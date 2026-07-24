#!/usr/bin/env python3
"""Create an AESG report PDF via the retained Word template."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


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
    args = parser.parse_args()
    if args.output.suffix.casefold() != ".pdf":
        raise ValueError("--output must end in .pdf")
    if not shutil.which("soffice"):
        raise RuntimeError("soffice is required")

    skill_root = Path(__file__).resolve().parents[2]
    docx_script = skill_root / "docx/scripts/create_aesg_docx.py"
    work_dir = args.output.parent.parent / "tmp/pdfs"
    work_dir.mkdir(parents=True, exist_ok=True)
    temp_docx = work_dir / f"{args.output.stem}.source.docx"
    run([sys.executable, str(docx_script), "--spec", str(args.spec), "--output", str(temp_docx)])

    profile = Path(tempfile.mkdtemp(prefix="lo-profile-", dir=work_dir))
    run(
        [
            "soffice",
            "--headless",
            f"-env:UserInstallation={profile.as_uri()}",
            "--convert-to",
            "pdf",
            "--outdir",
            str(work_dir),
            str(temp_docx),
        ]
    )
    converted = work_dir / f"{temp_docx.stem}.pdf"
    if not converted.is_file():
        raise RuntimeError(f"LibreOffice did not create {converted}")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(converted, args.output)
    if shutil.which("qpdf"):
        run(["qpdf", "--check", str(args.output)])
    run(["pdfinfo", str(args.output)])
    print(json.dumps({"ok": True, "output": str(args.output.resolve()), "bytes": args.output.stat().st_size}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
