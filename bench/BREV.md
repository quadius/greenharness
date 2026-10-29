# Running GreenHarness against NeMo models on Brev

This runbook is the live half of the benchmark. The mock runs in `bench/run-mock-suite.mjs` check plumbing only.

## What is verified and what is not

| Item | Status |
|---|---|
| Plugin routing, distillation, read dedupe, loop breaker | Verified against the scripted mock (`npm run bench:mock`, 47 unit tests). |
| Thinking switch sent to the server | Verified in the request body the mock received: `chat_template_kwargs.enable_thinking` is `false` on the small tier and `true` on the large tier. Whether the NeMo server honours it is **not** verified (step 4). |
| Lightning 30B-A3B serve command | Taken from the vLLM Day-0 post (2026-08-10). The post says it assumes one H100. Not run here. |
| Bolt E4B model id, serve command, thinking switch | **Not verified.** One source we read (DataLearner, dated 2026-10-19) says the model was not yet released, names no repo or serve command, and lists no thinking mode. Another note from earlier research says its thinking budget is configurable. Check the model card before you trust the small tier's numbers. |
| Prices | Not set. The ledger records tokens; cost needs prices (see step 6). |

No NeMo model was run in this session. Nothing below has been measured on NeMo.

## 1. Instance

Start a Brev instance with one H100 80 GB, or an equivalent card, for the large tier. Connect:

```bash
brev shell <instance>
```

Check the current CLI syntax with `brev --help` and `brev port-forward --help`.

## 2. Large tier (port 8000): Nemotron 3.5 Lightning 30B-A3B, BF16

Serve command, copied from the vLLM Day-0 post:

```bash
vllm serve nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16 \
  --max-num-seqs 256 \
  --max-num-batched-tokens 32768 \
  --enable-prefix-caching \
  --async-scheduling \
  --mamba-backend flashinfer \
  --moe-backend humming \
  --linear-backend humming \
  --mamba-ssu-algorithm horizontal \
  --mamba-cache-mode align \
  --mamba-ssm-cache-dtype float16 \
  --enable-mamba-cache-stochastic-rounding \
  --mamba-cache-philox-rounds 5 \
  --reasoning-parser nemotron_v3 \
  --tool-call-parser qwen3_coder \
  --enable-auto-tool-choice \
  --host 0.0.0.0 \
  --port 8000
```

Use a vLLM release from 2026-08-10 or later. The NVFP4 build (`nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4`) is smaller, but check that your card supports its kernels before you use it.

## 3. Small tier (port 8001): Nemotron 3.5 Bolt E4B

**Not verified.** Get the model id and serve command from the model card once it is published, then run it on port 8001. The preset assumes:

- model id `nvidia/NVIDIA-Nemotron-3.5-Bolt-E4B-4GB`
- an OpenAI-compatible endpoint at `http://localhost:8001/v1`

If the card gives a vLLM command, use the same pattern as step 2 with `--port 8001`. If it ships only as GGUF, serve it with llama.cpp's OpenAI-compatible server (`llama-server`) on port 8001 and check the model name it reports.

Co-hosting both on one 80 GB card is possible only if you cap each server's memory (`--gpu-memory-utilization`, for example 0.80 for the large tier and what is left for the small one). Test it; otherwise use a second instance.

## 4. Toggle test (do this before any benchmark)

The preset turns the thinking switch on or off per tier with `chat_template_kwargs.enable_thinking`. Confirm the server honours it on each endpoint: the same prompt should produce a reasoning trace only when the flag is `true`.

```bash
for flag in true false; do
  curl -s http://localhost:8000/v1/chat/completions -H 'content-type: application/json' -d "{
    \"model\": \"nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16\",
    \"messages\": [{\"role\": \"user\", \"content\": \"What is 17 times 23? Answer with the number only.\"}],
    \"chat_template_kwargs\": {\"enable_thinking\": $flag}, \"max_tokens\": 800
  }" | head -c 1500; echo; echo ---
done
```

Compare `completion_tokens` and any reasoning field in the two replies. If the flag makes no difference, the server ignores it: change the `compat` block in `bench/presets/nemo-brev.json` before you benchmark. Repeat the test on port 8001 for the small model.

## 5. Port-forward to this machine

```bash
brev port-forward <instance> --port 8000:8000
brev port-forward <instance> --port 8001:8001
```

Check that `curl http://127.0.0.1:8000/v1/models` lists the large model.

## 6. Run the three arms

Install the plugin's dependencies and DSH first (see the README), then:

```bash
export DSH_BIN=dsh            # or the path to your dsh binary
export NEMO_API_KEY=unused    # local vLLM does not check keys
node bench/run-case.mjs --task subtract-bug --arm greenharness --preset nemo-brev --out runs/brev/greenharness
node bench/run-case.mjs --task subtract-bug --arm always-large --preset nemo-brev --out runs/brev/always-large
node bench/run-case.mjs --task subtract-bug --arm always-small --preset nemo-brev --out runs/brev/always-small
```

Each run writes `summary.json`. Read these fields:

- `suite.pass` / `suite.fail`: an independent `node --test` re-run in the workspace. This is the verdict.
- `ledger.tiers` and `ledger.models`: calls per tier.
- `ledger.usage`: `inputTokens` (uncached), `cacheReadTokens`, `cacheWriteTokens`, `outputTokens`. Prompt tokens are the sum of the first three.
- `ledger.tool_actions`: how often distillation and dedupe fired.
- `ledger.route_changes`: each tier change and its reason.
- `problems`: anything that went wrong (DSH failed, or the plugin recorded no model calls). Read it first; an empty list means the run is usable.
- `wallSeconds`: whole-run wall time.

Run each arm at least three times. Model output varies between runs.

## 7. Cost

The ledger records tokens, not money. You can get money in one of two ways:

- Per-token prices: set `ledger.pricing` in the plugin config (`inputPerMTok`, `cachedInputPerMTok`, `outputPerMTok`, keyed by provider name). `costUsd` in each request record then follows.
- Self-hosted GPU time: multiply each arm's wall time by your instance's hourly rate, then compare arms. This does not split time by tier. Do that by reading the vLLM request log, which is not automated here.

Report which of the two you used. Neither price source has been checked for these models.

## Troubleshooting

- `TRANSPORT: Connection error` in `stderr.txt`: the port-forward is down, or the server is not up.
- A `greenharness:` error in `ledger.jsonl` (`"type":"error"`): the plugin caught a failure in one hook. The message says which.
- Suite fails with `not run` in the table: the summary was not written. Read `stderr.txt` in the run folder.
