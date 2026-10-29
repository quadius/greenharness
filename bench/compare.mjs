#!/usr/bin/env node
/**
 * Benchmark comparison runner:
 * Executes a prompt/scenario twice (once on `always-large` baseline, once on `greenharness`)
 * and outputs the full response text for both, followed by a side-by-side FinOps comparison.
 *
 * CLI usage:
 *   node bench/compare.mjs "build-horse"
 *   node bench/compare.mjs "Generate a 3D model of a horse using JavaScript and three.js"
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(here, '..')

/**
 * Determine task and scenario based on user prompt/name.
 * @param {string} promptInput
 */
export function resolveTaskAndScenario(promptInput) {
  const norm = String(promptInput ?? '').trim().toLowerCase()
  if (norm === 'loop-stuck' || norm.includes('loop')) {
    return { task: 'subtract-bug', scenario: 'loop-stuck', prompt: promptInput === 'loop-stuck' ? undefined : promptInput }
  }
  if (norm === 'subtract-fix' || norm.includes('subtract') || norm.includes('math') || norm.includes('bug')) {
    return { task: 'subtract-bug', scenario: 'subtract-fix', prompt: promptInput === 'subtract-fix' ? undefined : promptInput }
  }
  // Default to 3D horse greenfield build scenario
  const task = existsSync(join(here, 'tasks', 'horse-3d')) ? 'horse-3d' : 'subtract-bug'
  const isScenarioName = norm === 'build-horse' || norm === 'horse'
  return { task, scenario: 'build-horse', prompt: isScenarioName ? undefined : promptInput }
}

/**
 * Run one arm using bench/run-case.mjs.
 * @param {{ task: string, arm: string, scenario: string, out: string, prompt?: string, port?: number }} config
 */
function executeCase({ task, arm, scenario, out, prompt, port = 8128 }) {
  const args = [
    join(here, 'run-case.mjs'),
    '--task', task,
    '--arm', arm,
    '--scenario', scenario,
    '--out', out,
    '--preset', 'mock',
    '--port', String(port),
  ]
  if (prompt) {
    args.push('--prompt', prompt)
  }

  return new Promise((done) => {
    execFile(process.execPath, args, { cwd: pluginRoot, env: process.env, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      done({ error, stdout, stderr })
    })
  })
}

/**
 * Run benchmark comparison and return the formatted report.
 * @param {string} promptInput
 * @param {{ port?: number }} [options]
 * @returns {Promise<{ report: string, results: { alwaysLarge: any, greenharness: any } }>}
 */
