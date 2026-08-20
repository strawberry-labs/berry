#!/usr/bin/env python3
"""Create an AESG report or letter from retained Word templates."""

from __future__ import annotations

import argparse
import copy
import json
import os
import sys
import tempfile
import zipfile
from pathlib import Path

from docx import Document
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor


GREEN = "008C95"
GRAY = "343741"
WHITE = "FFFFFF"
TABLE_TEAL = "069B9B"
TABLE_BAND = "F2F2F2"
TABLE_BORDER = "A6A6A6"
FONT = "Verdana"
REPORT_USABLE_WIDTH_DXA = 10460
CELL_MARGIN_DXA = 120
REPORT_CELL_MARGIN_DXA = 108
REPORT_TABLE_INDENT_DXA = 0
LETTER_TEXT = "53565A"
LETTER_BODY_PT = 9.0
LETTER_SUBJECT_PT = 12.0
LETTER_BLOCK_LINE_PT = 13.8
REPORT_BODY_PT = 10.0
REPORT_BODY_COLOR = GRAY
REPORT_HEADING_COLOR = GREEN
REPORT_HEADING_SIZES = {1: 22.0, 2: 16.0, 3: 14.0}
REPORT_BODY_LINE_SPACING = 1.15
REPORT_BODY_SPACE_PT = 3.0
REPORT_HEADING_SPACING_PT = {1: (10.0, 0.0), 2: (4.0, 0.0), 3: (4.0, 0.0)}
REPORT_CAPTION_PT = 9.0
REPORT_CAPTION_COLOR = "04999A"
REPORT_FIGURE_CAPTION_COLOR = GREEN
REPORT_CONTENT_TOP_DXA = 1701
REPORT_LANDSCAPE_TOP_DXA = 720
LETTER_KINDS = {
    "letter",
    "letterhead",
    "leave-request",
    "leave_request",
    "memo",
    "simple",
    "simple-document",
    "simple_document",
}


def report_template(branding_skill_dir: Path) -> Path:
    return branding_skill_dir / "assets/templates/AESG_General_Report_Template.docx"


def letter_template(branding_skill_dir: Path) -> Path:
    return branding_skill_dir / "assets/templates/AESG_Letterhead_Dubai.docx"


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


def clear_text_highlight(element) -> None:
    """Remove specimen highlighting from an entire generated footer story."""

    for properties in element.xpath('.//*[local-name()="rPr"]'):
        for child in list(properties):
            if child.tag.rsplit("}", 1)[-1] in {"highlight", "shd"}:
                properties.remove(child)


def remove_page_breaks(element) -> None:
    for br in list(element.xpath('.//*[local-name()="br"]')):
        if br.get(qn("w:type")) == "page":
            br.getparent().remove(br)


def source_parts(document: Document):
    body = document._element.body
    children = list(body)
    cover = None
    approval = None
    divider = None
    section_properties = []
    for index, child in enumerate(children):
        tag = child.tag.rsplit("}", 1)[-1]
        value = normalise(text_of(child))
        if tag == "sdt" and "report title" in value and "project name" in value:
            cover = copy.deepcopy(child)
        elif tag == "tbl" and "prepared by" in value and "ref. no." in value:
            approval = copy.deepcopy(child)
        elif tag == "p" and "section heading i" in value and child.xpath(
            './/*[local-name()="drawing" or local-name()="pict"]'
        ):
            start = None
            for candidate_index in range(index - 1, max(index - 5, -1), -1):
                candidate = children[candidate_index]
                if candidate.xpath(
                    './/*[local-name()="blip"]/@*[local-name()="embed"]'
                ):
                    start = candidate_index
                    break
            if start is not None:
                divider = [copy.deepcopy(element) for element in children[start : index + 1]]
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


def set_section_top_margin(section_properties, top_dxa: int) -> None:
    page_margins = section_properties.find(qn("w:pgMar"))
    if page_margins is None:
        page_margins = OxmlElement("w:pgMar")
        section_properties.append(page_margins)
    page_margins.set(qn("w:top"), str(top_dxa))


def set_section_page_number_start(section_properties, start: int | None = None) -> None:
    page_number = section_properties.find(qn("w:pgNumType"))
    if start is None:
        if page_number is not None:
            section_properties.remove(page_number)
        return
    if page_number is None:
        page_number = OxmlElement("w:pgNumType")
        section_properties.append(page_number)
    page_number.set(qn("w:start"), str(start))


def style_by_name(document: Document, *names: str):
    styles = list(document.styles)
    for name in names:
        wanted = name.casefold()
        for style in styles:
            if style.name and style.name.casefold() == wanted:
                return style
    return None


