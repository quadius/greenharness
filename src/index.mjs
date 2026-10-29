/**
 * GreenHarness: a DeepSeek Harness (dsh) plugin that cuts the token, GPU and dollar cost of
 * multi-step agent work. Installed as a DSH bundle with `dsh plugin add @quadiusai/dsh-greenharness`;
 * every setting has a default, and `/greenharness` controls it while DSH runs. See README.md.
 *
 * Five mechanisms, each with a ledger record:
 *   1. Triage: before the first call of a turn, decide whether the request needs the large model.
 *   2. Cascade: route each call from verifier outcomes (test, type-check, lint).
 *   3. Distillation: shorten bash output before it enters the session log.
 *   4. Read dedupe: replace a byte-identical re-read with a pointer.
 *   5. Loop breaker: deny a repeated failing command and escalate.
 *
 * @module @quadiusai/dsh-greenharness
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { createLedger } from './core/ledger.mjs'
import { applyRoute, withoutModelNotices } from './core/route.mjs'
import { planFor, parseVerdict, TRIAGE_SYSTEM } from './core/triage.mjs'
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
  routing: z.object({ pinned: z.string().default('') }).default({}),
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
    maxChars: z.number().default(12000),
    contextLines: z.number().default(2),
  }).default({}),
  readDedupe: z.object({ enabled: z.boolean().default(true) }).default({}),
  loopBreaker: z.object({
    enabled: z.boolean().default(true),
    threshold: z.number().default(3),
  }).default({}),
  ledger: z.object({
    path: z.string().default('.greenharness/ledger.jsonl'),
    pricing: z.dict(price).default({}),
  }).default({}),
})

export function apply(ctx, config) {
  const settings = normalizeSettings(config)
  const ledger = createLedger(settings.ledger.path)
  const classifier = buildClassifier(ctx, settings, ledger)
  const runtime = createGreenHarness(settings, { ledger, logger: ctx.logger, classifier })
  const control = { paused: false }

  ctx.on('agent/request', async (payload, next) => {
    const proposed = await next()
    try {
      if (control.paused) return proposed
      const route = runtime.routeForNextCall(payload.agent.session.header.id, proposed)
      return route === undefined ? proposed : applyRoute(proposed, route)
    } catch (error) {
      reportError(ctx, ledger, 'agent/request', error, runtime)
      return proposed
    }
  })

  // DSH adds a "model changed" notice on purpose now, so the notice is removed here and the
  // ledger records each route change instead. This listener goes on the agent context, after
  // DSH's own listener, with `prepend`, so it is the outer listener and sees the notice.
  ctx.on('agent/created', ({ agent }) => {
    agent?.ctx?.on('agent/pre-step', async (_payload, next) => {
      const decision = await next()
      if (decision.kind !== 'enter') return decision
      const messages = withoutModelNotices(decision.messages)
      try {
        await runtime.observeMessages(agent.session.header.id, messages)
      } catch (error) {
        reportError(ctx, ledger, 'agent/pre-step', error, runtime)
      }
      return messages.length === decision.messages.length ? decision : { ...decision, messages }
    }, { prepend: true })
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next()
    if (control.paused || decision.kind !== 'allow') return decision
    const call = toCall(ctx, exec)
    if (call === undefined) return decision
    try { return runtime.beforeTool(call) ?? decision }
    catch (error) { reportError(ctx, ledger, 'tools/pre-execute', error, runtime); return decision }
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (control.paused || decision.kind !== 'accept' || Object.hasOwn(decision, 'value')) return decision
    const call = toCall(ctx, exec, result, resolve(dirname(settings.ledger.path), 'outputs'))
    if (call === undefined) return decision
    try {
      const replacement = await runtime.afterTool(call)
      if (replacement === undefined) return decision
      return { ...decision, kind: 'accept', content: [{ type: 'text', text: replacement.text }] }
    } catch (error) {
      reportError(ctx, ledger, 'tools/post-execute', error, runtime)
      return decision
    }
  })

  registerCommand(ctx, { control, settings, runtime, llm: ctx.llm })

  ctx.on('session/event', (session, event) => {
    try { runtime.observeEvent(session.header.id, event) }
    catch (error) { reportError(ctx, ledger, 'session/event', error, runtime) }
  })
}

/**
 * A model-based triage classifier, when `triage.mode: 'model'`. It asks DSH's LLM service for one
 * short, tools-free completion. If the service exposes no completion method, it returns undefined
 * once so the heuristic answers instead; the run never fails on it.
 */
function buildClassifier(ctx, settings, ledger) {
  if (settings.triage.mode !== 'model') return undefined
  let warned = false
  return async (text) => {
    const llm = ctx.llm
    const generate = typeof llm?.generate === 'function' ? llm.generate
      : typeof llm?.complete === 'function' ? llm.complete
        : undefined
    if (generate === undefined) {
      if (!warned) {
        warned = true
        ledger.write({ type: 'triage-skip', reason: 'ctx.llm exposes no completion method; using the heuristic' })
      }
      return undefined
    }
    const reply = await generate.call(llm, {
      provider: settings.triage.model.provider,
      model: settings.triage.model.model,
      system: TRIAGE_SYSTEM,
      prompt: String(text).slice(0, settings.triage.maxChars),
      maxTokens: 8,
      temperature: 0,
    })
    const verdict = parseVerdict(typeof reply === 'string' ? reply : reply?.text)
    return verdict === undefined ? undefined : { verdict, score: null, signals: ['model'], plan: planFor(verdict) }
  }
}

function registerCommand(ctx, host) {
  ctx.effect(function* () {
    yield ctx.commands.register({
      definitionId: '@quadiusai/dsh-greenharness',
      name: 'greenharness',
      description: 'GreenHarness: see tokens saved, choose cheap and strong models, pin a tier, switch features (try: help)',
      input: { hint: 'help | models | large <number> | tier auto|large|small | last | profile cheap | benchmark on <prompt>' },
      handler: (invocation) => runCommand(invocation.rawInput, host),
    })
  }, 'greenharness command')
}

function reportError(ctx, ledger, stage, error, runtime) {
  try { runtime?.noteError?.(stage, error) } catch { /* ignore */ }
  const message = error instanceof Error ? error.message : String(error)
  try { ledger.write({ type: 'error', stage, message }) } catch { /* ledger unavailable too */ }
  ctx.logger?.warn?.(`greenharness: ${stage} failed: ${message}`)
}

function toCall(ctx, exec, result, outputsDir) {
  const agent = exec.agent
  if (agent === undefined) return undefined
  const value = result?.value
  return {
    sessionId: agent.session.header.id,
    name: exec.name,
    args: exec.arguments ?? {},
    callId: exec.callId,
    isError: result?.isError === true,
    exitCode: typeof value?.exitCode === 'number' ? value.exitCode : undefined,
    timedOut: value?.timedOut === true,
    text: contentText(result?.content),
    // The full, untouched output goes to a plain file the model can open with its read tool, so
    // shortening never loses data even when DSH's spill store is unavailable.
    saveFile: outputsDir === undefined ? undefined : async (text) => {
      mkdirSync(outputsDir, { recursive: true })
      const file = join(outputsDir, `${exec.name}-${String(exec.callId ?? Date.now()).replace(/[^A-Za-z0-9_-]/g, '_')}.txt`)
      writeFileSync(file, text)
      return file
    },
    spill: async (text) => {
      const store = ctx.get('spillStore')
      if (store === undefined) return undefined
      const ref = await store.saveText({
        owner: { sessionId: agent.session.header.id },
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
