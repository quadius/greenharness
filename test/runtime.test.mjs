import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGreenHarness } from '../src/runtime.mjs'
import { normalizeSettings } from '../src/config.mjs'

const TEST_FAIL = [
  'not ok 2 - subtracts',
  "  error: 'Expected values to be strictly equal:'",
  '  expected: 2',
  '  actual: 3',
  '# fail 1',
].join('\n')
const TEST_PASS = '# tests 3\n# pass 3\n# fail 0'
const NOISE = Array.from({ length: 80 }, (_, i) => `✓ case ${i} (1ms)`).join('\n')
const SMALL = { provider: 'nemo-small', model: 'bolt-e4b', reasoningEffort: 'off' }
const LARGE = { provider: 'nemo-large', model: 'lightning-30b', reasoningEffort: 'high' }

function harness(overrides = {}) {
  const ledger = { records: [], write(record) { this.records.push(record) } }
  const settings = normalizeSettings({
    tiers: { small: { ...SMALL }, large: { ...LARGE } },
    ...overrides,
  })
  const runtime = createGreenHarness(settings, { ledger })
  const bash = (sessionId, command, text, extra = {}) => ({ sessionId, name: 'bash', args: { command }, callId: `c-${Math.random()}`, text, ...extra })
  return { runtime, ledger, bash, settings }
}

test('a failing verifier moves the next call to the large tier, and two stable passes return it', async () => {
  const { runtime, bash, ledger } = harness()
  const s = 'session-A'
  assert.deepEqual(runtime.routeForNextCall(s), SMALL)
  await runtime.afterTool(bash(s, 'node --test test/', TEST_FAIL, { exitCode: 1 }))
  assert.deepEqual(runtime.routeForNextCall(s), LARGE)
  assert.ok(ledger.records.some(r => r.type === 'route' && r.to === 'large'))
  await runtime.afterTool(bash(s, 'node --test test/', TEST_PASS, { exitCode: 0 }))
  assert.deepEqual(runtime.routeForNextCall(s), LARGE, 'one pass is not yet stable')
  await runtime.afterTool(bash(s, 'node --test test/', TEST_PASS, { exitCode: 0 }))
  assert.deepEqual(runtime.routeForNextCall(s), SMALL)
})

test('non-verifier commands never change the tier', async () => {
  const { runtime, bash } = harness()
  await runtime.afterTool(bash('s', 'ls -la', 'boom', { exitCode: 2 }))
  assert.equal(runtime.inspect('s').tier, 'small')
})

test('a bash call whose arguments were rejected never ran, so it is no verifier outcome', async () => {
  const { runtime, bash, ledger } = harness()
  const s = 'session-H'
  const rejected = 'Error: invalid arguments: missing required property "description"'
  await runtime.afterTool(bash(s, 'node --test', rejected, { isError: true }))
  assert.equal(runtime.inspect(s).tier, 'small')
  assert.equal(runtime.inspect(s).consecutiveFailures, 0)
  assert.ok(ledger.records.some(r => r.type === 'tool' && r.action === 'not-run'))
  assert.equal(runtime.beforeTool({ sessionId: s, name: 'bash', args: { command: 'node --test' } }), undefined)
})

test('the loop breaker denies the fourth identical failing run and escalates', async () => {
  const { runtime, bash, ledger } = harness()
  const s = 'session-B'
  for (let i = 0; i < 3; i += 1) await runtime.afterTool(bash(s, 'node --test test/', TEST_FAIL, { exitCode: 1 }))
  const verdict = runtime.beforeTool({ sessionId: s, name: 'bash', args: { command: 'node  --test test/' } })
  assert.equal(verdict.kind, 'deny')
  assert.match(verdict.reason, /failed 3 times in a row/)
  assert.equal(runtime.inspect(s).tier, 'large')
  assert.ok(ledger.records.some(r => r.type === 'loop-break'))
})

