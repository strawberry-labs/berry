#!/usr/bin/env python3
"""Create an AESG report or letter from retained Word templates."""

from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path

from docx import Document
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT, WD_ROW_HEIGHT_RULE
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor


GREEN = "008C95"
GRAY = "343741"
WHITE = "FFFFFF"
FONT = "Verdana"


def skill_root() -> Path:
    return Path(__file__).resolve().parents[2]


def report_template() -> Path:
    return skill_root() / "aesg-branding/assets/templates/AESG_General_Report_Template.docx"


def letter_template() -> Path:
    return skill_root() / "aesg-branding/assets/templates/AESG_Letterhead_Dubai.docx"


def text_of(element) -> str:
    return "".join(element.xpath('.//*[local-name()="t"]/text()'))


def normalise(value: str) -> str:
    return " ".join(value.split()).casefold()


def leaf_paragraphs(element):
    for paragraph in element.xpath('.//*[local-name()="p"]'):
        if not paragraph.xpath('.//*[local-name()="p"]'):
            yield paragraph


def replace_leaf_text(element, replacements: dict[str, str]) -> None:
    replacement_map = {normalise(key): str(value) for key, value in replacements.items()}
    for paragraph in leaf_paragraphs(element):
        nodes = paragraph.xpath('.//*[local-name()="t"]')
        if not nodes:
            continue
        key = normalise("".join(node.text or "" for node in nodes))
        if key not in replacement_map:
            continue
        nodes[0].text = replacement_map[key]
        for node in nodes[1:]:
            node.text = ""


def remove_shape_by_leaf_text(element, value: str) -> None:
    targets = []
    for paragraph in leaf_paragraphs(element):
        nodes = paragraph.xpath('.//*[local-name()="t"]')
        if normalise("".join(node.text or "" for node in nodes)) != normalise(value):
            continue
        node = paragraph
        while node is not None and node is not element:
            if node.tag.rsplit("}", 1)[-1] == "AlternateContent":
                targets.append(node)
                break
            node = node.getparent()
    for target in {id(node): node for node in targets}.values():
        parent = target.getparent()
        if parent is not None:
            parent.remove(target)


def clear_text_highlight(element, value: str) -> None:
    wanted = normalise(value)
    for paragraph in leaf_paragraphs(element):
        nodes = paragraph.xpath('.//*[local-name()="t"]')
        if normalise("".join(node.text or "" for node in nodes)) != wanted:
            continue
        for properties in paragraph.xpath('.//*[local-name()="rPr"]'):
            for child in list(properties):
                if child.tag.rsplit("}", 1)[-1] in {"highlight", "shd"}:
                    properties.remove(child)


def remove_page_breaks(element) -> None:
    for br in list(element.xpath('.//*[local-name()="br"]')):
        if br.get(qn("w:type")) == "page":
            br.getparent().remove(br)


def source_parts(document: Document):
    body = document._element.body
    cover = None
    approval = None
    divider = None
    section_properties = []
    for child in body:
        tag = child.tag.rsplit("}", 1)[-1]
        value = normalise(text_of(child))
        if tag == "sdt" and "report title" in value and "project name" in value:
            cover = copy.deepcopy(child)
        elif tag == "tbl" and "prepared by" in value and "ref. no." in value:
            approval = copy.deepcopy(child)
        elif tag == "p" and "section heading i" in value and child.xpath(
            './/*[local-name()="drawing" or local-name()="pict"]'
        ):
            divider = copy.deepcopy(child)
        for sect_pr in child.xpath('.//*[local-name()="sectPr"]'):
            section_properties.append(copy.deepcopy(sect_pr))
    if body.sectPr is not None:
        section_properties.append(copy.deepcopy(body.sectPr))
    if cover is None or divider is None or len(section_properties) < 2:
        raise ValueError("general report template does not contain the expected AESG source parts")
    return cover, approval, divider, section_properties


def clear_body(document: Document) -> None:
    body = document._element.body
    for child in list(body):
        if child.tag != qn("w:sectPr"):
            body.remove(child)


