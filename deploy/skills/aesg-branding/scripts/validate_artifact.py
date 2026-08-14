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
from xml.etree import ElementTree


PLACEHOLDER_RE = re.compile(
    r"(?:\b(?:lorem ipsum|insert title|sample heading|sample sub-heading|"
    r"replace text|name another|name surname|client name|click to add|"
    r"click to edit|section heading|xxxx-xxx)\b|x{8,})",
    re.IGNORECASE,
)
ERROR_TOKENS = ("#REF!", "#DIV/0!", "#VALUE!", "#NAME?", "#N/A", "#NUM!", "#NULL!")
WORD_TEXT_PART_RE = re.compile(
    r"word/(?:document|header\d+|footer\d+|footnotes|endnotes|comments)\.xml$"
)
SLIDE_PART_RE = re.compile(r"ppt/slides/slide(\d+)\.xml$")
PRESENTATION_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"
DRAWING_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


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


def paragraph_texts(xml: bytes, namespace: str) -> list[str]:
    root = ElementTree.fromstring(xml)
    paragraph_tag = f"{{{namespace}}}p"
    text_tag = f"{{{namespace}}}t"
    paragraphs: list[str] = []
    for paragraph in root.iter(paragraph_tag):
        if any(
            descendant is not paragraph and descendant.tag == paragraph_tag
            for descendant in paragraph.iter()
        ):
            continue
        paragraphs.append(
            "".join(node.text or "" for node in paragraph.iter(text_tag))
        )
    return paragraphs


def docx_story_text(path: Path) -> str:
    chunks: list[str] = []
    with zipfile.ZipFile(path) as archive:
        for name in archive.namelist():
            if WORD_TEXT_PART_RE.fullmatch(name):
                chunks.extend(
                    paragraph_texts(archive.read(name), WORD_NS)
                )
    return "\n".join(chunks)


def inspect_pptx_slides(
    path: Path, slide_order: dict[str, int]
) -> tuple[str, list[str], list[str]]:
    text: list[str] = []
    empty_placeholders: list[str] = []
    picture_placeholders: list[str] = []
    namespaces = {"p": PRESENTATION_NS, "a": DRAWING_NS}
    with zipfile.ZipFile(path) as archive:
        slide_parts = sorted(
            (
                (slide_order.get(name, int(match.group(1))), name)
                for name in archive.namelist()
                if (match := SLIDE_PART_RE.fullmatch(name))
            ),
            key=lambda item: item[0],
        )
        for slide_number, name in slide_parts:
            slide_xml = archive.read(name)
            root = ElementTree.fromstring(slide_xml)
            slide_text = paragraph_texts(slide_xml, DRAWING_NS)
            text.extend(slide_text)
            for shape in root.findall(".//p:sp", namespaces):
                properties = shape.find("./p:nvSpPr/p:cNvPr", namespaces)
                shape_name = properties.get("name", "") if properties is not None else ""
                placeholder = shape.find("./p:nvSpPr/p:nvPr/p:ph", namespaces)
                shape_text = "".join(
                    node.text or "" for node in shape.findall(".//a:t", namespaces)
                ).strip()
                if "picture placeholder" in shape_name.casefold():
                    picture_placeholders.append(f"slide {slide_number}, {shape_name}")
                if placeholder is None or shape_text:
                    continue
                placeholder_type = placeholder.get("type", "obj")
                if placeholder_type not in {"dt", "ftr"}:
                    empty_placeholders.append(
                        f"slide {slide_number}, {shape_name or placeholder_type}"
                    )
    return "\n".join(text), empty_placeholders, picture_placeholders


def validate_core_author(path: Path, errors: list[str], evidence: dict) -> None:
    with zipfile.ZipFile(path) as archive:
        try:
            core = archive.read("docProps/core.xml").decode("utf-8", errors="ignore")
        except KeyError:
            errors.append("Office package has no core properties")
            return
    creators = re.findall(r"<(?:dc:creator|cp:lastModifiedBy)>(.*?)</", core)
    evidence["coreAuthors"] = creators
    if creators and any(value.strip().casefold() != "aesg" for value in creators):
        errors.append("Office core properties contain a non-AESG author")


