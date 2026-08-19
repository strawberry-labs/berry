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
from pptx.enum.shapes import PP_PLACEHOLDER
from pptx.oxml.ns import qn
from pptx.util import Pt


SLIDE_LAYOUT_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout"
NOTES_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide"
FONT = "Verdana"
GREEN = RGBColor(0x00, 0x8C, 0x95)
GRAY = RGBColor(0x34, 0x37, 0x41)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)
PPT_TITLE_PT = 21.0
PPT_SECTION_PT = 8.5
PPT_BODY_PT = 9.0
PPT_DIVIDER_PT = 22.0


LAYOUTS = {
    "cover": {"slide": 1, "mode": "cover"},
    "text": {"slide": 2, "title": 498, "section": 497, "bodies": [499], "max": 1800},
    "two_columns": {
        "slide": 3,
        "title": 502,
        "section": 501,
        "bodies": [500, 503],
        "max": 850,
    },
    "three_columns": {
        "slide": 4,
        "title": 506,
        "section": 505,
        "bodies": [504, 507, 508],
        "max": 540,
    },
    "five_images": {
        "slide": 5,
        "title": 509,
        "bodies": [515],
        "image_slots": [510, 511, 512, 513, 514],
        "min_images": 1,
        "max": 760,
    },
    "image_statement": {
        "slide": 6,
        "title": 517,
        "section": 516,
        "bodies": [518],
        "image_slots": [519],
        "min_images": 1,
        "max": 1000,
    },
    "image_bottom": {
        "slide": 7,
        "title": 521,
        "section": 520,
        "bodies": [522],
        "image_slots": [523],
        "min_images": 1,
        "max": 650,
    },
    "text_image": {
        "slide": 8,
        "title": 527,
        "section": 526,
        "bodies": [524],
        "image_slots": [525],
        "min_images": 1,
        "max": 700,
    },
    "image_text": {
        "slide": 9,
        "title": 531,
        "section": 530,
        "bodies": [528],
        "image_slots": [529],
        "min_images": 1,
        "max": 700,
    },
    "divider": {"slide": 10, "mode": "divider", "bodies": [532]},
    "gallery": {
        "slide": 11,
        "bodies": [533, 537, 541],
        "image_slots": [534, 535, 536, 538, 539, 540, 542, 543, 544],
        "min_images": 1,
        "max": 420,
    },
    "image_three_columns": {
        "slide": 12,
        "bodies": [546, 547, 548],
        "image_slots": [545],
        "min_images": 1,
        "max": 360,
    },
    "three_columns_image": {
        "slide": 13,
        "bodies": [550, 551, 552],
        "image_slots": [549],
        "min_images": 1,
        "max": 360,
    },
    "image_two_columns": {
        "slide": 15,
        "bodies": [553, 554],
        "image_slots": [555],
        "min_images": 1,
        "max": 520,
    },
    "statement": {"slide": 16, "title": 556, "bodies": [557], "max": 1000},
    "plain": {"slide": 16, "title": 556, "bodies": [557], "max": 1500},
    "closing": {"slide": 17, "mode": "closing"},
}


def shape_by_id(container, shape_id: int):
    for shape in container.shapes:
        if shape.shape_id == shape_id:
            return shape
    return None


def replace_paragraph(
    paragraph,
    text: str,
    *,
    size: float = PPT_BODY_PT,
    color: RGBColor = GRAY,
    bold: bool | None = False,
    italic: bool | None = False,
) -> None:
    if paragraph.runs:
        paragraph.runs[0].text = text
        for run in list(paragraph.runs[1:]):
            paragraph._p.remove(run._r)
    else:
        paragraph.add_run().text = text
    for run in paragraph.runs:
        run.font.name = FONT
        run.font.size = Pt(size)
        run.font.color.rgb = color
        if bold is not None:
            run.font.bold = bold
        if italic is not None:
            run.font.italic = italic
        run.font.underline = False
        properties = run._r.get_or_add_rPr()
        for tag in ("latin", "ea", "cs"):
            element = properties.find(qn(f"a:{tag}"))
            if element is None:
                element = properties.makeelement(qn(f"a:{tag}"), {})
                properties.append(element)
            element.set("typeface", FONT)


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


def set_block(
    shape,
    value,
    *,
    size: float = PPT_BODY_PT,
    color: RGBColor = GRAY,
    force_bold: bool | None = None,
) -> None:
    if shape is None or not getattr(shape, "has_text_frame", False):
        return
    values = text_runs(value)
    paragraphs = shape.text_frame.paragraphs
    while len(paragraphs) < len(values):
        shape.text_frame.add_paragraph()
        paragraphs = shape.text_frame.paragraphs
    for paragraph in list(paragraphs[len(values) :]):
        shape.text_frame._txBody.remove(paragraph._p)
    paragraphs = shape.text_frame.paragraphs
    for index, paragraph in enumerate(paragraphs):
        text, bold, bullet = values[index]
        replace_paragraph(
            paragraph,
            text,
            size=size,
            color=color,
            bold=bold if force_bold is None else force_bold,
            italic=False,
        )
        set_bullet(paragraph, bullet)


