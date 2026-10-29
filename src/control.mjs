/**
 * The /greenharness slash command: parsing, and the replies it gives. Pure functions over a host
 * object, so they can be tested without DSH.
 *
 * host = { control: { paused: boolean }, settings, runtime, llm? }
 */

const TOGGLES = new Set(['distill', 'dedupe', 'loop', 'routing'])

export const HELP = [
  'GREENHARNESS: HOW TO USE IT',
  '',
  'It starts saving tokens on its own. These commands let you steer it.',
  '',
  'SEE WHAT IT IS DOING',
  '  /greenharness                 summary: tokens saved, last reply, models',
  '  /greenharness last            which model answered the last request',
  '',
  'CHOOSE MODELS',
  '  /greenharness models          list the models you have set up in DSH, numbered',
  '  /greenharness large 3         the strong model, used when work is hard or tests fail',
  '  /greenharness small 1         the cheap model (default: whatever DSH already uses)',
  '  Add API keys first in DSH: Settings > Models.',
  '',
  'CHOOSE HOW MUCH MODEL TO USE',
  '  /greenharness tier auto       automatic: triage plus the test cascade (default)',
  '  /greenharness tier large      every call uses the strong model',
  '  /greenharness tier small      every call uses the cheap model',
  '  /greenharness profile cheap|balanced|quality',
  '                                one command that sets several knobs at once',
  '',
  'TURN THINGS ON OR OFF',
  '  /greenharness on | off        resume or pause everything',
  '  /greenharness routing on|off  switching between the cheap and strong model',
  '  /greenharness distill on|off  shorten very long command output',
  '  /greenharness dedupe on|off   replace a repeated file read with a short pointer',
  '  /greenharness loop on|off     stop a command that keeps failing the same way',
  '  /greenharness verbose on|off  show which model runs next on shortened output',
  '',
  'BENCHMARK & COMPARE',
  '  /greenharness benchmark on <prompt>',
  '                                compare always-large vs greenharness on a prompt',
  '  /greenharness benchmark on build-horse | subtract-fix | loop-stuck',
  '                                run and compare standard benchmark scenarios',
  '',
  'Settings last until DSH restarts.',
].join('\n')

const EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

const PROFILES = {
  cheap: {
    label: 'cheap',
    pinned: 'small',
    note: 'Every call uses the cheap model. Triage and switching are off. Best for tiny edits and CI.',
    distill: { maxChars: 4000 },
    triage: { enabled: false },
  },
  balanced: {
    label: 'balanced',
    pinned: '',
    note: 'Hard requests and failing tests use the strong model; everything else stays cheap.',
    distill: { maxChars: 12000 },
    triage: { enabled: true, mode: 'heuristic', largeAt: 0.6, mixedAt: 0.35 },
  },
  quality: {
    label: 'quality',
    pinned: 'large',
    note: 'Every call uses the strong model and output is shortened less. The most expensive profile.',
    distill: { maxChars: 12000 },
    triage: { enabled: true, mode: 'heuristic', largeAt: 0.45, mixedAt: 0.25 },
  },
}

/**
 * @param {string} rawInput
 * @returns {{ action: 'status' | 'help' | 'models' | 'last' }
 *   | { action: 'pause', paused: boolean }
 *   | { action: 'toggle', mechanism: string, enabled: boolean }
 *   | { action: 'verbose', enabled: boolean }
 *   | { action: 'tier', tier: '' | 'small' | 'large' }
 *   | { action: 'profile', name: string }
 *   | { action: 'model', tier: 'small' | 'large', args: string[] }
 *   | { action: 'error', message: string }}
 */
