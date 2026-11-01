# GreenHarness

A DeepSeek Harness (dsh) plugin that makes multi-step agent runs cheaper. It routes each model call between a small and a large model using the outcome of the project's own tests. It shortens noisy tool output before the model reads it, and it stops an agent from repeating a failing command.

Built for AEGIS 2026, problem 2 (agentic cost and efficiency), team Skyline.

New to terminals or agents? Start with [`GETTING-STARTED.md`](GETTING-STARTED.md). What changed in 0.2.0 is in [`CHANGELOG.md`](CHANGELOG.md); where this is going is in [`ROADMAP.md`](ROADMAP.md).

## Quick install

```bash
dsh plugin --profile web add @quadiusai/dsh-greenharness
```

That is the whole setup. The package declares itself as a DSH bundle, so DSH turns it on in that profile by itself, and every setting has a default. Restart `dsh web`, then type `/greenharness` in the chat:

| Command | What it does |
|---|---|
| `/greenharness` | Status: what is on, and what it has done in this process. |
| `/greenharness doctor` | Every effective setting, the ledger file for this session, and anything that looks wrong. |
| `/greenharness on` / `off` | Resume or pause every mechanism. |
| `/greenharness models` | List the models DSH knows, numbered. |
| `/greenharness large <number or name> [effort]` | Turn on model routing. The small model is whatever DSH already uses; this one is the large model that failing tests escalate to. |
| `/greenharness small <number or name>` | Set the small model. |
| `/greenharness small <provider> <model> [effort]` | Set the small model explicitly. |
| `/greenharness tier auto` / `large` / `small` | Pin every call to one model, or return to automatic routing. |
| `/greenharness profile cheap` / `balanced` / `quality` | Switch several settings at once (profiles). |
| `/greenharness last` | See which model answered the last request, and why. |
| `/greenharness verbose on` / `off` | Toggle next-tier annotations on distilled output. |
| `/greenharness routing on` / `off` | Switch routing without losing the models. |
| `/greenharness distill` / `dedupe` / `loop` `on` / `off` | Switch one mechanism. |
| `/greenharness benchmark on <scenario>` | Developer tool. Compares `always-large` against `greenharness` on the scripted mock; needs `GREENHARNESS_BENCH=1`. |

With no setup, GreenHarness shortens noisy command output, replaces a repeated file read with a pointer, and blocks a repeated failing command. These need only one model. Routing between two models starts when you set a large model. Command settings last until DSH restarts; to make them permanent, put the same values in the plugin's config (`tiers`, `distill`, and so on, see Configuration).

## Status

- **Plugin:** five mechanisms on DSH 0.2.1-rc.5. **134 unit and integration tests** pass on Node, including a fake Cordis context that drives the real hooks.
- **Verified end to end against a scripted mock server** on rc.5 (plumbing, not a model): every mechanism reaches the model, and the run reports zero plugin errors. Numbers below.
- **Verified in a live web profile** on 0.1.6 during ten days of use: triage, distillation, routing and one verifier-driven escalation all appear in the ledger. The same ledger showed the weaknesses 0.2.0 fixes: read dedupe never fired, tier labels drifted, and a global ledger pooled every project.
- **Not measured: any real NeMo model.** No quality or cost number for a real model exists yet. The live runbook is [`BREV-SETUP.md`](BREV-SETUP.md).
- **Not checked:** typing `/greenharness` in the web chat of a fresh profile. The command is exercised through its handler in tests, not through the composer.

## How it works

| Mechanism | What it does | DSH hook | Ledger record |
|---|---|---|---|
| Triage | Reads the user request once at the start of a turn and scores it. Greenfield builds seed the cascade on the large tier; mixed work gives the small model its first steps, then escalates. Heuristic by default (0 tokens, deterministic), or model-assisted through DSH's `llm.stream`. | `agent/created` (`agent/pre-step`) | `triage`, `route` |
| Cascade | A verifier command (test runner, type checker, linter) that fails moves the next model call to the large tier. Passes twice in a row, after a minimum number of calls, move it back. No judge model is called. | `agent/request` (route), `tools/post-execute` (outcome) | `route`, `request` |
| Distillation | Bash output keeps failure, summary and safety lines plus nearby context. It drops progress frames and library stack frames, and collapses repeated lines. The full output goes to a file in the workspace and to DSH's spill store; the model gets a pointer to both. | `tools/post-execute` | `tool` with action `distill` |
| Read dedupe | A read whose bytes match an earlier read still in context returns a pointer instead of the file again — at most once in a row. An edit or write forgets the path, and compaction forgets everything. | `tools/post-execute` | `tool` with action `dedupe` |
| Loop breaker | A bash command that failed `threshold` times in a row with the same failure, and no file change since, is denied with a reason. The tier goes to large. | `tools/pre-execute` | `loop-break` |

