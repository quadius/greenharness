/**
 * Per-request API cost from provider-reported usage.
 *
 * Usage counts are disjoint, as DSH reports them: `inputTokens` is uncached input,
 * `cacheReadTokens` is cached input, `cacheWriteTokens` is cache creation, and `outputTokens`
 * includes reasoning tokens. Rates are USD per million tokens.
 *
 * @param {{ inputTokens?: number, outputTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number } | undefined} usage
 * @param {{ inputPerMTok?: number, cachedInputPerMTok?: number, outputPerMTok?: number } | undefined} price
 * @returns {number} estimated cost in USD; 0 when no price is configured for the route.
 */
export function usageCostUsd(usage, price) {
  if (usage === undefined || price === undefined) return 0
  const perToken = rate => (rate ?? 0) / 1_000_000
  const input = usage.inputTokens ?? 0
  const cacheWrite = usage.cacheWriteTokens ?? 0
  const cacheRead = usage.cacheReadTokens ?? 0
  const output = usage.outputTokens ?? 0
  return input * perToken(price.inputPerMTok)
    + cacheWrite * perToken(price.inputPerMTok)
    + cacheRead * perToken(price.cachedInputPerMTok ?? price.inputPerMTok)
    + output * perToken(price.outputPerMTok)
}
