/**
 * GreenHarness: a DeepSeek Harness (dsh) plugin that cuts the token, GPU and dollar cost of
 * multi-step agent work. Installed as a DSH bundle with `dsh plugin add @quadiusai/dsh-greenharness`;
 * every setting has a default, and `/greenharness` controls it while DSH runs. See README.md.
 *
 * Five mechanisms, each with a ledger record:
 *   1. Triage: before the first call of a turn, decide whether the request needs the large model.
 *   2. Cascade: route each call from verifier outcomes (test, type-check, lint).
 *   3. Distillation: shorten noisy tool output before it enters the session log.
 *   4. Read dedupe: replace a byte-identical re-read with a pointer, at most once in a row.
 *   5. Loop breaker: deny a repeated failing command and escalate.
 *
 * @module @quadiusai/dsh-greenharness
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { createLedger, pruneOutputs } from './core/ledger.mjs'
import { applyRoute } from './core/route.mjs'
import { planFor, parseVerdict, TRIAGE_SYSTEM } from './core/triage.mjs'
import { DEFAULT_PROGRESS_TOOLS } from './core/loop-guard.mjs'
import { normalizeSettings } from './config.mjs'
import { createGreenHarness } from './runtime.mjs'
import { runCommand } from './control.mjs'

export const name = 'greenharness'
export const inject = ['commands', 'llm']

const route = z.object({
  provider: z.string().default(''),
  model: z.string().default(''),
  reasoningEffort: z.string().default(''),
})

const price = z.object({
  inputPerMTok: z.number(),
  cachedInputPerMTok: z.number(),
  outputPerMTok: z.number(),
})

export const Config = z.object({
  tiers: z.object({ small: route, large: route }).default({}),
  routing: z.object({
    pinned: z.string().default(''),
    stripNotices: z.string().default('tier'),
  }).default({}),
  profile: z.string().default('balanced'),
  verbose: z.boolean().default(true),
  cascade: z.object({
    escalateAfterFailures: z.number().default(1),
    deescalateAfterPasses: z.number().default(2),
    minStepsPerTier: z.number().default(2),
  }).default({}),
  verifier: z.object({ patterns: z.array(z.string()).default([]) }).default({}),
  triage: z.object({
    enabled: z.boolean().default(true),
    mode: z.string().default('heuristic'),
    largeAt: z.number().default(0.6),
    mixedAt: z.number().default(0.35),
    mixedAfterSteps: z.number().default(2),
    maxChars: z.number().default(2000),
    model: route,
  }).default({}),
  distill: z.object({
    enabled: z.boolean().default(true),
    tools: z.array(z.string()).default(['bash']),
    maxChars: z.number().default(12000),
    contextLines: z.number().default(2),
    requireNoise: z.boolean().default(true),
  }).default({}),
  readDedupe: z.object({
    enabled: z.boolean().default(true),
    escapeHatch: z.boolean().default(true),
  }).default({}),
  loopBreaker: z.object({
    enabled: z.boolean().default(true),
    threshold: z.number().default(3),
    progressTools: z.array(z.string()).default([...DEFAULT_PROGRESS_TOOLS]),
  }).default({}),
  ledger: z.object({
    path: z.string().default('.greenharness/ledger.jsonl'),
    perSession: z.boolean().default(true),
    maxBytes: z.number().default(4 * 1024 * 1024),
    outputsKeep: z.number().default(50),
    pricing: z.dict(price).default({}),
  }).default({}),
})

export function apply(ctx, config) {
  const settings = normalizeSettings(config)
  /** Absolute workspace per session, so the ledger and spilled output stay with the project. */
  const workspaces = new Map()
  const cwdFor = sessionId => workspaces.get(sessionId)
  const ledger = createLedger({
    path: settings.ledger.path,
    perSession: settings.ledger.perSession,
    maxBytes: settings.ledger.maxBytes,
    cwdFor,
    logger: ctx.logger,
  })
  const classifier = buildClassifier(ctx, settings, ledger)
  const runtime = createGreenHarness(settings, { ledger, logger: ctx.logger, classifier })
  const control = { paused: false }

  ctx.effect(() => () => { void ledger.dispose() })

  ctx.on('agent/created', ({ agent }) => {
    const sessionId = agent?.session?.header?.id
    if (sessionId !== undefined && agent?.session?.header?.cwd !== undefined) {
      workspaces.set(sessionId, agent.session.header.cwd)
    }
    // DSH adds a "model changed" notice on purpose now, so the notice is removed here (only when
    // this plugin's own routing caused it) and the ledger records each route change instead.
    agent?.ctx?.on('agent/pre-step', async (_payload, next) => {
      const decision = await next()
      if (decision.kind !== 'enter') return decision
      try {
        const messages = await runtime.preStep(agent.session.header.id, decision.messages)
        return messages.length === decision.messages.length ? decision : { ...decision, messages }
      } catch (error) {
        reportError(ctx, ledger, 'agent/pre-step', error, runtime, agent.session.header.id)
        return decision
      }
    }, { prepend: true })
  })

  ctx.on('agent/disposed', ({ agent }) => {
    const sessionId = agent?.session?.header?.id
    if (sessionId === undefined) return
    try { runtime.forgetSession(sessionId) } catch (error) { reportError(ctx, ledger, 'agent/disposed', error, runtime, sessionId) }
    workspaces.delete(sessionId)
  })

  ctx.on('agent/request', async (payload, next) => {
    const proposed = await next()
    try {
      if (control.paused) return proposed
      const sessionId = payload.agent.session.header.id
      workspaces.set(sessionId, payload.agent.session.header.cwd ?? workspaces.get(sessionId) ?? process.cwd())
      const route = runtime.routeForNextCall(sessionId, proposed)
      return route === undefined ? proposed : applyRoute(proposed, route)
    } catch (error) {
      reportError(ctx, ledger, 'agent/request', error, runtime, payload?.agent?.session?.header?.id)
      return proposed
    }
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next()
    if (control.paused || decision.kind !== 'allow') return decision
    try {
      const call = toToolCall(exec, undefined, undefined, ctx)
      if (call === undefined) return decision
      return runtime.beforeTool(call) ?? decision
    } catch (error) {
      reportError(ctx, ledger, 'tools/pre-execute', error, runtime, exec?.agent?.session?.header?.id)
      return decision
    }
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (control.paused || decision.kind !== 'accept' || Object.hasOwn(decision, 'value')) return decision
    try {
      const call = toToolCall(exec, result, { ...settings.ledger, cwd: cwdFor(exec.agent?.session?.header?.id) }, ctx)
      if (call === undefined) return decision
      const replacement = await runtime.afterTool(call)
      if (replacement === undefined) return decision
      return { ...decision, kind: 'accept', content: [{ type: 'text', text: replacement.text }] }
    } catch (error) {
      reportError(ctx, ledger, 'tools/post-execute', error, runtime, exec?.agent?.session?.header?.id)
      return decision
    }
  })

  registerCommand(ctx, { control, settings, runtime, llm: ctx.llm, ledger })

  ctx.on('session/event', (session, event) => {
    const sessionId = session.header.id
    if (session.header.cwd !== undefined) workspaces.set(sessionId, session.header.cwd)
    try { runtime.observeEvent(sessionId, event) }
    catch (error) { reportError(ctx, ledger, 'session/event', error, runtime, sessionId) }
  })
}

