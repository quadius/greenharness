import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clearSession, createReadIndex, findUnchangedRead, forgetPath, rememberRead } from '../src/core/read-index.mjs'

test('an identical re-read of the same range is found; a changed one is not', () => {
  const index = createReadIndex()
  rememberRead(index, 's1', { path: 'src/a.mjs', offset: null, limit: null, digest: 'd1', callId: 'call-1' })
  assert.equal(findUnchangedRead(index, 's1', { path: 'src/a.mjs', offset: null, limit: null, digest: 'd1' }), 'call-1')
  assert.equal(findUnchangedRead(index, 's1', { path: 'src/a.mjs', offset: null, limit: null, digest: 'd2' }), undefined)
})

test('different line ranges of one file are separate entries', () => {
  const index = createReadIndex()
  rememberRead(index, 's1', { path: 'a.mjs', offset: 1, limit: 50, digest: 'd1', callId: 'call-1' })
  assert.equal(findUnchangedRead(index, 's1', { path: 'a.mjs', offset: 51, limit: 50, digest: 'd1' }), undefined)
})

test('sessions do not share entries', () => {
  const index = createReadIndex()
  rememberRead(index, 's1', { path: 'a.mjs', offset: null, limit: null, digest: 'd1', callId: 'call-1' })
  assert.equal(findUnchangedRead(index, 's2', { path: 'a.mjs', offset: null, limit: null, digest: 'd1' }), undefined)
})

test('an edit forgets every range of the path', () => {
  const index = createReadIndex()
  rememberRead(index, 's1', { path: 'a.mjs', offset: null, limit: null, digest: 'd1', callId: 'call-1' })
  rememberRead(index, 's1', { path: 'b.mjs', offset: null, limit: null, digest: 'd2', callId: 'call-2' })
  forgetPath(index, 's1', 'a.mjs')
  assert.equal(findUnchangedRead(index, 's1', { path: 'a.mjs', offset: null, limit: null, digest: 'd1' }), undefined)
  assert.equal(findUnchangedRead(index, 's1', { path: 'b.mjs', offset: null, limit: null, digest: 'd2' }), 'call-2')
})

test('compaction clears the session index', () => {
  const index = createReadIndex()
  rememberRead(index, 's1', { path: 'a.mjs', offset: null, limit: null, digest: 'd1', callId: 'call-1' })
  clearSession(index, 's1')
  assert.equal(findUnchangedRead(index, 's1', { path: 'a.mjs', offset: null, limit: null, digest: 'd1' }), undefined)
})
