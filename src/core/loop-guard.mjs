import { normalizeCommand } from './verify.mjs'

/**
 * Loop guard: counts consecutive runs of the same command that fail with the same failure
 * fingerprint. A run with a different fingerprint is progress and restarts the count; a
 * passing run clears it; any workspace edit clears every count.
 */

/**
 * Create an empty loop-guard state for one session.
 * @returns {{ streaks: Map<string, { count: number, fingerprint: string }> }}
 */
export function createLoopGuard() {
  return { streaks: new Map() }
}

/**
 * Record the outcome of an executed command.
 * @param {ReturnType<typeof createLoopGuard>} guard - the session's loop-guard state (mutated).
 * @param {string} command - the command text.
 * @param {{ passed: boolean, fingerprint: string | null }} outcome - from `classifyOutcome`.
 * @returns {number} the current consecutive count for this command (0 after a pass).
 */
export function recordCommandOutcome(guard, command, outcome) {
  const key = normalizeCommand(command)
  if (outcome.passed || outcome.fingerprint === null) {
    guard.streaks.delete(key)
    return 0
  }
  const previous = guard.streaks.get(key)
  const count = previous !== undefined && previous.fingerprint === outcome.fingerprint ? previous.count + 1 : 1
  guard.streaks.set(key, { count, fingerprint: outcome.fingerprint })
  return count
}

/**
 * Consecutive same-fingerprint failures for one command.
 * @param {ReturnType<typeof createLoopGuard>} guard - the session's loop-guard state.
 * @param {string} command - the command text.
 * @returns {number} the count, 0 when the command has no active streak.
 */
export function streakOf(guard, command) {
  return guard.streaks.get(normalizeCommand(command))?.count ?? 0
}

/**
 * Clear every streak after a workspace change, because a failing command may pass now.
 * @param {ReturnType<typeof createLoopGuard>} guard - the session's loop-guard state (mutated).
 */
export function noteWorkspaceChange(guard) {
  guard.streaks.clear()
}
