/**
 * Content-addressed index of file reads still visible in the model context.
 *
 * A read whose rendered content is byte-identical to an earlier read of the same file range can
 * be replaced by a short pointer to that earlier result. Two rules keep the model from being
 * trapped: the same range is short-circuited at most once in a row (the next identical read is
 * served in full again), and the index is cleared on compaction or pruning and forgets a path
 * whenever the agent edits or rewrites it.
 */

/**
 * Create an empty read index.
 * @returns {{ bySession: Map<string, Map<string, { path: string, digest: string, callId: string, pointed: boolean }>> }}
 */
export function createReadIndex() {
  return { bySession: new Map() }
}

/**
 * Key for one file range.
 * @param {string} path - the file path as the agent passed it.
 * @param {number | null} offset - first line, or null when defaulted.
 * @param {number | null} limit - line count, or null when defaulted.
 * @returns {string} the range key.
 */
export function rangeKey(path, offset, limit) {
  return JSON.stringify([path, offset ?? null, limit ?? null])
}

/**
 * Record a successful read.
 * @param {ReturnType<typeof createReadIndex>} index - the read index (mutated).
 * @param {string} sessionId - the owning session.
 * @param {{ path: string, offset?: number | null, limit?: number | null, digest: string, callId: string }} read - the read.
 */
export function rememberRead(index, sessionId, read) {
  const entries = index.bySession.get(sessionId) ?? new Map()
  entries.set(rangeKey(read.path, read.offset, read.limit), {
    path: read.path,
    digest: read.digest,
    callId: read.callId,
    pointed: false,
  })
  index.bySession.set(sessionId, entries)
}

/**
 * Find an earlier read of the same range with identical content.
 * @param {ReturnType<typeof createReadIndex>} index - the read index.
 * @param {string} sessionId - the owning session.
 * @param {{ path: string, offset?: number | null, limit?: number | null, digest: string }} read - the new read.
 * @returns {{ callId: string, pointed: boolean } | undefined} the earlier read, when its content matches.
 */
export function findUnchangedRead(index, sessionId, read) {
  const entry = index.bySession.get(sessionId)?.get(rangeKey(read.path, read.offset, read.limit))
  if (entry === undefined || entry.digest !== read.digest) return undefined
  return { callId: entry.callId, pointed: entry.pointed }
}

/**
 * Remember that a pointer was served for one range, so the next identical read gets the content.
 * @param {ReturnType<typeof createReadIndex>} index - the read index (mutated).
 * @param {string} sessionId - the owning session.
 * @param {{ path: string, offset?: number | null, limit?: number | null }} read - the deduped read.
 */
export function markReadPointed(index, sessionId, read) {
  const entry = index.bySession.get(sessionId)?.get(rangeKey(read.path, read.offset, read.limit))
  if (entry !== undefined) entry.pointed = true
}

/**
 * Forget every indexed range of a path, after the agent edited or rewrote it.
 * @param {ReturnType<typeof createReadIndex>} index - the read index (mutated).
 * @param {string} sessionId - the owning session.
 * @param {string} path - the changed file path.
 */
export function forgetPath(index, sessionId, path) {
  const entries = index.bySession.get(sessionId)
  if (entries === undefined) return
  for (const [key, entry] of entries) {
    if (entry.path === path) entries.delete(key)
  }
}

/**
 * Forget a session's whole index, after compaction or pruning removed earlier results from context.
 * @param {ReturnType<typeof createReadIndex>} index - the read index (mutated).
 * @param {string} sessionId - the owning session.
 */
export function clearSession(index, sessionId) {
  index.bySession.delete(sessionId)
}
