import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_VERIFIER_PATTERNS, classifyOutcome, compileVerifierPatterns, fingerprintOf,
  isVerifierCommand, normalizeCommand, parseExitMarker,
} from '../src/core/verify.mjs'

const patterns = compileVerifierPatterns(DEFAULT_VERIFIER_PATTERNS)

test('recognises common verifier commands and ignores ordinary shell', () => {
  for (const command of ['npm test', 'pnpm run test -- --watch=false', 'node --test test/', 'python3 -m pytest -q', 'go test ./...', 'cargo test', 'tsc --noEmit', 'npx vitest run']) {
    assert.equal(isVerifierCommand(command, patterns), true, command)
  }
  for (const command of ['ls -la', 'cat src/index.mjs', 'grep -n foo src', 'git status']) {
    assert.equal(isVerifierCommand(command, patterns), false, command)
  }
})

test('exit-code marker is read from rendered output', () => {
  assert.equal(parseExitMarker('boom\n[exit code: 2]'), 2)
  assert.equal(parseExitMarker('all good'), undefined)
})

test('passing runs have no fingerprint; failing runs carry one', () => {
  assert.deepEqual(classifyOutcome({ exitCode: 0, text: 'ok' }), { passed: true, exitCode: 0, timedOut: false, fingerprint: null })
  const failed = classifyOutcome({ exitCode: 1, text: 'not ok 1 - adds\nAssertionError: expected 2 got 3' })
  assert.equal(failed.passed, false)
  assert.match(failed.fingerprint, /^[0-9a-f]{12}$/)
})

test('a timeout is a failure even with exit code 0', () => {
  assert.equal(classifyOutcome({ exitCode: 0, timedOut: true, text: '' }).passed, false)
})

test('fingerprint ignores digits and durations but separates different failures', () => {
  const a = fingerprintOf('FAIL adds: expected 2 received 3 (12ms) at line 40')
  const b = fingerprintOf('FAIL adds: expected 7 received 9 (3ms) at line 41')
  const c = fingerprintOf('FAIL subtract: expected 2 received 3')
  assert.equal(a, b)
  assert.notEqual(a, c)
})

test('command keys collapse whitespace', () => {
  assert.equal(normalizeCommand('  node   --test  test/ '), 'node --test test/')
  assert.equal(normalizeCommand(undefined), '')
})
