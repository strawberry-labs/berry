#!/usr/bin/env python3
"""Prepare extracted CV JSON for V3 docxtpl rendering."""

from __future__ import annotations

import argparse
import copy
import json
import math
import re
import sys
import zipfile
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

from PIL import ImageFont
from lxml import etree

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from cv_template_common import (  # noqa: E402
    clean_display_line,
    cv_photo_bytes,
    get_section,
    load_cvs,
    normalise_project_entries,
    section_bullets,
    section_lines,
    section_text,
    slugify,
)
from text_normalization import repair_text_artifacts  # noqa: E402

DEFAULT_EXTRACTED_ROOT = ROOT / "output" / "extracted"
DEFAULT_INPUT = DEFAULT_EXTRACTED_ROOT / "cv_data.json"
DEFAULT_OUTPUT = DEFAULT_EXTRACTED_ROOT / "preprocessed_cv_data.json"
PORTRAIT_TEMPLATE = ROOT / "assets" / "templates" / "v3" / "aesg_cv_portrait_v3.docx"
LANDSCAPE_TEMPLATE = ROOT / "assets" / "templates" / "v3" / "aesg_cv_landscape_v3.docx"
W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
W = f"{{{W_NS}}}"
WORD_NS = {"w": W_NS}
FONT_MEASURE_SCALE = 10
DEFAULT_CELL_HORIZONTAL_PADDING_DXA = 240
DEFAULT_SIDEBAR_TEXT_INDENT_DXA = 216
# The generated landscape sidebar uses a manual bullet whose visible glyph and
# following space occupy 8.1pt at the template's 9pt font.
# Measuring against the full cell would overestimate the available wrap width
# and can put a sidebar section onto the wrong page.
LANDSCAPE_SIDEBAR_TEXT_INDENT_DXA = 162
# The first-page sidebar table expands to accommodate its content.  Do not
# reserve artificial end-of-row space here: it would move a semantic section
# (Anam's Qualifications is the representative case) to page two even though
# the table has room to grow on page one.
LANDSCAPE_SIDEBAR_FIRST_PAGE_REFLOW_DXA = 0
# The tagged landscape template gives every sidebar section a small visual
# break and every project card a breathing gap.  The page packer must reserve
# those exact gaps or it will place content that Word subsequently pushes.
LANDSCAPE_SIDEBAR_SECTION_GAP_DXA = 120
LANDSCAPE_PROJECT_CARD_GAP_DXA = 120
# These must match the explicit landscape project-cell margins in the DOCX
# builder. Measure against the narrower right lane so the packer never puts a
# card on a page that Word will later overflow.
LANDSCAPE_PROJECT_INTERCOLUMN_PADDING_DXA = 240
LANDSCAPE_PROJECT_OUTER_RIGHT_PADDING_DXA = 120
# Explicitly planned continuation pages already begin below the source
# section's calibrated top margin. They do not need the repeating spacer that
# was required when one Word table flowed onto an unplanned physical page.
LANDSCAPE_CONTINUATION_PROJECT_TABLE_TOP_SPACER_DXA = 0
# Page one deliberately uses no more than two paired project rows.  The
# packer steps down through four, three, two, then one card using their real
# rendered heights; a text-line cutoff would incorrectly leave the first-page
# project area empty when a longer card still physically fits.
LANDSCAPE_PAGE_ONE_PROJECT_MAX_CARDS = 4
# Word adds a final line of row/table flow after the first-page projects grid.
# Reserve it while testing compact project rows so the last card does not split
# into the next page after docxtpl has rendered the table.
LANDSCAPE_FIRST_PAGE_PROJECT_REFLOW_DXA = 240
# A narrow continuation row can only occupy the vertical range of the sidebar
# it sits beside.  Keep a small separator below that sidebar before the
# full-width project table begins.
LANDSCAPE_CONTINUATION_PROJECT_CLEARANCE_DXA = 360

STANDARD_SECTION_HEADINGS = {
    "overview",
    "work experience",
    "professional bodies",
    "professional bodies and memberships",
    "professional memberships",
    "memberships",
    "qualifications",
    "education",
    "core competencies",
    "selected projects",
    "selected project highlights",
    "additional project experience",
}

ADDITIONAL_PROJECT_CATEGORY_HEADINGS = {
    "strategic & frameworks",
    "hospitality & leisure",
    "masterplans & communities",
    "mixed-use",
    "sports & stadiums",
    "commercial",
    "residential",
    "cultural & heritage",
    "infrastructure & utilities",
    "green building certification",
    "sustainability education",
    "high performance building design",
}

MONTH = (
    r"Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|"
    r"Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?"
)
DATE_ENDPOINT = rf"(?:{MONTH})?\s*\d{{4}}|Present|present|Ongoing|ongoing|Current|current"
DATE_RANGE_RE = re.compile(
    rf"(?P<date>(?:(?:{MONTH})\s+)?\d{{4}}\s*[–-]\s*(?:{DATE_ENDPOINT}))",
    re.IGNORECASE,
)
EXPERIENCE_PREFIX_RE = re.compile(
    rf"^\s*(?P<prefix>\(?\s*(?:(?:{MONTH})\s+)?\d{{4}}\s*[–-]\s*(?:{DATE_ENDPOINT})\s*\)?)(?P<body>.*)$",
    re.IGNORECASE,
)
EXPERIENCE_DATE_FIELD_RANGE_RE = re.compile(
    rf"^\s*(?P<start>(?:(?:{MONTH})\s+)?\d{{4}})\s*[–-]\s*"
    rf"(?P<end>{DATE_ENDPOINT})\s*$",
    re.IGNORECASE,
)
LEADING_YEAR_PREFIX_RE = re.compile(r"^\s*(?P<prefix>(?:19|20)\d{2})(?P<body>\s*[,–-].*)$")
SINGLE_YEAR_RE = re.compile(r"(?<!\d)(?:19|20)\d{2}(?!\d)")
CURRENT_DATE_LABEL_RE = re.compile(r"\b(?:present|ongoing|current)\b", re.IGNORECASE)
MONTH_NUMBER = {
    "jan": 1,
    "january": 1,
    "feb": 2,
    "february": 2,
    "mar": 3,
    "march": 3,
    "apr": 4,
    "april": 4,
    "may": 5,
    "jun": 6,
    "june": 6,
    "jul": 7,
    "july": 7,
    "aug": 8,
    "august": 8,
    "sep": 9,
    "sept": 9,
    "september": 9,
    "oct": 10,
    "october": 10,
    "nov": 11,
    "november": 11,
    "dec": 12,
    "december": 12,
}
PROJECT_DATE_PART_RE = re.compile(
    rf"(?:(?P<month>{MONTH})\s+)?(?P<year>(?:19|20)\d{{2}})",
    re.IGNORECASE,
)
LOCATION_RE = re.compile(
    r"\b(?P<location>UAE|KSA|Qatar|Saudi Arabia|United Arab Emirates|Dubai|Abu Dhabi|"
    r"Sharjah|Riyadh|Jeddah|Egypt|Oman|Kuwait|India|South Africa|Muscat)\b",
    re.IGNORECASE,
)
ROLE_PREFIX_RE = re.compile(
    r"\b(?:assigned as|served as|worked as|acting as|appointed as|role as)\s+"
    r"(?:the\s+)?(?P<role>[A-Z][A-Za-z0-9&/()+,\-\s]{3,90}?)(?:,|\.|:|\s+for\b|\s+to\b)",
    re.IGNORECASE,
)
ROLE_NOUN_RE = re.compile(
    r"\b(?:engineer|manager|consultant|director|lead(?:er)?|controller|architect|"
    r"coordinator|specialist|designer|analyst|assessor|officer|practitioner|pqp|cxa|ica)\b",
    re.IGNORECASE,
)
LEADING_MARKER_RE = re.compile(r"^\s*(?:[a-z]\.|[ivx]+\.)\s+", re.IGNORECASE)


def collapse(value: str | None) -> str:
    value = repair_text_artifacts(value).replace("\u00a0", " ")
    value = value.replace(" - ", " – ")
    return re.sub(r"\s+", " ", value).strip()


def repair_experience_date_fields(
    start_value: str | None,
    end_value: str | None,
) -> tuple[str, str]:
    """Split a duplicated full date range into its two endpoint fields."""
    start = collapse(start_value)
    end = collapse(end_value)

    def range_parts(value: str) -> tuple[str, str] | None:
        match = EXPERIENCE_DATE_FIELD_RANGE_RE.fullmatch(value)
        if not match:
            return None
        range_end = collapse(match.group("end"))
        if range_end.casefold() in {"ongoing", "current", "present"}:
            range_end = "Present"
        return collapse(match.group("start")), range_end

    start_range = range_parts(start)
    end_range = range_parts(end)
    if start_range and end_range and start_range == end_range:
        return start_range
    if start_range and (not end or end == start_range[1]):
        return start_range
    if end_range and (not start or start == end_range[0]):
        return end_range
    return start, end


def title_case_heading(value: str) -> str:
    return " ".join(part.capitalize() if part.isupper() else part for part in value.split())


def split_name(name: str) -> tuple[str, str]:
    parts = collapse(name).split(maxsplit=1)
    if not parts:
        return "", ""
    if len(parts) == 1:
        return parts[0], ""
    return parts[0], parts[1]


def sentence_limit(text: str, max_chars: int) -> str:
    text = collapse(text)
    if len(text) <= max_chars:
        return text
    sentences = re.split(r"(?<=[.!?])\s+", text)
    selected: list[str] = []
    total = 0
    for sentence in sentences:
        if selected and total + len(sentence) + 1 > max_chars:
            break
        selected.append(sentence)
        total += len(sentence) + 1
    if selected:
        return collapse(" ".join(selected))
    return text[:max_chars].rstrip()


def item_objects(items: list[str], limit: int | None = None) -> list[dict[str, str]]:
    cleaned = [clean_display_line(collapse(item)) for item in items]
    cleaned = [item for item in cleaned if item]
    if limit is not None:
        cleaned = cleaned[:limit]
    return [{"text": item} for item in cleaned]


def limited_items(items: list[dict[str, Any]], limit: int) -> list[dict[str, Any]]:
    return items[:limit]


def compact_text(value: str, max_chars: int) -> str:
    return collapse(value)


def compact_items(
    items: list[dict[str, Any]],
    *,
    limit: int,
    max_chars: int,
    total_chars: int | None = None,
) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    used = 0
    for item in items[:limit]:
        text = compact_text(str(item.get("text", "")), max_chars)
        if not text:
            continue
        projected = used + len(text)
        if total_chars is not None and output and projected > total_chars:
            break
        clone = dict(item)
        clone["text"] = text
        output.append(clone)
        used = projected
    return output


