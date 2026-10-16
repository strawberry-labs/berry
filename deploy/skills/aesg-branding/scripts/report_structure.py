#!/usr/bin/env python3
"""Native Word heading, list, and TOC system for the AESG General Report.

The General Report must behave like a hand-built Word document: headings use
the built-in Heading 1-3 styles with automatic multilevel numbering, lists use
real multilevel numbering definitions, and the table of contents is a Word TOC
field.  This module is the single definition of that system.  It is applied
once to the retained template and again to every generated report so that a
legacy style catalogue can never reintroduce different values.
"""

from __future__ import annotations

from lxml import etree


W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
FONT = "Verdana"
GREEN = "008C95"
GRAY = "343741"

# One hanging indent for every heading level keeps heading text aligned and
# leaves room for long labels such as 10.12.3 at 11 pt (about 1.5 cm wide).
HEADING_HANGING_DXA = 1077  # 1.9 cm

# level: (style id, style name, legacy AESG style id, size pt, before pt,
#         after pt, number format)
HEADING_LEVELS = {
    1: ("Heading1", "heading 1", "AESGMainHeading", 14, 14, 14, "%1."),
    2: ("Heading2", "heading 2", "AESGSubH1", 12, 12, 12, "%1.%2"),
    3: ("Heading3", "heading 3", "AESGH2", 11, 11, 11, "%1.%2.%3"),
}
HEADING_NUM_ID = "10"

LIST_STEP_DXA = 360
LIST_FIRST_LEFT_DXA = 720
# kind: (numId, style ids per level, level formats)
LIST_SYSTEMS = {
    "bullets": (
        "4",
        ("AESGBullet", "AESGBullet2", "AESGBullet3"),
        ("AESG Bullet", "AESG Bullet 2", "AESG Bullet 3"),
        [
            ("lowerLetter", "%1."),
            ("lowerRoman", "%2"),
            ("bullet", "•"),
            ("bullet", "–"),
            ("bullet", "•"),
            ("bullet", "–"),
            ("bullet", "•"),
            ("bullet", "–"),
            ("bullet", "•"),
        ],
    ),
    "numbered": (
        "5",
        ("AESGNumbering", "AESGNumbering2", "AESGNumbering3"),
        ("AESG Numbering", "AESG Numbering 2", "AESG Numbering 3"),
        [
            ("decimal", "%1."),
            ("lowerLetter", "%2."),
            ("lowerRoman", "%3."),
            ("decimal", "(%4)"),
            ("lowerLetter", "(%5)"),
            ("lowerRoman", "(%6)"),
            ("decimal", "%7."),
            ("lowerLetter", "%8."),
            ("lowerRoman", "%9."),
        ],
    ),
}
LIST_LEVELS = 3

TOC_RIGHT_TAB_DXA = 10450
# style id: (name, left, hanging, size pt, colour, bold, before pt)
TOC_LEVELS = {
    "TOC1": ("toc 1", 567, 567, 11, GREEN, True, 8),
    "TOC2": ("toc 2", 1361, 794, 10, GREEN, False, 3),
    "TOC3": ("toc 3", 2382, 1021, 10, GRAY, False, 0),
}


def w(local: str) -> str:
    return f"{{{W_NS}}}{local}"


def child(parent, local: str, *, first: bool = False):
    node = parent.find(w(local))
    if node is None:
        node = etree.Element(w(local))
        if first:
            parent.insert(0, node)
        else:
            parent.append(node)
    return node


def remove_children(parent, *locals_: str) -> None:
    for local in locals_:
        for node in parent.findall(w(local)):
            parent.remove(node)


