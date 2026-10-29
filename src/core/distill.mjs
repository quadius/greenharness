import { stripAnsi } from './ansi.mjs'
import { FAIL_RE, FRAME_RE, LIB_FRAME_RE, PROGRESS_RE, SAFETY_RE, SUMMARY_RE, ZERO_RE } from './patterns.mjs'

/** Minimum size reduction (output at most this fraction of the input) before a distillation is used. */
const MIN_REDUCTION_RATIO = 0.9

/**
 * Classify one line for distillation.
 * @param {string} line - one line with control sequences removed.
 * @returns {'summary' | 'fail' | 'safety' | 'lib-frame' | 'frame' | 'plain'} the line's kind.
 */
function classify(line) {
  if (ZERO_RE.test(line)) return 'summary'
  if (FAIL_RE.test(line)) return 'fail'
  if (SAFETY_RE.test(line)) return 'safety'
  if (FRAME_RE.test(line)) return LIB_FRAME_RE.test(line) ? 'lib-frame' : 'frame'
  if (SUMMARY_RE.test(line)) return 'summary'
  return 'plain'
}

/**
 * Keep the signal in one shell or tool output and drop the rest, without changing any kept line.
 *
 * Kept, in order: failure, summary and safety lines; user-code stack frames and plain lines
 * within `contextLines` of a failure; the first and last three lines. Dropped: progress
 * frames, library stack frames, passing-test noise. Runs of three or more identical kept
 * lines collapse to one line with a count. Output above `maxChars` keeps its head and tail.
 *
 * @param {string} raw - tool output as the model would read it.
 * @param {{ maxChars?: number, contextLines?: number }} [options] - size budget and window around failures.
 * @returns {{ text: string, changed: boolean, stats: { inChars: number, outChars: number, droppedLines: number, droppedFrames: number, collapsedRepeats: number, failLines: number, elidedChars: number } }}
 *   `changed` is true only when the distilled text is at most 90% of the input and differs from it.
 */
export function distillOutput(raw, options = {}) {
  const maxChars = options.maxChars ?? 6000
  const contextLines = options.contextLines ?? 2
  const input = String(raw ?? '')
  const stats = {
    inChars: input.length, outChars: 0, droppedLines: 0, droppedFrames: 0,
    collapsedRepeats: 0, failLines: 0, elidedChars: 0,
  }

  let lines = stripAnsi(input).replace(/\r\n?/g, '\n').split('\n')
  lines = lines.filter((line) => {
    if (line.trim() !== '' && PROGRESS_RE.test(line)) {
      stats.droppedLines += 1
      return false
    }
    return true
  })

  const kinds = lines.map(classify)
  stats.failLines = kinds.filter(kind => kind === 'fail').length

  const nearFailure = new Array(lines.length).fill(false)
  kinds.forEach((kind, index) => {
    if (kind !== 'fail') return
    const from = Math.max(0, index - contextLines)
    const to = Math.min(lines.length - 1, index + contextLines)
    for (let j = from; j <= to; j += 1) nearFailure[j] = true
  })

  const keep = lines.map((_, index) => {
    const kind = kinds[index]
    if (kind === 'fail' || kind === 'summary' || kind === 'safety') return true
    if (kind === 'lib-frame') return false
    if (index < 3 || index >= lines.length - 3) return true
    return nearFailure[index]
  })

  const emitted = []
  let gap = 0
  let runText = null
  let runCount = 0
  const flushRun = () => {
    if (runText === null) return
    if (runCount >= 3) {
      emitted.push(`${runText}  (×${runCount})`)
      stats.collapsedRepeats += runCount - 1
    } else {
      for (let k = 0; k < runCount; k += 1) emitted.push(runText)
    }
    runText = null
    runCount = 0
  }

  for (let index = 0; index < lines.length; index += 1) {
    if (!keep[index]) {
      if (kinds[index] === 'lib-frame') stats.droppedFrames += 1
      if (gap === 0) flushRun()
      gap += 1
      continue
    }
    if (gap > 0) {
      emitted.push(`[… ${gap} line${gap === 1 ? '' : 's'} omitted]`)
      gap = 0
    }
    const text = lines[index]
    if (text === runText) {
      runCount += 1
    } else {
      flushRun()
      runText = text
      runCount = 1
    }
  }
  flushRun()
  if (gap > 0) emitted.push(`[… ${gap} line${gap === 1 ? '' : 's'} omitted]`)

  let text = emitted.join('\n').replace(/[ \t]+$/gm, '')
  if (text.length > maxChars) {
    const headBudget = Math.floor(maxChars * 0.4)
    const tailBudget = Math.max(0, maxChars - headBudget - 80)
    const headSlice = text.slice(0, headBudget)
    const headCut = headSlice.lastIndexOf('\n')
    const headText = headCut > 0 ? headSlice.slice(0, headCut) : headSlice
    const tailSlice = text.slice(text.length - tailBudget)
    const tailCut = tailSlice.indexOf('\n')
    const tailText = tailCut >= 0 ? tailSlice.slice(tailCut + 1) : tailSlice
    const omitted = text.length - headText.length - tailText.length
    stats.elidedChars = omitted
    text = `${headText}\n[… ${omitted} chars omitted …]\n${tailText}`
  }

  stats.outChars = text.length
  const changed = text !== input && text.length <= input.length * MIN_REDUCTION_RATIO
  return { text, changed, stats }
}
