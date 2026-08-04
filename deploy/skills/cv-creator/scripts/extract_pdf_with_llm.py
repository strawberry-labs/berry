#!/usr/bin/env python3
"""Extract CV PDFs into raw pipeline JSON with CanopyWave and MiniMax M3."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import re
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from threading import Lock
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from pypdf import PdfReader

try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover - optional convenience dependency.
    load_dotenv = None  # type: ignore[assignment]

from extract_pdf_content import (
    collect_pdf_paths,
    extract_image_objects,
    infer_profile_photo,
    json_safe,
    relative_pdf_paths,
)
from text_normalization import repair_text_artifacts


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ENDPOINT = "https://inference.canopywave.io/v1/chat/completions"
DEFAULT_MODEL = "minimax/minimax-m3"
DEFAULT_EXTRACTED_ROOT = ROOT / "output" / "extracted"
DEFAULT_OUTPUT = DEFAULT_EXTRACTED_ROOT / "cv_data.json"
DEFAULT_IMAGE_OUTPUT = DEFAULT_EXTRACTED_ROOT / "images"
DEFAULT_CACHE = DEFAULT_EXTRACTED_ROOT / "llm_cv_extraction_cache.json"
DEFAULT_COST_REPORT = DEFAULT_EXTRACTED_ROOT / "llm_cv_cost_report.json"
DEFAULT_WORKERS = 4
DEFAULT_TIMEOUT_SECONDS = 300
PROMPT_VERSION = "2026-07-31-v5"
# Reusing an older response after a material prompt change would make the cache
# look as though the new verbatim-extraction rules had been applied. Require a
# fresh model response for this version instead.
LEGACY_PROMPT_VERSIONS: tuple[str, ...] = ()
DEFAULT_INPUT_PRICE_PER_MILLION = 0.300
DEFAULT_OUTPUT_PRICE_PER_MILLION = 1.200
DEFAULT_CACHED_INPUT_PRICE_PER_MILLION = 0.060


CV_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "profile": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "name": {"type": "string"},
                "role": {"type": "string"},
            },
            "required": ["name", "role"],
        },
        "overview": {"type": "string"},
        "work_experience": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "start_date": {"type": "string"},
                    "end_date": {"type": "string"},
                    "role": {"type": "string"},
                    "organisation": {"type": "string"},
                    "location": {"type": "string"},
                    "description": {"type": "string"},
                    "raw_text": {"type": "string"},
                    "source_pages": {
                        "type": "array",
                        "items": {"type": "integer"},
                    },
                },
                "required": [
                    "start_date",
                    "end_date",
                    "role",
                    "organisation",
                    "location",
                    "description",
                    "raw_text",
                    "source_pages",
                ],
            },
        },
        "key_expertise": {
            "type": "array",
            "items": {"type": "string"},
        },
        "qualifications": {
            "type": "array",
            "items": {"type": "string"},
        },
        "memberships": {
            "type": "array",
            "items": {"type": "string"},
        },
        "selected_projects": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "name": {"type": "string"},
                    "duration": {"type": "string"},
                    "role": {"type": "string"},
                    "client": {"type": "string"},
                    "location": {"type": "string"},
                    "description": {"type": "string"},
                    "bullets": {
                        "type": "array",
                        "items": {"type": "string"},
                    },
                    "source_text": {"type": "string"},
                    "source_pages": {
                        "type": "array",
                        "items": {"type": "integer"},
                    },
                },
                "required": [
                    "name",
                    "duration",
                    "role",
                    "client",
                    "location",
                    "description",
                    "bullets",
                    "source_text",
                    "source_pages",
                ],
            },
        },
        "additional_sections": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "heading": {"type": "string"},
                    "content": {"type": "string"},
                    "items": {
                        "type": "array",
                        "items": {"type": "string"},
                    },
                    "source_pages": {
                        "type": "array",
                        "items": {"type": "integer"},
                    },
                },
                "required": ["heading", "content", "items", "source_pages"],
            },
        },
        "contacts": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "emails": {"type": "array", "items": {"type": "string"}},
                "phones": {"type": "array", "items": {"type": "string"}},
                "urls": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["emails", "phones", "urls"],
        },
        "quality_flags": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "code": {
                        "type": "string",
                        "enum": [
                            "project_descriptions_missing",
                            "project_descriptions_metadata_only",
                            "project_source_layout_ambiguous",
                            "project_records_truncated_or_corrupted",
                            "section_mapping_ambiguous",
                            "other_source_quality_issue",
                        ],
                    },
                    "severity": {
                        "type": "string",
                        "enum": ["info", "warning", "error"],
                    },
                    "section": {"type": "string"},
                    "message": {"type": "string"},
                    "affected_records": {
                        "type": "array",
                        "items": {"type": "string"},
                    },
                    "source_pages": {
                        "type": "array",
                        "items": {"type": "integer"},
                    },
                },
                "required": [
                    "code",
                    "severity",
                    "section",
                    "message",
                    "affected_records",
                    "source_pages",
                ],
            },
        },
        "warnings": {
            "type": "array",
            "items": {"type": "string"},
        },
    },
    "required": [
        "profile",
        "overview",
        "work_experience",
        "key_expertise",
        "qualifications",
        "memberships",
        "selected_projects",
        "additional_sections",
        "contacts",
        "quality_flags",
        "warnings",
    ],
}


SYSTEM_PROMPT = """\
You are a CV data-extraction engine. Extract facts from the supplied CV text into
the requested JSON schema.

