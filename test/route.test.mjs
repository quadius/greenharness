import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyRoute, withoutModelNotices } from '../src/core/route.mjs'

test('applyRoute replaces provider, model and effort and keeps every other control', () => {
  const config = { provider: 'p', model: 'm', reasoningEffort: 'high', maxTokens: 512, stop: ['x'] }
  const routed = applyRoute(config, { provider: 'nemo-small', model: 'bolt-e4b', reasoningEffort: 'off' })
  assert.deepEqual(routed, { provider: 'nemo-small', model: 'bolt-e4b', reasoningEffort: 'off', maxTokens: 512, stop: ['x'] })
  assert.equal(config.provider, 'p', 'the input is not mutated')
})

test('a route without an effort drops the inherited effort', () => {
  const routed = applyRoute({ provider: 'p', model: 'm', reasoningEffort: 'high' }, { provider: 'nemo-small', model: 'bolt-e4b' })
  assert.deepEqual(routed, { provider: 'nemo-small', model: 'bolt-e4b' })
  assert.equal('reasoningEffort' in routed, false)
})

test('withoutModelNotices removes only DSH model-switch notices', () => {
  const messages = [{ source: { kind: 'user' } }, { source: { kind: 'model-selection' } }, { source: { kind: 'tool' } }]
  assert.deepEqual(withoutModelNotices(messages), [messages[0], messages[2]])
  assert.equal(withoutModelNotices([]).length, 0)
})
