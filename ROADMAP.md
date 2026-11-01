# GreenHarness roadmap

Where this goes after 0.2.0. Ordered by value per unit of risk, not by ambition. Every item names
the metric that would prove it worked, because the honest problem with an efficiency plugin is
that it is easy to feel faster and never check.

## How to judge any change here

A change is only worth merging if it improves at least one of these on a **real** model, with the
mock suite used only as a plumbing smoke test:

1. **Cost per solved task**, not tokens per call. Tokens saved on a failed run are waste.
2. **Pass rate parity**: GreenHarness must not solve fewer tasks than always-large.
3. **Tier split**: how much of the work the cheap model actually did, measured per turn.
4. **Escalation latency**: model calls spent on a failing tier before it escalates.
5. **Overhead**: wall-clock added per tool call (today: one regex pass and a buffered append).

The benchmark harness already produces 1–3; 4 and 5 need instrumentation (see 0.3).

## 0.3 — close the holes that would bite a real user

- **`run_code` / PTC coverage.** Sub-dispatches bypass `tools/pre-execute` and `tools/post-execute`.
  Investigate `tools/ptc-dispatch-log` and the sub-dispatch path; either hook it or make the
  limitation explicit at startup (`doctor` should say "PTC mode: mechanisms inactive"). *Measure:
  distilled/denied counts in PTC mode, currently zero.*
- **Durable session state.** The cascade tier, loop streaks and read index die with the process.
  Write a small state file per session (or reuse a DSH store) so a restart or a resume does not
  re-escalate from scratch. *Measure: after restart, calls before the first useful escalation.*
- **Budget guard.** `ledger.budgetUsd` per session and per day: warn in `doctor`, then (opt-in)
  pin to the cheap tier or deny the next call with an explanation. *Measure: spend over the cap,
  which today is unbounded.*
- **Redaction in distilled output.** `SAFETY_RE` deliberately keeps credential-looking lines. That
  is right for a human, wrong for a context window: redact `sk-…`, `xoxb-…`, `ghp_…`, PEM blocks
  and `.env` assignments in place, and record `redactedCount` in the ledger. *Measure: a canary
  secret in bash output never appears in the request log.*
- **A real retrieval handle.** The pointer tells the model to re-read a file path; give it a stable
  id instead (`gh://out/<id>`), resolved by the plugin, so a moved or pruned file cannot dangling.
  *Measure: pointer-resolution failures in the ledger.*
- **Windows and PowerShell.** Verifier patterns and mutating-command detection are POSIX-shaped.
  DSH ships a Windows preset; at minimum do not misclassify `npm test` there. *Measure: patterns
  suite across platforms.*

## 0.4 — make routing smarter than "tests failed"

- **Structured verifier parsing.** Read TAP, JUnit XML, `node --test` summary and `tsc --pretty` so
  the cascade reacts to the *delta* (new failure, fixed failure, tests that never ran) instead of
  the exit code. *Measure: calls spent on a red→green sequence, currently 6–7.*
- **Cost-aware escalation.** Escalate only when the expected cost of staying small (more steps at
  a low rate) exceeds the expected cost of escalating (one cold-prefill large call). Needs a
  per-tier token profile from the ledger, which 0.2.0 now records per session. *Measure: cost per
  solved task against a fixed escalation policy.*
- **Adaptive cascade.** A UCB/epsilon-greedy bandit over (task class, tier) with the ledger as the
  reward, replacing the fixed `escalateAfterFailures` / `deescalateAfterPasses` constants. Keep a
  hard floor: never learn your way into an expensive default.
- **Triage v2.** Score with the ledger's own history ("this repo's prompts of this shape needed
  the large model 80% of the time"), a repo fingerprint (test count, language mix), and a token
  budget for the turn. Still no second model call by default.
- **Model-aware effort.** `reasoningEffort` is already per tier. Add a mid-run bump: escalate
  effort, not model, when the small tier is *almost* passing. *Measure: solved tasks at fixed cost.*

## 0.5 — make it visible

- **Client half (Web UI).** A small panel in the chat: live tier, tokens saved this turn, the last
  route decision with its reason, and a sparkline from the session ledger. This is the single
  highest-visibility change and the lowest-risk one; it is mostly a Slot registration on top of
  data the plugin already records.
- **Settings page instead of slash commands.** Tiers and thresholds belong in DSH's settings
  surface, with the slash commands kept for quick actions. *Measure: settings survive restart and
  are discoverable without reading the README.*
- **Weekly report.** `/greenharness report 7d` over the per-session ledgers: calls, tier split,
  saved characters, cost, and the three most expensive turns. This is the feature that makes the
  plugin worth keeping installed.

## 1.0 — the claim, measured

- **Real-model benchmark.** NeMo on Brev (or any hosted pair) on SWE-bench-lite-style tasks, three
  seeds, reporting cost per solved task and pass-rate parity against `always-large` and
  `always-small`. Publish the numbers even if they are unflattering; a plugin like this is only
  credible with a null result on the table.
- **Ablation table.** Each of the five mechanisms off, one at a time, so the contribution of
  routing vs distillation vs loop breaking is visible. The mock suite already has the arm
  machinery for this.
- **Differential scheduling.** Route at the *tool* level too: a cheap model for the "read the file
  and find the function" step, the large one for the edit. Today the granularity is one model call
  per step.

## Ideas considered and rejected

- **An LLM judge for escalation.** It costs a model call per decision, defeats the point, and is
  exactly what Switchyard already does.
- **Rewriting history in a proxy.** It breaks the provider's prefix cache; compression must happen
  when a result is written, not on every request.
- **Embedding-based semantic dedupe.** Needs a model, is nondeterministic, and "similar" file
  content is usually content the agent needs to see.
- **Confidence from logprobs.** Not exposed on the routes DSH targets.
- **A background daemon for analytics.** The per-session ledger already answers the questions; a
  daemon adds an install step and a privacy surface for no new information.

## Open questions worth answering before 1.0

1. Does escalation on the first failure actually pay off, or does a "two failures" threshold win
   on cost per solved task? 0.2.0 made this a one-line config change; nothing has measured it.
2. Is the side request DSH makes after the first agent call routed correctly, and does it matter?
3. Does the notice-stripping listener survive a DSH upgrade that changes listener ordering? A
   one-line runtime assertion could turn a silent regression into a ledger record.
4. How often does the small model fail in a way a verifier cannot see (a plausible but wrong
   answer with no test)? That is the failure mode this design cannot catch, and the honest scope
   limit of "verifier, not judge".
