#!/usr/bin/env python3
"""Build an AESG organisation memo from a JSON spec and a chosen template."""

from __future__ import annotations

import argparse
import json
import re
from zipfile import ZipFile, ZIP_DEFLATED
from lxml import etree
from pathlib import Path

from docx import Document
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt, RGBColor

GREEN = "008C95"
GRAY = "343741"
WHITE = "FFFFFF"
FONT = "Verdana"

TEMPLATES = {
    "HR": {
        "default_title": "Human Resources Memorandum",
        "closing_department": "Your Human Resources Department,",
    },
    "Finance": {
        "default_title": "Finance Memorandum",
        "closing_department": "Your Finance Department,",
    },
    "IT": {
        "default_title": "IT Memorandum",
        "closing_department": "Your IT Department,",
    },
    "Operational": {
        "default_title": "Operational Memorandum",
        "closing_department": "Your Operations Department,",
    },
}

DATE_PATTERN = re.compile(
    r"\b\d{1,2}\s+"
    r"(January|February|March|April|May|June|July|August|September|October|November|December)"
    r"\s+\d{4}\b",
    re.IGNORECASE,
)


def set_run_font(run, *, bold=False, italic=False, color=None, size=None):
    run.font.name = FONT
    rPr = run._element.get_or_add_rPr()
    rFonts = rPr.find(qn("w:rFonts"))
    if rFonts is None:
        rFonts = OxmlElement("w:rFonts")
        rPr.append(rFonts)
    rFonts.set(qn("w:ascii"), FONT)
    rFonts.set(qn("w:hAnsi"), FONT)
    if bold:
        run.bold = True
    if italic:
        run.italic = True
    if color is not None:
        run.font.color.rgb = RGBColor.from_string(color)
    if size is not None:
        run.font.size = Pt(size)


def find_first(doc, predicate):
    for i, p in enumerate(doc.paragraphs):
        if predicate(p):
            return i
    return -1


def find_body_block_indices(doc):
    """Locate Date/To/From/Subject, rule, salutation, and closing paragraphs."""
    body_index = find_first(doc, lambda p: p.text.startswith("Date:"))
    to_index = find_first(doc, lambda p: p.text.startswith("To:"))
    from_index = find_first(doc, lambda p: p.text.startswith("From:"))
    subject_index = find_first(doc, lambda p: p.text.startswith("Subject:"))
    rule_index = find_first(doc, lambda p: re.fullmatch(r"_+", p.text.strip() or "") is not None)
    salutation_index = find_first(doc, lambda p: p.text.startswith("Dear "))
    closing_index = find_first(
        doc, lambda p: p.text.startswith("Your ") and "Department," in p.text
    )
    return {
        "body": body_index,
        "to": to_index,
        "from": from_index,
        "subject": subject_index,
        "rule": rule_index,
        "salutation": salutation_index,
        "closing": closing_index,
    }

def iter_body_strings(body):
    if isinstance(body, str):
        yield body
    elif isinstance(body, dict):
        for value in body.values():
            yield from iter_body_strings(value)
    elif isinstance(body, list):
        for value in body:
            yield from iter_body_strings(value)


def extract_emphasis_phrases(spec):
    phrases = set()

    subject = str(spec.get("subject", "")).strip()
    if subject:
        phrases.add(subject)
        for match in re.finditer(r"\(([^()]+)\)", subject):
            inner = match.group(1).strip()
            if inner:
                phrases.add(inner)

    for text in [spec.get("date", ""), *iter_body_strings(spec.get("body", {}))]:
        text = str(text).strip()
        if not text:
            continue
        for match in DATE_PATTERN.finditer(text):
            phrases.add(match.group(0).strip())

    return sorted(
        {phrase for phrase in phrases if len(phrase) >= 4},
        key=len,
        reverse=True,
    )


def build_emphasis_pattern(phrases):
    if not phrases:
        return None
    escaped = [re.escape(phrase) for phrase in phrases]
    return re.compile("(" + "|".join(escaped) + ")", re.IGNORECASE)


