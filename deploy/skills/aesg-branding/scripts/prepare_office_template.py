#!/usr/bin/env python3
"""Prepare a privacy-safe, CRC-clean Office template for the AESG skill bundle."""

from __future__ import annotations

import argparse
import hashlib
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET


CORE_NS = "http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
DC_NS = "http://purl.org/dc/elements/1.1/"
DCTERMS_NS = "http://purl.org/dc/terms/"
CP_TAGS = {
    "creator": f"{{{DC_NS}}}creator",
    "lastModifiedBy": f"{{{CORE_NS}}}lastModifiedBy",
    "created": f"{{{DCTERMS_NS}}}created",
    "modified": f"{{{DCTERMS_NS}}}modified",
}


def repair_pptx(source: Path, work_dir: Path) -> Path:
    executable = shutil.which("libreoffice") or shutil.which("soffice")
    if not executable:
        raise RuntimeError("LibreOffice is required to repair the supplied PPTX")
    result = subprocess.run(
        [
            executable,
            "--headless",
            "--convert-to",
            "pptx",
            "--outdir",
            str(work_dir),
            str(source),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    repaired = work_dir / source.name
    if result.returncode or not repaired.is_file():
        detail = result.stderr.strip() or result.stdout.strip()
        raise RuntimeError(f"LibreOffice repair failed: {detail}")
    return repaired


def scrub_core_properties(data: bytes) -> bytes:
    root = ET.fromstring(data)
    for key in ("creator", "lastModifiedBy"):
        element = root.find(CP_TAGS[key])
        if element is None:
            element = ET.SubElement(root, CP_TAGS[key])
        element.text = "AESG"
    for key in ("created", "modified"):
        element = root.find(CP_TAGS[key])
        if element is not None:
            root.remove(element)
    ET.register_namespace("cp", CORE_NS)
    ET.register_namespace("dc", DC_NS)
    ET.register_namespace("dcterms", DCTERMS_NS)
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def rewrite_package(source: Path, output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(source) as incoming, zipfile.ZipFile(
        output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9
    ) as outgoing:
        corrupt = incoming.testzip()
        if corrupt:
            raise ValueError(f"source package remains corrupt: {corrupt}")
        for info in incoming.infolist():
            data = incoming.read(info.filename)
            if info.filename == "docProps/core.xml":
                data = scrub_core_properties(data)
            clean_info = zipfile.ZipInfo(info.filename, date_time=(2026, 8, 6, 0, 0, 0))
            clean_info.compress_type = zipfile.ZIP_DEFLATED
            clean_info.external_attr = info.external_attr
            clean_info.create_system = info.create_system
            outgoing.writestr(clean_info, data)
    with zipfile.ZipFile(output) as archive:
        corrupt = archive.testzip()
        if corrupt:
            raise ValueError(f"prepared package is corrupt: {corrupt}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument(
        "--repair-pptx",
        action="store_true",
        help="Round-trip the source through LibreOffice before sanitising it.",
    )
    args = parser.parse_args()
    if args.source.suffix.casefold() != args.output.suffix.casefold():
        raise ValueError("source and output extensions must match")
    if args.source.suffix.casefold() not in {".docx", ".pptx", ".xlsx"}:
        raise ValueError("only DOCX, PPTX, and XLSX packages are supported")

    with tempfile.TemporaryDirectory(prefix="aesg-template-") as temporary:
        package = args.source
        if args.repair_pptx:
            if args.source.suffix.casefold() != ".pptx":
                raise ValueError("--repair-pptx is valid only for PPTX files")
            package = repair_pptx(args.source, Path(temporary))
        rewrite_package(package, args.output)

    digest = hashlib.sha256(args.output.read_bytes()).hexdigest()
    print(f"{digest}  {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
