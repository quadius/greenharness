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
| `/greenharness benchmark on <prompt>` | Run prompt on `always-large` and `greenharness` and compare outputs & token savings |
| `/greenharness help` | List every command |

Changes last until DSH restarts.

## 5. If something looks wrong
- **No `/greenharness` command:** run the install line again, then restart `dsh web`.
- **"Not set" for the strong model:** run `/greenharness models`, then `/greenharness large <number>`.
- **"DSH has no models to list":** add your key and models in Settings > Models first.
- **Needs Node 22.19 or newer.**

## Good to know
- **Send one normal message first.** In a brand-new empty chat, DSH does not draw slash-command replies until the chat has its first message, so `/greenharness` seems to show nothing and then appears above your next message. This is how DSH displays commands, not something the plugin can change. Say "hi" first, then run the commands.
- **Shortened output is never lost.** When a long command output is shortened, the full text is saved under `.greenharness/outputs/` and the shortened version tells the AI the file path. The AI can open it with its read tool. To stop shortening altogether, type `/greenharness distill off`.

## Honest limits
The summary is text in the chat. DSH doesn't offer plugins a way to add their own panel, so there's no separate graphical dashboard. Savings numbers are estimates. The `/greenharness models` and `large` commands are tested with simulated model lists, and the plugin loads in a real `dsh web`. I could not click through a live chat without a real API key.
