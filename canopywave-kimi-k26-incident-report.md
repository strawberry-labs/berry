# Subject: Kimi K2.6 multimodal requests take over five minutes to first byte while MiniMax M3 completes in seconds

Hello Canopy Wave team,

We have isolated a model-specific latency problem on the Canopy Wave `moonshotai/kimi-k2.6` deployment. Large multimodal requests are accepted but remain silent for more than five minutes before the first response byte. The same request sent to `minimax/minimax-m3` through the same Canopy Wave endpoint returns promptly.

No customer prompt, customer document, production credential, BerryRouter access, or proprietary file is required to reproduce this. A fully synthetic and deterministic reproducer is included below.

## Impact

Our production model-call idle timeout is 240 seconds. Kimi K2.6 did not return response headers or a streaming event before that deadline, so the client cancelled and retried. Three identical attempts were cancelled after approximately 239.8 seconds each and the user received `Model request failed after 3 attempts`.

This was not a BerryRouter outage. Other models succeeded during the incident window, BerryRouter remained healthy, and the slow behavior is reproducible by calling Canopy Wave directly.

## Direct comparison

We sent equivalent synthetic requests directly to:

`POST https://inference.canopywave.io/v1/chat/completions`

Both requests used:

- A JSON body of 4,383,070 bytes
- Four inline base64 PNG images
- A substantial synthetic text context
- `stream: true`
- `stream_options.include_usage: true`
- `temperature: 0.6`
- `max_tokens: 512`
- The same client, network, headers and endpoint

Only the `model` value changed.

| Measurement | `moonshotai/kimi-k2.6` | `minimax/minimax-m3` |
|---|---:|---:|
| HTTP status | 200 | 200 |
| Time to first byte | 342.30 seconds | 17.09 seconds |
| Total response time | 350.16 seconds | 22.51 seconds |
| Completes within a 240-second client timeout | No | Yes |

Kimi K2.6 was approximately 20 times slower to first byte. Its first byte arrived 102.30 seconds after the production timeout had already expired.

Because MiniMax M3 processed the same request shape quickly, the evidence rules out request upload time, JSON encoding, base64 encoding, the four-image input pattern, the client network and BerryRouter as the source of the delay. The problem is specific to the Kimi K2.6 serving path on Canopy Wave.

The Kimi request eventually completed with HTTP 200, so this is not a hard context-window rejection. If the request violates an undocumented model, image or body limit, the API should return a prompt 4xx response rather than remain silent for more than five minutes.

## Self-contained reproduction

The following procedure creates synthetic document-style PNGs and two request bodies locally. It uses only the Python 3 standard library and does not download or depend on any customer data.

### 1. Generate the test requests

Save the following as `generate_canopywave_repro.py`:

```python
#!/usr/bin/env python3

import base64
import binascii
import hashlib
import json
import struct
import zlib
from pathlib import Path

TARGET_BODY_BYTES = 4_383_070
TARGET_IMAGE_BYTES = 770_000
WIDTH = 1_240
HEIGHT = 1_754
CONTEXT_PHRASE = "test data page text tool model image input request context "


def png_chunk(kind: bytes, data: bytes) -> bytes:
    crc = binascii.crc32(kind + data) & 0xFFFFFFFF
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", crc)


def synthetic_page_png(page_number: int) -> bytes:
    raw = bytearray()

    for y in range(HEIGHT):
        # PNG filter byte followed by one grayscale byte per pixel.
        raw.append(0)
        row = bytearray([255]) * WIDTH

        # Header band.
        if 85 <= y < 155:
            row[85:1_155] = bytes([224]) * 1_070

        # Document-like text lines of varying lengths.
        if 220 <= y < 1_500:
            relative = y - 220
            line_number = relative // 52
            if relative % 52 < 4:
                line_length = 700 + ((line_number * 73 + page_number * 41) % 350)
                row[105:105 + line_length] = bytes([48]) * line_length

        # A small page-specific diagram block.
        block_top = 440 + page_number * 95
        if block_top <= y < block_top + 180:
            row[790:1_105] = bytes([205]) * 315

        # Footer.
        if 1_620 <= y < 1_628:
            row[105:1_135] = bytes([170]) * 1_030

        raw.extend(row)

    signature = b"\x89PNG\r\n\x1a\n"
    ihdr = png_chunk(
        b"IHDR",
        struct.pack(">IIBBBBB", WIDTH, HEIGHT, 8, 0, 0, 0, 0),
    )
    idat = png_chunk(b"IDAT", zlib.compress(bytes(raw), level=9))
    iend = png_chunk(b"IEND", b"")

    # Add deterministic ancillary PNG metadata so the encoded image payload
    # is representative in size while the visible image remains synthetic.
    core = signature + ihdr + idat
    text_chunk_data_length = TARGET_IMAGE_BYTES - len(core) - len(iend) - 12
    keyword = b"synthetic-fixture\x00"
    if text_chunk_data_length < len(keyword):
        raise RuntimeError("Generated PNG exceeds the target image size")

    pattern = f"page-{page_number:02d}-synthetic-padding-".encode("ascii")
    padding_length = text_chunk_data_length - len(keyword)
    padding = (pattern * ((padding_length // len(pattern)) + 1))[:padding_length]
    text_chunk = png_chunk(b"tEXt", keyword + padding)

    png = core + text_chunk + iend
    if len(png) != TARGET_IMAGE_BYTES:
        raise RuntimeError(f"Expected {TARGET_IMAGE_BYTES} image bytes, got {len(png)}")
    return png


images = [synthetic_page_png(index) for index in range(1, 5)]

for index, image in enumerate(images, start=1):
    Path(f"synthetic-page-{index:02d}.png").write_bytes(image)

encoded_images = [base64.b64encode(image).decode("ascii") for image in images]


def request_object(model: str, context: str) -> dict:
    return {
        "model": model,
        "stream": True,
        "stream_options": {"include_usage": True},
        "temperature": 0.6,
        "max_tokens": 512,
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": context
                        + "\n\nInspect these four rendered document pages and briefly describe them.",
                    },
                    *[
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": "data:image/png;base64," + encoded_image
                            },
                        }
                        for encoded_image in encoded_images
                    ],
                ],
            }
        ],
    }


def encode_request(model: str, context: str) -> bytes:
    return json.dumps(
        request_object(model, context),
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")


def build_request(model: str) -> bytes:
    empty_request = encode_request(model, "")
    filler_bytes = TARGET_BODY_BYTES - len(empty_request)
    if filler_bytes < 0:
        raise RuntimeError("Images already exceed the target request-body size")

    context = (
        CONTEXT_PHRASE
        * ((filler_bytes // len(CONTEXT_PHRASE)) + 1)
    )[:filler_bytes]
    request = encode_request(model, context)

    if len(request) != TARGET_BODY_BYTES:
        raise RuntimeError(
            f"Expected {TARGET_BODY_BYTES} request bytes, got {len(request)}"
        )
    return request


requests = {
    "kimi-k26.json": build_request("moonshotai/kimi-k2.6"),
    "minimax-m3.json": build_request("minimax/minimax-m3"),
}

for filename, request in requests.items():
    Path(filename).write_bytes(request)
    print(
        f"{filename}: bytes={len(request)} "
        f"sha256={hashlib.sha256(request).hexdigest()}"
    )
```

