# GreenHarness

A DeepSeek Harness (dsh) plugin that makes multi-step agent runs cheaper. It routes each model call between a small and a large model using the outcome of the project's own tests. It shortens and deduplicates tool output before the model reads it, and it stops an agent from repeating a failing command.

Built for AEGIS 2026, problem 2 (agentic cost and efficiency), team Skyline.

New to terminals or agents? Start with [`GETTING-STARTED.md`](GETTING-STARTED.md).

## Quick install

```bash
dsh plugin --profile web add @quadiusai/dsh-greenharness
```

That is the whole setup. The package declares itself as a DSH bundle, so DSH turns it on in that profile by itself, and every setting has a default. Restart `dsh web`, then type `/greenharness` in the chat:

| Command | What it does |
|---|---|
| `/greenharness` | Status: what is on, and what it has done in this process. |
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
| `/greenharness benchmark on <prompt>` | Run prompt on both `always-large` and `greenharness` and compare outputs & token savings. |

With no setup, GreenHarness shortens long command output, replaces repeated file reads with a pointer, and blocks a repeated failing command. These need only one model. Routing between two models starts when you set a large model. Command settings last until DSH restarts; to make them permanent, put the same values in the plugin's config (`tiers`, `distill`, and so on, see Configuration).

**Status of this install path.** Checked: the package installs into a fresh web profile with the command above (from a packed tarball), DSH lists it as an active bundle, `dsh web` boots with it and no activation warning, and the command logic has unit tests. **Not checked:** typing `/greenharness` in the web chat itself, and installing from the npm registry (the package is not published yet; publish it with `npm publish --access public`).

## Status

- **Plugin:** five mechanisms wired to DSH 0.2.1-rc.2 headless. 87 unit tests pass on Node.
- **Verified end to end against a scripted mock server** (plumbing, not a model). Routing, triage, distillation, read dedupe and loop breaking all reach the model. The thinking-switch request body is correct on both tiers.
- **Not measured: any real NeMo model.** This session had no GPU and no Brev access, so no quality or cost numbers exist yet. The live runbook is [`bench/BREV.md`](bench/BREV.md).

## How it works

| Mechanism | What it does | DSH hook | Ledger record |
|---|---|---|---|
| Triage | Reads the user request once at the start of a turn and scores it. Greenfield builds seed the cascade on the large tier; mixed work gives the small model its first steps, then escalates. Heuristic by default (0 tokens, deterministic), or model-assisted via DSH's LLM service. | `agent/created` (`agent/pre-step`) | `triage`, `route` |
| Cascade | A verifier command (test runner, type checker, linter) that fails moves the next model call to the large tier. Passes twice in a row, after a minimum number of calls, move it back. No judge model is called. | `agent/request` (route), `tools/post-execute` (outcome) | `route`, `request` |
| Distillation | Bash output keeps failure, summary and safety lines plus nearby context. It drops progress frames and library stack frames, and collapses repeated lines. The full output goes to the spill store, and the model gets a pointer to it. | `tools/post-execute` | `tool` with action `distill` |
| Read dedupe | A read whose bytes match an earlier read still in context returns a pointer instead of the file again. An edit or write forgets the path, and compaction forgets everything. | `tools/post-execute` | `tool` with action `dedupe` |
| Loop breaker | A bash command that failed `threshold` times in a row with the same failure, and no file change since, is denied with a reason. The tier goes to large. | `tools/pre-execute` | `loop-break` |

### Hook facts that shaped the design

These come from DSH 0.2.1-rc.2's typings and source.

- **Routing** uses the `agent/request` waterfall. A listener that calls `await next()` receives the config DSH would use, and it returns a replacement to switch the model. DSH seeds each call from the last logged request header, so the route is applied on every call.
- **Notice removal.** DSH adds a "model changed" notice to the conversation whenever its default selection differs from the last request. Per-step routing triggers that on every large step, and the notice names the wrong model. GreenHarness removes it. Its listener is attached to each agent at `agent/created`, with `prepend`, so it runs outside DSH's own notice listener.
- **No `agent.model.select()`.** An earlier build called it. The call threw, the error was swallowed, and the unit tests passed only because they used a fake. Plugin failures are now written to the ledger as `error` records.

## Configuration

Settings are validated when the plugin loads. A missing tier, a bad integer or an invalid regex fails loudly.

