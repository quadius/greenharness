/**
 * Request triage: decide, before the first model call of a turn, how much of the work needs the
 * large model. The cascade only reacts to a failing verifier, so open-ended work with no test to
 * fail ("generate a 3D model of a horse") would stay on the small tier for the whole run.
 * The default classifier is a pure heuristic: no model call, no extra tokens, deterministic.
 * `mode: 'model'` asks DSH's LLM service to classify instead; see README.
 */

export const VERDICTS = Object.freeze(['small', 'mixed', 'large'])

export const TRIAGE_SYSTEM = [
  'You classify coding requests for a two-model agent.',
  'Answer with exactly one word:',
  '  small  the small model can do the whole request',
  '  mixed  the small model should start, the large model should finish',
  '  large  the large model should do the whole request',
].join('\n')

const BUILD_RE = /\b(?:build|create|generate|design|implement|scaffold|prototype|develop|bootstrap|code up|set up|spin up)\b/gi
const DOMAIN_RE = /\b(?:3d|three\.?js|webgl|webgpu|shader|renderer|rendering|game|animation|physics|canvas|scene|mesh|texture|dashboard|website|web ?app|api|server|service|cli|library|framework|engine|simulation|visuali[sz]ation|chart|graph|frontend|backend|full[- ]?stack)\b/gi
const SCRATCH_RE = /\b(?:from scratch|whole (?:app|application|project|thing)|entire|end to end|greenfield|new project)\b/i
const DEBUG_RE = /\b(?:fix|bug|failing|fails?|broken|regression|stack ?trace|debug|investigate|traceback)\b/gi
const TEST_RE = /\b(?:tests?|specs?|coverage|lint|typecheck|tsc|pytest|jest|vitest|mocha)\b/gi
const TRIVIAL_RE = /^\s*(?:hi|hello|hey|thanks|thank you|ok(?:ay)?|yes|no|sure|cool|great|nice)\b[\s\S]{0,40}$/i

/**
 * Score one request for difficulty. 0 is trivial, 1 is a greenfield build.
 * @param {string} text - the user's request.
 * @param {{ maxChars?: number }} [options]
 * @returns {{ score: number, signals: string[] }}
 */
export function scoreRequest(text, { maxChars = 2000 } = {}) {
  const input = String(text ?? '').slice(0, maxChars)
  if (input.trim() === '') return { score: 0, signals: ['empty'] }
  if (TRIVIAL_RE.test(input)) return { score: 0, signals: ['trivial'] }

  const signals = []
  let score = 0

  const builds = countMatches(input, BUILD_RE)
  if (builds > 0) { score += 0.35; signals.push('build-verb') }

  const domains = Math.min(3, countMatches(input, DOMAIN_RE))
  if (domains > 0) { score += 0.2 * domains; signals.push(`domain×${domains}`) }

  if (SCRATCH_RE.test(input)) { score += 0.25; signals.push('from-scratch') }
  if (input.length > 240) { score += 0.15; signals.push('long-brief') }
  if (/```/.test(input)) { score += 0.1; signals.push('code-block') }

  // Debugging is the cascade's job: it has a verifier to fail. Triaging it here would double-count.
  const debug = countMatches(input, DEBUG_RE)
  if (debug > 0) { score -= 0.35 * Math.min(2, debug); signals.push('debug') }
  if (TEST_RE.test(input) && builds === 0) { score -= 0.2; signals.push('test-scope') }

  return { score: Math.round(Math.max(0, Math.min(1, score)) * 100) / 100, signals }
}

/**
 * Classify a request.
 * @param {string} text
 * @param {{ largeAt?: number, mixedAt?: number, maxChars?: number }} [options]
 * @returns {{ verdict: 'small' | 'mixed' | 'large', score: number, signals: string[], plan: string[] }}
 */
export function classifyRequest(text, { largeAt = 0.6, mixedAt = 0.35, maxChars = 2000 } = {}) {
  const { score, signals } = scoreRequest(text, { maxChars })
  const verdict = score >= largeAt ? 'large' : score >= mixedAt ? 'mixed' : 'small'
  return { verdict, score, signals, plan: planFor(verdict) }
}

/**
 * The plain-language plan shown by `/greenharness last`.
 * @param {'small' | 'mixed' | 'large'} verdict
 * @returns {string[]}
 */
export function planFor(verdict) {
  if (verdict === 'large') return ['large: whole request']
  if (verdict === 'mixed') return ['small: first steps', 'large: main work']
  return ['small: whole request']
}

/**
 * Read the one-word verdict out of a classifier model's reply.
 * @param {string} text
 * @returns {'small' | 'mixed' | 'large' | undefined}
 */
export function parseVerdict(text) {
  const match = /\b(small|mixed|large)\b/i.exec(String(text ?? ''))
  return match ? /** @type {any} */ (match[1].toLowerCase()) : undefined
}

/**
 * The most recent user message in a step, skipping DSH's own model-selection notices.
 * @param {ReadonlyArray<{ role?: string, content?: unknown, source?: { kind?: string } }>} messages
 * @returns {string | undefined}
 */
export function latestUserMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message?.role !== 'user') continue
    if (message.source?.kind === 'model-selection') continue
    const text = textOf(message.content)
    if (text.trim() !== '') return text
  }
  return undefined
}

/** @param {unknown} content */
function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(part => (part && typeof part === 'object' && 'text' in part ? String(part.text) : '')).join('')
  }
  return ''
}

/** @param {string} text @param {RegExp} re */
function countMatches(text, re) {
  return (text.match(re) ?? []).length
}