def remove_shape(container, shape) -> None:
    if shape is not None:
        container.shapes._spTree.remove(shape.element)


def set_or_remove(container, shape_id: int | None, value, **kwargs) -> None:
    if shape_id is None:
        if str(value or "").strip():
            raise ValueError("selected layout does not provide a slot for this text")
        return
    shape = shape_by_id(container, shape_id)
    if shape is None and str(value or "").strip():
        raise ValueError(f"missing text slot {shape_id}")
    if not str(value or "").strip():
        remove_shape(container, shape)
        return
    set_block(shape, value, **kwargs)


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


def add_cover_text(slide, spec: dict) -> None:
    set_or_remove(
        slide,
        494,
        str(spec.get("client", "")).upper(),
        size=10,
        color=WHITE,
        force_bold=True,
    )
    set_or_remove(
        slide,
        492,
        str(spec.get("title", "AESG presentation")),
        size=30,
        color=WHITE,
        force_bold=True,
    )
    set_or_remove(slide, 493, str(spec.get("subtitle", "")), size=15, color=WHITE)
    set_or_remove(slide, 495, str(spec.get("reference", "")), size=9, color=WHITE)
    set_or_remove(slide, 496, str(spec.get("date", "")), size=9, color=WHITE)


def replace_picture(slide, path: Path, slot) -> None:
    if not path.is_file():
        raise FileNotFoundError(f"slide image not found: {path}")
    with Image.open(path) as image:
        image_ratio = image.width / image.height
    frame_ratio = slot.width / slot.height
    left, top, width, height = slot.left, slot.top, slot.width, slot.height
    remove_shape(slide, slot)
    picture = slide.shapes.add_picture(str(path), left, top, width=width, height=height)
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
    if title and config.get("mode") not in {"cover", "divider"} and not config.get("title"):
        raise ValueError(f"{layout} is a titleless specimen; choose a titled layout or omit title")
    if slide_spec.get("section") and not config.get("section"):
        raise ValueError(f"{layout} does not provide a section-label slot")
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
        divider_shape = shape_by_id(slide, config["bodies"][0])
        if divider_shape is None:
            raise ValueError(f"missing divider text slot in {layout}")
        set_block(
            divider_shape,
            slide_spec.get("title", "Section"),
            size=PPT_DIVIDER_PT,
            color=WHITE,
            force_bold=True,
        )
    elif mode != "closing":
        set_or_remove(
            slide,
            config.get("title"),
            slide_spec.get("title", ""),
            size=PPT_TITLE_PT,
            color=GRAY,
            force_bold=True,
        )
        set_or_remove(
            slide,
            config.get("section"),
            str(slide_spec.get("section", "")).upper(),
            size=PPT_SECTION_PT,
            color=GREEN,
            force_bold=True,
        )
        values = slide_spec.get("columns") or slide_spec.get("items")
        if values is None:
            values = [slide_spec.get("body", "")]
        if not isinstance(values, list):
            values = [values]
        body_ids = config.get("bodies", [])
        if len(values) > len(body_ids):
            raise ValueError(f"{layout} supports at most {len(body_ids)} text blocks")
        for shape_id, value in zip(body_ids, values):
            body_shape = shape_by_id(slide, shape_id)
            if body_shape is None:
                raise ValueError(f"missing text slot {shape_id} in {layout}")
            set_block(
                body_shape,
                value,
                size=PPT_BODY_PT,
                color=GRAY,
                force_bold=None,
            )
        for shape_id in body_ids[len(values) :]:
            remove_shape(slide, shape_by_id(slide, shape_id))

        images = slide_images(slide_spec)
        slots = config.get("image_slots", [])
        minimum = int(config.get("min_images", 0))
        if len(images) < minimum:
            raise ValueError(f"{layout} requires at least {minimum} image(s)")
        if len(images) > len(slots):
            raise ValueError(f"{layout} supports at most {len(slots)} images")
        for image_path, shape_id in zip(images, slots):
            slot = shape_by_id(slide, shape_id)
            if slot is None:
                raise ValueError(f"missing image slot {shape_id} in {layout} layout")
            replace_picture(slide, image_path, slot)
        for shape_id in slots[len(images) :]:
            remove_shape(slide, shape_by_id(slide, shape_id))

    for shape in list(slide.shapes):
        if not shape.is_placeholder:
            continue
        if shape.placeholder_format.type != PP_PLACEHOLDER.SLIDE_NUMBER:
            continue
        if mode in {"cover", "divider", "closing"}:
            remove_shape(slide, shape)
        else:
            nodes = shape.element.xpath('.//*[local-name()="t"]')
            if nodes:
                nodes[0].text = str(slide_number)
                for node in nodes[1:]:
                    node.text = ""


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
    presentation.core_properties.subject = "AESG Compact General Template"
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