/**
 * A model-based triage classifier, when `triage.mode: 'model'`. It makes one short, tools-free
 * completion through DSH's `llm` service (`stream`, the only generation entry point in 0.2.x)
 * and falls back to the heuristic whenever that call is unavailable or unclear, so triage never
 * blocks or fails a run.
 */
function buildClassifier(ctx, settings, ledger) {
  if (settings.triage.mode !== 'model') return undefined
  let warned = false
  return async (text, sessionId) => {
    const llm = ctx.llm
    if (typeof llm?.stream !== 'function') {
      if (!warned) {
        warned = true
        ledger.write({ type: 'triage-skip', session: sessionId, reason: 'ctx.llm exposes no stream method; using the heuristic' })
      }
      return undefined
    }
    const target = settings.triage.model
    const options = {
      provider: target.provider,
      model: target.model,
      ...(target.reasoningEffort === '' ? {} : { reasoningEffort: target.reasoningEffort }),
      system: TRIAGE_SYSTEM,
      messages: [{ role: 'user', content: [{ type: 'text', text: String(text).slice(0, settings.triage.maxChars) }] }],
      maxTokens: 8,
      temperature: 0,
    }
    let reply = ''
    let failure
    for await (const chunk of llm.stream(options)) {
      if (chunk?.type === 'text-delta') reply += chunk.text ?? ''
      else if (chunk?.type === 'finish' && chunk.reason?.kind !== 'stop' && chunk.reason?.kind !== 'tool-calls') failure = chunk.reason
    }
    if (failure !== undefined) {
      throw new Error(`triage model call ended with ${failure.kind ?? 'an error'}${failure.failure?.message === undefined ? '' : `: ${failure.failure.message}`}`)
    }
    const verdict = parseVerdict(reply)
    return verdict === undefined ? undefined : { verdict, score: null, signals: ['model'], plan: planFor(verdict) }
  }
}