test('a workspace edit clears the loop streak so the command may run again', async () => {
  const { runtime, bash } = harness()
  const s = 'session-C'
  for (let i = 0; i < 3; i += 1) await runtime.afterTool(bash(s, 'node --test', TEST_FAIL, { exitCode: 1 }))
  await runtime.afterTool({ sessionId: s, name: 'edit', args: { file_path: 'src/x.mjs', old_string: 'a', new_string: 'b' }, isError: false })
  assert.equal(runtime.beforeTool({ sessionId: s, name: 'bash', args: { command: 'node --test' } }), undefined)
})

test('a large noisy result is replaced by a distilled one that points at the full output', async () => {
  const spilled = []
  const { runtime, bash, ledger } = harness()
  const raw = `${NOISE}\n${TEST_FAIL}`
  const replacement = await runtime.afterTool(bash('s-D', 'npm test', raw, {
    exitCode: 1,
    spill: async (text) => { spilled.push(text); return 'spill://bash-1' },
  }))
  assert.ok(replacement, 'expected a replacement')
  assert.match(replacement.text, /not ok 2 - subtracts/)
  assert.match(replacement.text, /Full output: spill:\/\/bash-1/)
  assert.equal(spilled[0], raw, 'the full output is spilled verbatim')
  assert.ok(replacement.text.length < raw.length * 0.5)
  const record = ledger.records.find(r => r.type === 'tool' && r.tool === 'bash')
  assert.equal(record.action, 'distill')
  assert.equal(record.verifier, true)
})

test('distillation is skipped when disabled', async () => {
  const { runtime, bash } = harness({ distill: { enabled: false } })
  assert.equal(await runtime.afterTool(bash('s-E', 'npm test', `${NOISE}\n${TEST_FAIL}`, { exitCode: 1 })), undefined)
})

test('an identical re-read is replaced by a pointer until an edit or compaction', async () => {
  const { runtime, ledger } = harness()
  const s = 'session-F'
  const read = (text, callId) => ({ sessionId: s, name: 'read', args: { file_path: 'src/a.mjs' }, callId, isError: false, text })
  assert.equal(await runtime.afterTool(read('1  const a = 1', 'r1')), undefined)
  const stub = await runtime.afterTool(read('1  const a = 1', 'r2'))
  assert.match(stub.text, /same lines as the earlier read of src\/a\.mjs \(call r1\)/)

  await runtime.afterTool({ sessionId: s, name: 'write', args: { file_path: 'src/a.mjs', content: 'x' }, isError: false })
  assert.equal(await runtime.afterTool(read('1  const a = 1', 'r3')), undefined, 'a write forgets the path')

  await runtime.afterTool(read('1  const a = 1', 'r4'))
  runtime.observeEvent(s, { type: 'compaction/end', data: {} })
  assert.equal(await runtime.afterTool(read('1  const a = 1', 'r5')), undefined, 'compaction forgets the index')
  assert.ok(ledger.records.some(r => r.tool === 'read' && r.action === 'dedupe'))
})

test('provider usage is written per call with a cost from the configured price', () => {
  const { runtime, ledger } = harness({ ledger: { path: '', pricing: { 'nemo-small': { inputPerMTok: 0.1, cachedInputPerMTok: 0.01, outputPerMTok: 0.4 } } } })
  const s = 'session-G'
  runtime.observeEvent(s, { type: 'request/header', data: { header: { config: { provider: 'nemo-small', model: 'bolt-e4b', reasoningEffort: 'off' } } } })
  runtime.observeEvent(s, {
    type: 'assistant/message',
    data: { turn: 2, step: 1, usage: { inputTokens: 1000, cacheReadTokens: 9000, outputTokens: 500 } },
  })
  const record = ledger.records.find(r => r.type === 'request')
  assert.equal(record.provider, 'nemo-small')
  assert.equal(record.reasoningEffort, 'off')
  assert.ok(Math.abs(record.costUsd - (1000 * 0.1 + 9000 * 0.01 + 500 * 0.4) / 1e6) < 1e-12)
})