def add_text_with_emphasis(
    paragraph,
    text,
    *,
    remaining_emphasis_phrases=None,
    bold=False,
    italic=False,
    color=None,
    size=None,
):
    if not text:
        return

    parts = [text]
    matched_phrases = set()
    emphasis_pattern = build_emphasis_pattern(remaining_emphasis_phrases or [])
    if emphasis_pattern is not None:
        parts = re.split(emphasis_pattern, text)

    for part in parts:
        if not part:
            continue
        is_emphasis = False
        if emphasis_pattern is not None and emphasis_pattern.fullmatch(part) is not None:
            matched_phrase = next(
                (
                    phrase
                    for phrase in remaining_emphasis_phrases
                    if phrase.lower() == part.lower()
                ),
                None,
            )
            if matched_phrase is not None and matched_phrase not in matched_phrases:
                is_emphasis = True
                matched_phrases.add(matched_phrase)
        run = paragraph.add_run(part)
        set_run_font(
            run,
            bold=bold or is_emphasis,
            italic=italic,
            color=color,
            size=size,
        )

    if remaining_emphasis_phrases is not None:
        for phrase in matched_phrases:
            remaining_emphasis_phrases.discard(phrase)


def update_field(paragraph, prefix, value, *, tabs=2):
    """Rewrite a field line using the template's tab-stop layout."""
    clear_paragraph(paragraph)

    label_run = paragraph.add_run(f"{prefix}:")
    set_run_font(label_run, bold=True)

    for _ in range(tabs):
        tab_run = paragraph.add_run("\t")
        set_run_font(tab_run, bold=True)

    value_run = paragraph.add_run(value)
    set_run_font(value_run, bold=False)


def remove_paragraph_runs(paragraph):
    for run in list(paragraph.runs):
        run._element.getparent().remove(run._element)


def clear_paragraph(paragraph):
    """Remove text and any inline drawing/image content."""
    for child in list(paragraph._p):
        tag = child.tag.rsplit("}", 1)[-1]
        if tag != "pPr":
            paragraph._p.remove(child)


def insert_paragraph_after(
    paragraph,
    text="",
    *,
    style=None,
    remaining_emphasis_phrases=None,
    bold=False,
    italic=False,
    color=None,
    size=None,
):
    new_p = OxmlElement("w:p")
    paragraph._p.addnext(new_p)
    from docx.text.paragraph import Paragraph

    para = Paragraph(new_p, paragraph._parent)
    if style is not None:
        try:
            para.style = style
        except KeyError:
            pass
    if text:
        add_text_with_emphasis(
            para,
            text,
            remaining_emphasis_phrases=remaining_emphasis_phrases,
            bold=bold,
            italic=italic,
            color=color,
            size=size,
        )
    para.paragraph_format.space_after = Pt(7)
    return para


def apply_body_paragraph_format(paragraph):
    paragraph.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    paragraph.paragraph_format.line_spacing = 1.15


def remove_body_elements_after(paragraph):
    """Remove every body element after `paragraph` until the section properties."""
    current = paragraph._p.getnext()
    while current is not None:
        next_element = current.getnext()
        tag = current.tag.rsplit("}", 1)[-1]
        if tag == "sectPr":
            break
        current.getparent().remove(current)
        current = next_element


def find_paragraph_index(paragraphs, target):
    """Find a paragraph index by XML node identity after document edits."""
    for i, paragraph in enumerate(paragraphs):
        if paragraph._p is target._p:
            return i
    raise ValueError("target paragraph not found")


def add_callout(doc, anchor, value):
    table = doc.add_table(rows=1, cols=1)
    cell = table.cell(0, 0)
    tcPr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:fill"), "E6F4F5")
    tcPr.append(shd)
    run = cell.paragraphs[0].add_run(value)
    set_run_font(run, bold=True, color=GRAY)
    # move the table after `anchor`
    table._element.addnext  # touch to ensure order
    return table


def set_printable_table_borders(table):
    """Use actual Word borders, never editor-only gridlines or inherited styles."""
    properties = table._tbl.tblPr
    old = properties.find(qn("w:tblBorders"))
    if old is not None:
        properties.remove(old)
    borders = OxmlElement("w:tblBorders")
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        border = OxmlElement("w:" + edge)
        for key, value in (("val", "single"), ("sz", "6"), ("space", "0"), ("color", "53565A")):
            border.set(qn("w:" + key), value)
        borders.append(border)
    properties.append(borders)


