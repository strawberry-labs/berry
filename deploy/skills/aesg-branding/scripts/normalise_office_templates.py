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

WORD_FONT_ATTRIBUTES = (
    "asciiTheme",
    "hAnsiTheme",
    "eastAsiaTheme",
    "cstheme",
    "csTheme",
)
WORD_FONT_SLOTS = ("ascii", "hAnsi", "eastAsia", "cs")
WORD_THEME_COLOUR_ATTRIBUTES = ("themeColor", "themeShade", "themeTint")
REPORT_FOOTER_COLOUR = "53565A"
HEADER_TEXTBOX_WIDTH_PT = 260
HEADER_TEXTBOX_HEIGHT_PT = 30

# The retained report template contains a large legacy style catalogue.  The
# generator only uses a small role set, but every inherited style must still
# resolve to Verdana so that Word and LibreOffice do not select a theme or
# platform fallback for imported text.
REPORT_GENERIC_STYLES = {
    "Heading 1": (20, "262930", False),
    "Heading 2": (16, "262930", False),
    "Heading 3": (14, "262930", False),
    "Heading 1 Char": (20, "262930", False),
    "Heading 2 Char": (16, "262930", False),
    "Heading 3 Char": (14, "262930", False),
    "Title": (28, "343741", False),
    "Title Char": (28, "343741", False),
    "Caption": (9, "0E2841", False),
    "List Paragraph": (10, "343741", False),
    "List Bullet": (10, "343741", False),
    "List Number": (10, "343741", False),
    "Default Paragraph Font": (10, "343741", False),
    "AESG Title": (12, "008C95", True),
    "AESG Title 2": (10, "343741", True),
    "AESG Divider Heading": (26, "FFFFFF", True),
}

REPORT_BODY_STYLES = {
    "Normal": (10, "343741", False),
    "AESG Body Text": (10, "343741", False),
    "AESG Body Text Char": (10, "343741", False),
    "AESG Bullet": (10, "343741", False),
    "AESG Bullets": (10, "343741", False),
    "AESG Numbering": (10, "343741", False),
    "AESG Table Caption": (9, "04999A", False),
    "AESG Figure Captions": (9, "008C95", False),
    "AESG Figure Captions Char": (9, "008C95", False),
}
REPORT_HEADING_STYLES = {
    "AESG Main Heading": (22, "008C95", False),
    "AESG Sub H1": (16, "008C95", False),
    "AESG H2": (14, "008C95", False),
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
    for attribute in WORD_FONT_ATTRIBUTES:
        rfonts.attrib.pop(qn(W_NS, attribute), None)
    for attribute in ("ascii", "hAnsi", "eastAsia", "cs"):
        rfonts.set(qn(W_NS, attribute), "Verdana")
    size = ensure_child(rpr, W_NS, "sz")
    size.set(qn(W_NS, "val"), str(size_pt * 2))
    size_cs = ensure_child(rpr, W_NS, "szCs")
    size_cs.set(qn(W_NS, "val"), str(size_pt * 2))
    colour = ensure_child(rpr, W_NS, "color")
    for attribute in WORD_THEME_COLOUR_ATTRIBUTES:
        colour.attrib.pop(qn(W_NS, attribute), None)
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


def normalise_word_fonts(root, *, default_size_pt: int | None = None, default_color: str | None = None) -> None:
    """Remove theme font precedence from every Word text run/style in a part."""

    for rfonts in root.iter(qn(W_NS, "rFonts")):
        for attribute in WORD_FONT_ATTRIBUTES:
            rfonts.attrib.pop(qn(W_NS, attribute), None)
        for attribute in WORD_FONT_SLOTS:
            rfonts.set(qn(W_NS, attribute), "Verdana")
    for colour in root.iter(qn(W_NS, "color")):
        for attribute in WORD_THEME_COLOUR_ATTRIBUTES:
            colour.attrib.pop(qn(W_NS, attribute), None)
    if default_size_pt is not None:
        defaults = root.find(".//" + qn(W_NS, "docDefaults"))
        if defaults is not None:
            rpr_default = ensure_child(defaults, W_NS, "rPrDefault")
            rpr = ensure_child(rpr_default, W_NS, "rPr")
            rfonts = ensure_child(rpr, W_NS, "rFonts")
            for attribute in WORD_FONT_ATTRIBUTES:
                rfonts.attrib.pop(qn(W_NS, attribute), None)
            for attribute in WORD_FONT_SLOTS:
                rfonts.set(qn(W_NS, attribute), "Verdana")
            size = ensure_child(rpr, W_NS, "sz")
            size.set(qn(W_NS, "val"), str(default_size_pt * 2))
            size_cs = ensure_child(rpr, W_NS, "szCs")
            size_cs.set(qn(W_NS, "val"), str(default_size_pt * 2))
            if default_color is not None:
                colour = ensure_child(rpr, W_NS, "color")
                for attribute in WORD_THEME_COLOUR_ATTRIBUTES:
                    colour.attrib.pop(qn(W_NS, attribute), None)
                colour.set(qn(W_NS, "val"), default_color)


def normalise_theme_fonts(data: bytes) -> bytes:
    """Make the OOXML theme agree with the explicit AESG Office font contract."""

    root = etree.fromstring(data)
    for node in root.xpath('.//*[local-name()="fontScheme"]//*[local-name()="latin" or local-name()="ea" or local-name()="cs"]'):
        node.set("typeface", "Verdana")
    return etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)