export function parseCommand(rawInput = '') {
  const [first = 'status', ...args] = String(rawInput).trim().split(/\s+/).filter(Boolean)
  const verb = first.toLowerCase()
  if (verb === 'status' || verb === 'help' || verb === 'models' || verb === 'last') {
    return args.length === 0 ? { action: verb } : usage(`/greenharness ${verb}`)
  }
  if (verb === 'on' || verb === 'off') {
    return args.length === 0 ? { action: 'pause', paused: verb === 'off' } : usage(`/greenharness ${verb}`)
  }
  if (TOGGLES.has(verb)) {
    const value = (args[0] ?? '').toLowerCase()
    if (args.length !== 1 || (value !== 'on' && value !== 'off')) return usage(`/greenharness ${verb} on|off`)
    return { action: 'toggle', mechanism: verb, enabled: value === 'on' }
  }
  if (verb === 'verbose') {
    const value = (args[0] ?? '').toLowerCase()
    if (args.length !== 1 || (value !== 'on' && value !== 'off')) return usage('/greenharness verbose on|off')
    return { action: 'verbose', enabled: value === 'on' }
  }
  if (verb === 'tier') {
    const value = (args[0] ?? '').toLowerCase()
    if (args.length !== 1 || !['small', 'large', 'auto'].includes(value)) return usage('/greenharness tier small|large|auto')
    return { action: 'tier', tier: value === 'auto' ? '' : value }
  }
  if (verb === 'profile') {
    if (args.length > 1) return usage('/greenharness profile [cheap|balanced|quality]')
    return { action: 'profile', name: (args[0] ?? '').toLowerCase() }
  }
  if (verb === 'large' || verb === 'small') return { action: 'model', tier: verb, args }
  if (verb === 'benchmark' || verb === 'bench') {
    const rawRest = String(rawInput).trim().slice(first.length).trim()
    const prompt = rawRest.replace(/^on(?:\s+|$)/i, '').trim()
    if (!prompt) {
      return usage('/greenharness benchmark on <prompt or scenario>\n  Example: /greenharness benchmark on build-horse\n  Example: /greenharness benchmark on Generate a 3D model of a horse')
    }
    return { action: 'benchmark', prompt }
  }
  return { action: 'error', message: `Unknown command "${first}". Try /greenharness help.` }
}

/**
 * Run one command and return the reply DSH shows.
 * @param {string} rawInput
 * @param {{ control: { paused: boolean }, settings: any, runtime: any, llm?: any }} host
 * @returns {Promise<{ kind: 'success' | 'error', text: string }>}
 */
export async function runCommand(rawInput, host) {
  const command = parseCommand(rawInput)
  switch (command.action) {
    case 'error': return fail(command.message)
    case 'help': return ok(HELP)
    case 'status': return ok(statusText(host))
    case 'last': return showLast(host)
    case 'pause':
      host.control.paused = command.paused
      return ok(command.paused ? 'GreenHarness paused. Tool output and model routing are left alone.' : 'GreenHarness resumed.')
    case 'toggle': return toggle(command, host)
    case 'verbose':
      host.settings.verbose = command.enabled
      return ok(`Model labels on shortened output ${onOff(command.enabled)}.`)
    case 'tier': return applyTierPin(command.tier, host)
    case 'profile': return applyProfile(command.name, host)
    case 'models': return showModels(host)
    case 'model': return setModel(command, host)
    case 'benchmark': return runBenchmark(command.prompt, host)
    default: return fail('Unknown command. Try /greenharness help.')
  }
}

