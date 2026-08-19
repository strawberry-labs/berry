#!/usr/bin/env python3
"""Create an AESG report PDF via the retained Word template."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path


def converter_module(branding_skill_dir: Path):
    scripts_dir = branding_skill_dir / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    from office_converter import assert_pdf_fonts, convert_to_pdf

    return assert_pdf_fonts, convert_to_pdf


def run(command: list[str]) -> None:
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode:
        raise RuntimeError(
            f"command failed ({result.returncode}): {' '.join(command)}\n"
            f"{result.stdout}\n{result.stderr}"
        )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--spec", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--docx-skill-dir", required=True, type=Path)
    parser.add_argument("--branding-skill-dir", required=True, type=Path)
    parser.add_argument("--soffice")
    args = parser.parse_args()
    if args.output.suffix.casefold() != ".pdf":
        raise ValueError("--output must end in .pdf")
    assert_pdf_fonts, convert_to_pdf = converter_module(args.branding_skill_dir)

    docx_script = args.docx_skill_dir / "scripts/create_aesg_docx.py"
    work_dir = args.output.parent.parent / "tmp/pdfs"
    work_dir.mkdir(parents=True, exist_ok=True)
    temp_docx = work_dir / f"{args.output.stem}.source.docx"
    run([sys.executable, str(docx_script), "--spec", str(args.spec), "--output", str(temp_docx), "--branding-skill-dir", str(args.branding_skill_dir)])

    converted = convert_to_pdf(
        temp_docx,
        work_dir,
        soffice=args.soffice,
        profile_parent=work_dir,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(converted, args.output)
    if shutil.which("qpdf"):
        run(["qpdf", "--check", str(args.output)])
    run(["pdfinfo", str(args.output)])
    fonts = assert_pdf_fonts(args.output)
    print(json.dumps({"ok": True, "output": str(args.output.resolve()), "bytes": args.output.stat().st_size, "pdffonts": fonts}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