def set_run_font(
    run,
    *,
    bold: bool | None = None,
    italic: bool | None = None,
    size_pt: float | None = None,
    color: str | None = None,
) -> None:
    run.font.name = FONT
    fonts = run._element.get_or_add_rPr().get_or_add_rFonts()
    fonts.set(qn("w:ascii"), FONT)
    fonts.set(qn("w:hAnsi"), FONT)
    fonts.set(qn("w:eastAsia"), FONT)
    fonts.set(qn("w:cs"), FONT)
    if bold is not None:
        run.bold = bold
    if italic is not None:
        run.italic = italic
    if size_pt is not None:
        run.font.size = Pt(size_pt)
    if color is not None:
        run.font.color.rgb = RGBColor.from_string(color)


def add_text(
    document: Document,
    value: str,
    *style_names: str,
    bold: bool | None = None,
    italic: bool | None = None,
    size_pt: float | None = None,
    color: str | None = None,
    space_before_pt: float | None = None,
    space_after_pt: float | None = None,
    line_spacing_pt: float | None = None,
    line_spacing: float | None = None,
):
    style = style_by_name(document, *style_names)
    paragraph = document.add_paragraph(style=style)
    paragraph.alignment = WD_ALIGN_PARAGRAPH.LEFT
    if any("heading" in name.casefold() or name.casefold().startswith("aesg main") or name.casefold().startswith("aesg sub") or name.casefold() == "aesg h2" for name in style_names):
        paragraph.paragraph_format.keep_with_next = True
        paragraph.paragraph_format.keep_together = True
    if style is None:
        paragraph.paragraph_format.space_after = Pt(7)
    if space_before_pt is not None:
        paragraph.paragraph_format.space_before = Pt(space_before_pt)
    if space_after_pt is not None:
        paragraph.paragraph_format.space_after = Pt(space_after_pt)
    if line_spacing_pt is not None:
        paragraph.paragraph_format.line_spacing = Pt(line_spacing_pt)
    if line_spacing is not None:
        paragraph.paragraph_format.line_spacing = line_spacing
    run = paragraph.add_run(str(value))
    set_run_font(
        run,
        bold=bold,
        italic=italic,
        size_pt=size_pt,
        color=color,
    )
    return paragraph


def shade(cell, fill: str) -> None:
    properties = cell._tc.get_or_add_tcPr()
    shading = properties.find(qn("w:shd"))
    if shading is None:
        shading = OxmlElement("w:shd")
        properties.append(shading)
    shading.set(qn("w:fill"), fill)


def set_cell_margins(cell, value: int = CELL_MARGIN_DXA) -> None:
    properties = cell._tc.get_or_add_tcPr()
    margins = properties.find(qn("w:tcMar"))
    if margins is None:
        margins = OxmlElement("w:tcMar")
        properties.append(margins)
    for side in ("top", "start", "bottom", "end"):
        node = margins.find(qn(f"w:{side}"))
        if node is None:
            node = OxmlElement(f"w:{side}")
            margins.append(node)
        node.set(qn("w:w"), str(value))
        node.set(qn("w:type"), "dxa")


def set_repeat_table_header(row) -> None:
    properties = row._tr.get_or_add_trPr()
    marker = properties.find(qn("w:tblHeader"))
    if marker is None:
        marker = OxmlElement("w:tblHeader")
        properties.append(marker)
    marker.set(qn("w:val"), "true")


def usable_width_dxa(document: Document) -> int:
    section = document.sections[-1]
    dimensions = (section.page_width, section.left_margin, section.right_margin)
    if any(value is None for value in dimensions):
        return REPORT_USABLE_WIDTH_DXA
    return int(section.page_width.twips - section.left_margin.twips - section.right_margin.twips)


def table_width_dxa(
    document: Document,
    spec: dict | None = None,
    *,
    report: bool = True,
) -> int:
    """Return a source-pattern width instead of Word's auto-fit width."""

    spec = spec or {}
    if not report:
        return usable_width_dxa(document) - CELL_MARGIN_DXA
    requested = spec.get("tableWidthDxa")
    if requested is not None:
        value = int(requested)
        if value <= 0:
            raise ValueError("table.tableWidthDxa must be positive")
        return value
    pattern = str(spec.get("pattern", "")).casefold()
    count = len(spec.get("headers", []))
    if pattern in {"monitoring", "monitoring-summary", "landscape"}:
        return usable_width_dxa(document)
    if pattern in {"images", "image", "with-images"} and count == 3:
        return 10608
    if count == 2:
        return 10198
    if count == 3:
        return 10380
    return usable_width_dxa(document)


def column_widths(spec: dict, count: int, total_width_dxa: int) -> list[int]:
    requested = spec.get("widths")
    if requested is None:
        weights = [1.0] * count
    else:
        if not isinstance(requested, list) or len(requested) != count:
            raise ValueError("table.widths must contain one positive value per header")
        weights = [float(value) for value in requested]
        if any(value <= 0 for value in weights):
            raise ValueError("table.widths values must be positive")
    total = sum(weights)
    widths = [round(total_width_dxa * value / total) for value in weights]
    widths[-1] += total_width_dxa - sum(widths)
    return widths