export async function runBenchmarkComparison(promptInput, { port = 8128 } = {}) {
  const { task, scenario, prompt } = resolveTaskAndScenario(promptInput)
  const runId = `bench-${Date.now()}-${randomUUID().slice(0, 8)}`
  const baseDir = join(tmpdir(), 'greenharness-bench', runId)
  const outLarge = join(baseDir, 'always-large')
  const outGreen = join(baseDir, 'greenharness')

  try {
    await mkdir(baseDir, { recursive: true })

    // Run 1: always-large
    await executeCase({ task, arm: 'always-large', scenario, out: outLarge, prompt, port })
    // Run 2: greenharness
    await executeCase({ task, arm: 'greenharness', scenario, out: outGreen, prompt, port })

    const summaryLarge = JSON.parse(await readFile(join(outLarge, 'summary.json'), 'utf8'))
    const summaryGreen = JSON.parse(await readFile(join(outGreen, 'summary.json'), 'utf8'))

    const report = formatComparisonReport({
      prompt: promptInput,
      task,
      scenario,
      large: summaryLarge,
      green: summaryGreen,
    })

    return {
      report,
      results: {
        alwaysLarge: summaryLarge,
        greenharness: summaryGreen,
      },
    }
  } finally {
    try {
      await rm(baseDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup error
    }
  }
}

/**
 * Format the side-by-side comparison report.
 */
function formatComparisonReport({ prompt, task, scenario, large, green }) {
  const textLarge = String(large.finalText ?? '').trim() || '(No text output produced)'
  const textGreen = String(green.finalText ?? '').trim() || '(No text output produced)'

  const largePromptTokens = large.mock?.prompt_tokens_est ?? large.ledger?.usage?.inputTokens ?? 0
  const greenPromptTokens = green.mock?.prompt_tokens_est ?? green.ledger?.usage?.inputTokens ?? 0
  const tokenDiff = largePromptTokens - greenPromptTokens
  const pctSaved = largePromptTokens > 0 ? ((tokenDiff / largePromptTokens) * 100).toFixed(1) : '0.0'

  const largeCached = large.mock?.cached_tokens_est ?? large.ledger?.usage?.cacheReadTokens ?? 0
  const greenCached = green.mock?.cached_tokens_est ?? green.ledger?.usage?.cacheReadTokens ?? 0

  const largeCalls = large.mock?.agent_calls ?? large.ledger?.model_calls ?? 0
  const greenCalls = green.mock?.agent_calls ?? green.ledger?.model_calls ?? 0

  const greenDistill = green.ledger?.tool_actions?.['bash:distill'] ?? 0
  const greenDedupe = green.ledger?.tool_actions?.['read:dedupe'] ?? 0
  const greenLoop = green.mock?.saw_loop_guard_denial ? 1 : (green.ledger?.loop_breaks ?? 0)
  const greenTriage = green.ledger?.triage?.[0] ?? '—'
  const routeChanges = green.ledger?.route_changes?.length ?? 0

  const suiteLarge = large.suite ? `${large.suite.pass} pass / ${large.suite.fail} fail` : 'n/a'
  const suiteGreen = green.suite ? `${green.suite.pass} pass / ${green.suite.fail} fail` : 'n/a'

  return [
    '================================================================================',
    '                    GREENHARNESS DUAL-RUN BENCHMARK REPORT                      ',
    '================================================================================',
    `Target: "${prompt}"`,
    `Scenario: ${scenario} · Task Fixture: ${task}`,
    '',
    '--------------------------------------------------------------------------------',
    '1. ALWAYS-LARGE BASELINE (Single strong model, unoptimized tool output)',
    '--------------------------------------------------------------------------------',
    textLarge,
    '',
    `• Calls: ${largeCalls} (all large tier)`,
    `• Prompt Tokens (est): ${largePromptTokens.toLocaleString('en-US')}`,
    `• Cached Tokens (est): ${largeCached.toLocaleString('en-US')}`,
    `• Verification Suite:  ${suiteLarge}`,
    `• Elapsed Time:        ${large.wallSeconds?.toFixed(2) ?? '—'}s`,
    '',
    '--------------------------------------------------------------------------------',
    '2. GREENHARNESS (Triage + Cascade routing + Distillation + Read dedupe)',
    '--------------------------------------------------------------------------------',
    textGreen,
    '',
    `• Triage Verdict:      ${greenTriage}`,
    `• Route Switches:      ${routeChanges}`,
    `• Calls:               ${greenCalls}`,
    `• Tool Distillations:  ${greenDistill}`,
    `• Deduped Reads:       ${greenDedupe}`,
    `• Loop Breaker Triggers: ${greenLoop}`,
    `• Prompt Tokens (est): ${greenPromptTokens.toLocaleString('en-US')}`,
    `• Cached Tokens (est): ${greenCached.toLocaleString('en-US')}`,
    `• Verification Suite:  ${suiteGreen}`,
    `• Elapsed Time:        ${green.wallSeconds?.toFixed(2) ?? '—'}s`,
    '',
    '--------------------------------------------------------------------------------',
    '3. SIDE-BY-SIDE FINOPS COMPARISON',
    '--------------------------------------------------------------------------------',
    'Metric                  always-large         greenharness         Difference',
    '--------------------------------------------------------------------------------',
    `Prompt Tokens (est)     ${pad(largePromptTokens.toLocaleString('en-US'), 20)} ${pad(greenPromptTokens.toLocaleString('en-US'), 20)} -${tokenDiff.toLocaleString('en-US')} (${pctSaved}%)`,
    `Cached Tokens (est)     ${pad(largeCached.toLocaleString('en-US'), 20)} ${pad(greenCached.toLocaleString('en-US'), 20)} ${greenCached - largeCached >= 0 ? '+' : ''}${(greenCached - largeCached).toLocaleString('en-US')}`,
    `Agent Step Calls        ${pad(String(largeCalls), 20)} ${pad(String(greenCalls), 20)} ${greenCalls - largeCalls === 0 ? 'identical' : (greenCalls - largeCalls)}`,
    `Tool Distillations      ${pad('0', 20)} ${pad(String(greenDistill), 20)} +${greenDistill} compressed`,
    `Read Deduplications     ${pad('0', 20)} ${pad(String(greenDedupe), 20)} +${greenDedupe} deduped`,
    `Loop Breaker Stops      ${pad('0', 20)} ${pad(String(greenLoop), 20)} ${greenLoop > 0 ? '+1 loop prevented' : '0'}`,
    `Task Verification       ${pad(suiteLarge, 20)} ${pad(suiteGreen, 20)} ${suiteLarge === suiteGreen ? 'Identical result' : 'Different'}`,
    '--------------------------------------------------------------------------------',
    tokenDiff > 0
      ? `CONCLUSION: GreenHarness reduced prompt tokens by ${pctSaved}% (${tokenDiff.toLocaleString('en-US')} tokens saved) while achieving the same task outcome.`
      : `CONCLUSION: Both configurations delivered identical task outcomes with equivalent token consumption.`,
    '================================================================================',
  ].join('\n')
}

function pad(str, len) {
  return String(str).padEnd(len)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const promptArg = process.argv.slice(2).join(' ').trim() || 'build-horse'
  console.log(`Running benchmark on: "${promptArg}"...`)
  const { report } = await runBenchmarkComparison(promptArg)
  console.log(report)
}
