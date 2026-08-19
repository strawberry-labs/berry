#!/usr/bin/env python3
"""Render PDF or Office artifacts to page PNGs in a temporary directory."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

from office_converter import assert_pdf_fonts, convert_to_pdf


def run(command: list[str]) -> None:
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode:
        raise RuntimeError(
            f"command failed ({result.returncode}): {' '.join(command)}\n"
            f"{result.stdout}\n{result.stderr}"
        )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("artifact", type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--dpi", type=int, default=120)
    parser.add_argument("--soffice")
    args = parser.parse_args()

    artifact = args.artifact.resolve()
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    if not artifact.is_file():
        raise FileNotFoundError(artifact)

    pdf = artifact
    if artifact.suffix.casefold() != ".pdf":
        pdf = convert_to_pdf(
            artifact,
            output_dir,
            soffice=args.soffice,
            profile_parent=output_dir,
        )
        assert_pdf_fonts(pdf)
    if not pdf.is_file():
        raise RuntimeError(f"PDF render intermediate was not created: {pdf}")
    if not shutil.which("pdftoppm"):
        raise RuntimeError("pdftoppm is required to render pages")

    prefix = output_dir / "page"
    run(["pdftoppm", "-png", "-r", str(args.dpi), str(pdf), str(prefix)])
    pages = sorted(str(path) for path in output_dir.glob("page-*.png"))
    if not pages:
        raise RuntimeError("no rendered page PNGs were created")
    print(json.dumps({"ok": True, "source": str(artifact), "pdf": str(pdf), "pages": pages}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
