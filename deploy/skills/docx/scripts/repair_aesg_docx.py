#!/usr/bin/env python3
"""Repair an already-generated AESG report without rewriting its content.

The repair pass is deliberately structural: it fixes typography, theme/font
inheritance, page geometry, header/footer overflow, duplicate Word numbering,
collapsed manual line breaks, and empty gap-table scaffolding. It does not
rewrite factual findings or renumber source-authored section labels.
"""

from __future__ import annotations

import argparse
import copy
import os
import re
import sys
import tempfile
import zipfile
from pathlib import Path

from lxml import etree


def branding_scripts_dir() -> Path:
    """Resolve the activated aesg-branding scripts directory.

    Runtime skills are mounted as unrelated sibling directories, so prefer an
    explicit --branding-skill-dir (or AESG_BRANDING_SKILL_DIR) and fall back to
    the repository layout.
    """

    candidates = []
    if "--branding-skill-dir" in sys.argv:
        index = sys.argv.index("--branding-skill-dir")
        if index + 1 < len(sys.argv):
            candidates.append(Path(sys.argv[index + 1]) / "scripts")
    if os.environ.get("AESG_BRANDING_SKILL_DIR"):
        candidates.append(Path(os.environ["AESG_BRANDING_SKILL_DIR"]) / "scripts")
    candidates.append(Path(__file__).resolve().parents[2] / "aesg-branding" / "scripts")
    for candidate in candidates:
        if (candidate / "report_structure.py").is_file():
            return candidate
    raise FileNotFoundError(
        "aesg-branding scripts were not found; pass --branding-skill-dir <aesg-branding-skill-directory>"
    )


BRANDING_SCRIPTS = branding_scripts_dir()
sys.path.insert(0, str(BRANDING_SCRIPTS))
from report_structure import transform_numbering, transform_settings  # noqa: E402
from normalise_office_templates import (  # noqa: E402
    normalise_document_part,
    normalise_docx_styles,
    normalise_footer_story,
    normalise_header_story,
    normalise_theme_fonts,
    normalise_word_story,
)


W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
W = lambda local: f"{{{W_NS}}}{local}"

FONT = "Verdana"
BODY_SIZE = 20
BODY_COLOR = "343741"
HEADING_COLOR = "008C95"
HEADER_COLOR = "FFFFFF"
FOOTER_COLOR = "53565A"
SOURCE_TOKEN_RE = re.compile(
    r"\s*\[[^\]]+\|\s*(?:Word|Excel|PowerPoint)\]",
    re.IGNORECASE,
)
MANUAL_HEADING_PREFIX_RE = re.compile(
    r"^\s*(?:\d+(?:\.\d+)*(?:[.)])?\s+|appendix\s+[a-z]\b)",
    re.IGNORECASE,
)
THEME_FONT_ATTRS = ("asciiTheme", "hAnsiTheme", "eastAsiaTheme", "cstheme", "csTheme")
FONT_SLOTS = ("ascii", "hAnsi", "eastAsia", "cs")


def ensure_child(parent, local: str):
    child = parent.find(W(local))
    if child is None:
        child = etree.Element(W(local))
        parent.append(child)
    return child


def paragraph_text(paragraph) -> str:
    return "".join(node.text or "" for node in paragraph.iter(W("t")))


def style_id(paragraph) -> str:
    ppr = paragraph.find(W("pPr"))
    if ppr is None:
        return ""
    node = ppr.find(W("pStyle"))
    return node.get(W("val"), "") if node is not None else ""


def has_textbox_ancestor(node) -> bool:
    current = node.getparent()
    while current is not None:
        if current.tag.rsplit("}", 1)[-1] == "txbxContent":
            return True
        current = current.getparent()
    return False


def has_table_ancestor(node) -> bool:
    current = node.getparent()
    while current is not None:
        if current.tag == W("tbl"):
            return True
        current = current.getparent()
    return False


