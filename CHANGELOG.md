# Changelog

All notable changes to GreenHarness. The plugin targets DeepSeek Harness (dsh) `0.2.1-rc.5`.

## 0.2.0 — 2026-11-01

The "make the mechanisms defensible" release: the five features still do what 0.1.x said, but the
cases where they could trap a model, lose data, or silently do nothing are fixed, and the docs now
match the code.

### Fixed

- **Model-assisted triage works.** `triage.mode: "model"` now calls `llm.stream()`, the only
  generation entry point in DSH 0.2.x. The old code probed `llm.generate` / `llm.complete`, which
  do not exist, so the mode always fell back to the heuristic and logged a `triage-skip` record.
- **Triage is deterministic.** A `/g` regular expression was used with `.test()`, so `lastIndex`
  leaked between prompts and the same request could score differently on a later call.
- **Read dedupe cannot strand content.** A repeated read is short-circuited at most once in a row;
  the next identical read is served in full, and the pointer now says so. Off with
  `readDedupe.escapeHatch: false`.
- **The loop breaker is not fooled by fixes made outside `edit`/`write`.** Successful writer tools
  (`apply_patch`, `multiedit`, …) and mutating shell commands (`sed -i`, `git commit`, `npm install`,
  redirects, …) clear streaks, so a command that could pass now is no longer denied.
- **The ledger no longer sits on the agent's critical path or in the server's launch directory.**
  Records are buffered and flushed off the hot path; files are per session and resolved against the
  session's workspace; they rotate at `ledger.maxBytes`; oversized records become a marker; every
  write path is guarded.
- **Spilled output is inside the workspace and bounded.** Full tool output is written to
  `<session cwd>/.greenharness/outputs/` (a path the model's read tool can open) and pruned to
  `ledger.outputsKeep` files.
- **Tier labels are honest after a model change.** A call is labelled by the tier that produced it,
  not by whatever the large tier is configured as later in the session.
- **Session state is released** on `agent/disposed`. A long-lived server no longer keeps a cascade,
  a loop guard and a read index for every session it has ever seen.
- **Hook failures stay inside the hook.** Projecting a tool call can no longer throw into the tool
  pipeline.

### Changed

- **Model-switch notices**: only notices caused by this plugin's own routing are removed. A notice
  about a model the user switched to is kept, because it is real information. Controlled by
  `routing.stripNotices: tier | all | none`.
- **Distillation needs a signal**: a failure, summary or safety line, or actual noise (progress
  frames, library frames, repeated lines). A clean listing is left alone up to 8× the budget, then
  trimmed anyway. It also only runs on `distill.tools` (default: `bash`).
- **`/greenharness benchmark` is a developer tool**: it refuses to run without
  `GREENHARNESS_BENCH=1`, explains why, and points at `npm run bench:compare`.
- **New `/greenharness doctor`**: every effective setting, the ledger file for this session, and
  the checks that explain "it is on but nothing happens".

### Added

- Config: `routing.stripNotices`, `distill.tools`, `distill.requireNoise`, `readDedupe.escapeHatch`,
  `loopBreaker.progressTools`, `ledger.perSession`, `ledger.maxBytes`, `ledger.outputsKeep`.
- `test/plugin.test.mjs`: a fake Cordis context that exercises hook wiring, routing, notice
  filtering, distillation + workspace save, loop denial, disposal, and model-assisted triage.
- `test/ledger.test.mjs`: per-session naming, buffering, rotation, truncation, pruning.
- 134 tests, up from 92.

### Removed

- `withoutModelNotices()` in favour of `stripModelNotices()` with a policy, and the
  `llm.generate` / `llm.complete` probe.

## 0.1.7

- Documentation fixes and the missing license file.

## 0.1.6

- First published build: triage, cascade, distillation, read dedupe, loop breaker, ledger,
  `/greenharness` command, mock benchmark harness.
