#!/usr/bin/env python3
"""Extract text, layout fragments, section structure, contacts, and images from a PDF.

The script is designed for CV/resume PDFs, but it keeps the output generic enough
for other document types. It uses pypdf only, so it does not require native PDF
utilities such as poppler.
"""

from __future__ import annotations

import argparse
import base64
import json
import re
import sys
import unicodedata
from io import BytesIO
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from PIL import Image, ImageStat

from text_normalization import repair_text_artifacts

try:
    from pypdf import PdfReader
except ImportError as exc:  # pragma: no cover - exercised only when dependency is missing.
    raise SystemExit(
        "Missing dependency: pypdf. Install it with `python3 -m pip install pypdf`."
    ) from exc


EMAIL_RE = re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE)
URL_RE = re.compile(
    r"\b(?:https?://)?(?:www\.)?[A-Z0-9.-]+\.[A-Z]{2,}(?:/[^\s]*)?",
    re.IGNORECASE,
)
PHONE_RE = re.compile(r"(?<!\w)(?:\+?\d[\d\s().-]{7,}\d)(?!\w)")
YEAR_LINE_RE = re.compile(
    r"^(?P<start>\d{4})(?:\s*[–-]\s*(?P<end>Present|\d{4}))?\s*[:,]?\s+(?P<title>.+)$",
    re.IGNORECASE,
)
LOCATION_NAMES = (
    "Abu Dhabi",
    "Saudi Arabia",
    "United Arab Emirates",
    "Dubai",
    "Sharjah",
    "Qatar",
    "Kuwait",
    "Oman",
    "KSA",
    "UAE",
)
LOCATION_RE = re.compile(
    r"(?<!\w)(" + "|".join(re.escape(name) for name in LOCATION_NAMES) + r")(?!\w)",
    re.IGNORECASE,
)

DEFAULT_SECTION_HEADINGS = {
    "overview",
    "key expertise",
    "work experience",
    "qualifications",
    "education",
    "core competencies",
    "professional bodies",
    "professional bodies and memberships",
    "professional memberships",
    "memberships",
    "certifications",
    "training",
    "selected project highlights",
    "selected projects",
    "additional project experience",
    "green building certification",
    "sustainability education",
    "high performance building design",
    "strategic & frameworks",
    "hospitality & leisure",
    "masterplans & communities",
    "mixed-use",
    "sports & stadiums",
    "commercial",
    "residential",
    "cultural & heritage",
    "infrastructure & utilities",
}

TABLE_HEADER_RE = re.compile(
    r"^(?:key\s+)?projects?\s+location(?:\s+client)?\s+certification(?:\s*/\s*target)?$",
    re.IGNORECASE,
)
BULLET_PREFIXES = ("•", "\uf0b7", "-", "–", "*")
NUMBERED_ITEM_RE = re.compile(r"^\d+[.)]\s+")
PROJECT_CATEGORY_HEADINGS = {
    "strategic & frameworks",
    "hospitality & leisure",
    "masterplans & communities",
    "mixed-use",
    "sports & stadiums",
    "commercial",
    "residential",
    "cultural & heritage",
    "infrastructure & utilities",
}