### Hook facts that shaped the design

These come from DSH 0.2.1-rc.5's typings and source.

- **Routing** uses the `agent/request` waterfall. A listener that calls `await next()` receives the config DSH would use, and it returns a replacement to switch the model. DSH seeds each call from the last logged request header, so the route is applied on every call.
- **Notice removal.** DSH adds a "model changed" notice whenever its default selection differs from the last request. Per-step routing triggers that on every step. GreenHarness removes only the notices its own routing caused, and keeps a notice about a model the user switched to; `routing.stripNotices` decides (`tier` by default, `all`, or `none`). The listener is attached to each agent at `agent/created` with `prepend`, so it runs outside DSH's own notice listener.
- **Triage model calls** go through `llm.stream()`. rc.5's `llm` service has no `generate`/`complete`; 0.1.x probed for them and silently fell back to the heuristic forever.
- **Session workspace.** `session.header.cwd` is where the ledger and spilled output live, so a plugin in a web server does not scatter files into the directory `dsh web` happened to be started from.
- **No `agent.model.select()`.** An earlier build called it. The call threw, the error was swallowed, and the unit tests passed only because they used a fake. Plugin failures are now written to the ledger as `error` records.

## Configuration

Settings are validated when the plugin loads. A missing tier, a bad integer, an empty list entry, an unknown enum value or an invalid regex fails loudly.

| Key | Default | Meaning |
|---|---|---|
| `tiers.small`, `tiers.large` | required | `provider`, `model`, and `reasoningEffort` (empty means the provider default). |
| `routing.pinned` | `""` | Tier lock: `""` (auto), `"small"`, or `"large"`. |
| `routing.stripNotices` | `"tier"` | Which model-switch notices to remove: `"tier"` (only the ones routing caused), `"all"`, `"none"`. |
| `profile` | `"balanced"` | Preset bundle: `"cheap"`, `"balanced"`, or `"quality"`. |
| `verbose` | `true` | Annotate distilled output with next tier. |
| `cascade.escalateAfterFailures` | 1 | Consecutive verifier failures before moving to large. |
| `cascade.deescalateAfterPasses` | 2 | Consecutive verifier passes before moving back to small. |
| `cascade.minStepsPerTier` | 2 | Minimum model calls in a tier before it can change. |
| `verifier.patterns` | test runners, type checkers, linters | Regexes that mark a bash command as a verifier. |
| `triage.enabled`, `mode` | `true`, `"heuristic"` | Triage switch and classification engine (`"heuristic"` or `"model"`). |
| `triage.model` | required for `"model"` | The provider and model that classify a request (one 8-token completion). |
| `triage.largeAt`, `mixedAt` | `0.6`, `0.35` | Score thresholds for large and mixed verdicts. |
| `triage.mixedAfterSteps` | 2 | Steps before a mixed turn escalates to the large model. |
| `triage.maxChars` | 2000 | Character limit considered when scoring a prompt. |
| `distill.enabled`, `maxChars`, `contextLines` | true, 12000, 2 | Distillation switch, output budget (at least 500), and context lines around failures. |
| `distill.tools` | `["bash"]` | Which tools are distilled. Adding `read` or `grep` is allowed; it is off by default because tersely structured output loses more than it saves. |
| `distill.requireNoise` | `true` | Only cut an output that has a failure, summary or safety line, or real noise. A clean listing is kept up to 8× the budget. |
| `readDedupe.enabled`, `escapeHatch` | true, true | Dedupe switch, and whether the next identical read is served in full so content can never be stranded. |
| `loopBreaker.enabled`, `threshold` | true, 3 | Loop breaker switch and repeat count (at least 2). |
| `loopBreaker.progressTools` | `edit`, `write`, `multiedit`, `apply_patch`, … | Tools whose success clears every loop streak. Mutating shell commands (`sed -i`, `git commit`, `npm install`, redirects) also clear them. |
| `ledger.path` | `.greenharness/ledger.jsonl` | Where the JSONL ledger goes, relative to the session workspace. `{session}` is substituted. Empty disables the ledger. |
| `ledger.perSession`, `maxBytes`, `outputsKeep` | true, 4 MiB, 50 | One file per session, rotation size at which `.1` is kept, and how many spilled outputs to retain. |
| `ledger.pricing` | none | Optional per-provider prices in dollars per million tokens. |

