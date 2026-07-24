#!/usr/bin/env python3
"""Create an AESG letter or report from a compact JSON specification."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from docx import Document
from docx.enum.style import WD_STYLE_TYPE
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt, RGBColor


GREEN = "008C95"
GRAY = "343741"
WHITE = "FFFFFF"
FONT = "Verdana"


def skill_root() -> Path:
    return Path(__file__).resolve().parents[2]


def default_template() -> Path:
    return skill_root() / "aesg-branding/assets/templates/AESG_Letterhead_Dubai.docx"


def clear_body(document: Document) -> None:
    body = document._element.body
    for child in list(body):
        if child.tag != qn("w:sectPr"):
            body.remove(child)


def style_by_name(document: Document, name: str):
    for style in document.styles:
        if style.name and style.name.casefold() == name.casefold():
            return style
    return None


def ensure_style(document: Document, name: str, size: float, color: str, bold: bool = False):
    style = style_by_name(document, name)
    if style is None:
        style = document.styles.add_style(name, WD_STYLE_TYPE.PARAGRAPH)
    style.font.name = FONT
    style.font.size = Pt(size)
    style.font.bold = bold
    style.font.color.rgb = RGBColor.from_string(color)
    return style


def set_run_font(run, *, bold: bool | None = None, italic: bool | None = None) -> None:
    run.font.name = FONT
    run._element.get_or_add_rPr().get_or_add_rFonts().set(qn("w:ascii"), FONT)
    run._element.get_or_add_rPr().get_or_add_rFonts().set(qn("w:hAnsi"), FONT)
    if bold is not None:
        run.bold = bold
    if italic is not None:
        run.italic = italic


def configure_styles(document: Document) -> None:
    ensure_style(document, "Normal", 9, "53565A")
    ensure_style(document, "Heading 1", 12, GREEN, True)
    ensure_style(document, "Heading 2", 9, GREEN)
    ensure_style(document, "Heading 3", 14, GRAY, True)
    ensure_style(document, "Title", 26, "00686F")
    ensure_style(document, "Subtitle", 12, GREEN)
    list_style = style_by_name(document, "List Bullet")
    if list_style is not None:
        list_style.font.name = FONT
        list_style.font.size = Pt(9)


def add_text(document: Document, text: str, style: str = "Normal", *, bold: bool = False, italic: bool = False):
    paragraph = document.add_paragraph(style=style_by_name(document, style))
    paragraph.paragraph_format.space_after = Pt(8)
    paragraph.paragraph_format.line_spacing = 1
    run = paragraph.add_run(text)
    set_run_font(run, bold=bold, italic=italic)
    return paragraph


def shade(cell, fill: str) -> None:
    properties = cell._tc.get_or_add_tcPr()
    shading = properties.find(qn("w:shd"))
    if shading is None:
        shading = OxmlElement("w:shd")
        properties.append(shading)
    shading.set(qn("w:fill"), fill)


def add_table(document: Document, spec: dict) -> None:
    headers = [str(value) for value in spec.get("headers", [])]
    rows = spec.get("rows", [])
    if not headers:
        return
    table = document.add_table(rows=1, cols=len(headers))
    table.style = "Table Grid"
    table.autofit = True
    for index, header in enumerate(headers):
        cell = table.rows[0].cells[index]
        shade(cell, GRAY)
        cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
        paragraph = cell.paragraphs[0]
        run = paragraph.add_run(header)
        set_run_font(run, bold=True)
        run.font.color.rgb = RGBColor.from_string(WHITE)
    for row_values in rows:
        values = list(row_values.values()) if isinstance(row_values, dict) else list(row_values)
        cells = table.add_row().cells
        for index, cell in enumerate(cells):
            value = values[index] if index < len(values) else ""
            paragraph = cell.paragraphs[0]
            run = paragraph.add_run(str(value))
            set_run_font(run)
            cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
    document.add_paragraph()


def add_sections(document: Document, sections: list[dict]) -> None:
    for section in sections:
        heading = str(section.get("heading", "")).strip()
        if heading:
            level = int(section.get("level", 1))
            add_text(document, heading, f"Heading {min(max(level, 1), 3)}")
        for paragraph in section.get("paragraphs", []):
            add_text(document, str(paragraph))
        for bullet in section.get("bullets", []):
            add_text(document, str(bullet), "List Bullet")
        if section.get("table"):
            add_table(document, section["table"])
        if section.get("source"):
            add_text(document, f"Source: {section['source']}", italic=True)


def add_report(document: Document, spec: dict) -> None:
    title = str(spec.get("title", "AESG Report")).strip()
    add_text(document, title, "Title")
    if spec.get("subtitle"):
        add_text(document, str(spec["subtitle"]), "Subtitle")
    if spec.get("date"):
        paragraph = add_text(document, str(spec["date"]))
        paragraph.alignment = WD_ALIGN_PARAGRAPH.LEFT
    if spec.get("cover", True):
        document.paragraphs[-1].add_run().add_break(WD_BREAK.PAGE)
    add_sections(document, spec.get("sections", []))


def add_letter(document: Document, spec: dict) -> None:
    recipient = spec.get("recipient", [])
    if isinstance(recipient, str):
        recipient = [recipient]
    for line in recipient:
        add_text(document, str(line), "Heading 2")
    if spec.get("date"):
        add_text(document, f"Date: {spec['date']}", "Heading 2")
    if spec.get("reference"):
        add_text(document, f"Reference: {spec['reference']}", "Heading 2")
    if spec.get("subject"):
        add_text(document, f"Subject: {spec['subject']}", "Heading 2", bold=True)
    add_text(document, str(spec.get("salutation", "Dear Sir or Madam,")))
    add_sections(document, spec.get("sections", []))
    add_text(document, str(spec.get("closing", "Yours sincerely,")))
    if spec.get("signatory"):
        add_text(document, str(spec["signatory"]), bold=True)
    if spec.get("designation"):
        add_text(document, str(spec["designation"]))


def scrub_and_normalise(document: Document) -> None:
    for paragraph in document.paragraphs:
        for run in paragraph.runs:
            set_run_font(run)
    for table in document.tables:
        for row in table.rows:
            for cell in row.cells:
                for paragraph in cell.paragraphs:
                    for run in paragraph.runs:
                        set_run_font(run)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--spec", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--template", type=Path, default=default_template())
    args = parser.parse_args()

    spec = json.loads(args.spec.read_text(encoding="utf-8"))
    if args.output.suffix.casefold() != ".docx":
        raise ValueError("--output must end in .docx")
    if not args.template.is_file():
        raise FileNotFoundError(args.template)

    document = Document(args.template)
    clear_body(document)
    configure_styles(document)
    kind = str(spec.get("kind", "report")).casefold()
    if kind == "letter":
        add_letter(document, spec)
    elif kind == "report":
        add_report(document, spec)
    else:
        raise ValueError("kind must be report or letter")
    scrub_and_normalise(document)

    document.core_properties.title = str(spec.get("title", spec.get("subject", "AESG document")))
    document.core_properties.author = "AESG"
    document.core_properties.subject = str(spec.get("subtitle", spec.get("subject", "")))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    document.save(args.output)
    print(json.dumps({"ok": True, "output": str(args.output.resolve()), "bytes": args.output.stat().st_size}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
