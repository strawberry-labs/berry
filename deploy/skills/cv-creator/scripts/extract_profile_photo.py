#!/usr/bin/env python3
"""Recover the most likely profile photograph embedded in a CV PDF or DOCX."""

from __future__ import annotations

import argparse
import base64
import tempfile
import zipfile
from io import BytesIO
from pathlib import Path

from PIL import Image

from extract_pdf_content import infer_profile_photo
from extract_pdf_with_llm import mechanical_pdf_payload


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def docx_image_pages(input_path: Path, image_output_dir: Path) -> list[dict]:
    images: list[dict] = []
    with zipfile.ZipFile(input_path) as archive:
        media = sorted(
            name for name in archive.namelist()
            if name.startswith("word/media/") and not name.endswith("/")
        )
        for index, name in enumerate(media, start=1):
            data = archive.read(name)
            try:
                with Image.open(BytesIO(data)) as image:
                    width, height = image.size
                    image_format = (image.format or "").casefold()
            except Exception:
                continue
            mime_type = Image.MIME.get(image_format.upper()) or {
                "jpg": "image/jpeg",
                "jpeg": "image/jpeg",
                "png": "image/png",
            }.get(image_format)
            if not mime_type:
                continue
            suffix = ".jpg" if image_format in {"jpg", "jpeg"} else f".{image_format}"
            extracted = image_output_dir / f"docx_{index}{suffix}"
            extracted.write_bytes(data)
            images.append({
                "page": 1,
                "name": Path(name).name,
                "width": width,
                "height": height,
                "byte_length": len(data),
                "extractable": True,
                "mime_type": mime_type,
                "file_path": str(extracted),
                "base64": base64.b64encode(data).decode("ascii"),
            })
    return [{"page": 1, "images": images}]


def write_jpeg(encoded: str, output: Path) -> tuple[int, int]:
    with Image.open(BytesIO(base64.b64decode(encoded))) as source:
        image = source.convert("RGBA")
        background = Image.new("RGB", image.size, "white")
        background.paste(image, mask=image.getchannel("A"))
        output.parent.mkdir(parents=True, exist_ok=True)
        background.save(output, format="JPEG", quality=94, optimize=True)
        return background.size


def main() -> int:
    args = parse_args()
    suffix = args.input.suffix.casefold()
    if not args.input.is_file() or suffix not in {".pdf", ".docx"}:
        raise SystemExit(f"Input must be an existing PDF or DOCX: {args.input}")
    with tempfile.TemporaryDirectory(prefix="cv-creator-photo-") as temporary:
        temporary_path = Path(temporary)
        if suffix == ".pdf":
            source, _prompt_pages = mechanical_pdf_payload(
                args.input,
                image_output_dir=temporary_path,
                embed_images=True,
            )
            pages = source["pages"]
        else:
            pages = docx_image_pages(args.input, temporary_path)
        photo = infer_profile_photo(pages)
    encoded = (photo or {}).get("base64")
    if not encoded:
        raise SystemExit(
            "No suitable embedded profile photo was found. Ask the user to attach "
            "a clear JPG or PNG headshot."
        )
    width, height = write_jpeg(encoded, args.output)
    print(
        f"Wrote {args.output} "
        f"({width}x{height}, image/jpeg)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
