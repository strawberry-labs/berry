#!/usr/bin/env python3
"""Deterministic LibreOffice resolution and AESG PDF font checks."""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from xml.sax.saxutils import escape as xml_escape


def resolve_verdana_root() -> Path | None:
    """Find the approved Verdana directory for deterministic Office export."""

    repository_deploy = Path(__file__).resolve().parents[3]
    candidates = [
        Path(os.environ["AESG_FONT_DIR"]) if os.environ.get("AESG_FONT_DIR") else None,
        Path("/usr/local/share/fonts/aesg"),
        repository_deploy / "e2b-aesg/fonts/Verdana",
        Path("/System/Library/Fonts/Supplemental"),
        Path("/Library/Fonts"),
    ]
    for candidate in candidates:
        if candidate is None:
            continue
        for root in (candidate, candidate / "Verdana"):
            if (root / "Verdana.ttf").is_file():
                return root
    return None


def fontconfig_environment(profile_parent: Path) -> tuple[dict[str, str], Path | None]:
    """Give LibreOffice a writable fontconfig cache containing Verdana."""

    environment = os.environ.copy()
    configured = environment.get("AESG_FONTCONFIG_FILE")
    if configured:
        environment["FONTCONFIG_FILE"] = configured
        return environment, None
    font_root = resolve_verdana_root()
    if font_root is None:
        return environment, None
    config_root = Path(tempfile.mkdtemp(prefix="fontconfig-", dir=profile_parent))
    cache_root = config_root / "cache"
    cache_root.mkdir()
    config_path = config_root / "fonts.conf"
    directories = [
        font_root,
        Path("/usr/local/share/fonts"),
        Path("/usr/share/fonts"),
        Path("/System/Library/Fonts"),
        Path("/Library/Fonts"),
    ]
    dir_nodes = "\n".join(
        f"  <dir>{xml_escape(str(directory))}</dir>"
        for directory in directories
        if directory.exists()
    )
    config_path.write_text(
        "<?xml version=\"1.0\"?>\n"
        "<!DOCTYPE fontconfig SYSTEM \"fonts.dtd\">\n"
        "<fontconfig>\n"
        f"{dir_nodes}\n"
        f"  <cachedir>{xml_escape(str(cache_root))}</cachedir>\n"
        "  <include ignore_missing=\"yes\">/etc/fonts/fonts.conf</include>\n"
        "</fontconfig>\n",
        encoding="utf-8",
    )
    environment["FONTCONFIG_FILE"] = str(config_path)
    environment.pop("FONTCONFIG_PATH", None)
    return environment, config_root


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
    environment, fontconfig_root = fontconfig_environment(profile_parent)
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            check=False,
            env=environment,
        )
        if result.returncode:
            raise RuntimeError(
                f"command failed ({result.returncode}): {' '.join(command)}\n"
                f"{result.stdout}\n{result.stderr}"
            )
        converted = output_dir / f"{input_path.stem}.pdf"
        if not converted.is_file():
            raise RuntimeError(f"LibreOffice did not create {converted}")
        return converted
    finally:
        if fontconfig_root is not None:
            shutil.rmtree(fontconfig_root, ignore_errors=True)


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