def normalise_word_story(data: bytes, *, footer: bool = False) -> bytes:
    root = etree.fromstring(data)
    normalise_word_fonts(root)
    if footer:
        for properties in root.iter(qn(W_NS, "rPr")):
            for child in list(properties):
                if child.tag in {qn(W_NS, "highlight"), qn(W_NS, "shd")}:
                    properties.remove(child)
            colour = properties.find(qn(W_NS, "color"))
            if colour is not None:
                colour.set(qn(W_NS, "val"), REPORT_FOOTER_COLOUR)
                for attribute in WORD_THEME_COLOUR_ATTRIBUTES:
                    colour.attrib.pop(qn(W_NS, attribute), None)
    return etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)


def _replace_style_dimension(style: str, property_name: str, value: str) -> str:
    pattern = rf"{re.escape(property_name)}:[^;]+pt"
    replacement = f"{property_name}:{value}pt"
    if re.search(pattern, style, flags=re.IGNORECASE):
        return re.sub(pattern, replacement, style, count=1, flags=re.IGNORECASE)
    return style.rstrip(";") + ";" + replacement


def normalise_header_geometry(data: bytes) -> bytes:
    """Give retained header text boxes enough room for real report names."""

    root = etree.fromstring(data)
    for shape in root.xpath('.//*[local-name()="shape"]'):
        text = "".join(shape.xpath('.//*[local-name()="t"]/text()')).strip().casefold()
        if not text:
            continue
        style = shape.get("style", "")
        style = _replace_style_dimension(style, "width", str(HEADER_TEXTBOX_WIDTH_PT))
        style = _replace_style_dimension(style, "height", str(HEADER_TEXTBOX_HEIGHT_PT))
        style = re.sub(r"v-text-anchor:[^;]+", "v-text-anchor:top", style, flags=re.IGNORECASE)
        shape.set("style", style)
        for body in shape.xpath('.//*[local-name()="bodyPr"]'):
            body.set("anchor", "t")
            body.set("vertOverflow", "overflow")
        # The DrawingML representation is used by some Word/LibreOffice
        # viewers; keep it in step with the VML fallback box.
        for extent in shape.xpath('.//*[local-name()="extent"]'):
            extent.set("cx", str(HEADER_TEXTBOX_WIDTH_PT * 12700))
            extent.set("cy", str(HEADER_TEXTBOX_HEIGHT_PT * 12700))
    for anchor in root.xpath('.//*[local-name()="anchor"]'):
        text = "".join(anchor.xpath('.//*[local-name()="t"]/text()')).strip().casefold()
        if not text:
            continue
        for extent in anchor.xpath('.//*[local-name()="extent"]'):
            if extent.tag.rsplit("}", 1)[-1] == "extent":
                extent.set("cx", str(HEADER_TEXTBOX_WIDTH_PT * 12700))
                extent.set("cy", str(HEADER_TEXTBOX_HEIGHT_PT * 12700))
        for extent in anchor.xpath('.//*[local-name()="ext"]'):
            extent.set("cx", str(190 * 12700))
            extent.set("cy", str(18 * 12700))
        for body in anchor.xpath('.//*[local-name()="bodyPr"]'):
            body.set("anchor", "t")
            body.set("vertOverflow", "overflow")
    return etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)


