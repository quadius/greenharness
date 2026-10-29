import { createHash } from 'node:crypto'
import { stripAnsi } from './ansi.mjs'
import { FAIL_RE } from './patterns.mjs'

/**
 * Command patterns that count as verifiers: test runners, type checkers, linters and build checks.
 * A bash call matching one of these is a verifier call, and its exit status drives the cascade.
 */
export const DEFAULT_VERIFIER_PATTERNS = [
  String.raw`\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b`,
  String.raw`\b(?:pytest|py\.test)\b`,
  String.raw`\bpython3?\s+-m\s+(?:pytest|unittest)\b`,
  String.raw`\bnode\s+--test\b`,
  String.raw`\b(?:vitest|jest|mocha)\b`,
  String.raw`\bgo\s+test\b`,
  String.raw`\bcargo\s+(?:test|check|clippy)\b`,
  String.raw`\b(?:tsc|mypy|ruff|eslint)\b`,
  String.raw`\bmake\s+(?:test|check)\b`,
]

/**
 * Compile verifier command patterns.
 * @param {string[]} sources - regular-expression sources, matched case-insensitively.
 * @returns {RegExp[]} compiled patterns.
 */
export function compileVerifierPatterns(sources) {
  return sources.map(source => new RegExp(source, 'i'))
}

/**
 * Whether a command is a verifier call.
 * @param {string} command - the bash command text.
 * @param {RegExp[]} patterns - compiled verifier patterns.
 * @returns {boolean} true when any pattern matches.
 */
export function isVerifierCommand(command, patterns) {
  return patterns.some(pattern => pattern.test(command))
}

/**
 * Read the `[exit code: N]` marker that the bash tool appends to non-zero results.
 * @param {string} text - rendered tool output.
 * @returns {number | undefined} the exit code, or undefined when no marker is present.
 */
export function parseExitMarker(text) {
  const match = /\[exit code: (-?\d+)\]/.exec(text)
  return match ? Number(match[1]) : undefined
}

/**
 * Stable identity of one failure: the normalized failure lines with digits, durations and
 * addresses removed. The same failure at a different line or timing gets the same fingerprint.
 * @param {string} text - rendered tool output of the failing command.
 * @returns {string} a 12-character hex digest.
 */
export function fingerprintOf(text) {
  const lines = stripAnsi(String(text ?? '')).split('\n')
  let signal = lines.filter(line => FAIL_RE.test(line)).slice(0, 8)
  if (signal.length === 0) signal = lines.filter(line => line.trim() !== '').slice(-5)
  const normalized = signal
    .map(line => line
      .replace(/0x[0-9a-f]+/gi, '#')
      .replace(/\d+(?:\.\d+)?\s*(?:ms|s|µs)\b/g, '#')
      .replace(/\d+/g, '#')
      .replace(/\s+/g, ' ')
      .trim())
    .join('\n')
  return createHash('sha1').update(normalized).digest('hex').slice(0, 12)
}

/**
 * Classify the outcome of one executed command.
 * @param {{ exitCode: number, timedOut?: boolean, text?: string }} run - exit status, timeout flag and rendered output.
 * @returns {{ passed: boolean, exitCode: number, timedOut: boolean, fingerprint: string | null }}
 *   `fingerprint` is null for passing runs.
 */
export function classifyOutcome({ exitCode, timedOut = false, text = '' }) {
  const passed = !timedOut && exitCode === 0
  return { passed, exitCode, timedOut, fingerprint: passed ? null : fingerprintOf(text) }
}

/**
 * Canonical spelling of a command for keys: whitespace collapsed and trimmed.
 * @param {unknown} command - the command argument.
 * @returns {string} the normalized command, empty when absent.
 */
export function normalizeCommand(command) {
  return String(command ?? '').trim().replace(/\s+/g, ' ')
}