def set_table_borders(table, *, colour: str = TABLE_BORDER) -> None:
    properties = table._tbl.tblPr
    borders = properties.find(qn("w:tblBorders"))
    if borders is None:
        borders = OxmlElement("w:tblBorders")
        properties.append(borders)
    for edge in ("top", "bottom", "insideH"):
        node = borders.find(qn(f"w:{edge}"))
        if node is None:
            node = OxmlElement(f"w:{edge}")
            borders.append(node)
        node.set(qn("w:val"), "single")
        node.set(qn("w:sz"), "4")
        node.set(qn("w:space"), "0")
        node.set(qn("w:color"), colour)
    for edge in ("left", "right", "insideV"):
        node = borders.find(qn(f"w:{edge}"))
        if node is None:
            node = OxmlElement(f"w:{edge}")
            borders.append(node)
        node.set(qn("w:val"), "nil")


def set_table_geometry(
    table,
    widths: list[int],
    *,
    indent_dxa: int = REPORT_TABLE_INDENT_DXA,
    cell_margin_dxa: int = REPORT_CELL_MARGIN_DXA,
) -> None:
    table.autofit = False
    properties = table._tbl.tblPr
    width = properties.find(qn("w:tblW"))
    if width is None:
        width = OxmlElement("w:tblW")
        properties.append(width)
    width.set(qn("w:w"), str(sum(widths)))
    width.set(qn("w:type"), "dxa")
    indent = properties.find(qn("w:tblInd"))
    if indent is None:
        indent = OxmlElement("w:tblInd")
        properties.append(indent)
    indent.set(qn("w:w"), str(indent_dxa))
    indent.set(qn("w:type"), "dxa")
    layout = properties.find(qn("w:tblLayout"))
    if layout is None:
        layout = OxmlElement("w:tblLayout")
        properties.append(layout)
    layout.set(qn("w:type"), "fixed")
    grid = table._tbl.tblGrid
    for child in list(grid):
        grid.remove(child)
    for value in widths:
        column = OxmlElement("w:gridCol")
        column.set(qn("w:w"), str(value))
        grid.append(column)
    for row in table.rows:
        for cell, value in zip(row.cells, widths):
            cell_properties = cell._tc.get_or_add_tcPr()
            cell_width = cell_properties.find(qn("w:tcW"))
            if cell_width is None:
                cell_width = OxmlElement("w:tcW")
                cell_properties.append(cell_width)
            cell_width.set(qn("w:w"), str(value))
            cell_width.set(qn("w:type"), "dxa")
            set_cell_margins(cell, cell_margin_dxa)


def set_paragraph_cell_format(
    paragraph,
    *,
    alignment: WD_ALIGN_PARAGRAPH = WD_ALIGN_PARAGRAPH.LEFT,
    before_pt: float = 0.0,
    after_pt: float = 0.0,
    line_spacing: float = REPORT_BODY_LINE_SPACING,
) -> None:
    paragraph.alignment = alignment
    paragraph.paragraph_format.space_before = Pt(before_pt)
    paragraph.paragraph_format.space_after = Pt(after_pt)
    paragraph.paragraph_format.line_spacing = line_spacing


def add_cell_value(
    cell,
    value,
    *,
    font_size_pt: float | None,
    font_color: str | None,
    bold: bool = False,
    alignment: WD_ALIGN_PARAGRAPH = WD_ALIGN_PARAGRAPH.LEFT,
    max_width_inches: float | None = None,
) -> None:
    paragraph = cell.paragraphs[0]
    set_paragraph_cell_format(paragraph, alignment=alignment)
    if isinstance(value, dict):
        text = value.get("text", "")
        image_path = value.get("image", value.get("path"))
        if image_path:
            path = Path(str(image_path))
            if not path.is_file():
                raise FileNotFoundError(f"table image not found: {path}")
            width = float(value.get("widthInches", value.get("width", 1.1)))
            if max_width_inches is not None:
                width = min(width, max_width_inches)
            picture_run = paragraph.add_run()
            picture_run.add_picture(str(path), width=Inches(width))
        if text:
            run = paragraph.add_run(str(text))
            set_run_font(run, bold=bold, size_pt=font_size_pt, color=font_color)
        return
    run = paragraph.add_run(str(value))
    set_run_font(run, bold=bold, size_pt=font_size_pt, color=font_color)


