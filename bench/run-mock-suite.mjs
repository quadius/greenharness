#!/usr/bin/env node
/**
 * Runs every scripted scenario under every arm and prints one table. It is a plumbing check: the
 * mock is scripted, so the numbers show routing and context edits, not model quality or real cost.
 *
 *   npm run bench:mock            (needs Node 24 and DSH: set DSH_BIN, or put `dsh` on PATH)
 *
 * Results land under BENCH_OUT (default: runs/mock). Each case also writes its own summary.json.
 */
import { execFile } from 'node:child_process'
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outRoot = resolve(process.env.BENCH_OUT ?? join(here, '..', 'runs', 'mock'))
const ARMS = ['greenharness', 'always-large', 'always-small']

const scenarios = (await readdir(join(here, 'scenarios')))
  .filter(name => name.endsWith('.json'))
  .map(name => name.replace(/\.json$/, ''))
  .sort()

const rows = []
for (const scenario of scenarios) {
  for (const arm of ARMS) {
    const out = join(outRoot, `${scenario}-${arm}`)
    await runCase(['--task', 'subtract-bug', '--arm', arm, '--scenario', scenario, '--out', out, '--preset', 'mock'])
    rows.push(await readRow(scenario, arm, join(out, 'summary.json')))
  }
}

const table = renderTable(rows)
await mkdir(outRoot, { recursive: true })
await writeFile(join(outRoot, 'SUMMARY.md'), `${table}\n\nMock token counts are characters divided by four. They are not a tokenizer and not a bill.\n`)
console.log(table)

/** @param {string[]} args */
function runCase(args) {
  return new Promise((done) => {
    execFile(process.execPath, [join(here, 'run-case.mjs'), ...args], { env: process.env, maxBuffer: 64 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error) console.error(`case failed: ${args.join(' ')}\n${stderr}`)
      done()
    })
  })
}

/**
 * @param {string} scenario
 * @param {string} arm
 * @param {string} path
 */
async function readRow(scenario, arm, path) {
  try {
    const summary = JSON.parse(await readFile(path, 'utf8'))
    const served = summary.mock?.served_models ?? {}
    return {
      scenario,
      arm,
      calls: summary.mock?.agent_calls ?? 0,
      served: `${served['mock-bolt-e4b'] ?? 0} small / ${served['mock-lightning-30b'] ?? 0} large`,
      promptEst: summary.mock?.prompt_tokens_est ?? 0,
      cachedEst: summary.mock?.cached_tokens_est ?? 0,
      suite: summary.suite?.fail === null ? 'not run' : `${summary.suite.pass} pass / ${summary.suite.fail} fail`,
      distilled: summary.ledger?.tool_actions?.['bash:distill'] ?? 0,
      deduped: summary.ledger?.tool_actions?.['read:dedupe'] ?? 0,
      routes: summary.ledger?.route_changes?.length ?? 0,
      loopDenied: summary.mock?.saw_loop_guard_denial === true,
      errors: summary.ledger?.errors?.length ?? 0,
      triage: summary.ledger?.triage?.[0] ?? '—',
    }
  } catch (error) {
    return { scenario, arm, error: String(error?.message ?? error) }
  }
}

/** @param {Array<Record<string, any>>} rows */
function renderTable(rows) {
  const header = '| scenario | arm | agent calls | served by | prompt tokens (est.) | cached (est.) | suite | distilled | deduped | route changes | loop denied | triage | errors |'
  const rule = '|---|---|---:|---|---:|---:|---|---:|---:|---:|---|---|---|---:|'
  const body = rows.map((row) => {
    if (row.error) return `| ${row.scenario} | ${row.arm} | error: ${row.error} |`
    return `| ${row.scenario} | ${row.arm} | ${row.calls} | ${row.served} | ${row.promptEst} | ${row.cachedEst} | ${row.suite} | ${row.distilled} | ${row.deduped} | ${row.routes} | ${row.loopDenied ? 'yes' : 'no'} | ${row.triage} | ${row.errors} |`
  })
  return [header, rule, ...body].join('\n')
}
