/**
 * Renders the DSH patch overlay for one benchmark variant. The overlay is JSON, which is valid
 * YAML, so DSH's loader reads it with `--patch`. It mounts the OpenAI-compatible model routes
 * (`@deepseek-ai/dsh-llm-pi-ai`), points the default agent at the small tier, and mounts
 * GreenHarness with the tier map. A baseline variant omits the GreenHarness row, so the same
 * routes serve both arms of the comparison.
 */

/**
 * @typedef {{ id: string, name?: string, contextWindow?: number, reasoningEfforts?: Record<string, string | null> }} RouteModel
 * @typedef {{ baseURL: string, apiKeyEnv?: string, api?: string, compat?: Record<string, unknown>, defaultMaxTokens?: number, displayName?: string, models: RouteModel[] }} RouteSpec
 * @typedef {{ provider: string, model: string, reasoningEffort?: string }} TierSpec
 *
 * @param {object} options
 * @param {Record<string, RouteSpec>} options.routes - model routes keyed by route name.
 * @param {{ small: TierSpec, large: TierSpec }} options.tiers - the cascade's two tiers.
 * @param {boolean} options.greenharness - mount the plugin (false for the baseline arm).
 * @param {string} [options.pluginEntry] - absolute path of the plugin's src/index.mjs (required when greenharness is true).
 * @param {string} [options.ledgerPath] - absolute path of the JSONL ledger for this run.
 * @param {Record<string, unknown>} [options.pluginOptions] - extra GreenHarness config (cascade, distill, ...).
 * @returns {string} the overlay text.
 */
export function renderPatch({ routes, tiers, greenharness, pluginEntry, ledgerPath, pluginOptions = {} }) {
  const rows = [
    // `llm-pi-ai` is already mounted by the base bundle; this row configures that instance.
    // Self-hosted OpenAI-compatible servers ignore the key unless one is configured, but pi-ai
    // requires a key reference on hand-declared routes, so each route names one.
    { id: 'llm-pi-ai', config: { providers: Object.fromEntries(Object.entries(routes).map(([name, route]) => [name, { apiKeyEnv: 'NEMO_API_KEY', ...route }])) } },
    {
      id: 'agent-default-model',
      config: { provider: tiers.small.provider, model: tiers.small.model },
    },
  ]
  if (greenharness) {
    if (!pluginEntry) throw new Error('renderPatch: pluginEntry (absolute path to src/index.mjs) is required when greenharness is true')
    rows.push({
      insert: [{
        id: 'greenharness',
        name: pluginEntry,
        config: {
          tiers: { small: tiers.small, large: tiers.large },
          ledger: { path: ledgerPath ?? '.greenharness/ledger.jsonl', ...(pluginOptions.ledger ?? {}) },
          ...withoutKey(pluginOptions, 'ledger'),
        },
      }],
    })
  }
  return `${JSON.stringify(rows, null, 2)}\n`
}

/**
 * @template T
 * @param {Record<string, T>} object
 * @param {string} key
 */
function withoutKey(object, key) {
  const copy = { ...object }
  delete copy[key]
  return copy
}
