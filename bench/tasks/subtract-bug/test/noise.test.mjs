import { test } from 'node:test'
import assert from 'node:assert/strict'

// Passing filler that makes the raw runner output long, so distillation has work to do.
for (let i = 0; i < 300; i += 1) {
  test(`filler case ${i}`, () => {
    assert.ok(i >= 0)
  })
}
