#!/usr/bin/env python3
"""Deterministic LibreOffice resolution and AESG PDF font checks."""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path


def resolve_soffice(explicit: str | None = None) -> str:
    candidates = [explicit, os.environ.get("AESG_SOFFICE"), shutil.which("soffice")]
    for candidate in candidates:
        if not candidate:
            continue
        resolved = shutil.which(candidate) or candidate
        path = Path(resolved)
        if path.is_file() and os.access(path, os.X_OK):
            return str(path)
    raise RuntimeError(
        "an approved soffice binary is required; set AESG_SOFFICE or pass --soffice"
    )


def convert_to_pdf(
    input_path: Path,
    output_dir: Path,
    *,
    soffice: str | None = None,
    profile_parent: Path | None = None,
) -> Path:
    binary = resolve_soffice(soffice)
    output_dir.mkdir(parents=True, exist_ok=True)
    profile_parent = profile_parent or output_dir
    profile_parent.mkdir(parents=True, exist_ok=True)
    profile = Path(tempfile.mkdtemp(prefix="lo-profile-", dir=profile_parent))
    command = [
        binary,
        "--headless",
        f"-env:UserInstallation={profile.as_uri()}",
        "--convert-to",
        "pdf",
        "--outdir",
        str(output_dir),
        str(input_path),
    ]
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode:
        raise RuntimeError(
            f"command failed ({result.returncode}): {' '.join(command)}\n"
            f"{result.stdout}\n{result.stderr}"
        )
    converted = output_dir / f"{input_path.stem}.pdf"
    if not converted.is_file():
        raise RuntimeError(f"LibreOffice did not create {converted}")
    return converted


def assert_pdf_fonts(path: Path) -> str:
    pdffonts = shutil.which("pdffonts")
    if not pdffonts:
        raise RuntimeError("pdffonts is required to verify AESG PDF typography")
    result = subprocess.run([pdffonts, str(path)], capture_output=True, text=True, check=False)
    if result.returncode:
        raise RuntimeError(f"pdffonts failed for {path}: {result.stderr.strip()}")
    output = result.stdout.strip()
    font_text = output.casefold()
    if "verdana" not in font_text:
        raise RuntimeError(
            f"AESG PDF conversion did not embed Verdana: {path}\n{output}\n"
            "Set AESG_SOFFICE to an office runtime with the approved Verdana font."
        )
    fallbacks = (
        "linuxlibertine",
        "liberationserif",
        "liberationsans",
        "dejavuserif",
        "dejavusans",
        "noto serif",
        "noto sans",
    )
    found_fallbacks = [name for name in fallbacks if name in font_text]
    if found_fallbacks:
        raise RuntimeError(
            f"AESG PDF conversion contains fallback fonts {', '.join(found_fallbacks)}: {path}\n"
            "Set AESG_SOFFICE to an office runtime with the approved Verdana font."
        )
    return output
