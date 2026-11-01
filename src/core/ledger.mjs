import { appendFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'

/** Bytes buffered before a file is flushed even if the timer has not fired yet. */
const FLUSH_BYTES = 64 * 1024
/** Milliseconds between background flushes. */
const FLUSH_MS = 250
/** Largest single record kept; a longer one is truncated rather than growing without bound. */
const MAX_RECORD_BYTES = 256 * 1024
/** Ledgers with buffered records, flushed synchronously if the process exits before the timer. */
const liveLedgers = new Set()

function flushAllSync() {
  for (const ledger of liveLedgers) {
    try {
      ledger.flushSync()
    } catch {
      // an exit hook must never throw
    }
  }
}

/**
 * Cost and decision ledger: one JSON object per line, appended as events happen.
 *
 * Records are buffered in memory and flushed on a timer (or when the buffer is large), so the
 * agent loop never waits on disk. Each session can write its own file, so cost can be attributed
 * per workspace instead of being pooled into one process-wide log. Files rotate once at
 * `maxBytes` so a long-lived server cannot fill the disk with one JSONL file.
 *
 * Record types: `request` (provider usage per model step), `tool` (per tool result, with the
 * distillation or dedupe action), `route` (tier change), `loop-break` (denied command), `triage`,
 * `notice-stripped`, `notice-kept`, `error`.
 *
 * @param {{
 *   path?: string,
 *   perSession?: boolean,
 *   maxBytes?: number,
 *   flushMs?: number,
 *   cwdFor?: (sessionId: string) => string | undefined,
 *   logger?: { warn(message: string): void },
 * }} [options]
 * @returns {{
 *   enabled: boolean,
 *   fileFor(sessionId?: string): string,
 *   write(record: Record<string, unknown>): void,
 *   flush(): Promise<void>,
 *   flushSync(): void,
 *   dispose(): Promise<void>,
 *   pending(): number,
 * }}
 */
export function createLedger(options = {}) {
  const configured = typeof options.path === 'string' ? options.path : '.greenharness/ledger.jsonl'
  const perSession = options.perSession !== false
  const maxBytes = Number.isFinite(options.maxBytes) ? Math.max(0, options.maxBytes) : 4 * 1024 * 1024
  const flushMs = Number.isFinite(options.flushMs) ? Math.max(0, options.flushMs) : FLUSH_MS
  const cwdFor = typeof options.cwdFor === 'function' ? options.cwdFor : () => undefined
  const logger = options.logger

  if (configured === '') {
    return {
      enabled: false,
      fileFor: () => '',
      write() {},
      flush: async () => {},
      flushSync() {},
      dispose: async () => {},
      pending: () => 0,
    }
  }

  const registration = { flushSync }
  /** @type {Map<string, { lines: string[], bytes: number, size: number | undefined, rotated: boolean }>} */
  const buffers = new Map()
  let timer
  let warned = false
  let disposed = false
  let inFlight = Promise.resolve()

  /** Replace anything a filesystem would reject, so a session id is safe as a filename. */
  function safeSession(sessionId) {
    return String(sessionId).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 96) || 'session'
  }

  /**
   * The file one session writes to. `{session}` in the configured path is substituted; without
   * the placeholder the session id is inserted before the extension. Relative paths are resolved
   * against the session's own workspace, never the server's launch directory.
   * @param {string} [sessionId]
   * @returns {string}
   */
  function fileFor(sessionId) {
    const base = isAbsolute(configured) ? configured : resolve(cwdFor(sessionId ?? '') ?? process.cwd(), configured)
    if (!perSession || !sessionId) return base
    if (base.includes('{session}')) return base.split('{session}').join(safeSession(sessionId))
    const extension = extname(base)
    const stem = extension === '' ? base : base.slice(0, -extension.length)
    return `${stem}-${safeSession(sessionId)}${extension}`
  }

  function warnOnce(error) {
    if (warned) return
    warned = true
    logger?.warn?.(`greenharness: ledger write failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  function ensureTimer() {
    if (timer !== undefined || flushMs === 0 || disposed) return
    timer = setInterval(() => { void flush() }, flushMs)
    timer.unref?.()
  }

  function bufferOf(file) {
    let buffer = buffers.get(file)
    if (buffer === undefined) {
      buffer = { lines: [], bytes: 0, size: undefined, rotated: false }
      buffers.set(file, buffer)
    }
    return buffer
  }

  /** Keep the ledger from growing past `maxBytes` by rotating one generation. */
  async function rotateIfNeeded(file, buffer, incomingBytes) {
    if (maxBytes === 0) return
    if (buffer.size === undefined) {
      try {
        buffer.size = (await stat(file)).size
      } catch {
        buffer.size = 0
      }
    }
    if (buffer.rotated || buffer.size + incomingBytes <= maxBytes) return
    buffer.rotated = true
    try {
      await rm(`${file}.1`, { force: true })
      await rename(file, `${file}.1`)
      buffer.size = 0
    } catch (error) {
      // A missing file is the common case on the first rotation.
      if (error?.code !== 'ENOENT') warnOnce(error)
      buffer.size = 0
    }
  }

  function takeBatch() {
    const batch = []
    for (const [file, buffer] of buffers) {
      if (buffer.lines.length === 0) continue
      const payload = buffer.lines.join('')
      const bytes = buffer.bytes
      buffer.lines = []
      buffer.bytes = 0
      batch.push({ file, payload, bytes, buffer })
    }
    return batch
  }

  async function flush() {
    const batch = takeBatch()
    if (batch.length === 0) return
    inFlight = inFlight.then(async () => {
      for (const { file, payload, bytes, buffer } of batch) {
        try {
          await mkdir(dirname(file), { recursive: true })
          await rotateIfNeeded(file, buffer, bytes)
          await appendFile(file, payload)
          buffer.size = (buffer.size ?? 0) + bytes
        } catch (error) {
          warnOnce(error)
        }
      }
    })
    await inFlight
  }

  function flushSync() {
    for (const { file, payload, bytes, buffer } of takeBatch()) {
      try {
        mkdirSync(dirname(file), { recursive: true })
        appendFileSync(file, payload)
        buffer.size = (buffer.size ?? 0) + bytes
      } catch (error) {
        warnOnce(error)
      }
    }
  }

  async function dispose() {
    if (disposed) return
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
    await flush()
    disposed = true
    liveLedgers.delete(registration)
    if (liveLedgers.size === 0) process.off?.('exit', flushAllSync)
  }

  liveLedgers.add(registration)
  if (liveLedgers.size === 1) process.once?.('exit', flushAllSync)

  return {
    enabled: true,
    fileFor,
    /**
     * Queue one record. The write itself happens on the next flush, off the agent's critical path.
     * @param {Record<string, unknown>} record
     */
    write(record) {
      if (disposed) return
      const sessionId = typeof record.session === 'string' ? record.session : undefined
      const file = fileFor(sessionId)
      let line = JSON.stringify({ ts: new Date().toISOString(), ...record })
      if (line.length > MAX_RECORD_BYTES) {
        line = JSON.stringify({
          ts: record.ts ?? new Date().toISOString(),
          type: record.type ?? 'truncated',
          session: sessionId,
          truncated: true,
          bytes: line.length,
        })
      }
      const buffer = bufferOf(file)
      buffer.lines.push(`${line}\n`)
      buffer.bytes += line.length + 1
      ensureTimer()
      if (buffer.bytes >= FLUSH_BYTES) void flush()
    },
    flush,
    flushSync,
    dispose,
    pending() {
      let total = 0
      for (const buffer of buffers.values()) total += buffer.lines.length
      return total
    },
  }
}

/**
 * Delete the oldest files in one output directory, so spilling full tool output stays bounded.
 * @param {string} dir - directory holding spilled outputs.
 * @param {number} keep - how many of the newest files to keep; 0 disables pruning.
 * @returns {Promise<number>} how many files were removed.
 */
export async function pruneOutputs(dir, keep) {
  if (!Number.isFinite(keep) || keep <= 0) return 0
  let names
  try {
    names = await readdir(dir)
  } catch {
    return 0
  }
  if (names.length <= keep) return 0
  const stamped = []
  for (const name of names) {
    try {
      const info = await stat(join(dir, name))
      if (info.isFile()) stamped.push({ name, at: info.mtimeMs })
    } catch {
      // ignore a file that vanished mid-scan
    }
  }
  stamped.sort((left, right) => right.at - left.at)
  let removed = 0
  for (const entry of stamped.slice(keep)) {
    try {
      await rm(join(dir, entry.name), { force: true })
      removed += 1
    } catch {
      // ignore
    }
  }
  return removed
}