def append_before_final_section(document: Document, element) -> None:
    body = document._element.body
    section = body.sectPr
    if section is None:
        body.append(element)
    else:
        body.insert(body.index(section), element)


def set_final_section(document: Document, section_properties) -> None:
    body = document._element.body
    current = body.sectPr
    replacement = copy.deepcopy(section_properties)
    if current is None:
        body.append(replacement)
    else:
        body.replace(current, replacement)


def add_section_break(document: Document, section_properties) -> None:
    paragraph = document.add_paragraph()
    properties = paragraph._p.get_or_add_pPr()
    properties.append(copy.deepcopy(section_properties))


def style_by_name(document: Document, *names: str):
    wanted = {name.casefold() for name in names}
    for style in document.styles:
        if style.name and style.name.casefold() in wanted:
            return style
    return None


def set_run_font(run, *, bold: bool | None = None, italic: bool | None = None) -> None:
    run.font.name = FONT
    fonts = run._element.get_or_add_rPr().get_or_add_rFonts()
    fonts.set(qn("w:ascii"), FONT)
    fonts.set(qn("w:hAnsi"), FONT)
    if bold is not None:
        run.bold = bold
    if italic is not None:
        run.italic = italic


def add_text(
    document: Document,
    value: str,
    *style_names: str,
    bold: bool = False,
    italic: bool = False,
):
    style = style_by_name(document, *style_names)
    paragraph = document.add_paragraph(style=style)
    paragraph.paragraph_format.space_after = Pt(7)
    run = paragraph.add_run(str(value))
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
    rows = list(spec.get("rows", []))
    if not headers:
        return
    table = document.add_table(rows=1, cols=len(headers))
    preferred = style_by_name(document, "AESG Table", "Table Grid")
    if preferred is not None:
        table.style = preferred
    table.autofit = True
    for index, header in enumerate(headers):
        cell = table.rows[0].cells[index]
        shade(cell, GREEN)
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
            run = cell.paragraphs[0].add_run(str(value))
            set_run_font(run)
            cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
    document.add_paragraph()


def add_callout(document: Document, value: str) -> None:
    table = document.add_table(rows=1, cols=1)
    cell = table.cell(0, 0)
    shade(cell, "E6F4F5")
    paragraph = cell.paragraphs[0]
    run = paragraph.add_run(value)
    set_run_font(run, bold=True)
    run.font.color.rgb = RGBColor.from_string(GRAY)
    document.add_paragraph()


def add_image(document: Document, image_spec) -> None:
    if isinstance(image_spec, str):
        image_spec = {"path": image_spec}
    path = Path(str(image_spec.get("path", "")))
    if not path.is_file():
        raise FileNotFoundError(f"image not found: {path}")
    width = float(image_spec.get("widthInches", image_spec.get("width", 6.2)))
    caption = None
    if image_spec.get("caption"):
        caption = add_text(
            document,
            str(image_spec["caption"]),
            "AESG Figure Captions",
            "Caption",
            italic=True,
        )
        caption.alignment = WD_ALIGN_PARAGRAPH.CENTER
        caption.paragraph_format.keep_with_next = True
    paragraph = document.add_paragraph()
    paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
    paragraph.add_run().add_picture(str(path), width=Inches(width))
    if image_spec.get("source"):
        add_text(document, f"Source: {image_spec['source']}", "AESG Body Text", "Normal", italic=True)


def add_divider(document: Document, heading: str) -> None:
    table = document.add_table(rows=1, cols=1)
    table.autofit = True
    row = table.rows[0]
    row.height = Inches(8.4)
    row.height_rule = WD_ROW_HEIGHT_RULE.EXACTLY
    cell = row.cells[0]
    cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
    shade(cell, GREEN)
    paragraph = cell.paragraphs[0]
    paragraph.alignment = WD_ALIGN_PARAGRAPH.LEFT
    run = paragraph.add_run(heading)
    set_run_font(run, bold=True)
    run.font.size = Pt(25)
    run.font.color.rgb = RGBColor.from_string(WHITE)
    document.add_page_break()