def as_list(value: Any) -> List[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [value]


def normalise_line(line: str) -> str:
    """Normalize whitespace while preserving the actual wording."""
    line = repair_text_artifacts(unicodedata.normalize("NFKC", line))
    line = line.replace("\u00a0", " ")
    line = line.replace("\uf0b7", "•")
    line = re.sub(r"\s*@\s*", "@", line)
    return re.sub(r"[ \t]+", " ", line).strip()


def remove_empty(lines: Iterable[str]) -> List[str]:
    return [line for line in (normalise_line(line) for line in lines) if line]


def is_contact_line(line: str) -> bool:
    stripped = line.strip()
    if EMAIL_RE.fullmatch(stripped) or PHONE_RE.fullmatch(stripped):
        return True
    if URL_RE.fullmatch(stripped) and "@" not in stripped:
        return True
    return False


def is_bullet_line(line: str) -> bool:
    return bool(re.match(r"^(?:[•\uf0b7*]|[-–])\s+", line.strip()))


def strip_bullet_marker(line: str) -> str:
    return re.sub(r"^(?:[•\uf0b7*]|[-–])\s+", "", line.strip()).strip()


def is_likely_continuation(current: str, line: str) -> bool:
    if not current:
        return False
    if is_contact_line(line) or TABLE_HEADER_RE.match(line):
        return False
    if current.endswith((".", "!", "?", ";", ":")):
        return False
    if line[:1].islower() or line.startswith(("(", "&")):
        return True
    return not current.endswith((")", ".)"))


def pdf_date_to_iso(value: Any) -> Any:
    """Convert common PDF date strings to ISO 8601 where possible."""
    if not isinstance(value, str) or not value.startswith("D:"):
        return value

    raw = value[2:]
    match = re.match(
        r"(?P<date>\d{14})(?P<offset>Z|[+-]\d{2}'?\d{2}'?)?", raw
    )
    if not match:
        return value

    parsed = datetime.strptime(match.group("date"), "%Y%m%d%H%M%S")
    offset = match.group("offset")
    if not offset:
        return parsed.isoformat()
    if offset == "Z":
        return f"{parsed.isoformat()}+00:00"

    sign = offset[0]
    digits = re.sub(r"\D", "", offset[1:])
    if len(digits) == 4:
        return f"{parsed.isoformat()}{sign}{digits[:2]}:{digits[2:]}"
    return parsed.isoformat()


def json_safe(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(k).lstrip("/"): json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(item) for item in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return pdf_date_to_iso(value)
    return str(value)


def collect_layout_fragments(page: Any, page_number: int) -> List[Dict[str, Any]]:
    fragments: List[Dict[str, Any]] = []

    def visitor(text: str, _cm: Any, tm: Any, font_dict: Any, font_size: float) -> None:
        content = normalise_line(text)
        if not content:
            return

        x = float(tm[4]) if len(tm) > 4 else None
        y = float(tm[5]) if len(tm) > 5 else None
        font = None
        if font_dict:
            font = str(font_dict.get("/BaseFont", "")).lstrip("/") or None

        fragments.append(
            {
                "page": page_number,
                "text": content,
                "x": round(x, 3) if x is not None else None,
                "y": round(y, 3) if y is not None else None,
                "font_size": round(float(font_size), 3) if font_size is not None else None,
                "font": font,
            }
        )

    page.extract_text(visitor_text=visitor)
    return fragments


def median(values: List[float], default: float) -> float:
    if not values:
        return default
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) / 2


def group_fragments_into_lines(fragments: List[Dict[str, Any]]) -> List[str]:
    usable = [
        fragment
        for fragment in fragments
        if fragment["x"] is not None and fragment["y"] is not None and fragment["text"]
    ]
    if not usable:
        return []

    x_values = sorted({float(fragment["x"]) for fragment in usable})
    x_span = max(x_values) - min(x_values) if len(x_values) > 1 else 0
    column_breaks: List[float] = []
    if x_span:
        gaps = [
            (x_values[index + 1] - x_values[index], x_values[index], x_values[index + 1])
            for index in range(len(x_values) - 1)
        ]
        for gap, left, right in gaps:
            left_count = sum(1 for fragment in usable if float(fragment["x"]) <= left)
            right_count = sum(1 for fragment in usable if float(fragment["x"]) >= right)
            if gap > max(100, x_span * 0.35) and left_count >= 4 and right_count >= 4:
                column_breaks.append((left + right) / 2)

    columns: List[List[Dict[str, Any]]] = [[] for _ in range(len(column_breaks) + 1)]
    for fragment in usable:
        column_index = 0
        for boundary in column_breaks:
            if float(fragment["x"]) > boundary:
                column_index += 1
        columns[column_index].append(fragment)

    font_size = median(
        [float(fragment["font_size"]) for fragment in usable if fragment["font_size"]],
        10,
    )
    y_tolerance = max(2.5, font_size * 0.45)
    lines: List[str] = []

    for column in columns:
        grouped: List[List[Dict[str, Any]]] = []
        for fragment in sorted(column, key=lambda item: (float(item["y"]), float(item["x"]))):
            if not grouped or abs(float(grouped[-1][0]["y"]) - float(fragment["y"])) > y_tolerance:
                grouped.append([fragment])
            else:
                grouped[-1].append(fragment)

        for group in grouped:
            ordered = sorted(group, key=lambda item: float(item["x"]))
            text = normalise_line(" ".join(fragment["text"] for fragment in ordered))
            text = re.sub(r"\b(\d+)\s+([.)])\s+", r"\1\2 ", text)
            text = re.sub(r"\s+([,.;:?)])", r"\1", text)
            text = re.sub(r"([(])\s+", r"\1", text)
            if text:
                lines.append(text)

    return lines


def raw_lines_are_suspicious(lines: List[str]) -> bool:
    if not lines:
        return True
    if any(len(line) > 700 for line in lines):
        return True
    if len(lines) <= 5 and sum(len(line) for line in lines) > 1200:
        return True
    return False


def split_combined_section_headings(line: str) -> Optional[tuple[str, str]]:
    """Recognize two headings merged by a PDF's two-column text stream."""
    normalized = normalise_line(line).casefold()
    headings = sorted(DEFAULT_SECTION_HEADINGS, key=len, reverse=True)
    for left in headings:
        for right in headings:
            if left != right and normalized == f"{left} {right}":
                return left.upper(), right.upper()
    return None


def positioned_profile_parts(fragments: List[Dict[str, Any]]) -> tuple[str, str]:
    """Recover a large, multi-line name and the role directly below it."""
    usable = [
        fragment
        for fragment in fragments
        if isinstance(fragment.get("x"), (int, float))
        and isinstance(fragment.get("y"), (int, float))
        and float(fragment.get("x") or 0) > 5
        and float(fragment.get("y") or 0) > 5
        and fragment.get("text")
    ]
    if not usable:
        return "", ""
    max_size = max(float(fragment.get("font_size") or 0) for fragment in usable)
    if max_size < 16:
        return "", ""
    name_fragments = [
        fragment
        for fragment in usable
        if float(fragment.get("font_size") or 0) >= max_size * 0.8
    ]
    if not name_fragments:
        return "", ""
    name = normalise_line(
        " ".join(
            fragment["text"]
            for fragment in sorted(name_fragments, key=lambda item: -float(item["y"]))
        )
    )
    name_bottom = min(float(fragment["y"]) for fragment in name_fragments)
    role_candidates = [
        fragment
        for fragment in usable
        if float(fragment["y"]) < name_bottom
        and float(fragment.get("font_size") or 0) > 10
    ]
    if not role_candidates:
        return name, ""
    role_y = max(float(fragment["y"]) for fragment in role_candidates)
    role = normalise_line(
        " ".join(
            fragment["text"]
            for fragment in sorted(
                (
                    fragment
                    for fragment in role_candidates
                    if abs(float(fragment["y"]) - role_y) <= 1.8
                ),
                key=lambda item: float(item["x"]),
            )
        )
    )
    return name, role


def right_column_start(line: str, right_heading: str) -> bool:
    if right_heading.casefold() == "work experience":
        return bool(
            re.match(
                r"^\d{4}\s*[–-]\s*(?:Present|\d{4})\s*[:,]",
                line,
                re.IGNORECASE,
            )
        )
    if right_heading.casefold() in {"selected projects", "selected project highlights"}:
        has_date_range = bool(
            re.search(
                r"\b(?:19|20)\d{2}\s*[–-]\s*(?:(?:19|20)\d{2}|Present|Ongoing)\b",
                line,
                re.IGNORECASE,
            )
        )
        return is_project_title_line(line) and (has_date_range or bool(LOCATION_RE.search(line)))
    return False


def repair_interleaved_two_column_lines(
    lines: List[str],
    fragments: List[Dict[str, Any]],
    page_number: int,
) -> List[str]:
    """Restore reading order when paired column headings share one text line."""
    pairs = {
        index: pair
        for index, line in enumerate(lines)
        if (pair := split_combined_section_headings(line)) is not None
    }
    if not pairs:
        return lines
    name, role = positioned_profile_parts(fragments)
    if not name or not role:
        return lines

    filtered = [line for line in lines if line.strip() != str(page_number)]
    name_parts = {part.casefold() for part in name.split()}
    filtered = [
        line
        for line in filtered
        if line.casefold() != role.casefold()
        and line.casefold() not in name_parts
        and line.casefold() != name.casefold()
    ]
    pair_indexes = [
        index
        for index, line in enumerate(filtered)
        if split_combined_section_headings(line) is not None
    ]
    if not pair_indexes:
        return lines

    output = [name, role, "OVERVIEW"]
    output.extend(filtered[: pair_indexes[0]])
    for pair_position, start in enumerate(pair_indexes):
        end = pair_indexes[pair_position + 1] if pair_position + 1 < len(pair_indexes) else len(filtered)
        pair = split_combined_section_headings(filtered[start])
        if pair is None:
            continue
        left_heading, right_heading = pair
        output.append(left_heading)
        switched = False
        for line in filtered[start + 1 : end]:
            if not switched and right_column_start(line, right_heading):
                output.append(right_heading)
                switched = True
            output.append(line)
    return output


def extract_page_lines(page: Any, page_number: int) -> List[Dict[str, Any]]:
    raw_text = page.extract_text() or ""
    lines = [line for line in remove_empty(raw_text.splitlines()) if line != str(page_number)]
    fragments = collect_layout_fragments(page, page_number)
    lines = repair_interleaved_two_column_lines(lines, fragments, page_number)
    if raw_lines_are_suspicious(lines):
        layout_lines = group_fragments_into_lines(fragments)
        if len(layout_lines) > len(lines):
            lines = layout_lines

    line_entries = []
    for index, line in enumerate(lines, start=1):
        line_entries.append({"page": page_number, "line_number": index, "text": line})
    return merge_contact_line_entries(line_entries)


def image_extension_and_mime(filters: List[Any], data: bytes) -> tuple[Optional[str], Optional[str]]:
    filter_names = {str(item) for item in filters}
    if "/DCTDecode" in filter_names or data.startswith(b"\xff\xd8\xff"):
        return "jpg", "image/jpeg"
    if "/JPXDecode" in filter_names:
        return "jp2", "image/jp2"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png", "image/png"
    return None, None


def extract_image_objects(
    page: Any,
    page_number: int,
    image_output_dir: Optional[Path],
    embed_images: bool,
) -> List[Dict[str, Any]]:
    resources = page.get("/Resources") or {}
    xobjects = resources.get("/XObject") or {}
    images: List[Dict[str, Any]] = []

    for name, ref in xobjects.items():
        obj = ref.get_object()
        if obj.get("/Subtype") != "/Image":
            continue

        image_name = str(name).lstrip("/")
        image_data = obj.get_data()
        filters = as_list(obj.get("/Filter"))
        extension, mime_type = image_extension_and_mime(filters, image_data)
        image_payload = {
            "page": page_number,
            "name": image_name,
            "width": json_safe(obj.get("/Width")),
            "height": json_safe(obj.get("/Height")),
            "color_space": json_safe(obj.get("/ColorSpace")),
            "bits_per_component": json_safe(obj.get("/BitsPerComponent")),
            "filter": json_safe(obj.get("/Filter")),
            "byte_length": len(image_data),
            "extractable": extension is not None,
            "extension": extension,
            "mime_type": mime_type,
        }

        if extension and image_output_dir:
            image_output_dir.mkdir(parents=True, exist_ok=True)
            image_path = image_output_dir / f"page_{page_number}_{image_name}.{extension}"
            image_path.write_bytes(image_data)
            image_payload["file_path"] = str(image_path)

        if extension and embed_images:
            image_payload["base64"] = base64.b64encode(image_data).decode("ascii")

        images.append(image_payload)

    return images


def infer_profile_photo(pages: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    images = [
        image
        for page in pages
        for image in page["images"]
        if image.get("extractable")
        and (image.get("file_path") or image.get("base64"))
        and isinstance(image.get("width"), int)
        and isinstance(image.get("height"), int)
    ]
    if not images:
        return None
    scored = [(profile_photo_score(image), image) for image in images]
    scored = [(score, image) for score, image in scored if score > 0]
    if not scored:
        return None

    # CV profile photos overwhelmingly live on the first page.  Treat a valid
    # first-page candidate as a stronger structural signal than raw pixel area:
    # otherwise a larger, nearly square project photograph on a later page can
    # outscore the real headshot.  Later pages remain a fallback for CVs that do
    # not contain any viable first-page image.
    first_page_scored = [
        item for item in scored if item[1].get("page") == 1
    ]
    candidate_pool = first_page_scored or scored
    largest = max(candidate_pool, key=lambda item: item[0])[1]
    return {
        "page": largest["page"],
        "name": largest["name"],
        "width": largest["width"],
        "height": largest["height"],
        "mime_type": largest["mime_type"],
        "file_path": largest.get("file_path"),
        "base64": largest.get("base64"),
    }


def image_bytes_for_score(image: Dict[str, Any]) -> Optional[bytes]:
    if image.get("base64"):
        try:
            return base64.b64decode(image["base64"])
        except Exception:
            return None
    if image.get("file_path"):
        try:
            return Path(image["file_path"]).read_bytes()
        except Exception:
            return None
    return None


def profile_photo_score(image: Dict[str, Any]) -> float:
    width = image.get("width")
    height = image.get("height")
    if not isinstance(width, int) or not isinstance(height, int):
        return 0
    area = width * height
    if area < 40_000:
        return 0
    ratio = width / max(height, 1)
    if ratio > 2.2 or ratio < 0.35:
        return 0

    data = image_bytes_for_score(image)
    if not data:
        return 0
    try:
        pil_image = Image.open(BytesIO(data)).convert("RGB")
    except Exception:
        return 0

    stat = ImageStat.Stat(pil_image.resize((80, 80)))
    mean = sum(stat.mean) / 3
    stddev = sum(stat.stddev) / 3
    if mean > 245 and stddev < 30:
        return 0

    ratio_score = 1 / (1 + abs(ratio - 1))
    page_score = 1.2 if image.get("page") == 1 else 1.0
    texture_score = min(1.4, 0.7 + (stddev / 90))
    return area * ratio_score * page_score * texture_score


def is_section_heading(line: str, extra_headings: Iterable[str]) -> bool:
    key = line.lower().strip()
    if key in DEFAULT_SECTION_HEADINGS or key in {h.lower() for h in extra_headings}:
        return True
    return False


def is_likely_unknown_section_heading(line: str) -> bool:
    stripped = line.strip()
    if not stripped or is_contact_line(stripped):
        return False
    if is_bullet_line(stripped) or NUMBERED_ITEM_RE.match(stripped):
        return False
    if TABLE_HEADER_RE.match(stripped) or re.search(r"\b20\d{2}\b", stripped):
        return False
    if any(mark in stripped for mark in [",", ".", ":", "|", "(", ")"]):
        return False
    words = stripped.split()
    if not 1 <= len(words) <= 5 or len(stripped) > 70:
        return False
    title_like_words = sum(1 for word in words if word[:1].isupper() or word in {"&", "and", "of"})
    return title_like_words / len(words) >= 0.8


def is_url_fragment(line: str) -> bool:
    lowered = line.lower().strip()
    return (
        "linkedin.com" in lowered
        or lowered.startswith("http")
        or lowered.startswith("www.")
        or lowered.startswith("linkedin.")
    )


def should_merge_contact_fragment(current: str, next_line: str) -> bool:
    if not current or not next_line:
        return False
    if is_section_heading(next_line, ()):
        return False
    if "@" in current and len(next_line.strip()) == 1 and next_line.strip().isalnum():
        return True
    if "@" in current and not EMAIL_RE.search(current):
        return len(next_line.split()) <= 2
    if is_url_fragment(current):
        return len(next_line.split()) <= 2 and not next_line.endswith(".")
    return False


def merge_contact_line_entries(entries: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    merged: List[Dict[str, Any]] = []
    index = 0
    while index < len(entries):
        entry = dict(entries[index])
        while index + 1 < len(entries) and should_merge_contact_fragment(
            entry["text"], entries[index + 1]["text"]
        ):
            entry["text"] = normalise_line(f"{entry['text']}{entries[index + 1]['text']}")
            index += 1
        merged.append(entry)
        index += 1
    return merged


def split_sections(
    page_lines: List[Dict[str, Any]], extra_headings: Iterable[str]
) -> List[Dict[str, Any]]:
    sections: List[Dict[str, Any]] = []
    current: Optional[Dict[str, Any]] = None
    seen_additional_project_experience = False

    for entry in page_lines:
        line = entry["text"]
        heading_key = line.lower().strip()
        is_heading = is_section_heading(line, extra_headings)
        if heading_key in PROJECT_CATEGORY_HEADINGS and not seen_additional_project_experience:
            is_heading = False

        if is_heading:
            if current:
                sections.append(finalise_section(current))
            current = {
                "heading": line,
                "start_page": entry["page"],
                "lines": [],
            }
            if heading_key == "additional project experience":
                seen_additional_project_experience = True
            continue

        if current:
            current["lines"].append(entry)

    if current:
        sections.append(finalise_section(current))

    return sections


def finalise_section(section: Dict[str, Any]) -> Dict[str, Any]:
    cleaned_lines = [
        entry
        for entry in section["lines"]
        if not is_contact_line(entry["text"])
        and not entry["text"].lower().startswith("*a full list")
    ]
    plain_lines = [entry["text"] for entry in cleaned_lines]
    return {
        "heading": section["heading"],
        "start_page": section["start_page"],
        # Repair compounds across visual line boundaries while retaining the
        # original line records for layout provenance.
        "text": repair_text_artifacts("\n".join(plain_lines)),
        "lines": cleaned_lines,
        "bullets": extract_bullets(plain_lines),
        "tables": extract_tables(plain_lines),
        "work_experience": extract_work_experience(plain_lines)
        if section["heading"].lower() == "work experience"
        else [],
    }


def extract_bullets(lines: Iterable[str]) -> List[str]:
    bullets: List[str] = []
    current: Optional[str] = None

    for line in lines:
        stripped = line.strip()
        if is_bullet_line(stripped):
            if current:
                bullets.append(current)
            current = strip_bullet_marker(stripped)
            continue

        if current and is_likely_continuation(current, stripped):
            current = f"{current} {stripped}"
        elif current:
            bullets.append(current)
            current = None

    if current:
        bullets.append(current)

    return bullets


def extract_work_experience(lines: Iterable[str]) -> List[Dict[str, Optional[str]]]:
    entries: List[Dict[str, Optional[str]]] = []
    for line in lines:
        match = YEAR_LINE_RE.match(line)
        if not match:
            if entries:
                continuation = line.strip()
                entries[-1]["raw"] = f"{entries[-1]['raw']} {continuation}"
                if entries[-1]["organisation"]:
                    entries[-1]["organisation"] = (
                        f"{entries[-1]['organisation']} {continuation}"
                    )
                else:
                    entries[-1]["role"] = f"{entries[-1]['role']} {continuation}"
            continue

        title = match.group("title")
        role = title
        organisation = None
        org_split = re.split(r"\s+[–-]\s+", title, maxsplit=1)
        if len(org_split) == 2:
            role, organisation = org_split

        entries.append(
            {
                "start_year": match.group("start"),
                "end_year": match.group("end"),
                "role": role.strip(),
                "organisation": organisation.strip() if organisation else None,
                "raw": line,
            }
        )
    return entries


def extract_tables(lines: List[str]) -> List[Dict[str, Any]]:
    tables: List[Dict[str, Any]] = []
    active: Optional[Dict[str, Any]] = None

    for line in lines:
        if TABLE_HEADER_RE.match(line):
            if active:
                tables.append(active)
            active = {"header": line, "rows": []}
            continue

        if active:
            active["rows"].append(line)

    if active:
        tables.append(active)

    return tables


def project_text(title: str, bullets: List[str]) -> str:
    parts = [title.strip(), *bullets]
    return "\n".join(part for part in parts if part)


def repair_pdf_word_fragments(value: str) -> str:
    """Repair a few common glyph-level splits produced by embedded PDF fonts."""
    value = normalise_line(repair_text_artifacts(value))
    value = re.sub(r"\b((?:19|20)\d)\s+(\d)\b", r"\1\2", value)
    return value


TITLE_TRAILING_DATE_RE = re.compile(
    r"(?:\b(?:19|20)\d{2}\s*[–-]\s*(?:(?:19|20)\d{2}|Present|present|Ongoing|ongoing|Current|current)\b|(?<!\d)(?:19|20)\d{2})\s*$",
    re.IGNORECASE,
)


def has_title_trailing_date(line: str) -> bool:
    """Whether a line ends in a project date or date range.

    Project headings in these CVs end with their date (``..., 2023 – 2024`` or
    ``..., 2024``). Body sentences can also contain years (``Saudi Vision
    2030``), but only a genuine heading carries the date as its trailing token.
    """
    return bool(TITLE_TRAILING_DATE_RE.search(line.strip()))


def is_project_title_line(line: str) -> bool:
    stripped = line.strip()
    if not stripped or is_contact_line(stripped):
        return False
    if is_section_heading(stripped, ()) or TABLE_HEADER_RE.match(stripped):
        return False
    if is_bullet_line(stripped) or NUMBERED_ITEM_RE.match(stripped):
        return False
    if stripped.lower().startswith(("some key projects", "*a full list", "key activities")):
        return False
    if re.search(r"\b20\d{2}\b", stripped):
        return True
    letters = [char for char in stripped if char.isalpha()]
    if letters:
        upper_ratio = sum(1 for char in letters if char.isupper()) / len(letters)
        if upper_ratio > 0.65 and len(stripped) < 140:
            return True
    words = stripped.split()
    if (
        2 <= len(words) <= 7
        and stripped[:1].isupper()
        and not any(mark in stripped for mark in [",", ".", ":", "|", "(", ")"])
    ):
        return True
    return False


def styled_lines_from_fragments(
    fragments_by_page: Dict[int, List[Dict[str, Any]]],
    page_numbers: set[int],
) -> List[Dict[str, Any]]:
    """Rebuild visual lines while retaining their dominant font size."""
    lines: List[Dict[str, Any]] = []
    for page_number in sorted(page_numbers):
        usable = [
            fragment
            for fragment in fragments_by_page.get(page_number, [])
            if fragment.get("text")
            and isinstance(fragment.get("x"), (int, float))
            and isinstance(fragment.get("y"), (int, float))
            and float(fragment.get("x") or 0) > 5
            and float(fragment.get("y") or 0) > 5
        ]
        if not usable:
            continue
        typical_size = median(
            [float(fragment["font_size"]) for fragment in usable if fragment.get("font_size")],
            10,
        )
        tolerance = max(1.8, typical_size * 0.28)
        groups: List[List[Dict[str, Any]]] = []
        for fragment in sorted(usable, key=lambda item: (-float(item["y"]), float(item["x"]))):
            match = next(
                (
                    group
                    for group in groups
                    if abs(float(group[0]["y"]) - float(fragment["y"])) <= tolerance
                ),
                None,
            )
            if match is None:
                groups.append([fragment])
            else:
                match.append(fragment)

        for group in sorted(groups, key=lambda item: -float(item[0]["y"])):
            ordered = sorted(group, key=lambda item: float(item["x"]))
            text = normalise_line(" ".join(fragment["text"] for fragment in ordered))
            text = re.sub(r"\s+([,.;:?)])", r"\1", text)
            text = re.sub(r"([(])\s+", r"\1", text)
            if not text:
                continue
            font_size = max(
                (float(fragment.get("font_size") or 0) for fragment in ordered),
                default=0,
            )
            lines.append(
                {
                    "page": page_number,
                    "x": min(float(fragment["x"]) for fragment in ordered),
                    "y": float(group[0]["y"]),
                    "font_size": font_size,
                    "text": text,
                }
            )
    return lines


def extract_styled_selected_projects(
    section: Dict[str, Any],
    fragments_by_page: Dict[int, List[Dict[str, Any]]],
) -> List[Dict[str, Any]]:
    """Use a real title/body font-size distinction when the PDF exposes one."""
    page_numbers = {int(line["page"]) for line in section.get("lines", []) if line.get("page")}
    lines = styled_lines_from_fragments(fragments_by_page, page_numbers)
    if not lines:
        return []

    sizes = [round(float(line["font_size"]), 2) for line in lines if line["font_size"] > 0]
    if not sizes:
        return []
    counts: Dict[float, int] = {}
    for size in sizes:
        counts[size] = counts.get(size, 0) + 1
    body_size = max(counts, key=lambda size: (counts[size], -size))
    title_threshold = body_size + 0.4
    title_lines = [line for line in lines if line["font_size"] >= title_threshold]
    if len(title_lines) < 3:
        return []

    projects: List[Dict[str, Any]] = []
    current: Optional[Dict[str, Any]] = None

    def flush() -> None:
        nonlocal current
        if not current:
            return
        title = repair_pdf_word_fragments(" ".join(current["title_lines"]))
        body_lines = [repair_pdf_word_fragments(text) for text in current["body_lines"] if normalise_line(text)]
        if title and body_lines:
            client = ""
            retained_body_lines: List[str] = []
            for body_line in body_lines:
                match = re.match(r"^client(?:\s+name)?\s*[:\-–]\s*(.+)$", body_line, re.IGNORECASE)
                if match and not client:
                    client = normalise_line(match.group(1))
                else:
                    retained_body_lines.append(body_line)
            body_lines = retained_body_lines
            bullets = [strip_bullet_marker(line) for line in body_lines if is_bullet_line(line)]
            description_lines = [line for line in body_lines if not is_bullet_line(line)]
            if description_lines:
                bullets.insert(0, normalise_line(" ".join(description_lines)))
            project = {
                    "name": title,
                    "category": "Selected Project Highlights",
                    "source": "selected_project_typography",
                    "source_section": section["heading"],
                    "content_type": "narrative_project",
                    "bullets": bullets,
                    "text": project_text(title, bullets),
                }
            if client:
                project["client"] = client
            projects.append(project)
        current = None

    previous_title_line: Optional[Dict[str, Any]] = None
    for line in lines:
        text = line["text"].strip()
        lowered = text.lower()
        if TABLE_HEADER_RE.match(text):
            flush()
            break
        if (
            not text
            or lowered in {"selected projects", "selected project highlights"}
            or lowered.startswith("*a full list")
        ):
            continue
        is_title = line["font_size"] >= title_threshold
        if is_title:
            same_title = bool(
                current
                and not current["body_lines"]
                and previous_title_line
                and line["page"] == previous_title_line["page"]
                and abs(float(previous_title_line["y"]) - float(line["y"])) <= body_size * 2.1
            )
            if not same_title:
                flush()
                current = {"title_lines": [], "body_lines": []}
            current["title_lines"].append(text)
            previous_title_line = line
            continue
        previous_title_line = None
        if current:
            current["body_lines"].append(text)
    flush()
    return projects


def project_parse_quality(projects: List[Dict[str, Any]]) -> float:
    if not projects:
        return 0
    score = float(len(projects) * 4)
    for project in projects:
        name = normalise_line(project.get("name") or "")
        if not name or len(name) > 210:
            score -= 5
        if name[:1].islower():
            score -= 3
        if re.search(r"\b(?:is|was|were|has|have|managed|delivered|assessed)\b", name, re.I):
            score -= 3
        if project.get("bullets"):
            score += 1
    return score


def extract_selected_projects(
    sections: List[Dict[str, Any]],
    fragments_by_page: Optional[Dict[int, List[Dict[str, Any]]]] = None,
) -> List[Dict[str, Any]]:
    section = next(
        (
            item
            for item in sections
            if item["heading"].lower() in {"selected project highlights", "selected projects"}
        ),
        None,
    )
    if not section:
        return []

    projects: List[Dict[str, Any]] = []
    current: Optional[Dict[str, Any]] = None
    current_bullet: Optional[str] = None

    def flush_bullet() -> None:
        nonlocal current_bullet
        if current and current_bullet:
            current["bullets"].append(current_bullet)
        current_bullet = None

    def flush_project() -> None:
        nonlocal current
        flush_bullet()
        if current and current["name"]:
            current["text"] = project_text(current["name"], current["bullets"])
            projects.append(current)
        current = None

    for line in section["text"].splitlines():
        stripped = line.strip()
        lowered = stripped.lower()
        # A tabular project inventory is retained in section["tables"] but is
        # intentionally outside the narrative project stream used by templates.
        if TABLE_HEADER_RE.match(stripped):
            flush_project()
            break
        if (
            not stripped
            or lowered.startswith("a selection of")
            or lowered.startswith("some key projects")
            or lowered.startswith("*a full list")
        ):
            continue

        if current is not None and lowered.startswith("role:"):
            flush_bullet()
            current["role_line"] = normalise_line(stripped[5:]).strip(" :")
            continue

        if current is not None and re.match(r"^client(?:\s+name)?\s*[:\-–]", lowered):
            flush_bullet()
            current["client"] = normalise_line(
                re.sub(r"^client(?:\s+name)?\s*[:\-–]\s*", "", stripped, flags=re.IGNORECASE)
            ).strip(" :")
            continue

        if is_bullet_line(stripped) or NUMBERED_ITEM_RE.match(stripped):
            flush_bullet()
            if current is None:
                current = {
                    "name": "Untitled project",
                    "category": "Selected Project Highlights",
                    "source": "selected_project_highlights",
                    "source_section": section["heading"],
                    "bullets": [],
                    "text": "",
                }
            current_bullet = (
                strip_bullet_marker(stripped)
                if is_bullet_line(stripped)
                else NUMBERED_ITEM_RE.sub("", stripped).strip()
            )
            continue

        if current_bullet:
            if is_likely_continuation(current_bullet, stripped):
                current_bullet = f"{current_bullet} {stripped}"
                continue
            flush_project()

        if current and not current["bullets"] and not is_project_title_line(stripped):
            current["bullets"].append(stripped)
            continue

        if current and current["bullets"] and not is_project_title_line(stripped):
            current["bullets"][-1] = f"{current['bullets'][-1]} {stripped}"
            continue

        if current:
            flush_project()

        current = {
            "name": stripped,
            "category": "Selected Project Highlights",
            "source": "selected_project_highlights",
            "source_section": section["heading"],
            "content_type": "narrative_project",
            "bullets": [],
            "text": "",
        }

    flush_project()
    projects = merge_orphaned_project_bodies(projects)
    if fragments_by_page:
        styled_projects = extract_styled_selected_projects(section, fragments_by_page)
        if (
            len(styled_projects) >= 4
            and project_parse_quality(styled_projects) >= project_parse_quality(projects) - 4
        ):
            return styled_projects
    return projects


def merge_orphaned_project_bodies(projects: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Reattach a description that was split from its dated project heading.

    A narrative project heading normally ends with its date. When extraction
    starts a new ``current`` project from a body sentence (a line that merely
    contains a year, such as a vision/goal year), the true heading is left as
    a description-less project and the following project holds only that
    heading's body. This detects that pattern generically: a project with no
    description whose name ends in a date, immediately followed by a project
    whose name is a prose sentence (not a date-terminated heading), and folds
    the follower's text back into the heading project.
    """
    if len(projects) < 2:
        return projects
    merged: List[Dict[str, Any]] = []
    index = 0
    while index < len(projects):
        project = projects[index]
        follower = projects[index + 1] if index + 1 < len(projects) else None
        if (
            follower is not None
            and not (project.get("bullets") or [])
            and not project.get("role_line")
            and has_title_trailing_date(str(project.get("name") or ""))
            and not has_title_trailing_date(str(follower.get("name") or ""))
        ):
            follower_bullets = [b for b in (follower.get("bullets") or []) if b]
            body_parts = [str(follower.get("name") or "").strip(), *follower_bullets]
            project["bullets"] = [normalise_line(" ".join(part for part in body_parts if part))]
            project["text"] = project_text(str(project.get("name") or ""), project["bullets"])
            # Carry across any client/role the fragment parser attached to the
            # orphaned body; the dated heading remains the project identity.
            for key in ("client", "role_line"):
                if follower.get(key) and not project.get(key):
                    project[key] = follower[key]
            merged.append(project)
            index += 2
            continue
        merged.append(project)
        index += 1
    return merged


def split_additional_project_rows(lines: List[str]) -> List[str]:
    rows: List[str] = []
    buffer: List[str] = []

    for line in lines:
        if TABLE_HEADER_RE.match(line):
            continue

        if not buffer:
            buffer = [line]
            continue

        buffer_text = " ".join(buffer)
        if LOCATION_RE.search(line) and LOCATION_RE.search(buffer_text):
            rows.append(normalise_line(buffer_text))
            buffer = [line]
        else:
            buffer.append(line)

    if buffer:
        rows.append(normalise_line(" ".join(buffer)))

    return rows


def parse_additional_project_row(
    row: str, category: str, source_section: str
) -> Dict[str, Any]:
    matches = list(LOCATION_RE.finditer(row))
    if not matches:
        return {
            "name": row,
            "category": category,
            "location": None,
            "certification_target": None,
            "source": "additional_project_experience",
            "source_section": source_section,
            "text": row,
        }

    match = matches[-1]
    name = row[: match.start()].strip(" -–")
    location = match.group(1).strip()
    target = row[match.end() :].strip(" -–")
    return {
        "name": name or row,
        "category": category,
        "location": location,
        "certification_target": target or None,
        "source": "additional_project_experience",
        "source_section": source_section,
        "text": row,
    }


def extract_additional_projects(sections: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    projects: List[Dict[str, Any]] = []
    for section in sections:
        heading = section["heading"]
        if heading.lower() not in PROJECT_CATEGORY_HEADINGS:
            continue

        rows = split_additional_project_rows(section["text"].splitlines())
        for row in rows:
            projects.append(parse_additional_project_row(row, heading, heading))

    return projects


def group_projects_by_category(projects: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    grouped: Dict[str, List[Dict[str, Any]]] = {}
    for project in projects:
        grouped.setdefault(project["category"], []).append(project)
    return [
        {"category": category, "entries": category_projects}
        for category, category_projects in grouped.items()
    ]


def attach_projects_to_sections(
    sections: List[Dict[str, Any]],
    selected_projects: List[Dict[str, Any]],
    additional_projects: List[Dict[str, Any]],
) -> None:
    additional_categories = group_projects_by_category(additional_projects)

    for section in sections:
        heading = section["heading"]
        heading_key = heading.lower()
        if heading_key in {"selected project highlights", "selected projects"}:
            section["projects"] = selected_projects
        elif heading_key == "additional project experience":
            section["categories"] = additional_categories
        elif heading_key in PROJECT_CATEGORY_HEADINGS:
            section["entries"] = [
                project for project in additional_projects if project["category"] == heading
            ]


def extract_contacts(text: str) -> Dict[str, List[str]]:
    emails = sorted(set(EMAIL_RE.findall(text)))
    urls = set()
    for match in URL_RE.finditer(text):
        url = match.group(0)
        previous_char = text[match.start() - 1] if match.start() else ""
        next_char = text[match.end()] if match.end() < len(text) else ""
        if (
            previous_char == "@"
            or next_char == "@"
            or "@" in url
            or re.fullmatch(r"\d+\.\d+", url)
        ):
            continue
        urls.add(url)
    phones = set()
    for phone in PHONE_RE.findall(text):
        cleaned = normalise_line(phone)
        digits = re.sub(r"\D", "", cleaned)
        if re.fullmatch(r"\d{4}\s*[–-]\s*\d{4}", cleaned):
            continue
        if not cleaned.startswith("+") and len(digits) < 10:
            continue
        if cleaned.startswith("+") and len(digits) < 8:
            continue
        phones.add(cleaned)
    return {"emails": emails, "urls": sorted(urls), "phones": sorted(phones)}


def infer_profile(lines: List[str]) -> Dict[str, Optional[str]]:
    first_heading = next(
        (i for i, line in enumerate(lines) if is_section_heading(line, ())), len(lines)
    )
    header_lines = lines[:first_heading]
    return {
        "name": header_lines[0] if len(header_lines) > 0 else None,
        "role": header_lines[1] if len(header_lines) > 1 else None,
    }


def extract_pdf(
    path: Path,
    include_layout: bool,
    extra_headings: Iterable[str],
    image_output_dir: Optional[Path],
    embed_images: bool,
) -> Dict[str, Any]:
    reader = PdfReader(str(path))
    metadata = json_safe(dict(reader.metadata or {}))
    pages: List[Dict[str, Any]] = []
    all_page_lines: List[Dict[str, Any]] = []
    fragments_by_page: Dict[int, List[Dict[str, Any]]] = {}

    for index, page in enumerate(reader.pages, start=1):
        page_fragments = collect_layout_fragments(page, index)
        fragments_by_page[index] = page_fragments
        line_entries = extract_page_lines(page, index)
        # Page lines remain available separately; page text is the clean
        # reading form and can safely repair words split across line breaks.
        page_text = repair_text_artifacts(
            "\n".join(entry["text"] for entry in line_entries)
        )
        all_page_lines.extend(line_entries)

        page_payload: Dict[str, Any] = {
            "page_number": index,
            "width": round(float(page.mediabox.width), 3),
            "height": round(float(page.mediabox.height), 3),
            "text": page_text,
            "lines": line_entries,
            "images": extract_image_objects(
                page,
                index,
                image_output_dir=image_output_dir,
                embed_images=embed_images,
            ),
        }

        if include_layout:
            page_payload["fragments"] = page_fragments

        pages.append(page_payload)

    full_text = "\n".join(page["text"] for page in pages)
    all_lines = [entry["text"] for entry in all_page_lines]
    sections = split_sections(all_page_lines, extra_headings)
    selected_projects = extract_selected_projects(sections, fragments_by_page)
    additional_projects = extract_additional_projects(sections)
    attach_projects_to_sections(sections, selected_projects, additional_projects)

    return {
        "source": {
            "file": str(path),
            "filename": path.name,
            "file_size_bytes": path.stat().st_size,
        },
        "metadata": metadata,
        "summary": {
            "page_count": len(pages),
            "line_count": len(all_page_lines),
            "section_count": len(sections),
            "image_count": sum(len(page["images"]) for page in pages),
            "project_count": len(selected_projects) + len(additional_projects),
            "additional_project_count": len(additional_projects),
            "extractable_image_count": sum(
                1 for page in pages for image in page["images"] if image["extractable"]
            ),
        },
        "profile": infer_profile(all_lines),
        "profile_photo": infer_profile_photo(pages),
        "sections": sections,
        "contacts": extract_contacts(full_text),
        "pages": pages,
    }


def collect_pdf_paths(inputs: Iterable[Path]) -> List[Path]:
    pdf_paths: List[Path] = []
    for input_path in inputs:
        path = input_path.expanduser().resolve()
        if not path.exists():
            raise SystemExit(f"Input does not exist: {path}")
        if path.is_dir():
            pdf_paths.extend(
                sorted(
                    child
                    for child in path.rglob("*")
                    if child.is_file() and child.suffix.lower() == ".pdf"
                )
            )
        elif path.suffix.lower() == ".pdf":
            pdf_paths.append(path)
        else:
            raise SystemExit(f"Expected a .pdf file or directory of PDFs: {path}")

    unique_paths: List[Path] = []
    seen = set()
    for path in pdf_paths:
        if path not in seen:
            unique_paths.append(path)
            seen.add(path)

    if not unique_paths:
        raise SystemExit("No PDF files found.")
    return unique_paths


def relative_pdf_paths(inputs: Iterable[Path], pdf_paths: Iterable[Path]) -> Dict[Path, Path]:
    """Map each PDF to its path relative to the supplied input directory."""
    resolved_inputs = [path.expanduser().resolve() for path in inputs]
    result: Dict[Path, Path] = {}
    for pdf_path in pdf_paths:
        relative_path: Optional[Path] = None
        for input_path in resolved_inputs:
            if input_path.is_dir():
                try:
                    relative_path = pdf_path.relative_to(input_path)
                    break
                except ValueError:
                    continue
            elif input_path == pdf_path:
                relative_path = Path(pdf_path.name)
                break
        result[pdf_path] = relative_path or Path(pdf_path.name)
    return result


def build_batch_payload(
    pdf_paths: List[Path],
    include_layout: bool,
    extra_headings: Iterable[str],
    image_output_dir: Optional[Path],
    embed_images: bool,
    relative_paths: Optional[Dict[Path, Path]] = None,
) -> Dict[str, Any]:
    cvs = []
    for pdf_path in pdf_paths:
        relative_path = (relative_paths or {}).get(pdf_path, Path(pdf_path.name))
        cv_image_output_dir = image_output_dir
        if image_output_dir is not None:
            cv_image_output_dir = image_output_dir / relative_path.parent / relative_path.stem
        cv = extract_pdf(
            pdf_path,
            include_layout=include_layout,
            extra_headings=extra_headings,
            image_output_dir=cv_image_output_dir,
            embed_images=embed_images,
        )
        cv["source"]["relative_path"] = relative_path.as_posix()
        cvs.append(cv)

    return {
        "summary": {
            "cv_count": len(cvs),
            "files": [cv["source"]["filename"] for cv in cvs],
            "page_count": sum(cv["summary"]["page_count"] for cv in cvs),
            "section_count": sum(cv["summary"]["section_count"] for cv in cvs),
            "image_count": sum(cv["summary"]["image_count"] for cv in cvs),
            "extractable_image_count": sum(
                cv["summary"]["extractable_image_count"] for cv in cvs
            ),
        },
        "cvs": cvs,
    }


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Extract structured PDF content into JSON."
    )
    parser.add_argument(
        "inputs",
        nargs="+",
        type=Path,
        help="One or more PDF files or directories containing PDFs.",
    )
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        help="Optional output JSON path. Defaults to stdout.",
    )
    parser.add_argument(
        "--compact",
        action="store_true",
        help="Write compact JSON instead of pretty-printed JSON.",
    )
    parser.add_argument(
        "--include-layout",
        action="store_true",
        help="Include PDF layout fragments with x/y/font information.",
    )
    parser.add_argument(
        "--heading",
        action="append",
        default=[],
        help="Additional section heading to recognise. Can be used multiple times.",
    )
    parser.add_argument(
        "--image-output-dir",
        type=Path,
        help="Directory to write extractable images, such as JPEG profile photos.",
    )
    parser.add_argument(
        "--embed-images",
        action="store_true",
        help="Embed extractable image bytes as base64 strings in the JSON.",
    )
    return parser.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv)
    pdf_paths = collect_pdf_paths(args.inputs)
    relative_paths = relative_pdf_paths(args.inputs, pdf_paths)
    payload = build_batch_payload(
        pdf_paths,
        include_layout=args.include_layout,
        extra_headings=args.heading,
        image_output_dir=args.image_output_dir,
        embed_images=args.embed_images,
        relative_paths=relative_paths,
    )

    if args.compact:
        content = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    else:
        content = json.dumps(payload, ensure_ascii=False, indent=2)

    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(content + "\n", encoding="utf-8")
    else:
        print(content)

    return 0


if __name__ == "__main__":
    sys.exit(main())
