import { test } from 'node:test'
import assert from 'node:assert/strict'
import { distillOutput } from '../src/core/distill.mjs'
import { stripAnsi } from '../src/core/ansi.mjs'

const passingNoise = Array.from({ length: 60 }, (_, i) => `✓ adds case ${i} (1ms)`).join('\n')

test('stripAnsi removes colour and cursor sequences', () => {
  assert.equal(stripAnsi('\u001b[31mFAIL\u001b[0m \u001b[2K x'), 'FAIL  x')
})

test('keeps the failure window and summary, drops passing-test noise', () => {
  const raw = [
    passingNoise,
    'not ok 61 - divides by zero',
    "  error: 'Expected values to be strictly equal:'",
    '  expected: 2',
    '  actual: 3',
    '    at file:///work/src/math.test.mjs:12:5',
    '    at Test.run (node:internal/test_runner/test:900:3)',
    '# tests 61',
    '# fail 1',
  ].join('\n')
  const { text, changed, stats } = distillOutput(raw, { maxChars: 6000, contextLines: 2 })
  assert.equal(changed, true)
  assert.match(text, /not ok 61 - divides by zero/)
  assert.match(text, /actual: 3/)
  assert.match(text, /# fail 1/)
  assert.doesNotMatch(text, /adds case 10 /)
  assert.doesNotMatch(text, /node:internal/, 'library frames are dropped')
  assert.ok(stats.droppedFrames >= 1)
  assert.ok(stats.outChars < stats.inChars * 0.5)
})

test('keeps security and deprecation warnings even when they are not failures', () => {
  const raw = `${passingNoise}\nwarning: package foo is deprecated\nDONE`
  const { text } = distillOutput(raw, { maxChars: 6000 })
  assert.match(text, /deprecated/)
})

test('zero-failure summaries are summaries, not failures', () => {
  const raw = `${passingNoise}\nTests 61 passed, 0 failed`
  const { text, stats } = distillOutput(raw, { maxChars: 6000 })
  assert.match(text, /0 failed/)
  assert.equal(stats.failLines, 0)
})

test('collapses runs of identical kept lines', () => {
  const raw = `${passingNoise}\n${Array(5).fill('Error: ECONNRESET retrying').join('\n')}`
  const { text, stats } = distillOutput(raw, { maxChars: 6000 })
  assert.match(text, /Error: ECONNRESET retrying {2}\(×5\)/)
  assert.ok(stats.collapsedRepeats >= 4)
})

test('drops spinner and progress-bar frames', () => {
  const raw = ['installing', '|', '/', '-', '[#####     ] 50%', '42% |████', ...Array(40).fill('ok'), 'Error: boom'].join('\n')
  const { text, stats } = distillOutput(raw, { maxChars: 6000 })
  assert.doesNotMatch(text, /\[#####/)
  assert.ok(stats.droppedLines >= 4)
  assert.match(text, /Error: boom/)
})

test('output that does not shrink by at least 10% is reported unchanged', () => {
  const raw = 'line one\nline two\nline three'
  const result = distillOutput(raw, { maxChars: 6000 })
  assert.equal(result.changed, false)
})

test('over-budget output keeps head and tail with an elision marker', () => {
  const raw = Array.from({ length: 2000 }, (_, i) => `Error: failure number ${i} in module`).join('\n')
  const { text, changed, stats } = distillOutput(raw, { maxChars: 1000 })
  assert.equal(changed, true)
  assert.ok(text.length <= 1100, `length ${text.length}`)
  assert.match(text, /chars omitted/)
  assert.ok(stats.elidedChars > 0)
})

test('carriage-return progress keeps the final frame of each line', () => {
  const raw = `${passingNoise}\nprogress 10%\rprogress 90%\rprogress 100%\nFAIL: final`
  const { text } = distillOutput(raw, { maxChars: 6000 })
  assert.match(text, /FAIL: final/)
  assert.doesNotMatch(text, /progress 10%/)
})

// === GreenHarness 0.2.0 addition: a clean listing is not worth cutting ===
test('a clean output with no failure, summary, safety line or noise is left alone', () => {
  const listing = Array.from({ length: 120 }, (_, i) => `src/module-${i}.mjs`).join('\n')
  const result = distillOutput(listing, { maxChars: 400 })
  assert.equal(result.changed, false, 'structure beats a blind truncation')
})

test('a failing log still distils, and the signal survives', () => {
  const log = `${Array.from({ length: 120 }, (_, i) => `  at frame ${i} (node_modules/x/y.js:${i}:1)`).join('\n')}\nfailure: expected 2 but got 3\nTests: 1 failed, 2 passed`
  const result = distillOutput(log, { maxChars: 400 })
  assert.equal(result.changed, true)
  assert.match(result.text, /failure: expected 2 but got 3/)
  assert.match(result.text, /Tests: 1 failed, 2 passed/)
})

test('an output far over budget is distilled even without a signal line', () => {
  const listing = Array.from({ length: 6000 }, (_, i) => `src/module-${i}.mjs`).join('\n')
  const result = distillOutput(listing, { maxChars: 400 })
  assert.equal(result.changed, true)
  assert.match(result.text, /lines omitted/)
})
