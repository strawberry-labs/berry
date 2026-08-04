#!/usr/bin/env python3
"""Recover the most likely profile photograph embedded in one CV PDF."""

from __future__ import annotations

import argparse
import base64
import tempfile
from pathlib import Path

from extract_pdf_content import infer_profile_photo
from extract_pdf_with_llm import mechanical_pdf_payload


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.input.is_file() or args.input.suffix.casefold() != ".pdf":
        raise SystemExit(f"Input must be an existing PDF: {args.input}")
    with tempfile.TemporaryDirectory(prefix="cv-creator-photo-") as temporary:
        source, _prompt_pages = mechanical_pdf_payload(
            args.input,
            image_output_dir=Path(temporary),
            embed_images=True,
        )
    photo = infer_profile_photo(source["pages"])
    encoded = (photo or {}).get("base64")
    if not encoded:
        raise SystemExit(
            "No suitable embedded profile photo was found. Ask the user to attach "
            "a clear JPG or PNG headshot."
        )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(base64.b64decode(encoded))
    print(
        f"Wrote {args.output} "
        f"({photo.get('width')}x{photo.get('height')}, {photo.get('mime_type')})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