def add_table(
    document: Document,
    spec: dict,
    *,
    font_size_pt: float | None = None,
    font_color: str | None = None,
    report: bool = True,
) -> None:
    headers = [str(value) for value in spec.get("headers", [])]
    rows = list(spec.get("rows", []))
    if not headers:
        return
    table = document.add_table(rows=1, cols=len(headers))
    pattern = str(spec.get("pattern", "")).casefold()
    image_pattern = pattern in {"images", "image", "with-images"}
    monitoring_pattern = pattern in {"monitoring", "monitoring-summary", "landscape"}
    preferred = style_by_name(
        document,
        "Plain Table 4",
        "PlainTable4",
        "AESG Table",
        "Table Grid",
    )
    if preferred is not None:
        table.style = preferred
    widths = column_widths(
        spec,
        len(headers),
        table_width_dxa(document, spec, report=report),
    )
    header_alignment = (
        WD_ALIGN_PARAGRAPH.CENTER
        if pattern in {"monitoring", "monitoring-summary", "landscape"}
        else WD_ALIGN_PARAGRAPH.LEFT
    )
    for index, header in enumerate(headers):
        cell = table.rows[0].cells[index]
        if not image_pattern:
            shade(cell, TABLE_TEAL)
        cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
        add_cell_value(
            cell,
            header,
            font_size_pt=font_size_pt,
            font_color=(REPORT_BODY_COLOR if index == 0 else TABLE_TEAL)
            if image_pattern
            else WHITE,
            bold=True,
            alignment=header_alignment,
        )
    set_repeat_table_header(table.rows[0])
    for row_index, row_values in enumerate(rows):
        if isinstance(row_values, dict):
            values = row_values.get("values", row_values.get("cells", []))
            if not values:
                values = [row_values.get(header, "") for header in headers]
        else:
            values = list(row_values)
        cells = table.add_row().cells
        for index, cell in enumerate(cells):
            value = values[index] if index < len(values) else ""
            if monitoring_pattern:
                fill = "D1D1D1" if row_index % 2 == 0 else "E9E9EA"
                if index in {0, len(cells) - 1}:
                    fill = "808080" if row_index % 2 == 0 else "95999E"
                shade(cell, fill)
                cell_alignment = WD_ALIGN_PARAGRAPH.CENTER if index == 0 else WD_ALIGN_PARAGRAPH.LEFT
                cell_color = WHITE if index in {0, len(cells) - 1} else font_color
            else:
                shade(cell, TABLE_BAND if row_index % 2 == 0 else WHITE)
                cell_alignment = (
                    WD_ALIGN_PARAGRAPH.CENTER
                    if image_pattern and isinstance(value, dict) and value.get("image", value.get("path"))
                    else WD_ALIGN_PARAGRAPH.LEFT
                )
                cell_color = font_color
            max_width = max((widths[index] / 1440.0) - 0.2, 0.45)
            add_cell_value(
                cell,
                value,
                font_size_pt=font_size_pt,
                font_color=cell_color,
                alignment=cell_alignment,
                max_width_inches=max_width,
            )
            cell.vertical_alignment = (
                WD_CELL_VERTICAL_ALIGNMENT.TOP
                if image_pattern or monitoring_pattern
                else WD_CELL_VERTICAL_ALIGNMENT.CENTER
            )
    for span in spec.get("rowSpans", []):
        if not isinstance(span, dict):
            raise ValueError("table.rowSpans must contain objects")
        column = int(span.get("column", -1))
        start = int(span.get("start", -1))
        length = int(span.get("span", 0))
        if column < 0 or column >= len(headers) or start < 0 or length < 2 or start + length > len(rows):
            raise ValueError("table.rowSpans contains an invalid column, start, or span")
        for row_number in range(start + 1, start + length):
            table.cell(row_number + 1, column).text = ""
        merged = table.cell(start + 1, column).merge(table.cell(start + length, column))
        if monitoring_pattern and column in {0, len(headers) - 1}:
            shade(merged, "808080")
            merged.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.TOP
    set_table_geometry(
        table,
        widths,
        indent_dxa=REPORT_TABLE_INDENT_DXA if report else CELL_MARGIN_DXA,
        cell_margin_dxa=REPORT_CELL_MARGIN_DXA if report else CELL_MARGIN_DXA,
    )
    set_table_borders(table, colour=TABLE_BORDER)
    spacer = document.add_paragraph()
    spacer.paragraph_format.space_before = Pt(0)
    spacer.paragraph_format.space_after = Pt(0)
    spacer.paragraph_format.line_spacing = 1.0


def add_callout(
    document: Document,
    value: str,
    *,
    font_size_pt: float | None = None,
    font_color: str = GRAY,
    report: bool = True,
) -> None:
    table = document.add_table(rows=1, cols=1)
    cell = table.cell(0, 0)
    shade(cell, "E6F4F5")
    paragraph = cell.paragraphs[0]
    run = paragraph.add_run(value)
    set_run_font(run, bold=True, size_pt=font_size_pt, color=font_color)
    set_table_geometry(
        table,
        [table_width_dxa(document, report=report)],
        indent_dxa=REPORT_TABLE_INDENT_DXA if report else CELL_MARGIN_DXA,
        cell_margin_dxa=REPORT_CELL_MARGIN_DXA if report else CELL_MARGIN_DXA,
    )
    set_table_borders(table, colour="E6F4F5")
    spacer = document.add_paragraph()
    spacer.paragraph_format.space_before = Pt(0)
    spacer.paragraph_format.space_after = Pt(0)
    spacer.paragraph_format.line_spacing = 1.0


