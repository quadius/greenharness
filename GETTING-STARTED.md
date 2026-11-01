# GreenHarness: Getting Started

GreenHarness makes your DSH agent cheaper to run. It shortens huge command output, stops repeated work, and can hand easy steps to a cheap model and hard steps to a strong one. You don't have to configure anything for it to start saving.

## 1. Install (one time)

Open DSH's web page, or a terminal, and run:

```
dsh plugin --profile web add @quadiusai/dsh-greenharness
```

Then start `dsh web` as usual. That's it. GreenHarness is now on.

## 2. Add your API keys and pick your models (no files to edit)

1. In DSH web, open **Settings > Models**. Add your provider (for example NVIDIA) and paste your API key. DSH stores it.
2. In the chat box, type:

```
/greenharness models
```

You get a numbered list of every model DSH knows:

```
MODELS YOU CAN CHOOSE FROM
   1. Nemotron 3 Ultra 550B A55B   (NVIDIA, id nvidia/nemotron-3-ultra-550b-a55b)
   2. Nemotron 3 Bolt E4B          (NVIDIA, id nvidia/nemotron-3-bolt-e4b)
```

3. Pick by number:

```
/greenharness small 2       the cheap model, for easy steps
/greenharness large 1       the strong model, for hard steps
```

You can also type part of the name instead of a number, for example `/greenharness large nvidia Nemotron 3 Ultra`. Optionally add a thinking level at the end: `low`, `medium`, `high`.

If you skip the large model, GreenHarness still saves tokens. It just won't switch models.

> **Important:** the command must be the only thing you send. Type it, then press Enter. If the chat shows "Thinking..." and runs commands, DSH treated your line as a normal message, which means the plugin isn't loaded. Update to the latest version and restart `dsh web`.

## 3. See it working

Type this in the chat box any time:

```
/greenharness
```

You get a live summary like:

```
GreenHarness is ON

Tokens saved so far: about 1,240
  (long outputs shortened: 3, repeated reads replaced: 2, loops stopped: 0)
Work done by the cheap model: [██████████████░░░░░░] 70%
Model calls: 12. Switches between models: 2.
```

- **Tokens saved** is an estimate (about 4 characters per token) of text GreenHarness kept out of the model.
- **The bar** shows how much of the work the cheap model did. A fuller bar means a cheaper run.
- Type `/greenharness` again to refresh the numbers.

## 4. Handy commands

| Type this | What it does |
|---|---|
| `/greenharness` | Show the summary above |
| `/greenharness off` / `on` | Pause or resume everything |
| `/greenharness models` | List your models, numbered |
| `/greenharness large <number or name>` | Pick the strong model (turns switching on) |
| `/greenharness small <number or name>` | Pick the cheap model |
| `/greenharness tier auto` / `large` / `small` | Pin every call to one model, or return to automatic |
| `/greenharness profile cheap` / `balanced` / `quality` | Switch several settings at once |
| `/greenharness last` | See which model answered the last request, and why |
| `/greenharness routing off` | Stop switching models |
| `/greenharness distill off` | Stop shortening long output |
| `/greenharness doctor` | Show every setting in effect and anything that looks wrong |
| `/greenharness help` | List every command |

Changes last until DSH restarts. To make one permanent, put the same value in the plugin's config
(`tiers`, `distill`, `ledger`, …); see the README's configuration table.

There is also `/greenharness benchmark`, but it is a developer tool: it runs the scripted mock
comparison, takes a minute or two, and refuses to run unless DSH was started with
`GREENHARNESS_BENCH=1`. For real numbers use `npm run bench:compare` in the plugin checkout.

## 5. If something looks wrong
- **No `/greenharness` command:** run the install line again, then restart `dsh web`.
- **Something is on but nothing happens:** `/greenharness doctor`. It prints the models, the
  thresholds, the ledger file for this chat, the number of tracked sessions, and the last plugin
  error, so the cause is usually on screen.
- **"Not set" for the strong model:** run `/greenharness models`, then `/greenharness large <number>`.
- **"DSH has no models to list":** add your key and models in Settings > Models first.
- **Needs Node 22.19 or newer.**

## Good to know
- **Send one normal message first.** In a brand-new empty chat, DSH does not draw slash-command replies until the chat has its first message, so `/greenharness` seems to show nothing and then appears above your next message. This is how DSH displays commands, not something the plugin can change. Say "hi" first, then run the commands.
- **Shortened output is never lost.** When a command output is shortened, the full text is saved
  under `.greenharness/outputs/` in that chat's workspace, and the shortened version tells the AI
  the file path. The AI can open it with its read tool, and the oldest files are pruned. To stop
  shortening altogether, type `/greenharness distill off`.
- **Quiet output is left alone.** GreenHarness only shortens output that actually contains a
  failure, a summary line, or noise like progress spinners and stack frames from libraries. A long
  file listing is not cut in half, because that loses more than it saves.
- **A repeated read gives you a pointer, then the text.** If the AI reads the same lines twice in a
  row, it gets a one-line pointer the first time. Ask again (read the same range again) and it gets
  the real content back, so nothing can become unreachable.
- **The ledger lives with your project.** By default each chat writes its own
  `.greenharness/ledger-<chat-id>.jsonl` next to the files it is working on, so you can see what a
  session cost without mixing in every other chat.

## Honest limits
The summary is text in the chat; DSH's plugin API can register a client-side panel and a graph is
on the roadmap, but there is no dashboard yet. Savings numbers are estimates (about four
characters per token), and they count characters kept out of the model, not dollars charged. The
`/greenharness models` and `large` commands are tested with simulated model lists, and the plugin
loads in a real `dsh web`; the full chat round trip has not been clicked through without a live
API key. The mock benchmark measures plumbing and prompt shape, never a real model's answers.