async function runBenchmark(prompt, host) {
  try {
    const runner = host?.benchmarkRunner ?? (await import('../bench/compare.mjs')).runBenchmarkComparison
    const result = await runner(prompt)
    return ok(typeof result === 'string' ? result : (result?.report ?? JSON.stringify(result, null, 2)))
  } catch (error) {
    return fail(`Benchmark failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * The status reply: switches, models, the last reply and what this process has done so far.
 * @param {{ control: { paused: boolean }, settings: any, runtime: any }} host
 */
export function statusText({ control, settings, runtime }) {
  const stats = runtime.stats()
  const count = key => stats[key] ?? 0
  const describe = route => (route ? `${route.provider}/${route.model}` : 'not set')
  const small_ = settings.tiers.small
    ? describe(settings.tiers.small)
    : 'the model DSH uses (recorded at the first routed call)'
  const savedTokens = Math.round(count('charsSaved') / 4)
  const smallTok = count('smallTokens')
  const largeTok = count('largeTokens')
  const spent = smallTok + largeTok
  const cheapShare = spent === 0 ? 0 : smallTok / spent
  const pinned = settings.routing.pinned
  const headline = control.paused
    ? 'GreenHarness is PAUSED'
    : pinned ? `GreenHarness is ON · every call uses the ${pinned} model` : 'GreenHarness is ON'
  const routingMode = pinned ? `pinned to ${pinned}` : settings.routing.enabled ? 'automatic' : 'off'

  const lines = [
    headline,
    `Profile: ${settings.profile} · Routing ${routingMode} · Triage ${settings.triage.enabled ? settings.triage.mode : 'off'}`,
    '',
    `Tokens saved so far: about ${savedTokens.toLocaleString('en-US')}`,
    `  (long outputs shortened: ${count('tool:distill')}, repeated reads replaced: ${count('tool:dedupe')}, loops stopped: ${count('loop-break')})`,
    `ALL PROMPTS SINCE DSH STARTED: cheap model did ${bar(cheapShare)} ${Math.round(cheapShare * 100)}%`,
    `  ${count('request')} model calls, ${count('route')} switches between models. For just the latest prompt: /greenharness last`,
  ]
  const turn = runtime.lastTurn?.()
  if (turn !== undefined) {
    const served = Object.entries(turn.models).map(([model, n]) => `${model} ×${n}`).join(', ')
    lines.push(`LATEST PROMPT ONLY: cheap model did ${bar(turnShare(turn))} ${Math.round(turnShare(turn) * 100)}%`)
    lines.push(`  ${served || 'no calls logged'} · ${turn.tokens.toLocaleString('en-US')} tokens`)
    if (turn.verdict !== undefined) {
      const score = turn.score === null || turn.score === undefined ? '' : ` (${turn.score})`
      lines.push(`Triage for that request: ${turn.verdict}${score} · ${turn.plan.join(' → ')}`)
    }
  }
  const mismatch = runtime.lastMismatch?.()
  if (mismatch !== undefined) {
    lines.push(`WARNING: the latest call was meant to use ${mismatch.intended} but DSH used ${mismatch.actual}. GreenHarness's choice is not being applied.`)
  }
  if (count('errors') > 0) lines.push(`WARNING: ${count('errors')} plugin error(s). Latest: ${runtime.lastError?.() ?? 'unknown'}`)
  if (count('costUsd') > 0) lines.push(`Cost so far: $${count('costUsd').toFixed(4)}`)
  lines.push(
    '',
    `Models: small = ${small_}, large = ${describe(settings.tiers.large)}.`,
    `Features: shorten output ${onOff(settings.distill.enabled)}, repeated reads ${onOff(settings.readDedupe.enabled)}, loop stop ${onOff(settings.loopBreaker.enabled)}, route labels ${onOff(settings.verbose)}.`,
    ...(settings.tiers.large ? [] : ['Next step: type /greenharness models, then /greenharness large <number> to add a strong model.']),
    'All commands: /greenharness help',
  )
  return lines.join('\n')
}

/** Share of one prompt's tokens that the cheap model handled, 0..1. */
function turnShare(turn) {
  const small = turn.tierTokens?.small ?? 0
  const total = small + (turn.tierTokens?.large ?? 0)
  return total === 0 ? 0 : small / total
}

/** A 20-cell text progress bar. @param {number} fraction 0..1 */
export function bar(fraction) {
  const filled = Math.max(0, Math.min(20, Math.round(fraction * 20)))
  return '[' + '█'.repeat(filled) + '░'.repeat(20 - filled) + ']'
}

/** @param {{ mechanism: string, enabled: boolean }} command @param {{ settings: any }} host */
function toggle({ mechanism, enabled }, { settings }) {
  if (mechanism === 'routing') {
    if (enabled && settings.tiers.large === undefined) {
      return fail('Routing needs a large model first: /greenharness large <provider> <model>')
    }
    settings.routing.enabled = enabled
    return ok(`Routing ${onOff(enabled)}.`)
  }
  const owner = { distill: settings.distill, dedupe: settings.readDedupe, loop: settings.loopBreaker }[mechanism]
  owner.enabled = enabled
  return ok(`${mechanism === 'loop' ? 'Loop breaker' : mechanism[0].toUpperCase() + mechanism.slice(1)} ${onOff(enabled)}.`)
}

/** @param {'' | 'small' | 'large'} tier @param {{ settings: any, runtime: any }} host */
function applyTierPin(tier, { settings, runtime }) {
  if (tier === 'large' && settings.tiers.large === undefined) {
    return fail('Pick a large model first: /greenharness models, then /greenharness large <number>.')
  }
  settings.routing.pinned = tier
  settings.profile = 'custom'
  runtime.notePin?.(tier)
  return ok(tier === ''
    ? 'Routing is automatic again: the small model runs, and a hard request or a failing test moves it to the large one.'
    : `Every model call now uses the ${tier} model. Type /greenharness tier auto to go back to automatic routing.`)
}

/** @param {string} name @param {{ settings: any, runtime: any }} host */
function applyProfile(name, { settings, runtime }) {
  if (name === '') {
    return ok([
      'PROFILES',
      ...Object.values(PROFILES).map(p => `  ${p.label.padEnd(9)} ${p.note}`),
      '',
      'Apply one: /greenharness profile cheap',
    ].join('\n'))
  }
  const profile = PROFILES[name]
  if (profile === undefined) return fail(`Unknown profile "${name}". Try: cheap, balanced, quality.`)
  if (profile.pinned === 'large' && settings.tiers.large === undefined) {
    return fail('The quality profile needs a large model first: /greenharness models, then /greenharness large <number>.')
  }
  settings.routing.pinned = profile.pinned
  Object.assign(settings.distill, profile.distill)
  Object.assign(settings.triage, profile.triage)
  settings.profile = profile.label
  runtime.notePin?.(profile.pinned)
  return ok(`Profile: ${profile.label}.\n${profile.note}\nTune it further with /greenharness help.`)
}

/** @param {{ runtime: any }} host */
function showLast({ runtime }) {
  const turn = runtime.lastTurn?.()
  if (turn === undefined) return ok('No model calls yet. Send a prompt, then run /greenharness last.')
  const models = Object.entries(turn.models).map(([model, n]) => `${model} ×${n}`).join(', ')
  const score = turn.score === null || turn.score === undefined ? '' : ` (${turn.score})`
  return ok([
    'LAST REPLY',
    `  cheap model: ${bar(turnShare(turn))} ${Math.round(turnShare(turn) * 100)}% of this prompt's tokens`,
    `  last call: ${turn.tier ?? 'unknown'} model`,
    `  models:    ${models || 'none logged'}`,
    `  calls:     ${turn.calls}`,
    `  tokens:    ${turn.tokens.toLocaleString('en-US')}`,
    ...(turn.verdict === undefined ? [] : [`  triage:    ${turn.verdict}${score} · ${turn.plan.join(' → ')}`]),
    '',
    'Tip: /greenharness tier large|small|auto changes which model runs.',
  ].join('\n'))
}

const norm = text => String(text).toLowerCase().replace(/[^a-z0-9]/g, '')

async function loadListing(host) {
  const entries = []
  if (host.llm === undefined) return entries
  for (const provider of host.llm.listProviders()) {
    let models = []
    try { models = await host.llm.listModels(provider.id) } catch { continue }
    for (const model of models) {
      entries.push({ n: entries.length + 1, provider: provider.id, providerName: provider.name, id: model.id, name: model.name })
    }
  }
  host.listing = entries
  return entries
}

const row = e => `  ${String(e.n).padStart(2)}. ${e.name}   (${e.providerName}, id ${e.id})`

async function showModels(host) {
  const entries = await loadListing(host)
  if (entries.length === 0) {
    return ok([
      'DSH has no models to list yet.',
      'Add your API key and models first: open Settings > Models in DSH, then run /greenharness models again.',
    ].join('\n'))
  }
  return ok([
    'MODELS YOU CAN CHOOSE FROM',
    ...entries.map(row),
    '',
    'Pick the strong one:   /greenharness large <number>      e.g. /greenharness large 3',
    'Pick the cheap one:    /greenharness small <number>',
  ].join('\n'))
}

async function resolveModel(args, host) {
  let effort = ''
  if (args.length > 1 && EFFORTS.has(args[args.length - 1].toLowerCase())) effort = args[args.length - 1].toLowerCase()
  const words = effort === '' ? args : args.slice(0, -1)
  if (words.length === 0) return { error: 'Which model? Run /greenharness models to see the list, then use its number.' }
  const entries = host.listing?.length ? host.listing : await loadListing(host)
  const pick = e => ({ route: { provider: e.provider, model: e.id, reasoningEffort: effort }, label: `${e.name} (${e.providerName})` })
  if (words.length === 1 && /^\d+$/.test(words[0])) {
    const hit = entries.find(e => e.n === Number(words[0]))
    return hit ? pick(hit) : { error: `There is no model number ${words[0]}. Run /greenharness models to see the list.` }
  }
  if (host.llm === undefined) {
    if (words.length < 2) return { error: 'Use: /greenharness large <provider> <model>' }
    return { route: { provider: words[0], model: words.slice(1).join(' '), reasoningEffort: effort }, label: `${words[0]}/${words.slice(1).join(' ')}` }
  }
  const providers = host.llm.listProviders()
  const owner = providers.find(p => norm(p.id) === norm(words[0]) || norm(p.name) === norm(words[0]))
  const rest = owner ? words.slice(1) : words
  const pool = owner ? entries.filter(e => e.provider === owner.id) : entries
  const query = norm(rest.join(''))
  if (query === '') return { error: `Which model from ${owner.name}? Run /greenharness models to see the list.` }
  const exact = pool.filter(e => norm(e.id) === query || norm(e.name) === query)
  const near = exact.length > 0 ? exact : pool.filter(e => norm(e.id).includes(query) || norm(e.name).includes(query))
  if (near.length === 1) return pick(near[0])
  if (near.length > 1) return { error: ['That matches several models. Pick one by number:', ...near.map(row)].join('\n') }
  if (owner && rest.length === 1) {
    return { route: { provider: owner.id, model: rest[0], reasoningEffort: effort }, label: `${rest[0]} (${owner.name}, typed id)` }
  }
  return { error: `I could not find a model matching "${rest.join(' ')}". Run /greenharness models to see what DSH has. Add keys and models in Settings > Models.` }
}

/** @param {{ tier: 'small' | 'large', args: string[] }} command */
async function setModel({ tier, args }, host) {
  if (args.length === 0) return showModels(host)
  const found = await resolveModel(args, host)
  if ('error' in found) return fail(found.error)
  host.settings.tiers[tier] = found.route
  if (tier === 'large') {
    host.settings.routing.enabled = true
    return ok(`Strong model set to ${found.label}.\nSwitching is ON: GreenHarness will use it when the request is hard or the cheap model keeps failing tests, then go back.\nType /greenharness to watch it work.`)
  }
  return ok(`Cheap model set to ${found.label}.`)
}

function usage(message) { return { action: 'error', message: `Usage: ${message}` } }
function onOff(value) { return value ? 'on' : 'off' }
function ok(text) { return { kind: 'success', text } }
function fail(text) { return { kind: 'error', text } }
