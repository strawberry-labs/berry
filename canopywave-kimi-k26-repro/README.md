# Canopy Wave Kimi K2.6 multimodal latency reproduction

This package contains synthetic test data only. It contains no customer documents, prompts, credentials, production logs, internal request IDs, or proprietary source code.

## What this reproduces

Both requests use four inline base64 PNGs, streaming, and an exact 4,383,070-byte JSON body. The only meaningful difference is the model:

- `moonshotai/kimi-k2.6`
- `minimax/minimax-m3`

In our direct test against Canopy Wave, Kimi K2.6 took 342.30 seconds to first byte and 350.16 seconds total. MiniMax M3 took 17.09 seconds to first byte and 22.51 seconds total.

## Run

Requires Bash, cURL and Python 3. No Python packages are required.

```bash
export CANOPYWAVE_API_KEY='your-test-key'
./run-repro.sh
```

The runner saves response headers, response bodies and cURL timing output for both models in the current directory.

To rebuild the synthetic images and JSON bodies:

```bash
python3 generate_canopywave_repro.py
```
