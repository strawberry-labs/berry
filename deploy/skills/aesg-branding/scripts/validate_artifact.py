#!/usr/bin/env python3
"""Fast structural checks for AESG PDF and OpenXML artifacts."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path


PLACEHOLDER_RE = re.compile(
    r"\b(lorem ipsum|insert title|sample heading|sample sub-heading|"
    r"replace text|name another|client name|click to add|xxxx-xxx)\b",
    re.IGNORECASE,
)
ERROR_TOKENS = ("#REF!", "#DIV/0!", "#VALUE!", "#NAME?", "#N/A", "#NUM!", "#NULL!")


def run(command: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, capture_output=True, text=True, check=False)


def package_text(path: Path) -> str:
    chunks: list[str] = []
    with zipfile.ZipFile(path) as archive:
        corrupt = archive.testzip()
        if corrupt:
            raise ValueError(f"corrupt ZIP member: {corrupt}")
        for name in archive.namelist():
            if name.endswith((".xml", ".rels")):
                chunks.append(archive.read(name).decode("utf-8", errors="ignore"))
    return "\n".join(chunks)


def validate_pdf(path: Path, errors: list[str], evidence: dict) -> None:
    if path.read_bytes()[:5] != b"%PDF-":
        errors.append("missing PDF signature")
    for command in (["qpdf", "--check", str(path)], ["pdfinfo", str(path)]):
        if not shutil.which(command[0]):
            errors.append(f"missing validator: {command[0]}")
            continue
        result = run(command)
        evidence[command[0]] = result.stdout.strip() or result.stderr.strip()
        if result.returncode:
            errors.append(f"{command[0]} validation failed")
    if shutil.which("pdffonts"):
        fonts = run(["pdffonts", str(path)])
        evidence["pdffonts"] = fonts.stdout.strip()
        font_text = fonts.stdout.casefold()
        if not any(name in font_text for name in ("verdana", "ubuntu", "tahoma")):
            errors.append("expected AESG font not found in PDF")
    if shutil.which("file"):
        mime = run(["file", "--brief", "--mime-type", str(path)]).stdout.strip()
        evidence["mime"] = mime
        if mime != "application/pdf":
            errors.append(f"unexpected MIME type: {mime}")


def validate_docx(path: Path, errors: list[str], evidence: dict) -> None:
    from docx import Document

    document = Document(path)
    text = "\n".join(p.text for p in document.paragraphs)
    for table in document.tables:
        text += "\n" + "\n".join(cell.text for row in table.rows for cell in row.cells)
    placeholders = sorted(set(match.group(0) for match in PLACEHOLDER_RE.finditer(text)))
    if placeholders:
        errors.append(f"placeholder text remains: {', '.join(placeholders)}")
    if not document.sections:
        errors.append("DOCX has no sections")
    xml = package_text(path).casefold()
    if "verdana" not in xml:
        errors.append("Verdana is not declared in DOCX package")
    evidence.update(
        {
            "sections": len(document.sections),
            "paragraphs": len(document.paragraphs),
            "tables": len(document.tables),
        }
    )


def validate_xlsx(path: Path, errors: list[str], evidence: dict) -> None:
    from openpyxl import load_workbook

    workbook = load_workbook(path, data_only=False)
    if not workbook.sheetnames:
        errors.append("workbook has no worksheets")
    hidden = [ws.title for ws in workbook.worksheets if ws.sheet_state != "visible"]
    if hidden:
        errors.append(f"unexpected hidden worksheets: {', '.join(hidden)}")
    if any(name.casefold() == "joiners" for name in workbook.sheetnames):
        errors.append("forbidden Joiners worksheet found")
    formula_errors: list[str] = []
    placeholders: list[str] = []
    for worksheet in workbook.worksheets:
        for row in worksheet.iter_rows():
            for cell in row:
                value = cell.value
                if isinstance(value, str):
                    if any(token in value for token in ERROR_TOKENS):
                        formula_errors.append(f"{worksheet.title}!{cell.coordinate}")
                    if PLACEHOLDER_RE.search(value):
                        placeholders.append(f"{worksheet.title}!{cell.coordinate}")
    if formula_errors:
        errors.append(f"formula error tokens at: {', '.join(formula_errors[:12])}")
    if placeholders:
        errors.append(f"placeholder text at: {', '.join(placeholders[:12])}")
    xml = package_text(path).casefold()
    if "joiners" in xml:
        errors.append("forbidden Joiners identifier found in package")
    if "verdana" not in xml:
        errors.append("Verdana is not declared in XLSX package")
    evidence["worksheets"] = workbook.sheetnames
    evidence["dimensions"] = {
        ws.title: {"rows": ws.max_row, "columns": ws.max_column} for ws in workbook.worksheets
    }


def validate_pptx(path: Path, errors: list[str], evidence: dict) -> None:
    from pptx import Presentation

    presentation = Presentation(path)
    placeholders: list[str] = []
    for slide_number, slide in enumerate(presentation.slides, start=1):
        for shape in slide.shapes:
            if getattr(shape, "has_text_frame", False):
                text = shape.text.strip()
                if text and PLACEHOLDER_RE.search(text):
                    placeholders.append(f"slide {slide_number}, shape {shape.shape_id}")
    if placeholders:
        errors.append(f"placeholder text remains: {', '.join(placeholders[:12])}")
    if not presentation.slides:
        errors.append("presentation has no slides")
    xml = package_text(path).casefold()
    if "verdana" not in xml:
        errors.append("Verdana is not declared in PPTX package")
    evidence.update(
        {
            "slides": len(presentation.slides),
            "layouts": len(presentation.slide_layouts),
            "masters": len(presentation.slide_masters),
            "sizeEmu": [presentation.slide_width, presentation.slide_height],
        }
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("artifact", type=Path)
    args = parser.parse_args()
    path = args.artifact.resolve()
    errors: list[str] = []
    evidence: dict = {"path": str(path), "bytes": path.stat().st_size if path.is_file() else 0}

    if not path.is_file() or path.stat().st_size == 0:
        errors.append("artifact is missing or empty")
    else:
        try:
            if path.suffix.casefold() == ".pdf":
                validate_pdf(path, errors, evidence)
            elif path.suffix.casefold() == ".docx":
                validate_docx(path, errors, evidence)
            elif path.suffix.casefold() == ".xlsx":
                validate_xlsx(path, errors, evidence)
            elif path.suffix.casefold() == ".pptx":
                validate_pptx(path, errors, evidence)
            else:
                errors.append(f"unsupported extension: {path.suffix}")
        except Exception as exc:
            errors.append(f"validation exception: {exc}")

    report = {"ok": not errors, "errors": errors, "evidence": evidence}
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
