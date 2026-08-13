#!/usr/bin/env python3
"""Create an AESG presentation by cloning approved slides from the General Template."""

from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path

from PIL import Image
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN
from pptx.oxml.ns import qn
from pptx.util import Inches, Pt


SLIDE_LAYOUT_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout"
NOTES_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide"
GREEN = RGBColor(0x00, 0x8C, 0x95)
GRAY = RGBColor(0x34, 0x37, 0x41)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)
FONT = "Verdana"


LAYOUTS = {
    "cover": {"slide": 1, "mode": "cover"},
    "text": {"slide": 2, "bodies": [499], "max": 1800},
    "two_columns": {"slide": 3, "bodies": [500, 503], "max": 850},
    "three_columns": {"slide": 4, "bodies": [504, 507, 508], "max": 540},
    "statement": {"slide": 6, "bodies": [518], "max": 1000, "title_backing": True},
    "image_bottom": {"slide": 7, "bodies": [522], "image_slots": [68], "max": 650},
    "text_image": {"slide": 8, "bodies": [524], "image_slots": [86], "max": 700},
    "image_text": {"slide": 9, "bodies": [528], "image_slots": [96], "max": 700},
    "divider": {"slide": 10, "mode": "divider", "bodies": [532]},
    "gallery": {
        "slide": 11,
        "bodies": [533, 537, 541],
        "image_slots": [223, 224, 225, 227, 228, 229, 231, 232, 233],
        "max": 420,
    },
    "image_three_columns": {
        "slide": 12,
        "bodies": [546, 547, 548],
        "image_slots": [266],
        "max": 360,
        "title_backing": True,
    },
    "three_columns_image": {
        "slide": 13,
        "bodies": [550, 551, 552],
        "image_slots": [276],
        "max": 360,
    },
    "image_two_columns": {
        "slide": 15,
        "bodies": [553, 554],
        "image_slots": [330],
        "max": 520,
        "title_backing": True,
    },
    "plain": {"slide": 16, "bodies": [557], "max": 1500},
    "closing": {"slide": 17, "mode": "closing"},
}


def shape_by_id(container, shape_id: int):
    for shape in container.shapes:
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
        run.font.name = FONT


def text_runs(value) -> list[tuple[str, bool, bool]]:
    if isinstance(value, dict):
        lines: list[tuple[str, bool, bool]] = []
        if value.get("title"):
            lines.append((str(value["title"]), True, False))
        if value.get("body"):
            lines.extend((line, False, False) for line in str(value["body"]).splitlines())
        if value.get("bullets"):
            lines.extend((str(item), False, True) for item in value["bullets"])
        return lines or [("", False, False)]
    if isinstance(value, list):
        return [(str(item), False, False) for item in value] or [("", False, False)]
    return [(line, False, False) for line in str(value or "").splitlines()] or [("", False, False)]


def text_lines(value) -> list[str]:
    return [text for text, _bold, _bullet in text_runs(value)]


def set_bullet(paragraph, enabled: bool) -> None:
    properties = paragraph._p.get_or_add_pPr()
    for child in list(properties):
        if child.tag.rsplit("}", 1)[-1] in {"buNone", "buChar", "buAutoNum"}:
            properties.remove(child)
    if enabled:
        properties.set("marL", "285750")
        properties.set("indent", "-228600")
        bullet = properties.makeelement(qn("a:buChar"), {"char": "•"})
        properties.append(bullet)
    else:
        properties.append(properties.makeelement(qn("a:buNone"), {}))


def set_block(shape, value) -> None:
    if shape is None or not getattr(shape, "has_text_frame", False):
        return
    values = text_runs(value)
    paragraphs = shape.text_frame.paragraphs
    while len(paragraphs) < len(values):
        shape.text_frame.add_paragraph()
        paragraphs = shape.text_frame.paragraphs
    for index, paragraph in enumerate(paragraphs):
        text, bold, bullet = values[index] if index < len(values) else ("", False, False)
        replace_paragraph(paragraph, text)
        set_bullet(paragraph, bullet)
        if paragraph.runs:
            paragraph.runs[0].font.bold = bold


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
            new_rid = destination.part.relate_to(relationship.target_part, relationship.reltype)
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