| Key | Default | Meaning |
|---|---|---|
| `tiers.small`, `tiers.large` | required | `provider`, `model`, and `reasoningEffort` (empty means the provider default). |
| `routing.pinned` | `""` | Tier lock: `""` (auto), `"small"`, or `"large"`. |
| `profile` | `"balanced"` | Preset bundle: `"cheap"`, `"balanced"`, or `"quality"`. |
| `verbose` | `true` | Annotate distilled output with next tier. |
| `cascade.escalateAfterFailures` | 1 | Consecutive verifier failures before moving to large. |
| `cascade.deescalateAfterPasses` | 2 | Consecutive verifier passes before moving back to small. |
| `cascade.minStepsPerTier` | 2 | Minimum model calls in a tier before it can change. |
| `verifier.patterns` | test runners, type checkers, linters | Regexes that mark a bash command as a verifier. |
| `triage.enabled`, `mode` | `true`, `"heuristic"` | Triage switch and classification engine (`"heuristic"` or `"model"`). |
| `triage.largeAt`, `mixedAt` | `0.6`, `0.35` | Score thresholds for large and mixed verdicts. |
| `triage.mixedAfterSteps` | 2 | Steps before a mixed turn escalates to the large model. |
| `triage.maxChars` | 2000 | Character limit considered when scoring a prompt. |
| `distill.enabled`, `maxChars`, `contextLines` | true, 6000, 2 | Distillation switch, output budget (at least 500), and context lines around failures. |
| `readDedupe.enabled` | true | Read dedupe switch. |
| `loopBreaker.enabled`, `threshold` | true, 3 | Loop breaker switch and repeat count (at least 2). |
| `ledger.path`, `ledger.pricing` | `.greenharness/ledger.jsonl`, none | Where the JSONL ledger goes, and optional per-provider prices in dollars per million tokens. |

The routes themselves (provider URL, model ids, thinking switch) live in the patch overlay. `bench/presets/` shows the format.

## Develop and benchmark

Everything below is for working on the plugin or running the benchmark; ordinary use needs only the quick install above.

Requirements: Node.js 22.19 or newer (the highest minimum any DSH package declares; the mock benchmark ran on Node 24.22) and DSH `0.2.1-rc.2`. Install DSH in its own folder with `npm install @deepseek-ai/dsh@0.2.1-rc.2` (about two minutes here), then point `DSH_BIN` at its `node_modules/.bin/dsh`.

1. `npm install` in this folder. It also installs the plugin's peer dependencies at the versions DSH uses. Run it first: without it the plugin does not load.
2. Unit tests: `npm test` (87 tests).
3. Mock suite (every scenario under every arm, about 35 seconds): `npm run bench:mock` or `DSH_BIN=<dsh> node bench/run-mock-suite.mjs`
4. Side-by-side prompt benchmark: `npm run bench:compare -- "build-horse"` or `node bench/compare.mjs "<prompt>"`
5. One case: `DSH_BIN=<dsh> node bench/run-case.mjs --task subtract-bug --arm greenharness --scenario subtract-fix --out runs/one`
6. Live NeMo models on Brev: [`bench/BREV.md`](bench/BREV.md).

Each case copies the task to a fresh workspace and starts a fresh DSH home. The verdict comes from re-running `node --test` in the workspace, not from the agent's claim. Each case writes `summary.json`, `ledger.jsonl`, `patch.yml`, `stdout.txt`, `stderr.txt` and the workspace. If something went wrong (DSH did not start or exited with an error, or GreenHarness recorded no model calls), `summary.json` lists it under `problems`, the reason goes to stderr, and the command exits with code 1.

## Metrics

- **Model calls per tier**: `ledger.tiers`, `ledger.models`.
- **Prompt tokens**: `inputTokens` (uncached) plus `cacheReadTokens` plus `cacheWriteTokens`. Output tokens are reported separately.
- **Tool output**: `rawChars` against `outChars` on each `tool` record. Distillation and dedupe show up here.
- **Verdict**: the independent suite re-run (`suite.pass`, `suite.fail`).
- **Cost**: tokens times the configured price, or GPU-hours times an hourly rate. Not automated for self-hosted GPUs.

## Results so far (mock, plumbing only)

These come from `bench/run-mock-suite.mjs`. The mock replays a fixed script, so these numbers show what the plugin changes in the prompt. They say nothing about a real model's pass rate. Token counts are characters divided by four, over the message history only. Token estimates shift by a few percent between installs and folder layouts, so compare the rows, tier splits and pass/fail results rather than the last digit.