def add_image(
    document: Document,
    image_spec,
    *,
    font_size_pt: float | None = None,
    font_color: str | None = None,
    line_spacing: float | None = None,
) -> None:
    if isinstance(image_spec, str):
        image_spec = {"path": image_spec}
    path = Path(str(image_spec.get("path", "")))
    if not path.is_file():
        raise FileNotFoundError(f"image not found: {path}")
    width = float(image_spec.get("widthInches", image_spec.get("width", 6.2)))
    width = min(width, max((usable_width_dxa(document) / 1440.0) - 0.1, 1.0))
    paragraph = document.add_paragraph()
    paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
    paragraph.paragraph_format.keep_with_next = bool(image_spec.get("caption"))
    paragraph.paragraph_format.space_before = Pt(0)
    paragraph.paragraph_format.space_after = Pt(0)
    paragraph.add_run().add_picture(str(path), width=Inches(width))
    if image_spec.get("caption"):
        paragraph.paragraph_format.keep_with_next = True
        caption = add_text(
            document,
            str(image_spec["caption"]),
            "AESG Figure Captions",
            "Caption",
            bold=False,
            italic=True,
            size_pt=REPORT_CAPTION_PT,
            color=REPORT_FIGURE_CAPTION_COLOR,
            space_before_pt=0,
            space_after_pt=6.0,
            line_spacing=line_spacing,
        )
        caption.alignment = WD_ALIGN_PARAGRAPH.CENTER
        caption.paragraph_format.keep_with_next = bool(image_spec.get("source"))
    if image_spec.get("source"):
        add_text(
            document,
            f"Source: {image_spec['source']}",
            "AESG Body Text",
            "Normal",
            bold=False,
            italic=True,
            size_pt=font_size_pt,
            color=font_color,
            line_spacing=line_spacing,
        )


def add_divider(
    document: Document,
    heading: str,
    divider_source,
    *,
    start_on_new_page: bool,
) -> None:
    if start_on_new_page:
        document.add_page_break()
    divider = [copy.deepcopy(element) for element in divider_source]
    for element in divider:
        replace_leaf_text(element, {"Section Heading II": heading})
    next_shape_id = max(
        [
            int(node.get("id"))
            for node in document._element.xpath(
                './/*[local-name()="docPr" or local-name()="cNvPr"]'
            )
            if str(node.get("id", "")).isdigit()
        ]
        or [0]
    ) + 1
    for element in divider:
        for node in element.xpath('.//*[local-name()="docPr" or local-name()="cNvPr"]'):
            node.set("id", str(next_shape_id))
            next_shape_id += 1
        for node in element.xpath('.//*[local-name()="shape"]'):
            if str(node.get("id", "")).startswith("_x0000_s"):
                node.set("id", f"_x0000_s{next_shape_id}")
                next_shape_id += 1
        append_before_final_section(document, element)


def section_is_landscape(section: dict) -> bool:
    if str(section.get("orientation", "")).casefold() == "landscape":
        return True
    table = section.get("table")
    return isinstance(table, dict) and str(table.get("pattern", "")).casefold() in {
        "monitoring",
        "monitoring-summary",
        "landscape",
    }