def add_text_box(
    slide,
    text: str,
    *,
    left: float,
    top: float,
    width: float,
    height: float,
    size: float,
    color: RGBColor,
    bold: bool = False,
    align=PP_ALIGN.LEFT,
):
    box = slide.shapes.add_textbox(Inches(left), Inches(top), Inches(width), Inches(height))
    frame = box.text_frame
    frame.clear()
    frame.word_wrap = True
    paragraph = frame.paragraphs[0]
    paragraph.alignment = align
    run = paragraph.add_run()
    run.text = text
    run.font.name = FONT
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.color.rgb = color
    return box


def add_title(slide, title: str, section: str = "", *, backing: bool = False) -> None:
    if section:
        add_text_box(
            slide,
            section.upper(),
            left=0.6,
            top=0.72,
            width=9.4,
            height=0.22,
            size=8.5,
            color=GREEN,
            bold=True,
        )
    title_box = add_text_box(
        slide,
        title,
        left=0.6,
        top=0.92 if section else 0.78,
        width=9.5,
        height=0.72,
        size=21,
        color=GRAY,
        bold=True,
    )
    if backing:
        title_box.fill.solid()
        title_box.fill.fore_color.rgb = WHITE
        title_box.line.fill.background()


def add_cover_text(slide, spec: dict) -> None:
    title = str(spec.get("title", "AESG presentation"))
    add_text_box(
        slide,
        title,
        left=0.72,
        top=1.35,
        width=7.6,
        height=1.35,
        size=30,
        color=WHITE,
        bold=True,
    )
    subtitle = str(spec.get("subtitle", "")).strip()
    if subtitle:
        add_text_box(
            slide,
            subtitle,
            left=0.75,
            top=2.65,
            width=6.9,
            height=0.85,
            size=15,
            color=WHITE,
        )
    meta = "  |  ".join(
        str(value) for value in (spec.get("client"), spec.get("date")) if value
    )
    if meta:
        add_text_box(
            slide,
            meta,
            left=0.75,
            top=6.72,
            width=6.8,
            height=0.35,
            size=9,
            color=WHITE,
        )


def add_picture_cover(slide, path: Path, slot) -> None:
    if not path.is_file():
        raise FileNotFoundError(f"slide image not found: {path}")
    with Image.open(path) as image:
        image_ratio = image.width / image.height
    frame_ratio = slot.width / slot.height
    picture = slide.shapes.add_picture(
        str(path), slot.left, slot.top, width=slot.width, height=slot.height
    )
    if image_ratio > frame_ratio:
        visible = frame_ratio / image_ratio
        crop = (1 - visible) / 2
        picture.crop_left = crop
        picture.crop_right = crop
    elif image_ratio < frame_ratio:
        visible = image_ratio / frame_ratio
        crop = (1 - visible) / 2
        picture.crop_top = crop
        picture.crop_bottom = crop


def slide_images(spec: dict) -> list[Path]:
    values = list(spec.get("images", []))
    if spec.get("image"):
        values.insert(0, spec["image"])
    paths = []
    for value in values:
        paths.append(Path(str(value.get("path", ""))) if isinstance(value, dict) else Path(str(value)))
    return paths


def validate_capacity(layout: str, slide_spec: dict, config: dict) -> None:
    title = str(slide_spec.get("title", ""))
    if len(title) > 90:
        raise ValueError(f"{layout} title exceeds 90 characters")
    limit = int(config.get("max", 0))
    if not limit:
        return
    values = slide_spec.get("columns") or slide_spec.get("items")
    if values is None:
        values = [slide_spec.get("body", "")]
    if not isinstance(values, list):
        values = [values]
    for index, value in enumerate(values, start=1):
        length = len(" ".join(text_lines(value)))
        if length > limit:
            raise ValueError(f"{layout} text block {index} exceeds its {limit}-character capacity")


