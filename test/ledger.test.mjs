import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLedger, pruneOutputs } from '../src/core/ledger.mjs'

async function workspace() {
  return mkdtemp(join(tmpdir(), 'greenharness-ledger-'))
}

test('a session writes its own file inside its own workspace', async () => {
  const cwd = await workspace()
  const ledger = createLedger({ path: '.greenharness/ledger.jsonl', perSession: true, cwdFor: () => cwd, flushMs: 0 })
  const file = ledger.fileFor('session-abc')
  assert.equal(file, join(cwd, '.greenharness', 'ledger-session-abc.jsonl'))
  ledger.write({ type: 'request', session: 'session-abc', tier: 'small' })
  await ledger.flush()
  const lines = (await readFile(file, 'utf8')).trim().split('\n')
  assert.equal(lines.length, 1)
  const record = JSON.parse(lines[0])
  assert.equal(record.type, 'request')
  assert.equal(record.tier, 'small')
  assert.match(record.ts, /^\d{4}-\d{2}-\d{2}T/)
  await ledger.dispose()
})

test('{session} in the path is substituted, and ids cannot escape the directory', async () => {
  const cwd = await workspace()
  const ledger = createLedger({ path: 'logs/{session}.jsonl', perSession: true, cwdFor: () => cwd, flushMs: 0 })
  assert.equal(ledger.fileFor('a/b..c'), join(cwd, 'logs', 'a_b..c.jsonl'))
  ledger.write({ type: 'triage', session: 'a/b..c' })
  await ledger.flush()
  const names = await readdir(join(cwd, 'logs'))
  assert.deepEqual(names, ['a_b..c.jsonl'])
  await ledger.dispose()
})

test('records are buffered and only hit the disk on a flush', async () => {
  const cwd = await workspace()
  const ledger = createLedger({ path: 'l.jsonl', perSession: false, cwdFor: () => cwd, flushMs: 0 })
  ledger.write({ type: 'tool', action: 'distill' })
  const file = join(cwd, 'l.jsonl')
  await assert.rejects(readFile(file, 'utf8'), 'nothing written yet')
  assert.equal(ledger.pending(), 1)
  await ledger.flush()
  assert.equal(ledger.pending(), 0)
  assert.match(await readFile(file, 'utf8'), /"action":"distill"/)
  await ledger.dispose()
})

test('flushSync drains the buffer synchronously, for process exit', async () => {
  const cwd = await workspace()
  const ledger = createLedger({ path: 'sync.jsonl', perSession: false, cwdFor: () => cwd, flushMs: 0 })
  ledger.write({ type: 'route', from: 'small', to: 'large' })
  ledger.flushSync()
  assert.match(await readFile(join(cwd, 'sync.jsonl'), 'utf8'), /"to":"large"/)
  await ledger.dispose()
})

test('a ledger rotates once instead of growing without bound', async () => {
  const cwd = await workspace()
  const ledger = createLedger({ path: 'rot.jsonl', perSession: false, cwdFor: () => cwd, maxBytes: 400, flushMs: 0 })
  const file = join(cwd, 'rot.jsonl')
  for (let i = 0; i < 12; i += 1) {
    ledger.write({ type: 'tool', action: 'none', i })
    await ledger.flush()
  }
  const names = await readdir(cwd)
  assert.ok(names.includes('rot.jsonl'), 'the live file stays')
  assert.ok(names.includes('rot.jsonl.1'), 'the previous generation is kept')
  await ledger.dispose()
})

test('an empty path disables the ledger entirely', async () => {
  const ledger = createLedger({ path: '', cwdFor: () => tmpdir() })
  assert.equal(ledger.enabled, false)
  ledger.write({ type: 'request' })
  ledger.flushSync()
  assert.equal(await ledger.flush(), undefined)
  await ledger.dispose()
})

test('one oversized record is replaced by a marker instead of filling the log', async () => {
  const cwd = await workspace()
  const ledger = createLedger({ path: 'big.jsonl', perSession: false, cwdFor: () => cwd, flushMs: 0 })
  ledger.write({ type: 'tool', action: 'none', blob: 'x'.repeat(300 * 1024) })
  await ledger.flush()
  const record = JSON.parse((await readFile(join(cwd, 'big.jsonl'), 'utf8')).trim())
  assert.equal(record.truncated, true)
  assert.ok(record.bytes > 300 * 1000)
  await ledger.dispose()
})

test('pruning keeps the newest output files only', async () => {
  const dir = await workspace()
  for (let i = 0; i < 6; i += 1) {
    await writeFile(join(dir, `${i}.txt`), 'x')
    // make the mtime order explicit: later files are newer
    await new Promise(done => setTimeout(done, 5))
  }
  const removed = await pruneOutputs(dir, 2)
  assert.equal(removed, 4)
  const left = (await readdir(dir)).sort()
  assert.deepEqual(left, ['4.txt', '5.txt'])
})