def add_sections(
    document: Document,
    sections: list[dict],
    divider_source=None,
    *,
    portrait_section=None,
    landscape_section=None,
) -> None:
    in_landscape = False
    for index, section in enumerate(sections):
        wants_landscape = section_is_landscape(section)
        if wants_landscape != in_landscape and landscape_section is not None and portrait_section is not None:
            # A sectPr on the paragraph before the content closes the current
            # section; the body-level sectPr then governs the new content.
            add_section_break(document, portrait_section if wants_landscape else landscape_section)
            set_final_section(
                document,
                landscape_section if wants_landscape else portrait_section,
            )
            in_landscape = wants_landscape
        heading = str(section.get("heading", "")).strip()
        if section.get("divider") and heading and divider_source is not None:
            add_divider(
                document,
                heading,
                divider_source,
                start_on_new_page=index > 0,
            )
        elif section.get("pageBreak") and (index or document.paragraphs):
            document.add_page_break()
        if heading:
            level = min(max(int(section.get("level", 1)), 1), 3)
            styles = {
                1: ("AESG Main Heading", "Heading 1"),
                2: ("AESG Sub H1", "Heading 2"),
                3: ("AESG H2", "Heading 3"),
            }[level]
            heading_before, heading_after = REPORT_HEADING_SPACING_PT[level]
            heading_paragraph = add_text(
                document,
                heading,
                *styles,
                size_pt=REPORT_HEADING_SIZES[level],
                color=REPORT_HEADING_COLOR,
                space_before_pt=heading_before,
                space_after_pt=heading_after,
                line_spacing=1.0,
            )
            if section.get("headingNumbered") is False:
                properties = heading_paragraph._p.get_or_add_pPr()
                numbering = properties.find(qn("w:numPr"))
                if numbering is None:
                    numbering = OxmlElement("w:numPr")
                    properties.append(numbering)
                ilvl = numbering.find(qn("w:ilvl"))
                if ilvl is None:
                    ilvl = OxmlElement("w:ilvl")
                    numbering.append(ilvl)
                ilvl.set(qn("w:val"), "0")
                num_id = numbering.find(qn("w:numId"))
                if num_id is None:
                    num_id = OxmlElement("w:numId")
                    numbering.append(num_id)
                num_id.set(qn("w:val"), "0")
        for paragraph in section.get("paragraphs", []):
            value = paragraph.get("text", "") if isinstance(paragraph, dict) else paragraph
            add_text(
                document,
                str(value),
                "AESG Body Text",
                "Normal",
                bold=False,
                italic=False,
                size_pt=REPORT_BODY_PT,
                color=REPORT_BODY_COLOR,
                space_before_pt=0,
                space_after_pt=REPORT_BODY_SPACE_PT,
                line_spacing=REPORT_BODY_LINE_SPACING,
            )
        for bullet in section.get("bullets", []):
            add_text(
                document,
                str(bullet),
                "AESG Bullet",
                "List Bullet",
                bold=False,
                italic=False,
                size_pt=REPORT_BODY_PT,
                color=REPORT_BODY_COLOR,
                space_before_pt=0,
                space_after_pt=REPORT_BODY_SPACE_PT,
                line_spacing=REPORT_BODY_LINE_SPACING,
            )
        for numbered in section.get("numbered", []):
            add_text(
                document,
                str(numbered),
                "AESG Numbering",
                "List Number",
                bold=False,
                italic=False,
                size_pt=REPORT_BODY_PT,
                color=REPORT_BODY_COLOR,
                space_before_pt=0,
                space_after_pt=REPORT_BODY_SPACE_PT,
                line_spacing=REPORT_BODY_LINE_SPACING,
            )
        if section.get("callout"):
            add_callout(
                document,
                str(section["callout"]),
                font_size_pt=REPORT_BODY_PT,
                font_color=REPORT_BODY_COLOR,
                report=True,
            )
        if section.get("table"):
            if section["table"].get("caption"):
                add_text(
                    document,
                    str(section["table"]["caption"]),
                    "AESG Table Caption",
                    "Caption",
                    bold=False,
                    italic=False,
                    size_pt=REPORT_CAPTION_PT,
                    color=REPORT_CAPTION_COLOR,
                    space_before_pt=4.0,
                    space_after_pt=3.0,
                    line_spacing=1.0,
                )
                document.paragraphs[-1].alignment = WD_ALIGN_PARAGRAPH.CENTER
            add_table(
                document,
                section["table"],
                font_size_pt=REPORT_BODY_PT,
                font_color=REPORT_BODY_COLOR,
                report=True,
            )
        images = section.get("images", [])
        if section.get("image"):
            images = [section["image"], *images]
        for image in images:
            add_image(
                document,
                image,
                font_size_pt=REPORT_BODY_PT,
                font_color=REPORT_BODY_COLOR,
                line_spacing=REPORT_BODY_LINE_SPACING,
            )
        if section.get("source"):
            add_text(
                document,
                f"Source: {section['source']}",
                "AESG Body Text",
                "Normal",
                bold=False,
                italic=True,
                size_pt=REPORT_BODY_PT,
                color=REPORT_BODY_COLOR,
                space_before_pt=0,
                space_after_pt=REPORT_BODY_SPACE_PT,
                line_spacing=REPORT_BODY_LINE_SPACING,
            )


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
        if row_index >= len(rows):
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
    content_section = copy.deepcopy(sections[0])
    set_section_top_margin(content_section, REPORT_CONTENT_TOP_DXA)
    set_section_page_number_start(content_section, None)
    final_section = copy.deepcopy(sections[1])
    set_section_top_margin(final_section, REPORT_CONTENT_TOP_DXA)
    set_section_page_number_start(final_section, None)
    landscape_section = copy.deepcopy(sections[3]) if len(sections) > 3 else None
    if landscape_section is not None:
        set_section_top_margin(landscape_section, REPORT_LANDSCAPE_TOP_DXA)
        set_section_page_number_start(landscape_section, None)
    set_final_section(document, final_section)
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
        add_section_break(document, content_section)
    else:
        set_final_section(document, content_section)
    replacements = {
        "Project Name": spec.get("project", spec.get("title", "AESG")),
        "Report Title": spec.get("title", "AESG report"),
        "Monday, July 27, 2026": spec.get("date", ""),
        "AESG – OPE – MAR - REP": spec.get(
            "reference", spec.get("documentControl", {}).get("reference", "AESG")
        ),
    }
    if spec.get("documentTitle"):
        add_text(
            document,
            str(spec["documentTitle"]),
            "AESG Title",
            "Title",
            bold=True,
            size_pt=REPORT_HEADING_SIZES[1],
            color=REPORT_HEADING_COLOR,
            space_after_pt=REPORT_BODY_SPACE_PT,
        )
    add_sections(
        document,
        list(spec.get("sections", [])),
        divider,
        portrait_section=final_section,
        landscape_section=landscape_section,
    )
    for section in document.sections:
        replace_leaf_text(section.header._element, replacements)
        replace_leaf_text(section.footer._element, replacements)
        clear_text_highlight(section.header._element)
        clear_text_highlight(section.footer._element)


