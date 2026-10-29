/**
 * Two-tier model cascade: a small model runs by default; a verifier failure moves the next
 * step to the large model; verifier passes move back once they are stable. Pure state
 * machine: callers read the returned change and apply it to the agent.
 */

/** Default policy: escalate on the first failure, return after two passes, and stay at least two steps per tier. */
export const DEFAULT_CASCADE_POLICY = Object.freeze({
  escalateAfterFailures: 1,
  deescalateAfterPasses: 2,
  minStepsPerTier: 2,
})

/**
 * Create cascade state for one session.
 * @param {Partial<typeof DEFAULT_CASCADE_POLICY>} [policy] - overrides for the default policy.
 * @returns {{ policy: typeof DEFAULT_CASCADE_POLICY, tier: 'small' | 'large', stepsInTier: number, consecutiveFailures: number, consecutivePasses: number }}
 */
export function createCascade(policy = {}) {
  return {
    policy: { ...DEFAULT_CASCADE_POLICY, ...policy },
    tier: 'small',
    stepsInTier: 0,
    consecutiveFailures: 0,
    consecutivePasses: 0,
  }
}

/**
 * Count one completed model step in the current tier.
 * @param {ReturnType<typeof createCascade>} cascade - the session's cascade state (mutated).
 */
export function recordStep(cascade) {
  cascade.stepsInTier += 1
}

/**
 * Apply a verifier outcome to the cascade.
 * @param {ReturnType<typeof createCascade>} cascade - the session's cascade state (mutated).
 * @param {boolean} passed - whether the verifier command passed.
 * @returns {{ from: string, to: string, reason: string } | null} the tier change, or null when the tier stays.
 */
export function recordVerification(cascade, passed) {
  if (passed) {
    cascade.consecutiveFailures = 0
    cascade.consecutivePasses += 1
    const stable = cascade.consecutivePasses >= cascade.policy.deescalateAfterPasses
      && cascade.stepsInTier >= cascade.policy.minStepsPerTier
    return cascade.tier === 'large' && stable ? switchTier(cascade, 'small', 'verifier-passed') : null
  }
  cascade.consecutivePasses = 0
  cascade.consecutiveFailures += 1
  const escalate = cascade.consecutiveFailures >= cascade.policy.escalateAfterFailures
  return cascade.tier === 'small' && escalate ? switchTier(cascade, 'large', 'verifier-failed') : null
}

/**
 * Force the large tier, for example when the loop breaker fires.
 * @param {ReturnType<typeof createCascade>} cascade - the session's cascade state (mutated).
 * @param {string} reason - audit reason recorded with the change.
 * @returns {{ from: string, to: string, reason: string } | null} the tier change, or null when already large.
 */
export function escalate(cascade, reason) {
  return cascade.tier === 'large' ? null : switchTier(cascade, 'large', reason)
}

/**
 * Move to another tier and reset the counters that belong to the old tier.
 * @param {ReturnType<typeof createCascade>} cascade - the session's cascade state (mutated).
 * @param {'small' | 'large'} tier - the destination tier.
 * @param {string} reason - audit reason.
 * @returns {{ from: string, to: string, reason: string }} the change.
 */
function switchTier(cascade, tier, reason) {
  const from = cascade.tier
  cascade.tier = tier
  cascade.stepsInTier = 0
  cascade.consecutiveFailures = 0
  cascade.consecutivePasses = 0
  return { from, to: tier, reason }
}

/**
 * Move to a named tier, for triage or a user pin. Returns null when the tier already matches.
 * @param {ReturnType<typeof createCascade>} cascade
 * @param {'small' | 'large'} tier
 * @param {string} reason
 * @returns {{ from: string, to: string, reason: string } | null}
 */
export function setTier(cascade, tier, reason) {
  return cascade.tier === tier ? null : switchTier(cascade, tier, reason)
}