def validate_spec(spec):
    for key in ("template", "date", "to", "from", "subject", "signatory"):
        if not isinstance(spec.get(key), str) or not spec[key].strip():
            raise ValueError(f"Missing required field: {key}")
    signature_type = spec.get("signature_type", "person")
    if signature_type not in ("person", "department"):
        raise ValueError("signature_type must be person or department")
    if signature_type == "person" and (not isinstance(spec.get("designation"), str) or not spec["designation"].strip()):
        raise ValueError("A personal signature requires the supplied job title")
    if signature_type == "person" and len(spec["signatory"].split()) < 2:
        raise ValueError("signatory must contain the supplied first and last name")
    blocks = spec.get("body", {}).get("blocks")
    if not isinstance(blocks, list) or not blocks:
        raise ValueError("body.blocks must be a non-empty ordered list")
    allowed = {"paragraphs", "headings", "bullets", "numbered", "tables", "callouts"}
    for block in blocks:
        if not isinstance(block, dict) or block.get("type") not in allowed:
            raise ValueError("Unknown body block type")
        values = block.get("value")
        if not isinstance(values, list) or not values:
            raise ValueError("Each block value must be a non-empty list")
        if block["type"] == "tables":
            for table in values:
                headers, rows = table.get("headers"), table.get("rows")
                if not headers or not rows or any(len(row) != len(headers) for row in rows):
                    raise ValueError("Tables require headers and equally sized rows")
        elif any(not isinstance(value, str) for value in values):
            raise ValueError("Text block values must be strings")


def normalise_styles(doc):
    # Match AESG's validator using XML objects, never regex replacements.
    for style in doc.styles:
        if style.type in (1, 2):
            style.font.name = FONT
    for name, size, color in (("Heading 1", 12, GREEN), ("Heading 2", 9, "53565A")):
        style = doc.styles[name]
        style.font.name = FONT
        style.font.size = Pt(size)
        style.font.color.rgb = RGBColor.from_string(color)
    doc.styles["Normal"].font.name = FONT


def normalise_package_fonts(path, template_path):
    # Preserve header/footer XML and media bytes. Normalize styles and theme only.
    with ZipFile(template_path) as source:
        furniture = {name: source.read(name) for name in source.namelist()
                     if name.startswith(("word/header", "word/footer", "word/media/", "word/_rels/header", "word/_rels/footer"))}
    with ZipFile(path) as archive:
        entries = [(item, archive.read(item.filename)) for item in archive.infolist()]
    with ZipFile(path, "w", ZIP_DEFLATED) as archive:
        for item, data in entries:
            if item.filename in ("word/styles.xml", "word/stylesWithEffects.xml"):
                tree = etree.fromstring(data)
                for fonts in tree.iter(qn("w:rFonts")):
                    for attr in list(fonts.attrib):
                        if etree.QName(attr).localname.lower().endswith("theme"):
                            del fonts.attrib[attr]
                    for attr in ("ascii", "hAnsi", "eastAsia", "cs"):
                        fonts.set(qn("w:" + attr), FONT)
                data = etree.tostring(tree, xml_declaration=True, encoding="UTF-8", standalone=True)
            elif item.filename.startswith("word/theme/") and item.filename.endswith(".xml"):
                tree = etree.fromstring(data)
                for element in tree.iter():
                    if element.get("typeface"):
                        element.set("typeface", FONT)
                data = etree.tostring(tree, xml_declaration=True, encoding="UTF-8", standalone=True)
            archive.writestr(item, furniture.get(item.filename, data))