def add_letter_multiline(document: Document, lines: list[str]) -> None:
    if not lines:
        return
    style = style_by_name(document, "Heading 2", "heading 2", "Normal")
    paragraph = document.add_paragraph(style=style)
    paragraph.paragraph_format.space_before = Pt(0)
    paragraph.paragraph_format.space_after = Pt(0)
    paragraph.paragraph_format.line_spacing = Pt(LETTER_BLOCK_LINE_PT)
    for index, line in enumerate(lines):
        if index:
            paragraph.add_run().add_break()
        if line:
            run = paragraph.add_run(str(line))
            set_run_font(
                run,
                size_pt=LETTER_BODY_PT,
                color=LETTER_TEXT,
            )


def add_letter_reference_subject(document: Document, spec: dict) -> None:
    reference = str(spec.get("reference", "")).strip()
    subject = str(spec.get("subject", spec.get("title", ""))).strip()
    if not reference and not subject:
        return
    style = style_by_name(document, "Heading 2", "heading 2", "Normal")
    paragraph = document.add_paragraph(style=style)
    paragraph.paragraph_format.space_before = Pt(0)
    paragraph.paragraph_format.line_spacing = Pt(LETTER_BLOCK_LINE_PT)
    paragraph.paragraph_format.space_after = Pt(18)
    if reference:
        run = paragraph.add_run(f"Reference: {reference}")
        set_run_font(run, size_pt=LETTER_BODY_PT, color=LETTER_TEXT)
    if reference and subject:
        paragraph.add_run().add_break()
        paragraph.add_run().add_break()
    if subject:
        run = paragraph.add_run(subject)
        set_run_font(
            run,
            bold=True,
            size_pt=LETTER_SUBJECT_PT,
            color=LETTER_TEXT,
        )


def add_letter_sections(document: Document, sections: list[dict]) -> None:
    for section in sections:
        if section.get("pageBreak") and document.paragraphs:
            document.add_page_break()
        heading = str(section.get("heading", "")).strip()
        if heading:
            add_text(
                document,
                heading,
                "Heading 1",
                bold=True,
                italic=False,
                size_pt=LETTER_SUBJECT_PT,
                color=GREEN,
                space_before_pt=12,
                space_after_pt=9,
            )
        for paragraph in section.get("paragraphs", []):
            value = paragraph.get("text", "") if isinstance(paragraph, dict) else paragraph
            add_text(
                document,
                str(value),
                "Normal",
                bold=False,
                italic=False,
                size_pt=LETTER_BODY_PT,
                color=LETTER_TEXT,
                space_after_pt=9,
            )
        for bullet in section.get("bullets", []):
            add_text(
                document,
                str(bullet),
                "List Bullet",
                "Normal",
                bold=False,
                italic=False,
                size_pt=LETTER_BODY_PT,
                color=LETTER_TEXT,
                space_after_pt=3,
            )
        for numbered in section.get("numbered", []):
            add_text(
                document,
                str(numbered),
                "List Number",
                "Normal",
                bold=False,
                italic=False,
                size_pt=LETTER_BODY_PT,
                color=LETTER_TEXT,
                space_after_pt=3,
            )
        if section.get("callout"):
            add_callout(
                document,
                str(section["callout"]),
                font_size_pt=LETTER_BODY_PT,
                font_color=LETTER_TEXT,
                report=False,
            )
        if section.get("table"):
            if section["table"].get("caption"):
                add_text(
                    document,
                    str(section["table"]["caption"]),
                    "Normal",
                    bold=True,
                    italic=False,
                    size_pt=LETTER_BODY_PT,
                    color=LETTER_TEXT,
                    space_before_pt=9,
                    space_after_pt=3,
                )
            add_table(
                document,
                section["table"],
                font_size_pt=LETTER_BODY_PT,
                font_color=LETTER_TEXT,
                report=False,
            )
        images = section.get("images", [])
        if section.get("image"):
            images = [section["image"], *images]
        for image in images:
            add_image(
                document,
                image,
                font_size_pt=LETTER_BODY_PT,
                font_color=LETTER_TEXT,
            )
        if section.get("source"):
            add_text(
                document,
                f"Source: {section['source']}",
                "Normal",
                bold=False,
                italic=True,
                size_pt=LETTER_BODY_PT,
                color=LETTER_TEXT,
                space_after_pt=9,
            )


