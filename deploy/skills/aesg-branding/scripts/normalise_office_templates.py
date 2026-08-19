#!/usr/bin/env python3
"""Normalise retained AESG Office templates to the runtime typography contract."""

from __future__ import annotations

import argparse
import re
import tempfile
import zipfile
from pathlib import Path

from lxml import etree


W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"
NS = {"w": W_NS, "a": A_NS, "p": P_NS}

REPORT_BODY_STYLES = {
    "Normal": (10, "343741", False),
    "AESG Body Text": (10, "343741", False),
    "AESG Body Text Char": (10, "343741", False),
    "AESG Bullet": (10, "343741", False),
    "AESG Numbering": (10, "343741", False),
    "AESG Table Caption": (10, "343741", False),
    "AESG Figure Captions": (10, "343741", False),
}
REPORT_HEADING_STYLES = {
    "AESG Main Heading": (22, "059B9B", False),
    "AESG Sub H1": (16, "059B9B", False),
    "AESG H2": (14, "059B9B", False),
}
LETTER_STYLES = {
    "Normal": (9, "53565A", False),
    "Heading 1": (12, "008C95", True),
    "Heading 2": (9, "53565A", False),
    "List Bullet": (9, "53565A", False),
    "List Number": (9, "53565A", False),
}

PPT_BODY_SHAPE_IDS = {
    499,
    500,
    503,
    504,
    507,
    508,
    515,
    518,
    522,
    524,
    528,
    533,
    537,
    541,
    546,
    547,
    548,
    550,
    551,
    552,
    553,
    554,
    557,
}


def qn(namespace: str, local: str) -> str:
    return f"{{{namespace}}}{local}"


def replace_zip_members(path: Path, transforms: dict[str, callable]) -> None:
    temporary = Path(tempfile.mkstemp(prefix=f".{path.stem}-", suffix=path.suffix, dir=path.parent)[1])
    try:
        with zipfile.ZipFile(path, "r") as source, zipfile.ZipFile(temporary, "w") as target:
            for info in source.infolist():
                data = source.read(info.filename)
                transform = transforms.get(info.filename)
                if transform is not None:
                    data = transform(data)
                target.writestr(info, data)
        temporary.replace(path)
    finally:
        if temporary.exists():
            temporary.unlink()


def ensure_child(parent, namespace: str, local: str):
    child = parent.find(qn(namespace, local))
    if child is None:
        child = etree.SubElement(parent, qn(namespace, local))
    return child


def set_style_font(style, size_pt: int, color: str, bold: bool) -> None:
    rpr = ensure_child(style, W_NS, "rPr")
    rfonts = ensure_child(rpr, W_NS, "rFonts")
    for attribute in ("ascii", "hAnsi", "eastAsia", "cs"):
        rfonts.set(qn(W_NS, attribute), "Verdana")
    size = ensure_child(rpr, W_NS, "sz")
    size.set(qn(W_NS, "val"), str(size_pt * 2))
    size_cs = ensure_child(rpr, W_NS, "szCs")
    size_cs.set(qn(W_NS, "val"), str(size_pt * 2))
    colour = ensure_child(rpr, W_NS, "color")
    colour.set(qn(W_NS, "val"), color)
    bold_node = rpr.find(qn(W_NS, "b"))
    if bold:
        if bold_node is None:
            bold_node = etree.SubElement(rpr, qn(W_NS, "b"))
        bold_node.set(qn(W_NS, "val"), "1")
    elif bold_node is not None:
        rpr.remove(bold_node)


def set_style_spacing(style, before: int, after: int, line: int) -> None:
    ppr = ensure_child(style, W_NS, "pPr")
    spacing = ensure_child(ppr, W_NS, "spacing")
    spacing.set(qn(W_NS, "before"), str(before))
    spacing.set(qn(W_NS, "after"), str(after))
    spacing.set(qn(W_NS, "line"), str(line))
    spacing.set(qn(W_NS, "lineRule"), "auto")


def normalise_docx_styles(data: bytes, *, report: bool) -> bytes:
    root = etree.fromstring(data)
    styles = REPORT_BODY_STYLES | REPORT_HEADING_STYLES if report else LETTER_STYLES
    styles_by_name = {name.casefold(): contract for name, contract in styles.items()}
    for style in root.findall(qn(W_NS, "style")):
        name_node = style.find(qn(W_NS, "name"))
        name = name_node.get(qn(W_NS, "val"), "") if name_node is not None else ""
        contract = styles_by_name.get(name.casefold())
        if contract is None:
            continue
        size_pt, color, bold = contract
        set_style_font(style, size_pt, color, bold)
        if report and name.casefold() in {key.casefold() for key in REPORT_BODY_STYLES}:
            set_style_spacing(style, 120, 120, 276)
    return etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)


def normalise_letter_document(data: bytes) -> bytes:
    text = data.decode("utf-8")
    text = re.sub(
        r'w:hanging="([0-9]+)(?:\.[0-9]+)?"',
        lambda match: f'w:hanging="{match.group(1)}"',
        text,
    )
    return text.encode("utf-8")


def set_ppt_run_properties(properties) -> None:
    properties.set("sz", "900")
    properties.set("b", "0")
    properties.attrib.pop("i", None)
    properties.attrib.pop("u", None)
    for tag in ("latin", "ea", "cs"):
        node = properties.find(qn(A_NS, tag))
        if node is None:
            node = etree.SubElement(properties, qn(A_NS, tag))
        node.set("typeface", "Verdana")
    for child in list(properties):
        if child.tag == qn(A_NS, "solidFill"):
            properties.remove(child)
    fill = etree.SubElement(properties, qn(A_NS, "solidFill"))
    colour = etree.SubElement(fill, qn(A_NS, "srgbClr"))
    colour.set("val", "343741")


def normalise_pptx_slide(data: bytes) -> bytes:
    root = etree.fromstring(data)
    for shape in root.findall(".//" + qn(P_NS, "sp")):
        c_nv_pr = shape.find("./" + qn(P_NS, "nvSpPr") + "/" + qn(P_NS, "cNvPr"))
        if c_nv_pr is None or int(c_nv_pr.get("id", "-1")) not in PPT_BODY_SHAPE_IDS:
            continue
        for properties in shape.iter():
            if properties.tag in {
                qn(A_NS, "rPr"),
                qn(A_NS, "endParaRPr"),
                qn(A_NS, "defRPr"),
            }:
                set_ppt_run_properties(properties)
    return etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)


def normalise_report(path: Path) -> None:
    replace_zip_members(
        path,
        {
            "word/styles.xml": lambda data: normalise_docx_styles(data, report=True),
        },
    )


def normalise_letterhead(path: Path) -> None:
    replace_zip_members(
        path,
        {
            "word/styles.xml": lambda data: normalise_docx_styles(data, report=False),
            "word/document.xml": normalise_letter_document,
        },
    )


def normalise_presentation(path: Path) -> None:
    with zipfile.ZipFile(path) as archive:
        slide_names = [name for name in archive.namelist() if re.fullmatch(r"ppt/slides/slide\d+\.xml", name)]
    replace_zip_members(path, {name: normalise_pptx_slide for name in slide_names})


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", type=Path)
    parser.add_argument("--letterhead", type=Path)
    parser.add_argument("--presentation", type=Path)
    args = parser.parse_args()
    if not any((args.report, args.letterhead, args.presentation)):
        parser.error("pass at least one template path")
    if args.report:
        normalise_report(args.report)
    if args.letterhead:
        normalise_letterhead(args.letterhead)
    if args.presentation:
        normalise_presentation(args.presentation)
    print("normalised retained AESG Office templates")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
