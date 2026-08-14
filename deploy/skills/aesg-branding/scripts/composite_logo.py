#!/usr/bin/env python3
"""Place an approved transparent AESG PNG on an image without altering it."""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image


POSITIONS = ("top-left", "top-right", "bottom-left", "bottom-right")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Alpha-composite an exact AESG logo onto an image."
    )
    parser.add_argument("input", type=Path, help="Generated or edited source image")
    parser.add_argument("output", type=Path, help="New PNG to create")
    parser.add_argument("--logo", required=True, type=Path, help="Approved transparent PNG")
    parser.add_argument("--position", choices=POSITIONS, default="top-right")
    parser.add_argument(
        "--width-percent",
        type=float,
        default=18.0,
        help="Logo width as a percentage of the base image width (default: 18)",
    )
    parser.add_argument(
        "--clearspace-scale",
        type=float,
        default=1.0,
        help="Edge margin in rendered logo heights (default: 1.0)",
    )
    return parser.parse_args()


def fail(message: str) -> None:
    raise SystemExit(message)


def main() -> None:
    args = parse_args()
    input_path = args.input.expanduser().resolve()
    output_path = args.output.expanduser().resolve()
    logo_path = args.logo.expanduser().resolve()

    if not input_path.is_file():
        fail(f"Input image does not exist: {input_path}")
    if not logo_path.is_file():
        fail(f"Logo does not exist: {logo_path}")
    if logo_path.suffix.lower() != ".png":
        fail("The approved logo must be a transparent PNG.")
    if output_path.suffix.lower() != ".png":
        fail("Output must use the .png extension.")
    if output_path == input_path:
        fail("Refusing to overwrite the source image; choose a new output path.")
    if not 5.0 <= args.width_percent <= 40.0:
        fail("--width-percent must be between 5 and 40.")
    if not 0.5 <= args.clearspace_scale <= 3.0:
        fail("--clearspace-scale must be between 0.5 and 3.0.")

    with Image.open(input_path) as source_image, Image.open(logo_path) as logo_image:
        base = source_image.convert("RGBA")
        logo = logo_image.convert("RGBA")

        target_width = round(base.width * args.width_percent / 100.0)
        target_height = round(target_width * logo.height / logo.width)
        margin = round(target_height * args.clearspace_scale)

        if target_width + 2 * margin > base.width or target_height + 2 * margin > base.height:
            fail("The logo and required clear space do not fit the base image.")

        logo = logo.resize((target_width, target_height), Image.Resampling.LANCZOS)
        horizontal = margin if args.position.endswith("left") else base.width - margin - target_width
        vertical = margin if args.position.startswith("top") else base.height - margin - target_height

        base.alpha_composite(logo, (horizontal, vertical))
        output_path.parent.mkdir(parents=True, exist_ok=True)
        base.save(output_path, format="PNG", optimize=True)

    print(output_path)


if __name__ == "__main__":
    main()