def create_letter(document: Document, spec: dict) -> None:
    clear_body(document)
    recipient = spec.get("recipient", [])
    if isinstance(recipient, str):
        recipient = [recipient]
    opening_lines = [str(line) for line in recipient]
    if spec.get("date"):
        if opening_lines:
            opening_lines.append("")
        opening_lines.append(str(spec["date"]))
    add_letter_multiline(document, opening_lines)
    add_letter_reference_subject(document, spec)
    add_text(
        document,
        str(spec.get("salutation", "Dear Sir or Madam,")),
        "Normal",
        bold=False,
        italic=False,
        size_pt=LETTER_BODY_PT,
        color=LETTER_TEXT,
        space_after_pt=9,
    )
    add_letter_sections(document, list(spec.get("sections", [])))
    add_text(
        document,
        str(spec.get("closing", "Yours sincerely,")),
        "Normal",
        bold=False,
        italic=False,
        size_pt=LETTER_BODY_PT,
        color=LETTER_TEXT,
        space_before_pt=9,
        space_after_pt=18,
    )
    if spec.get("signatory"):
        add_text(
            document,
            str(spec["signatory"]),
            "Normal",
            bold=False,
            italic=False,
            size_pt=LETTER_BODY_PT,
            color=LETTER_TEXT,
        )
    if spec.get("designation"):
        add_text(
            document,
            str(spec["designation"]),
            "Normal",
            bold=False,
            italic=False,
            size_pt=LETTER_BODY_PT,
            color=LETTER_TEXT,
        )


def restore_letter_template_parts(template: Path, output: Path) -> None:
    """Restore untouched letterhead structures after python-docx serialisation."""

    exact_parts = {
        "word/styles.xml",
        "word/numbering.xml",
        "word/settings.xml",
        "word/fontTable.xml",
        "word/webSettings.xml",
    }
    prefixes = (
        "word/header",
        "word/footer",
        "word/_rels/header",
        "word/_rels/footer",
        "word/theme/",
    )
    temporary = output.with_name(f".{output.stem}.preserved{output.suffix}")
    with zipfile.ZipFile(template) as source, zipfile.ZipFile(output) as generated:
        source_names = set(source.namelist())
        with zipfile.ZipFile(temporary, "w") as target:
            for info in generated.infolist():
                should_restore = info.filename in exact_parts or info.filename.startswith(prefixes)
                data = source.read(info.filename) if should_restore and info.filename in source_names else generated.read(info.filename)
                target.writestr(info, data)
    temporary.replace(output)


def normalise_report_output_parts(output: Path) -> None:
    """Make every generated report story explicit after python-docx saves it."""

    scripts_dir = Path(__file__).resolve().parents[2] / "aesg-branding" / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    from normalise_office_templates import (  # noqa: PLC0415
        normalise_document_part,
        normalise_docx_styles,
        normalise_footer_story,
        normalise_header_story,
        normalise_theme_fonts,
    )

    with zipfile.ZipFile(output) as source:
        names = set(source.namelist())
        transforms = {
            "word/document.xml": normalise_document_part,
            "word/styles.xml": lambda data: normalise_docx_styles(data, report=True),
            "word/theme/theme1.xml": normalise_theme_fonts,
        }
        for name in names:
            if name.startswith("word/header") and name.endswith(".xml"):
                transforms[name] = normalise_header_story
            elif name.startswith("word/footer") and name.endswith(".xml"):
                transforms[name] = normalise_footer_story
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{output.stem}-",
            suffix=output.suffix,
            dir=output.parent,
        )
        os.close(descriptor)
        temporary = Path(temporary_name)
        try:
            with zipfile.ZipFile(temporary, "w") as target:
                for info in source.infolist():
                    data = source.read(info.filename)
                    transform = transforms.get(info.filename)
                    target.writestr(info, transform(data) if transform else data)
            temporary.replace(output)
        finally:
            if temporary.exists():
                temporary.unlink()


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
    parser.add_argument("--branding-skill-dir", required=True, type=Path)
    args = parser.parse_args()
    if args.output.suffix.casefold() != ".docx":
        raise ValueError("--output must end in .docx")
    spec = json.loads(args.spec.read_text(encoding="utf-8"))
    raw_kind = spec.get("kind")
    if raw_kind is None:
        letter_fields = {"recipient", "reference", "subject", "salutation", "closing", "signatory", "designation"}
        kind = "letter" if letter_fields.intersection(spec) else "report"
    else:
        kind = str(raw_kind).strip().casefold()
        if kind in LETTER_KINDS:
            kind = "letter"
    if kind not in {"report", "letter"}:
        raise ValueError(
            "kind must be report or a letterhead route such as letter, memo, or leave-request"
        )
    template = args.template or (report_template(args.branding_skill_dir) if kind == "report" else letter_template(args.branding_skill_dir))
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
    if kind == "report":
        normalise_report_output_parts(args.output)
    else:
        restore_letter_template_parts(template, args.output)
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