def build(spec, template_path, output_path):
    template_key = spec.get("template", "Operational")
    if template_key not in TEMPLATES:
        raise ValueError(f"unknown template key: {template_key}")

    validate_spec(spec)
    doc = Document(template_path)
    normalise_styles(doc)
    indices = find_body_block_indices(doc)
    if -1 in indices.values():
        raise ValueError("template does not match expected memo layout")

    title_text = spec.get("title") or TEMPLATES[template_key]["default_title"]
    remaining_emphasis_phrases = set(extract_emphasis_phrases(spec))
    paragraphs = list(doc.paragraphs)

    # 1. Title is the first paragraph (Heading 1). Preserve its style.
    title_para = paragraphs[0]
    if title_para.runs:
        title_run = title_para.runs[0]
        title_run.text = title_text
        for run in title_para.runs[1:]:
            run.text = ""
    else:
        title_run = title_para.add_run(title_text)
    set_run_font(title_run, bold=True)

    # 2. Date / To / From lines.
    update_field(paragraphs[indices["body"]], "Date", spec["date"], tabs=2)
    update_field(paragraphs[indices["to"]], "To", spec["to"], tabs=2)
    update_field(paragraphs[indices["from"]], "From", spec["from"], tabs=2)
    update_field(paragraphs[indices["subject"]], "Subject", spec["subject"], tabs=1)

    # 3. Salutation.
    salutation = spec.get("salutation", "Dear All,")
    salutation_para = paragraphs[indices["salutation"]]
    clear_paragraph(salutation_para)
    salutation_run = salutation_para.add_run(salutation)
    set_run_font(salutation_run, bold=False)
    apply_body_paragraph_format(salutation_para)
    blank_para = insert_paragraph_after(salutation_para, "")
    apply_body_paragraph_format(blank_para)

    # 4. Replace the body (between rule and closing) with user content.
    body_anchor = paragraphs[indices["salutation"]]
    body_anchor_idx = indices["salutation"]

    # Remove everything between salutation+1 and closing-1 (the lorem block).
    to_remove = paragraphs[body_anchor_idx + 1 : indices["closing"]]
    for para in to_remove:
        para._p.getparent().remove(para._p)

    # Re-read paragraphs after deletion.
    paragraphs = list(doc.paragraphs)
    closing_para = None
    for p in paragraphs:
        if p.text.startswith("Your ") and "Department," in p.text:
            closing_para = p
            break
    if closing_para is None:
        raise ValueError("closing paragraph not found after edit")

    # Insert content blocks before the closing paragraph.
    def add_paragraph_before_closing(text, *, style="Normal"):
        return insert_paragraph_after(
            last_anchor, text, style=style
        )

    last_anchor = blank_para

    def insert_block(kind, value):
        nonlocal last_anchor
        if kind == "paragraphs":
            for para in value:
                new = insert_paragraph_after(
                    last_anchor,
                    para,
                    remaining_emphasis_phrases=remaining_emphasis_phrases,
                )
                last_anchor = new
        elif kind == "bullets":
            for item in value:
                bullet = insert_paragraph_after(
                    last_anchor,
                    f"\u2022 {item}",
                    remaining_emphasis_phrases=remaining_emphasis_phrases,
                )
                bullet.paragraph_format.left_indent = Pt(18)
                last_anchor = bullet
        elif kind == "numbered":
            for i, item in enumerate(value, start=1):
                bullet = insert_paragraph_after(
                    last_anchor,
                    f"{i}. {item}",
                    remaining_emphasis_phrases=remaining_emphasis_phrases,
                )
                bullet.paragraph_format.left_indent = Pt(18)
                last_anchor = bullet
        elif kind == "headings":
            for heading in value:
                new = insert_paragraph_after(
                    last_anchor,
                    heading,
                    bold=True,
                    color="53565A",
                    size=9,
                )
                last_anchor = new
        elif kind == "tables":
            for table_spec in value:
                caption = table_spec.get("caption")
                if caption:
                    cap = insert_paragraph_after(
                        last_anchor,
                        caption,
                        bold=True,
                        italic=True,
                        color=GRAY,
                        size=9,
                    )
                    last_anchor = cap
                headers = table_spec.get("headers", [])
                rows = table_spec.get("rows", [])
                if not headers or not rows:
                    continue
                tbl = doc.add_table(rows=1 + len(rows), cols=len(headers))
                tbl.autofit = True
                set_printable_table_borders(tbl)
                for i, header in enumerate(headers):
                    cell = tbl.rows[0].cells[i]
                    tcPr = cell._tc.get_or_add_tcPr()
                    shd = OxmlElement("w:shd")
                    shd.set(qn("w:fill"), WHITE)
                    tcPr.append(shd)
                    cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
                    run = cell.paragraphs[0].add_run(header)
                    set_run_font(run, bold=True, color=GRAY)
                for r_i, row in enumerate(rows):
                    for c_i, cell_value in enumerate(row):
                        cell = tbl.rows[r_i + 1].cells[c_i]
                        cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
                        run = cell.paragraphs[0].add_run(str(cell_value))
                        set_run_font(run)
                # relocate table to be just after last_anchor
                closing_p = closing_para._p
                closing_p.addprevious(tbl._element)
                # blank spacer paragraph
                spacer = OxmlElement("w:p")
                closing_p.addprevious(spacer)
                from docx.text.paragraph import Paragraph

                last_anchor = Paragraph(spacer, closing_para._parent)
        elif kind == "callouts":
            for text in value:
                tbl = doc.add_table(rows=1, cols=1)
                cell = tbl.cell(0, 0)
                tcPr = cell._tc.get_or_add_tcPr()
                shd = OxmlElement("w:shd")
                shd.set(qn("w:fill"), "E6F4F5")
                tcPr.append(shd)
                run = cell.paragraphs[0].add_run(text)
                set_run_font(run, bold=True, color=GRAY)
                closing_p = closing_para._p
                closing_p.addprevious(tbl._element)
                spacer = OxmlElement("w:p")
                closing_p.addprevious(spacer)
                from docx.text.paragraph import Paragraph

                last_anchor = Paragraph(spacer, closing_para._parent)
        else:
            raise ValueError(f"unknown body block kind: {kind}")

    for block in spec["body"]["blocks"]:
        insert_block(block["type"], block["value"])

    blank_before_closing = insert_paragraph_after(last_anchor, "")

    # 5. Closing department line.
    closing_text = (
        (spec["signatory"].strip() if spec.get("signature_type") == "department" else None)
        or spec.get("closing_department")
        or TEMPLATES[template_key]["closing_department"]
    )
    for run in list(closing_para.runs):
        run.text = ""
    closing_run = closing_para.add_run(closing_text)
    set_run_font(closing_run, bold=False)
    apply_body_paragraph_format(closing_para)

    # 6. Signatory / designation / follow line.
    paragraphs = list(doc.paragraphs)
    closing_idx = find_paragraph_index(paragraphs, closing_para)
    if spec.get("signature_type") == "department":
        follow_text = (spec.get("designation") or "").strip()
    else:
        follow_text = f"{spec['signatory'].strip()}\n{spec['designation'].strip()}"
    # Replace the paragraph just after the closing.
    if closing_idx + 1 < len(paragraphs):
        follow_para = paragraphs[closing_idx + 1]
    else:
        follow_para = insert_paragraph_after(closing_para)
    clear_paragraph(follow_para)
    follow_run = follow_para.add_run(follow_text)
    set_run_font(follow_run, bold=True)
    follow_para.alignment = WD_ALIGN_PARAGRAPH.LEFT
    follow_para.paragraph_format.keep_together = True
    closing_para.paragraph_format.keep_with_next = True
    remove_body_elements_after(follow_para)

    # 7. Enforce Verdana and brand colour on every run that has text.
    for para in doc.paragraphs:
        if para.text.strip() and para not in (title_para, follow_para):
            apply_body_paragraph_format(para)
        for run in para.runs:
            if run.text.strip():
                # do not override the title's bold or callout colours, but
                # ensure font family is Verdana
                set_run_font(run)
    for table in doc.tables:
        for row in table.rows:
            for cell in row.cells:
                for para in cell.paragraphs:
                    para.alignment = WD_ALIGN_PARAGRAPH.LEFT
                    para.paragraph_format.line_spacing = 1.15
                    for run in para.runs:
                        if run.text.strip():
                            set_run_font(run)

    follow_para.alignment = WD_ALIGN_PARAGRAPH.LEFT

    # 8. Set core properties.
    doc.core_properties.title = title_text
    doc.core_properties.author = "AESG"
    doc.core_properties.last_modified_by = "AESG"
    doc.core_properties.subject = spec.get("subject", "")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    doc.save(output_path)
    normalise_package_fonts(output_path, template_path)
    return output_path


def parse_spec(value):
    if value is None:
        return {}
    if isinstance(value, (dict, list)):
        return value
    text = value.strip()
    if not text:
        return {}
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # treat as a path
        return json.loads(Path(text).read_text(encoding="utf-8"))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--template", required=True)
    parser.add_argument("--spec", required=True, help="JSON string or path")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    spec = parse_spec(args.spec)
    build(spec, Path(args.template), Path(args.output))
    print(json.dumps({"ok": True, "output": str(args.output)}))


if __name__ == "__main__":
    main()