# CT_PPr and CT_RPr are sequences; Word rejects out-of-order children.
PPR_ORDER = [
    "pStyle", "keepNext", "keepLines", "pageBreakBefore", "framePr",
    "widowControl", "numPr", "suppressLineNumbers", "pBdr", "shd", "tabs",
    "suppressAutoHyphens", "kinsoku", "wordWrap", "overflowPunct",
    "topLinePunct", "autoSpaceDE", "autoSpaceDN", "bidi", "adjustRightInd",
    "snapToGrid", "spacing", "ind", "contextualSpacing", "mirrorIndents",
    "suppressOverlap", "jc", "textDirection", "textAlignment",
    "textboxTightWrap", "outlineLvl", "divId", "cnfStyle", "rPr", "sectPr",
    "pPrChange",
]
RPR_ORDER = [
    "rStyle", "rFonts", "b", "bCs", "i", "iCs", "caps", "smallCaps", "strike",
    "dstrike", "outline", "shadow", "emboss", "imprint", "noProof",
    "snapToGrid", "vanish", "webHidden", "color", "spacing", "w", "kern",
    "position", "sz", "szCs", "highlight", "u", "effect", "bdr", "shd",
    "fitText", "vertAlign", "rtl", "cs", "em", "lang", "eastAsianLayout",
    "specVanish", "oMath",
]
STYLE_ORDER = [
    "name", "aliases", "basedOn", "next", "link", "autoRedefine", "hidden",
    "uiPriority", "semiHidden", "unhideWhenUsed", "qFormat", "locked",
    "personal", "personalCompose", "personalReply", "rsid", "pPr", "rPr",
    "tblPr", "trPr", "tcPr", "tblStylePr",
]
LVL_ORDER = [
    "start", "numFmt", "lvlRestart", "pStyle", "isLgl", "suff", "lvlText",
    "lvlPicBulletId", "legacy", "lvlJc", "pPr", "rPr",
]


def reorder(parent, order: list[str]) -> None:
    rank = {name: index for index, name in enumerate(order)}
    children = list(parent)
    children.sort(key=lambda node: rank.get(etree.QName(node).localname, len(order)))
    for node in children:
        parent.remove(node)
        parent.append(node)


def set_run_contract(rpr, *, size_pt: float, colour: str, bold: bool) -> None:
    fonts = child(rpr, "rFonts")
    for attribute in list(fonts.attrib):
        fonts.attrib.pop(attribute)
    for slot in ("ascii", "hAnsi", "eastAsia", "cs"):
        fonts.set(w(slot), FONT)
    remove_children(rpr, "b", "bCs", "i", "iCs", "caps", "color", "sz", "szCs")
    if bold:
        etree.SubElement(rpr, w("b"))
        etree.SubElement(rpr, w("bCs"))
    colour_node = etree.SubElement(rpr, w("color"))
    colour_node.set(w("val"), colour)
    for local in ("sz", "szCs"):
        node = etree.SubElement(rpr, w(local))
        node.set(w("val"), str(round(size_pt * 2)))
    reorder(rpr, RPR_ORDER)


def set_spacing(ppr, *, before: int, after: int, line: int = 240) -> None:
    spacing = child(ppr, "spacing")
    for attribute in list(spacing.attrib):
        spacing.attrib.pop(attribute)
    spacing.set(w("before"), str(before))
    spacing.set(w("after"), str(after))
    spacing.set(w("line"), str(line))
    spacing.set(w("lineRule"), "auto")


def set_indent(ppr, *, left: int, hanging: int) -> None:
    indent = child(ppr, "ind")
    for attribute in list(indent.attrib):
        indent.attrib.pop(attribute)
    indent.set(w("left"), str(left))
    indent.set(w("hanging"), str(hanging))


def set_numbering(ppr, num_id: str, level: int) -> None:
    remove_children(ppr, "numPr")
    numbering = etree.SubElement(ppr, w("numPr"))
    ilvl = etree.SubElement(numbering, w("ilvl"))
    ilvl.set(w("val"), str(level))
    num = etree.SubElement(numbering, w("numId"))
    num.set(w("val"), num_id)


def ensure_style(root, style_id: str, name: str, *, based_on: str | None = "Normal"):
    style = None
    for candidate in root.findall(w("style")):
        if candidate.get(w("styleId")) == style_id:
            style = candidate
            break
    if style is None:
        style = etree.SubElement(root, w("style"))
        style.set(w("type"), "paragraph")
        style.set(w("customStyle"), "1")
        style.set(w("styleId"), style_id)
    child(style, "name").set(w("val"), name)
    remove_children(style, "basedOn", "numPr", "aliases")
    if based_on:
        child(style, "basedOn").set(w("val"), based_on)
    child(style, "qFormat")
    remove_children(style, "semiHidden", "unhideWhenUsed", "hidden")
    return style


def fresh_ppr(style):
    remove_children(style, "pPr")
    ppr = etree.SubElement(style, w("pPr"))
    return ppr


def fresh_rpr(style):
    remove_children(style, "rPr")
    return etree.SubElement(style, w("rPr"))