def set_run_contract(run, *, size: int, color: str, bold: bool | None = None) -> None:
    rpr = run.find(W("rPr"))
    if rpr is None:
        rpr = etree.Element(W("rPr"))
        run.insert(0, rpr)
    rfonts = rpr.find(W("rFonts"))
    if rfonts is None:
        rfonts = etree.Element(W("rFonts"))
        rpr.insert(0, rfonts)
    for attribute in THEME_FONT_ATTRS:
        rfonts.attrib.pop(W(attribute), None)
    for attribute in FONT_SLOTS:
        rfonts.set(W(attribute), FONT)
    for local in ("sz", "szCs"):
        size_node = rpr.find(W(local))
        if size_node is None:
            size_node = etree.Element(W(local))
            rpr.append(size_node)
        size_node.set(W("val"), str(size))
    colour = rpr.find(W("color"))
    if colour is None:
        colour = etree.Element(W("color"))
        rpr.append(colour)
    colour.set(W("val"), color)
    for attribute in ("themeColor", "themeShade", "themeTint"):
        colour.attrib.pop(W(attribute), None)
    if bold is not None:
        bold_node = rpr.find(W("b"))
        if bold:
            if bold_node is None:
                bold_node = etree.Element(W("b"))
                rpr.append(bold_node)
            bold_node.set(W("val"), "1")
        elif bold_node is not None:
            rpr.remove(bold_node)


def set_paragraph_contract(
    paragraph,
    *,
    size: int,
    color: str,
    before: int = 120,
    after: int = 120,
    line: int = 276,
    alignment: str = "left",
    keep_next: bool = False,
    bold: bool | None = None,
) -> None:
    ppr = paragraph.find(W("pPr"))
    if ppr is None:
        ppr = etree.Element(W("pPr"))
        paragraph.insert(0, ppr)
    spacing = ppr.find(W("spacing"))
    if spacing is None:
        spacing = etree.Element(W("spacing"))
        ppr.append(spacing)
    spacing.set(W("before"), str(before))
    spacing.set(W("after"), str(after))
    spacing.set(W("line"), str(line))
    spacing.set(W("lineRule"), "auto")
    justification = ppr.find(W("jc"))
    if justification is None:
        justification = etree.Element(W("jc"))
        ppr.append(justification)
    justification.set(W("val"), alignment)
    keep = ppr.find(W("keepNext"))
    if keep_next and keep is None:
        ppr.append(etree.Element(W("keepNext")))
    elif not keep_next and keep is not None:
        ppr.remove(keep)
    if keep_next:
        # A direct numPr can point at a legacy list; headings take numbering
        # from their Heading style and captions are never numbered lists.
        numbering = ppr.find(W("numPr"))
        if numbering is not None:
            ppr.remove(numbering)
    for run in paragraph.iter(W("r")):
        if run.find(W("t")) is not None or run.find(W("instrText")) is not None:
            set_run_contract(run, size=size, color=color, bold=bold)


def suppress_style_numbering(paragraph) -> None:
    """Disable heading-style numbering when the source text already has a label."""

    ppr = paragraph.find(W("pPr"))
    if ppr is None:
        ppr = etree.Element(W("pPr"))
        paragraph.insert(0, ppr)
    numbering = ppr.find(W("numPr"))
    if numbering is None:
        numbering = etree.Element(W("numPr"))
        ppr.append(numbering)
    ilvl = ensure_child(numbering, "ilvl")
    ilvl.set(W("val"), "0")
    num_id = ensure_child(numbering, "numId")
    num_id.set(W("val"), "0")
    # Without a number the heading style's hanging indent would wrap the
    # label's second line under an empty number column.
    indent = ensure_child(ppr, "ind")
    for attribute in list(indent.attrib):
        indent.attrib.pop(attribute)
    indent.set(W("left"), "0")
    indent.set(W("firstLine"), "0")
    from report_structure import PPR_ORDER, reorder  # noqa: PLC0415

    reorder(ppr, PPR_ORDER)


def clean_source_tokens(root) -> None:
    for text in root.iter(W("t")):
        if text.text:
            text.text = SOURCE_TOKEN_RE.sub("", text.text)


def clone_run_with_properties(run):
    clone = etree.Element(W("r"))
    properties = run.find(W("rPr"))
    if properties is not None:
        clone.append(copy.deepcopy(properties))
    return clone


def split_paragraph_at_manual_breaks(paragraph) -> list:
    """Return new paragraphs when a generator joined separate items with w:br."""

    segments: list[list] = [[]]
    for child in list(paragraph):
        if child.tag == W("pPr"):
            continue
        if child.tag != W("r") or child.find(".//" + W("br")) is None:
            segments[-1].append(copy.deepcopy(child))
            continue
        current_run = None
        for run_child in list(child):
            if run_child.tag == W("rPr"):
                if current_run is None:
                    current_run = clone_run_with_properties(child)
                continue
            if run_child.tag == W("br"):
                if current_run is not None and len(current_run) > 0:
                    segments[-1].append(current_run)
                current_run = None
                segments.append([])
                continue
            if current_run is None:
                current_run = clone_run_with_properties(child)
            current_run.append(copy.deepcopy(run_child))
        if current_run is not None and len(current_run) > 0:
            segments[-1].append(current_run)

    meaningful = [
        items
        for items in segments
        if "".join(node.text or "" for item in items for node in item.iter(W("t"))).strip()
    ]
    if len(meaningful) <= 1:
        return [paragraph]
    rebuilt = []
    for items in meaningful:
        new_paragraph = etree.Element(W("p"), nsmap=paragraph.nsmap)
        ppr = paragraph.find(W("pPr"))
        if ppr is not None:
            new_paragraph.append(copy.deepcopy(ppr))
        for item in items:
            new_paragraph.append(item)
        rebuilt.append(new_paragraph)
    return rebuilt