def add_sections(document: Document, sections: list[dict], divider_source=None) -> None:
    for index, section in enumerate(sections):
        heading = str(section.get("heading", "")).strip()
        if section.get("divider") and heading and divider_source is not None:
            add_divider(document, heading)
        elif section.get("pageBreak") and (index or document.paragraphs):
            document.add_page_break()
        if heading:
            level = min(max(int(section.get("level", 1)), 1), 3)
            styles = {
                1: ("AESG Main Heading", "Heading 1"),
                2: ("AESG Sub H1", "Heading 2"),
                3: ("AESG H2", "Heading 3"),
            }[level]
            add_text(document, heading, *styles)
        for paragraph in section.get("paragraphs", []):
            value = paragraph.get("text", "") if isinstance(paragraph, dict) else paragraph
            add_text(document, str(value), "AESG Body Text", "Normal")
        for bullet in section.get("bullets", []):
            add_text(document, str(bullet), "AESG Bullet", "List Bullet")
        for numbered in section.get("numbered", []):
            add_text(document, str(numbered), "AESG Numbering", "List Number")
        if section.get("callout"):
            add_callout(document, str(section["callout"]))
        if section.get("table"):
            if section["table"].get("caption"):
                add_text(
                    document,
                    str(section["table"]["caption"]),
                    "AESG Table Caption",
                    "Caption",
                )
            add_table(document, section["table"])
        images = section.get("images", [])
        if section.get("image"):
            images = [section["image"], *images]
        for image in images:
            add_image(document, image)
        if section.get("source"):
            add_text(document, f"Source: {section['source']}", "AESG Body Text", "Normal", italic=True)


def populate_approval_table(table_element, spec: dict) -> None:
    rows = table_element.xpath('./*[local-name()="tr"]')
    document_control = spec.get("documentControl", {})
    values = {
        0: str(spec.get("project", spec.get("title", ""))),
        1: str(spec.get("title", "")),
        2: str(spec.get("subtitle", spec.get("description", ""))),
        5: str(document_control.get("issue", "01")),
        6: str(document_control.get("revision", "00")),
        7: str(spec.get("date", "")),
    }
    for row_index, value in values.items():
        if row_index >= len(rows) or not value:
            continue
        cells = rows[row_index].xpath('./*[local-name()="tc"]')
        if not cells:
            continue
        target = cells[-1]
        paragraphs = target.xpath('.//*[local-name()="p"]')
        if paragraphs:
            nodes = paragraphs[0].xpath('.//*[local-name()="t"]')
            if nodes:
                nodes[0].text = value
                for node in nodes[1:]:
                    node.text = ""
    people = {
        9: str(document_control.get("preparedBy", "AESG")),
        10: str(document_control.get("reviewedBy", "AESG")),
        11: str(document_control.get("approvedBy", "AESG")),
    }
    for row_index, value in people.items():
        if row_index >= len(rows):
            continue
        cells = rows[row_index].xpath('./*[local-name()="tc"]')
        if len(cells) < 3:
            continue
        name_nodes = cells[2].xpath('.//*[local-name()="t"]')
        if name_nodes:
            name_nodes[0].text = value
            for node in name_nodes[1:]:
                node.text = ""
        if len(cells) > 3:
            for node in cells[3].xpath('.//*[local-name()="t"]'):
                node.text = ""