Run it:

```bash
python3 generate_canopywave_repro.py
```

Expected output:

- Four valid synthetic PNG files
- `kimi-k26.json`
- `minimax-m3.json`
- Both JSON request bodies exactly 4,383,070 bytes

No external files or customer information are used.

### 2. Set a Canopy Wave API key

Use a Canopy Wave test key belonging to your own environment:

```bash
read -r -s -p "Canopy Wave API key: " CANOPYWAVE_API_KEY
echo
export CANOPYWAVE_API_KEY
```

### 3. Run the Kimi K2.6 request

The timeout is deliberately set to ten minutes so the client does not cancel before the delayed first byte:

```bash
curl --http1.1 \
  --silent \
  --show-error \
  --no-buffer \
  --max-time 600 \
  --dump-header kimi-k26.headers.txt \
  --output kimi-k26.response.txt \
  --write-out $'model=moonshotai/kimi-k2.6\nhttp=%{http_code}\nupload_bytes=%{size_upload}\nttfb_seconds=%{time_starttransfer}\ntotal_seconds=%{time_total}\n' \
  'https://inference.canopywave.io/v1/chat/completions' \
  -H "Authorization: Bearer ${CANOPYWAVE_API_KEY}" \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  --data-binary @kimi-k26.json
```

Record:

- `http`
- `upload_bytes`
- `ttfb_seconds`
- `total_seconds`
- The request ID or trace ID from the response headers

### 4. Run the MiniMax M3 control

```bash
curl --http1.1 \
  --silent \
  --show-error \
  --no-buffer \
  --max-time 600 \
  --dump-header minimax-m3.headers.txt \
  --output minimax-m3.response.txt \
  --write-out $'model=minimax/minimax-m3\nhttp=%{http_code}\nupload_bytes=%{size_upload}\nttfb_seconds=%{time_starttransfer}\ntotal_seconds=%{time_total}\n' \
  'https://inference.canopywave.io/v1/chat/completions' \
  -H "Authorization: Bearer ${CANOPYWAVE_API_KEY}" \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  --data-binary @minimax-m3.json
```

The two generated bodies have the same byte size, content structure, images, streaming settings and output limit. The model identifier is the only meaningful request difference.

## Requested investigation

Please compare the two requests at each stage of the Canopy Wave serving path and provide timings for:

1. Admission and queue wait
2. Request parsing and base64 image decoding
3. Image preprocessing and vision-encoder execution
4. Tokenization and multimodal prefill
5. Time until HTTP headers and the first SSE event are emitted

Please also confirm:

- The supported request-body and inline-image limits for Kimi K2.6
- Whether Kimi K2.6 has a separate queue, cold-start path or prefill configuration
- The expected time-to-first-byte SLO for a request of this size
- Whether the endpoint can emit headers or SSE keepalive events during long preprocessing
- Whether over-limit requests can be rejected promptly with a documented 4xx response

Increasing the downstream client timeout is not a sufficient primary resolution. A streaming inference endpoint that remains silent for more than five minutes causes retries, duplicate work and a failed user experience. The Kimi K2.6 endpoint should either begin streaming within a reasonable period or return a clear validation/capacity error.

Please share the root cause, the remediation plan and any temporary model-specific guidance we should apply while the issue is being fixed.