The routes themselves (provider URL, model ids, thinking switch) live in the patch overlay. `bench/presets/` shows the format.

## Develop and benchmark

Everything below is for working on the plugin or running the benchmark; ordinary use needs only the quick install above.

Requirements: Node.js 22.19 or newer (the highest minimum any DSH package declares; the mock benchmark ran on Node 26.12) and DSH `0.2.1-rc.5`. Install DSH in its own folder with `npm install @deepseek-ai/dsh@0.2.1-rc.5`, then point `DSH_BIN` at its `node_modules/.bin/dsh`.

1. `npm install` in this folder. It installs the plugin's one runtime dependency, `@deepseek-ai/schemastery`. Run it first: without it the plugin does not load.
2. Unit and integration tests: `npm test` (134 tests).
3. Mock suite (every scenario under every arm, about 35 seconds): `npm run bench:mock` or `DSH_BIN=<dsh> node bench/run-mock-suite.mjs`
4. Side-by-side prompt benchmark: `npm run bench:compare -- "build-horse"` or `node bench/compare.mjs "<prompt>"`
5. One case: `DSH_BIN=<dsh> node bench/run-case.mjs --task subtract-bug --arm greenharness --scenario subtract-fix --out runs/one`
6. Live NeMo models on Brev: [`BREV-SETUP.md`](BREV-SETUP.md).

Each case copies the task to a fresh workspace and starts a fresh DSH home. The verdict comes from re-running `node --test` in the workspace, not from the agent's claim. Each case writes `summary.json`, `ledger.jsonl`, `patch.yml`, `stdout.txt`, `stderr.txt` and the workspace. If something went wrong (DSH did not start or exited with an error, or GreenHarness recorded no model calls), `summary.json` lists it under `problems`, the reason goes to stderr, and the command exits with code 1.

## Metrics

- **Model calls per tier**: `ledger.tiers`, `ledger.models`.
- **Prompt tokens**: `inputTokens` (uncached) plus `cacheReadTokens` plus `cacheWriteTokens`. Output tokens are reported separately.
- **Tool output**: `rawChars` against `outChars` on each `tool` record. Distillation and dedupe show up here.
- **Verdict**: the independent suite re-run (`suite.pass`, `suite.fail`).
- **Cost**: tokens times the configured price, or GPU-hours times an hourly rate. Not automated for self-hosted GPUs.

## Results so far (mock, plumbing only)

These come from `bench/run-mock-suite.mjs` on DSH 0.2.1-rc.5. The mock replays a fixed script, so these numbers show what the plugin changes in the prompt. They say nothing about a real model's pass rate. Token counts are characters divided by four, over the message history only. Token estimates shift by a few percent between installs and folder layouts, so compare the rows, tier splits and pass/fail results rather than the last digit.

| scenario | arm | agent calls | served by | prompt tokens (est.) | cached (est.) | suite | distilled | deduped | route changes | loop denied | triage | errors |
|---|---|---:|---|---:|---:|---|---:|---:|---|---|---|---:|
| build-horse | greenharness | 4 | 0 small / 4 large | 5709 | 2761 | 301 pass / 1 fail | 1 | 0 | 1 | no | large (0.9) | 0 |
| build-horse | always-large | 4 | 0 small / 4 large | 8090 | 2763 | 301 pass / 1 fail | 0 | 0 | 0 | no | — | 0 |
| build-horse | always-small | 4 | 4 small / 0 large | 8081 | 2761 | 301 pass / 1 fail | 0 | 0 | 0 | no | — | 0 |
| loop-stuck | greenharness | 6 | 2 small / 4 large | 11755 | 5612 | 301 pass / 1 fail | 3 | 0 | 4 | yes | large (0.9) | 0 |
| loop-stuck | always-large | 6 | 0 small / 6 large | 48000 | 31938 | 301 pass / 1 fail | 0 | 0 | 0 | no | — | 0 |
| loop-stuck | always-small | 6 | 6 small / 0 large | 48018 | 31953 | 301 pass / 1 fail | 0 | 0 | 0 | no | — | 0 |
| subtract-fix | greenharness | 7 | 1 small / 6 large | 12557 | 6877 | 302 pass / 0 fail | 3 | 1 | 2 | no | large (0.9) | 0 |
| subtract-fix | always-large | 7 | 0 small / 7 large | 33700 | 23252 | 302 pass / 0 fail | 0 | 0 | 0 | no | — | 0 |
| subtract-fix | always-small | 7 | 7 small / 0 large | 33702 | 23248 | 302 pass / 0 fail | 0 | 0 | 0 | no | — | 0 |