def create_report(document: Document, spec: dict) -> None:
    cover, approval, divider, sections = source_parts(document)
    clear_body(document)
    set_final_section(document, sections[1])
    if spec.get("cover", True):
        remove_shape_by_leaf_text(cover, "Client Logo")
        replace_leaf_text(
            cover,
            {
                "Report Title": spec.get("title", "AESG report"),
                "Project Name": spec.get("project", spec.get("subtitle", "")),
                "Client Name": spec.get("client", "AESG"),
                "Client Logo": "",
            },
        )
        approval_page = bool(spec.get("approvalPage", False) and approval is not None)
        if not approval_page:
            remove_page_breaks(cover)
        append_before_final_section(document, cover)
        if approval_page:
            populate_approval_table(approval, spec)
            append_before_final_section(document, approval)
        add_section_break(document, sections[0])
    replacements = {
        "Project Name": spec.get("project", spec.get("title", "AESG")),
        "Report Title": spec.get("title", "AESG report"),
        "Monday, July 27, 2026": spec.get("date", ""),
        "AESG – OPE – MAR - REP": spec.get(
            "reference", spec.get("documentControl", {}).get("reference", "AESG")
        ),
    }
    for section in document.sections:
        replace_leaf_text(section.header._element, replacements)
        replace_leaf_text(section.footer._element, replacements)
        clear_text_highlight(section.footer._element, str(replacements["AESG – OPE – MAR - REP"]))
    if spec.get("documentTitle"):
        add_text(document, str(spec["documentTitle"]), "AESG Title", "Title")
    add_sections(document, list(spec.get("sections", [])), divider)


def create_letter(document: Document, spec: dict) -> None:
    clear_body(document)
    recipient = spec.get("recipient", [])
    if isinstance(recipient, str):
        recipient = [recipient]
    if spec.get("date"):
        add_text(document, str(spec["date"]), "AESG Body Text", "Normal")
    for line in recipient:
        add_text(document, str(line), "AESG Body Text", "Normal")
    if spec.get("reference"):
        add_text(document, f"Reference: {spec['reference']}", "AESG Sub H1", "Heading 2")
    if spec.get("subject"):
        add_text(document, str(spec["subject"]), "AESG Sub H1", "Heading 2", bold=True)
    add_text(document, str(spec.get("salutation", "Dear Sir or Madam,")), "AESG Body Text", "Normal")
    add_sections(document, list(spec.get("sections", [])))
    add_text(document, str(spec.get("closing", "Yours sincerely,")), "AESG Body Text", "Normal")
    if spec.get("signatory"):
        add_text(document, str(spec["signatory"]), "AESG Body Text", "Normal", bold=True)
    if spec.get("designation"):
        add_text(document, str(spec["designation"]), "AESG Body Text", "Normal")


def normalise_new_text(document: Document) -> None:
    for paragraph in document.paragraphs:
        for run in paragraph.runs:
            if run.text:
                set_run_font(run)
    for table in document.tables:
        for row in table.rows:
            for cell in row.cells:
                for paragraph in cell.paragraphs:
                    for run in paragraph.runs:
                        if run.text:
                            set_run_font(run)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--spec", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--template", type=Path)
    args = parser.parse_args()
    if args.output.suffix.casefold() != ".docx":
        raise ValueError("--output must end in .docx")
    spec = json.loads(args.spec.read_text(encoding="utf-8"))
    kind = str(spec.get("kind", "report")).casefold()
    if kind not in {"report", "letter"}:
        raise ValueError("kind must be report or letter")
    template = args.template or (report_template() if kind == "report" else letter_template())
    if not template.is_file():
        raise FileNotFoundError(template)

    document = Document(template)
    if kind == "report":
        create_report(document, spec)
    else:
        create_letter(document, spec)
    normalise_new_text(document)
    document.core_properties.title = str(spec.get("title", spec.get("subject", "AESG document")))
    document.core_properties.author = "AESG"
    document.core_properties.last_modified_by = "AESG"
    document.core_properties.subject = str(
        spec.get("project", spec.get("subtitle", spec.get("subject", "")))
    )
    document.core_properties.keywords = str(
        spec.get("reference", spec.get("documentControl", {}).get("reference", "AESG"))
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    document.save(args.output)
    print(
        json.dumps(
            {
                "ok": True,
                "output": str(args.output.resolve()),
                "bytes": args.output.stat().st_size,
                "kind": kind,
                "template": template.name,
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
