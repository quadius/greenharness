import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCascade, escalate, recordStep, recordVerification } from '../src/core/cascade.mjs'

test('a failed verifier moves the cascade to the large tier immediately', () => {
  const cascade = createCascade()
  assert.equal(cascade.tier, 'small')
  assert.deepEqual(recordVerification(cascade, false), { from: 'small', to: 'large', reason: 'verifier-failed' })
  assert.equal(cascade.tier, 'large')
})

test('returning to the small tier needs two passes and a minimum number of steps', () => {
  const cascade = createCascade({ minStepsPerTier: 2, deescalateAfterPasses: 2 })
  recordVerification(cascade, false)
  assert.equal(recordVerification(cascade, true), null, 'one pass is not stable')
  assert.equal(recordVerification(cascade, true), null, 'two passes but no steps yet')
  recordStep(cascade)
  recordStep(cascade)
  assert.deepEqual(recordVerification(cascade, true), { from: 'large', to: 'small', reason: 'verifier-passed' })
})

test('a failure while large resets the pass streak and does not change the tier', () => {
  const cascade = createCascade()
  recordVerification(cascade, false)
  recordVerification(cascade, true)
  assert.equal(recordVerification(cascade, false), null)
  assert.equal(cascade.consecutivePasses, 0)
  assert.equal(cascade.tier, 'large')
})

test('escalate forces the large tier once and is a no-op afterwards', () => {
  const cascade = createCascade()
  assert.deepEqual(escalate(cascade, 'loop-breaker'), { from: 'small', to: 'large', reason: 'loop-breaker' })
  assert.equal(escalate(cascade, 'loop-breaker'), null)
})

test('a higher escalation threshold tolerates one failure', () => {
  const cascade = createCascade({ escalateAfterFailures: 2 })
  assert.equal(recordVerification(cascade, false), null)
  assert.equal(recordVerification(cascade, false)?.to, 'large')
})

test('switching tiers resets the counters that belong to the previous tier', () => {
  const cascade = createCascade()
  recordStep(cascade)
  recordVerification(cascade, false)
  assert.equal(cascade.stepsInTier, 0)
  assert.equal(cascade.consecutiveFailures, 0)
})
