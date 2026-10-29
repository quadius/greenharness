import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLoopGuard, noteWorkspaceChange, recordCommandOutcome, streakOf } from '../src/core/loop-guard.mjs'

const failing = fingerprint => ({ passed: false, fingerprint })
const passing = { passed: true, fingerprint: null }

test('the same failure repeated on the same command builds a streak', () => {
  const guard = createLoopGuard()
  assert.equal(recordCommandOutcome(guard, 'node --test', failing('aa')), 1)
  assert.equal(recordCommandOutcome(guard, 'node --test', failing('aa')), 2)
  assert.equal(recordCommandOutcome(guard, 'node  --test ', failing('aa')), 3, 'whitespace differences share a key')
  assert.equal(streakOf(guard, 'node --test'), 3)
})

test('a different failure fingerprint is progress and restarts the streak', () => {
  const guard = createLoopGuard()
  recordCommandOutcome(guard, 'npm test', failing('aa'))
  recordCommandOutcome(guard, 'npm test', failing('aa'))
  assert.equal(recordCommandOutcome(guard, 'npm test', failing('bb')), 1)
})

test('a passing run clears the streak', () => {
  const guard = createLoopGuard()
  recordCommandOutcome(guard, 'npm test', failing('aa'))
  assert.equal(recordCommandOutcome(guard, 'npm test', passing), 0)
  assert.equal(streakOf(guard, 'npm test'), 0)
})

test('a workspace change clears every streak', () => {
  const guard = createLoopGuard()
  recordCommandOutcome(guard, 'npm test', failing('aa'))
  recordCommandOutcome(guard, 'node --test', failing('bb'))
  noteWorkspaceChange(guard)
  assert.equal(streakOf(guard, 'npm test'), 0)
  assert.equal(streakOf(guard, 'node --test'), 0)
})