test('a call is logged with the route it actually used, not the cascade tier', async () => {
  const { runtime, bash, ledger } = harness()
  const s = 'session-I'
  await runtime.afterTool(bash(s, 'node --test', TEST_FAIL, { exitCode: 1 }))
  assert.equal(runtime.inspect(s).tier, 'large')
  runtime.observeEvent(s, { type: 'request/header', data: { header: { config: { ...SMALL } } } })
  runtime.observeEvent(s, { type: 'assistant/message', data: { turn: 1, step: 1, usage: { inputTokens: 10, cacheReadTokens: 0, outputTokens: 1 } } })
  const record = ledger.records.find(r => r.type === 'request')
  assert.equal(record.tier, 'small')
  assert.equal(record.model, 'bolt-e4b')
})

// === GreenHarness 0.1.2 additions ===
test('a greenfield prompt sends the first call to the large model', async () => {
  const { runtime, ledger } = harness()
  await runtime.observeMessages('s-T', [{ role: 'user', content: 'Generate a 3D model of a horse using JavaScript and three.js' }])
  assert.deepEqual(runtime.routeForNextCall('s-T'), LARGE)
  assert.ok(ledger.records.some(r => r.type === 'triage' && r.verdict === 'large'))
  assert.ok(ledger.records.some(r => r.type === 'route' && r.reason === 'triage-large'))
})

test('a debugging prompt leaves the first call on the small tier', async () => {
  const { runtime } = harness()
  await runtime.observeMessages('s-U', [{ role: 'user', content: 'Fix the failing tests. Run node --test.' }])
  assert.deepEqual(runtime.routeForNextCall('s-U'), SMALL)
})

test('a mixed verdict gives the small model two calls, then switches', async () => {
  const { runtime, ledger } = harness()
  await runtime.observeMessages('s-X', [{ role: 'user', content: 'Create a shader for a water effect' }])
  assert.deepEqual(runtime.routeForNextCall('s-X'), SMALL)
  assert.deepEqual(runtime.routeForNextCall('s-X'), SMALL)
  assert.deepEqual(runtime.routeForNextCall('s-X'), LARGE)
  assert.ok(ledger.records.some(r => r.type === 'route' && r.reason === 'triage-mixed'))
})

test('pinning to the small model ignores a failing verifier', async () => {
  const { runtime, bash } = harness()
  runtime.notePin('small')
  await runtime.afterTool(bash('s-V', 'node --test', TEST_FAIL, { exitCode: 1 }))
  assert.deepEqual(runtime.routeForNextCall('s-V'), SMALL)
})

test('pinning to the large model wins over triage', async () => {
  const { runtime } = harness()
  await runtime.observeMessages('s-W', [{ role: 'user', content: 'hello' }])
  runtime.notePin('large')
  assert.deepEqual(runtime.routeForNextCall('s-W'), LARGE)
})

test('lastTurn reports which model served the calls', async () => {
  const { runtime } = harness()
  await runtime.observeMessages('s-Y', [{ role: 'user', content: 'hello' }])
  runtime.observeEvent('s-Y', { type: 'request/header', data: { header: { config: { ...SMALL } } } })
  runtime.observeEvent('s-Y', { type: 'assistant/message', data: { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 20 } } })
  const turn = runtime.lastTurn()
  assert.equal(turn.calls, 1)
  assert.equal(turn.tier, 'small')
  assert.equal(turn.tokens, 120)
  assert.deepEqual(turn.models, { 'nemo-small/bolt-e4b': 1 })
})

test('shortened output points at a full copy the model can open', async () => {
  const { runtime, bash } = harness()
  const call = bash('s-F', 'node big.js', `${NOISE.repeat(3)}\n${TEST_FAIL}`, { exitCode: 1 })
  let saved
  call.saveFile = async text => { saved = text; return '/tmp/out/bash-1.txt' }
  const result = await runtime.afterTool(call)
  assert.ok(result?.text.includes('/tmp/out/bash-1.txt'))
  assert.ok(result.text.includes('read tool'))
  assert.equal(saved, call.text)
})