def apply_heading_styles(root) -> None:
    for level, (style_id, name, legacy_id, size, before, after, _) in HEADING_LEVELS.items():
        style = ensure_style(root, style_id, name)
        child(style, "next").set(w("val"), "AESGBodyText")
        ppr = fresh_ppr(style)
        etree.SubElement(ppr, w("keepNext"))
        etree.SubElement(ppr, w("keepLines"))
        set_numbering(ppr, HEADING_NUM_ID, level - 1)
        tabs = etree.SubElement(ppr, w("tabs"))
        tab = etree.SubElement(tabs, w("tab"))
        tab.set(w("val"), "left")
        tab.set(w("pos"), str(HEADING_HANGING_DXA))
        set_spacing(ppr, before=before * 20, after=after * 20)
        set_indent(ppr, left=HEADING_HANGING_DXA, hanging=HEADING_HANGING_DXA)
        etree.SubElement(ppr, w("jc")).set(w("val"), "left")
        etree.SubElement(ppr, w("outlineLvl")).set(w("val"), str(level - 1))
        reorder(ppr, PPR_ORDER)
        set_run_contract(fresh_rpr(style), size_pt=size, colour=GREEN, bold=False)
        reorder(style, STYLE_ORDER)

        # Legacy AESG heading names remain selectable in Word but now resolve
        # to the same numbered heading definition instead of a second list.
        legacy = None
        for candidate in root.findall(w("style")):
            if candidate.get(w("styleId")) == legacy_id:
                legacy = candidate
        if legacy is not None:
            remove_children(legacy, "basedOn", "pPr", "rPr")
            etree.SubElement(legacy, w("basedOn")).set(w("val"), style_id)
            set_run_contract(etree.SubElement(legacy, w("rPr")), size_pt=size, colour=GREEN, bold=False)
            reorder(legacy, STYLE_ORDER)

    # Character styles linked to headings must not override the paragraph size.
    for level, (style_id, *_rest) in HEADING_LEVELS.items():
        size = HEADING_LEVELS[level][3]
        for candidate in root.findall(w("style")):
            if candidate.get(w("styleId")) == f"{style_id}Char":
                set_run_contract(child(candidate, "rPr"), size_pt=size, colour=GREEN, bold=False)
                reorder(candidate, STYLE_ORDER)


def apply_list_styles(root) -> None:
    for kind, (num_id, style_ids, names, _formats) in LIST_SYSTEMS.items():
        for level, (style_id, name) in enumerate(zip(style_ids, names)):
            style = ensure_style(root, style_id, name, based_on="AESGBodyText")
            ppr = fresh_ppr(style)
            set_numbering(ppr, num_id, level)
            set_spacing(ppr, before=0, after=60, line=276)
            set_indent(
                ppr,
                left=LIST_FIRST_LEFT_DXA + level * LIST_STEP_DXA,
                hanging=LIST_STEP_DXA,
            )
            etree.SubElement(ppr, w("contextualSpacing")).set(w("val"), "0")
            etree.SubElement(ppr, w("jc")).set(w("val"), "left")
            reorder(ppr, PPR_ORDER)
            set_run_contract(fresh_rpr(style), size_pt=10, colour=GRAY, bold=False)
            reorder(style, STYLE_ORDER)


def apply_toc_styles(root) -> None:
    heading = ensure_style(root, "TOCHeading", "TOC Heading")
    child(heading, "next").set(w("val"), "Normal")
    ppr = fresh_ppr(heading)
    etree.SubElement(ppr, w("keepNext"))
    set_numbering(ppr, "0", 0)
    set_spacing(ppr, before=0, after=280)
    set_indent(ppr, left=0, hanging=0)
    etree.SubElement(ppr, w("outlineLvl")).set(w("val"), "9")
    reorder(ppr, PPR_ORDER)
    set_run_contract(fresh_rpr(heading), size_pt=14, colour=GREEN, bold=True)
    reorder(heading, STYLE_ORDER)
    for style_id, (name, left, hanging, size, colour, bold, before) in TOC_LEVELS.items():
        style = ensure_style(root, style_id, name)
        child(style, "next").set(w("val"), "Normal")
        ppr = fresh_ppr(style)
        tabs = etree.SubElement(ppr, w("tabs"))
        number_tab = etree.SubElement(tabs, w("tab"))
        number_tab.set(w("val"), "left")
        number_tab.set(w("pos"), str(left))
        page_tab = etree.SubElement(tabs, w("tab"))
        page_tab.set(w("val"), "right")
        page_tab.set(w("leader"), "dot")
        page_tab.set(w("pos"), str(TOC_RIGHT_TAB_DXA))
        set_spacing(ppr, before=before * 20, after=40, line=240)
        set_indent(ppr, left=left, hanging=hanging)
        reorder(ppr, PPR_ORDER)
        set_run_contract(fresh_rpr(style), size_pt=size, colour=colour, bold=bold)
        reorder(style, STYLE_ORDER)


