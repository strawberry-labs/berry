#!/usr/bin/env python3
"""Run the complete V3 CV pipeline with a two-folder batch layout."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
REQUIRED_TEMPLATES = (
    ROOT / "assets" / "templates" / "v3" / "aesg_cv_portrait_v3.docx",
    ROOT / "assets" / "templates" / "v3" / "aesg_cv_landscape_v3.docx",
    ROOT / "assets" / "templates" / "v3" / "aesg_cv_portrait_v3.pptx",
    ROOT / "assets" / "templates" / "v3" / "aesg_cv_landscape_v3.pptx",
)
ARTIFACT_KINDS = {
    "docx_portrait": ("portrait", ".docx"),
    "docx_landscape": ("landscape", ".docx"),
    "pptx_portrait": ("portrait", ".pptx"),
    "pptx_landscape": ("landscape", ".pptx"),
}


@dataclass(frozen=True)
class BatchPaths:
    root: Path
    extracted: Path
    generated: Path
    raw_json: Path
    preprocessed_json: Path
    cache: Path
    cost_report: Path
    images: Path

    @classmethod
    def from_root(cls, root: Path) -> "BatchPaths":
        batch_root = root.resolve()
        extracted = batch_root / "extracted"
        return cls(
            root=batch_root,
            extracted=extracted,
            generated=batch_root / "generated",
            raw_json=extracted / "cv_data.json",
            preprocessed_json=extracted / "preprocessed_cv_data.json",
            cache=extracted / "llm_cv_extraction_cache.json",
            cost_report=extracted / "llm_cv_cost_report.json",
            images=extracted / "images",
        )


def run_stage(label: str, command: list[str]) -> None:
    print(f"\n[{label}] {' '.join(command)}", flush=True)
    subprocess.run(command, cwd=ROOT, check=True)


def prepare_batch(paths: BatchPaths) -> None:
    paths.root.mkdir(parents=True, exist_ok=True)
    unexpected = sorted(
        item.name
        for item in paths.root.iterdir()
        if item.name not in {".DS_Store", "extracted", "generated"}
    )
    if unexpected:
        raise RuntimeError(
            "Batch output folder must contain only extracted/ and generated/. "
            f"Unexpected entries: {', '.join(unexpected)}"
        )
    paths.extracted.mkdir(parents=True, exist_ok=True)
    paths.generated.mkdir(parents=True, exist_ok=True)
    paths.images.mkdir(parents=True, exist_ok=True)


def publish_batch(
    generated_root: Path,
    preprocessed_json: Path,
    deliverables_dir: Path,
    *,
    overwrite: bool,
) -> list[Path]:
    with preprocessed_json.open(encoding="utf-8") as handle:
        payload = json.load(handle)
    cvs = payload.get("cvs") if isinstance(payload, dict) else None
    cv_count = len(cvs) if isinstance(cvs, list) else 1
    if cv_count < 1:
        raise RuntimeError("No CVs were available to publish")

    planned: list[tuple[Path, Path]] = []
    claimed_destinations: set[Path] = set()
    sources = sorted(
        [*generated_root.rglob("*.docx"), *generated_root.rglob("*.pptx")]
    )
    for source in sources:
        relative = source.relative_to(generated_root)
        matching_parts = [
            (index, part)
            for index, part in enumerate(relative.parts[:-1])
            if part in ARTIFACT_KINDS
        ]
        if len(matching_parts) != 1:
            continue
        kind_index, kind = matching_parts[0]
        orientation, expected_suffix = ARTIFACT_KINDS[kind]
        if source.suffix.casefold() != expected_suffix:
            continue
        source_parent = Path(*relative.parts[:kind_index])
        destination = (
            deliverables_dir
            / source_parent
            / f"{source.stem}_{orientation}{expected_suffix}"
        )
        if destination in claimed_destinations:
            raise RuntimeError(
                f"Multiple generated files map to the same deliverable: {destination}"
            )
        claimed_destinations.add(destination)
        planned.append((source, destination))

    expected_count = cv_count * len(ARTIFACT_KINDS)
    if len(planned) != expected_count:
        raise RuntimeError(
            f"Expected {expected_count} batch deliverables for {cv_count} CVs "
            f"but collected {len(planned)}"
        )
    conflicts = [destination for _, destination in planned if destination.exists()]
    if conflicts and not overwrite:
        raise RuntimeError(
            "Refusing to overwrite existing deliverables:\n"
            + "\n".join(f"  {path}" for path in conflicts)
            + "\nUse --overwrite only after confirming the targets."
        )

    outputs: list[Path] = []
    for source, destination in planned:
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        if destination.stat().st_size < 1:
            raise RuntimeError(f"Published an empty deliverable: {destination}")
        outputs.append(destination)
    return outputs


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="Folder containing source PDFs.")
    parser.add_argument(
        "--batch-root",
        type=Path,
        required=True,
        help="Output folder that will contain only extracted/ and generated/.",
    )
    parser.add_argument(
        "--deliverables-dir",
        type=Path,
        required=True,
        help="Folder that receives the final portrait and landscape DOCX/PPTX files.",
    )
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--llm-timeout", type=int, default=300)
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument(
        "--exclude-dir",
        action="append",
        default=[],
        help="Skip source PDFs below this directory name. Repeat as needed.",
    )
    parser.add_argument(
        "--no-cache",
        action="store_true",
        help="Force fresh MiniMax extraction even when a cached result exists.",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Replace existing final deliverables after explicitly confirming the target.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.workers < 1:
        raise SystemExit("--workers must be at least 1")
    if args.llm_timeout < 1:
        raise SystemExit("--llm-timeout must be at least 1 second")
    if not args.input.is_dir():
        raise SystemExit(f"Input folder does not exist: {args.input}")

    missing_templates = [path for path in REQUIRED_TEMPLATES if not path.is_file()]
    if missing_templates:
        raise SystemExit(
            "Missing V3 templates:\n"
            + "\n".join(f"  {path}" for path in missing_templates)
        )

    paths = BatchPaths.from_root(args.batch_root)
    deliverables_dir = args.deliverables_dir.resolve()
    if deliverables_dir == paths.root or deliverables_dir.is_relative_to(paths.root):
        raise SystemExit("--deliverables-dir must be outside --batch-root")
    prepare_batch(paths)
    python = sys.executable

    extraction = [
        python,
        str(ROOT / "scripts" / "extract_pdf_with_llm.py"),
        str(args.input.resolve()),
        "--output",
        str(paths.raw_json),
        "--image-output-dir",
        str(paths.images),
        "--cache",
        str(paths.cache),
        "--cost-report",
        str(paths.cost_report),
        "--workers",
        str(args.workers),
        "--timeout",
        str(args.llm_timeout),
    ]
    for excluded in args.exclude_dir:
        extraction.extend(["--exclude-dir", excluded])
    if args.limit is not None:
        extraction.extend(["--limit", str(args.limit)])
    if args.no_cache:
        extraction.append("--no-cache")
    run_stage("1/5 MiniMax extraction", extraction)

    run_stage(
        "2/5 preprocessing",
        [
            python,
            str(ROOT / "scripts" / "v3" / "preprocess_cv_data_v3.py"),
            "--input",
            str(paths.raw_json),
            "--output",
            str(paths.preprocessed_json),
        ],
    )
    run_stage(
        "3/5 DOCX rendering",
        [
            python,
            str(ROOT / "scripts" / "v3" / "render_docx_v3.py"),
            "--data",
            str(paths.preprocessed_json),
            "--output-root",
            str(paths.generated),
            "--skip-refresh",
            "--orientation",
            "both",
        ],
    )
    run_stage(
        "4/5 PPTX rendering",
        [
            python,
            str(ROOT / "scripts" / "v3" / "render_pptx_v3.py"),
            "--data",
            str(paths.preprocessed_json),
            "--output-root",
            str(paths.generated),
            "--orientation",
            "both",
        ],
    )
    print("\n[5/5 publishing deliverables]", flush=True)
    deliverables = publish_batch(
        paths.generated,
        paths.preprocessed_json,
        deliverables_dir,
        overwrite=args.overwrite,
    )
    print(f"\nCompleted batch: {paths.root}")
    for deliverable in deliverables:
        print(f"Deliverable: {deliverable}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
