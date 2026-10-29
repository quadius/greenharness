import { test } from 'node:test'
import assert from 'node:assert/strict'
import { add, subtract } from '../src/math.mjs'

test('adds two numbers', () => {
  assert.equal(add(2, 3), 5)
})

test('subtracts b from a', () => {
  assert.equal(subtract(5, 3), 2)
})
