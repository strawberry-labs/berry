#!/usr/bin/env python3
"""Clone and fill slides from AESG's retained 16:9 PowerPoint template."""

from __future__ import annotations

import argparse
import copy
import json
import re
from pathlib import Path

from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE
from pptx.oxml.ns import qn


SLIDE_LAYOUT_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout"
NOTES_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide"
PLACEHOLDER_RE = re.compile(
    r"lorem ipsum|insert title|slide no\.?|‹#›|// title|where does it come from|"
    r"what is lorem|why do we use it|where can i get some|\bpoints\b",
    re.IGNORECASE,
)
LAYOUT_SOURCE = {
    "title": 1,
    "statement": 3,
    "three_columns": 4,
    "process": 5,
    "four_cards": 7,
    "seven_points": 8,
    "comparison": 9,
    "two_columns": 9,
    "star": 10,
    "table": 12,
    "image_text": 13,
}


def skill_root() -> Path:
    return Path(__file__).resolve().parents[2]


def default_template() -> Path:
    return skill_root() / "aesg-branding/assets/templates/AESG_Presentation_16x9.pptx"


def shape_by_id(slide, shape_id: int):
    for shape in slide.shapes:
        if shape.shape_id == shape_id:
            return shape
    return None


def replace_paragraph(paragraph, text: str) -> None:
    if paragraph.runs:
        paragraph.runs[0].text = text
        for run in list(paragraph.runs[1:]):
            paragraph._p.remove(run._r)
    else:
        paragraph.add_run().text = text
    for run in paragraph.runs:
        run.font.name = "Verdana"


def set_lines(shape, values: list[str]) -> None:
    if shape is None or not (
        getattr(shape, "has_text_frame", False) or hasattr(shape, "text_frame")
    ):
        return
    paragraphs = shape.text_frame.paragraphs
    while len(paragraphs) < len(values):
        shape.text_frame.add_paragraph()
        paragraphs = shape.text_frame.paragraphs
    for index, paragraph in enumerate(paragraphs):
        replace_paragraph(paragraph, values[index] if index < len(values) else "")


def set_block(shape, value) -> None:
    if isinstance(value, dict):
        values = [str(value.get("title", "")), str(value.get("body", ""))]
    elif isinstance(value, list):
        values = [str(item) for item in value]
    else:
        values = str(value or "").splitlines() or [""]
    set_lines(shape, values)


def clone_slide(presentation: Presentation, source):
    destination = presentation.slides.add_slide(source.slide_layout)
    for shape in list(destination.shapes):
        destination.shapes._spTree.remove(shape.element)

    relationship_map: dict[str, str] = {}
    for relationship in source.part.rels.values():
        if relationship.reltype in (SLIDE_LAYOUT_REL, NOTES_REL):
            continue
        if relationship.is_external:
            new_rid = destination.part.rels.get_or_add_ext_rel(
                relationship.reltype, relationship.target_ref
            )
        else:
            new_rid = destination.part.relate_to(
                relationship.target_part, relationship.reltype
            )
        relationship_map[relationship.rId] = new_rid

    for source_shape in source.shapes:
        element = copy.deepcopy(source_shape.element)
        for node in element.iter():
            for attribute, value in list(node.attrib.items()):
                if value in relationship_map:
                    node.set(attribute, relationship_map[value])
        destination.shapes._spTree.insert_element_before(element, "p:extLst")
    return destination


def remove_original_slides(presentation: Presentation, count: int) -> None:
    slide_ids = presentation.slides._sldIdLst
    for _ in range(count):
        slide_id = slide_ids[0]
        presentation.part.drop_rel(slide_id.rId)
        del slide_ids[0]


def fill_table(shape, table_spec: dict) -> None:
    if shape is None or not shape.has_table:
        return
    headers = [str(value) for value in table_spec.get("headers", [])]
    rows = table_spec.get("rows", [])
    table = shape.table
    values = [headers] + [
        [str(value) for value in (row.values() if isinstance(row, dict) else row)]
        for row in rows
    ]
    wanted_rows = max(1, len(values))
    wanted_columns = max(1, max((len(row) for row in values), default=1))
    table_xml = table._tbl
    while len(table_xml.tr_lst) > wanted_rows:
        table_xml.remove(table_xml.tr_lst[-1])
    total_width = sum(int(column.get("w")) for column in table_xml.tblGrid.gridCol_lst)
    while len(table_xml.tblGrid.gridCol_lst) > wanted_columns:
        table_xml.tblGrid.remove(table_xml.tblGrid.gridCol_lst[-1])
    for row in table_xml.tr_lst:
        while len(row.tc_lst) > wanted_columns:
            row.remove(row.tc_lst[-1])
    column_width = total_width // wanted_columns
    for column in table_xml.tblGrid.gridCol_lst:
        column.set("w", str(column_width))
    for row_index, row in enumerate(table.rows):
        for column_index, cell in enumerate(row.cells):
            value = ""
            if row_index < len(values) and column_index < len(values[row_index]):
                value = values[row_index][column_index]
            set_lines(cell, [value])