def apply_report_styles(root) -> None:
    """Rewrite styles.xml in place with the report heading/list/TOC system."""

    apply_heading_styles(root)
    apply_list_styles(root)
    apply_toc_styles(root)


def build_level(level: int, fmt: str, text: str, *, left: int, hanging: int, style_id: str | None, legal: bool = False):
    lvl = etree.Element(w("lvl"))
    lvl.set(w("ilvl"), str(level))
    etree.SubElement(lvl, w("start")).set(w("val"), "1")
    etree.SubElement(lvl, w("numFmt")).set(w("val"), fmt)
    if style_id:
        etree.SubElement(lvl, w("pStyle")).set(w("val"), style_id)
    if legal:
        etree.SubElement(lvl, w("isLgl"))
    etree.SubElement(lvl, w("suff")).set(w("val"), "tab")
    etree.SubElement(lvl, w("lvlText")).set(w("val"), text)
    etree.SubElement(lvl, w("lvlJc")).set(w("val"), "left")
    ppr = etree.SubElement(lvl, w("pPr"))
    tabs = etree.SubElement(ppr, w("tabs"))
    tab = etree.SubElement(tabs, w("tab"))
    tab.set(w("val"), "num")
    tab.set(w("pos"), str(left))
    set_indent(ppr, left=left, hanging=hanging)
    if fmt == "bullet":
        rpr = etree.SubElement(lvl, w("rPr"))
        fonts = etree.SubElement(rpr, w("rFonts"))
        for slot in ("ascii", "hAnsi", "cs"):
            fonts.set(w(slot), FONT)
        fonts.set(w("hint"), "default")
    return lvl


def abstract_for_num(root, num_id: str):
    """Return (num, abstractNum), creating them when a document lacks them."""

    for num in root.findall(w("num")):
        if num.get(w("numId")) == num_id:
            abstract_id = num.find(w("abstractNumId")).get(w("val"))
            for abstract in root.findall(w("abstractNum")):
                if abstract.get(w("abstractNumId")) == abstract_id:
                    return num, abstract
            num.getparent().remove(num)
            break
    # Documents repaired from older templates may not carry these ids.
    # abstractNum elements must precede every num element.
    existing = [int(node.get(w("abstractNumId"))) for node in root.findall(w("abstractNum"))]
    abstract = etree.Element(w("abstractNum"))
    abstract.set(w("abstractNumId"), str(max(existing, default=-1) + 1))
    first_num = root.find(w("num"))
    if first_num is not None:
        first_num.addprevious(abstract)
    else:
        root.append(abstract)
    num = etree.Element(w("num"))
    num.set(w("numId"), num_id)
    etree.SubElement(num, w("abstractNumId")).set(w("val"), abstract.get(w("abstractNumId")))
    cleanup = root.find(w("numIdMacAtCleanup"))
    if cleanup is not None:
        cleanup.addprevious(num)
    else:
        root.append(num)
    return num, abstract


def rewrite_abstract(abstract, name: str, levels: list) -> None:
    for node in list(abstract):
        if etree.QName(node).localname not in {"nsid"}:
            abstract.remove(node)
    etree.SubElement(abstract, w("multiLevelType")).set(w("val"), "multilevel")
    etree.SubElement(abstract, w("name")).set(w("val"), name)
    for level in levels:
        abstract.append(level)