Rules:
- Act as a structural extractor, not a CV writer or editor. Copy approximately
  99% of the source wording verbatim.
- Use only information present in the supplied CV. Never invent, complete, or
  infer unsupported employers, dates, clients, qualifications, or projects.
- Copy the complete source wording for overview, work-experience descriptions,
  project descriptions, qualifications, and memberships. Do not paraphrase,
  summarise, shorten, expand, polish, merge, or embellish it.
- The only permitted textual cleanup is repairing obvious PDF line wrapping,
  joining words split by extraction artifacts, collapsing accidental
  whitespace, removing list markers from structured label fields, and
  normalising date fields.
- Normalise date ranges to one ASCII hyphen with one space on each side:
  "2025-2026", "2025 -2026", and "2025 – 2026" become "2025 - 2026".
- For every work_experience record, start_date and end_date must each contain
  exactly one date endpoint, never the complete range. For example, source
  "2019-2023" must become start_date "2019" and end_date "2023"; source
  "2019-Ongoing" must become start_date "2019" and end_date "Present". If the
  source provides only one date, put it in start_date and leave end_date empty.
- In date fields and date ranges only, normalise "Ongoing", "ongoing", and
  "Current" to "Present". Do not replace those words when used as ordinary
  prose.
- Keep every work-experience record and every narrative selected project.
- Separate project name, duration, role, client, location, and description.
- A project description must contain only the source narrative about scope,
  responsibilities, contribution, deliverables, challenges, or outcomes. Never
  construct a description by repeating the project name, duration, role,
  client, or location.
- If a project has no narrative description, return an empty description and
  add a quality flag. Do not manufacture prose to make the record look complete.
- Copy project descriptions in full. Do not create short or teaser versions.
- A client is the project owner or commissioning organization, not the
  candidate's employer. Return an empty string when the client is not stated.
- Return an empty role or client when it is not explicitly stated for that
  project. Do not infer it from nearby projects, employment history, job title,
  chronology, or general knowledge.
- Put project inventories, category tables, and uncommon sections in
  additional_sections instead of selected_projects.
- source_pages must contain the page numbers supporting each record.
- Put ambiguities or suspected extraction problems in warnings.
- Use quality_flags for source-content problems that need human review. In
  particular, flag project_descriptions_metadata_only when a project section
  provides only dates, role, project name, client, or location but no actual
  scope, contribution, responsibilities, or outcome. Flag missing narrative
  descriptions rather than inventing them. A project inventory can be
  extracted faithfully and still be unsuitable for publication.
- Include every required property, using empty strings, arrays, or contact arrays
  when the CV does not provide a value.
- Return JSON only. Do not include Markdown or reasoning.

