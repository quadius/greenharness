# Restore the old BEGINNER-GUIDE.md

`BEGINNER-GUIDE.md` was removed because `GETTING-STARTED.md` replaces it (shorter, no terminal knowledge needed).
This file lets you undo that, in 3 steps.

## What the removal changed
1. Deleted `BEGINNER-GUIDE.md`.
2. Removed `"BEGINNER-GUIDE.md"` from the `files` list in `package.json`, and added `"GETTING-STARTED.md"`.
3. In `README.md`, links to `BEGINNER-GUIDE.md` now point to `GETTING-STARTED.md`.

## How to put it back
1. Create a file named `BEGINNER-GUIDE.md` in the plugin folder. Paste in everything between the two `=====` lines below (or run the one-liner at the bottom).
2. In `package.json`, add `"BEGINNER-GUIDE.md"` to the `files` list.
3. In `README.md`, change the links from `GETTING-STARTED.md` back to `BEGINNER-GUIDE.md`.

One-liner (run in the plugin folder; extracts the block automatically):

```
awk '/^=====BEGIN=====$/{f=1;next}/^=====END=====$/{f=0}f' RESTORE-OLD-GUIDE.md > BEGINNER-GUIDE.md
```

=====BEGIN=====
# GreenHarness: a beginner's guide

This guide takes you from a zipped folder to a finished benchmark run, one step at a time. Read sections 1 and 2 once. After that, jump to the section you need.

Sections: 1 What this is · 2 Words you will see · 3 What you need · 4 Install · 5 Check it works · 6 Your first run · 7 The full mock comparison · 8 Using it on your own work · 9 NVIDIA Brev (for the bonus points) · 10 Troubleshooting · 11 What is verified · 12 Quick reference

> **Just want to use it?** Install DSH, then run `dsh plugin --profile web add @quadiusai/dsh-greenharness` and type `/greenharness` in the web chat. Nothing else is needed. The rest of this guide is for running the benchmark and the NVIDIA tests; the quick install and its limits are at the top of `README.md`.

## 1. What this is, in plain words

An AI agent works in steps. It reads a file, runs the tests, edits some code, runs the tests again, and so on. Each step sends the whole conversation to the model again. Long conversations and long test output cost tokens, and tokens cost money (or GPU time if you host the model yourself).

GreenHarness is a plugin for DSH (DeepSeek Harness, the agent program). It tries to make those steps cheaper in four ways:

1. **Cascade.** Use the small model while things go well. When a test run fails, switch to the large model. Passing tests switch it back.
2. **Distillation.** Shorten long command output before the model reads it. It keeps the error lines and drops the noise. The full output is saved, and the model can ask for it.
3. **Read dedupe.** If the model asks to read a file it already has in the conversation, and the file has not changed, it gets a short pointer instead of the whole file again.
4. **Loop breaker.** If the same failing command runs three times in a row with no file change, it is blocked, and the model is told why.

**What has and has not been measured.** The results so far come from a scripted fake model (a "mock"). They show that the plumbing works: routing, shortening, dedupe and loop breaking all reach the model. They do not show whether a real model does better or cheaper. Those numbers come from the NVIDIA runs on Brev (section 9), which you run yourself.

## 2. Words you will see

| Word | Meaning |
|---|---|
| Terminal | The window where you type commands. On a Mac, open the app called Terminal. |
| Node.js and npm | The JavaScript runtime and its package installer. Everything here needs them. |
| DSH | DeepSeek Harness. The agent program: it runs a task, calls the model, and runs tools such as shell commands. |
| Plugin | An add-on that changes how DSH behaves. GreenHarness is one. |
| Patch | A configuration file that tells DSH which models to use and which plugins to load. It is written as JSON, which DSH reads as YAML. You pass it with `--patch`. |
| Headless | DSH's one-shot mode: give it a task, it works, prints the answer, and exits. |
| Tier | A slot for a model. GreenHarness has two: `small` and `large`. |
| Verifier | The test command (here `node --test`). Whether it passes or fails decides which tier is used. |
| Ledger | A log file with one JSON record per line, describing what happened in a run. |
| Mock | A fake model server that replays a script. It costs nothing, and it is good for checking plumbing. |
| Token | A chunk of text, roughly a word or part of one. Models charge per token. |
| Prompt cache | If the start of a prompt matches the previous one, the server can reuse its work, which is cheaper. |
| Brev | NVIDIA's rental service for GPU machines. An *instance* is one rented machine. |
| Port-forward | A tunnel that makes a server on the rented machine reachable at `localhost` on your computer. |