def split_experience_parts(item: dict[str, Any]) -> dict[str, Any]:
    clone = dict(item)
    text = collapse(str(clone.get("text", "")))
    duration = collapse(str(clone.get("duration", "")))
    prefix = ""
    body = text

    if duration and text.lower().startswith(duration.lower()):
        prefix = f"{duration}: "
        body = text[len(duration) :].lstrip(" ,:–-")
    else:
        match = EXPERIENCE_PREFIX_RE.match(text)
        if match:
            prefix = collapse(match.group("prefix"))
            body = collapse(match.group("body")).lstrip(" ,:–-")
            prefix = f"{prefix} " if prefix.startswith("(") else f"{prefix}: "
        else:
            match = LEADING_YEAR_PREFIX_RE.match(text)
            if match:
                prefix = f"{collapse(match.group('prefix'))}: "
                body = collapse(match.group("body")).lstrip(" ,:–-")
            else:
                colon_index = text.find(":")
                if 0 < colon_index <= 90:
                    candidate = text[:colon_index]
                    if re.search(r"(?:19|20)\d{2}|present|current|ongoing|date", candidate, re.IGNORECASE):
                        prefix = f"{candidate}: "
                        body = text[colon_index + 1 :].lstrip()

    clone["text"] = text
    clone["prefix"] = prefix
    clone["body"] = body
    return clone