def split_collapsed_body_paragraphs(root) -> None:
    paragraphs = [
        paragraph
        for paragraph in root.iter(W("p"))
        if not has_textbox_ancestor(paragraph)
        and paragraph.find(".//" + W("br")) is not None
    ]
    for paragraph in paragraphs:
        rebuilt = split_paragraph_at_manual_breaks(paragraph)
        if len(rebuilt) == 1:
            continue
        parent = paragraph.getparent()
        index = parent.index(paragraph)
        parent.remove(paragraph)
        for offset, item in enumerate(rebuilt):
            parent.insert(index + offset, item)


def cell_is_group_header(row) -> bool:
    cells = row.findall(W("tc"))
    if len(cells) != 1:
        return False
    return bool("".join(cells[0].itertext()).strip())


def cell_text(cell) -> str:
    return "".join(node.text or "" for node in cell.iter(W("t"))).strip()


def is_incomplete_gap_row(row) -> bool:
    """Identify an unmerged row with only its requirement label populated."""

    cells = row.findall(W("tc"))
    if len(cells) <= 1:
        return False
    values = [cell_text(cell) for cell in cells]
    populated = [index for index, value in enumerate(values) if value]
    if populated != [0]:
        return False
    for cell in cells:
        properties = cell.find(W("tcPr"))
        if properties is None:
            continue
        if properties.find(W("gridSpan")) is not None or properties.find(W("hMerge")) is not None:
            return False
    return True


def remove_gap_table_placeholder_rows(root) -> None:
    for table in root.iter(W("tbl")):
        rows = table.findall(W("tr"))
        if not rows or "requirement" not in cell_text(rows[0]).casefold():
            continue
        for row in rows[1:]:
            cells = row.findall(W("tc"))
            if cells and (
                all(not cell_text(cell) for cell in cells)
                or is_incomplete_gap_row(row)
            ):
                table.remove(row)


def normalise_compliance_rag_values(root) -> None:
    values = {"green": "Green", "amber": "Amber", "red": "Red"}
    for table in root.iter(W("tbl")):
        rows = table.findall(W("tr"))
        if not rows:
            continue
        headers = [cell_text(cell).casefold() for cell in rows[0].findall(W("tc"))]
        if "requirement" not in headers or "rag" not in headers:
            continue
        rag_index = headers.index("rag")
        for row in rows[1:]:
            cells = row.findall(W("tc"))
            if rag_index >= len(cells):
                continue
            cell = cells[rag_index]
            canonical = values.get(cell_text(cell).casefold())
            if canonical is None:
                continue
            text_nodes = list(cell.iter(W("t")))
            if not text_nodes:
                continue
            text_nodes[0].text = canonical
            for text_node in text_nodes[1:]:
                text_node.text = ""