def validate_pdf(path: Path, errors: list[str], evidence: dict) -> None:
    if path.read_bytes()[:5] != b"%PDF-":
        errors.append("missing PDF signature")
    if shutil.which("qpdf"):
        result = run(["qpdf", "--check", str(path)])
        evidence["qpdf"] = result.stdout.strip() or result.stderr.strip()
        if result.returncode:
            errors.append("qpdf validation failed")
    try:
        from pypdf import PdfReader

        document = PdfReader(path)
        extracted = "\n".join(page.extract_text() or "" for page in document.pages)
        placeholders = sorted(set(match.group(0) for match in PLACEHOLDER_RE.finditer(extracted)))
        if placeholders:
            errors.append(f"placeholder text remains: {', '.join(placeholders)}")
        evidence["pypdf"] = {"pages": len(document.pages), "textChecked": True}
    except Exception as exc:
        errors.append(f"PDF package validation failed: {exc}")
    if shutil.which("pdfinfo"):
        result = run(["pdfinfo", str(path)])
        evidence["pdfinfo"] = result.stdout.strip() or result.stderr.strip()
        if result.returncode:
            errors.append("pdfinfo validation failed")
    else:
        errors.append("missing validator: pdfinfo")
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
    text = docx_story_text(path)
    placeholders = sorted(set(match.group(0) for match in PLACEHOLDER_RE.finditer(text)))
    if placeholders:
        errors.append(f"placeholder text remains: {', '.join(placeholders)}")
    if not document.sections:
        errors.append("DOCX has no sections")
    xml = package_text(path).casefold()
    if "verdana" not in xml:
        errors.append("Verdana is not declared in DOCX package")
    validate_core_author(path, errors, evidence)
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
    validate_core_author(path, errors, evidence)
    evidence["worksheets"] = workbook.sheetnames
    evidence["dimensions"] = {
        ws.title: {"rows": ws.max_row, "columns": ws.max_column} for ws in workbook.worksheets
    }


def validate_pptx(path: Path, errors: list[str], evidence: dict) -> None:
    from pptx import Presentation

    presentation = Presentation(path)
    slide_order = {
        str(slide.part.partname).lstrip("/"): index
        for index, slide in enumerate(presentation.slides, start=1)
    }
    slide_text, empty_placeholders, picture_placeholders = inspect_pptx_slides(
        path, slide_order
    )
    placeholders = sorted(set(match.group(0) for match in PLACEHOLDER_RE.finditer(slide_text)))
    if placeholders:
        errors.append(f"placeholder text remains: {', '.join(placeholders[:12])}")
    if empty_placeholders:
        errors.append(
            f"empty structural placeholders remain: {', '.join(empty_placeholders[:12])}"
        )
    if picture_placeholders:
        errors.append(
            f"unresolved picture placeholders remain: {', '.join(picture_placeholders[:12])}"
        )
    if not presentation.slides:
        errors.append("presentation has no slides")
    xml = package_text(path).casefold()
    if "verdana" not in xml:
        errors.append("Verdana is not declared in PPTX package")
    layout_count = sum(len(master.slide_layouts) for master in presentation.slide_masters)
    expected_size = [9906000, 6858000]
    actual_size = [presentation.slide_width, presentation.slide_height]
    if presentation.core_properties.subject == "AESG Compact General Template":
        if len(presentation.slide_masters) != 1 or layout_count != 17:
            errors.append("AESG compact runtime must contain one master and seventeen layouts")
        if actual_size != expected_size:
            errors.append(f"unexpected AESG compact template size: {actual_size}")
    validate_core_author(path, errors, evidence)
    evidence.update(
        {
            "slides": len(presentation.slides),
            "layouts": layout_count,
            "masters": len(presentation.slide_masters),
            "sizeEmu": actual_size,
            "emptyPlaceholders": empty_placeholders,
            "picturePlaceholders": picture_placeholders,
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