def split_experience_items(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    split_items = [split_experience_parts(item) for item in items]
    merged: list[dict[str, Any]] = []

    for item in split_items:
        prefix = collapse(str(item.get("prefix", "")))
        body = collapse(str(item.get("body", "")))
        if not body:
            continue

        # PDF extraction can emit the wrapped tail of an experience entry as
        # a separate structured record (for example "Environment Consultants"
        # or "India"). An undated record is continuation text, not another job.
        if not prefix and merged:
            merged[-1]["body"] = collapse(f"{merged[-1].get('body', '')} {body}")
            merged[-1]["text"] = collapse(
                f"{merged[-1].get('prefix', '')}{merged[-1]['body']}"
            )
            continue

        clone = dict(item)
        clone["prefix"] = str(item.get("prefix", ""))
        clone["body"] = body
        merged.append(clone)

    return merged


def line_looks_complete(value: str) -> bool:
    value = collapse(value)
    return bool(re.search(r"(?:[.!?)]|(?:19|20)\d{2})$", value))


def line_looks_continuation(value: str) -> bool:
    value = collapse(value)
    return bool(re.match(r"^(?:and|or|of|for|in|with|to|the|functional|practises|professions)\b", value, re.I))


CREDENTIAL_START_RE = re.compile(
    r"^(?:advanced\s+)?(?:postgraduate|undergraduate|bachelor(?:'s)?|master(?:'s)?|"
    r"doctor(?:ate)?|diploma|certificate|pgcert|bsc|msc|ba|ma|mba|leed|breeam|"
    r"well|fitwel|gsas|ceequal|modescore|mostadam)\b",
    re.IGNORECASE,
)


def line_starts_new_credential(value: str) -> bool:
    """Identify a visual PDF line that begins a new qualification entry."""
    return bool(CREDENTIAL_START_RE.match(collapse(value)))


def merged_wrapped_items(lines: list[str], *, credentials: bool = False) -> list[str]:
    merged: list[str] = []
    current = ""
    for raw_line in lines:
        marked = bool(re.match(r"\s*(?:[•\uf0b7*]|[-–])\s+", raw_line or ""))
        line = clean_display_line(collapse(raw_line))
        if not line:
            continue
        if marked or not current:
            if current:
                merged.append(current)
            current = line
            continue
        if credentials and line_starts_new_credential(line):
            merged.append(current)
            current = line
        elif line_looks_continuation(line) or not line_looks_complete(current):
            current = collapse(f"{current} {line}")
        else:
            merged.append(current)
            current = line
    if current:
        merged.append(current)
    return merged


def overview(cv: dict[str, Any]) -> str:
    return sentence_limit(section_text(cv, "Overview"), 900)


def experience_items(cv: dict[str, Any], limit: int = 8) -> list[dict[str, Any]]:
    section = get_section(cv, "Work Experience")
    if not section:
        return []
    entries = section.get("work_experience") or []
    if entries:
        output: list[dict[str, Any]] = []
        for entry in entries[:limit]:
            start, end = repair_experience_date_fields(
                entry.get("start_year"),
                entry.get("end_year"),
            )
            role = collapse(entry.get("role"))
            organisation = collapse(entry.get("organisation"))
            raw_text = collapse(entry.get("raw"))

            # Some source PDFs use an en dash between the first year and the
            # range endpoint. The extractor can then store only the first year
            # in ``start_year`` and put "– Present" or "– 2026" at the start
            # of the role. Preserve the original complete line here so the
            # downstream date/body splitter can recover the whole range.
            malformed_range = bool(
                not end
                and raw_text
                and re.match(
                    r"^[–-]\s*(?:present|current|ongoing|(?:19|20)\d{2})\b",
                    role,
                    re.IGNORECASE,
                )
            )
            if malformed_range:
                output.append(
                    {
                        "text": raw_text,
                        "duration": "",
                        "role": role,
                        "organisation": organisation,
                        "raw": entry,
                    }
                )
                continue

            duration = f"{start} – {end}".strip(" –") if end else start
            text = ", ".join(part for part in [duration, role, organisation] if part)
            output.append(
                {
                    "text": text,
                    "duration": duration,
                    "role": role,
                    "organisation": organisation,
                    "raw": entry,
                }
            )
        return output

    return item_objects(section_lines(cv, "Work Experience"), limit=limit)


def key_expertise_items(cv: dict[str, Any]) -> list[dict[str, str]]:
    bullets = section_bullets(cv, "Core Competencies", "Key Expertise")
    return item_objects(bullets, limit=10)


EXPERTISE_RULES: tuple[tuple[str, str], ...] = (
    (r"\b(?:ghg|greenhouse gas)\b", "GHG accounting and carbon management"),
    (r"\bdecarboni[sz]ation\b|\bdecarboni[sz]e\b", "Decarbonization strategies and roadmaps"),
    (r"\bnet\s*[- ]?\s*zero\b", "Net Zero strategy and implementation"),
    (r"\bembodied carbon\b|\bwhole[- ]life\b|\blife cycle\b|\blca\b", "Whole-life and embodied carbon assessment"),
    (r"\b(?:leed|breeam|well|estidama|mostadam|fitwel|gsas)\b", "Green building certification frameworks"),
    (r"\bsustainab", "Sustainability advisory and project delivery"),
    (r"\b(?:facade|façade|curtain wall|cladding|glazing|skylight)\b", "Facade systems, cladding and glazing"),
    (r"\b(?:aluminium|aluminum)\b", "Aluminium facade and glazing works"),
    (r"\bdocument control\b|\bdocumentation\b", "Document control and project documentation"),
    (r"\bdocument management system", "Document management systems"),
    (r"\b(?:tender|submission|submittal|contract)\b", "Tender, submission and contract documentation"),
    (r"\bcompliance\b|\bquality control\b", "Compliance and quality control"),
    (r"\b(?:consultant|vendor|stakeholder|coordination|coordinate)\b", "Consultant, vendor and stakeholder coordination"),
    (r"\bproject management\b|\bproject manager\b|\bmanage[sd]?\b", "Project management and delivery coordination"),
    (r"\benergy\b|\bthermal\b|\bperformance analysis\b", "Energy analysis and performance optimization"),
    (r"\bdaylight\b|\bmicroclimate\b", "Daylight, microclimate and environmental analysis"),
    (r"\bcircular\b", "Circular economy and lifecycle thinking"),
    (r"\bpolicy\b|\brating system\b", "Policy development and rating systems"),
    (r"\bhospitality\b|\bmixed[- ]use\b", "Hospitality and mixed-use developments"),
    (r"\bmasterplan", "Masterplanning and large-scale developments"),
    (r"\binfrastructure\b|\butilities\b", "Infrastructure and utilities coordination"),
    (r"\barchitect", "Architectural design coordination"),
    (r"\bfit[- ]out\b", "Interior fit-out sustainability"),
    (r"\bconstruction\b", "Construction administration support"),
)


ROLE_EXPERTISE_RULES: tuple[tuple[str, str], ...] = (
    (r"\bcarbon\b", "Carbon management and sustainability reporting"),
    (r"\bdocument controller\b", "Document control and project administration"),
    (r"\b(?:facade|façade)\b", "Facade design and coordination"),
    (r"\bsustainab", "Sustainability consulting and project delivery"),
    (r"\barchitect\b", "Architectural and sustainability design coordination"),
)


ROLE_SPECIFIC_EXPERTISE: tuple[tuple[str, tuple[str, ...]], ...] = (
    (
        r"\bdocument controller\b",
        (
            "Document lifecycle management",
            "Document control systems",
            "Tender, submission and contract documentation",
            "Compliance with international standards",
            "Consultant, vendor and stakeholder coordination",
            "Version control and secure archiving",
        ),
    ),
    (
        r"\b(?:facade|façade)\b",
        (
            "Facade design and coordination",
            "Facade systems, cladding and glazing",
            "Aluminium facade and glazing works",
            "Curtain wall and skylight systems",
            "Engineering coordination across project teams",
            "Sustainable facade solutions",
        ),
    ),
)


def inferred_key_expertise(cv: dict[str, Any], projects: list[dict[str, Any]], limit: int = 6) -> list[dict[str, str]]:
    profile = cv.get("profile") or {}
    role = collapse(profile.get("role"))
    project_text = " ".join(
        collapse(" ".join([project.get("name", ""), project.get("description", "")]))
        for project in projects[:8]
    )
    source_text = collapse(" ".join([role, section_text(cv, "Overview"), project_text])).lower()

    inferred: list[str] = []
    for pattern, labels in ROLE_SPECIFIC_EXPERTISE:
        if re.search(pattern, role, re.IGNORECASE):
            return [{"text": item} for item in labels[:limit]]

    for pattern, label in ROLE_EXPERTISE_RULES:
        if re.search(pattern, role, re.IGNORECASE) and label not in inferred:
            inferred.append(label)

    for pattern, label in EXPERTISE_RULES:
        if len(inferred) >= limit:
            break
        if re.search(pattern, source_text, re.IGNORECASE) and label not in inferred:
            inferred.append(label)

    return [{"text": item} for item in inferred[:limit]]


def qualification_items(cv: dict[str, Any]) -> list[dict[str, str]]:
    return item_objects(
        merged_wrapped_items(section_lines(cv, "Qualifications"), credentials=True),
        limit=10,
    )


def education_items(cv: dict[str, Any]) -> list[dict[str, str]]:
    return item_objects(
        merged_wrapped_items(section_lines(cv, "Education"), credentials=True),
        limit=8,
    )


def membership_items(cv: dict[str, Any]) -> list[dict[str, str]]:
    section = get_section(
        cv,
        "Professional Bodies and Memberships",
        "Professional Bodies",
        "Professional Memberships",
        "Memberships",
    )
    if not section:
        return []

    bullets = section.get("bullets") or []
    if bullets:
        return item_objects(bullets, limit=8)

    lines = [line.get("text", "") for line in section.get("lines", [])]
    return item_objects(merged_wrapped_items(lines), limit=8)


def find_duration(text: str) -> str:
    match = DATE_RANGE_RE.search(text)
    if match:
        return collapse(match.group("date"))
    years = SINGLE_YEAR_RE.findall(text)
    if years and re.search(r"(?:^|[,\s–-])(?:19|20)\d{2}(?:\s*[.)–-])?$", text):
        return years[-1]
    return ""


def project_chronology_sort_key(project: dict[str, Any]) -> tuple[int, ...]:
    """Sort dated projects by recency while keeping undated records stable.

    Active projects are the most recent group. Completed projects use their
    latest endpoint first, then their start date. Python's stable sort retains
    source order whenever two projects have the same chronology.
    """
    duration = collapse(project.get("duration"))
    parts = list(PROJECT_DATE_PART_RE.finditer(duration))
    if not parts:
        return (0, 0, 0, 0, 0, 0)

    start = parts[0]
    end = parts[-1]
    start_year = int(start.group("year"))
    end_year = int(end.group("year"))
    start_month = MONTH_NUMBER.get((start.group("month") or "").casefold(), 0)
    end_month = MONTH_NUMBER.get((end.group("month") or "").casefold(), 12)
    is_current = int(bool(CURRENT_DATE_LABEL_RE.search(duration)))

    return (
        1,
        is_current,
        end_year,
        end_month,
        start_year,
        start_month,
    )


def strip_duration(text: str, duration: str) -> str:
    if not duration:
        return text
    stripped = text.replace(duration, " ")
    stripped = stripped.replace(f"({duration})", " ")
    stripped = re.sub(r"\s*[,\-–]\s*$", "", stripped)
    stripped = re.sub(r"^\s*[,\-–]\s*", "", stripped)
    return collapse(stripped)


def extract_location(text: str) -> str:
    match = LOCATION_RE.search(text)
    return collapse(match.group("location")) if match else ""


def clean_role(value: str) -> str:
    value = collapse(value)
    value = re.sub(r"\s+(?:for|to|in)\s*$", "", value, flags=re.IGNORECASE)
    value = value.strip(" .,:;–-")
    blocked = {
        "responsible",
        "responsible in",
        "responsible for",
        "developed",
        "led",
        "managed",
        "worked closely",
    }
    lowered = value.lower()
    if lowered in blocked:
        return ""
    if any(fragment in lowered for fragment in ("well as", "as per", "client requirement")):
        return ""
    if len(value.split()) > 14 or not ROLE_NOUN_RE.search(value):
        return ""
    return value


def extract_role_from_title(title: str, duration: str) -> tuple[str, str]:
    original = collapse(LEADING_MARKER_RE.sub("", title))
    role = ""
    without_duration = strip_duration(original, duration)

    if duration and re.search(r"^\(?\s*" + re.escape(duration) + r"\s*\)?\s*[–-]\s*", original):
        role = re.sub(r"^\(?\s*" + re.escape(duration) + r"\s*\)?\s*[–-]\s*", "", original).strip()
        return "", clean_role(role)

    split = re.split(r"\s+[–-]\s+", without_duration, maxsplit=1)
    if len(split) == 2 and re.search(r"\b(?:engineer|leader|lead|manager|consultant|director|controller|designer)\b", split[1], re.I):
        return collapse(split[0]), clean_role(split[1])

    return without_duration, ""


def extract_role_from_body(body: str) -> str:
    body = collapse(body)
    if not body:
        return ""

    first_sentence = re.split(r"(?<=[.!?])\s+", body, maxsplit=1)[0]
    colon_match = re.match(r"(?P<role>[A-Z][A-Za-z0-9&/()+,\-\s]{4,90})\s*:\s+", first_sentence)
    if colon_match:
        return clean_role(colon_match.group("role"))

    comma_match = re.match(
        r"(?P<role>(?:Project|Sustainability|Carbon|Lead|Senior|Principal|Associate|Document|Façade|Facade)"
        r"[A-Za-z0-9&/()+,\-\s]{4,95}),\s+",
        first_sentence,
    )
    if comma_match:
        return clean_role(comma_match.group("role"))

    prefix_match = ROLE_PREFIX_RE.search(body)
    if prefix_match:
        return clean_role(prefix_match.group("role"))
    return ""


def description_from_project(project: dict[str, Any]) -> str:
    bullets = [collapse(item) for item in project.get("bullets") or [] if collapse(item)]
    if bullets:
        text = collapse(" ".join(bullets))
    else:
        text = collapse(project.get("text"))
        name = collapse(project.get("name"))
        if name and text.startswith(name):
            text = collapse(text[len(name) :])

    # PDF extraction occasionally repeats the final bullet/sentence when a
    # page or text stream boundary is joined. Remove exact normalized repeats
    # and sufficiently long trailing fragments already present at the end of
    # the preceding sentence, while preserving short intentional repetition.
    sentences = re.split(r"(?<=[.!?])\s+", text)
    deduplicated: list[str] = []
    seen: set[str] = set()
    for sentence in sentences:
        sentence = collapse(sentence)
        if not sentence:
            continue
        key = re.sub(r"[^a-z0-9]+", " ", sentence.casefold()).strip()
        if key and key in seen:
            continue
        if (
            key
            and len(key) >= 35
            and len(key.split()) >= 6
            and any(previous.endswith(key) for previous in seen)
        ):
            continue
        if key:
            seen.add(key)
        deduplicated.append(sentence)
    return collapse(" ".join(deduplicated))


def is_duration_only_title(title: str) -> bool:
    title = collapse(LEADING_MARKER_RE.sub("", title))
    duration = find_duration(title)
    without = re.sub(r"[\s() .,:;–-]+", "", strip_duration(title, duration))
    return bool(duration and not without)


def is_role_group_title(title: str) -> bool:
    title = collapse(LEADING_MARKER_RE.sub("", title))
    duration = find_duration(title)
    without, role = extract_role_from_title(title, duration)
    return bool(duration and role and not without)


def is_short_project_name(value: str) -> bool:
    value = collapse(value).strip(".")
    if not value:
        return False
    if len(value) > 140:
        return False
    if value.endswith((".", ":", ";")) and len(value.split()) > 12:
        return False
    return True


def project_from_parts(
    *,
    name: str,
    description: str,
    raw: dict[str, Any],
    source_index: int,
    inherited_duration: str = "",
    inherited_role: str = "",
) -> dict[str, Any] | None:
    raw_name = collapse(name)
    raw_description = collapse(description)
    if not raw_name and not raw_description:
        return None

    explicit_duration = collapse(raw.get("duration"))
    title_duration = find_duration(raw_name)
    duration = (
        inherited_duration
        or explicit_duration
        or title_duration
        or find_duration(raw_description)
    )
    # A date range can wrap between the title cell and the first description
    # line (for example title ending in "2022" and body beginning "2023 ...").
    # Recover that endpoint before the description reaches the renderer.
    if re.fullmatch(r"(?:19|20)\d{2}", duration):
        wrapped_endpoint = re.match(
            r"^(?P<year>(?:19|20)\d{2})\s+(?P<body>[A-Z].+)$",
            raw_description,
        )
        if wrapped_endpoint and int(wrapped_endpoint.group("year")) >= int(duration):
            duration = f"{duration} – {wrapped_endpoint.group('year')}"
            raw_description = collapse(wrapped_endpoint.group("body"))
    cleaned_name, title_role = extract_role_from_title(
        raw_name,
        title_duration or duration,
    )
    explicit_role = collapse(raw.get("role_line"))
    explicit_role = re.sub(r"^role\s*:\s*", "", explicit_role, flags=re.IGNORECASE)
    role = (
        inherited_role
        or clean_role(collapse(raw.get("role")))
        or title_role
        or clean_role(explicit_role)
        or extract_role_from_body(raw_description)
    )
    if not cleaned_name and raw_name and not is_duration_only_title(raw_name):
        cleaned_name = strip_duration(
            LEADING_MARKER_RE.sub("", raw_name),
            title_duration or duration,
        )
    if not cleaned_name:
        # A duration-only grouping is retained in the source-section archive,
        # but it is not a project name suitable for a generated template.
        if is_duration_only_title(raw_name):
            return None
        cleaned_name = raw_name or "Project"

    # Normalize a punctuation separator immediately before a recognized
    # project location without touching true hyphenated project names.
    cleaned_name = re.sub(
        r"[,;]?\s*[-–]\s*(?=(?:KSA|UAE|Qatar|Saudi Arabia|United Arab Emirates|"
        r"Dubai|Abu Dhabi|Sharjah|Riyadh|Jeddah|Egypt|Oman|Kuwait|India|South Africa|Muscat)\b)",
        " – ",
        cleaned_name,
        flags=re.IGNORECASE,
    )

    location = collapse(raw.get("location")) or extract_location(
        " ".join([cleaned_name, raw_description])
    )
    duration_display = f"({duration})" if duration and not duration.startswith("(") else duration
    role_display = role
    client = collapse(raw.get("client") or raw.get("client_name"))
    meta_parts = [part for part in [duration_display, role] if part]

    return {
        "name": cleaned_name.strip(" .,:;–-") or "Project",
        "duration": duration,
        "duration_display": duration_display,
        "duration_suffix": f" - {duration}" if duration else "",
        "role": role,
        "role_display": role_display,
        "role_line": f"Role: {role}" if role else "",
        # Client is retained independently of the role.  Version 1 templates
        # display it as its own project-card line; role remains available in
        # normalized data but is deliberately not rendered by those templates.
        "client": client,
        "client_line": client,
        "duration_line": duration,
        "location": location,
        "description": raw_description,
        "description_short": sentence_limit(raw_description, 420),
        "description_teaser": sentence_limit(raw_description, 320),
        "meta_line": " | ".join(meta_parts),
        "source_section": raw.get("source_section") or raw.get("category") or "",
        "category": raw.get("category") or "",
        "source_index": source_index,
        "raw_text": collapse(raw.get("text")) or raw_name,
        "bullets": [collapse(item) for item in raw.get("bullets") or [] if collapse(item)],
        "content_type": "narrative_project",
        "template_safe": True,
    }


def expand_project(project: dict[str, Any], source_index: int) -> list[dict[str, Any]]:
    title = collapse(project.get("name"))
    duration = find_duration(title)
    _, role = extract_role_from_title(title, duration)
    bullets = [collapse(item) for item in project.get("bullets") or [] if collapse(item)]

    # Date-only records are grouping headers. The following lettered roles and
    # numbered projects may have been merged into their bullets by extraction;
    # rendering that compound record creates a bogus "( )" project card. Keep
    # it in retained_source_sections, but omit it from display projects.
    if is_duration_only_title(title):
        return []

    if is_role_group_title(title) and bullets:
        expanded: list[dict[str, Any]] = []
        for offset, bullet in enumerate(bullets):
            if not is_short_project_name(bullet):
                break
            parsed = project_from_parts(
                name=bullet,
                description="",
                raw=project,
                source_index=source_index + offset,
                inherited_duration=duration,
                inherited_role=role,
            )
            if parsed:
                expanded.append(parsed)
        if len(expanded) == len(bullets):
            return expanded

    parsed = project_from_parts(
        name=title,
        description=description_from_project(project),
        raw=project,
        source_index=source_index,
    )
    return [parsed] if parsed else []


def selected_projects(cv: dict[str, Any]) -> list[dict[str, Any]]:
    section = get_section(cv, "Selected Projects", "Selected Project Highlights")
    if not section:
        return []

    candidates = []
    for project in section.get("projects") or []:
        content_type = collapse(project.get("content_type")).casefold()
        source = collapse(project.get("source")).casefold()
        if content_type and content_type != "narrative_project":
            continue
        if "table" in source:
            continue
        candidates.append(project)
    raw_projects = normalise_project_entries(copy.deepcopy(candidates))
    parsed: list[dict[str, Any]] = []
    for index, project in enumerate(raw_projects):
        parsed.extend(expand_project(project, index))

    parsed.sort(key=project_chronology_sort_key, reverse=True)
    for rank, project in enumerate(parsed, start=1):
        project["rank"] = rank
    return parsed


def additional_project_experience(cv: dict[str, Any]) -> list[dict[str, Any]]:
    groups: list[dict[str, Any]] = []
    for section in cv.get("sections", []):
        heading = section.get("heading") or ""
        if heading.lower() not in ADDITIONAL_PROJECT_CATEGORY_HEADINGS:
            continue

        items = []
        for line in section.get("lines") or []:
            text = collapse(line.get("text"))
            if not text or re.match(r"^Project\s+Location\s+Certification\s*/\s*Target$", text, re.I):
                continue
            items.append({"text": text})

        if not items and section.get("text"):
            text = collapse(section.get("text"))
            text = re.sub(r"Project Location Certification / Target", "", text, flags=re.I)
            if text:
                items.append({"text": text})

        if items:
            groups.append(
                {
                    "heading": heading,
                    "items": items,
                    "entries": items,
                    "source_section": heading,
                    "tables": copy.deepcopy(section.get("tables") or []),
                }
            )
        elif section.get("tables"):
            groups.append(
                {
                    "heading": heading,
                    "items": [],
                    "entries": [],
                    "source_section": heading,
                    "tables": copy.deepcopy(section.get("tables") or []),
                }
            )
    return groups


def additional_sections(cv: dict[str, Any]) -> list[dict[str, Any]]:
    sections: list[dict[str, Any]] = []
    for section in cv.get("sections", []):
        heading = section.get("heading") or ""
        key = heading.lower()
        if key in STANDARD_SECTION_HEADINGS or key in ADDITIONAL_PROJECT_CATEGORY_HEADINGS:
            continue
        lines = [collapse(line.get("text")) for line in section.get("lines") or []]
        lines = [line for line in lines if line]
        if not lines and section.get("text"):
            lines = [collapse(section.get("text"))]
        if lines or section.get("tables"):
            items = [{"text": line} for line in lines]
            sections.append(
                {
                    "heading": heading,
                    "items": items,
                    "entries": items,
                    "tables": copy.deepcopy(section.get("tables") or []),
                }
            )
    return sections


def ordered_sections(context: dict[str, Any]) -> list[dict[str, Any]]:
    sections: list[dict[str, Any]] = []
    sections.append({"key": "overview", "heading": "Overview", "text": context["overview"]})
    for key, heading in [
        ("experience", "Experience"),
        ("selected_projects", "Selected Projects"),
        ("key_expertise", "Key Expertise"),
        ("qualifications", "Qualifications"),
        ("memberships", "Memberships"),
        ("additional_project_experience", "Additional Project Experience"),
        ("additional_sections", "Additional Sections"),
    ]:
        value = context.get(key)
        if value:
            sections.append({"key": key, "heading": heading, "items": value})
    return sections


@dataclass(frozen=True)
class PortraitLayoutMetrics:
    page_content_height_dxa: int = 14654
    continuation_content_height_dxa: int = 14654
    fixed_height_before_overview_dxa: int = 3240
    fixed_height_after_overview_dxa: int = 672
    full_width_dxa: int = 10196
    sidebar_width_dxa: int = 3055
    project_width_dxa: int = 7141
    cell_horizontal_padding_dxa: int = DEFAULT_CELL_HORIZONTAL_PADDING_DXA
    sidebar_text_indent_dxa: int = DEFAULT_SIDEBAR_TEXT_INDENT_DXA
    line_height_dxa: int = 240
    project_body_line_height_dxa: int = 240
    paragraph_after_dxa: int = 120
    section_heading_before_dxa: int = 180
    section_heading_after_dxa: int = 60

    @property
    def project_heading_height_dxa(self) -> int:
        return (
            self.section_heading_before_dxa
            + self.line_height_dxa
            + self.section_heading_after_dxa
        )


@dataclass(frozen=True)
class LandscapeLayoutMetrics:
    page_content_height_dxa: int = 9756
    continuation_content_height_dxa: int = 10376
    fixed_height_before_overview_dxa: int = 2880
    fixed_height_after_overview_dxa: int = 288
    full_width_dxa: int = 15120
    sidebar_width_dxa: int = 5040
    project_width_dxa: int = 4680
    continuation_project_width_dxa: int = 7218
    sidebar_text_indent_dxa: int = LANDSCAPE_SIDEBAR_TEXT_INDENT_DXA
    line_height_dxa: int = 240
    paragraph_after_dxa: int = 120
    section_heading_before_dxa: int = 180
    section_heading_after_dxa: int = 60

    @property
    def section_heading_height_dxa(self) -> int:
        return (
            self.section_heading_before_dxa
            + self.line_height_dxa
            + self.section_heading_after_dxa
        )


def _word_int(element: etree._Element | None, name: str, default: int) -> int:
    if element is None:
        return default
    value = element.get(f"{W}{name}")
    return int(value) if value and value.lstrip("-").isdigit() else default


def _paragraph_base_height_dxa(paragraph: etree._Element, line_height: int) -> int:
    p_pr = paragraph.find(f"{W}pPr")
    spacing = p_pr.find(f"{W}spacing") if p_pr is not None else None
    before = _word_int(spacing, "before", 0)
    after = _word_int(spacing, "after", 0)
    if spacing is not None and spacing.get(f"{W}lineRule") == "exact":
        return before + _word_int(spacing, "line", line_height) + after
    return before + line_height + after


def _style_font_size_half_points(
    styles: etree._Element,
    style_id: str,
    default: int,
) -> int:
    """Resolve a paragraph style's inherited Word font size."""
    current = style_id
    visited: set[str] = set()
    while current and current not in visited:
        visited.add(current)
        matches = styles.xpath(
            f'.//w:style[@w:styleId="{current}"]',
            namespaces=WORD_NS,
        )
        if not matches:
            break
        style = matches[0]
        size = style.find(f"{W}rPr/{W}sz")
        value = _word_int(size, "val", 0)
        if value:
            return value
        based_on = style.find(f"{W}basedOn")
        current = based_on.get(f"{W}val", "") if based_on is not None else ""
    return default


def _auto_line_height_dxa(
    spacing: etree._Element | None,
    font_size_half_points: int,
    default: int,
    *,
    font_line_box_dxa: int | None = None,
) -> int:
    """Convert Word line spacing to physical DXA.

    With ``lineRule="auto"``, Word's ``w:line="240"`` means one line, not
    240 twips. The physical height is therefore the font size multiplied by
    ``line / 240``.
    """
    if spacing is None:
        return default
    line = _word_int(spacing, "line", 240)
    rule = spacing.get(f"{W}lineRule", "auto")
    # A font's rendered line box is taller than its nominal point size.  Word
    # uses that ascent/descent box for ``lineRule="auto"``.  Callers that can
    # measure the real template font should pass it here; the nominal size is
    # retained as a portable fallback.
    font_height = max(
        1,
        font_line_box_dxa
        if font_line_box_dxa is not None
        else font_size_half_points * 10,
    )
    if rule == "exact":
        return max(1, line)
    if rule == "atLeast":
        return max(font_height, line)
    return max(1, round(font_height * line / 240))


@lru_cache(maxsize=1)
def portrait_layout_metrics() -> PortraitLayoutMetrics:
    """Read the portrait page and typography geometry from the tagged template."""
    fallback = PortraitLayoutMetrics()
    if not PORTRAIT_TEMPLATE.exists():
        return fallback
    try:
        with zipfile.ZipFile(PORTRAIT_TEMPLATE) as archive:
            document = etree.fromstring(archive.read("word/document.xml"))
            styles = etree.fromstring(archive.read("word/styles.xml"))

        section = document.xpath(".//w:sectPr", namespaces=WORD_NS)[0]
        page_size = section.find(f"{W}pgSz")
        margins = section.find(f"{W}pgMar")
        page_height = _word_int(page_size, "h", 16838)
        page_content_height = (
            page_height
            - _word_int(margins, "top", 1320)
            - _word_int(margins, "bottom", 864)
        )

        normal_style = styles.xpath(
            './/w:style[@w:styleId="Normal"]', namespaces=WORD_NS
        )[0]
        normal_spacing = normal_style.find(f"{W}pPr/{W}spacing")
        line_height = _word_int(normal_spacing, "line", fallback.line_height_dxa)

        # Project body copy uses the 9pt AESGBodyCopy style, not Normal.
        # Measure its real Verdana line box so narrow project cards are not
        # overestimated with the 11pt Normal line height.
        project_body_font_size = _style_font_size_half_points(
            styles,
            "AESGBodyCopy",
            18,
        )
        measurement_font = portrait_measurement_font(False)
        if hasattr(measurement_font, "getmetrics"):
            ascent, descent = measurement_font.getmetrics()
            project_body_line_box = round(
                (ascent + descent)
                / (9 * FONT_MEASURE_SCALE)
                * (project_body_font_size / 2)
                * 20
            )
        else:
            project_body_line_box = project_body_font_size * 10
        project_body_line_height = _auto_line_height_dxa(
            normal_spacing,
            project_body_font_size,
            fallback.project_body_line_height_dxa,
            font_line_box_dxa=project_body_line_box,
        )

        body = document.find(".//w:body", namespaces=WORD_NS)
        if body is None:
            return fallback
        tables = body.xpath("./w:tbl", namespaces=WORD_NS)
        main_table = tables[1]
        overview_table = tables[0]
        grid_widths = [
            _word_int(column, "w", 0)
            for column in main_table.xpath("./w:tblGrid/w:gridCol", namespaces=WORD_NS)
        ]
        sidebar_width, project_width = grid_widths[:2]
        full_width = _word_int(
            overview_table.find(f"{W}tr/{W}tc/{W}tcPr/{W}tcW"),
            "w",
            sidebar_width + project_width,
        )
        header_height = _word_int(
            main_table.find(f"{W}tr/{W}trPr/{W}trHeight"),
            "val",
            432,
        )

        main_index = list(body).index(main_table)
        overview_index = list(body).index(overview_table)
        fixed_before = sum(
            _paragraph_base_height_dxa(child, line_height)
            for child in list(body)[:overview_index]
            if child.tag == f"{W}p"
        )
        fixed_after = header_height + sum(
            _paragraph_base_height_dxa(child, line_height)
            for child in list(body)[overview_index + 1 : main_index]
            if child.tag == f"{W}p"
        )

        project_paragraphs = document.xpath(
            './/w:p[contains(string(.), "{{ project.description }}")]',
            namespaces=WORD_NS,
        )
        project_spacing = (
            project_paragraphs[0].find(f"{W}pPr/{W}spacing")
            if project_paragraphs
            else None
        )
        paragraph_after = _word_int(
            project_spacing, "after", fallback.paragraph_after_dxa
        )
        heading_paragraphs = document.xpath(
            './/w:p[contains(string(.), "SELECTED PROJECTS")]',
            namespaces=WORD_NS,
        )
        heading_spacing = (
            heading_paragraphs[0].find(f"{W}pPr/{W}spacing")
            if heading_paragraphs
            else None
        )

        return PortraitLayoutMetrics(
            page_content_height_dxa=page_content_height,
            continuation_content_height_dxa=page_content_height,
            fixed_height_before_overview_dxa=fixed_before,
            fixed_height_after_overview_dxa=fixed_after,
            full_width_dxa=full_width,
            sidebar_width_dxa=sidebar_width,
            project_width_dxa=project_width,
            line_height_dxa=line_height,
            project_body_line_height_dxa=project_body_line_height,
            paragraph_after_dxa=paragraph_after,
            section_heading_before_dxa=_word_int(
                heading_spacing, "before", fallback.section_heading_before_dxa
            ),
            section_heading_after_dxa=_word_int(
                heading_spacing, "after", fallback.section_heading_after_dxa
            ),
        )
    except (IndexError, KeyError, OSError, ValueError, zipfile.BadZipFile):
        return fallback


@lru_cache(maxsize=1)
def landscape_layout_metrics() -> LandscapeLayoutMetrics:
    """Read landscape page, cell, and typography geometry from the template."""
    fallback = LandscapeLayoutMetrics()
    if not LANDSCAPE_TEMPLATE.exists():
        return fallback
    try:
        with zipfile.ZipFile(LANDSCAPE_TEMPLATE) as archive:
            document = etree.fromstring(archive.read("word/document.xml"))
            styles = etree.fromstring(archive.read("word/styles.xml"))

        sections = document.xpath(".//w:sectPr", namespaces=WORD_NS)
        first_section, continuation_section = sections[0], sections[-1]

        def content_height(section: etree._Element, default: int) -> int:
            page_size = section.find(f"{W}pgSz")
            margins = section.find(f"{W}pgMar")
            return (
                _word_int(page_size, "h", 11906)
                - _word_int(margins, "top", default)
                - _word_int(margins, "bottom", 850)
            )

        normal_style = styles.xpath(
            './/w:style[@w:styleId="Normal"]', namespaces=WORD_NS
        )[0]
        normal_spacing = normal_style.find(f"{W}pPr/{W}spacing")
        body_font_size = _style_font_size_half_points(
            styles,
            "AESGBodyCopy",
            18,
        )
        # The template uses 9pt Verdana body copy.  At that size Verdana's
        # ascent/descent box is approximately 11pt.  Using only the nominal
        # 9pt value underestimates every wrapped line and makes Word create
        # unplanned continuation pages after rendering.
        measurement_font = portrait_measurement_font(False)
        if hasattr(measurement_font, "getmetrics"):
            ascent, descent = measurement_font.getmetrics()
            measured_line_box_dxa = round(
                (ascent + descent)
                / (9 * FONT_MEASURE_SCALE)
                * (body_font_size / 2)
                * 20
            )
        else:
            measured_line_box_dxa = body_font_size * 10
        line_height = _auto_line_height_dxa(
            normal_spacing,
            body_font_size,
            fallback.line_height_dxa,
            font_line_box_dxa=measured_line_box_dxa,
        )

        body = document.find(".//w:body", namespaces=WORD_NS)
        if body is None:
            return fallback
        tables = body.xpath("./w:tbl", namespaces=WORD_NS)
        overview_table, main_table = tables[:2]
        grid_widths = [
            _word_int(column, "w", 0)
            for column in main_table.xpath("./w:tblGrid/w:gridCol", namespaces=WORD_NS)
        ]
        sidebar_width = grid_widths[0]
        project_cell_width = grid_widths[1]
        project_width = (
            project_cell_width
            - LANDSCAPE_PROJECT_INTERCOLUMN_PADDING_DXA
            - LANDSCAPE_PROJECT_OUTER_RIGHT_PADDING_DXA
        )
        full_width = _word_int(
            overview_table.find(f"{W}tr/{W}tc/{W}tcPr/{W}tcW"),
            "w",
            sum(grid_widths),
        )

        continuation_page_size = continuation_section.find(f"{W}pgSz")
        continuation_margins = continuation_section.find(f"{W}pgMar")
        continuation_width = (
            _word_int(continuation_page_size, "w", 16838)
            - _word_int(continuation_margins, "left", 1123)
            - _word_int(continuation_margins, "right", 818)
        )
        continuation_project_width = (
            continuation_width // 2
            - LANDSCAPE_PROJECT_INTERCOLUMN_PADDING_DXA
            - LANDSCAPE_PROJECT_OUTER_RIGHT_PADDING_DXA
        )

        header_height = _word_int(
            main_table.find(f"{W}tr/{W}trPr/{W}trHeight"), "val", 288
        )
        overview_index = list(body).index(overview_table)
        main_index = list(body).index(main_table)
        fixed_before = sum(
            _paragraph_base_height_dxa(child, line_height)
            for child in list(body)[:overview_index]
            if child.tag == f"{W}p"
        )
        fixed_after = header_height + sum(
            _paragraph_base_height_dxa(child, line_height)
            for child in list(body)[overview_index + 1 : main_index]
            if child.tag == f"{W}p"
        )

        project_paragraphs = document.xpath(
            './/w:p[contains(string(.), "{{ project.description }}")]',
            namespaces=WORD_NS,
        )
        project_spacing = (
            project_paragraphs[0].find(f"{W}pPr/{W}spacing")
            if project_paragraphs
            else None
        )
        heading_paragraphs = document.xpath(
            './/w:p[contains(string(.), "SELECTED PROJECTS")]',
            namespaces=WORD_NS,
        )
        heading_spacing = (
            heading_paragraphs[0].find(f"{W}pPr/{W}spacing")
            if heading_paragraphs
            else None
        )

        return LandscapeLayoutMetrics(
            page_content_height_dxa=content_height(first_section, 1300),
            continuation_content_height_dxa=content_height(continuation_section, 680),
            fixed_height_before_overview_dxa=fixed_before,
            fixed_height_after_overview_dxa=fixed_after,
            full_width_dxa=full_width,
            sidebar_width_dxa=sidebar_width,
            project_width_dxa=project_width,
            continuation_project_width_dxa=continuation_project_width,
            line_height_dxa=line_height,
            paragraph_after_dxa=_word_int(
                project_spacing, "after", fallback.paragraph_after_dxa
            ),
            section_heading_before_dxa=_word_int(
                heading_spacing, "before", fallback.section_heading_before_dxa
            ),
            section_heading_after_dxa=_word_int(
                heading_spacing, "after", fallback.section_heading_after_dxa
            ),
        )
    except (IndexError, KeyError, OSError, ValueError, zipfile.BadZipFile):
        return fallback


@lru_cache(maxsize=2)
def portrait_measurement_font(bold: bool = False) -> ImageFont.ImageFont:
    name = "Verdana Bold.ttf" if bold else "Verdana.ttf"
    candidates = (
        Path("/System/Library/Fonts/Supplemental") / name,
        Path("/Library/Fonts") / name,
        Path("C:/Windows/Fonts") / ("verdanab.ttf" if bold else "verdana.ttf"),
        Path("/usr/share/fonts/truetype/msttcorefonts") / name,
        Path("/usr/share/fonts/truetype/dejavu")
        / ("DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf"),
    )
    size = 9 * FONT_MEASURE_SCALE
    for candidate in candidates:
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size=size)
    return ImageFont.load_default()


