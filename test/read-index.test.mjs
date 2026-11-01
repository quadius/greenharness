import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  clearSession, createReadIndex, findUnchangedRead, forgetPath, markReadPointed, rememberRead,
} from '../src/core/read-index.mjs'

const read = (overrides = {}) => ({ path: 'src/a.mjs', offset: null, limit: null, digest: 'd1', ...overrides })

test('an identical re-read of the same range is found; a changed one is not', () => {
  const index = createReadIndex()
  rememberRead(index, 's1', { ...read(), callId: 'call-1' })
  assert.deepEqual(findUnchangedRead(index, 's1', read()), { callId: 'call-1', pointed: false })
  assert.equal(findUnchangedRead(index, 's1', read({ digest: 'd2' })), undefined)
})

test('different line ranges of one file are separate entries', () => {
  const index = createReadIndex()
  rememberRead(index, 's1', { ...read({ offset: 1, limit: 50 }), callId: 'call-1' })
  assert.equal(findUnchangedRead(index, 's1', read({ offset: 51, limit: 50 })), undefined)
})

test('sessions do not share entries', () => {
  const index = createReadIndex()
  rememberRead(index, 's1', { ...read(), callId: 'call-1' })
  assert.equal(findUnchangedRead(index, 's2', read()), undefined)
})

test('an edit forgets every range of the path', () => {
  const index = createReadIndex()
  rememberRead(index, 's1', { ...read(), callId: 'call-1' })
  rememberRead(index, 's1', { ...read({ path: 'b.mjs', digest: 'd2' }), callId: 'call-2' })
  forgetPath(index, 's1', 'src/a.mjs')
  assert.equal(findUnchangedRead(index, 's1', read()), undefined)
  assert.deepEqual(findUnchangedRead(index, 's1', read({ path: 'b.mjs', digest: 'd2' })), { callId: 'call-2', pointed: false })
})

test('compaction clears the session index', () => {
  const index = createReadIndex()
  rememberRead(index, 's1', { ...read(), callId: 'call-1' })
  clearSession(index, 's1')
  assert.equal(findUnchangedRead(index, 's1', read()), undefined)
})

test('a served pointer is remembered so the next identical read gets the content', () => {
  const index = createReadIndex()
  rememberRead(index, 's1', { ...read(), callId: 'call-1' })
  markReadPointed(index, 's1', read())
  assert.deepEqual(findUnchangedRead(index, 's1', read()), { callId: 'call-1', pointed: true })
  // remembering the range again resets the flag
  rememberRead(index, 's1', { ...read(), callId: 'call-2' })
  assert.deepEqual(findUnchangedRead(index, 's1', read()), { callId: 'call-2', pointed: false })
})