def normalise_header_story(data: bytes) -> bytes:
    return normalise_header_geometry(normalise_word_story(data))


def _set_style_height(style: str, value: str) -> str:
    if re.search(r"height:[^;]+(?:pt)?", style, flags=re.IGNORECASE):
        return re.sub(r"height:[^;]+(?:pt)?", f"height:{value}", style, count=1, flags=re.IGNORECASE)
    return style.rstrip(";") + f";height:{value}"


def normalise_footer_geometry(data: bytes) -> bytes:
    """Keep the two-line footer labels inside their VML/DrawingML boxes."""

    root = etree.fromstring(data)
    for group in root.xpath('.//*[local-name()="group"]'):
        if not group.xpath('.//*[local-name()="txbxContent"]'):
            continue
        coordsize = group.get("coordsize", "")
        parts = coordsize.split(",")
        if len(parts) == 2 and parts[0].isdigit():
            parts[1] = "4300"
            group.set("coordsize", ",".join(parts))
        style = group.get("style", "")
        group.set("style", _set_style_height(style, "34pt"))
        text_shapes = [
            shape
            for shape in group.xpath('.//*[local-name()="shape"]')
            if "".join(shape.xpath('.//*[local-name()="t"]/text()')).strip()
        ]
        for index, shape in enumerate(text_shapes):
            shape_style = shape.get("style", "")
            shape_style = _set_style_height(shape_style, "1850")
            shape_style = re.sub(r"v-text-anchor:[^;]+", "v-text-anchor:top", shape_style, flags=re.IGNORECASE)
            if index:
                if re.search(r"top:[^;]+", shape_style, flags=re.IGNORECASE):
                    shape_style = re.sub(r"top:[^;]+", "top:1950", shape_style, count=1, flags=re.IGNORECASE)
                else:
                    shape_style = shape_style.rstrip(";") + ";top:1950"
            shape.set("style", shape_style)

    for anchor in root.xpath('.//*[local-name()="anchor"]'):
        if not anchor.xpath('.//*[local-name()="txbxContent"]'):
            continue
        for extent in anchor.xpath('./*[local-name()="extent"]'):
            extent.set("cy", "430000")
        for xfrm in anchor.xpath('.//*[local-name()="grpSpPr"]/*[local-name()="xfrm"]'):
            for extent in xfrm.xpath('./*[local-name()="ext" or local-name()="chExt"]'):
                extent.set("cy", "430000")
        text_shapes = [
            shape
            for shape in anchor.xpath('.//*[local-name()="wsp"]')
            if shape.xpath('.//*[local-name()="txbxContent"]')
        ]
        for index, shape in enumerate(text_shapes):
            for extent in shape.xpath('.//*[local-name()="spPr"]/*[local-name()="xfrm"]/*[local-name()="ext"]'):
                extent.set("cy", "185000")
            for offset in shape.xpath('.//*[local-name()="spPr"]/*[local-name()="xfrm"]/*[local-name()="off"]'):
                offset.set("y", str(index * 195000))
            for body in shape.xpath('.//*[local-name()="bodyPr"]'):
                body.set("anchor", "t")
                body.set("vertOverflow", "overflow")
    return etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)


def normalise_footer_story(data: bytes) -> bytes:
    root = etree.fromstring(normalise_footer_geometry(normalise_word_story(data, footer=False)))
    for run in root.iter(qn(W_NS, "r")):
        properties = run.find(qn(W_NS, "rPr"))
        if properties is None:
            continue
        for child in list(properties):
            if child.tag in {qn(W_NS, "highlight"), qn(W_NS, "shd")}:
                properties.remove(child)
        style = properties.find(qn(W_NS, "rStyle"))
        if style is not None and style.get(qn(W_NS, "val"), "").casefold() == "pagenumber":
            continue
    return etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)