def wrapped_line_count(
    runs: list[tuple[str, bool]],
    width_dxa: int,
) -> int:
    """Measure Word-like wrapping with the template's actual Verdana faces."""
    maximum = max(1.0, width_dxa / 20 * FONT_MEASURE_SCALE)
    lines = 1
    used = 0.0
    for text, bold in runs:
        font = portrait_measurement_font(bold)
        for token in re.findall(r"\s*\S+", text or ""):
            token_width = font.getlength(token)
            if used and used + token_width > maximum:
                lines += 1
                used = 0.0
            if token_width <= maximum:
                used += token_width
                continue
            for character in token:
                character_width = font.getlength(character)
                if used and used + character_width > maximum:
                    lines += 1
                    used = 0.0
                used += character_width
    return lines


def portrait_overview_height_dxa(
    overview_text: str,
    metrics: PortraitLayoutMetrics | None = None,
) -> int:
    metrics = metrics or portrait_layout_metrics()
    if not collapse(overview_text):
        return 0
    width = metrics.full_width_dxa - metrics.cell_horizontal_padding_dxa
    return wrapped_line_count([(collapse(overview_text), False)], width) * metrics.line_height_dxa


def portrait_project_height_dxa(
    project: dict[str, Any],
    metrics: PortraitLayoutMetrics | None = None,
) -> int:
    metrics = metrics or portrait_layout_metrics()
    width = metrics.project_width_dxa - metrics.cell_horizontal_padding_dxa
    # Portrait Version 1 renders separate name, client and date paragraphs.
    # Measuring the old combined title/date field (or the now-hidden role)
    # underestimates a card and lets Word split it in the narrow first-page
    # project cell.
    line_height = metrics.project_body_line_height_dxa
    height = (
        wrapped_line_count([(collapse(project.get("name")), True)], width)
        * line_height
        + metrics.paragraph_after_dxa
    )
    client = collapse(project.get("client_line"))
    if client:
        height += (
            wrapped_line_count([(client, False)], width) * line_height
            + metrics.paragraph_after_dxa
        )
    duration = collapse(project.get("duration_line"))
    if duration:
        height += (
            wrapped_line_count([(duration, False)], width) * line_height
            + metrics.paragraph_after_dxa
        )
    # The portrait templates render the complete description paragraph. The
    # placement model must measure that same rendered text; using the shorter
    # teaser made the estimate smaller than the rendered card and let Word
    # push a project off the first page after packing had accepted it.
    description = collapse(project.get("description") or project.get("description_teaser"))
    height += (
        wrapped_line_count([(description, False)], width) * line_height
        + metrics.paragraph_after_dxa
    )
    # Allow a small fixed tolerance for Word's run metrics and table layout.
    # The previous full-line buffer per card was leaving unused project space
    # on portrait page one. Borderline cards still belong in the full-width
    # continuation, not as split narrow-column content.
    return height + 60