def normalise_report_content(root) -> None:
    clean_source_tokens(root)
    split_collapsed_body_paragraphs(root)
    remove_gap_table_placeholder_rows(root)
    normalise_compliance_rag_values(root)
    for table_index, table in enumerate(root.iter(W("tbl"))):
        rows = table.findall(W("tr"))
        is_gap_table = bool(rows and "requirement" in cell_text(rows[0]).casefold())
        for row_index, row in enumerate(rows):
            header = is_gap_table and row_index == 0
            group_header = is_gap_table and row_index > 0 and cell_is_group_header(row)
            for cell in row.findall(W("tc")):
                for paragraph in cell.findall(".//" + W("p")):
                    if header:
                        set_paragraph_contract(
                            paragraph,
                            size=20,
                            color=HEADING_COLOR,
                            before=0,
                            after=0,
                            line=240,
                            bold=True,
                        )
                    elif group_header:
                        set_paragraph_contract(
                            paragraph,
                            size=20,
                            color=HEADING_COLOR,
                            before=0,
                            after=0,
                            line=240,
                            alignment="center",
                            bold=True,
                        )
                    else:
                        set_paragraph_contract(
                            paragraph,
                            size=BODY_SIZE,
                            color=BODY_COLOR,
                            before=0,
                            after=0,
                            line=240,
                        )
    for paragraph in root.iter(W("p")):
        if has_textbox_ancestor(paragraph) or has_table_ancestor(paragraph):
            continue
        sid = style_id(paragraph).casefold()
        line = 276
        if sid in {"title", "reporttitlecoverpage"}:
            size, before, after = 44, 200, 0
        elif "mainheading" in sid or sid == "heading1":
            size, before, after, line = 28, 280, 280, 240
        elif "subh1" in sid or sid == "heading2":
            size, before, after, line = 24, 240, 240, 240
        elif any(token in sid for token in ("h2", "subh2", "subh3", "heading3")):
            size, before, after, line = 22, 220, 220, 240
        elif "tablecaption" in sid:
            size, before, after = 18, 0, 0
        elif "figurecaptions" in sid or sid == "caption":
            size, before, after = 18, 0, 0
        else:
            size, before, after = BODY_SIZE, 0, 60
        set_paragraph_contract(
            paragraph,
            size=size,
            color=("04999A" if "tablecaption" in sid else HEADING_COLOR)
            if size > BODY_SIZE or "caption" in sid
            else BODY_COLOR,
            before=before,
            after=after,
            line=line,
            keep_next=size > BODY_SIZE or "caption" in sid,
            bold=None,
        )
        if size > BODY_SIZE and MANUAL_HEADING_PREFIX_RE.match(paragraph_text(paragraph)):
            suppress_style_numbering(paragraph)


def normalise_document_geometry(root) -> None:
    sections = list(root.iter(W("sectPr")))
    for index, section in enumerate(sections):
        margins = ensure_child(section, "pgMar")
        page_size = section.find(W("pgSz"))
        width = int(page_size.get(W("w"), "0")) if page_size is not None else 0
        height = int(page_size.get(W("h"), "0")) if page_size is not None else 0
        landscape = width > height
        portrait_appendix = len(sections) >= 5 and index == len(sections) - 1
        margins.set(W("top"), "720" if landscape or portrait_appendix else "1701")
        margins.set(W("right"), "720")
        margins.set(W("bottom"), "720")
        margins.set(W("left"), "720")
        margins.set(W("header"), "1134")
        margins.set(W("footer"), "1134")
        page_number = ensure_child(section, "pgNumType")
        page_number.set(W("start"), "1")


def transform_document(data: bytes) -> bytes:
    root = etree.fromstring(normalise_document_part(data))
    normalise_document_geometry(root)
    normalise_report_content(root)
    return etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)


def transform_header(data: bytes) -> bytes:
    root = etree.fromstring(normalise_header_story(data))
    for run in root.iter(W("r")):
        if run.find(W("t")) is not None:
            set_run_contract(run, size=16, color=HEADER_COLOR)
    return etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)


def transform_footer(data: bytes) -> bytes:
    root = etree.fromstring(normalise_footer_story(data))
    for run in root.iter(W("r")):
        if run.find(W("t")) is not None or run.find(W("instrText")) is not None:
            set_run_contract(run, size=16, color=FOOTER_COLOR)
    return etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)


def replace_zip_members(path: Path, transforms: dict[str, callable]) -> None:
    temporary = Path(tempfile.mkstemp(prefix=f".{path.stem}-", suffix=path.suffix, dir=path.parent)[1])
    try:
        with zipfile.ZipFile(path, "r") as source, zipfile.ZipFile(temporary, "w") as target:
            for info in source.infolist():
                data = source.read(info.filename)
                transform = transforms.get(info.filename)
                target.writestr(info, transform(data) if transform else data)
        temporary.replace(path)
    finally:
        if temporary.exists():
            temporary.unlink()


def repair_report(path: Path) -> None:
    with zipfile.ZipFile(path) as archive:
        stories = [
            name
            for name in archive.namelist()
            if re.fullmatch(r"word/(?:header|footer)\d+\.xml", name)
        ]
    transforms: dict[str, callable] = {
        "word/document.xml": transform_document,
        "word/styles.xml": lambda data: normalise_docx_styles(data, report=True),
        "word/numbering.xml": transform_numbering,
        "word/settings.xml": transform_settings,
        "word/theme/theme1.xml": normalise_theme_fonts,
    }
    for name in stories:
        transforms[name] = transform_header if name.startswith("word/header") else transform_footer
    replace_zip_members(path, transforms)