test('a small prompt after a large one starts back on the small tier', async () => {
  const { runtime, ledger } = harness()
  await runtime.observeMessages('s-R', [{ role: 'user', content: 'Generate a 3D model of a horse using JavaScript and build the whole scene with lighting, animation and controls' }])
  runtime.routeForNextCall('s-R')
  await runtime.observeMessages('s-R', [{ role: 'user', content: 'whats 1+1' }])
  assert.deepEqual(runtime.routeForNextCall('s-R'), SMALL)
})

test('a call that ran on another model than asked is reported', () => {
  const { runtime, ledger } = harness()
  runtime.routeForNextCall('s-M')
  runtime.observeEvent('s-M', { type: 'request/header', data: { header: { config: { ...LARGE } } } })
  runtime.observeEvent('s-M', { type: 'assistant/message', data: { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 1 } } })
  assert.ok(ledger.records.some(r => r.type === 'route-mismatch'))
  assert.match(runtime.lastMismatch().intended, /bolt-e4b/)
})

test('releasing a pin returns the session to the small tier', () => {
  const { runtime } = harness()
  runtime.notePin('large')
  assert.deepEqual(runtime.routeForNextCall('s-P'), LARGE)
  runtime.notePin('')
  assert.deepEqual(runtime.routeForNextCall('s-P'), SMALL)
})

// === GreenHarness 0.2.0 additions ===
test('a deduped read is served in full on the next identical request, so content can never vanish', async () => {
  const { runtime, ledger } = harness()
  const s = 'session-DD'
  const read = (callId) => ({ sessionId: s, name: 'read', args: { file_path: 'src/a.mjs' }, callId, isError: false, text: '1  const a = 1' })
  assert.equal(await runtime.afterTool(read('r1')), undefined)
  const pointer = await runtime.afterTool(read('r2'))
  assert.match(pointer.text, /Omitted to save tokens/)
  assert.match(pointer.text, /read the same range again/)
  assert.equal(await runtime.afterTool(read('r3')), undefined, 'the third read gets the real content')
  assert.ok(ledger.records.some(r => r.tool === 'read' && r.action === 'dedupe-refresh'))
  const again = await runtime.afterTool(read('r4'))
  assert.match(again.text, /Omitted to save tokens/, 'the cycle starts over')
})

test('the escape hatch can be switched off for strict dedupe', async () => {
  const { runtime } = harness({ readDedupe: { escapeHatch: false } })
  const s = 'session-DE'
  const read = (callId) => ({ sessionId: s, name: 'read', args: { file_path: 'src/a.mjs' }, callId, isError: false, text: '1  const a = 1' })
  await runtime.afterTool(read('r1'))
  await runtime.afterTool(read('r2'))
  assert.match((await runtime.afterTool(read('r3'))).text, /Omitted to save tokens/)
})

test('a mutating bash command clears the loop streak, so a fix through the shell is not denied', async () => {
  const { runtime, bash } = harness()
  const s = 'session-DM'
  for (let i = 0; i < 3; i += 1) await runtime.afterTool(bash(s, 'node --test', TEST_FAIL, { exitCode: 1 }))
  await runtime.afterTool(bash(s, 'sed -i s/3/2/ src/math.mjs', '', { exitCode: 0 }))
  assert.equal(runtime.beforeTool({ sessionId: s, name: 'bash', args: { command: 'node --test' } }), undefined)
})

test('a successful apply_patch counts as progress, not only the edit tool', async () => {
  const { runtime, bash } = harness()
  const s = 'session-DP'
  for (let i = 0; i < 3; i += 1) await runtime.afterTool(bash(s, 'node --test', TEST_FAIL, { exitCode: 1 }))
  await runtime.afterTool({ sessionId: s, name: 'apply_patch', args: { file_path: 'src/x.mjs' }, isError: false })
  assert.equal(runtime.beforeTool({ sessionId: s, name: 'bash', args: { command: 'node --test' } }), undefined)
})