Required JSON Schema:
""" + json.dumps(CV_SCHEMA, ensure_ascii=False)


def clean_text(value: Any) -> str:
    return re.sub(r"\s+", " ", repair_text_artifacts(str(value or ""))).strip()


QUALITY_STOPWORDS = {
    "a",
    "an",
    "and",
    "as",
    "at",
    "by",
    "for",
    "in",
    "of",
    "on",
    "or",
    "project",
    "role",
    "served",
    "the",
    "to",
    "with",
    "worked",
    "working",
}

MONTH_NAME = (
    r"Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|"
    r"Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|"
    r"Nov(?:ember)?|Dec(?:ember)?"
)
DATE_TOKEN = rf"(?:(?:{MONTH_NAME})\s+)?(?:19|20)\d{{2}}"
DATE_RANGE_NORMALIZATION_RE = re.compile(
    rf"(?P<start>{DATE_TOKEN})\s*[-–—]\s*"
    rf"(?P<end>{DATE_TOKEN}|Present|Ongoing|Current)",
    re.IGNORECASE,
)
DATE_RANGE_VALUE_RE = re.compile(
    rf"^\s*(?P<start>{DATE_TOKEN})\s*[-–—]\s*"
    rf"(?P<end>{DATE_TOKEN}|Present|Ongoing|Current)\s*$",
    re.IGNORECASE,
)


def normalize_date_ranges(value: Any) -> str:
    """Normalize only recognizable date ranges while preserving other prose."""
    text = clean_text(value)

    def replacement(match: re.Match[str]) -> str:
        end = match.group("end")
        if end.casefold() in {"ongoing", "current", "present"}:
            end = "Present"
        return f"{match.group('start')} - {end}"

    return DATE_RANGE_NORMALIZATION_RE.sub(replacement, text)


def normalize_date_value(value: Any) -> str:
    """Normalize a date field without changing ordinary uses of 'ongoing'."""
    text = normalize_date_ranges(value)
    if text.casefold() in {"ongoing", "current", "present"}:
        return "Present"
    return text


def work_experience_date_endpoints(
    start_value: Any,
    end_value: Any,
) -> tuple[str, str]:
    """Repair a complete range mistakenly copied into both endpoint fields."""
    start = normalize_date_value(start_value)
    end = normalize_date_value(end_value)

    def range_parts(value: str) -> tuple[str, str] | None:
        match = DATE_RANGE_VALUE_RE.fullmatch(value)
        if not match:
            return None
        return (
            clean_text(match.group("start")),
            normalize_date_value(match.group("end")),
        )

    start_range = range_parts(start)
    end_range = range_parts(end)
    if start_range and end_range and start_range == end_range:
        return start_range
    if start_range and (not end or end == start_range[1]):
        return start_range
    if end_range and (not start or start == end_range[0]):
        return end_range
    return start, end


def quality_tokens(value: Any) -> list[str]:
    return re.findall(r"[a-z]+|\d{4}", clean_text(value).casefold())


def metadata_only_project_description(item: dict[str, Any]) -> bool:
    """Return True when a project description only repeats its label fields."""
    description_tokens = quality_tokens(item.get("description"))
    if not description_tokens:
        return True

    metadata = " ".join(
        clean_text(item.get(field))
        for field in ("name", "duration", "role", "client", "location")
    )
    remaining = list(
        (Counter(description_tokens) - Counter(quality_tokens(metadata))).elements()
    )
    substantive = [
        token
        for token in remaining
        if token not in QUALITY_STOPWORDS and not token.isdigit()
    ]
    overlap_ratio = (len(description_tokens) - len(remaining)) / len(
        description_tokens
    )
    return len(substantive) < 5 and overlap_ratio >= 0.55


def deterministic_project_quality_flags(
    projects: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Guarantee a review flag for project lists with no narrative content."""
    if len(projects) < 3:
        return []

    affected = [
        item
        for item in projects
        if isinstance(item, dict) and metadata_only_project_description(item)
    ]
    if len(affected) < 3 or len(affected) / len(projects) < 0.5:
        return []

    names = [
        clean_text(item.get("name")) or f"Project {index}"
        for index, item in enumerate(affected, start=1)
    ]
    pages = sorted(
        {
            page
            for item in affected
            for page in (item.get("source_pages") or [])
            if isinstance(page, int) and page > 0
        }
    )
    return [
        {
            "code": "project_descriptions_metadata_only",
            "severity": "warning",
            "section": "selected_projects",
            "message": (
                f"{len(affected)} of {len(projects)} projects only repeat label "
                "metadata and contain no publishable scope, contribution, "
                "responsibility, or outcome. Keep the extracted facts, but "
                "review the source before generating a client-facing CV."
            ),
            "affected_records": names,
            "source_pages": pages,
        }
    ]


def add_deterministic_quality_flags(value: dict[str, Any]) -> dict[str, Any]:
    flags = value.setdefault("quality_flags", [])
    existing_codes = {
        clean_text(flag.get("code"))
        for flag in flags
        if isinstance(flag, dict)
    }
    for flag in deterministic_project_quality_flags(
        value.get("selected_projects") or []
    ):
        if flag["code"] not in existing_codes:
            flags.append(flag)
    return value


def extract_json_object(content: str) -> dict[str, Any]:
    """Parse a JSON object even when a model wraps it in prose or code fences."""
    content = re.sub(r"<think>.*?</think>", "", content, flags=re.DOTALL | re.IGNORECASE)
    content = content.strip()
    if content.startswith("```"):
        content = re.sub(r"^```(?:json)?\s*", "", content, flags=re.IGNORECASE)
        content = re.sub(r"\s*```$", "", content)

    decoder = json.JSONDecoder()
    for match in re.finditer(r"\{", content):
        try:
            value, _end = decoder.raw_decode(content[match.start() :])
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    raise ValueError("The model response did not contain a valid JSON object.")


