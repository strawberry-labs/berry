#!/usr/bin/env python3
"""Render V3 AESG CV DOCX outputs with docxtpl."""

from __future__ import annotations

import argparse
import base64
import copy
import io
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path
from typing import Any, Callable, Sequence

from PIL import Image, ImageFont, ImageOps
from docx import Document
from docxtpl import DocxTemplate
from lxml import etree

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from cv_template_common import artifact_output_path, fit_profile_name_lines  # noqa: E402
from v3.preprocess_cv_data_v3 import (  # noqa: E402
    landscape_first_page_project_capacity_dxa,
    landscape_sidebar_pages,
    portrait_experience_height_dxa,
    portrait_first_page_row_capacity_dxa,
    portrait_layout_metrics,
    portrait_project_height_dxa,
    portrait_sidebar_block_height_dxa,
    wrapped_line_count,
    split_landscape_projects,
)

from v3.word_layout import (
    verdana_path, experience_tab_dxa, order_ppr, PROJECT_BEFORE_DXA,
)  # noqa: E402

TEMPLATE_DIR = ROOT / "assets" / "templates" / "v3"
DATA_PATH = ROOT / "output" / "extracted" / "preprocessed_cv_data.json"
OUTPUT_ROOT = ROOT / "output" / "generated"
PORTRAIT_TEMPLATE = TEMPLATE_DIR / "aesg_cv_portrait_v3.docx"
LANDSCAPE_TEMPLATE = TEMPLATE_DIR / "aesg_cv_landscape_v3.docx"
AESG_TEAL = (0, 140, 149)
EMU_PER_DXA = 635
W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
W = f"{{{W_NS}}}"
WORD_NS = {"w": W_NS}
EXPERIENCE_FONT_SIZE_PT = 9
EXPERIENCE_MEASURE_SCALE = 10
EXPERIENCE_BULLET_PREFIX = "• "
EXPERIENCE_BODY_SEPARATOR = "\u00a0"
# Landscape's AESGBulletLevel1 places its marker at the cell's left edge and
# starts list text after the glyph. The manual experience marker must use the
# same origin; the measured glyph/date width still controls body wrapping.
EXPERIENCE_BULLET_LEADING_POSITION = 0
LANDSCAPE_TABLE_FLOW_OVERHEAD_DXA = 180
# Native Word table flow is the default. A single render probe is opt-in.
LANDSCAPE_PAGINATION_MODES = ("estimated", "render-validated")
DOCX_RENDERER = (
    Path.home()
    / ".codex"
    / "plugins"
    / "cache"
    / "openai-primary-runtime"
    / "documents"
    / "26.727.11326"
    / "skills"
    / "documents"
    / "render_docx.py"
)
# The text box has invisible slack below the role line. This optical correction
# aligns the role's rendered baseline, not its drawing frame, with the photo.
LANDSCAPE_HEADER_TEXTBOX_VISIBLE_BOTTOM_OFFSET_EMU = 460_000
# Portrait uses a taller text box than landscape. This correction removes its
# invisible lower slack so the rendered designation, rather than the drawing
# frame, ends at the live photo's bottom edge.
PORTRAIT_HEADER_TEXTBOX_VISIBLE_BOTTOM_OFFSET_EMU = 975_000
# Match the portrait block's lower clearance to the landscape reference. At
# 180 DPI this moves the photo and text down together by about 55 pixels.
PORTRAIT_HEADER_VERTICAL_SHIFT_EMU = 280_000
PROFILE_NAME_BASE_SIZE_PT = 28.0
PROFILE_NAME_MIN_SIZE_PT = 16.0
PROFILE_NAME_TEXT_WIDTH_PX = (4_349_750 - 2 * 91_440) / 914_400 * 96
# Reserve only structural table flow, not a whole-project safety margin.
# A boundary project's narrative can continue naturally on the following page.
PORTRAIT_PROJECT_FLOW_BUFFER_DXA = 180
PORTRAIT_SIDEBAR_PAGE_BUFFER_DXA = 300
# The right lane can render a fraction taller than its measured Verdana line
# boxes once Word lays out the complete two-column table.  Keep a separate
# continuation guard so a near-full work-experience/project lane is recognised
# as reaching page two even when the project packer considered it a page-one
# fit.  This controls only the following section break; it does not move or
# omit any project content.
PORTRAIT_RIGHT_LANE_PAGE_BUFFER_DXA = 480


def profile_name_measurement_font(size_pt: float) -> ImageFont.ImageFont:
    """Load the bold Verdana face used by the live profile name."""
    size_px = max(1, round(size_pt * 96 / 72))
    candidates = [
        Path("/System/Library/Fonts/Supplemental/Verdana Bold.ttf"),
        Path("/Library/Fonts/Verdana Bold.ttf"),
        Path("/usr/share/fonts/truetype/msttcorefonts/Verdana_Bold.ttf"),
    ]
    for candidate in candidates:
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size=size_px)
    return ImageFont.load_default()


def fitted_docx_profile_name(
    first_name: str,
    last_name: str,
    orientation: str,
) -> tuple[str, str, float]:
    """Return two display lines and a safe Word name size."""

    def measure_name(text: str, size_pt: float) -> float:
        display = text.upper() if orientation == "landscape" else text
        return float(profile_name_measurement_font(size_pt).getlength(display))

    return fit_profile_name_lines(
        first_name,
        last_name,
        max_width=PROFILE_NAME_TEXT_WIDTH_PX,
        measure=measure_name,
        base_size=PROFILE_NAME_BASE_SIZE_PT,
        min_size=PROFILE_NAME_MIN_SIZE_PT,
    )


def portrait_profile_header_offsets(
    photo_height_emu: int,
    text_box_height_emu: int,
) -> tuple[int, int]:
    """Return aligned page-relative top offsets for the portrait header."""
    photo_offset = PORTRAIT_HEADER_VERTICAL_SHIFT_EMU
    text_offset = max(
        0,
        photo_offset
        + photo_height_emu
        - text_box_height_emu
        + PORTRAIT_HEADER_TEXTBOX_VISIBLE_BOTTOM_OFFSET_EMU,
    )
    return photo_offset, text_offset


def landscape_full_width_project_rows(
    projects: list[dict[str, Any]],
) -> list[dict[str, list[dict[str, Any]]]]:
    """Pair remaining projects into Word-safe, independently breakable rows.

    The Word table itself is the pagination engine.  Do not pre-split this
    collection into predicted physical pages: a tiny wrap difference would
    otherwise turn every following hard page break into a blank or sparse
    page. Headings stay with the first narrative line, while long descriptions
    may flow within a project row when a full pair cannot fit on one page.
    """
    rows: list[dict[str, list[dict[str, Any]]]] = []
    for index in range(0, len(projects), 2):
        rows.append(
            {
                "projects_left": [projects[index]],
                "projects_right": (
                    [projects[index + 1]] if index + 1 < len(projects) else []
                ),
            }
        )
    return rows


def portrait_project_height_for_docx(
    project: dict[str, Any],
    metrics: Any,
) -> int:
    """Measure the actual teaser and explicit paragraph gaps on Word page one."""
    measured = copy.deepcopy(project)
    measured["client_line"] = (
        str(project.get("client_line_display") or "").strip()
        or str(project.get("client_line") or "").strip()
        or "Confidential"
    )
    measured["description"] = (
        str(project.get("description_teaser") or "").strip()
        or str(project.get("description") or "").strip()
    )
    height = portrait_project_height_dxa(measured, metrics)
    return max(metrics.project_body_line_height_dxa, height)


def portrait_project_start_height_for_docx(
    project: dict[str, Any], metrics: Any,
) -> int:
    """Reserve metadata and two opening lines so Word never strands a title."""
    width = metrics.project_width_dxa - metrics.cell_horizontal_padding_dxa
    line_height = metrics.project_body_line_height_dxa
    client = (
        str(project.get("client_line_display") or "").strip()
        or str(project.get("client_line") or "").strip()
        or "Confidential"
    )
    height = wrapped_line_count([(str(project.get("name") or ""), True)], width) * line_height
    height += wrapped_line_count([(client, False)], width) * line_height
    duration = str(project.get("duration_line") or "").strip()
    if duration:
        height += wrapped_line_count([(duration, False)], width) * line_height
    description = str(project.get("description") or project.get("description_teaser") or "")
    body_lines = min(2, wrapped_line_count([(description, False)], width))
    return height + PROJECT_BEFORE_DXA + body_lines * line_height


