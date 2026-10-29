import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeSettings } from '../src/config.mjs'
import { createGreenHarness } from '../src/runtime.mjs'
import { bar, parseCommand, runCommand, statusText } from '../src/control.mjs'

const silentLedger = { write() {} }

function hostWith(raw = {}, extra = {}) {
  const settings = normalizeSettings(raw)
  const runtime = createGreenHarness(settings, { ledger: silentLedger })
  return { control: { paused: false }, settings, runtime, ...extra }
}

test('status is the default command', () => {
  assert.deepEqual(parseCommand(''), { action: 'status' })
  assert.deepEqual(parseCommand('   '), { action: 'status' })
})

test('on and off pause every mechanism', () => {
  assert.deepEqual(parseCommand('off'), { action: 'pause', paused: true })
  assert.deepEqual(parseCommand('ON'), { action: 'pause', paused: false })
})

test('each mechanism can be switched by name', () => {
  assert.deepEqual(parseCommand('distill off'), { action: 'toggle', mechanism: 'distill', enabled: false })
  assert.deepEqual(parseCommand('dedupe on'), { action: 'toggle', mechanism: 'dedupe', enabled: true })
  assert.deepEqual(parseCommand('loop off'), { action: 'toggle', mechanism: 'loop', enabled: false })
  assert.equal(parseCommand('distill').action, 'error')
  assert.equal(parseCommand('distill maybe').action, 'error')
})

test('large and small keep their words for model matching', () => {
  assert.deepEqual(parseCommand('large nvidia Nemotron 3 Ultra'), { action: 'model', tier: 'large', args: ['nvidia', 'Nemotron', '3', 'Ultra'] })
  assert.deepEqual(parseCommand('small 1'), { action: 'model', tier: 'small', args: ['1'] })
  assert.deepEqual(parseCommand('models'), { action: 'models' })
})

test('unknown words get a pointer to help, not a silent no-op', () => {
  const reply = parseCommand('frobnicate')
  assert.equal(reply.action, 'error')
  assert.match(reply.message, /help/)
})

test('large turns routing on, and routing on without a large model is refused', async () => {
  const host = hostWith({})
  assert.equal((await runCommand('routing on', host)).kind, 'error')
  assert.equal(host.settings.routing.enabled, false)

  const set = await runCommand('large nemo lightning', host)
  assert.equal(set.kind, 'success')
  assert.equal(host.settings.routing.enabled, true)
  assert.equal(host.settings.tiers.large.model, 'lightning')
})

test('pause and toggles change the live settings the hooks read', async () => {
  const host = hostWith({})
  await runCommand('off', host)
  assert.equal(host.control.paused, true)
  await runCommand('loop off', host)
  assert.equal(host.settings.loopBreaker.enabled, false)
})

test('status reports switches, models and counts', async () => {
  const host = hostWith({})
  const text = statusText(host)
  assert.match(text, /GreenHarness is ON/)
  assert.match(text, /Routing off/)
  assert.match(text, /shorten output on/)
  assert.match(text, /0 model calls/)
  assert.match(text, /Tokens saved so far: about 0/)
  await runCommand('off', host)
  assert.match(statusText(host), /GreenHarness is PAUSED/)
})

test('status shows tokens saved and the cheap-model progress bar', () => {
  const written = []
  const host = hostWith({})
  const runtime = createGreenHarness(host.settings, { ledger: { write: r => written.push(r) } })
  host.runtime = runtime
  runtime.observeEvent('s', { type: 'request/header', data: { header: { config: { provider: 'p', model: 'm' } } } })
  runtime.observeEvent('s', { type: 'assistant/message', data: { turn: 1, step: 1, usage: { inputTokens: 300, outputTokens: 100 } } })
  const text = statusText(host)
  assert.match(text, /1 model calls/)
  assert.match(text, /\[█{20}\] 100%/)
  assert.equal(bar(0.5), '[' + '█'.repeat(10) + '░'.repeat(10) + ']')
})

test('without tiers, routing returns no route, so the proposed model stays', () => {
  const host = hostWith({})
  assert.equal(host.runtime.routeForNextCall('s1', { provider: 'p', model: 'm' }), undefined)
})

test('the small tier is captured from the first routed call, then escalation uses large', async () => {
  const host = hostWith({})
  await runCommand('large nemo lightning high', host)
  const first = host.runtime.routeForNextCall('s1', { provider: 'deepseek', model: 'flash', reasoningEffort: '' })
  assert.deepEqual(first, { provider: 'deepseek', model: 'flash' })
  assert.deepEqual(host.settings.tiers.small, { provider: 'deepseek', model: 'flash', reasoningEffort: '' })
})

const fakeLlm = {
  listProviders: () => [{ id: 'nvidia', name: 'NVIDIA' }, { id: 'deepseek', name: 'DeepSeek' }],
  listModels: async id => (id === 'nvidia'
    ? [{ id: 'nvidia/nemotron-3-ultra-550b-a55b', name: 'Nemotron 3 Ultra 550B A55B' }, { id: 'nvidia/nemotron-3-bolt-e4b', name: 'Nemotron 3 Bolt E4B' }]
    : [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }]),
}

test('models lists everything DSH knows, numbered', async () => {
  const host = { ...hostWith({}), llm: fakeLlm }
  const reply = await runCommand('models', host)
  assert.match(reply.text, /1\. Nemotron 3 Ultra 550B A55B/)
  assert.match(reply.text, /3\. DeepSeek V4 Flash/)
})