def portrait_experience_height_dxa(
    experience: list[dict[str, Any]],
    metrics: PortraitLayoutMetrics | None = None,
) -> int:
    metrics = metrics or portrait_layout_metrics()
    width = metrics.project_width_dxa - metrics.cell_horizontal_padding_dxa
    regular = portrait_measurement_font(False)
    height = 0
    for item in experience:
        prefix = f"{collapse(item.get('prefix')).strip()}\u00a0"
        prefix_points = regular.getlength(prefix) / FONT_MEASURE_SCALE
        body_width = max(metrics.line_height_dxa, width - math.ceil(prefix_points * 20))
        height += (
            wrapped_line_count([(collapse(item.get("body")), False)], body_width)
            * metrics.line_height_dxa
        )
    return height


def portrait_first_page_row_capacity_dxa(
    overview_text: str,
    metrics: PortraitLayoutMetrics | None = None,
) -> int:
    metrics = metrics or portrait_layout_metrics()
    return max(
        0,
        metrics.page_content_height_dxa
        - metrics.fixed_height_before_overview_dxa
        - portrait_overview_height_dxa(overview_text, metrics)
        - metrics.fixed_height_after_overview_dxa,
    )


def _portrait_item_text(item: Any) -> str:
    if isinstance(item, dict):
        return collapse(item.get("text")) or collapse(
            f"{item.get('prefix', '')}{item.get('body', '')}"
        )
    return collapse(item)