function registerCommand(ctx, host) {
  ctx.effect(function* () {
    yield ctx.commands.register({
      definitionId: '@quadiusai/dsh-greenharness',
      name: 'greenharness',
      description: 'GreenHarness: see tokens saved, choose cheap and strong models, pin a tier, switch features (try: help)',
      input: { hint: 'help | doctor | models | large <number> | tier auto|large|small | last | profile cheap' },
      handler: (invocation) => {
        // Keep one host object across invocations so `/greenharness models` can cache its listing.
        host.agent = invocation.agent
        return runCommand(invocation.rawInput, host)
      },
    })
  }, 'greenharness command')
}

function reportError(ctx, ledger, stage, error, runtime, sessionId) {
  try { runtime?.noteError?.(stage, error) } catch { /* ignore */ }
  const message = error instanceof Error ? error.message : String(error)
  try { ledger.write({ type: 'error', stage, session: sessionId, message }) } catch { /* ledger unavailable too */ }
  ctx.logger?.warn?.(`greenharness: ${stage} failed: ${message}`)
}

/**
 * Project one tool dispatch into the narrow shape the runtime uses. Everything optional is
 * resolved lazily, so a missing field can never throw inside a hook.
 * @param {{ agent?: any, name?: string, arguments?: Record<string, any>, callId?: string }} exec
 * @param {{ content?: any[], isError?: boolean, value?: any }} [result]
 * @param {{ path?: string, cwd?: string, outputsKeep?: number }} [sink]
 * @param {{ get(name: string): any }} [ctx]
 */
function toToolCall(exec, result, sink, ctx) {
  const agent = exec?.agent
  const sessionId = agent?.session?.header?.id
  if (sessionId === undefined) return undefined
  const value = result?.value
  const cwd = sink?.cwd ?? agent.session.header.cwd ?? process.cwd()
  const outputsDir = sink?.path ? resolve(cwd, dirname(sink.path), 'outputs') : undefined
  const keep = sink?.outputsKeep
  return {
    sessionId,
    name: exec.name ?? 'unknown',
    args: exec.arguments ?? {},
    callId: exec.callId,
    isError: result?.isError === true,
    exitCode: typeof value?.exitCode === 'number' ? value.exitCode : undefined,
    timedOut: value?.timedOut === true,
    text: contentText(result?.content),
    // The full, untouched output goes to a plain file inside the session workspace, so the model
    // can reopen it with its read tool even when DSH's spill store is unavailable.
    saveFile: outputsDir === undefined ? undefined : async (text) => {
      await mkdir(outputsDir, { recursive: true })
      const stamp = Date.now()
      const safeCall = String(exec.callId ?? stamp).replace(/[^A-Za-z0-9_-]/g, '_')
      const safeTool = String(exec.name ?? 'tool').replace(/[^A-Za-z0-9_-]/g, '_')
      const file = join(outputsDir, `${stamp}-${safeTool}-${safeCall}.txt`)
      await writeFile(file, text)
      void pruneOutputs(outputsDir, keep)
      return file
    },
    spill: async (text) => {
      const store = ctx?.get?.('spillStore')
      if (store === undefined) return undefined
      const ref = await store.saveText({
        owner: { sessionId },
        source: { kind: 'tool', toolName: exec.name, callId: exec.callId, label: 'result' },
        suggestedName: `${exec.name}.txt`,
        content: text,
      })
      return ref.retrievalHint
    },
  }
}

function contentText(content) {
  return (content ?? []).filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
}