def portrait_sidebar_height_for_docx(
    key_expertise: list[dict[str, Any]],
    qualifications: list[dict[str, Any]],
    memberships: list[dict[str, Any]],
    metrics: Any,
) -> int:
    """Measure the complete flowing sidebar, including continuation pages."""
    return sum(
        portrait_sidebar_block_height_dxa(items, include_heading=heading, metrics=metrics)
        for items, heading in (
            (key_expertise, False), (qualifications, True), (memberships, True)
        )
    )


def split_portrait_projects_for_docx(
    projects: list[dict[str, Any]],
    experience: list[dict[str, Any]],
    key_expertise: list[dict[str, Any]],
    qualifications: list[dict[str, Any]],
    education: list[dict[str, Any]],
    memberships: list[dict[str, Any]],
    overview_text: str = "",
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Fill the right lane, letting one boundary project continue naturally.

    The lane stays available beside a sidebar that extends beyond page one.
    Keep titles and opening lines together, but do not reject a project merely
    because its complete narrative needs another page. All following projects
    retain the reference's full-width continuation after the two-column table.
    """
    if not projects:
        return [], []
    metrics = portrait_layout_metrics()
    lane_height = max(
        portrait_first_page_row_capacity_dxa(overview_text, metrics),
        portrait_sidebar_height_for_docx(key_expertise, qualifications, memberships, metrics),
    )
    capacity = max(
        0,
        lane_height
        - portrait_experience_height_dxa(experience, metrics)
        - metrics.project_heading_height_dxa
        - PORTRAIT_PROJECT_FLOW_BUFFER_DXA,
    )
    used = 0
    placed = 0
    for project in projects:
        card_height = portrait_project_height_for_docx(project, metrics)
        if used + card_height <= capacity:
            used += card_height
            placed += 1
            continue
        if used + portrait_project_start_height_for_docx(project, metrics) <= capacity:
            # Store the whole narrative exactly once. Word splits this last
            # paragraph at its actual page boundary, not at a guessed word.
            placed += 1
        break
    return projects[:placed], projects[placed:]


def portrait_sidebar_flows_to_page_two_for_docx(
    key_expertise: list[dict[str, Any]],
    qualifications: list[dict[str, Any]],
    memberships: list[dict[str, Any]],
    overview_text: str = "",
) -> bool:
    """Predict whether the actual flowing DOCX sidebar reaches page two.

    Measure the same narrow Verdana line boxes used by the template. A wider,
    lower-leading approximation can fit in a headless fallback-font render but
    still overflow in LibreOffice once the intended font is applied.
    """
    metrics = portrait_layout_metrics()
    height = portrait_sidebar_height_for_docx(
        key_expertise, qualifications, memberships, metrics
    )
    return (
        height + PORTRAIT_SIDEBAR_PAGE_BUFFER_DXA
        > portrait_first_page_row_capacity_dxa(overview_text, metrics)
    )


def portrait_right_lane_flows_to_page_two_for_docx(
    experience: list[dict[str, Any]],
    featured_projects: list[dict[str, Any]],
    overview_text: str = "",
) -> bool:
    """Predict whether the first-page portrait right lane reaches page two.

    The lane contains Work Experience followed by the featured project cards.
    A small table-flow guard accounts for Word/LibreOffice line-box rounding at
    the bottom of a nearly full cell.  If this lane reaches page two, the later
    full-width projects must use a continuous section or Word will add another
    page break and defer them to page three.
    """
    metrics = portrait_layout_metrics()
    height = portrait_experience_height_dxa(experience, metrics)
    if featured_projects:
        height += metrics.project_heading_height_dxa
        height += sum(
            portrait_project_height_for_docx(project, metrics)
            for project in featured_projects
        )
    return (
        height + PORTRAIT_RIGHT_LANE_PAGE_BUFFER_DXA
        > portrait_first_page_row_capacity_dxa(overview_text, metrics)
    )


def docx_render_context(
    cv: dict[str, Any],
    orientation: str,
) -> dict[str, Any]:
    """Derive template-specific pagination without mutating normalized data."""
    context = copy.deepcopy(cv)
    name_line_one, name_line_two, name_size = fitted_docx_profile_name(
        str(context.get("first_name") or ""),
        str(context.get("last_name") or ""),
        orientation,
    )
    context["first_name"] = name_line_one
    context["last_name"] = name_line_two
    context["profile_name_size_pt"] = name_size
    # Keep legacy template variables empty when rendering older preprocessed
    # payloads. New extraction and preprocessing no longer emit Education.
    context["education"] = []
    context["education_portrait"] = []
    context["education_landscape"] = []
    projects = list(context.get("selected_projects") or [])
    experience = list(context.get("experience") or [])
    key_expertise = list(context.get("key_expertise") or [])
    qualifications = list(context.get("qualifications") or [])
    education: list[dict[str, Any]] = []
    memberships = list(context.get("memberships") or [])
    overview = str(context.get("overview") or "")
    landscape_page_one_capacity_dxa = (
        landscape_first_page_project_capacity_dxa(overview)
        if orientation == "landscape"
        else 0
    )

    for project in projects:
        # Word has flowing pages: retain the whole source narrative even when
        # a shared preprocessed payload also includes a shorter slide teaser.
        if str(project.get("description") or "").strip():
            project["description_teaser"] = project["description"]
        # Every project card keeps a usable dedicated client line. When the
        # source CV does not identify a client, use the approved placeholder.
        project["client_line_display"] = (
            str(project.get("client_line") or "").strip() or "Confidential"
        )

    if orientation == "portrait":
        sidebar_flows_to_page_two = portrait_sidebar_flows_to_page_two_for_docx(
            key_expertise,
            qualifications,
            memberships,
            overview,
        )
        featured, remaining = split_portrait_projects_for_docx(
            projects,
            experience,
            key_expertise,
            qualifications,
            education,
            memberships,
            overview,
        )
        right_lane_flows_to_page_two = (
            portrait_right_lane_flows_to_page_two_for_docx(
                experience,
                featured,
                overview,
            )
        )
        first_page_content_flows_to_page_two = (
            sidebar_flows_to_page_two or right_lane_flows_to_page_two
        )
        context.update(
            {
                "selected_projects_featured": featured,
                "selected_projects_remaining": remaining,
                "selected_projects_featured_portrait": featured,
                "selected_projects_remaining_portrait": remaining,
                # The full-width continuation is a distinct project region.
                # Give it its own native heading even when one or more
                # projects were already placed in the first-page right column.
                "selected_projects_heading_on_continuation_portrait": bool(
                    remaining
                ),
                "selected_projects_next_page_section_portrait": bool(remaining),
                "selected_projects_full_width_page_break_portrait": False,
                "portrait_sidebar_flows_to_page_two": sidebar_flows_to_page_two,
                "portrait_right_lane_flows_to_page_two": (
                    right_lane_flows_to_page_two
                ),
                "portrait_first_page_content_flows_to_page_two": (
                    first_page_content_flows_to_page_two
                ),
            }
        )
        return context

    sidebar_pages = landscape_sidebar_pages(
        experience,
        key_expertise,
        qualifications,
        education,
        memberships,
        overview,
    )
    (
        left_projects,
        right_projects,
        continuation_left,
        continuation_right,
        remaining_projects,
    ) = split_landscape_projects(
        projects,
        experience,
        key_expertise,
        qualifications,
        education,
        memberships,
        overview,
        sidebar_pages,
        table_flow_overhead_dxa=LANDSCAPE_TABLE_FLOW_OVERHEAD_DXA,
    )
    featured_count = (
        len(left_projects)
        + len(right_projects)
        + len(continuation_left)
        + len(continuation_right)
    )
    # Keep one flowing project table. Predicted physical page breaks left
    # half-empty landscape pages whenever a whole second pair did not fit.
    # Word can split the narrative rows using the template's widow control.
    full_width_rows = landscape_full_width_project_rows(remaining_projects)
    continuation_pages = sidebar_pages[1:]
    for index, page in enumerate(continuation_pages):
        page["break_after"] = index < len(continuation_pages) - 1
        page["has_project_lane_content"] = bool(
            page.get("projects_left") or page.get("projects_right")
        )
        page["append_full_width_projects"] = False
        page["full_width_project_rows"] = []

    standalone_full_width_pages = []
    if full_width_rows:
        if continuation_pages:
            continuation_pages[-1]["append_full_width_projects"] = True
            continuation_pages[-1]["full_width_project_rows"] = full_width_rows
        else:
            standalone_full_width_pages = [{
                "project_rows": full_width_rows,
                "show_heading": True,
            }]

    context.update(
        {
            "landscape_page1": sidebar_pages[0],
            "landscape_page1_content_row_min_height_dxa": (
                landscape_page_one_capacity_dxa
            ),
            "landscape_sidebar_continuation_pages": continuation_pages,
            "selected_projects_featured_landscape": projects[:featured_count],
            "selected_projects_remaining_landscape": remaining_projects,
            "selected_projects_full_width_page_break_landscape": bool(
                standalone_full_width_pages and not continuation_pages
            ),
            "landscape_full_width_project_rows": full_width_rows,
            "landscape_full_width_project_pages": standalone_full_width_pages,
            "selected_projects_left": left_projects,
            "selected_projects_right": right_projects,
        }
    )
    return context


def run_script(script: Path) -> None:
    subprocess.run([sys.executable, str(script)], cwd=str(ROOT), check=True)


def load_payload(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def render_template(template_path: Path, context: dict[str, Any], output_path: Path) -> None:
    template = DocxTemplate(str(template_path))
    template.render(context, autoescape=True)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    template.save(str(output_path))


W14_NS = "http://schemas.microsoft.com/office/word/2010/wordml"
WP14_NS = "http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing"
WP_NS = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"


def _next_hex_identifier(counter: list[int], used: set[str]) -> str:
    """Return the next unused eight-character OOXML hexadecimal identifier."""
    while True:
        value = f"{counter[0]:08X}"
        counter[0] += 1
        if value not in used:
            used.add(value)
            return value


def _next_decimal_identifier(counter: list[int], used: set[str]) -> str:
    """Return the next unused decimal drawing identifier."""
    while True:
        value = str(counter[0])
        counter[0] += 1
        if value not in used:
            used.add(value)
            return value


def repair_ooxml_identifiers(docx_path: Path) -> None:
    """Make cloned Word drawing/paragraph identifiers unique.

    Docxtpl and the continuation-page builders clone XML fragments. Word
    tolerates many repeated legacy attributes, but it can reject a document
    when Word 2010 paragraph/text IDs or drawing IDs are duplicated. Rewrite
    those identity fields after templating and before later geometry patches.
    The values are document-internal and changing them does not alter visible
    content or layout.
    """
    tmp_path = docx_path.with_suffix(".ids.tmp.docx")
    xml_parts: dict[str, etree._Element] = {}
    with zipfile.ZipFile(docx_path, "r") as source:
        for item in source.infolist():
            name = item.filename
            if (
                name.startswith("word/")
                and name.endswith(".xml")
                and not name.endswith(".rels")
            ):
                try:
                    xml_parts[name] = etree.fromstring(source.read(name))
                except etree.XMLSyntaxError:
                    continue

        counters = {
            "paraId": [1],
            "textId": [1],
            "anchorId": [1],
            "editId": [1],
            "docPr": [1],
        }
        used = {key: set() for key in counters}
        changed_parts: dict[str, bytes] = {}

        for name, root in xml_parts.items():
            changed = False
            for element in root.iter():
                for key, namespace in (
                    ("paraId", W14_NS),
                    ("textId", W14_NS),
                    ("anchorId", WP14_NS),
                    ("editId", WP14_NS),
                ):
                    attribute = f"{{{namespace}}}{key}"
                    if attribute not in element.attrib:
                        continue
                    element.set(
                        attribute,
                        _next_hex_identifier(counters[key], used[key]),
                    )
                    changed = True

                if element.tag == f"{{{WP_NS}}}docPr" and "id" in element.attrib:
                    element.set(
                        "id",
                        _next_decimal_identifier(
                            counters["docPr"],
                            used["docPr"],
                        ),
                    )
                    changed = True

            if changed:
                changed_parts[name] = etree.tostring(
                    root,
                    xml_declaration=True,
                    encoding="UTF-8",
                    standalone="yes",
                )

        if not changed_parts:
            return

        with zipfile.ZipFile(
            tmp_path,
            "w",
            compression=zipfile.ZIP_DEFLATED,
        ) as destination:
            for item in source.infolist():
                destination.writestr(
                    item,
                    changed_parts.get(item.filename, source.read(item.filename)),
                )
    tmp_path.replace(docx_path)


def apply_profile_name_font_size(
    docx_path: Path,
    context: dict[str, Any],
) -> None:
    """Apply the fitted name size to every OOXML fallback copy of the header."""
    name_lines = {
        str(context.get("first_name") or "").strip(),
        str(context.get("last_name") or "").strip(),
    } - {""}
    if not name_lines:
        return
    half_points = str(round(float(context["profile_name_size_pt"]) * 2))
    tmp_path = docx_path.with_suffix(".name-fit.tmp.docx")
    with zipfile.ZipFile(docx_path, "r") as source:
        document = etree.fromstring(source.read("word/document.xml"))
        changed = False
        for run in document.xpath(
            ".//w:txbxContent//w:r",
            namespaces=WORD_NS,
        ):
            text = "".join(run.xpath(".//w:t/text()", namespaces=WORD_NS)).strip()
            if text not in name_lines:
                continue
            properties = run.find(f"{W}rPr")
            if properties is None:
                properties = etree.Element(f"{W}rPr")
                run.insert(0, properties)
            for tag in ("sz", "szCs"):
                size = properties.find(f"{W}{tag}")
                if size is None:
                    size = etree.SubElement(properties, f"{W}{tag}")
                size.set(f"{W}val", half_points)
            changed = True
        if not changed:
            return
        patched = etree.tostring(
            document,
            xml_declaration=True,
            encoding="UTF-8",
            standalone="yes",
        )
        with zipfile.ZipFile(
            tmp_path,
            "w",
            compression=zipfile.ZIP_DEFLATED,
        ) as destination:
            for item in source.infolist():
                destination.writestr(
                    item,
                    patched
                    if item.filename == "word/document.xml"
                    else source.read(item.filename),
                )
    tmp_path.replace(docx_path)


def profile_photo_bytes(context: dict[str, Any]) -> bytes | None:
    photo = context.get("profile_photo") or {}
    encoded = photo.get("base64")
    if not encoded:
        return None
    try:
        return base64.b64decode(encoded)
    except Exception:
        return None


def target_photo_aspect(docx_path: Path, default: float = 1.0) -> float:
    ns = {
        "wp": "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
        "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
        "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    }
    with zipfile.ZipFile(docx_path, "r") as archive:
        rels = etree.fromstring(archive.read("word/_rels/document.xml.rels"))
        relmap = {
            rel.get("Id"): rel.get("Target")
            for rel in rels
            if rel.get("Target")
        }
        document = etree.fromstring(archive.read("word/document.xml"))

    for anchor in document.xpath(".//wp:anchor[.//a:blip]", namespaces=ns):
        rel_ids = anchor.xpath(".//a:blip/@r:embed", namespaces=ns)
        if not rel_ids:
            continue
        if relmap.get(rel_ids[0]) != "media/image1.png":
            continue
        extent = anchor.xpath("./wp:extent", namespaces=ns)
        if not extent:
            continue
        cx = int(extent[0].get("cx", "0"))
        cy = int(extent[0].get("cy", "0"))
        if cx > 0 and cy > 0:
            return cx / cy
    return default


def fitted_photo(
    source: Image.Image,
    size: tuple[int, int],
    fill: tuple[int, int, int] = AESG_TEAL,
    *,
    vertical_alignment: str = "center",
) -> Image.Image:
    image = Image.new("RGB", size, fill)
    contained = ImageOps.contain(source.convert("RGB"), size, method=Image.Resampling.LANCZOS)
    if vertical_alignment not in {"center", "bottom"}:
        raise ValueError("vertical_alignment must be 'center' or 'bottom'")
    y = (
        size[1] - contained.height
        if vertical_alignment == "bottom"
        else (size[1] - contained.height) // 2
    )
    image.paste(
        contained,
        ((size[0] - contained.width) // 2, y),
    )
    return image


def build_photo_replacement(
    data: bytes,
    aspect: float,
    *,
    vertical_alignment: str = "center",
) -> bytes:
    source = Image.open(io.BytesIO(data)).convert("RGB")
    width = 1600
    height = max(1, int(round(width / max(aspect, 0.1))))
    image = fitted_photo(
        source,
        (width, height),
        vertical_alignment=vertical_alignment,
    )
    output = io.BytesIO()
    image.save(output, format="PNG", optimize=True)
    return output.getvalue()


def relationship_map(archive: zipfile.ZipFile) -> dict[str, str]:
    rels = etree.fromstring(archive.read("word/_rels/document.xml.rels"))
    return {rel.get("Id"): rel.get("Target") for rel in rels if rel.get("Id") and rel.get("Target")}


def normalise_word_target(target: str) -> str:
    target = target.lstrip("/")
    if target.startswith("../"):
        target = target[3:]
    if target.startswith("word/"):
        return target
    if target.startswith("media/"):
        return f"word/{target}"
    return target


def header_media_target_aspects(archive: zipfile.ZipFile) -> dict[str, float]:
    ns = {
        "wp": "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
        "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
        "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    }
    aspects: dict[str, float] = {}
    for header_name in [name for name in archive.namelist() if name.startswith("word/header") and name.endswith(".xml")]:
        rels_name = f"word/_rels/{Path(header_name).name}.rels"
        if rels_name not in archive.namelist():
            continue
        rels = etree.fromstring(archive.read(rels_name))
        relmap = {
            rel.get("Id"): normalise_word_target(rel.get("Target") or "")
            for rel in rels
        }
        header = etree.fromstring(archive.read(header_name))
        for anchor in header.xpath(".//wp:anchor[.//a:blip]", namespaces=ns):
            rel_ids = anchor.xpath(".//a:blip/@r:embed", namespaces=ns)
            extent = anchor.find("wp:extent", namespaces=ns)
            if not rel_ids or extent is None:
                continue
            cx = int(extent.get("cx", "0"))
            cy = int(extent.get("cy", "0"))
            target = relmap.get(rel_ids[0], "")
            if target.startswith("word/media/") and cx > 0 and cy > 0:
                aspects[target] = max(aspects.get(target, 0), cx / cy)
    return aspects


def pad_image_to_aspect(data: bytes, target_aspect: float | None) -> bytes:
    if not target_aspect:
        return data
    image = Image.open(io.BytesIO(data)).convert("RGB")
    width, height = image.size
    if height <= 0 or width / height >= target_aspect * 0.999:
        return data

    target_width = int(math.ceil(height * target_aspect))
    output = Image.new("RGB", (target_width, height), "white")
    output.paste(image, (0, 0))
    extension_width = target_width - width
    for y in range(height):
        output.paste(Image.new("RGB", (extension_width, 1), image.getpixel((width - 1, y))), (width, y))

    buffer = io.BytesIO()
    output.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


def first_page_metrics(document: etree._Element) -> tuple[int, int, int]:
    ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    sect_pr = document.xpath(".//w:sectPr", namespaces=ns)[0]
    page_size = sect_pr.find("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}pgSz")
    margins = sect_pr.find("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}pgMar")
    if page_size is None or margins is None:
        raise ValueError("Could not read first page size and margins")
    width = int(page_size.get("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}w"))
    height = int(page_size.get("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}h"))
    left_margin = int(margins.get("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}left", "0"))
    return width, height, left_margin


def profile_anchor_box(
    document: etree._Element,
    relmap: dict[str, str],
    background_size: tuple[int, int],
) -> tuple[int, int, int, int] | None:
    ns = {
        "wp": "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
        "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
        "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    }
    page_width_dxa, page_height_dxa, left_margin_dxa = first_page_metrics(document)
    px_per_emu_x = background_size[0] / (page_width_dxa * EMU_PER_DXA)
    px_per_emu_y = background_size[1] / (page_height_dxa * EMU_PER_DXA)

    for anchor in document.xpath(".//wp:anchor[.//a:blip]", namespaces=ns):
        rel_ids = anchor.xpath(".//a:blip/@r:embed", namespaces=ns)
        if not rel_ids or relmap.get(rel_ids[0]) != "media/image1.png":
            continue

        vertical = anchor.find("wp:positionV", namespaces=ns)
        vertical_offset = vertical.xpath("string(.//wp:posOffset)", namespaces=ns) if vertical is not None else ""
        if not vertical_offset.strip():
            # The current portrait template anchors the profile at the page's
            # ``inside`` edge.  For a vertical page-relative placement this
            # is the top edge on page one.  Treat it as an explicit zero
            # offset so the image can be baked into the editable template
            # artwork instead of leaving Word to paint it behind the teal
            # header shape.
            vertical_alignment = (
                vertical.xpath("string(.//wp:align)", namespaces=ns).strip().lower()
                if vertical is not None
                else ""
            )
            if vertical_alignment == "inside":
                vertical_offset = "0"
            else:
                continue

        horizontal = anchor.find("wp:positionH", namespaces=ns)
        horizontal_offset = horizontal.xpath("string(.//wp:posOffset)", namespaces=ns) if horizontal is not None else "0"
        extent = anchor.find("wp:extent", namespaces=ns)
        if extent is None:
            continue

        h_offset = int(horizontal_offset or 0)
        if horizontal is not None and horizontal.get("relativeFrom") == "column":
            h_offset += left_margin_dxa * EMU_PER_DXA

        x = int(round(h_offset * px_per_emu_x))
        y = int(round(int(vertical_offset) * px_per_emu_y))
        width = int(round(int(extent.get("cx", "0")) * px_per_emu_x))
        height = int(round(int(extent.get("cy", "0")) * px_per_emu_y))
        if width > 0 and height > 0:
            return x, y, width, height
    return None


def remove_profile_photo_anchors(document: etree._Element, relmap: dict[str, str]) -> bytes:
    ns = {
        "wp": "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
        "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
        "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    }
    for drawing in list(document.xpath(".//w:drawing[.//a:blip]", namespaces={**ns, "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"})):
        rel_ids = drawing.xpath(".//a:blip/@r:embed", namespaces=ns)
        if not rel_ids or relmap.get(rel_ids[0]) != "media/image1.png":
            continue
        run = drawing.getparent()
        if run is not None and etree.QName(run).localname == "r":
            parent = run.getparent()
            if parent is not None:
                parent.remove(run)
        else:
            parent = drawing.getparent()
            if parent is not None:
                parent.remove(drawing)

    # The source templates wrap the floating profile image in a picture
    # content control. Removing only the drawing leaves an empty picture SDT,
    # which Word/Quick Look can display later in the document as a small empty
    # square. The profile has already been baked into the native header image,
    # so discard only those now-empty picture controls and retain their anchor
    # paragraphs (and therefore the template's intended vertical rhythm).
    document_ns = {
        "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    }
    for control in list(
        document.xpath(
            ".//w:sdt[w:sdtPr/w:picture and not(.//w:drawing) and "
            "not(.//w:t[normalize-space(.)]) ]",
            namespaces=document_ns,
        )
    ):
        parent = control.getparent()
        if parent is not None:
            parent.remove(control)

    return etree.tostring(
        document,
        xml_declaration=True,
        encoding="UTF-8",
        standalone="yes",
    )


def build_first_page_background(base: bytes, photo_data: bytes, box: tuple[int, int, int, int]) -> bytes:
    background = Image.open(io.BytesIO(base)).convert("RGB")
    photo = Image.open(io.BytesIO(photo_data)).convert("RGB")
    x, y, width, height = box
    frame = fitted_photo(photo, (width, height))
    background.paste(frame, (x, y))
    output = io.BytesIO()
    background.save(output, format="PNG", optimize=True)
    return output.getvalue()


def normalise_landscape_profile_photo_anchors(
    document: etree._Element,
    relmap: dict[str, str],
) -> bool:
    """Keep the source template's first landscape profile-photo anchor only.

    The landscape source DOCX contains two overlapping floating anchors for
    ``image1.png``.  They share the same media part, so replacing that part
    with the candidate photo makes LibreOffice render a thin duplicate at the
    top of the profile frame.  The first anchor is the intended editable
    profile frame; later anchors are legacy duplicates.
    """
    ns = {
        "wp": "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
        "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
        "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    }
    anchors = [
        anchor
        for anchor in document.xpath(".//wp:anchor[.//a:blip]", namespaces=ns)
        if (
            (rel_ids := anchor.xpath(".//a:blip/@r:embed", namespaces=ns))
            and relmap.get(rel_ids[0]) == "media/image1.png"
        )
    ]
    if not anchors:
        return False

    primary = anchors[0]
    changed = (
        primary.get("behindDoc") != "0"
        or primary.get("relativeHeight") != "251662000"
        or len(anchors) > 1
    )
    primary.set("behindDoc", "0")
    primary.set("relativeHeight", "251662000")
    for duplicate in anchors[1:]:
        parent = duplicate.getparent()
        if parent is not None:
            parent.remove(duplicate)
    return changed


def patch_profile_photo(
    docx_path: Path,
    context: dict[str, Any],
    orientation: str,
) -> None:
    """Replace the template profile photo with the candidate photo.

    The photo is kept as a live anchored Word image so it remains editable and
    movable in the generated document. It is no longer baked into the header
    background image. Landscape output also removes the source template's
    duplicate profile anchor so the photo has one visible frame.
    """
    data = profile_photo_bytes(context)
    tmp_path = docx_path.with_suffix(".tmp.docx")
    with zipfile.ZipFile(docx_path, "r") as source:
        document = etree.fromstring(source.read("word/document.xml"))
        relmap = relationship_map(source)
        document_changed = (
            normalise_landscape_profile_photo_anchors(document, relmap)
            if orientation == "landscape"
            else False
        )
        header_aspects = header_media_target_aspects(source)
        media_overrides: dict[str, bytes] = {}

        if data:
            replacement = build_photo_replacement(
                data,
                target_photo_aspect(docx_path),
                vertical_alignment=(
                    "bottom" if orientation == "portrait" else "center"
                ),
            )
            media_overrides["word/media/image1.png"] = replacement

        for media_path, aspect in header_aspects.items():
            if media_path in source.namelist():
                media_overrides[media_path] = pad_image_to_aspect(
                    media_overrides.get(media_path, source.read(media_path)),
                    aspect,
                )

        if not media_overrides and not document_changed:
            return
        patched_document = etree.tostring(
            document,
            xml_declaration=True,
            encoding="UTF-8",
            standalone="yes",
        )

    with zipfile.ZipFile(docx_path, "r") as source, zipfile.ZipFile(
        tmp_path,
        "w",
        compression=zipfile.ZIP_DEFLATED,
    ) as destination:
        for item in source.infolist():
            content = (
                patched_document
                if item.filename == "word/document.xml" and document_changed
                else media_overrides.get(item.filename, source.read(item.filename))
            )
            destination.writestr(item, content)
    tmp_path.replace(docx_path)


def align_portrait_profile_text_to_photo(docx_path: Path) -> None:
    """Align the visible portrait designation with the live photo bottom."""
    ns = {
        "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
        "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
        "w": W_NS,
        "wp": "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
    }
    wp_ns = ns["wp"]
    tmp_path = docx_path.with_suffix(".tmp.docx")
    with zipfile.ZipFile(docx_path, "r") as source:
        document = etree.fromstring(source.read("word/document.xml"))
        relmap = relationship_map(source)
        photo_anchor = next(
            (
                anchor
                for anchor in document.xpath(
                    ".//wp:anchor[.//a:blip]",
                    namespaces=ns,
                )
                if (
                    rel_ids := anchor.xpath(
                        ".//a:blip/@r:embed",
                        namespaces=ns,
                    )
                )
                and relmap.get(rel_ids[0]) == "media/image1.png"
            ),
            None,
        )
        if photo_anchor is None:
            return

        photo_position = photo_anchor.find(f"{{{wp_ns}}}positionV")
        photo_extent = photo_anchor.find(f"{{{wp_ns}}}extent")
        if photo_position is None or photo_extent is None:
            return
        try:
            photo_height = int(photo_extent.get("cy", "0"))
        except ValueError:
            return

        photo_target_offset, _unused_text_offset = (
            portrait_profile_header_offsets(photo_height, 0)
        )
        changed = (
            photo_position.get("relativeFrom") != "page"
            or photo_position.xpath(
                "string(.//wp:posOffset)",
                namespaces=ns,
            )
            != str(photo_target_offset)
        )
        if changed:
            photo_position.set("relativeFrom", "page")
            for child in list(photo_position):
                photo_position.remove(child)
            photo_offset = etree.SubElement(
                photo_position,
                f"{{{wp_ns}}}posOffset",
            )
            photo_offset.text = str(photo_target_offset)

        for text_anchor in document.xpath(
            ".//wp:anchor[.//w:txbxContent]",
            namespaces=ns,
        ):
            text_extent = text_anchor.find(f"{{{wp_ns}}}extent")
            text_position = text_anchor.find(f"{{{wp_ns}}}positionV")
            if text_extent is None or text_position is None:
                continue
            try:
                _photo_offset, target_offset = portrait_profile_header_offsets(
                    photo_height,
                    int(text_extent.get("cy", "0")),
                )
            except ValueError:
                continue
            current_offset = text_position.find(f"{{{wp_ns}}}posOffset")
            if (
                text_position.get("relativeFrom") == "page"
                and current_offset is not None
                and current_offset.text == str(target_offset)
            ):
                continue
            text_position.set("relativeFrom", "page")
            for child in list(text_position):
                text_position.remove(child)
            offset = etree.SubElement(
                text_position,
                f"{{{wp_ns}}}posOffset",
            )
            offset.text = str(target_offset)
            changed = True

        if not changed:
            return
        patched_document = etree.tostring(
            document,
            xml_declaration=True,
            encoding="UTF-8",
            standalone="yes",
        )
        with zipfile.ZipFile(
            tmp_path,
            "w",
            compression=zipfile.ZIP_DEFLATED,
        ) as destination:
            for item in source.infolist():
                destination.writestr(
                    item,
                    patched_document
                    if item.filename == "word/document.xml"
                    else source.read(item.filename),
                )
    tmp_path.replace(docx_path)


def align_landscape_profile_text_to_photo(docx_path: Path) -> None:
    """Align the name/designation drawing's bottom edge to the live photo.

    The source text box is positioned relative to a body paragraph while the
    portrait image is positioned relative to the page.  That makes the
    designation drift below the photo for candidates whose name occupies two
    lines.  Use the actual rendered image geometry as the shared page-relative
    baseline, keeping the original text-box size and typography intact.
    """
    ns = {
        "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
        "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
        "w": W_NS,
        "wp": "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
    }
    wp_ns = ns["wp"]
    tmp_path = docx_path.with_suffix(".tmp.docx")
    with zipfile.ZipFile(docx_path, "r") as source:
        document = etree.fromstring(source.read("word/document.xml"))
        relmap = relationship_map(source)
        photo_anchor = next(
            (
                anchor
                for anchor in document.xpath(".//wp:anchor[.//a:blip]", namespaces=ns)
                if (
                    rel_ids := anchor.xpath(".//a:blip/@r:embed", namespaces=ns)
                )
                and relmap.get(rel_ids[0]) == "media/image1.png"
            ),
            None,
        )
        if photo_anchor is None:
            return

        photo_position = photo_anchor.find(f"{{{wp_ns}}}positionV")
        photo_extent = photo_anchor.find(f"{{{wp_ns}}}extent")
        if photo_position is None or photo_extent is None:
            return
        photo_offset = photo_position.find(f"{{{wp_ns}}}posOffset")
        if photo_offset is None or not photo_offset.text:
            return
        try:
            photo_bottom = int(photo_offset.text) + int(photo_extent.get("cy", "0"))
        except ValueError:
            return

        changed = False
        for text_anchor in document.xpath(".//wp:anchor[.//w:txbxContent]", namespaces=ns):
            text_extent = text_anchor.find(f"{{{wp_ns}}}extent")
            text_position = text_anchor.find(f"{{{wp_ns}}}positionV")
            if text_extent is None or text_position is None:
                continue
            try:
                target_offset = max(
                    0,
                    photo_bottom
                    - int(text_extent.get("cy", "0"))
                    + LANDSCAPE_HEADER_TEXTBOX_VISIBLE_BOTTOM_OFFSET_EMU,
                )
            except ValueError:
                continue
            current_offset = text_position.find(f"{{{wp_ns}}}posOffset")
            if (
                text_position.get("relativeFrom") == "page"
                and current_offset is not None
                and current_offset.text == str(target_offset)
            ):
                continue
            text_position.set("relativeFrom", "page")
            for child in list(text_position):
                text_position.remove(child)
            offset = etree.SubElement(text_position, f"{{{wp_ns}}}posOffset")
            offset.text = str(target_offset)
            changed = True

        if not changed:
            return
        patched_document = etree.tostring(
            document,
            xml_declaration=True,
            encoding="UTF-8",
            standalone="yes",
        )
        with zipfile.ZipFile(
            tmp_path,
            "w",
            compression=zipfile.ZIP_DEFLATED,
        ) as destination:
            for item in source.infolist():
                destination.writestr(
                    item,
                    patched_document
                    if item.filename == "word/document.xml"
                    else source.read(item.filename),
                )
    tmp_path.replace(docx_path)


def experience_measurement_font() -> ImageFont.ImageFont:
    """Measure the actual Verdana face installed in the managed runtime."""
    return ImageFont.truetype(
        str(verdana_path()), size=EXPERIENCE_FONT_SIZE_PT * EXPERIENCE_MEASURE_SCALE
    )


EXPERIENCE_FONT = experience_measurement_font()


def experience_body_indent(prefix: str, *, include_bullet: bool) -> tuple[int, int]:
    """Measure where black body text naturally begins after the date."""
    # Word's tab fallback varies with inherited paragraph defaults. Measure
    # the exact visible leading string. Portrait begins directly with the date;
    # landscape retains its source-template bullet and list-text position.
    bullet = EXPERIENCE_BULLET_PREFIX if include_bullet else ""
    leading_position = EXPERIENCE_BULLET_LEADING_POSITION if include_bullet else 0
    leading_text = f"{bullet}{prefix.strip()}{EXPERIENCE_BODY_SEPARATOR}"
    measured_pixels = EXPERIENCE_FONT.getlength(leading_text)
    # The high-resolution measurement scale maps directly to the Word point
    # coordinate used by the source Verdana run. Applying a second 96-DPI
    # conversion shortens the hanging indent, making a wrapped role begin
    # left of its first word in Microsoft Word.
    width_points = measured_pixels / EXPERIENCE_MEASURE_SCALE
    return leading_position + experience_tab_dxa(width_points), leading_position


def shared_experience_body_indent(
    prefixes: Sequence[str], *, include_bullet: bool
) -> tuple[int, int]:
    """Return one tab stop that accommodates every date in an experience block."""
    positions = [
        experience_body_indent(prefix, include_bullet=include_bullet)
        for prefix in prefixes
    ]
    if not positions:
        raise ValueError("Expected at least one experience date prefix")
    return max(positions, key=lambda measured: measured[0])


def tune_experience_hanging_indents(docx_path: Path, orientation: str) -> None:
    """Align each experience block to its widest date label and body size."""
    tmp_path = docx_path.with_suffix(".tabs.tmp.docx")
    changed = False
    with zipfile.ZipFile(docx_path, "r") as source:
        document = etree.fromstring(source.read("word/document.xml"))
        candidates: list[tuple[etree._Element, list[etree._Element], bool, str]] = []
        for paragraph in document.xpath(".//w:p[w:r/w:t]", namespaces=WORD_NS):
            runs = paragraph.findall(f"{W}r")
            run_text = ["".join(run.xpath("./w:t/text()", namespaces=WORD_NS)) for run in runs]
            include_bullet = bool(run_text and run_text[0].startswith("•"))
            prefix_index = 1 if include_bullet else 0
            if len(runs) < prefix_index + 3:
                continue
            prefix = run_text[prefix_index].strip()
            separator_run = runs[prefix_index + 1]
            separator = run_text[prefix_index + 1]
            has_body_tab = separator_run.find(f"{W}tab") is not None
            if (
                not prefix
                or not any(char.isdigit() for char in prefix)
                or (not has_body_tab and separator.strip())
            ):
                continue
            candidates.append((paragraph, runs, include_bullet, prefix))

        # All values in an experience block begin at the same x-position.  The
        # widest rendered date label establishes its shared tab stop, so a
        # compact label such as "2024:" does not pull the role to the left of
        # "2013 – 2021:" on the next row.
        shared_positions = {
            include_bullet: shared_experience_body_indent(
                [
                    prefix
                    for _, _, candidate_has_bullet, prefix in candidates
                    if candidate_has_bullet == include_bullet
                ],
                include_bullet=include_bullet,
            )
            for include_bullet in {candidate[2] for candidate in candidates}
        }

        for paragraph, runs, include_bullet, _ in candidates:
            # Experience is now unbulleted in both layouts.  Keep support for
            # a visible bullet if a retained template supplies one, but always
            # use the shared measured date/body hanging indent for the block.
            position, leading_position = shared_positions[include_bullet]
            p_pr = paragraph.find(f"{W}pPr")
            if p_pr is None:
                p_pr = etree.Element(f"{W}pPr")
                paragraph.insert(0, p_pr)

            # Template paragraphs can retain direct numbering even after the
            # visible content has been replaced. Any numPr would either add an
            # unwanted portrait bullet or duplicate the landscape marker.
            for num_pr in list(p_pr.findall(f"{W}numPr")):
                p_pr.remove(num_pr)

            p_style = p_pr.find(f"{W}pStyle")
            if p_style is None:
                p_style = etree.Element(f"{W}pStyle")
                p_pr.insert(0, p_style)
            p_style.set(f"{W}val", "AESGBodyCopy")

            justification = p_pr.find(f"{W}jc") if p_pr is not None else None
            if justification is None and p_pr is not None:
                justification = etree.SubElement(p_pr, f"{W}jc")
            if justification is not None:
                justification.set(f"{W}val", "left")
            # The actual tab and the hanging indent use the same measured
            # point. A literal space makes Word and LibreOffice use different
            # font metrics for the first line, which left-shifts wrapping in
            # Word even when the indent itself is correct.
            for tabs in list(p_pr.findall(f"{W}tabs")):
                p_pr.remove(tabs)
            tabs = etree.Element(f"{W}tabs")
            tab = etree.SubElement(tabs, f"{W}tab")
            tab.set(f"{W}val", "left")
            tab.set(f"{W}pos", str(position))
            p_pr.append(tabs)

            indent = p_pr.find(f"{W}ind")
            if indent is None:
                indent = etree.SubElement(p_pr, f"{W}ind")
            for inherited in ("firstLine", "firstLineChars", "hangingChars"):
                indent.attrib.pop(f"{W}{inherited}", None)
            indent.set(f"{W}left", str(position))
            indent.set(f"{W}hanging", str(max(0, position - leading_position)))

            order_ppr(p_pr)

            # Normal is 11pt in the source file, while all other CV body copy
            # is 9pt. Force every visible experience run to the template body
            # size without changing its teal/black colour treatment.
            for run in paragraph.findall(f"{W}r"):
                r_pr = run.find(f"{W}rPr")
                if r_pr is None:
                    r_pr = etree.Element(f"{W}rPr")
                    run.insert(0, r_pr)
                for tag in ("sz", "szCs"):
                    size = r_pr.find(f"{W}{tag}")
                    if size is None:
                        size = etree.SubElement(r_pr, f"{W}{tag}")
                    size.set(f"{W}val", str(EXPERIENCE_FONT_SIZE_PT * 2))
            changed = True

        if not changed:
            return
        patched = etree.tostring(document, xml_declaration=True, encoding="UTF-8", standalone="yes")
        with zipfile.ZipFile(tmp_path, "w", compression=zipfile.ZIP_DEFLATED) as destination:
            for item in source.infolist():
                destination.writestr(item, patched if item.filename == "word/document.xml" else source.read(item.filename))
    tmp_path.replace(docx_path)


def set_portrait_project_continuation_section(
    docx_path: Path,
    has_full_width_projects: bool,
    first_page_content_flows_to_page_two: bool = False,
) -> None:
    """Start full-width projects on page two, but never force page three.

    The paragraph-level ``sectPr`` immediately after the flowing two-column
    table describes the section that is ending.  Word stores the start type of
    the following continuation section on the terminal, body-level ``sectPr``.
    Use ``nextPage`` when the sidebar fits on page one, ensuring continuation
    projects never appear below it on that page. If either side of the
    two-column table reaches page two, keep the section continuous so projects
    begin directly below the completed table instead of being forced onto page
    three. When no continuation projects exist, remove the now-unused section
    boundary entirely. Otherwise its empty paragraph can spill onto a blank
    page when the two-column table ends exactly at the page bottom.
    """
    tmp_path = docx_path.with_suffix(".section.tmp.docx")
    with zipfile.ZipFile(docx_path, "r") as source:
        document = etree.fromstring(source.read("word/document.xml"))
        body = document.find(".//w:body", namespaces=WORD_NS)
        if body is None:
            return

        section = body.find("./w:sectPr", namespaces=WORD_NS)
        if section is None:
            return

        if not has_full_width_projects:
            boundary_sections = body.xpath(
                "./w:p/w:pPr/w:sectPr",
                namespaces=WORD_NS,
            )
            if boundary_sections:
                boundary_section = boundary_sections[-1]
                boundary_paragraph = boundary_section.getparent().getparent()
                # The paragraph-level section describes the first-page CV
                # section and therefore owns its header/footer references,
                # margins, and title-page setting. Promote those properties to
                # the terminal section before removing the empty paragraph.
                single_section = copy.deepcopy(boundary_section)
                single_section_type = single_section.find(f"{W}type")
                if single_section_type is None:
                    single_section_type = etree.Element(f"{W}type")
                    single_section.insert(0, single_section_type)
                single_section_type.set(f"{W}val", "continuous")
                body.replace(section, single_section)
                body.remove(boundary_paragraph)
                section = single_section

        section_type = section.find(f"{W}type")
        if section_type is None:
            section_type = etree.Element(f"{W}type")
            insert_at = 0
            for index, child in enumerate(section):
                if child.tag not in {f"{W}headerReference", f"{W}footerReference"}:
                    insert_at = index
                    break
                insert_at = index + 1
            section.insert(insert_at, section_type)
        section_type.set(
            f"{W}val",
            (
                "continuous"
                if (
                    not has_full_width_projects
                    or first_page_content_flows_to_page_two
                )
                else "nextPage"
            ),
        )
        patched = etree.tostring(
            document,
            xml_declaration=True,
            encoding="UTF-8",
            standalone="yes",
        )
        with zipfile.ZipFile(
            tmp_path,
            "w",
            compression=zipfile.ZIP_DEFLATED,
        ) as destination:
            for item in source.infolist():
                destination.writestr(
                    item,
                    patched
                    if item.filename == "word/document.xml"
                    else source.read(item.filename),
                )
    tmp_path.replace(docx_path)


def collapse_landscape_section_break_paragraph(docx_path: Path) -> None:
    """Keep Word's first landscape section marker on page one.

    The landscape template deliberately places an explicit page break after
    its first section boundary.  When the page-one table reaches the bottom of
    the page, Microsoft Word gives the otherwise empty section-break paragraph
    its inherited 9pt line box and moves that paragraph to page two.  The
    explicit break then moves the real continuation content to page three,
    leaving page two blank.  LibreOffice collapses the same paragraph, which is
    why the defect is Word-only.

    Preserve both the section boundary and the explicit page break, but reduce
    the empty boundary paragraph to a one-DXA line.  Insert ``w:spacing`` before
    ``w:rPr``/``w:sectPr`` so the paragraph-property sequence remains valid
    WordprocessingML and does not trigger Word's repair dialog.
    """
    tmp_path = docx_path.with_suffix(".section-mark.tmp.docx")
    with zipfile.ZipFile(docx_path, "r") as source:
        document = etree.fromstring(source.read("word/document.xml"))
        body = document.find(".//w:body", namespaces=WORD_NS)
        if body is None:
            return

        boundary_paragraphs = body.xpath(
            "./w:p[w:pPr/w:sectPr]",
            namespaces=WORD_NS,
        )
        if not boundary_paragraphs:
            return

        paragraph_properties = boundary_paragraphs[0].find(f"{W}pPr")
        if paragraph_properties is None:
            return

        spacing = paragraph_properties.find(f"{W}spacing")
        if spacing is None:
            spacing = etree.Element(f"{W}spacing")
            insert_at = next(
                (
                    index
                    for index, child in enumerate(paragraph_properties)
                    if child.tag
                    in {f"{W}rPr", f"{W}sectPr", f"{W}pPrChange"}
                ),
                len(paragraph_properties),
            )
            paragraph_properties.insert(insert_at, spacing)
        spacing.set(f"{W}before", "0")
        spacing.set(f"{W}after", "0")
        spacing.set(f"{W}line", "1")
        spacing.set(f"{W}lineRule", "exact")

        run_properties = paragraph_properties.find(f"{W}rPr")
        if run_properties is None:
            run_properties = etree.Element(f"{W}rPr")
            section_properties = paragraph_properties.find(f"{W}sectPr")
            insert_at = (
                paragraph_properties.index(section_properties)
                if section_properties is not None
                else len(paragraph_properties)
            )
            paragraph_properties.insert(insert_at, run_properties)
        for tag in ("sz", "szCs"):
            size = run_properties.find(f"{W}{tag}")
            if size is None:
                size = etree.SubElement(run_properties, f"{W}{tag}")
            size.set(f"{W}val", "2")

        patched = etree.tostring(
            document,
            xml_declaration=True,
            encoding="UTF-8",
            standalone="yes",
        )
        with zipfile.ZipFile(
            tmp_path,
            "w",
            compression=zipfile.ZIP_DEFLATED,
        ) as destination:
            for item in source.infolist():
                destination.writestr(
                    item,
                    patched
                    if item.filename == "word/document.xml"
                    else source.read(item.filename),
                )
    tmp_path.replace(docx_path)


def remove_landscape_unused_sidebar_template_table(
    docx_path: Path,
    has_sidebar_continuation: bool,
) -> None:
    """Remove the dormant sidebar table when page two has no sidebar content.

    Docxtpl cannot conditionally remove a sibling table using a paragraph-level
    control tag. Its empty continuation table otherwise survives rendering and
    can duplicate page-one Qualifications before the full-width projects.
    """
    if has_sidebar_continuation:
        return

    tmp_path = docx_path.with_suffix(".sidebar.tmp.docx")
    with zipfile.ZipFile(docx_path, "r") as source:
        document = etree.fromstring(source.read("word/document.xml"))
        body = document.find(".//w:body", namespaces=WORD_NS)
        if body is None:
            return

        children = list(body)
        first_section_break_index = next(
            (
                index
                for index, child in enumerate(children)
                if child.tag == f"{W}p"
                and child.find(f".//{W}sectPr") is not None
            ),
            None,
        )
        if first_section_break_index is None:
            return

        removed = False
        for child in children[first_section_break_index + 1 :]:
            if child.tag == f"{W}sectPr":
                break
            # The dormant source continuation table has the original
            # three-column grid. The generated full-width projects table has
            # exactly two grid columns and is real candidate content, so it
            # must never be removed when a CV has no sidebar continuation.
            grid_columns = child.xpath("./w:tblGrid/w:gridCol", namespaces=WORD_NS)
            if child.tag == f"{W}tbl" and len(grid_columns) >= 3:
                body.remove(child)
                removed = True
                break
        if not removed:
            return

        patched = etree.tostring(
            document,
            xml_declaration=True,
            encoding="UTF-8",
            standalone="yes",
        )
        with zipfile.ZipFile(
            tmp_path,
            "w",
            compression=zipfile.ZIP_DEFLATED,
        ) as destination:
            for item in source.infolist():
                destination.writestr(
                    item,
                    patched
                    if item.filename == "word/document.xml"
                    else source.read(item.filename),
                )
    tmp_path.replace(docx_path)


def set_landscape_first_page_content_row_min_height(
    docx_path: Path,
    height_dxa: int,
) -> None:
    """Extend the page-one three-column row to its per-CV safe capacity."""
    tmp_path = docx_path.with_suffix(".row-height.tmp.docx")
    with zipfile.ZipFile(docx_path, "r") as source:
        document = etree.fromstring(source.read("word/document.xml"))
        body = document.find(".//w:body", namespaces=WORD_NS)
        if body is None:
            raise ValueError("Landscape DOCX does not contain a body")

        main_table = next(
            (
                table
                for table in body.xpath("./w:tbl", namespaces=WORD_NS)
                if len(
                    table.xpath(
                        "./w:tblGrid/w:gridCol",
                        namespaces=WORD_NS,
                    )
                )
                >= 3
            ),
            None,
        )
        if main_table is None:
            raise ValueError(
                "Landscape DOCX does not contain the first-page three-column table"
            )
        rows = main_table.xpath("./w:tr", namespaces=WORD_NS)
        if len(rows) < 2:
            raise ValueError(
                "Landscape first-page table does not contain its content row"
            )

        row = rows[1]
        row_properties = row.find(f"{W}trPr")
        if row_properties is None:
            row_properties = etree.Element(f"{W}trPr")
            row.insert(0, row_properties)
        row_height = row_properties.find(f"{W}trHeight")
        if row_height is None:
            row_height = etree.SubElement(row_properties, f"{W}trHeight")
        row_height.set(f"{W}val", str(max(0, int(height_dxa))))
        row_height.set(f"{W}hRule", "atLeast")

        patched = etree.tostring(
            document,
            xml_declaration=True,
            encoding="UTF-8",
            standalone="yes",
        )
        with zipfile.ZipFile(
            tmp_path,
            "w",
            compression=zipfile.ZIP_DEFLATED,
        ) as destination:
            for item in source.infolist():
                destination.writestr(
                    item,
                    patched
                    if item.filename == "word/document.xml"
                    else source.read(item.filename),
                )
    tmp_path.replace(docx_path)


def validate_docx(path: Path) -> None:
    Document(str(path))


def write_docx_from_context(
    template_path: Path,
    context: dict[str, Any],
    output_path: Path,
    orientation: str,
) -> None:
    """Render and apply every orientation-specific deterministic patch."""
    render_template(template_path, context, output_path)
    repair_ooxml_identifiers(output_path)
    apply_profile_name_font_size(output_path, context)
    if orientation == "portrait":
        set_portrait_project_continuation_section(
            output_path,
            bool(context.get("selected_projects_remaining_portrait")),
            bool(
                context.get(
                    "portrait_first_page_content_flows_to_page_two"
                )
            ),
        )
    else:
        collapse_landscape_section_break_paragraph(output_path)
        set_landscape_first_page_content_row_min_height(
            output_path,
            max(
                0,
                int(context["landscape_page1_content_row_min_height_dxa"])
                - LANDSCAPE_TABLE_FLOW_OVERHEAD_DXA,
            ),
        )
        remove_landscape_unused_sidebar_template_table(
            output_path,
            bool(context.get("landscape_sidebar_continuation_pages")),
        )
    tune_experience_hanging_indents(output_path, orientation)
    patch_profile_photo(output_path, context, orientation)
    if orientation == "portrait":
        align_portrait_profile_text_to_photo(output_path)
    else:
        align_landscape_profile_text_to_photo(output_path)
    validate_docx(output_path)


def rendered_docx_page_count(
    docx_path: Path,
    output_dir: Path,
) -> int | None:
    """Render a probe DOCX and return its physical page count.

    ``None`` means the render validator is unavailable. The caller then keeps
    the native Word flow, so optional rendering never blocks generation.
    """
    if not DOCX_RENDERER.exists():
        return None
    output_dir.mkdir(parents=True, exist_ok=True)
    environment = os.environ.copy()
    environment.setdefault("TMPDIR", "/private/tmp")
    try:
        subprocess.run(
            [
                sys.executable,
                str(DOCX_RENDERER),
                str(docx_path),
                "--output_dir",
                str(output_dir),
            ],
            cwd=str(ROOT),
            env=environment,
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=60,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return len(list(output_dir.glob("page-*.png"))) or None


def render_validated_landscape_context(
    cv: dict[str, Any],
    template_path: Path,
    output_path: Path,
    *,
    page_count_probe: Callable[[Path, Path], int | None] = rendered_docx_page_count,
) -> tuple[dict[str, Any], bool]:
    """Optionally inspect one completed Word-flow document; never repack in a loop."""
    context = docx_render_context(cv, "landscape")
    write_docx_from_context(template_path, context, output_path, "landscape")
    with tempfile.TemporaryDirectory(prefix=".landscape-validation-",
                                     dir=str(output_path.parent)) as directory:
        actual_page_count = page_count_probe(output_path, Path(directory))
    if actual_page_count is None:
        context["landscape_pagination_mode"] = "estimated"
        context["landscape_render_validation_unavailable"] = True
    else:
        context["landscape_pagination_mode"] = "render-validated"
        context["landscape_rendered_page_count"] = actual_page_count
    return context, True


def render_all(
    data_path: Path,
    output_root: Path,
    requested_orientation: str = "both",
    landscape_pagination_mode: str = "estimated",
) -> list[Path]:
    if landscape_pagination_mode not in LANDSCAPE_PAGINATION_MODES:
        raise ValueError(
            "landscape_pagination_mode must be one of "
            f"{', '.join(LANDSCAPE_PAGINATION_MODES)}"
        )
    payload = load_payload(data_path)
    outputs: list[Path] = []
    claimed_paths: set[Path] = set()
    for cv in payload.get("cvs", []):
        for orientation, template_path in [
            ("portrait", PORTRAIT_TEMPLATE),
            ("landscape", LANDSCAPE_TEMPLATE),
        ]:
            if requested_orientation not in {"both", orientation}:
                continue
            output_path = artifact_output_path(
                output_root,
                cv,
                f"docx_{orientation}",
                ".docx",
            )
            if output_path in claimed_paths:
                raise ValueError(
                    f"Duplicate source PDF path would overwrite an output: {output_path}"
                )
            claimed_paths.add(output_path)
            if (
                orientation == "landscape"
                and landscape_pagination_mode == "render-validated"
            ):
                context, already_written = render_validated_landscape_context(
                    cv,
                    template_path,
                    output_path,
                )
            else:
                context = docx_render_context(cv, orientation)
                if orientation == "landscape":
                    context["landscape_pagination_mode"] = "estimated"
                already_written = False
            if not already_written:
                write_docx_from_context(
                    template_path,
                    context,
                    output_path,
                    orientation,
                )
            outputs.append(output_path)
            mode = (
                f" [{context.get('landscape_pagination_mode')}]"
                if orientation == "landscape"
                else ""
            )
            print(f"Wrote {output_path}{mode}")
    return outputs


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=DATA_PATH)
    parser.add_argument("--output-root", type=Path, default=OUTPUT_ROOT)
    parser.add_argument(
        "--skip-refresh",
        action="store_true",
        help="Do not regenerate preprocessed data and tagged templates before rendering.",
    )
    parser.add_argument(
        "--orientation",
        choices=("portrait", "landscape", "both"),
        default="both",
        help="Render only one orientation, or both (default).",
    )
    parser.add_argument(
        "--landscape-pagination-mode",
        choices=LANDSCAPE_PAGINATION_MODES,
        default="estimated",
        help=(
            "Use native Word page flow (default), or render one optional "
            "page-count probe after generation."
        ),
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if not args.skip_refresh:
        # Refresh normalized data and templates. DOCX-specific pagination is
        # derived later by ``docx_render_context`` for each orientation.
        run_script(ROOT / "scripts" / "v3" / "build_docx_templates_v3.py")
        run_script(ROOT / "scripts" / "v3" / "preprocess_cv_data_v3.py")
    outputs = render_all(
        args.data,
        args.output_root,
        args.orientation,
        args.landscape_pagination_mode,
    )
    print(f"Rendered {len(outputs)} V3 DOCX files")


if __name__ == "__main__":
    main()
