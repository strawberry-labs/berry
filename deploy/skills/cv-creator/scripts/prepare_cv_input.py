#!/usr/bin/env python3
"""Convert a Berry-authored CV specification and headshot to raw V3 CV JSON."""

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import re
from pathlib import Path
from typing import Any

from PIL import Image


def text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def strings(value: Any, field: str) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError(f"{field} must be an array")
    return [item for item in (text(item) for item in value) if item]


def objects(value: Any, field: str) -> list[dict[str, Any]]:
    if value is None:
        return []
    if not isinstance(value, list) or any(not isinstance(item, dict) for item in value):
        raise ValueError(f"{field} must be an array of objects")
    return value


def require(value: Any, field: str) -> str:
    result = text(value)
    if not result:
        raise ValueError(f"Missing required field: {field}")
    return result


def safe_filename(value: Any, name: str) -> str:
    filename = Path(text(value) or f"{name} - CV.pdf").name
    stem = filename.rsplit(".", 1)[0] if "." in filename else filename
    stem = re.sub(r"[\\/:*?\"<>|]+", "-", stem).strip(" .")
    return f"{stem or 'AESG CV'}.pdf"


def section(
    heading: str,
    *,
    body: str = "",
    items: list[str] | None = None,
    work_experience: list[dict[str, Any]] | None = None,
    projects: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    values = items or []
    content = body or "\n".join(values)
    lines = [
        {"page": 1, "line_number": index, "text": item}
        for index, item in enumerate(values or ([content] if content else []), start=1)
    ]
    return {
        "heading": heading,
        "start_page": 1,
        "text": content,
        "lines": lines,
        "bullets": values,
        "tables": [],
        "work_experience": work_experience or [],
        "projects": projects or [],
    }


def encode_photo(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise ValueError(f"Profile photo does not exist: {path}")
    raw = path.read_bytes()
    try:
        with Image.open(io.BytesIO(raw)) as image:
            image.load()
            width, height = image.size
            image_format = (image.format or "").upper()
            mime_type = Image.MIME.get(image_format)
            if image_format not in {"JPEG", "PNG"} or not mime_type:
                converted = io.BytesIO()
                image.convert("RGB").save(converted, format="JPEG", quality=95)
                raw = converted.getvalue()
                image_format = "JPEG"
                mime_type = "image/jpeg"
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"Profile photo is not a readable image: {path}") from exc
    if width < 240 or height < 240:
        raise ValueError(
            f"Profile photo is too small ({width}x{height}); use at least 240x240 pixels"
        )
    return {
        "name": path.name,
        "format": image_format,
        "mime_type": mime_type,
        "width": width,
        "height": height,
        "extractable": True,
        "page_number": 1,
        "base64": base64.b64encode(raw).decode("ascii"),
    }


def experience_records(spec: dict[str, Any]) -> list[dict[str, Any]]:
    source = objects(spec.get("work_experience"), "work_experience")
    if not source and not spec.get("confirm_no_work_experience"):
        raise ValueError(
            "Add at least one work_experience record or set "
            "confirm_no_work_experience to true"
        )
    output = []
    for index, item in enumerate(source, start=1):
        start = text(item.get("start_date"))
        end = text(item.get("end_date"))
        role = require(item.get("role"), f"work_experience[{index}].role")
        organisation = require(
            item.get("organisation"),
            f"work_experience[{index}].organisation",
        )
        if not start and not end:
            raise ValueError(
                f"work_experience[{index}] needs start_date or end_date"
            )
        location = text(item.get("location"))
        description = text(item.get("description"))
        duration = " - ".join(part for part in (start, end) if part)
        raw = ", ".join(
            part
            for part in (duration, role, organisation, location, description)
            if part
        )
        output.append(
            {
                "start_year": start,
                "end_year": end or None,
                "role": role,
                "organisation": organisation,
                "location": location,
                "description": description,
                "raw": raw,
                "source_pages": [],
            }
        )
    return output


def project_records(spec: dict[str, Any]) -> list[dict[str, Any]]:
    source = objects(spec.get("selected_projects"), "selected_projects")
    if not source and not spec.get("confirm_no_selected_projects"):
        raise ValueError(
            "Add selected_projects or set confirm_no_selected_projects to true"
        )
    output = []
    for index, item in enumerate(source, start=1):
        name = require(item.get("name"), f"selected_projects[{index}].name")
        description = require(
            item.get("description"),
            f"selected_projects[{index}].description",
        )
        duration = text(item.get("duration"))
        bullets = strings(item.get("bullets"), f"selected_projects[{index}].bullets")
        narrative = [description, *[item for item in bullets if item != description]]
        output.append(
            {
                "name": name,
                "duration": duration,
                "role": text(item.get("role")),
                "role_line": text(item.get("role")),
                "client": text(item.get("client")),
                "location": text(item.get("location")),
                "category": "Selected Projects",
                "source": "berry_user_input",
                "source_section": "Selected Projects",
                "content_type": "narrative_project",
                "description": description,
                "bullets": narrative,
                "text": "\n".join([name, *narrative]),
                "source_pages": [],
            }
        )
    return output


def build_payload(spec: dict[str, Any], photo_path: Path) -> dict[str, Any]:
    name = require(spec.get("name"), "name")
    role = require(spec.get("role"), "role")
    overview = require(spec.get("overview"), "overview")
    filename = safe_filename(spec.get("source_filename"), name)
    photo = encode_photo(photo_path)
    experience = experience_records(spec)
    projects = project_records(spec)
    expertise = strings(spec.get("key_expertise"), "key_expertise")
    qualifications = strings(spec.get("qualifications"), "qualifications")
    memberships = strings(spec.get("memberships"), "memberships")

    sections = [section("Overview", body=overview)]
    if experience:
        sections.append(
            section(
                "Work Experience",
                items=[item["raw"] for item in experience],
                work_experience=experience,
            )
        )
    if expertise:
        sections.append(section("Core Competencies", items=expertise))
    if qualifications:
        sections.append(section("Qualifications", items=qualifications))
    if memberships:
        sections.append(
            section("Professional Bodies and Memberships", items=memberships)
        )
    if projects:
        sections.append(
            section(
                "Selected Projects",
                items=[item["text"] for item in projects],
                projects=projects,
            )
        )
    for index, item in enumerate(
        objects(spec.get("additional_sections"), "additional_sections"),
        start=1,
    ):
        heading = require(item.get("heading"), f"additional_sections[{index}].heading")
        sections.append(
            section(
                heading,
                body=text(item.get("content")),
                items=strings(item.get("items"), f"additional_sections[{index}].items"),
            )
        )

    contacts = spec.get("contacts") or {}
    if not isinstance(contacts, dict):
        raise ValueError("contacts must be an object")
    quality_flags = objects(spec.get("source_quality_flags"), "source_quality_flags")
    cv = {
        "source": {
            "file": "berry-user-input",
            "filename": filename,
            "relative_path": filename,
            "file_size_bytes": 0,
            "sha256": hashlib.sha256(
                json.dumps(spec, sort_keys=True).encode("utf-8")
            ).hexdigest(),
        },
        "metadata": {},
        "summary": {
            "page_count": 0,
            "line_count": sum(len(item["lines"]) for item in sections),
            "section_count": len(sections),
            "image_count": 1,
            "project_count": len(projects),
            "additional_project_count": 0,
            "extractable_image_count": 1,
        },
        "profile": {"name": name, "role": role},
        "profile_photo": photo,
        "sections": sections,
        "contacts": {
            "emails": strings(contacts.get("emails"), "contacts.emails"),
            "phones": strings(contacts.get("phones"), "contacts.phones"),
            "urls": strings(contacts.get("urls"), "contacts.urls"),
        },
        "pages": [],
        "llm_extraction": {
            "provider": "berry",
            "model": "interactive-agent",
            "prompt_version": "cv-creator-skill-v1",
            "input_mode": "user_prompt_or_agent_extraction",
            "warnings": strings(spec.get("warnings"), "warnings"),
            "source_quality_flags": quality_flags,
            "usage": {},
            "cost": {},
        },
    }
    return {
        "summary": {
            "cv_count": 1,
            "files": [filename],
            "page_count": 0,
            "section_count": len(sections),
            "image_count": 1,
            "extractable_image_count": 1,
            "extraction_provider": "berry",
            "extraction_model": "interactive-agent",
        },
        "cvs": [cv],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--spec", type=Path, required=True)
    parser.add_argument("--photo", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        spec = json.loads(args.spec.read_text(encoding="utf-8"))
        if not isinstance(spec, dict):
            raise ValueError("CV specification must be a JSON object")
        payload = build_payload(spec, args.photo)
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        raise SystemExit(f"Invalid CV input: {exc}") from exc
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"Wrote {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
