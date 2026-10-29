/**
 * Content-addressed index of file reads still visible in the model context.
 *
 * A read whose rendered content is byte-identical to an earlier read of the same file range
 * can be replaced by a short pointer to that earlier result. The pointer is only valid while
 * the earlier result is still in context, so the index is cleared on compaction and pruning
 * and forgets a path whenever the agent edits or rewrites it.
 */

/**
 * Create an empty read index.
 * @returns {{ bySession: Map<string, Map<string, { path: string, digest: string, callId: string }>> }}
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
function rangeKey(path, offset, limit) {
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
  entries.set(rangeKey(read.path, read.offset, read.limit), { path: read.path, digest: read.digest, callId: read.callId })
  index.bySession.set(sessionId, entries)
}

/**
 * Find an earlier read of the same range with identical content.
 * @param {ReturnType<typeof createReadIndex>} index - the read index.
 * @param {string} sessionId - the owning session.
 * @param {{ path: string, offset?: number | null, limit?: number | null, digest: string }} read - the new read.
 * @returns {string | undefined} the call id of the identical earlier read, if one is indexed.
 */
export function findUnchangedRead(index, sessionId, read) {
  const entry = index.bySession.get(sessionId)?.get(rangeKey(read.path, read.offset, read.limit))
  return entry !== undefined && entry.digest === read.digest ? entry.callId : undefined
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