def validate_llm_result(value: dict[str, Any]) -> dict[str, Any]:
    # Older cache entries predate source-quality flags. Normalizing them keeps
    # cached extraction reusable while the deterministic check still applies.
    value.setdefault("quality_flags", [])
    missing = [field for field in CV_SCHEMA["required"] if field not in value]
    if missing:
        raise ValueError(f"Model JSON is missing required fields: {', '.join(missing)}")
    if not isinstance(value.get("profile"), dict):
        raise ValueError("Model JSON field 'profile' must be an object.")
    for field in (
        "work_experience",
        "key_expertise",
        "qualifications",
        "memberships",
        "selected_projects",
        "additional_sections",
        "quality_flags",
        "warnings",
    ):
        if not isinstance(value.get(field), list):
            raise ValueError(f"Model JSON field '{field}' must be an array.")
    return add_deterministic_quality_flags(value)


def response_formats() -> list[dict[str, Any] | None]:
    """Prefer strict schema output, with compatibility fallbacks."""
    return [
        {
            "type": "json_schema",
            "json_schema": {
                "name": "aesg_cv_extraction",
                "strict": True,
                "schema": CV_SCHEMA,
            },
        },
        {"type": "json_object"},
        None,
    ]


def token_usage(response: dict[str, Any]) -> dict[str, int]:
    """Normalize OpenAI-compatible usage fields returned by inference providers."""
    usage = response.get("usage") or {}
    prompt_tokens = int(usage.get("prompt_tokens", usage.get("input_tokens", 0)) or 0)
    completion_tokens = int(
        usage.get("completion_tokens", usage.get("output_tokens", 0)) or 0
    )
    details = usage.get("prompt_tokens_details") or usage.get("input_tokens_details") or {}
    cached_tokens = int(
        details.get(
            "cached_tokens",
            usage.get(
                "cached_tokens",
                usage.get(
                    "cache_read_input_tokens",
                    usage.get("cache_tokens", 0),
                ),
            ),
        )
        or 0
    )
    cached_tokens = min(max(cached_tokens, 0), max(prompt_tokens, 0))
    uncached_tokens = max(prompt_tokens - cached_tokens, 0)
    total_tokens = int(
        usage.get(
            "total_tokens",
            prompt_tokens + completion_tokens,
        )
        or 0
    )
    return {
        "input_tokens": prompt_tokens,
        "uncached_input_tokens": uncached_tokens,
        "cached_input_tokens": cached_tokens,
        "output_tokens": completion_tokens,
        "total_tokens": total_tokens,
    }


def usage_cost(
    usage: dict[str, int],
    *,
    input_price_per_million: float,
    output_price_per_million: float,
    cached_input_price_per_million: float,
) -> dict[str, float]:
    input_cost = (
        usage["uncached_input_tokens"] * input_price_per_million / 1_000_000
    )
    cached_input_cost = (
        usage["cached_input_tokens"]
        * cached_input_price_per_million
        / 1_000_000
    )
    output_cost = usage["output_tokens"] * output_price_per_million / 1_000_000
    return {
        "input_cost_usd": input_cost,
        "cached_input_cost_usd": cached_input_cost,
        "output_cost_usd": output_cost,
        "total_cost_usd": input_cost + cached_input_cost + output_cost,
    }


def canopywave_chat_completion(
    *,
    api_key: str,
    endpoint: str,
    model: str,
    messages: list[dict[str, Any]],
    max_tokens: int,
    temperature: float,
    timeout: int,
) -> tuple[dict[str, Any], dict[str, int]]:
    """Call CanopyWave, falling back when a model rejects response_format."""
    format_errors: list[str] = []
    for response_format in response_formats():
        payload: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
        }
        if response_format is not None:
            payload["response_format"] = response_format

        for attempt in range(3):
            request = Request(
                endpoint,
                data=json.dumps(payload).encode("utf-8"),
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {api_key}",
                },
                method="POST",
            )
            try:
                with urlopen(request, timeout=timeout) as response:
                    body = json.loads(response.read().decode("utf-8"))
                try:
                    content = body["choices"][0]["message"]["content"]
                    result = validate_llm_result(extract_json_object(content))
                except (KeyError, TypeError, ValueError) as exc:
                    if attempt < 2:
                        time.sleep(2**attempt)
                        continue
                    format_errors.append(f"Invalid model JSON: {exc}")
                    break
                return result, token_usage(body)
            except HTTPError as exc:
                body = exc.read().decode("utf-8", errors="replace")[:600]
                if exc.code in {400, 404, 422} and response_format is not None:
                    format_errors.append(f"HTTP {exc.code}: {body}")
                    break
                if exc.code == 429 or 500 <= exc.code < 600:
                    if attempt < 2:
                        time.sleep(2**attempt)
                        continue
                raise RuntimeError(f"CanopyWave returned HTTP {exc.code}: {body}") from exc
            except URLError as exc:
                if attempt < 2:
                    time.sleep(2**attempt)
                    continue
                raise RuntimeError(f"Could not reach CanopyWave: {exc.reason}") from exc

    detail = format_errors[-1] if format_errors else "no response"
    raise RuntimeError(f"CanopyWave did not return structured CV JSON ({detail}).")