def fill_slide(slide, slide_spec: dict, slide_number: int) -> None:
    layout = str(slide_spec.get("layout", "statement")).casefold()
    if layout == "title":
        set_block(shape_by_id(slide, 67), slide_spec.get("title", "AESG"))
    elif layout == "statement":
        set_block(shape_by_id(slide, 108), str(slide_number))
        set_block(shape_by_id(slide, 111), slide_spec.get("title", ""))
        set_block(shape_by_id(slide, 112), slide_spec.get("body", ""))
    elif layout == "three_columns":
        for shape_id, value in zip((121, 122, 123), slide_spec.get("columns", [])):
            set_block(shape_by_id(slide, shape_id), value)
    elif layout == "process":
        items = slide_spec.get("items", [])[:3]
        for index, item in enumerate(items):
            set_block(shape_by_id(slide, (132, 134, 131)[index]), item.get("title", ""))
            set_block(shape_by_id(slide, (140, 141, 142)[index]), item)
    elif layout == "four_cards":
        for shape_id, value in zip((179, 180, 181, 182), slide_spec.get("items", [])[:4]):
            set_block(shape_by_id(slide, shape_id), value)
    elif layout == "seven_points":
        for shape_id, value in zip(
            (193, 194, 195, 196, 197, 198, 199), slide_spec.get("items", [])[:7]
        ):
            set_block(shape_by_id(slide, shape_id), value)
        set_block(shape_by_id(slide, 190), str(slide_number))
    elif layout in ("comparison", "two_columns"):
        set_block(shape_by_id(slide, 224), slide_spec.get("left", ""))
        set_block(shape_by_id(slide, 222), slide_spec.get("right", ""))
    elif layout == "star":
        set_block(shape_by_id(slide, 239), {"title": slide_spec.get("title", ""), "body": slide_spec.get("body", "")})
        items = slide_spec.get("items", [])[:4]
        for shape_id, value in zip((235, 236, 237, 238), items):
            set_block(shape_by_id(slide, shape_id), value)
        set_block(shape_by_id(slide, 244), slide_spec.get("outcome", ""))
    elif layout == "table":
        set_block(shape_by_id(slide, 280), {"title": slide_spec.get("title", ""), "body": slide_spec.get("body", "")})
        set_block(shape_by_id(slide, 281), str(slide_number))
        fill_table(shape_by_id(slide, 282), slide_spec.get("table", {}))
    elif layout == "image_text":
        set_block(shape_by_id(slide, 293), {"title": slide_spec.get("title", ""), "body": slide_spec.get("body", "")})

    for shape in slide.shapes:
        if getattr(shape, "has_text_frame", False):
            text = shape.text.strip()
            if text and PLACEHOLDER_RE.search(text):
                set_lines(shape, [""])


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--spec", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--template", type=Path, default=default_template())
    args = parser.parse_args()
    if args.output.suffix.casefold() != ".pptx":
        raise ValueError("--output must end in .pptx")
    spec = json.loads(args.spec.read_text(encoding="utf-8"))
    slide_specs = spec.get("slides") or [{"layout": "title", "title": spec.get("title", "AESG")}]

    presentation = Presentation(args.template)
    originals = list(presentation.slides)
    for slide_spec in slide_specs:
        layout = str(slide_spec.get("layout", "statement")).casefold()
        if layout not in LAYOUT_SOURCE:
            raise ValueError(f"unsupported layout: {layout}")
        clone_slide(presentation, originals[LAYOUT_SOURCE[layout] - 1])
    remove_original_slides(presentation, len(originals))
    for index, (slide, slide_spec) in enumerate(zip(presentation.slides, slide_specs), start=1):
        fill_slide(slide, slide_spec, index)

    presentation.core_properties.title = str(spec.get("title", "AESG presentation"))
    presentation.core_properties.author = "AESG"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    presentation.save(args.output)
    print(
        json.dumps(
            {
                "ok": True,
                "output": str(args.output.resolve()),
                "bytes": args.output.stat().st_size,
                "slides": len(presentation.slides),
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
