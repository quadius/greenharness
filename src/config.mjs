import { DEFAULT_VERIFIER_PATTERNS, compileVerifierPatterns } from './core/verify.mjs'

/**
 * Validate and complete the plugin configuration. Misconfiguration fails at load: a tier
 * without a provider and model, a non-integer threshold, an out-of-range fraction, or an
 * invalid verifier pattern throws here rather than silently changing routing later.
 *
 * @param {Record<string, any>} raw - the configuration DSH validated against the plugin schema.
 * @returns {{
 *   tiers: { small?: Route, large?: Route },
 *   routing: { enabled: boolean, pinned: '' | 'small' | 'large' },
 *   profile: string,
 *   verbose: boolean,
 *   cascade: { escalateAfterFailures: number, deescalateAfterPasses: number, minStepsPerTier: number },
 *   verifier: { patterns: string[] },
 *   triage: { enabled: boolean, mode: 'heuristic' | 'model', largeAt: number, mixedAt: number, mixedAfterSteps: number, maxChars: number, model: Route },
 *   distill: { enabled: boolean, maxChars: number, contextLines: number },
 *   readDedupe: { enabled: boolean },
 *   loopBreaker: { enabled: boolean, threshold: number },
 *   ledger: { path: string, pricing: Record<string, Price> },
 * }} complete settings with every default applied.
 */
export function normalizeSettings(raw) {
  const tiers = raw?.tiers ?? {}
  const small = isSetRoute(tiers.small) ? normalizeRoute(tiers.small, 'tiers.small') : undefined
  const large = isSetRoute(tiers.large) ? normalizeRoute(tiers.large, 'tiers.large') : undefined

  const pinned = String(raw?.routing?.pinned ?? '')
  if (pinned !== '' && pinned !== 'small' && pinned !== 'large') {
    throw new Error(`greenharness: routing.pinned must be "small", "large" or empty (got "${pinned}")`)
  }

  const triageMode = String(raw?.triage?.mode ?? 'heuristic')
  if (triageMode !== 'heuristic' && triageMode !== 'model') {
    throw new Error(`greenharness: triage.mode must be "heuristic" or "model" (got "${triageMode}")`)
  }
  const largeAt = fraction(raw?.triage?.largeAt ?? 0.6, 'triage.largeAt')
  const mixedAt = fraction(raw?.triage?.mixedAt ?? 0.35, 'triage.mixedAt')
  if (mixedAt >= largeAt) {
    throw new Error(`greenharness: triage.mixedAt (${mixedAt}) must be below triage.largeAt (${largeAt})`)
  }

  const cascade = {
    escalateAfterFailures: integerAtLeast(raw.cascade?.escalateAfterFailures ?? 1, 1, 'cascade.escalateAfterFailures'),
    deescalateAfterPasses: integerAtLeast(raw.cascade?.deescalateAfterPasses ?? 2, 1, 'cascade.deescalateAfterPasses'),
    minStepsPerTier: integerAtLeast(raw.cascade?.minStepsPerTier ?? 2, 0, 'cascade.minStepsPerTier'),
  }

  const patterns = raw.verifier?.patterns?.length ? [...raw.verifier.patterns] : [...DEFAULT_VERIFIER_PATTERNS]
  try {
    compileVerifierPatterns(patterns)
  } catch (error) {
    throw new Error(`greenharness: verifier.patterns has an invalid regular expression: ${String(error)}`)
  }

  return {
    tiers: { small, large },
    routing: { enabled: large !== undefined, pinned },
    profile: String(raw?.profile ?? 'balanced'),
    verbose: raw?.verbose ?? true,
    cascade,
    verifier: { patterns },
    triage: {
      enabled: raw?.triage?.enabled ?? true,
      mode: triageMode,
      largeAt,
      mixedAt,
      mixedAfterSteps: integerAtLeast(raw?.triage?.mixedAfterSteps ?? 2, 1, 'triage.mixedAfterSteps'),
      maxChars: integerAtLeast(raw?.triage?.maxChars ?? 2000, 200, 'triage.maxChars'),
      model: triageMode === 'model'
        ? normalizeRoute(raw?.triage?.model, 'triage.model')
        : { provider: '', model: '', reasoningEffort: '' },
    },
    distill: {
      enabled: raw.distill?.enabled ?? true,
      maxChars: integerAtLeast(raw.distill?.maxChars ?? 12000, 500, 'distill.maxChars'),
      contextLines: integerAtLeast(raw.distill?.contextLines ?? 2, 0, 'distill.contextLines'),
    },
    readDedupe: { enabled: raw.readDedupe?.enabled ?? true },
    loopBreaker: {
      enabled: raw.loopBreaker?.enabled ?? true,
      threshold: integerAtLeast(raw.loopBreaker?.threshold ?? 3, 2, 'loopBreaker.threshold'),
    },
    ledger: {
      path: raw.ledger?.path ?? '.greenharness/ledger.jsonl',
      pricing: raw.ledger?.pricing ?? {},
    },
  }
}

/** @typedef {{ provider: string, model: string, reasoningEffort: string }} Route */
/** @typedef {{ inputPerMTok?: number, cachedInputPerMTok?: number, outputPerMTok?: number }} Price */

function isSetRoute(route) {
  return Boolean(route && (route.provider || route.model))
}

function normalizeRoute(route, label) {
  if (!route || !route.provider || !route.model) {
    throw new Error(`greenharness: ${label} needs both \`provider\` and \`model\``)
  }
  return { provider: String(route.provider), model: String(route.model), reasoningEffort: String(route.reasoningEffort ?? '') }
}

function integerAtLeast(value, min, label) {
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`greenharness: ${label} must be an integer >= ${min} (got ${String(value)})`)
  }
  return value
}

function fraction(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`greenharness: ${label} must be a number between 0 and 1 (got ${String(value)})`)
  }
  return value
}