def fill_slide(slide, slide_spec: dict, slide_number: int) -> None:
    layout = str(slide_spec.get("layout", "text")).casefold()
    config = LAYOUTS[layout]
    validate_capacity(layout, slide_spec, config)
    mode = config.get("mode")
    if mode == "cover":
        add_cover_text(slide, slide_spec)
    elif mode == "divider":
        set_block(shape_by_id(slide, config["bodies"][0]), slide_spec.get("title", "Section"))
    elif mode != "closing":
        values = slide_spec.get("columns") or slide_spec.get("items")
        if values is None:
            values = [slide_spec.get("body", "")]
        if not isinstance(values, list):
            values = [values]
        body_ids = config.get("bodies", [])
        for shape_id, value in zip(body_ids, values):
            set_block(shape_by_id(slide, shape_id), value)
        for shape_id in body_ids[len(values) :]:
            set_block(shape_by_id(slide, shape_id), "")

        images = slide_images(slide_spec)
        slots = config.get("image_slots", [])
        if slots and not images:
            raise ValueError(f"{layout} requires at least one image")
        if len(images) > len(slots):
            raise ValueError(f"{layout} supports at most {len(slots)} images")
        for image_path, shape_id in zip(images, slots):
            slot = shape_by_id(slide.slide_layout, shape_id)
            if slot is None:
                raise ValueError(f"missing image slot {shape_id} in {layout} layout")
            add_picture_cover(slide, image_path, slot)

        # Add the title last so it remains legible above image placeholders. A small
        # white title panel is used only where the approved specimen places an image
        # directly behind the title region.
        add_title(
            slide,
            str(slide_spec.get("title", "")),
            str(slide_spec.get("section", "")),
            backing=bool(config.get("title_backing")),
        )

    for shape in list(slide.shapes):
        if getattr(shape, "has_text_frame", False) and shape.text.strip().isdigit():
            slide.shapes._spTree.remove(shape.element)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--spec", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--template", type=Path)
    parser.add_argument("--branding-skill-dir", required=True, type=Path)
    args = parser.parse_args()
    if args.output.suffix.casefold() != ".pptx":
        raise ValueError("--output must end in .pptx")
    template = args.template or args.branding_skill_dir / "assets/templates/AESG_General_Presentation.pptx"
    if not template.is_file():
        raise FileNotFoundError(template)
    spec = json.loads(args.spec.read_text(encoding="utf-8"))
    slide_specs = spec.get("slides") or [{"layout": "cover", "title": spec.get("title", "AESG")}]
    if not isinstance(slide_specs, list):
        raise ValueError("spec.slides must be a list")

    presentation = Presentation(template)
    originals = list(presentation.slides)
    for slide_spec in slide_specs:
        layout = str(slide_spec.get("layout", "text")).casefold()
        if layout not in LAYOUTS:
            raise ValueError(f"unsupported layout: {layout}")
        clone_slide(presentation, originals[LAYOUTS[layout]["slide"] - 1])
    remove_original_slides(presentation, len(originals))
    for index, (slide, slide_spec) in enumerate(zip(presentation.slides, slide_specs), start=1):
        fill_slide(slide, slide_spec, index)

    presentation.core_properties.title = str(spec.get("title", "AESG presentation"))
    presentation.core_properties.subject = "AESG General Template"
    presentation.core_properties.author = "AESG"
    presentation.core_properties.last_modified_by = "AESG"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    presentation.save(args.output)
    print(
        json.dumps(
            {
                "ok": True,
                "output": str(args.output.resolve()),
                "bytes": args.output.stat().st_size,
                "slides": len(presentation.slides),
                "masters": len(presentation.slide_masters),
                "nativeSizeEmu": [presentation.slide_width, presentation.slide_height],
        "template": template.name,
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