def add_missing_table_of_contents(path: Path, *, paginate: bool = True) -> bool:
    """Insert a native TOC for existing headings when the report has none."""

    from docx import Document  # noqa: PLC0415

    scripts_dir = str(Path(__file__).resolve().parent)
    if scripts_dir not in sys.path:
        sys.path.insert(0, scripts_dir)
    import create_aesg_docx as generator  # noqa: PLC0415

    document = Document(path)
    has_toc = bool(document.element.xpath('.//w:instrText[contains(., "TOC ")]'))

    def heading_level(paragraph) -> int | None:
        style = paragraph.style
        while style is not None:
            if style.style_id in {"Heading1", "Heading2", "Heading3"}:
                return int(style.style_id[-1])
            style = style.base_style
        return None

    headings = [
        (paragraph, heading_level(paragraph))
        for paragraph in document.paragraphs
        if paragraph.text.strip() and heading_level(paragraph)
    ]
    if not headings:
        return False
    # Divider titles live in text boxes, which document.paragraphs skips.
    dividers = document.element.body.xpath(
        './/w:p[w:pPr/w:pStyle[@w:val="AESGDividerHeading"]]'
    )
    structure = generator.ReportStructure(document)
    entries_by_text: dict[str, dict] = {}
    for paragraph, level in headings:
        numbering = paragraph._p.find(f"{W('pPr')}/{W('numPr')}/{W('numId')}")
        numbered = numbering is None or numbering.get(W("val")) != "0"
        entry = structure.reserve_heading(level, numbered)
        entry["text"] = paragraph.text.strip()
        entries_by_text.setdefault(" ".join(entry["text"].split()).casefold(), entry)
    # Legacy dividers counted on their own list (chapter 6 read "2.").
    for divider in dividers:
        title = " ".join(paragraph_text(divider).split())
        title = re.sub(r"^\d+(?:\.\d+)*\.?\s+", "", title).casefold()
        entry = entries_by_text.get(title)
        if entry is None:
            continue
        entry["divider"] = True
        for node in divider.xpath('./w:r[w:t]'):
            text = node.find(W("t"))
            if text is not None and re.fullmatch(r"\s*\d+(?:\.\d+)*\.?\s*", text.text or ""):
                divider.remove(node)
        generator.number_divider([divider.getparent()], entry)
    if has_toc or len(headings) < 2:
        document.save(path)
        return False
    for paragraph, _level in headings:
        entry = next(item for item in structure.headings if item.get("text") == paragraph.text.strip() and "placed" not in item)
        entry["placed"] = True
        start = etree.Element(W("bookmarkStart"))
        start.set(W("id"), entry["bookmarkId"])
        start.set(W("name"), entry["bookmark"])
        properties = paragraph._p.find(W("pPr"))
        if properties is not None:
            properties.addnext(start)
        else:
            paragraph._p.insert(0, start)
        end = etree.Element(W("bookmarkEnd"))
        end.set(W("id"), entry["bookmarkId"])
        paragraph._p.append(end)

    # Put the TOC at the start of the content section, after any cover or
    # approval section break, so it never lands between a divider and its
    # heading.
    body = document.element.body
    first = headings[0][0]._p
    anchor = first
    node = first.getprevious()
    while node is not None:
        if node.find(f"{W('pPr')}/{W('sectPr')}") is not None:
            anchor = node.getnext()
            break
        anchor = node
        node = node.getprevious()
    placeholder = etree.Element(W("p"))
    anchor.addprevious(placeholder)
    page_break = etree.Element(W("p"))
    run = etree.SubElement(page_break, W("r"))
    etree.SubElement(run, W("br")).set(W("type"), "page")
    anchor.addprevious(page_break)
    structure.toc_placeholder = placeholder
    generator.insert_table_of_contents(document, structure, generator.TOC_TITLE)
    if body.sectPr is None:
        return False
    document.save(path)
    paginated = paginate and generator.paginate_table_of_contents(
        path, structure.headings, generator.TOC_TITLE
    )
    if not paginated:
        from report_structure import enable_field_update_in_package  # noqa: PLC0415

        enable_field_update_in_package(path)
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument(
        "--branding-skill-dir",
        type=Path,
        help="activated aesg-branding skill directory (resolved before import)",
    )
    args = parser.parse_args()
    if args.input.suffix.casefold() != ".docx" or args.output.suffix.casefold() != ".docx":
        raise ValueError("--input and --output must be .docx files")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(args.input.read_bytes())
    repair_report(args.output)
    add_missing_table_of_contents(args.output)
    print(f"repaired AESG report: {args.output.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