def portrait_sidebar_block_height_dxa(
    items: list[dict[str, Any]],
    *,
    include_heading: bool,
    metrics: PortraitLayoutMetrics | None = None,
) -> int:
    metrics = metrics or portrait_layout_metrics()
    if not items:
        return 0
    width = (
        metrics.sidebar_width_dxa
        - metrics.cell_horizontal_padding_dxa
        - metrics.sidebar_text_indent_dxa
    )
    height = metrics.project_heading_height_dxa if include_heading else 0
    for item in items:
        text = _portrait_item_text(item)
        if text:
            height += wrapped_line_count([(text, False)], width) * metrics.line_height_dxa
    return height + 1


def portrait_sidebar_page_usages_dxa(
    key_expertise: list[dict[str, Any]],
    qualifications: list[dict[str, Any]],
    education: list[dict[str, Any]],
    memberships: list[dict[str, Any]],
    overview_text: str = "",
) -> list[int]:
    """Pack atomic sidebar sections into the actual first/continuation pages."""
    metrics = portrait_layout_metrics()
    blocks = [
        portrait_sidebar_block_height_dxa(
            key_expertise, include_heading=False, metrics=metrics
        ),
        portrait_sidebar_block_height_dxa(
            qualifications, include_heading=True, metrics=metrics
        ),
        portrait_sidebar_block_height_dxa(
            education, include_heading=True, metrics=metrics
        ),
        portrait_sidebar_block_height_dxa(
            memberships, include_heading=True, metrics=metrics
        ),
    ]
    first_capacity = portrait_first_page_row_capacity_dxa(overview_text, metrics)
    continuation_capacity = metrics.continuation_content_height_dxa
    usages = [0]
    capacities = [first_capacity]
    for block_height in [height for height in blocks if height > 0]:
        available = capacities[-1] - usages[-1]
        if block_height <= available:
            usages[-1] += block_height
            continue
        if block_height <= continuation_capacity:
            usages.append(block_height)
            capacities.append(continuation_capacity)
            continue

        # Word is allowed to split only a section intrinsically taller than a
        # complete continuation page. Start it at the next page and model each
        # full page before its final partial page.
        if usages[-1]:
            usages.append(0)
            capacities.append(continuation_capacity)
        remaining = block_height
        while remaining > continuation_capacity:
            usages[-1] = continuation_capacity
            remaining -= continuation_capacity
            usages.append(0)
            capacities.append(continuation_capacity)
        usages[-1] = remaining
    return usages


def portrait_sidebar_pages(
    key_expertise: list[dict[str, Any]],
    qualifications: list[dict[str, Any]],
    education: list[dict[str, Any]],
    memberships: list[dict[str, Any]],
    overview_text: str = "",
) -> list[dict[str, Any]]:
    """Allocate portrait sidebar sections to explicit physical pages.

    The portrait DOCX renderer consumes this layout-only model so that a
    continuation sidebar and its project column can be emitted in the same
    table row.  The normalized CV data remains complete and unchanged.
    """
    metrics = portrait_layout_metrics()
    first_capacity = portrait_first_page_row_capacity_dxa(overview_text, metrics)
    continuation_capacity = metrics.continuation_content_height_dxa
    capacities = [first_capacity]
    pages: list[dict[str, Any]] = [
        {
            "key_expertise": [],
            "qualifications": [],
            "education": [],
            "memberships": [],
            "_used_height_dxa": 0,
        }
    ]

    def next_page() -> None:
        capacities.append(continuation_capacity)
        pages.append(
            {
                "key_expertise": [],
                "qualifications": [],
                "education": [],
                "memberships": [],
                "_used_height_dxa": 0,
            }
        )

    def available_height() -> int:
        return capacities[-1] - int(pages[-1]["_used_height_dxa"])

    for key, items, first_page_has_native_heading in (
        ("key_expertise", key_expertise, True),
        ("qualifications", qualifications, False),
        ("education", education, False),
        ("memberships", memberships, False),
    ):
        if not items:
            continue

        include_heading = not (first_page_has_native_heading and len(pages) == 1)
        block_height = portrait_sidebar_block_height_dxa(
            items,
            include_heading=include_heading,
            metrics=metrics,
        )
        if block_height <= available_height():
            pages[-1][key] = items
            pages[-1]["_used_height_dxa"] += block_height
            continue

        continuation_block_height = portrait_sidebar_block_height_dxa(
            items,
            include_heading=True,
            metrics=metrics,
        )
        if continuation_block_height <= continuation_capacity:
            next_page()
            pages[-1][key] = items
            pages[-1]["_used_height_dxa"] = continuation_block_height
            continue

        # Only a section intrinsically taller than a continuation page may
        # split.  Split at item boundaries and repeat its heading per page.
        if pages[-1]["_used_height_dxa"]:
            next_page()
        width = (
            metrics.sidebar_width_dxa
            - metrics.cell_horizontal_padding_dxa
            - metrics.sidebar_text_indent_dxa
        )
        for item in items:
            item_height = (
                wrapped_line_count([(_portrait_item_text(item), False)], width)
                * metrics.line_height_dxa
            )
            heading_height = (
                metrics.project_heading_height_dxa
                if not pages[-1][key]
                else 0
            )
            if pages[-1][key] and item_height > available_height():
                next_page()
                heading_height = metrics.project_heading_height_dxa
            pages[-1][key].append(item)
            pages[-1]["_used_height_dxa"] += heading_height + item_height
    return pages


def portrait_sidebar_flows_to_page_two(
    key_expertise: list[dict[str, Any]],
    qualifications: list[dict[str, Any]],
    education: list[dict[str, Any]],
    memberships: list[dict[str, Any]],
    overview_text: str = "",
) -> bool:
    return len(
        portrait_sidebar_page_usages_dxa(
            key_expertise,
            qualifications,
            education,
            memberships,
            overview_text,
        )
    ) > 1