test('a call is labelled by the tier that produced it even after the large model is changed', async () => {
  const { runtime, ledger, settings } = harness()
  const s = 'session-TL'
  runtime.routeForNextCall(s)
  settings.tiers.large = { provider: 'other', model: 'brand-new', reasoningEffort: '' }
  runtime.observeEvent(s, { type: 'request/header', data: { header: { config: { ...SMALL } } } })
  runtime.observeEvent(s, { type: 'assistant/message', data: { turn: 1, step: 1, usage: { inputTokens: 5, outputTokens: 1 } } })
  assert.equal(ledger.records.find(r => r.type === 'request').tier, 'small')
})

test('forgetSession drops the cascade, the loop guard and the read index', async () => {
  const { runtime, bash } = harness()
  const s = 'session-FS'
  await runtime.afterTool(bash(s, 'node --test', TEST_FAIL, { exitCode: 1 }))
  assert.equal(runtime.inspect(s).tier, 'large')
  assert.equal(runtime.sessionCount(), 1)
  runtime.forgetSession(s)
  assert.equal(runtime.sessionCount(), 0)
  assert.equal(runtime.inspect(s).tier, 'small', 'the fresh state starts on the small tier')
})

test('distillation only touches the tools it is configured for', async () => {
  const { runtime, ledger } = harness()
  const noise = Array.from({ length: 80 }, (_, i) => `✓ case ${i} (1ms)`).join('\n')
  const grepCall = { sessionId: 's-DG', name: 'grep', args: { pattern: 'x' }, callId: 'g1', text: `${noise}\n${TEST_FAIL}` }
  assert.equal(await runtime.afterTool(grepCall), undefined, 'grep is not a distilled tool by default')
  assert.ok(ledger.records.length === 0, 'nothing is logged for a tool it does not act on')
})

test('a pure truncation of a clean, moderately long output is skipped', async () => {
  const { runtime, bash } = harness({ distill: { maxChars: 500 } })
  const clean = Array.from({ length: 200 }, (_, i) => `src/file-${i}.mjs`).join('\n')
  assert.equal(await runtime.afterTool(bash('s-DC', 'find src', clean, { exitCode: 0 })), undefined)
})

test('a huge clean output is still truncated, because context cost dominates', async () => {
  const { runtime, bash } = harness({ distill: { maxChars: 500 } })
  const clean = Array.from({ length: 4000 }, (_, i) => `src/file-${i}.mjs`).join('\n')
  const replacement = await runtime.afterTool(bash('s-DH', 'find src', clean, { exitCode: 0 }))
  assert.ok(replacement, 'a 4x-over-budget listing is distilled')
  assert.match(replacement.text, /distilled/)
})

test('preStep strips our own notice, keeps a foreign one and writes telemetry once', async () => {
  const { runtime, ledger } = harness()
  const s = 'session-NS'
  runtime.routeForNextCall(s)
  const notice = (from) => ({
    role: 'user',
    source: { kind: 'model-selection' },
    content: [{ type: 'text', text: `[model changed: assistant turns above this point were generated by ${from}; the session continues with nemo-small/bolt-e4b]` }],
  })
  const user = { role: 'user', source: { kind: 'user' }, content: 'hello' }
  const admitted = await runtime.preStep(s, [user, notice('nemo-small/bolt-e4b')])
  assert.deepEqual(admitted, [user])
  assert.ok(ledger.records.some(r => r.type === 'notice-stripped' && r.count === 1))
  const kept = await runtime.preStep(s, [user, notice('someone/else')])
  assert.equal(kept.length, 2)
  assert.ok(ledger.records.some(r => r.type === 'notice-kept'))
})

test('preStep leaves messages alone when routing is off', async () => {
  const { runtime, ledger } = harness({ tiers: { small: { ...SMALL } } })
  const notice = {
    role: 'user',
    source: { kind: 'model-selection' },
    content: [{ type: 'text', text: '[model changed: assistant turns above this point were generated by a; the session continues with b]' }],
  }
  const admitted = await runtime.preStep('s-NO', [notice])
  assert.deepEqual(admitted, [notice])
  assert.ok(ledger.records.every(r => r.type !== 'notice-stripped'))
})