def apply_report_numbering(root) -> None:
    """Rewrite numbering.xml in place with the heading and list definitions."""

    owned_styles = {definition[0] for definition in HEADING_LEVELS.values()}
    for _, style_ids, _, _ in LIST_SYSTEMS.values():
        owned_styles.update(style_ids)
    # A paragraph style may be linked from only one list level.
    for lvl in root.iter(w("lvl")):
        style = lvl.find(w("pStyle"))
        if style is not None and style.get(w("val")) in owned_styles | {
            definition[2] for definition in HEADING_LEVELS.values()
        }:
            lvl.remove(style)

    num, abstract = abstract_for_num(root, HEADING_NUM_ID)
    remove_children(num, "lvlOverride")
    levels = []
    formats = ["%1.", "%1.%2", "%1.%2.%3", "%1.%2.%3.%4", "%1.%2.%3.%4.%5", "%1.%2.%3.%4.%5.%6",
               "%1.%2.%3.%4.%5.%6.%7", "%1.%2.%3.%4.%5.%6.%7.%8", "%1.%2.%3.%4.%5.%6.%7.%8.%9"]
    for level, text in enumerate(formats):
        style_id = HEADING_LEVELS[level + 1][0] if level + 1 in HEADING_LEVELS else None
        levels.append(
            build_level(
                level,
                "decimal",
                text,
                left=HEADING_HANGING_DXA,
                hanging=HEADING_HANGING_DXA,
                style_id=style_id,
                legal=level > 0,
            )
        )
    rewrite_abstract(abstract, "AESG Report Headings", levels)

    for kind, (num_id, style_ids, _, formats) in LIST_SYSTEMS.items():
        num, abstract = abstract_for_num(root, num_id)
        remove_children(num, "lvlOverride")
        levels = [
            build_level(
                level,
                fmt,
                text,
                left=LIST_FIRST_LEFT_DXA + level * LIST_STEP_DXA,
                hanging=LIST_STEP_DXA,
                style_id=style_ids[level] if level < len(style_ids) else None,
            )
            for level, (fmt, text) in enumerate(formats)
        ]
        rewrite_abstract(abstract, f"AESG {kind.title()} List", levels)
    for abstract in root.findall(w("abstractNum")):
        for lvl in abstract.findall(w("lvl")):
            reorder(lvl, LVL_ORDER)
            ppr = lvl.find(w("pPr"))
            if ppr is not None:
                reorder(ppr, PPR_ORDER)


def disable_field_update(root) -> None:
    """Remove the open-time field refresh.

    updateFields makes Word show "This document contains fields that may
    refer to other files" on every open, which alarms clients. Generated
    reports carry correct cached TOC page numbers instead.
    """

    for node in root.findall(w("updateFields")):
        root.remove(node)


def enable_field_update(root) -> None:
    """Fallback only: ask Word to refresh fields when cached pages are missing."""

    node = root.find(w("updateFields"))
    if node is None:
        node = etree.Element(w("updateFields"))
        # CT_Settings is a strict sequence: updateFields sits immediately
        # before hdrShapeDefaults/footnotePr/endnotePr/compat/docVars/rsids.
        following = ("hdrShapeDefaults", "footnotePr", "endnotePr", "compat", "docVars", "rsids",
                     "mathPr", "attachedSchema", "themeFontLang", "clrSchemeMapping")
        anchor = next(
            (candidate for candidate in root if etree.QName(candidate).localname in following),
            None,
        )
        if anchor is not None:
            anchor.addprevious(node)
        else:
            root.append(node)
    node.set(w("val"), "true")


def transform_styles(data: bytes) -> bytes:
    root = etree.fromstring(data)
    apply_report_styles(root)
    return etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)


def transform_numbering(data: bytes) -> bytes:
    root = etree.fromstring(data)
    apply_report_numbering(root)
    return etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)


def transform_settings(data: bytes) -> bytes:
    root = etree.fromstring(data)
    disable_field_update(root)
    return etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)


def enable_field_update_in_package(path) -> None:
    """Set updateFields in a saved DOCX when its TOC page numbers are blank."""

    import zipfile  # noqa: PLC0415
    from pathlib import Path  # noqa: PLC0415

    path = Path(path)
    temporary = path.with_name(f".{path.stem}.fields{path.suffix}")
    with zipfile.ZipFile(path) as source, zipfile.ZipFile(temporary, "w") as target:
        for info in source.infolist():
            data = source.read(info.filename)
            if info.filename == "word/settings.xml":
                root = etree.fromstring(data)
                enable_field_update(root)
                data = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
            target.writestr(info, data)
    temporary.replace(path)
