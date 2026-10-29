#!/usr/bin/env node
/**
 * Run one benchmark case through the real DSH headless runner and report what happened.
 *
 *   node bench/run-case.mjs --task subtract-bug --arm greenharness --scenario subtract-fix --out <dir>
 *   node bench/run-case.mjs --task subtract-bug --arm always-large --preset nemo-brev --out <dir>
 *
 * Arms:
 *   greenharness  DSH with the GreenHarness plugin: the small tier by default, escalating on verifier failures.
 *   always-large  DSH without the plugin; every model call uses the large tier (the single-model baseline).
 *   always-small  DSH without the plugin; every model call uses the small tier.
 *
 * Presets (bench/presets/<name>.json) name the routes and the two tiers. A preset with "mock": true
 * (such as `mock`) points its routes at a scripted OpenAI-compatible server (plumbing only, not a
 * model) and needs --scenario. Live presets serve real models and run the task from its TASK.md;
 * they take no --scenario.
 *
 * Environment: DSH_BIN (the dsh binary, default `dsh`), NEMO_API_KEY (default: a placeholder for
 * local servers that do not check keys).
 *
 * Writes under --out: workspace/ (the task after the run), patch.yml, ledger.jsonl, requests.jsonl
 * (mock only), stdout.txt, stderr.txt and summary.json. The verdict is an independent re-run of
 * `node --test` in the workspace, not the agent's own claim.
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startMockServer } from './mock-openai-server.mjs'
import { renderPatch } from './lib/patch.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(here, '..')
const ARMS = ['greenharness', 'always-large', 'always-small']
const DEFAULT_PROMPT = 'Fix the failing tests in this project. Run node --test to check your work.'

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const { task, arm, scenario, out, preset = 'mock', port = '8124', prompt: promptOverride } = options
  if (!task || !out || !ARMS.includes(arm)) {
    console.error(`usage: node bench/run-case.mjs --task <dir under bench/tasks> --arm <${ARMS.join('|')}> --out <dir> [--preset mock|nemo-brev] [--scenario <name>] [--port 8124]`)
    process.exitCode = 2
    return
  }

  const outDir = resolve(out)
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })
  const workspace = join(outDir, 'workspace')
  await cp(join(here, 'tasks', task), workspace, { recursive: true })
  const prompt = promptOverride ?? (existsSync(join(workspace, 'TASK.md')) ? await readFile(join(workspace, 'TASK.md'), 'utf8') : DEFAULT_PROMPT)

  const spec = JSON.parse(await readFile(join(here, 'presets', `${preset}.json`), 'utf8'))
  const routes = structuredClone(spec.routes)
  let mock
  if (spec.mock === true) {
    if (!scenario) throw new Error('a mock preset needs --scenario <name>')
    const script = JSON.parse(await readFile(join(here, 'scenarios', `${scenario}.json`), 'utf8'))
    mock = await startMockServer({ port: Number(port), steps: script.steps, logPath: join(outDir, 'requests.jsonl') })
    for (const route of Object.values(routes)) route.baseURL = mock.url
  }

  const tiers = arm === 'always-large' ? { small: spec.tiers.large, large: spec.tiers.large }
    : arm === 'always-small' ? { small: spec.tiers.small, large: spec.tiers.small }
      : spec.tiers
  const patchPath = join(outDir, 'patch.yml')
  await writeFile(patchPath, renderPatch({
    routes,
    tiers,
    greenharness: arm === 'greenharness',
    pluginEntry: join(pluginRoot, 'src', 'index.mjs'),
    ledgerPath: join(outDir, 'ledger.jsonl'),
  }))

  const started = Date.now()
  let session
  try {
    session = await run(process.env.DSH_BIN ?? 'dsh', ['headless', '--patch', patchPath, prompt], {
      cwd: workspace,
      env: { ...process.env, DSH_HOME: join(outDir, 'dsh-home'), NEMO_API_KEY: process.env.NEMO_API_KEY ?? 'local-dev-no-auth' },
      timeout: 15 * 60 * 1000,
    })
  } finally {
    if (mock) await mock.close()
  }
  const wallSeconds = (Date.now() - started) / 1000
  await writeFile(join(outDir, 'stdout.txt'), session.stdout)
  await writeFile(join(outDir, 'stderr.txt'), session.stderr)

  // TAP output has the `# pass N` lines that matchCount reads; the default reporter does not.
  const suite = await run(process.execPath, ['--test', '--test-reporter=tap'], { cwd: workspace, timeout: 5 * 60 * 1000 })
  const ledger = readJsonl(join(outDir, 'ledger.jsonl'))
  const requests = mock ? readJsonl(join(outDir, 'requests.jsonl')) : []
  // A problem makes the run fail loudly. Without these checks, a wrong DSH_BIN or a plugin that
  // did not load would look like a finished run, and the greenharness arm would quietly be a baseline.
  const problems = []
  if (session.code !== 0) problems.push(`DSH exited with code ${session.code}; read stderr.txt`)
  if (arm === 'greenharness' && !ledger.some(record => record.type === 'request')) {
    problems.push('GreenHarness recorded no model calls, so the plugin probably did not load; read stderr.txt for "failed to import" or "did not activate"')
  }
  const summary = {
    arm,
    task,
    preset,
    scenario: scenario ?? null,
    wallSeconds,
    dshExitCode: session.code,
    dshTimedOut: session.timedOut,
    problems,
    suite: { exitCode: suite.code, pass: matchCount(suite.stdout, 'pass'), fail: matchCount(suite.stdout, 'fail') },
    finalText: session.stdout.trim(),
    ledger: summarizeLedger(ledger),
    ...(mock ? { mock: summarizeMock(requests) } : {}),
  }
  await writeFile(join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  console.log(JSON.stringify(summary, null, 2))
  for (const problem of problems) console.error(`problem: ${problem}`)
  if (problems.length > 0) process.exitCode = 1
}

/**
 * Run a command and resolve with its exit code and output. Never rejects.
 * @param {string} command
 * @param {string[]} args
 * @param {import('node:child_process').ExecFileOptions} [options]
 */
