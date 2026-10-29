import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyRequest, latestUserMessage, parseVerdict, planFor, scoreRequest } from '../src/core/triage.mjs'

test('a greenfield build goes to the large model', () => {
  const result = classifyRequest('Generate a 3D model of a horse using JavaScript and three.js')
  assert.equal(result.verdict, 'large')
  assert.ok(result.score >= 0.6)
})

test('a debugging request stays on the small tier: the cascade covers it', () => {
  assert.equal(classifyRequest('Fix the failing tests in this project. Run node --test to check your work.').verdict, 'small')
})

test('a greeting and an empty request are small', () => {
  assert.equal(classifyRequest('hello').verdict, 'small')
  assert.equal(classifyRequest('').verdict, 'small')
})

test('a request that needs scaffolding first is mixed', () => {
  assert.equal(classifyRequest('Create a shader for a water effect').verdict, 'mixed')
})

test('a long brief with several systems is large', () => {
  const result = classifyRequest('Build a full-stack dashboard with charts, an API and a small server. Keep it simple but complete and usable.')
  assert.equal(result.verdict, 'large')
})

test('a plan follows the verdict', () => {
  assert.deepEqual(planFor('mixed'), ['small: first steps', 'large: main work'])
  assert.equal(planFor('large').length, 1)
})

test('scoreRequest reports the signals it used', () => {
  const { signals } = scoreRequest('Generate a 3D scene')
  assert.ok(signals.includes('build-verb'))
  assert.ok(signals.some(s => s.startsWith('domain')))
})

test('parseVerdict reads a one-word model reply', () => {
  assert.equal(parseVerdict('Large'), 'large')
  assert.equal(parseVerdict('mixed.'), 'mixed')
  assert.equal(parseVerdict('I cannot'), undefined)
})

test('latestUserMessage picks the last user turn and skips model notices', () => {
  const messages = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'second' },
    { role: 'user', content: 'notice', source: { kind: 'model-selection' } },
  ]
  assert.equal(latestUserMessage(messages), 'second')
  assert.equal(latestUserMessage([]), undefined)
})