In the subtract scenario, GreenHarness sent about 2.7 times fewer estimated prompt tokens than either single-model arm. In the loop scenario, it denied the repeats after three identical failures — and used about a quarter of the tokens of the single-model arms. In the build scenario, triage immediately routed the greenfield work to the strong model. The `always-*` arms have no verifier and no loop breaker, so they always run the same script to the end.

The loop-guard row is also the clearest demonstration of escalation cost: 4 route changes across 6 calls means most calls ran on the large tier. That is the trade-off `escalateAfterFailures` and `cascade.minStepsPerTier` exist to tune.

## Limitations

- **Escalation on the first failure.** A failing task spends most of its calls on the large tier. Savings come from passing runs staying small and from smaller tool output on every tier. A task that never passes keeps escalating.
- **Cold caches after a switch.** The first call on a tier after a switch pays a full prefill, because that model's prefix cache is cold. The mock models caches per model, but real servers will differ.
- **Side request.** Every run has one tools-free request, sent right after the first agent call. The mock logs it as a side call. The ledger does not record it, so its tokens are missing from the ledger totals. Whether GreenHarness routes it has not been checked.
- **Distillation can hide a line the model needed.** The full output is one retrieval away, but the model has to ask for it. It deliberately does not distill a clean listing, because cutting the middle of a file list costs more than it saves.
- **Read dedupe is shallow.** It keys on a path plus line range and a content digest, and it forgets on edit and compaction. It does not know that DSH pruned just one old tool result.
- **`run_code` / PTC mode is not covered.** In a tools registry with `mode: "ptc"`, sub-dispatches do not pass through `tools/pre-execute` / `tools/post-execute`, so distillation, dedupe and the loop breaker do not see them. Routing still works.
- **Notice filtering depends on listener order.** DSH's own notice listener and this plugin both register with `prepend`; the plugin has to be the outer one. This holds on rc.5 and is visible as `notice-stripped` records, but it is not an API guarantee.
- **Developer preview.** DSH 0.2.1-rc.5 is pre-release. The hook names above come from its typings in this version and may change.

## Compared with NeMo Switchyard

As its README describes it, Switchyard is a routing proxy on port 4000. It decides per request and per step with a classifier, and it escalates with an LLM judge.

GreenHarness differs in four ways:

- **Verifier, not judge.** It sits inside the agent and reads the result of the test or compiler run, so escalation costs no extra model call.
- **Compress once.** Distillation and dedupe act on tool results when they are written. A proxy sees the whole request on every call, so it would have to rewrite history it already sent, which breaks the prompt cache prefix.
- **Session state.** The loop breaker keys on command fingerprints and resets on file changes. A stateless proxy does not hold that state.
- **Host-bound.** It runs only inside DSH. Switchyard works with any client that speaks the API.

## Files

- `GETTING-STARTED.md`: step by step, for someone new to terminals and agents.
- `CHANGELOG.md`: what changed, release by release.
- `ROADMAP.md`: where this is going, and which ideas were rejected.
- `src/index.mjs`: the Cordis plugin. Config schema, hook wiring, error reporting.
- `src/control.mjs`: the `/greenharness` command (parsing, replies, doctor, benchmark gate).
- `src/runtime.mjs`: triage, cascade, distillation, dedupe, loop breaker and ledger records. No DSH imports.
- `src/core/`: pure logic (`triage`, `cascade`, `verify`, `distill`, `patterns`, `read-index`, `loop-guard`, `route`, `ledger`, `pricing`).
- `src/config.mjs`: settings normalization and validation.
- `test/`: 134 tests: unit tests per mechanism, config, control, ledger, and a fake-context integration test.
- `bench/compare.mjs`: dual-arm prompt benchmark runner (`always-large` vs `greenharness`).
- `bench/run-case.mjs`: one case (task, arm, preset) through DSH headless, with the independent re-run and `summary.json`.
- `bench/run-mock-suite.mjs`: every scenario under every arm, as one table.
- `bench/mock-openai-server.mjs`: scripted OpenAI-compatible server. It logs what each request contained.
- `bench/presets/`: `mock`, `mock-chat-template`, `nemo-brev`.
- `bench/scenarios/`: scripts for the mock (`build-horse`, `loop-stuck`, `subtract-fix`). `bench/tasks/`: fixtures (`horse-3d`, `subtract-bug`).
- `BREV-SETUP.md`: live runbook for NeMo models on Brev.

## License

MIT