DSH runs on your computer. Only the models run on Brev, and the port-forward connects them to DSH.

## 3. What you need

- **A terminal on macOS or Linux.** On Windows, install WSL (Ubuntu) and do every step below inside it. Native Windows has not been tested.
- **Node.js 22.19 or newer.** The tests and the mock benchmark ran on Node 24, so a 24.x release from [nodejs.org](https://nodejs.org) is the safest choice.
- **Internet access** for npm. DSH installs about 600 packages.
- **For section 9 only:** a Brev account and a GPU instance. These cost money.

Check your Node version:

```bash
node --version
```

You should see `v24.` followed by a number, or `v22.19` or higher. If you see `command not found`, install Node first.

### What is in the plugin folder

```
greenharness-dsh-plugin/
  BEGINNER-GUIDE.md      this guide
  README.md              the technical reference
  package.json           the plugin's name and scripts
  src/                   the plugin's code
  test/                  47 unit tests
  bench/                 the benchmark
    run-case.mjs          runs one case
    run-mock-suite.mjs    runs every case on the mock
    presets/              model setups (mock and NVIDIA)
    scenarios/            scripted mock behaviour
    tasks/                the sample task (subtract-bug)
    BREV.md               the NVIDIA runbook
```

## 4. Install

Run these in order. Most of the time goes to the DSH download.

### 4.1 Unzip the plugin

```bash
mkdir -p ~/greenharness
unzip ~/Downloads/greenharness-dsh-plugin.zip -d ~/greenharness
```

Change `~/Downloads/` if you saved the zip somewhere else. `unzip` prints a long list of file names; that is normal. You should now have `~/greenharness/greenharness-dsh-plugin/`. On a Mac you can also double-click the zip and move the resulting folder into `~/greenharness`.

### 4.2 Install the plugin's dependencies

```bash
cd ~/greenharness/greenharness-dsh-plugin
npm install
```

Expect a line like `added 4 packages`. This also installs the two packages the plugin depends on, so you do not need to link anything by hand.

### 4.3 Install DSH in its own folder

```bash
mkdir -p ~/greenharness/dsh
cd ~/greenharness/dsh
npm install @deepseek-ai/dsh@0.2.1-rc.2
```

This took about two minutes here and reports `added 615 packages`. The number can change slightly.

### 4.4 Tell the scripts where DSH is

```bash
export DSH_BIN="$HOME/greenharness/dsh/node_modules/.bin/dsh"
export NEMO_API_KEY=local-dev-no-auth
"$DSH_BIN" --version
```

The last line should print `0.2.1-rc.2`.

`DSH_BIN` is the path to DSH. `NEMO_API_KEY` is a placeholder: the mock does not check keys, so any text works. These `export` lines last only until you close the terminal. To keep them, add the same two lines to your shell profile (`~/.zshrc` on a Mac, `~/.bashrc` on most Linux systems) and open a new terminal.

## 5. Check that it works

```bash
cd ~/greenharness/greenharness-dsh-plugin
npm test
```

The last lines should include `pass 47` and `fail 0`.

`npm test` does not need the two dependency packages, so it can pass before step 4.2. The packages are needed when DSH loads the plugin. If a run later reports `Cannot find package '@deepseek-ai/schemastery'` in its `stderr.txt`, you skipped step 4.2: run `npm install` in the plugin folder, then run again.

## 6. Your first run (about 6 seconds, no real model)

From the plugin folder:

```bash
node bench/run-case.mjs --task subtract-bug --arm greenharness --scenario subtract-fix --out runs/one
```

What each option means:

- `--task subtract-bug`: the project to work on, found at `bench/tasks/subtract-bug`. It has one failing test.
- `--arm greenharness`: run with the plugin. The other two arms, `always-large` and `always-small`, run without the plugin and use only one model.
- `--scenario subtract-fix`: the script the mock follows. Live models do not take a scenario.
- `--out runs/one`: the folder for the results. If it already exists, it is deleted and rebuilt.

The command prints a JSON summary. These are the lines to read first:

```json
"dshExitCode": 0,
"problems": [],
"suite": { "exitCode": 0, "pass": 302, "fail": 0 },
"finalText": "Fixed subtract to return a - b. All tests pass.",
```

- `dshExitCode: 0`: DSH finished without an error.
- `problems`: empty means nothing went wrong. If it is not empty, the entries say what did.
- `suite`: the verdict. The runner runs the tests itself after the agent finishes, so the agent's own claim does not count. `pass 302, fail 0` means the bug is fixed.

Further down, `ledger` says how the run went: `model_calls: 7`, `tiers` with 2 small and 5 large calls, and `route_changes` showing the switch to large after the failing test, then back to small after it passed.

The folder `runs/one/` now contains:

- `summary.json`: the summary you just saw.
- `ledger.jsonl`: one line per event. `request` is a model call, `route` is a tier change and its reason, `tool` is what happened to a tool's output (`distill`, `dedupe` or `none`), `loop-break` is a blocked command, and `error` is a plugin failure.
- `patch.yml`: the DSH configuration this run used. You can reuse it (section 8.4).
- `workspace/`: the project after the agent worked on it.
- `stdout.txt` and `stderr.txt`: DSH's output. Read `stderr.txt` first when something fails.
- `dsh-home/`: DSH's own files for this run.
- `requests.jsonl`: what the mock server received.

## 7. The full mock comparison (about 35 seconds)

```bash
node bench/run-mock-suite.mjs
```

This runs two scenarios under all three arms and prints one table. It also saves the table to `runs/mock/SUMMARY.md`. The columns:

- **agent calls**: model calls made during the run.
- **served by**: how many calls went to the small and the large mock model.
- **prompt tokens (est.)**: the estimated size of everything sent to the model. Lower is cheaper.
- **cached (est.)**: the part of that which a prompt cache could have reused.
- **suite**: the verdict, passing and failing tests after the run.
- **distilled, deduped**: how often tool output was shortened, and how often a re-read was replaced with a pointer.
- **route changes, loop denied**: tier switches, and whether the loop breaker blocked a command.

Read the `subtract-fix` rows. The greenharness arm sends about a third of the prompt tokens of either single-model arm, and all three arms pass. That is a plumbing result. It says nothing about whether a real model would pass.

## 8. Using it on your own work

### 8.1 Change which models are used

Model setups are in `bench/presets/`. Each preset names the servers (`routes`) and the two tiers (`tiers`):

- `mock.json`: fake models, used by the mock runs.
- `mock-chat-template.json`: the mock with the thinking switch turned on, for testing that switch.
- `nemo-brev.json`: the NVIDIA models, reached at `localhost:8000` (large) and `localhost:8001` (small) through port-forwards.

To use a different server, copy `nemo-brev.json` to a new file such as `bench/presets/my-server.json`. Change each route's `baseURL` and model `id`, and change `tiers` if needed. Keep `"mock": false`. Then run with `--preset my-server` and leave out `--scenario`.

### 8.2 Change how the cascade behaves

The plugin's settings sit in the `greenharness` entry of a patch file. Section 8.4 shows how to find it. These are the settings people change most, with their defaults:

- `cascade.escalateAfterFailures` (1): failing test runs before the large model is used.
- `cascade.deescalateAfterPasses` (2): passing test runs in a row before going back to the small model.
- `cascade.minStepsPerTier` (2): calls that must happen on a tier before it can change.
- `distill.maxChars` (6000): the output budget for one shortened tool result. Minimum 500.
- `loopBreaker.threshold` (3): identical failing commands before the loop breaker blocks. Minimum 2.

The Configuration table in `README.md` lists every setting.

We tested one change against the mock. Adding `"cascade": { "escalateAfterFailures": 2 }` to the `greenharness` entry kept the run on the small model the whole way (zero route changes), and it still passed the tests. The runner does not take these settings as command-line flags yet, so you change them in the patch file.

### 8.3 Benchmark your own task

1. Make a folder `bench/tasks/my-task/`.
2. Put these in it:
   - `TASK.md`: the instruction the agent receives, in plain English.
   - Your project files.
   - Tests that `node --test` can run. They should fail until the task is done.
3. Run it with a live model preset, leaving out `--scenario`:

```bash
node bench/run-case.mjs --task my-task --arm greenharness --preset nemo-brev --out runs/my-task
```

The mock scenarios are written for the `subtract-bug` project, so they will not fit your task. The verdict is `node --test` only. A project in another language will not be judged correctly by the runner.

### 8.4 Use the plugin with DSH directly

The runner writes a patch file for each run, and you can reuse it to run DSH on any project.

1. Copy the patch from a run:

```bash
cp runs/one/patch.yml ~/my-patch.yml
```

2. Open `~/my-patch.yml` in a text editor. Find the block that starts with `"ledger": {` and change its `"path"` to a file in a folder you choose, such as `/Users/you/my-project/.greenharness/ledger.jsonl`. The copied path points into `runs/one`, so without this change every run overwrites that folder's ledger. Use an absolute path.

   The same file has a `"name"` entry, which is the absolute path of the plugin's `src/index.mjs`. If you move the plugin folder, update it there.

3. The copied patch points at the mock on port 8124. To try the recipe safely, copy the sample task and start the mock in a second terminal:

```bash
cp -r bench/tasks/subtract-bug ~/subtract-copy
node bench/mock-openai-server.mjs --script bench/scenarios/subtract-fix.json --port 8124
```

4. In the first terminal, run DSH from inside the project folder:

```bash
cd ~/subtract-copy
"$DSH_BIN" headless --patch ~/my-patch.yml "Fix the failing tests in this project. Run node --test to check your work."
```

Notes:

- DSH works in the folder you start it from, and it can change and delete files there. Try it on a copy, or commit your work first.
- DSH keeps its own state in `~/.dsh` unless you set `DSH_HOME`. The benchmark gives each run its own `DSH_HOME`.
- To use real models, edit the `providers` block in the patch: change each `baseURL` and model `id`.
- DSH also has an interactive mode, `dsh tui`, and the same `--patch` option is documented for it. The plugin has not been tested in that mode.

## 9. NVIDIA Brev (for the bonus points)

**A Brev instance bills while it runs. Stop or delete it when you finish.**

This part needs a paid GPU instance, so it cannot be run from the sandbox this was built in. The full commands are in `bench/BREV.md`. In order:

1. Create a Brev instance with one H100 80 GB, or a similar GPU. Connect with `brev shell <instance>`. Check the current CLI syntax with `brev --help`.
2. On the instance, serve Nemotron 3.5 Lightning 30B-A3B on port 8000. Use the command in `BREV.md` section 2.
3. Serve the small model, Nemotron 3.5 Bolt E4B, on port 8001. **Its model ID and serve command are not verified.** Check its model card first (`BREV.md` section 3).
4. Run the toggle test (`BREV.md` section 4) before any benchmark. It checks that the server really turns thinking on and off.
5. On your computer, forward the ports (`BREV.md` section 5):

```bash
brev port-forward <instance> --port 8000:8000
brev port-forward <instance> --port 8001:8001
```

Check that `curl http://127.0.0.1:8000/v1/models` lists the large model.

6. In the plugin folder, with `DSH_BIN` set:

```bash
export NEMO_API_KEY=unused
node bench/run-case.mjs --task subtract-bug --arm greenharness --preset nemo-brev --out runs/brev/greenharness-1
node bench/run-case.mjs --task subtract-bug --arm always-large --preset nemo-brev --out runs/brev/always-large-1
node bench/run-case.mjs --task subtract-bug --arm always-small --preset nemo-brev --out runs/brev/always-small-1
```

Run each arm at least three times. Give each run a new `--out` name (`-2`, `-3`), because reusing a name deletes that run's folder. Model output varies between runs.

7. Read each `summary.json`:
   - `problems`: must be empty.
   - `suite.pass` and `suite.fail`: the verdict.
   - `ledger.tiers`: calls on each tier.
   - `ledger.usage`: tokens. Prompt tokens are `inputTokens`, `cacheReadTokens` and `cacheWriteTokens` added together.
   - `ledger.tool_actions`: how often distillation and dedupe ran.
   - `wallSeconds`: total time.

8. **Cost.** The ledger counts tokens, not dollars. Either set per-token prices in the patch, under `ledger`, as `pricing`, keyed by provider name with `inputPerMTok`, `cachedInputPerMTok` and `outputPerMTok`. Or multiply the instance's hourly rate by the wall time. `BREV.md` section 7 has the details. Neither price source has been checked against NVIDIA's actual prices. The pricing setting itself was checked with the mock: with prices set, each call recorded a non-zero `costUsd`.

## 10. Troubleshooting

These messages are the real ones from testing. Find yours in the left column.

| You see | Usually means | What to do |
|---|---|---|
| `command not found` for `node` or `npm` | Node is missing, or not on your PATH. | Install Node (section 3), then open a new terminal. |
| `Cannot find package '@deepseek-ai/schemastery'` in a run's `stderr.txt` | `npm install` was not run in the plugin folder. | Run `npm install` in `~/greenharness/greenharness-dsh-plugin` (section 4.2). |
| `dsh: warning: 1 entry did not activate`, or `failed to import` in `stderr.txt` | The plugin did not load. | The same fix. The run also reports `GreenHarness recorded no model calls` under `problems`. |
| `spawn ... ENOENT` in `stderr.txt` | `DSH_BIN` points at nothing. | Check `"$DSH_BIN" --version` and fix the path (section 4.4). |
| `MISSING_CREDENTIAL ... NEMO_API_KEY` | You ran DSH directly without the key. | `export NEMO_API_KEY=local-dev-no-auth`. The benchmark runner sets this for you. |
| `listen EADDRINUSE: address already in use 127.0.0.1:8124` | Something else is using the mock's port. | Stop that program, or add `--port 8125` to the `run-case` command. |
| `a mock preset needs --scenario <name>` | A mock run was started without a scenario. | Add `--scenario subtract-fix`. |
| `dsh: TRANSPORT: Connection error.` (Brev) | The model server is not running, or the port-forward is down. | Check `curl http://127.0.0.1:8000/v1/models`, then restart the port-forward. |
| `problem: DSH exited with code 1` | DSH failed. | Read `stderr.txt` in the run folder. |
| `suite` shows `fail: 1` | The agent did not fix the bug. | Read `workspace/` and `stdout.txt`. The loop-stuck scenario fails by design. |

On Windows, run everything inside WSL.

## 11. What is verified and what is not

| Item | Status |
|---|---|
| Install steps 4.1–4.4 and `npm test` (47 pass) | Verified from the zip, in a clean home folder, on Node 24.22. The unit tests also pass on Node 22.23. |
| The sample run (section 6) and the mock table (section 7) | Verified. |
| Running DSH yourself with a copied patch (section 8.4), including the ledger path and cascade edits | Verified against the mock. |
| Pricing in the patch (section 9, step 8) | Verified with the mock (non-zero `costUsd`). Real prices not checked. |
| Your own task (section 8.3) | **Not run.** It uses the same runner as the sample task, with a live preset. |
| The error messages in section 10 | Verified in this sandbox. The Brev connection error was reproduced with no model server running. |
| Brev: serve commands, port-forward, toggle test | **Not verified.** No Brev access or GPU here. |
| Bolt E4B (the small model) | **Not verified.** |
| Native Windows | **Not tested.** Use WSL. |
| Quality and cost with real models | **Not measured.** |

## 12. Quick reference

```bash
# once
mkdir -p ~/greenharness && unzip ~/Downloads/greenharness-dsh-plugin.zip -d ~/greenharness
cd ~/greenharness/greenharness-dsh-plugin && npm install
mkdir -p ~/greenharness/dsh && cd ~/greenharness/dsh && npm install @deepseek-ai/dsh@0.2.1-rc.2

# every new terminal (or put these in your shell profile)
export DSH_BIN="$HOME/greenharness/dsh/node_modules/.bin/dsh"
export NEMO_API_KEY=local-dev-no-auth
cd ~/greenharness/greenharness-dsh-plugin

npm test
node bench/run-case.mjs --task subtract-bug --arm greenharness --scenario subtract-fix --out runs/one
node bench/run-mock-suite.mjs
```
=====END=====