test('the exact words a user typed in the chat find the model', async () => {
  const host = { ...hostWith({}), llm: fakeLlm }
  const reply = await runCommand('large nvidia Nemotron 3 Ultra 550B A55B', host)
  assert.equal(reply.kind, 'success')
  assert.deepEqual(host.settings.tiers.large, { provider: 'nvidia', model: 'nvidia/nemotron-3-ultra-550b-a55b', reasoningEffort: '' })
  assert.equal(host.settings.routing.enabled, true)
})

test('a list number, a trailing effort and a partial name all work', async () => {
  const host = { ...hostWith({}), llm: fakeLlm }
  await runCommand('models', host)
  await runCommand('small 2', host)
  assert.equal(host.settings.tiers.small.model, 'nvidia/nemotron-3-bolt-e4b')
  await runCommand('large ultra high', host)
  assert.equal(host.settings.tiers.large.reasoningEffort, 'high')
  assert.equal(host.settings.tiers.large.model, 'nvidia/nemotron-3-ultra-550b-a55b')
})

test('an unknown or ambiguous model gets a helpful error, not a silent change', async () => {
  const host = { ...hostWith({}), llm: fakeLlm }
  const none = await runCommand('large banana split', host)
  assert.equal(none.kind, 'error')
  assert.equal(host.settings.tiers.large, undefined)
  const many = await runCommand('large nemotron', host)
  assert.equal(many.kind, 'error')
  assert.match(many.text, /several models/)
  assert.equal((await runCommand('large 99', host)).kind, 'error')
})

test('help is organised and mentions where to add keys', async () => {
  const reply = await runCommand('help', hostWith({}))
  assert.match(reply.text, /CHOOSE MODELS/)
  assert.match(reply.text, /Settings > Models/)
})

// === GreenHarness 0.1.2 additions ===
test('tier pins routing, and auto releases it', async () => {
  const host = hostWith({})
  assert.equal((await runCommand('tier large', host)).kind, 'error')
  await runCommand('large nemo lightning', host)
  assert.equal((await runCommand('tier large', host)).kind, 'success')
  assert.equal(host.settings.routing.pinned, 'large')
  assert.equal((await runCommand('tier auto', host)).kind, 'success')
  assert.equal(host.settings.routing.pinned, '')
  assert.equal(parseCommand('tier medium').action, 'error')
})

test('profiles set a bundle of knobs in one command', async () => {
  const host = hostWith({})
  assert.equal((await runCommand('profile cheap', host)).kind, 'success')
  assert.equal(host.settings.routing.pinned, 'small')
  assert.equal(host.settings.triage.enabled, false)
  assert.equal(host.settings.distill.maxChars, 4000)
  assert.equal(host.settings.profile, 'cheap')
  assert.equal((await runCommand('profile quality', host)).kind, 'error', 'quality needs a large model')
  assert.match((await runCommand('profile', host)).text, /balanced/)
})

test('last reports the turn that just ran', async () => {
  const host = hostWith({})
  await host.runtime.observeMessages('s', [{ role: 'user', content: 'hello' }])
  host.runtime.observeEvent('s', { type: 'request/header', data: { header: { config: { provider: 'p', model: 'm' } } } })
  host.runtime.observeEvent('s', { type: 'assistant/message', data: { turn: 1, step: 1, usage: { inputTokens: 300, outputTokens: 100 } } })
  const reply = await runCommand('last', host)
  assert.match(reply.text, /last call: small model/)
  assert.match(reply.text, /tokens:    400/)
})

test('the status line names the pinned tier and the last reply', async () => {
  const host = hostWith({})
  await runCommand('large nemo lightning', host)
  await runCommand('tier large', host)
  const text = statusText(host)
  assert.match(text, /every call uses the large model/)
  assert.match(text, /Profile: custom/)
})

test('benchmark command parses prompt and executes comparison', async () => {
  assert.equal(parseCommand('benchmark').action, 'error')
  assert.equal(parseCommand('benchmark on').action, 'error')
  assert.deepEqual(parseCommand('benchmark on build-horse'), { action: 'benchmark', prompt: 'build-horse' })
  assert.deepEqual(parseCommand('bench on Generate a 3D model of a horse'), { action: 'benchmark', prompt: 'Generate a 3D model of a horse' })
  assert.deepEqual(parseCommand('benchmark subtract-fix'), { action: 'benchmark', prompt: 'subtract-fix' })

  let calledWith = null
  const host = hostWith({}, {
    benchmarkRunner: async (prompt) => {
      calledWith = prompt
      return { report: `REPORT for ${prompt}: always-large vs greenharness` }
    },
  })

  const reply = await runCommand('benchmark on build-horse', host)
  assert.equal(reply.kind, 'success')
  assert.equal(calledWith, 'build-horse')
  assert.match(reply.text, /REPORT for build-horse/)
})

test('last shows a per-prompt cheap-model bar that is separate from the all-prompts total', async () => {
  const host = hostWith({ tiers: { small: { provider: 'p', model: 'small' }, large: { provider: 'p', model: 'large' } } })
  host.runtime.lastTurn = () => ({ calls: 2, models: { 'p/small': 1, 'p/large': 1 }, tokens: 400, tierTokens: { small: 100, large: 300 }, tier: 'large', plan: [] })
  const reply = await runCommand('last', host)
  assert.match(reply.text, /cheap model: \[█{5}░{15}\] 25%/)
  assert.match(statusText(host), /LATEST PROMPT ONLY: cheap model did \[█{5}░{15}\] 25%/)
  assert.match(statusText(host), /ALL PROMPTS SINCE DSH STARTED/)
})
