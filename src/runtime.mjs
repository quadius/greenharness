import { createHash } from 'node:crypto'
import { usageCostUsd } from './core/pricing.mjs'
import { distillOutput } from './core/distill.mjs'
import { createCascade, escalate, recordStep, recordVerification, setTier } from './core/cascade.mjs'
import { createLoopGuard, isProgressTool, noteWorkspaceChange, recordCommandOutcome, streakOf } from './core/loop-guard.mjs'
import {
  clearSession, createReadIndex, findUnchangedRead, forgetPath, markReadPointed, rememberRead,
} from './core/read-index.mjs'
import { classifyRequest, latestUserMessage, planFor } from './core/triage.mjs'
import {
  classifyOutcome, compileVerifierPatterns, isMutatingCommand, isVerifierCommand, normalizeCommand, parseExitMarker,
} from './core/verify.mjs'
import { stripModelNotices } from './core/route.mjs'

/** Session events that mean earlier tool results are no longer in the model's context. */
const CONTEXT_REMOVAL_EVENTS = new Set([
  'compaction/start', 'compaction/end', 'compaction/prune', 'compaction/summary',
  'compaction/checkpoint', 'compaction/tool-pairing',
])

/**
 * @typedef {object} ToolCall
 * @property {string} sessionId
 * @property {string} name
 * @property {Record<string, any>} args
 * @property {string} [callId]
 * @property {boolean} [isError]
 * @property {number} [exitCode]
 * @property {boolean} [timedOut]
 * @property {string} [text]
 * @property {(text: string) => Promise<string | undefined>} [spill]
 * @property {(text: string) => Promise<string | undefined>} [saveFile]
 */

/**
 * Build the GreenHarness runtime: triage, routing, distillation, read dedupe, loop breaking and
 * the cost ledger. The Cordis adapter asks it for the route of each model call, hands it the
 * messages entering a step and the tool calls as they settle, passes it session events, and shows
 * the user `/greenharness` replies.
 *
 * @param {ReturnType<import('./config.mjs').normalizeSettings>} settings - complete settings.
 * @param {{
 *   ledger: { write(record: object): void },
 *   logger?: { warn(message: string): void },
 *   classifier?: (text: string) => Promise<{ verdict: string, score?: number | null, signals?: string[], plan?: string[] } | undefined>,
 * }} deps
 */
