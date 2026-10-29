import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeSettings } from '../src/config.mjs'

const tiers = {
  small: { provider: 'nemo-small', model: 'bolt-e4b' },
  large: { provider: 'nemo-large', model: 'lightning-30b', reasoningEffort: 'high' },
}

test('defaults are applied and an empty effort means the adapter default', () => {
  const settings = normalizeSettings({ tiers })
  assert.equal(settings.tiers.small.reasoningEffort, '')
  assert.equal(settings.tiers.large.reasoningEffort, 'high')
  assert.deepEqual(settings.cascade, { escalateAfterFailures: 1, deescalateAfterPasses: 2, minStepsPerTier: 2 })
  assert.equal(settings.loopBreaker.threshold, 3)
  assert.equal(settings.distill.maxChars, 12000)
  assert.equal(settings.ledger.path, '.greenharness/ledger.jsonl')
  assert.ok(settings.verifier.patterns.length > 0)
})

test('a tier that is present but incomplete fails loudly at load', () => {
  assert.throws(() => normalizeSettings({ tiers: { small: tiers.small, large: { provider: 'x' } } }), /tiers\.large needs both/)
  assert.throws(() => normalizeSettings({ tiers: { small: { provider: 'x' }, large: tiers.large } }), /tiers\.small needs both/)
})

test('no tiers is valid: routing is off and the other mechanisms keep their defaults', () => {
  const settings = normalizeSettings({})
  assert.equal(settings.routing.enabled, false)
  assert.equal(settings.tiers.large, undefined)
  assert.equal(settings.distill.enabled, true)
  assert.equal(settings.loopBreaker.enabled, true)
})

test('a large tier alone turns routing on; the small tier is captured later', () => {
  const settings = normalizeSettings({ tiers: { large: tiers.large } })
  assert.equal(settings.routing.enabled, true)
  assert.equal(settings.tiers.small, undefined)
})

test('out-of-range numbers fail loudly', () => {
  assert.throws(() => normalizeSettings({ tiers, loopBreaker: { threshold: 1 } }), /loopBreaker\.threshold must be an integer >= 2/)
  assert.throws(() => normalizeSettings({ tiers, distill: { maxChars: 10 } }), /distill\.maxChars/)
})

test('an invalid verifier pattern fails loudly', () => {
  assert.throws(() => normalizeSettings({ tiers, verifier: { patterns: ['(unclosed'] } }), /invalid regular expression/)
})

// === GreenHarness 0.1.2 additions ===
test('triage defaults are on and heuristic; routing starts automatic', () => {
  const settings = normalizeSettings({})
  assert.equal(settings.triage.enabled, true)
  assert.equal(settings.triage.mode, 'heuristic')
  assert.equal(settings.triage.largeAt, 0.6)
  assert.equal(settings.triage.mixedAfterSteps, 2)
  assert.equal(settings.routing.pinned, '')
  assert.equal(settings.verbose, true)
  assert.equal(settings.profile, 'balanced')
})

test('an invalid pin, a crossed threshold pair or a model mode with no model fails loudly', () => {
  assert.throws(() => normalizeSettings({ routing: { pinned: 'medium' } }), /routing\.pinned/)
  assert.throws(() => normalizeSettings({ triage: { largeAt: 0.3, mixedAt: 0.5 } }), /triage\.largeAt/)
  assert.throws(() => normalizeSettings({ triage: { mode: 'model' } }), /triage\.model/)
  assert.throws(() => normalizeSettings({ triage: { mode: 'guess' } }), /triage\.mode/)
})