def normalise_document_part(data: bytes, *, reset_page_numbers: bool = False) -> bytes:
    root = etree.fromstring(data)
    normalise_word_fonts(root)
    if reset_page_numbers:
        for section in root.iter(qn(W_NS, "sectPr")):
            page_number = ensure_child(section, W_NS, "pgNumType")
            page_number.set(qn(W_NS, "start"), "1")
    return etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)


def normalise_docx_styles(data: bytes, *, report: bool) -> bytes:
    root = etree.fromstring(data)
    styles = REPORT_BODY_STYLES | REPORT_HEADING_STYLES if report else LETTER_STYLES
    if report:
        styles = styles | REPORT_GENERIC_STYLES
    styles_by_name = {name.casefold(): contract for name, contract in styles.items()}
    for style in root.findall(qn(W_NS, "style")):
        # Explicit family on every retained style prevents a legacy style from
        # reintroducing major/minor theme fonts through inheritance.
        rpr = style.find(qn(W_NS, "rPr"))
        if rpr is not None:
            rfonts = rpr.find(qn(W_NS, "rFonts"))
            if rfonts is not None:
                for attribute in WORD_FONT_ATTRIBUTES:
                    rfonts.attrib.pop(qn(W_NS, attribute), None)
                for attribute in WORD_FONT_SLOTS:
                    rfonts.set(qn(W_NS, attribute), "Verdana")
            for colour in rpr.findall(qn(W_NS, "color")):
                for attribute in WORD_THEME_COLOUR_ATTRIBUTES:
                    colour.attrib.pop(qn(W_NS, attribute), None)
        name_node = style.find(qn(W_NS, "name"))
        name = name_node.get(qn(W_NS, "val"), "") if name_node is not None else ""
        style_id = style.get(qn(W_NS, "styleId"), "").casefold()
        # The supplied General Template deliberately carries numbering on its
        # AESG heading styles.  Preserve that numPr: removing it makes the
        # generated report lose the 1 / 1.1 / 1.1.1 prefixes even though the
        # typography itself is correct.  Only obsolete helper styles that are
        # not part of the template's heading hierarchy are unnumbered.
        if report and style_id in {"aesgsubtext", "aesgsubh30"}:
            ppr = style.find(qn(W_NS, "pPr"))
            if ppr is not None:
                numbering = ppr.find(qn(W_NS, "numPr"))
                if numbering is not None:
                    ppr.remove(numbering)
        contract = styles_by_name.get(name.casefold())
        if contract is None:
            continue
        size_pt, color, bold = contract
        set_style_font(style, size_pt, color, bold)
        if report and name.casefold() in {key.casefold() for key in REPORT_BODY_STYLES}:
            if name.casefold() in {
                "aesg table caption",
                "aesg figure captions",
                "aesg figure captions char",
            }:
                set_style_spacing(style, 0, 0, 240)
            else:
                set_style_spacing(style, 0, 60, 276)
    normalise_word_fonts(
        root,
        default_size_pt=10 if report else 9,
        default_color="343741" if report else "53565A",
    )
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
    with zipfile.ZipFile(path) as archive:
        story_names = [
            name
            for name in archive.namelist()
            if re.fullmatch(r"word/(?:header|footer)\d+\.xml", name)
        ]
    replace_zip_members(
        path,
        {
            "word/styles.xml": lambda data: normalise_docx_styles(data, report=True),
            "word/document.xml": normalise_document_part,
            "word/theme/theme1.xml": normalise_theme_fonts,
            **{
                name: (
                    normalise_header_story
                    if name.startswith("word/header")
                    else normalise_footer_story
                )
                for name in story_names
            },
        },
    )


def normalise_letterhead(path: Path) -> None:
    with zipfile.ZipFile(path) as archive:
        story_names = [
            name
            for name in archive.namelist()
            if re.fullmatch(r"word/(?:header|footer)\d+\.xml", name)
        ]
    replace_zip_members(
        path,
        {
            "word/styles.xml": lambda data: normalise_docx_styles(data, report=False),
            "word/document.xml": lambda data: normalise_document_part(normalise_letter_document(data)),
            "word/theme/theme1.xml": normalise_theme_fonts,
            **{
                name: (
                    normalise_header_story
                    if name.startswith("word/header")
                    else lambda data: normalise_word_story(data, footer=True)
                )
                for name in story_names
            },
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
