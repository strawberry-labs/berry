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