def split_portrait_projects(
    projects: list[dict[str, Any]],
    experience: list[dict[str, Any]],
    key_expertise: list[dict[str, Any]],
    qualifications: list[dict[str, Any]],
    education: list[dict[str, Any]],
    memberships: list[dict[str, Any]],
    overview_text: str = "",
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Pack complete projects at measured narrow-column height.

    Page one uses its full right-column capacity independently of the sidebar.
    Continuation pages retain narrow projects only while an atomic sidebar
    section occupies the left column, and only up to that sidebar's height.
    """
    if not projects:
        return [], []
    metrics = portrait_layout_metrics()
    # Place shortest projects first in the narrow columns so the front page
    # fills up with the most that will fit; taller projects overflow to the
    # full-width continuation section.
    projects = sorted(
        projects,
        key=lambda project: portrait_project_height_dxa(project, metrics),
    )
    page_one_capacity = portrait_first_page_row_capacity_dxa(overview_text, metrics)
    project_capacity = max(
        0,
        page_one_capacity
        - portrait_experience_height_dxa(experience, metrics)
        - metrics.project_heading_height_dxa,
    )

    featured_count = 0
    used_height = 0
    while featured_count < len(projects):
        project_height = portrait_project_height_dxa(projects[featured_count], metrics)
        if used_height + project_height > project_capacity:
            break
        used_height += project_height
        featured_count += 1

    sidebar_pages = portrait_sidebar_page_usages_dxa(
        key_expertise,
        qualifications,
        education,
        memberships,
        overview_text,
    )
    for sidebar_height in sidebar_pages[1:]:
        used_height = 0
        while featured_count < len(projects):
            project_height = portrait_project_height_dxa(
                projects[featured_count], metrics
            )
            if used_height + project_height > sidebar_height:
                break
            used_height += project_height
            featured_count += 1

    return projects[:featured_count], projects[featured_count:]


def landscape_first_page_row_capacity_dxa(
    overview_text: str,
    metrics: LandscapeLayoutMetrics | None = None,
) -> int:
    metrics = metrics or landscape_layout_metrics()
    overview_width = metrics.full_width_dxa - DEFAULT_CELL_HORIZONTAL_PADDING_DXA
    overview_height = (
        wrapped_line_count([(collapse(overview_text), False)], overview_width)
        * metrics.line_height_dxa
        if collapse(overview_text)
        else 0
    )
    return max(
        0,
        metrics.page_content_height_dxa
        - metrics.fixed_height_before_overview_dxa
        - overview_height
        - metrics.fixed_height_after_overview_dxa,
    )


def landscape_first_page_project_capacity_dxa(
    overview_text: str,
    metrics: LandscapeLayoutMetrics | None = None,
) -> int:
    """Return the exact page-one height shared by the grid and its packer."""
    metrics = metrics or landscape_layout_metrics()
    return max(
        0,
        landscape_first_page_row_capacity_dxa(overview_text, metrics)
        - LANDSCAPE_FIRST_PAGE_PROJECT_REFLOW_DXA,
    )


def landscape_project_height_dxa(
    project: dict[str, Any],
    *,
    width_dxa: int | None = None,
    metrics: LandscapeLayoutMetrics | None = None,
    description_field: str = "description_teaser",
) -> int:
    metrics = metrics or landscape_layout_metrics()
    width = width_dxa or metrics.project_width_dxa
    line_counts = landscape_project_line_counts(
        project,
        width_dxa=width,
        metrics=metrics,
        description_field=description_field,
    )
    # The reserved line before the description is a carriage return inside
    # the description paragraph, not a separate paragraph.  It therefore
    # contributes a line height but no additional paragraph-after spacing.
    # Only the description paragraph has the template's 6pt after-spacing.
    # Title, client, and duration paragraphs have no direct or inherited
    # after-spacing, so charging each one here rejects cards that Word can
    # safely render in the remaining page-one row.
    return (
        sum(line_counts.values()) * metrics.line_height_dxa
        + metrics.paragraph_after_dxa
        + LANDSCAPE_PROJECT_CARD_GAP_DXA
        + 1
    )


def landscape_project_line_counts(
    project: dict[str, Any],
    *,
    width_dxa: int,
    metrics: LandscapeLayoutMetrics | None = None,
    description_field: str = "description_teaser",
) -> dict[str, int]:
    """Measure the four visible project-card fields as the DOCX renders them."""
    del metrics  # Kept in the signature with the height helper for callers.

    def lines(text: str, *, bold: bool = False, reserve_blank_line: bool = False) -> int:
        value = collapse(text)
        if not value:
            return 1 if reserve_blank_line else 0
        return wrapped_line_count([(value, bold)], width_dxa)

    return {
        "title": lines(str(project.get("name") or ""), bold=True, reserve_blank_line=True),
        # The client paragraph is intentionally present even when no client is
        # supplied.  It gives every card the same title/client/date/body rhythm.
        "client": lines(
            str(project.get("client_line") or ""),
            reserve_blank_line=True,
        ),
        "duration": lines(str(project.get("duration_line") or "")),
        "description_spacer": 1,
        "description": lines(
            str(project.get(description_field) or ""),
            reserve_blank_line=True,
        ),
    }


def landscape_sidebar_pages(
    experience: list[dict[str, Any]],
    key_expertise: list[dict[str, Any]],
    qualifications: list[dict[str, Any]],
    education: list[dict[str, Any]],
    memberships: list[dict[str, Any]],
    overview_text: str,
) -> list[dict[str, Any]]:
    """Allocate sidebar content into physical landscape pages.

    Keeping this page model is important: a single Word table row that spans
    pages lets each cell continue at a different vertical position.  The DOCX
    builder consumes one model entry per page and emits a fresh table below
    each continuation banner instead.
    """
    metrics = landscape_layout_metrics()
    # Keep atomic sidebar blocks slightly inside the actual first-row limit.
    # This is deliberately a layout-only reserve, not a data truncation rule.
    first_capacity = max(
        0,
        landscape_first_page_row_capacity_dxa(overview_text, metrics)
        - LANDSCAPE_SIDEBAR_FIRST_PAGE_REFLOW_DXA,
    )
    continuation_capacity = metrics.continuation_content_height_dxa
    capacities = [first_capacity]
    pages: list[dict[str, Any]] = [
        {
            "experience": [],
            "key_expertise": [],
            "qualifications": [],
            "education": [],
            "memberships": [],
            "_used_height_dxa": 0,
        }
    ]
    text_width = metrics.project_width_dxa - metrics.sidebar_text_indent_dxa

    def next_page() -> None:
        capacities.append(continuation_capacity)
        pages.append(
            {
                "experience": [],
                "key_expertise": [],
                "qualifications": [],
                "education": [],
                "memberships": [],
                "_used_height_dxa": 0,
            }
        )

    def available_height() -> int:
        return capacities[-1] - int(pages[-1]["_used_height_dxa"])

    def place_experience_item(item: dict[str, Any]) -> None:
        text = collapse(
            f"{collapse(item.get('prefix')).strip()} {collapse(item.get('body'))}"
        )
        height = wrapped_line_count([(text, False)], text_width) * metrics.line_height_dxa
        # An individual experience item may be intrinsically taller than the
        # region; allow Word to flow it, but start ordinary items on a fresh
        # page rather than creating a misleading blank project area.
        if pages[-1]["experience"] and height > available_height():
            next_page()
        pages[-1]["experience"].append(item)
        pages[-1]["_used_height_dxa"] += min(height, capacities[-1])

    for item in experience:
        place_experience_item(item)
    if experience:
        pages[-1]["_used_height_dxa"] += min(
            LANDSCAPE_SIDEBAR_SECTION_GAP_DXA,
            max(0, available_height()),
        )

    for key, items in (
        ("key_expertise", key_expertise),
        ("qualifications", qualifications),
        ("education", education),
        ("memberships", memberships),
    ):
        if not items:
            continue
        block_height = (
            metrics.section_heading_height_dxa
            + LANDSCAPE_SIDEBAR_SECTION_GAP_DXA
            + 1
        )
        for item in items:
            text = _portrait_item_text(item)
            block_height += (
                wrapped_line_count([(text, False)], text_width)
                * metrics.line_height_dxa
            )
        available = available_height()
        if block_height <= available:
            pages[-1][key] = items
            pages[-1]["_used_height_dxa"] += block_height
        elif block_height <= continuation_capacity:
            next_page()
            pages[-1][key] = items
            pages[-1]["_used_height_dxa"] = block_height
        else:
            # Only an intrinsically over-height section may split.  Preserve
            # every item and repeat its heading on the continuation fragment.
            if pages[-1]["_used_height_dxa"]:
                next_page()
            for item in items:
                item_height = wrapped_line_count(
                    [(_portrait_item_text(item), False)], text_width
                ) * metrics.line_height_dxa
                heading_height = (
                    metrics.section_heading_height_dxa
                    if not pages[-1][key]
                    else 0
                )
                if pages[-1][key] and item_height > available_height():
                    next_page()
                    heading_height = metrics.section_heading_height_dxa
                pages[-1][key].append(item)
                pages[-1]["_used_height_dxa"] += heading_height + item_height
            pages[-1]["_used_height_dxa"] += LANDSCAPE_SIDEBAR_SECTION_GAP_DXA
    return pages


def landscape_sidebar_page_usages_dxa(
    experience: list[dict[str, Any]],
    key_expertise: list[dict[str, Any]],
    qualifications: list[dict[str, Any]],
    education: list[dict[str, Any]],
    memberships: list[dict[str, Any]],
    overview_text: str,
) -> list[int]:
    """Compatibility view of :func:`landscape_sidebar_pages`."""
    return [
        int(page["_used_height_dxa"])
        for page in landscape_sidebar_pages(
            experience,
            key_expertise,
            qualifications,
            education,
            memberships,
            overview_text,
        )
    ]


def split_landscape_projects(
    projects: list[dict[str, Any]],
    experience: list[dict[str, Any]],
    key_expertise: list[dict[str, Any]],
    qualifications: list[dict[str, Any]],
    education: list[dict[str, Any]],
    memberships: list[dict[str, Any]],
    overview_text: str,
    sidebar_pages: list[dict[str, Any]] | None = None,
    *,
    table_flow_overhead_dxa: int = 0,
) -> tuple[
    list[dict[str, Any]],
    list[dict[str, Any]],
    list[dict[str, Any]],
    list[dict[str, Any]],
    list[dict[str, Any]],
]:
    """Pack compact projects as paired rows, then return a wide-table remainder.

    Page-one and sidebar-continuation projects use true two-card rows.  The
    next row begins only after the taller card in the preceding row, matching
    the full-width continuation table and giving Word legal break boundaries.
    """
    if not projects:
        return [], [], [], [], []
    metrics = landscape_layout_metrics()
    pages = sidebar_pages or landscape_sidebar_pages(
        experience,
        key_expertise,
        qualifications,
        education,
        memberships,
        overview_text,
    )
    page_capacities = [
        landscape_first_page_project_capacity_dxa(overview_text, metrics)
    ]
    # On later pages narrow projects may use only the vertical span occupied
    # by sidebar content.  The later full-width table follows immediately.
    page_capacities.extend(
        max(
            0,
            int(page["_used_height_dxa"])
            - LANDSCAPE_CONTINUATION_PROJECT_CLEARANCE_DXA,
        )
        for page in pages[1:]
    )

    used = [0 for _ in page_capacities]
    page_left: list[list[dict[str, Any]]] = [[] for _ in page_capacities]
    page_right: list[list[dict[str, Any]]] = [[] for _ in page_capacities]
    page_rows: list[list[dict[str, list[dict[str, Any]]]]] = [
        [] for _ in page_capacities
    ]
    project_index = 0
    page_index = 0
    while project_index < len(projects):
        left_project = projects[project_index]
        right_project = (
            projects[project_index + 1]
            if project_index + 1 < len(projects)
            else None
        )
        left_height = landscape_project_height_dxa(left_project, metrics=metrics)
        placed = False
        while page_index < len(page_capacities):
            capacity = page_capacities[page_index]
            page_card_count = len(page_left[page_index]) + len(page_right[page_index])
            page_card_limit = (
                LANDSCAPE_PAGE_ONE_PROJECT_MAX_CARDS
                if page_index == 0
                else None
            )
            can_add_pair = (
                right_project is not None
                and (
                    page_card_limit is None
                    or page_card_count + 2 <= page_card_limit
                )
            )
            pair_height = max(
                left_height,
                landscape_project_height_dxa(right_project, metrics=metrics)
                if right_project is not None
                else 0,
            )

            # Prefer a complete two-column row. If that row does not fit,
            # fall back to a left-only card before giving the project area to
            # the full-width continuation. This is the 4 → 3 → 2 → 1
            # first-page waterfall while preserving source order.
            if can_add_pair and used[page_index] + pair_height <= capacity:
                row = {
                    "projects_left": [left_project],
                    "projects_right": [right_project],
                }
                page_rows[page_index].append(row)
                page_left[page_index].append(left_project)
                page_right[page_index].append(right_project)
                used[page_index] += pair_height
                project_index += 2
                placed = True
                break
            can_add_single = (
                page_card_limit is None or page_card_count + 1 <= page_card_limit
            )
            if can_add_single and used[page_index] + left_height <= capacity:
                page_rows[page_index].append(
                    {"projects_left": [left_project], "projects_right": []}
                )
                page_left[page_index].append(left_project)
                used[page_index] += left_height
                project_index += 1
                placed = True
                break
            page_index += 1
        if not placed:
            break
    continuation_left = [project for lane in page_left[1:] for project in lane]
    continuation_right = [project for lane in page_right[1:] for project in lane]
    for index, page in enumerate(pages):
        page["projects_left"] = page_left[index]
        page["projects_right"] = page_right[index]
        page["project_rows"] = page_rows[index]
        page["_project_left_height_dxa"] = used[index]
        page["_project_right_height_dxa"] = used[index]
        # The following two-column table begins after the complete
        # three-column row, whose height is governed by its tallest cell.
        # Include the mandatory end-of-cell paragraph/table flow overhead so
        # Word and the preprocessor agree on the remaining physical space.
        page["_occupied_height_dxa"] = (
            max(
                int(page["_used_height_dxa"]),
                used[index],
            )
            + table_flow_overhead_dxa
        )
    return (
        page_left[0],
        page_right[0],
        continuation_left,
        continuation_right,
        projects[project_index:],
    )


def balance_landscape_continuation_projects(
    projects: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    metrics = landscape_layout_metrics()
    columns: tuple[list[dict[str, Any]], list[dict[str, Any]]] = ([], [])
    heights = [0, 0]
    for project in projects:
        lane = 0 if heights[0] <= heights[1] else 1
        columns[lane].append(project)
        heights[lane] += landscape_project_height_dxa(
            project,
            width_dxa=metrics.continuation_project_width_dxa,
            metrics=metrics,
        )
    return columns


def pack_landscape_full_width_project_pages(
    projects: list[dict[str, Any]],
    sidebar_pages: list[dict[str, Any]],
    *,
    page_reflow_buffer_dxa: int = 0,
    project_reflow_buffer_dxa: int = 0,
) -> list[dict[str, Any]]:
    """Pack full-width landscape projects into physical two-column pages.

    Model every physical page explicitly. Prefer a complete left/right pair,
    whose row height is governed by its taller card. If the pair does not fit
    but its first card does, place that card alone before starting the next
    physical page. This is the page-2-onward equivalent of the first-page
    4 → 3 → 2 → 1 waterfall and preserves source order.
    """
    if not projects:
        return []

    metrics = landscape_layout_metrics()
    # Word's font metrics, nested-table end paragraphs, and line wrapping can
    # make a theoretically exact page slightly taller than the estimate.
    # Reserve a calibrated two-line allowance so Word never has to create an
    # uncontrolled continuation page.
    page_content_capacity = max(
        0,
        metrics.continuation_content_height_dxa
        - page_reflow_buffer_dxa,
    )
    sidebar_continues = len(sidebar_pages) > 1
    first_page_overhead = (
        metrics.section_heading_height_dxa
        + LANDSCAPE_CONTINUATION_PROJECT_TABLE_TOP_SPACER_DXA
    )
    later_page_overhead = LANDSCAPE_CONTINUATION_PROJECT_TABLE_TOP_SPACER_DXA
    sidebar_occupied_height = (
        int(
            sidebar_pages[-1].get(
                "_occupied_height_dxa",
                sidebar_pages[-1]["_used_height_dxa"],
            )
        )
        if sidebar_continues
        else 0
    )
    # The first full-width table may share the final sidebar-continuation page.
    # It starts beneath the sidebar row, not at the page top.  All later
    # tables start on their own continuation page.
    pages: list[dict[str, Any]] = []
    project_index = 0
    first_project_page = True
    shares_sidebar = sidebar_continues

    while project_index < len(projects):
        fixed_overhead = (
            first_page_overhead
            if first_project_page
            else later_page_overhead
        )
        capacity = max(
            0,
            page_content_capacity
            - fixed_overhead
            - (sidebar_occupied_height if shares_sidebar else 0),
        )
        break_before = not shares_sidebar
        rows: list[dict[str, Any]] = []
        columns: tuple[list[dict[str, Any]], list[dict[str, Any]]] = ([], [])
        used_height = 0

        while project_index < len(projects):
            left_project = projects[project_index]
            left_height = landscape_project_height_dxa(
                left_project,
                width_dxa=metrics.continuation_project_width_dxa,
                metrics=metrics,
                description_field="description",
            ) + project_reflow_buffer_dxa
            right_project = (
                projects[project_index + 1]
                if project_index + 1 < len(projects)
                else None
            )
            right_height = (
                landscape_project_height_dxa(
                    right_project,
                    width_dxa=metrics.continuation_project_width_dxa,
                    metrics=metrics,
                    description_field="description",
                )
                + project_reflow_buffer_dxa
                if right_project is not None
                else 0
            )
            row_height = max(left_height, right_height)
            if (
                right_project is not None
                and used_height + row_height <= capacity
            ):
                rows.append(
                    {
                        "projects_left": [left_project],
                        "projects_right": [right_project],
                        "_height_dxa": row_height,
                    }
                )
                columns[0].append(left_project)
                columns[1].append(right_project)
                used_height += row_height
                project_index += 2
                continue

            # The second project is too tall for this page, but the first may
            # still consume the remaining left-column space.  Do not carry a
            # short card forward solely because its paired neighbour is long.
            if used_height + left_height <= capacity:
                rows.append(
                    {
                        "projects_left": [left_project],
                        "projects_right": [],
                        "_height_dxa": left_height,
                    }
                )
                columns[0].append(left_project)
                used_height += left_height
                project_index += 1
                continue

            break

        if rows:
            pages.append(
                {
                    "project_rows": rows,
                    "projects_left": columns[0],
                    "projects_right": columns[1],
                    "break_before": break_before,
                    "show_heading": first_project_page,
                    "shares_sidebar": shares_sidebar,
                    "_used_height_dxa": used_height,
                    "_capacity_dxa": capacity,
                    "_fixed_overhead_dxa": fixed_overhead,
                }
            )
            first_project_page = False
            shares_sidebar = False
            continue

        # No complete project fits beside the sidebar. Start the first
        # full-width table on a fresh page rather than emit an empty table.
        if shares_sidebar:
            shares_sidebar = False
            continue

        # An intrinsically taller-than-page project must be allowed to flow;
        # keep it isolated so later projects still receive fresh page starts.
        project = projects[project_index]
        pages.append(
            {
                "project_rows": [
                    {
                        "projects_left": [project],
                        "projects_right": [],
                        "_height_dxa": landscape_project_height_dxa(
                            project,
                            width_dxa=metrics.continuation_project_width_dxa,
                            metrics=metrics,
                            description_field="description",
                        )
                        + project_reflow_buffer_dxa,
                    }
                ],
                "projects_left": [project],
                "projects_right": [],
                "break_before": break_before,
                "show_heading": first_project_page,
                "shares_sidebar": False,
                "_used_height_dxa": landscape_project_height_dxa(
                    project,
                    width_dxa=metrics.continuation_project_width_dxa,
                    metrics=metrics,
                    description_field="description",
                )
                + project_reflow_buffer_dxa,
                "_capacity_dxa": capacity,
                "_fixed_overhead_dxa": fixed_overhead,
            }
        )
        project_index += 1
        first_project_page = False
        shares_sidebar = False

    return pages


def strip_foreign_profile_suffix(
    text: str,
    foreign_profile_names: list[str] | None,
) -> str:
    """Remove a copied paragraph that switches to another CV owner.

    Some source PDFs contain a pasted project paragraph from another CV. The
    reliable signal is a sentence boundary followed by another batch member's
    distinctive name and an ownership verb ("Badruddin is...", "Daniel
    led...", etc.). Keep the legitimate prefix and discard the foreign suffix.
    """
    text = collapse(text)
    if not text or not foreign_profile_names:
        return text

    tokens: set[str] = set()
    for profile_name in foreign_profile_names:
        parts = collapse(profile_name).split()
        if not parts:
            continue
        full_name = " ".join(parts)
        if len(full_name) >= 6:
            tokens.add(full_name)
        if len(parts[0]) >= 5:
            tokens.add(parts[0])
    if not tokens:
        return text

    names = "|".join(
        re.escape(value)
        for value in sorted(tokens, key=len, reverse=True)
    )
    foreign_start = re.compile(
        rf"(?:^|(?<=[.!?])\s+)(?:{names})\b\s+"
        r"(?:is|was|served|led|managed|worked|contributed|oversaw)\b",
        re.IGNORECASE,
    )
    match = foreign_start.search(text)
    return text[: match.start()].strip() if match else text


def preprocess_cv(
    cv: dict[str, Any],
    foreign_profile_names: list[str] | None = None,
) -> dict[str, Any]:
    profile = cv.get("profile") or {}
    name = collapse(profile.get("name")) or collapse((cv.get("metadata") or {}).get("Author")) or "Unnamed CV"
    name = title_case_heading(name)
    role = collapse(profile.get("role"))
    first_name, last_name = split_name(name)
    photo = cv.get("profile_photo") or {}
    projects = selected_projects(cv)
    for project in projects:
        description = strip_foreign_profile_suffix(
            project.get("description") or "",
            foreign_profile_names,
        )
        project["description"] = description
        project["description_short"] = sentence_limit(description, 420)
        project["description_teaser"] = sentence_limit(description, 320)
    qualifications = qualification_items(cv)
    key_expertise = key_expertise_items(cv)
    if not key_expertise:
        key_expertise = inferred_key_expertise(cv, projects)
    if not key_expertise and qualifications:
        key_expertise = qualifications[:4]
    experience = split_experience_items(experience_items(cv))
    memberships = membership_items(cv)
    overview_text = overview(cv)

    archived_additional_projects = additional_project_experience(cv)
    archived_additional_sections = additional_sections(cv)
    context: dict[str, Any] = {
        "id": slugify(name).lower(),
        "source": cv.get("source"),
        "source_quality_flags": copy.deepcopy(
            (cv.get("llm_extraction") or {}).get("source_quality_flags") or []
        ),
        "metadata": {
            "name": name,
            "first_name": first_name,
            "last_name": last_name,
            "role": role,
            "source_filename": (cv.get("source") or {}).get("filename"),
        },
        "name": name,
        "first_name": first_name,
        "last_name": last_name,
        "role": role,
        "profile_photo": {
            "has_image": bool(cv_photo_bytes(cv)),
            "mime_type": photo.get("mime_type"),
            "width": photo.get("width"),
            "height": photo.get("height"),
            "base64": photo.get("base64"),
        },
        "overview": overview_text,
        "overview_full": collapse(section_text(cv, "Overview")),
        "experience": experience,
        # Preserve complete sidebar sections. Word flows these across pages and
        # PowerPoint packs them as semantic units; pre-cutting them here caused
        # a section to be split before the layout engines saw it.
        "experience_portrait": experience,
        "experience_landscape": experience,
        "key_expertise": key_expertise,
        "key_expertise_portrait": key_expertise,
        "key_expertise_landscape": key_expertise,
        "qualifications": qualifications,
        # Word and PowerPoint continuation layouts now pack these lists across
        # pages, so preserve complete credentials instead of dropping entries.
        "qualifications_portrait": qualifications,
        "qualifications_landscape": qualifications,
        "memberships": memberships,
        "memberships_portrait": memberships,
        "memberships_landscape": memberships,
        "selected_projects": projects,
        # Extra tables and bespoke sections remain available for auditing and
        # future manual use, but are not part of the common CV template model.
        "additional_project_experience": [],
        "additional_sections": [],
        "archived_additional_project_experience": archived_additional_projects,
        "archived_additional_sections": archived_additional_sections,
        # Lossless audit copy of every source section, including uncommon
        # headings and project tables. Renderers consume only the normalized
        # fields above, so retained-only content never appears automatically.
        "retained_source_sections": copy.deepcopy(
            [
                source_section
                for source_section in (cv.get("sections") or [])
                if collapse(source_section.get("heading")).casefold() != "education"
            ]
        ),
    }
    context["sections"] = ordered_sections(context)
    return context


def build_payload(input_path: Path) -> dict[str, Any]:
    cvs = load_cvs(input_path)
    profile_names = [
        collapse((cv.get("profile") or {}).get("name"))
        for cv in cvs
    ]
    processed = []
    for cv in cvs:
        current_name = collapse((cv.get("profile") or {}).get("name"))
        foreign_names = [
            name
            for name in profile_names
            if name and name.casefold() != current_name.casefold()
        ]
        processed.append(preprocess_cv(cv, foreign_names))
    return {
        "version": "v3",
        "source_file": str(input_path),
        "cv_count": len(processed),
        "cvs": processed,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    payload = build_payload(args.input)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {args.output}")
    print(f"Prepared {payload['cv_count']} CVs")


if __name__ == "__main__":
    main()