| scenario | arm | agent calls | served by | prompt tokens (est.) | cached (est.) | suite | distilled | deduped | route changes | loop denied | triage | errors |
|---|---|---:|---|---:|---:|---|---:|---:|---:|---|---|---:|
| build-horse | greenharness | 4 | 0 small / 4 large | 5665 | 2772 | 301 pass / 1 fail | 1 | 0 | 1 | no | large (0.9) | 0 |
| build-horse | always-large | 4 | 0 small / 4 large | 8108 | 2775 | 301 pass / 1 fail | 0 | 0 | 0 | no | — | 0 |
| build-horse | always-small | 4 | 4 small / 0 large | 8106 | 2772 | 301 pass / 1 fail | 0 | 0 | 0 | no | — | 0 |
| loop-stuck | greenharness | 6 | 0 small / 6 large | 10995 | 7408 | 301 pass / 1 fail | 3 | 0 | 1 | yes | large (0.9) | 0 |
| loop-stuck | always-large | 6 | 0 small / 6 large | 48026 | 31959 | 301 pass / 1 fail | 0 | 0 | 0 | no | — | 0 |
| loop-stuck | always-small | 6 | 6 small / 0 large | 48009 | 31948 | 301 pass / 1 fail | 0 | 0 | 0 | no | — | 0 |
| subtract-fix | greenharness | 7 | 1 small / 6 large | 11968 | 6612 | 302 pass / 0 fail | 3 | 1 | 2 | no | large (0.9) | 0 |
| subtract-fix | always-large | 7 | 0 small / 7 large | 33742 | 23285 | 302 pass / 0 fail | 0 | 0 | 0 | no | — | 0 |
| subtract-fix | always-small | 7 | 7 small / 0 large | 33735 | 23286 | 302 pass / 0 fail | 0 | 0 | 0 | no | — | 0 |


In the subtract scenario, GreenHarness sent almost 3 times fewer estimated prompt tokens than either single-model arm. In the loop scenario, it denied the repeats after three identical failures. In the build scenario, triage immediately routed the greenfield work to the strong model. The `always-*` arms have no verifier and no loop breaker, so they always run the same script to the end.

## Limitations

- **No real model yet.** Routing and the thinking switch are verified against the mock only. The thinking switch's wire format is confirmed; whether the NeMo server honours it is not (see the toggle test in `bench/BREV.md`).
- **Escalation on the first failure.** A failing task spends most of its calls on the large tier. Savings come from passing runs staying small and from smaller tool output on every tier. `escalateAfterFailures` and `minStepsPerTier` are the first knobs to tune.
- **Cold caches after a switch.** The first call on a tier after a switch pays a full prefill, because that model's prefix cache is cold. The mock models caches per model, but real servers will differ.
- **Side request.** Every run has one tools-free request, sent right after the first agent call. The mock logs it as a side call. The ledger does not record it, so its tokens are missing from the ledger totals. It ran on the default route, before the first escalation in every run. Whether GreenHarness routes it has not been checked.
- **Distillation can hide a line the model needed.** The full output is one retrieval away, but the model has to ask for it.
- **Developer preview.** DSH 0.2.1-rc.2 is pre-release. The hook names above come from its typings in this version and may change.
- **Bolt E4B is unverified.** Its model id, serve command and thinking switch are not confirmed (see `bench/BREV.md`).

## Compared with NeMo Switchyard

As its README describes it, Switchyard is a routing proxy on port 4000. It decides per request and per step with a classifier, and it escalates with an LLM judge.

GreenHarness differs in four ways:

- **Verifier, not judge.** It sits inside the agent and reads the result of the test or compiler run, so escalation costs no extra model call.
- **Compress once.** Distillation and dedupe act on tool results when they are written. A proxy sees the whole request on every call, so it would have to rewrite history it already sent, which breaks the prompt cache prefix.
- **Session state.** The loop breaker keys on command fingerprints and resets on file changes. A stateless proxy does not hold that state.
- **Host-bound.** It runs only inside DSH. Switchyard works with any client that speaks the API.

## Files

- `GETTING-STARTED.md`: step by step, for someone new to terminals and agents.
- `src/index.mjs`: the Cordis plugin. Config schema, hook wiring, error reporting.
- `src/control.mjs`: the `/greenharness` command (parsing and replies).
- `src/runtime.mjs`: triage, cascade, distillation, dedupe, loop breaker and ledger records. No DSH imports.
- `src/core/`: pure logic (`triage`, `cascade`, `verify`, `distill`, `patterns`, `read-index`, `loop-guard`, `route`, `ledger`, `pricing`).
- `src/config.mjs`: settings normalization and validation.
- `test/`: 87 unit tests across all mechanisms, config, control, and runtime.
- `bench/compare.mjs`: dual-arm prompt benchmark runner (`always-large` vs `greenharness`).
- `bench/run-case.mjs`: one case (task, arm, preset) through DSH headless, with the independent re-run and `summary.json`.
- `bench/run-mock-suite.mjs`: every scenario under every arm, as one table.
- `bench/mock-openai-server.mjs`: scripted OpenAI-compatible server. It logs what each request contained.
- `bench/presets/`: `mock`, `mock-chat-template`, `nemo-brev`.
- `bench/scenarios/`: scripts for the mock (`build-horse`, `loop-stuck`, `subtract-fix`). `bench/tasks/`: fixtures (`horse-3d`, `subtract-bug`).
- `bench/BREV.md`: live runbook, with what is verified and what is not.

## License

MIT 
