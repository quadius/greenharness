# Running GreenHarness on NVIDIA Brev (Lightning 30B and the 120B Super)

Plain-language setup. Anything marked **unverified** I could not test; check it before you rely on it.

## What you are setting up
- **Small (cheap) model:** Nemotron 3.5 **Lightning 30B-A3B** on one H100 80 GB (port 8000).
- **Large (strong) model:** Nemotron 3.5 **Super VL 120B-A12B**, NVFP4 build, on one **H200** (port 8002).
- GreenHarness sends easy steps to the small model and hard steps to the large one.
- Each model runs on **its own machine**. Do not start two servers on one GPU.

## Step 1: start the machines
1. Create the instances at brev.nvidia.com: an H100 for Lightning, an H200 for Super.
2. Open a terminal on each (the Brev page's shell button, or `brev shell <instance-name>`).
3. vLLM must be new enough. Lightning needs **0.27.1 or newer**. The Super recipe was written for **0.31.0**; if Super says the model architecture is not supported, upgrade with `uv pip install -U vllm`.

## Step 2: serve Lightning 30B on the H100 (port 8000)
This one is confirmed working for you.
```
vllm serve nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16 \
  --max-num-seqs 256 --max-num-batched-tokens 32768 --enable-prefix-caching \
  --async-scheduling --mamba-backend flashinfer --moe-backend humming \
  --linear-backend humming --mamba-ssu-algorithm horizontal --mamba-cache-mode align \
  --mamba-ssm-cache-dtype float16 --enable-mamba-cache-stochastic-rounding \
  --mamba-cache-philox-rounds 5 --reasoning-parser nemotron_v3 \
  --tool-call-parser qwen3_coder --enable-auto-tool-choice \
  --host 0.0.0.0 --port 8000
```
Optional: add `--max-model-len 65536` to use less GPU memory than the default 262144.

## Step 3: serve Super 3.5 VL 120B on the H200 (port 8002)
```
vllm serve nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4 \
  --trust-remote-code --tensor-parallel-size 1 \
  --max-model-len 65536 --gpu-memory-utilization 0.90 --max-num-seqs 64 \
  --enable-auto-tool-choice --tool-call-parser qwen3_coder --reasoning-parser nemotron_v3 \
  --host 0.0.0.0 --port 8002
```
Why these flags:
- The vLLM recipe lists this model for **1x H200 with NVFP4 and tensor-parallel 1**. The weights are about 91 GB, so they fit in 141 GB.
- **Do not add `--no-enable-chunked-prefill`.** An older guide said to, but with the Mamba cache mode these models use, vLLM then fails with "Chunked prefill is required for mamba cache mode 'align'". Leaving it out uses the default, which is correct.
- The recipe's longest context for this setup is 114,688. Start at 65536; raise `--max-model-len` toward 114688 once it runs. If it runs out of memory, lower it to 32768.
- The recipe also shows speculative decoding (`--speculative_config.method mtp`). It is optional; leave it off until the basic server works.

These flags are assembled from the recipe page, and I have not run them on an H200. If Super fails, send me the lines above the traceback.

## Step 4: reach the servers from your laptop
Run these on your laptop, one per server (check `brev port-forward --help` for exact syntax):
```
brev port-forward <instance-name> --port 8000:8000
brev port-forward <instance-name> --port 8002:8002
```
Test: open `http://127.0.0.1:8000/v1/models` in a browser. It should list the model.

## Step 5: connect to DSH
**Easiest, using the demo preset:** `bench/presets/nemo-brev-super.json` (Lightning small, Super 3.5 VL large) or `bench/presets/nemo-brev.json` (Lightning only). They define both servers and both tiers for the benchmark scripts.

**In the DSH chat:** add the provider in **Settings > Models** with the address `http://127.0.0.1:8000/v1`, an API key of any text (local vLLM does not check it), and the model id above. The exact form labels may differ. Then in the chat:
```
/greenharness models
/greenharness small <number of Lightning>
/greenharness large <number of Super>
```

## The "content limit reached, type continue" message
This is the model being cut off. For thinking models, **thinking tokens count toward the output limit**, so a model can spend its whole allowance thinking and stop mid-answer. The plugin does not create this message. To avoid it:
- The two NeMo presets now set `maxTokens` to 32768 (Lightning) and 16384 (Super). Raise them if you still see it.
- Use thinking **off** for the small tier. The presets already do.
- Do not set `--max-model-len` lower than your longest prompt plus the output limit.

## Check it is working
1. Run the toggle test in `bench/BREV.md` (step 4) to confirm the thinking switch does something on your server.
2. Send a task in DSH, then type `/greenharness last`. It shows which model served the prompt and a bar for the cheap model's share.

## Cost
Rent only while you demo, and **stop the instance afterwards**. A multi-GPU instance for the 120B costs far more per hour than one H100.
