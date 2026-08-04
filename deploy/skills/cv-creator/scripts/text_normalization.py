#!/usr/bin/env python3
"""Shared repairs for text artifacts introduced by PDF glyph extraction."""

from __future__ import annotations

import re
import unicodedata


# These are glyph-level splits observed in the source PDFs. Keep this list
# conservative: joining arbitrary adjacent words creates worse semantic errors.
_WORD_FRAGMENT_PATTERNS = (
    re.compile(r"\b([Cc])\s+(ontrol(?:ler)?)\b"),
    re.compile(r"\b([Ee]nviro)\s+(nmental)\b"),
    re.compile(r"\b([Ee]nsurin)\s+(g)\b"),
    re.compile(r"\b([Ff]ram)\s+(eworks?)\b"),
    re.compile(r"\b([Ff]os)\s+(ter)\b"),
    re.compile(r"\b([Ii])\s+(ntegration)\b"),
    re.compile(r"\b([Ii]nst)\s+(allation)\b"),
    re.compile(r"\b([Ii]ndoo)\s+(r)\b"),
    re.compile(r"\b([Mm]anageme)\s+(nt)\b"),
    re.compile(r"\b([Mm])\s+(a)\s+(nager)\b"),
    re.compile(r"\b([Oo]ffic)\s+(e)\b"),
    re.compile(r"\b([Pp]roced)\s+(ures?)\b"),
    re.compile(r"\b([Rr]evi)\s+(ews?)\b"),
    re.compile(r"\b([Ss]t)\s+(akeholders?)\b"),
    re.compile(r"\b([Ww])\s+(ater)\b"),
    re.compile(r"\b([Bb])\s+(uildings?)\b"),
    re.compile(r"\b([Cc]urrent)\s+(ly)\b"),
    re.compile(r"\b([Dd])\s+(u)\b"),
    re.compile(r"\b([Rr]i)\s+(y)\s+(adh)\b"),
)


# Only known compounds are joined. A blanket "word - word" replacement would
# corrupt intentional separators such as "Director - Sustainability".
_HYPHENATED_TERMS = (
    "Al-Ameen",
    "Al-Khobar",
    "Gans-Vlei",
    "audit-ready",
    "closed-loop",
    "climate-resilient",
    "cross-functional",
    "data-driven",
    "decision-grade",
    "de-risk",
    "design-stage",
    "end-to-end",
    "ESG-aligned",
    "fit-out",
    "government-led",
    "giga-project",
    "gravity-based",
    "high-performance",
    "high-end",
    "high-profile",
    "high-rise",
    "high-stakes",
    "large-scale",
    "low-carbon",
    "material-specific",
    "man-made",
    "mixed-use",
    "multi-discipline",
    "net-zero",
    "on-site",
    "pre-functional",
    "project-specific",
    "programme-wide",
    "program-wide",
    "retro-commissioning",
    "self-paced",
    "shell-and-core",
    "site-wide",
    "technical-specialist",
    "two-tower",
    "water-reuse",
    "well-being",
    "well-structured",
    "whole-life",
    "zero-waste",
    "100-year",
)


def _compound_pattern(term: str) -> re.Pattern[str]:
    parts = term.split("-")
    separator = r"\s*[-‐‑–]\s*"
    body = separator.join(f"({re.escape(part)})" for part in parts)
    return re.compile(rf"(?<!\w){body}(?!\w)", re.IGNORECASE)


_HYPHENATED_PATTERNS = tuple(_compound_pattern(term) for term in _HYPHENATED_TERMS)


def repair_text_artifacts(value: str | None) -> str:
    """Repair known split words and compound hyphens without changing meaning."""
    text = unicodedata.normalize("NFKC", str(value or ""))
    text = text.replace("\u00a0", " ")

    for pattern in _WORD_FRAGMENT_PATTERNS:
        text = pattern.sub(lambda match: "".join(match.groups()), text)

    for pattern in _HYPHENATED_PATTERNS:
        text = pattern.sub(lambda match: "-".join(match.groups()), text)

    return text