def extract_page_text(page: Any) -> str:
    """Prefer pypdf's layout-preserving mode, then fall back to ordinary text."""
    try:
        text = page.extract_text(extraction_mode="layout") or ""
    except (TypeError, ValueError):
        text = page.extract_text() or ""
    return repair_text_artifacts(text).strip()


def mechanical_pdf_payload(
    path: Path,
    image_output_dir: Path | None,
    embed_images: bool,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    reader = PdfReader(str(path))
    pages: list[dict[str, Any]] = []
    prompt_pages: list[dict[str, Any]] = []

    for page_number, page in enumerate(reader.pages, start=1):
        text = extract_page_text(page)
        images = extract_image_objects(
            page,
            page_number,
            image_output_dir=image_output_dir,
            embed_images=embed_images,
        )
        lines = [
            {"page": page_number, "line_number": index, "text": line.strip()}
            for index, line in enumerate(text.splitlines(), start=1)
            if line.strip()
        ]
        pages.append(
            {
                "page_number": page_number,
                "width": round(float(page.mediabox.width), 3),
                "height": round(float(page.mediabox.height), 3),
                "text": text,
                "lines": lines,
                "images": images,
            }
        )
        prompt_pages.append({"page_number": page_number, "text": text})

    source = {
        "file": str(path),
        "filename": path.name,
        "file_size_bytes": path.stat().st_size,
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "metadata": json_safe(dict(reader.metadata or {})),
        "pages": pages,
    }
    return source, prompt_pages


def build_user_prompt(filename: str, prompt_pages: list[dict[str, Any]]) -> str:
    page_blocks = []
    for page in prompt_pages:
        page_blocks.append(
            f'<page number="{page["page_number"]}">\n{page["text"]}\n</page>'
        )
    return (
        f"Extract this CV: {filename}\n\n"
        + "\n\n".join(page_blocks)
        + "\n\nReturn the complete structured CV JSON."
    )


def section(
    heading: str,
    *,
    text: str = "",
    items: list[str] | None = None,
    work_experience: list[dict[str, Any]] | None = None,
    projects: list[dict[str, Any]] | None = None,
    start_page: int = 1,
) -> dict[str, Any]:
    values = [clean_text(item) for item in (items or []) if clean_text(item)]
    body = text.strip() or "\n".join(values)
    lines = [
        {"page": start_page, "line_number": index, "text": value}
        for index, value in enumerate(values or body.splitlines(), start=1)
        if clean_text(value)
    ]
    return {
        "heading": heading,
        "start_page": start_page,
        "text": body,
        "lines": lines,
        "bullets": values,
        "tables": [],
        "work_experience": work_experience or [],
        "projects": projects or [],
    }


def source_page(value: dict[str, Any]) -> int:
    pages = value.get("source_pages") or []
    return min((page for page in pages if isinstance(page, int) and page > 0), default=1)


def work_experience_records(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    records = []
    for item in items:
        start, end = work_experience_date_endpoints(
            item.get("start_date"),
            item.get("end_date"),
        )
        role = clean_text(item.get("role"))
        organisation = clean_text(item.get("organisation"))
        location = clean_text(item.get("location"))
        description = normalize_date_ranges(item.get("description"))
        raw = normalize_date_ranges(item.get("raw_text"))
        if not raw:
            duration = " – ".join(part for part in [start, end] if part)
            raw = ", ".join(
                part
                for part in [duration, role, organisation, location, description]
                if part
            )
        records.append(
            {
                "start_year": start,
                "end_year": end or None,
                "role": role,
                "organisation": organisation or None,
                "location": location,
                "description": description,
                "raw": raw,
                "source_pages": item.get("source_pages") or [],
            }
        )
    return records


def raw_project_records(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    records = []
    for item in items:
        name = clean_text(item.get("name"))
        duration = normalize_date_value(item.get("duration"))
        display_title = ", ".join(part for part in [name, duration] if part)
        description = normalize_date_ranges(item.get("description"))
        bullets = [clean_text(value) for value in item.get("bullets") or []]
        bullets = [value for value in bullets if value and value != description]
        if description:
            bullets.insert(0, description)
        source_text = normalize_date_ranges(item.get("source_text"))
        text = source_text or "\n".join([display_title, *bullets])
        records.append(
            {
                "name": display_title or name or "Untitled project",
                "duration": duration,
                "role": clean_text(item.get("role")),
                "role_line": clean_text(item.get("role")),
                "client": clean_text(item.get("client")),
                "location": clean_text(item.get("location")),
                "category": "Selected Projects",
                "source": "canopywave_llm",
                "source_section": "Selected Projects",
                "content_type": "narrative_project",
                "description": description,
                "bullets": bullets,
                "text": text,
                "source_pages": item.get("source_pages") or [],
            }
        )
    return records


def llm_result_to_raw_cv(
    *,
    path: Path,
    relative_path: Path,
    source: dict[str, Any],
    result: dict[str, Any],
    model: str,
    usage: dict[str, int],
    costs: dict[str, float],
) -> dict[str, Any]:
    pages = source["pages"]
    work_items = result.get("work_experience") or []
    experience = work_experience_records(work_items)
    projects = raw_project_records(result.get("selected_projects") or [])
    sections: list[dict[str, Any]] = []

    overview = str(result.get("overview") or "").strip()
    if overview:
        sections.append(section("Overview", text=overview))
    if experience:
        experience_lines = [record["raw"] for record in experience if record["raw"]]
        sections.append(
            section(
                "Work Experience",
                items=experience_lines,
                work_experience=experience,
                start_page=min((source_page(item) for item in work_items), default=1),
            )
        )

    standard_lists = [
        ("Core Competencies", "key_expertise"),
        ("Qualifications", "qualifications"),
        ("Professional Bodies and Memberships", "memberships"),
    ]
    for heading, field in standard_lists:
        values = result.get(field) or []
        if values:
            sections.append(section(heading, items=values))

    if projects:
        project_items = result.get("selected_projects") or []
        sections.append(
            section(
                "Selected Projects",
                items=[record["text"] for record in projects],
                projects=projects,
                start_page=min(
                    (source_page(item) for item in project_items),
                    default=1,
                ),
            )
        )

    for extra in result.get("additional_sections") or []:
        heading = clean_text(extra.get("heading")) or "Additional Information"
        values = [clean_text(value) for value in extra.get("items") or []]
        sections.append(
            section(
                heading,
                text=str(extra.get("content") or "").strip(),
                items=values,
                start_page=source_page(extra),
            )
        )

    return {
        "source": {
            "file": str(path),
            "filename": path.name,
            "relative_path": relative_path.as_posix(),
            "file_size_bytes": source["file_size_bytes"],
            "sha256": source["sha256"],
        },
        "metadata": source["metadata"],
        "summary": {
            "page_count": len(pages),
            "line_count": sum(len(page["lines"]) for page in pages),
            "section_count": len(sections),
            "image_count": sum(len(page["images"]) for page in pages),
            "project_count": len(projects),
            "additional_project_count": 0,
            "extractable_image_count": sum(
                1
                for page in pages
                for image in page["images"]
                if image.get("extractable")
            ),
        },
        "profile": {
            "name": clean_text((result.get("profile") or {}).get("name")),
            "role": clean_text((result.get("profile") or {}).get("role")),
        },
        "profile_photo": infer_profile_photo(pages),
        "sections": sections,
        "contacts": result.get("contacts") or {
            "emails": [],
            "phones": [],
            "urls": [],
        },
        "pages": pages,
        "llm_extraction": {
            "provider": "canopywave",
            "model": model,
            "prompt_version": PROMPT_VERSION,
            "input_mode": "pypdf_layout_text",
            "warnings": result.get("warnings") or [],
            "source_quality_flags": result.get("quality_flags") or [],
            "usage": usage,
            "cost": costs,
        },
    }


def load_cache(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def cache_key(
    source_sha256: str,
    model: str,
    prompt_version: str = PROMPT_VERSION,
) -> str:
    return hashlib.sha256(
        f"{prompt_version}:{model}:{source_sha256}".encode("utf-8")
    ).hexdigest()


def save_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def build_cost_report(
    cvs: list[dict[str, Any]],
    *,
    model: str,
    input_price_per_million: float,
    output_price_per_million: float,
    cached_input_price_per_million: float,
) -> dict[str, Any]:
    items = []
    for cv in cvs:
        extraction = cv.get("llm_extraction") or {}
        usage = extraction.get("usage") or {}
        costs = extraction.get("cost") or {}
        items.append(
            {
                "file": (cv.get("source") or {}).get("relative_path")
                or (cv.get("source") or {}).get("filename"),
                **usage,
                **costs,
            }
        )

    count = len(items)
    totals = {
        field: sum(int(item.get(field, 0) or 0) for item in items)
        for field in (
            "input_tokens",
            "uncached_input_tokens",
            "cached_input_tokens",
            "output_tokens",
            "total_tokens",
        )
    }
    total_cost = sum(float(item.get("total_cost_usd", 0) or 0) for item in items)
    average_cost = total_cost / count if count else 0.0
    return {
        "model": model,
        "pricing_usd_per_million_tokens": {
            "input": input_price_per_million,
            "output": output_price_per_million,
            "cached_input": cached_input_price_per_million,
        },
        "file_count": count,
        "items": items,
        "totals": {
            **totals,
            "cost_usd": total_cost,
        },
        "averages": {
            field: (value / count if count else 0)
            for field, value in totals.items()
        }
        | {"cost_usd": average_cost},
        "projection_350_files": {
            "estimated_cost_usd": average_cost * 350,
            "basis": "sample mean multiplied by 350",
        },
    }


def exclude_relative_directories(
    paths: list[Path],
    relative_paths: dict[Path, Path],
    excluded_directories: list[str],
) -> list[Path]:
    excluded = {
        directory.strip().casefold()
        for directory in excluded_directories
        if directory.strip()
    }
    if not excluded:
        return paths

    return [
        path
        for path in paths
        if excluded.isdisjoint(
            part.casefold() for part in relative_paths[path].parent.parts
        )
    ]


def empty_usage() -> dict[str, int]:
    return {
        "input_tokens": 0,
        "uncached_input_tokens": 0,
        "cached_input_tokens": 0,
        "output_tokens": 0,
        "total_tokens": 0,
    }


def extract_one_cv(
    *,
    index: int,
    total: int,
    path: Path,
    relative_path: Path,
    args: argparse.Namespace,
    api_key: str,
    cache: dict[str, Any],
    cache_lock: Lock,
) -> tuple[int, dict[str, Any] | None]:
    """Extract one PDF without sharing mutable provider state across workers."""
    image_dir = (
        args.image_output_dir / relative_path.parent / relative_path.stem
        if args.image_output_dir and not args.dry_run
        else None
    )
    source, prompt_pages = mechanical_pdf_payload(
        path,
        image_output_dir=image_dir,
        embed_images=not args.no_embed_images,
    )
    prompt = build_user_prompt(path.name, prompt_pages)
    print(
        f"[{index}/{total}] {relative_path.as_posix()} "
        f"({len(prompt):,} prompt characters)"
    )
    if args.dry_run:
        return index, None

    key = cache_key(source["sha256"], args.model)
    cached_key = None
    cached_entry: Any = None
    if not args.no_cache:
        candidate_keys = [
            key,
            *[
                cache_key(source["sha256"], args.model, version)
                for version in LEGACY_PROMPT_VERSIONS
            ],
        ]
        with cache_lock:
            cached_key = next(
                (candidate for candidate in candidate_keys if candidate in cache),
                None,
            )
            if cached_key is not None:
                cached_entry = copy.deepcopy(cache[cached_key])

    if cached_key is not None:
        if isinstance(cached_entry, dict) and "result" in cached_entry:
            result = validate_llm_result(cached_entry["result"])
            usage = cached_entry.get("usage") or empty_usage()
        else:
            result = validate_llm_result(cached_entry)
            usage = empty_usage()
        print(f"[{index}/{total}] using cached LLM extraction")
        if cached_key != key:
            with cache_lock:
                cache[key] = {"result": result, "usage": usage}
                save_json(args.cache, cache)
    else:
        result, usage = canopywave_chat_completion(
            api_key=api_key,
            endpoint=args.endpoint,
            model=args.model,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": prompt},
            ],
            max_tokens=args.max_tokens,
            temperature=args.temperature,
            timeout=args.timeout,
        )
        with cache_lock:
            cache[key] = {"result": result, "usage": usage}
            save_json(args.cache, cache)

    costs = usage_cost(
        usage,
        input_price_per_million=args.input_price_per_million,
        output_price_per_million=args.output_price_per_million,
        cached_input_price_per_million=args.cached_input_price_per_million,
    )
    print(
        f"[{index}/{total}] complete: "
        f"{usage['input_tokens']:,} input + "
        f"{usage['output_tokens']:,} output tokens; "
        f"${costs['total_cost_usd']:.6f}"
    )
    return (
        index,
        llm_result_to_raw_cv(
            path=path,
            relative_path=relative_path,
            source=source,
            result=result,
            model=args.model,
            usage=usage,
            costs=costs,
        ),
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("inputs", nargs="+", type=Path, help="PDF files or folders.")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--image-output-dir", type=Path, default=DEFAULT_IMAGE_OUTPUT)
    parser.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--cost-report", type=Path, default=DEFAULT_COST_REPORT)
    parser.add_argument(
        "--endpoint",
        default=os.getenv("CANOPYWAVE_API_URL", DEFAULT_ENDPOINT),
    )
    parser.add_argument(
        "--model",
        default=os.getenv("CANOPYWAVE_MODEL", DEFAULT_MODEL),
    )
    parser.add_argument("--max-tokens", type=int, default=16000)
    parser.add_argument("--temperature", type=float, default=0.0)
    parser.add_argument("--workers", type=int, default=DEFAULT_WORKERS)
    parser.add_argument(
        "--timeout",
        type=int,
        default=DEFAULT_TIMEOUT_SECONDS,
        help="CanopyWave request timeout in seconds (default: 300).",
    )
    parser.add_argument(
        "--input-price-per-million",
        type=float,
        default=DEFAULT_INPUT_PRICE_PER_MILLION,
    )
    parser.add_argument(
        "--output-price-per-million",
        type=float,
        default=DEFAULT_OUTPUT_PRICE_PER_MILLION,
    )
    parser.add_argument(
        "--cached-input-price-per-million",
        type=float,
        default=DEFAULT_CACHED_INPUT_PRICE_PER_MILLION,
    )
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument(
        "--exclude-dir",
        action="append",
        default=[],
        help="Skip PDFs inside a directory with this name. Repeat as needed.",
    )
    parser.add_argument(
        "--no-embed-images",
        action="store_true",
        help="Do not embed extracted image bytes in the output JSON.",
    )
    parser.add_argument(
        "--no-cache",
        action="store_true",
        help="Call CanopyWave even when an extraction is cached.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Read PDFs and report prompt sizes without making API calls.",
    )
    return parser.parse_args()


def main() -> int:
    if load_dotenv is not None:
        load_dotenv(ROOT / ".env")
    args = parse_args()
    if args.workers < 1:
        raise SystemExit("--workers must be at least 1")
    if args.timeout < 1:
        raise SystemExit("--timeout must be at least 1 second")
    api_key = os.getenv("CANOPYWAVE_API_KEY", "").strip()
    if not args.dry_run and not api_key:
        raise SystemExit(
            "CANOPYWAVE_API_KEY is not set. Add it to .env or export it."
        )

    paths = collect_pdf_paths(args.inputs)
    relative_paths = relative_pdf_paths(args.inputs, paths)
    paths = exclude_relative_directories(paths, relative_paths, args.exclude_dir)
    if not paths:
        raise SystemExit("No PDF files remain after applying directory exclusions.")
    if args.limit is not None:
        paths = paths[: args.limit]
    cache = load_cache(args.cache)
    cache_lock = Lock()
    completed: dict[int, dict[str, Any]] = {}
    errors: list[str] = []
    print(
        f"Extracting {len(paths)} PDF(s) with {args.workers} workers "
        f"(request timeout {args.timeout}s)"
    )
    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = {
            executor.submit(
                extract_one_cv,
                index=index,
                total=len(paths),
                path=path,
                relative_path=relative_paths[path],
                args=args,
                api_key=api_key,
                cache=cache,
                cache_lock=cache_lock,
            ): (index, relative_paths[path])
            for index, path in enumerate(paths, start=1)
        }
        for future in as_completed(futures):
            index, relative_path = futures[future]
            try:
                result_index, cv = future.result()
                if cv is not None:
                    completed[result_index] = cv
            except Exception as exc:  # noqa: BLE001
                message = f"{relative_path.as_posix()}: {exc}"
                errors.append(message)
                print(f"[{index}/{len(paths)}] FAIL: {message}")

    if errors:
        print(f"Extraction failures: {len(errors)}")
        for message in errors:
            print(f"  {message}")
        return 1

    if args.dry_run:
        print(f"Dry run complete: {len(paths)} PDF(s), no API calls.")
        return 0
    cvs = [completed[index] for index in range(1, len(paths) + 1)]

    payload = {
        "summary": {
            "cv_count": len(cvs),
            "files": [cv["source"]["filename"] for cv in cvs],
            "page_count": sum(cv["summary"]["page_count"] for cv in cvs),
            "section_count": sum(cv["summary"]["section_count"] for cv in cvs),
            "image_count": sum(cv["summary"]["image_count"] for cv in cvs),
            "extractable_image_count": sum(
                cv["summary"]["extractable_image_count"] for cv in cvs
            ),
            "extraction_provider": "canopywave",
            "extraction_model": args.model,
        },
        "cvs": cvs,
    }
    save_json(args.output, payload)
    cost_report = build_cost_report(
        cvs,
        model=args.model,
        input_price_per_million=args.input_price_per_million,
        output_price_per_million=args.output_price_per_million,
        cached_input_price_per_million=args.cached_input_price_per_million,
    )
    save_json(args.cost_report, cost_report)
    print(f"Wrote {args.output}")
    print(f"Wrote {args.cost_report}")
    print(f"Extracted {len(cvs)} CV(s) with {args.model}")
    print(
        f"Total API cost: ${cost_report['totals']['cost_usd']:.6f}; "
        f"average: ${cost_report['averages']['cost_usd']:.6f} per CV"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
