/**
 * Helpers for the two DSH hooks that carry per-step routing.
 *
 * DSH keeps the last logged request header and seeds the next model call from it, so a route
 * must be applied on every call, not only where the tier changes. The `agent/request` waterfall
 * is where a plugin replaces the call configuration; `agent/pre-step` is where it can edit the
 * messages admitted to a step.
 */

/**
 * Replace provider, model and reasoning effort in one model-call configuration. Every other
 * control is kept. The inherited effort is always dropped first, so a route without an effort
 * does not keep the previous tier's effort.
 *
 * @param {Record<string, any>} config - the configuration DSH would use (not mutated).
 * @param {{ provider: string, model: string, reasoningEffort?: string }} route - the tier route.
 * @returns {Record<string, any>} a new configuration.
 */
export function applyRoute(config, route) {
  const { reasoningEffort: _inheritedEffort, ...controls } = config
  return {
    ...controls,
    provider: route.provider,
    model: route.model,
    ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
  }
}

/**
 * Drop DSH's model-switch notices. DSH adds one whenever the entry point's default selection
 * differs from the last logged request. Per-step routing makes that differ on purpose, so the
 * notice would repeat on every step and name the wrong model. The routing ledger records each
 * change instead.
 *
 * @template {{ source?: { kind?: string } | undefined }} T
 * @param {ReadonlyArray<T>} messages - the messages admitted to a step.
 * @returns {T[]} the messages without model-switch notices.
 */
export function withoutModelNotices(messages) {
  return messages.filter(message => message?.source?.kind !== 'model-selection')
}