export function createGreenHarness(settings, { ledger, logger, classifier } = {}) {
  const verifierRegexes = compileVerifierPatterns(settings.verifier.patterns)
  const sessions = new Map()
  const reads = createReadIndex()
  const tally = {}
  /** The turn that ran most recently, so `/greenharness last` works without a session id. */
  let latestTurn
  let lastMismatch
  let lastError

  const log = {
    write(record) {
      const key = record.type === 'tool' ? `tool:${record.action}` : record.type
      tally[key] = (tally[key] ?? 0) + 1
      if (record.type === 'tool' && record.rawChars > record.outChars) {
        tally.charsSaved = (tally.charsSaved ?? 0) + (record.rawChars - record.outChars)
      }
      if (record.type === 'request') {
        const u = record.usage ?? {}
        const tier = record.tier === 'large' ? 'large' : 'small'
        tally[`${tier}Tokens`] = (tally[`${tier}Tokens`] ?? 0) + (u.inputTokens ?? 0) + (u.outputTokens ?? 0)
        tally.costUsd = (tally.costUsd ?? 0) + (record.costUsd ?? 0)
      }
      ledger.write(record)
    },
  }

  /** @param {string} sessionId */
  function stateOf(sessionId) {
    let state = sessions.get(sessionId)
    if (state === undefined) {
      state = {
        cascade: createCascade(settings.cascade),
        loop: createLoopGuard(),
        route: undefined,
        triagedDigest: '',
        pendingEscalation: null,
        turn: undefined,
        /** The route this plugin last asked for, so its own notices can be told apart. */
        applied: undefined,
        /** model and provider/model to the tier that produced it, for honest labels. */
        tierLabels: new Map(),
      }
      sessions.set(sessionId, state)
    }
    return state
  }

  /** @param {'small' | 'large'} tier */
  function tierRoute(tier) {
    const route = settings.tiers[tier]
    if (route === undefined) return undefined
    return route.reasoningEffort === ''
      ? { provider: route.provider, model: route.model }
      : { provider: route.provider, model: route.model, reasoningEffort: route.reasoningEffort }
  }

  /**
   * Remember which tier produced one model id, so a call is labelled by what was chosen for it
   * rather than by whatever the large tier happens to be configured as now.
   * @param {ReturnType<typeof stateOf>} state
   * @param {'small' | 'large'} tier
   * @param {{ provider?: string, model?: string } | undefined} route
   */
  function labelTier(state, tier, route) {
    if (route?.model === undefined) return
    const labels = [[String(route.model), tier]]
    if (route.provider) labels.push([`${route.provider}/${route.model}`, tier])
    for (const [label, value] of labels) {
      if (state.tierLabels.get(label) === 'large' && value === 'small') continue
      state.tierLabels.set(label, value)
    }
  }

  /**
   * The tier one actual route belongs to.
   * @param {ReturnType<typeof stateOf>} state
   * @param {{ provider?: string, model?: string } | undefined} route
   * @returns {'small' | 'large'}
   */
  function tierOfRoute(state, route) {
    const large = settings.tiers.large
    const key = `${route?.provider ?? ''}/${route?.model ?? ''}`
    const known = state.tierLabels.get(key) ?? state.tierLabels.get(String(route?.model ?? ''))
    if (known !== undefined) return known
    if (large === undefined) return 'small'
    return route?.provider === large.provider && route?.model === large.model ? 'large' : 'small'
  }

  function applyChange(call, change, extra = {}) {
    if (change === null) return
    log.write({
      type: 'route', session: call.sessionId, from: change.from, to: change.to,
      reason: change.reason, selection: tierRoute(change.to), ...extra,
    })
  }

  /**
   * Run the request classifier. The injected classifier wins; if it returns undefined or
   * throws, the built-in heuristic answers instead, so triage never blocks a run.
   * @param {string} text
   * @param {string} sessionId
   */
  async function classify(text, sessionId) {
    if (classifier !== undefined) {
      try {
        const result = await classifier(text, sessionId)
        if (result !== undefined) return result
      } catch (error) {
        logger?.warn?.(`greenharness: triage classifier failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return classifyRequest(text, settings.triage)
  }

  /**
   * Look at the conversation at the start of a step. A new user message begins a turn: triage it
   * once, record the verdict, and seed the cascade.
   * @param {string} sessionId
   * @param {ReadonlyArray<{ role?: string, content?: unknown, source?: { kind?: string } }>} messages
   */
  async function observeMessages(sessionId, messages) {
    const state = stateOf(sessionId)
    const text = latestUserMessage(messages)
    if (text === undefined) return
    const digest = createHash('sha1').update(text).digest('hex')
    if (digest === state.triagedDigest) return

    state.triagedDigest = digest
    state.pendingEscalation = null
    const turn = {
      session: sessionId, digest, calls: 0, models: {}, tokens: 0, tierTokens: { small: 0, large: 0 },
      tier: state.cascade.tier, verdict: undefined, score: undefined, plan: [],
    }
    state.turn = turn
    latestTurn = turn

    if (!settings.triage.enabled) return
    const result = await classify(text, sessionId)
    if (result === undefined) return

    turn.verdict = result.verdict
    turn.score = result.score ?? null
    turn.plan = result.plan ?? planFor(result.verdict)
    log.write({
      type: 'triage', session: sessionId, verdict: result.verdict, score: result.score ?? null,
      signals: result.signals ?? [], plan: turn.plan, mode: settings.triage.mode, chars: text.length,
    })

    if (!settings.routing.enabled || settings.routing.pinned !== '') return
    // Every new prompt starts on the small tier unless triage says large; otherwise one large
    // turn would keep every later easy prompt on the large model until two tests pass.
    if (result.verdict !== 'large' && state.cascade.tier === 'large') {
      const back = setTier(state.cascade, 'small', 'triage-reset')
      if (back !== null) {
        log.write({ type: 'route', session: sessionId, ...back, selection: tierRoute('small') })
        labelTier(state, 'small', tierRoute('small'))
      }
    }
    if (result.verdict === 'large') {
      const change = setTier(state.cascade, 'large', 'triage-large')
      if (change !== null) {
        log.write({ type: 'route', session: sessionId, ...change, selection: tierRoute('large') })
      }
    } else if (result.verdict === 'mixed') {
      state.pendingEscalation = { afterSteps: settings.triage.mixedAfterSteps, reason: 'triage-mixed' }
    }
  }

  /**
   * Whether one model id in a switch notice is one of the configured tiers. Used to recognise a
   * notice this plugin provoked when the previous route is not known.
   * @param {string} label - a bare model id or `provider/model`.
   */
  function isTierModel(label) {
    for (const tier of ['small', 'large']) {
      const route = settings.tiers[tier]
      if (route === undefined) continue
      if (label === route.model || label === `${route.provider}/${route.model}`) return true
    }
    return false
  }

  /**
   * The messages admitted to a step, minus the switch notices this plugin caused. Telemetry is
   * written only when a notice is seen, so a silent run stays silent.
   * @param {string} sessionId
   * @param {ReadonlyArray<any>} messages - messages proposed for the step.
   * @returns {Promise<any[]>} the messages to admit.
   */
  async function preStep(sessionId, messages) {
    const state = stateOf(sessionId)
    let admitted = messages
    if (settings.routing.enabled && settings.tiers.large !== undefined) {
      const filtered = stripModelNotices(messages, {
        policy: settings.routing.stripNotices,
        applied: state.applied,
        isTierModel,
      })
      admitted = filtered.messages
      if (filtered.stripped > 0) {
        log.write({ type: 'notice-stripped', session: sessionId, count: filtered.stripped })
      }
      if (filtered.kept > 0) {
        log.write({ type: 'notice-kept', session: sessionId, count: filtered.kept, reason: 'not-caused-by-routing' })
      }
    }
    await observeMessages(sessionId, admitted)
    return admitted
  }

  /**
   * The route of the next model call. A user pin wins; otherwise a pending triage escalation
   * fires once the small tier has had its steps; otherwise the cascade decides.
   * @param {string} sessionId
   * @param {{ provider?: string, model?: string, reasoningEffort?: string }} [proposed]
   */
  function routeForNextCall(sessionId, proposed) {
    if (!settings.routing.enabled || settings.tiers.large === undefined) {
      const idle = stateOf(sessionId)
      idle.applied = undefined
      return undefined
    }
    if (settings.tiers.small === undefined && proposed?.provider && proposed?.model) {
      settings.tiers.small = { provider: proposed.provider, model: proposed.model, reasoningEffort: proposed.reasoningEffort ?? '' }
    }
    const state = stateOf(sessionId)
    const pinned = settings.routing.pinned

    if (pinned === 'small' || pinned === 'large') {
      setTier(state.cascade, pinned, 'pinned')
      state.pendingEscalation = null
      recordStep(state.cascade)
      state.intended = tierRoute(pinned)
      state.applied = state.intended
      labelTier(state, pinned, state.intended)
      return state.intended
    }
    if (settings.tiers.small === undefined) {
      state.applied = undefined
      return undefined
    }

    const pending = state.pendingEscalation
    if (pending !== null && state.cascade.tier === 'small' && state.cascade.stepsInTier >= pending.afterSteps) {
      const change = setTier(state.cascade, 'large', pending.reason)
      state.pendingEscalation = null
      if (change !== null) log.write({ type: 'route', session: sessionId, ...change, selection: tierRoute('large') })
    }
    recordStep(state.cascade)
    state.intended = tierRoute(state.cascade.tier)
    state.applied = state.intended
    labelTier(state, state.cascade.tier, state.intended)
    return state.intended
  }

  /**
   * Pin every live session to one tier, or release them. `/greenharness tier` calls this.
   * @param {'' | 'small' | 'large'} tier
   */
  function notePin(tier) {
    settings.routing.pinned = tier
    for (const state of sessions.values()) {
      state.pendingEscalation = null
      // Releasing a pin (tier auto) starts every session back on the small tier.
      setTier(state.cascade, tier === 'large' ? 'large' : 'small', tier === '' ? 'unpinned' : 'pinned')
      state.applied = undefined
    }
  }

  /** @param {ToolCall} call */
  function beforeTool(call) {
    if (!settings.loopBreaker.enabled || call.name !== 'bash') return undefined
    const command = normalizeCommand(call.args?.command)
    const state = stateOf(call.sessionId)
    const count = streakOf(state.loop, command)
    if (count < settings.loopBreaker.threshold) return undefined
    applyChange(call, escalate(state.cascade, 'loop-breaker'))
    log.write({ type: 'loop-break', session: call.sessionId, command: truncate(command), count })
    return {
      kind: 'deny',
      reason: `GreenHarness loop guard: \`${command}\` has failed ${count} times in a row with the same failure and no file change since. Do not run it again unchanged. Read the failure, change the code or the command, then rerun. The next step uses the ${state.cascade.tier} model.`,
    }
  }

  /**
   * Replace one long tool result with a shorter, still-informative one. Nothing is lost: the full
   * text is spilled (or written to a file) and the replacement points at it.
   * @param {ToolCall} call
   * @param {ReturnType<typeof stateOf>} state
   * @returns {Promise<string | undefined>} the replacement text, when one is worth using.
   */
  async function distillReplacement(call, state) {
    if (!settings.distill.enabled) return undefined
    if (!settings.distill.tools.includes(call.name)) return undefined
    const text = call.text ?? ''
    if (text.length === 0) return undefined
    const distilled = distillOutput(text, {
      maxChars: settings.distill.maxChars,
      contextLines: settings.distill.contextLines,
      requireNoise: settings.distill.requireNoise,
    })
    if (!distilled.changed) return undefined
    const hint = call.spill ? await call.spill(text).catch(() => undefined) : undefined
    const file = call.saveFile ? await call.saveFile(text).catch(() => undefined) : undefined
    const nextTier = settings.verbose ? state.cascade.tier : undefined
    const candidate = composeDistilled(distilled, hint, nextTier, file)
    return candidate.length < text.length ? candidate : undefined
  }

  async function afterBash(call, state) {
    const command = normalizeCommand(call.args?.command)
    if (call.isError === true && call.exitCode === undefined && call.timedOut !== true) {
      log.write({
        type: 'tool', session: call.sessionId, tool: 'bash', action: 'not-run', command: truncate(command),
        rawChars: (call.text ?? '').length, outChars: (call.text ?? '').length,
      })
      return undefined
    }
    const exitCode = call.exitCode ?? parseExitMarker(call.text ?? '') ?? (call.isError ? 1 : 0)
    const outcome = classifyOutcome({ exitCode, timedOut: call.timedOut === true, text: call.text ?? '' })
    const repeats = recordCommandOutcome(state.loop, command, outcome)
    // A writer may have fixed the failure: clear every streak, not only this command's.
    if (outcome.passed && isMutatingCommand(command)) noteWorkspaceChange(state.loop)
    const verifier = isVerifierCommand(command, verifierRegexes)
    if (verifier) applyChange(call, recordVerification(state.cascade, outcome.passed), { command: truncate(command) })

    const replacement = await distillReplacement(call, state)
    log.write({
      type: 'tool', session: call.sessionId, tool: 'bash', action: replacement === undefined ? 'none' : 'distill',
      verifier, passed: outcome.passed, exitCode, fingerprint: outcome.fingerprint, repeats,
      command: truncate(command), rawChars: (call.text ?? '').length, outChars: replacement?.length ?? (call.text ?? '').length,
    })
    return replacement === undefined ? undefined : { text: replacement }
  }

  /**
   * Replace a byte-identical re-read with a pointer, but only once in a row: the next identical
   * read is served in full again, so the content can never become unreachable.
   * @param {ToolCall} call
   * @returns {{ text: string } | undefined}
   */
  function afterRead(call) {
    if (!settings.readDedupe.enabled || call.isError) return undefined
    const path = call.args?.file_path
    if (typeof path !== 'string') return undefined
    const text = call.text ?? ''
    const read = {
      path,
      offset: numberOrNull(call.args?.offset),
      limit: numberOrNull(call.args?.limit),
      digest: createHash('sha1').update(text).digest('hex'),
    }
    const earlier = findUnchangedRead(reads, call.sessionId, read)
    if (earlier !== undefined && settings.readDedupe.escapeHatch && earlier.pointed) {
      // The model asked again after being shown a pointer: give it the real content.
      rememberRead(reads, call.sessionId, { ...read, callId: call.callId ?? '' })
      log.write({
        type: 'tool', session: call.sessionId, tool: 'read', action: 'dedupe-refresh', path,
        rawChars: text.length, outChars: text.length,
      })
      return undefined
    }
    if (earlier !== undefined) {
      markReadPointed(reads, call.sessionId, read)
      const replacement = `[greenharness: this read returns the same lines as the earlier read of ${path} (call ${earlier.callId}), which is still in context. Omitted to save tokens. Reuse that result, or read the same range again to get the text.]`
      log.write({ type: 'tool', session: call.sessionId, tool: 'read', action: 'dedupe', path, rawChars: text.length, outChars: replacement.length })
      return { text: replacement }
    }
    rememberRead(reads, call.sessionId, { ...read, callId: call.callId ?? '' })
    log.write({ type: 'tool', session: call.sessionId, tool: 'read', action: 'none', path, rawChars: text.length, outChars: text.length })
    return undefined
  }

  /** @param {ToolCall} call */
  async function afterTool(call) {
    const state = stateOf(call.sessionId)
    if (call.name === 'bash') return afterBash(call, state)
    if (call.name === 'read') return afterRead(call)

    if (isProgressTool(call.name, settings.loopBreaker.progressTools) && call.isError !== true) {
      if (typeof call.args?.file_path === 'string') forgetPath(reads, call.sessionId, call.args.file_path)
      noteWorkspaceChange(state.loop)
    }

    const replacement = await distillReplacement(call, state)
    if (replacement === undefined) {
      if (settings.distill.tools.includes(call.name)) {
        log.write({
          type: 'tool', session: call.sessionId, tool: call.name, action: 'none',
          rawChars: (call.text ?? '').length, outChars: (call.text ?? '').length,
        })
      }
      return undefined
    }
    log.write({
      type: 'tool', session: call.sessionId, tool: call.name, action: 'distill',
      rawChars: (call.text ?? '').length, outChars: replacement.length,
    })
    return { text: replacement }
  }

  /**
   * Session event observer: writes one ledger record per model call, with the route that call
   * actually used, and clears the read index when the context shrinks.
   * @param {string} sessionId
   * @param {{ type: string, data?: any }} event
   */
  function observeEvent(sessionId, event) {
    const state = stateOf(sessionId)
    if (event.type === 'request/header') {
      const config = event.data?.header?.config
      if (config !== undefined) state.route = { provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort }
      return
    }
    if (event.type === 'assistant/message') {
      const usage = event.data?.usage
      if (usage === undefined) return
      const route = state.route ?? tierRoute(state.cascade.tier) ?? { provider: '', model: '' }
      const tier = tierOfRoute(state, route)
      const wanted = state.intended
      state.intended = undefined
      if (wanted !== undefined && (wanted.provider !== route.provider || wanted.model !== route.model)) {
        log.write({ type: 'route-mismatch', session: sessionId, intended: wanted, actual: { provider: route.provider, model: route.model } })
        lastMismatch = { intended: `${wanted.provider}/${wanted.model}`, actual: `${route.provider}/${route.model}` }
      } else if (wanted !== undefined) {
        lastMismatch = undefined
      }
      log.write({
        type: 'request', session: sessionId, turn: event.data.turn, step: event.data.step,
        tier, provider: route.provider, model: route.model,
        reasoningEffort: route.reasoningEffort ?? null, usage,
        costUsd: usageCostUsd(usage, settings.ledger.pricing[route.provider]),
      })
      if (state.turn !== undefined) {
        state.turn.calls += 1
        state.turn.tier = tier
        const key = `${route.provider}/${route.model}`
        state.turn.models[key] = (state.turn.models[key] ?? 0) + 1
        const used = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
        state.turn.tokens += used
        state.turn.tierTokens[tier] += used
      }
      return
    }
    if (CONTEXT_REMOVAL_EVENTS.has(event.type)) clearSession(reads, sessionId)
  }

  /**
   * Drop everything remembered about one session. DSH disposes an agent when its session is
   * closed or archived; without this the process would keep a cascade, a loop guard and a read
   * index alive for every session it has ever seen.
   * @param {string} sessionId
   */
  function forgetSession(sessionId) {
    sessions.delete(sessionId)
    clearSession(reads, sessionId)
    if (latestTurn?.session === sessionId) latestTurn = undefined
  }

  return {
    stats() { return { ...tally } },
    /** The newest call that ran on a different model than the plugin asked for, if the latest call did. */
    lastMismatch: () => lastMismatch,
    /** Remember a plugin error so /greenharness can show it. */
    noteError(stage, error) {
      tally.errors = (tally.errors ?? 0) + 1
      lastError = `${stage}: ${error instanceof Error ? error.message : String(error)}`
    },
    lastError: () => lastError,
    /** How many sessions currently hold state; surfaced by `/greenharness doctor`. */
    sessionCount: () => sessions.size,
    beforeTool,
    afterTool,
    observeEvent,
    observeMessages,
    preStep,
    routeForNextCall,
    notePin,
    forgetSession,
    /**
     * A copy of the most recent turn's routing, for `/greenharness last` and the status line.
     * @returns {{ session: string, calls: number, models: Record<string, number>, tokens: number, tier?: string, verdict?: string, score?: number | null, plan: string[] } | undefined}
     */
    lastTurn() {
      if (latestTurn === undefined) return undefined
      return { ...latestTurn, models: { ...latestTurn.models }, tierTokens: { ...latestTurn.tierTokens }, plan: [...latestTurn.plan] }
    },
    /**
     * Read-only view of one session's routing state, for tests and diagnostics.
     * @param {string} sessionId
     */
    inspect(sessionId) {
      const state = stateOf(sessionId)
      return {
        tier: settings.routing.pinned || state.cascade.tier,
        stepsInTier: state.cascade.stepsInTier,
        consecutiveFailures: state.cascade.consecutiveFailures,
        triage: state.turn?.verdict,
      }
    },
  }
}

/**
 * Text that replaces a distilled tool result, with a pointer to the full output and — when
 * verbose is on — the tier the next call will use.
 * @param {ReturnType<typeof distillOutput>} distilled
 * @param {string | undefined} hint
 * @param {string | undefined} nextTier
 * @param {string | undefined} file
 */
function composeDistilled(distilled, hint, nextTier, file) {
  const { stats } = distilled
  const saved = file === undefined ? '' : ` Full output saved to ${file}. Open it with the read tool (use offset and limit for a part) if you need the missing lines.`
  const pointer = hint === undefined ? saved : `${saved} Full output: ${hint}.`
  const next = nextTier === undefined ? '' : ` Next call: ${nextTier}.`
  return `${distilled.text}\n[greenharness: distilled ${stats.inChars} to ${stats.outChars} chars; dropped ${stats.droppedLines} progress lines and ${stats.droppedFrames} library frames.${pointer}${next}]`
}

function truncate(text, limit = 240) {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

function numberOrNull(value) {
  return typeof value === 'number' ? value : null
}