function run(command, args, options = {}) {
  return new Promise((done) => {
    execFile(command, args, { maxBuffer: 256 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      // A program that never started (for example, a wrong DSH_BIN) has no numeric exit code.
      // Keep its message, or stderr.txt stays empty and the failure is invisible.
      const startFailure = error && typeof error.code !== 'number' ? `${error.message}\n` : ''
      done({
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? '') + startFailure,
        timedOut: error?.killed === true,
      })
    })
  })
}

/**
 * @param {string} text - TAP output.
 * @param {'pass' | 'fail'} kind
 */
function matchCount(text, kind) {
  const match = new RegExp(`^# ${kind} (\\d+)$`, 'm').exec(text)
  return match ? Number(match[1]) : null
}

/** @param {string} path */
function readJsonl(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line))
}

/**
 * What the ledger says the run cost and did.
 * @param {Array<Record<string, any>>} records
 */
function summarizeLedger(records) {
  const requests = records.filter(r => r.type === 'request')
  const tools = records.filter(r => r.type === 'tool')
  const usage = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }
  for (const request of requests) {
    for (const key of Object.keys(usage)) usage[key] += request.usage?.[key] ?? 0
  }
  return {
    model_calls: requests.length,
    tiers: countBy(requests, r => r.tier),
    models: countBy(requests, r => `${r.provider}/${r.model}`),
    usage,
    costUsd: sum(requests, r => (Number.isFinite(r.costUsd) ? r.costUsd : 0)),
    route_changes: records.filter(r => r.type === 'route').map(r => `${r.from}->${r.to} (${r.reason})`),
    loop_breaks: records.filter(r => r.type === 'loop-break').length,
    tool_actions: countBy(tools, r => `${r.tool}:${r.action}`),
    errors: records.filter(r => r.type === 'error').map(r => `${r.stage}: ${r.message}`),
    triage: records.filter(r => r.type === 'triage').map(r => `${r.verdict} (${r.score ?? 'model'})`),
    pinned: records.some(r => r.type === 'route' && r.reason === 'pinned'),
  }
}

/**
 * What the mock server saw: which model served each agent call, and what the model was shown.
 * @param {Array<Record<string, any>>} records
 */
function summarizeMock(records) {
  const agent = records.filter(r => r.agentCall)
  const toolResults = records.flatMap(r => r.toolMessages ?? [])
  return {
    agent_calls: agent.length,
    side_calls: records.length - agent.length,
    served_models: countBy(agent, r => r.model),
    prompt_tokens_est: sum(agent, r => r.promptTokens),
    cached_tokens_est: sum(agent, r => r.cachedTokens),
    model_notices_sent: sum(records, r => r.noticeCount ?? 0),
    saw_distill_footer: toolResults.some(t => t.includes('[greenharness: distilled')),
    saw_dedupe_stub: toolResults.some(t => t.includes('[greenharness: this read returns the same lines')),
    saw_loop_guard_denial: toolResults.some(t => t.includes('GreenHarness loop guard')),
  }
}

/**
 * @template T
 * @param {T[]} items
 * @param {(item: T) => unknown} key
 */
function countBy(items, key) {
  const counts = {}
  for (const item of items) {
    const name = String(key(item))
    counts[name] = (counts[name] ?? 0) + 1
  }
  return counts
}

/**
 * @template T
 * @param {T[]} items
 * @param {(item: T) => unknown} pick
 */
function sum(items, pick) {
  return items.reduce((total, item) => total + (Number(pick(item)) || 0), 0)
}

/** @param {string[]} argv */
function parseArgs(argv) {
  const options = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]
    if (!key?.startsWith('--') || argv[i + 1] === undefined) {
      throw new Error(`expected --name value pairs, got: ${argv.slice(i).join(' ')}`)
    }
    options[key.slice(2)] = argv[i + 1]
  }
  return options
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
