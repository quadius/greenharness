import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Cost and decision ledger: one JSON object per line, appended as events happen.
 * Record types: `request` (provider usage per model step), `tool` (per tool result, with the
 * distillation or dedupe action), `route` (tier change), `loop-break` (denied command).
 *
 * @param {string} path - JSONL file to append to; an empty value disables the ledger.
 * @returns {{ path: string, write(record: Record<string, unknown>): void }}
 */
export function createLedger(path) {
  if (!path) return { path: '', write() {} }
  mkdirSync(dirname(path), { recursive: true })
  return {
    path,
    write(record) {
      appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`)
    },
  }
}
