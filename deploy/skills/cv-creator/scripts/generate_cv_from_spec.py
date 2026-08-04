#!/usr/bin/env python3
"""Run the AESG V3 CV pipeline from a structured Berry CV specification."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def run(label: str, command: list[str]) -> None:
    print(f"\n[{label}] {' '.join(command)}", flush=True)
    subprocess.run(command, cwd=ROOT, check=True)


def formats(value: str) -> list[str]:
    requested = []
    for item in value.split(","):
        item = item.strip().casefold()
        if item and item not in requested:
            requested.append(item)
    unsupported = [item for item in requested if item not in {"docx", "pptx"}]
    if unsupported or not requested:
        raise argparse.ArgumentTypeError(
            "--formats must be docx, pptx, or docx,pptx"
        )
    return requested


def prepare_batch(root: Path) -> tuple[Path, Path]:
    root.mkdir(parents=True, exist_ok=True)
    unexpected = sorted(
        item.name
        for item in root.iterdir()
        if item.name not in {".DS_Store", "extracted", "generated", "manifest.json"}
    )
    if unexpected:
        raise RuntimeError(
            "Batch root may contain only extracted/, generated/, and manifest.json. "
            f"Unexpected entries: {', '.join(unexpected)}"
        )
    extracted = root / "extracted"
    generated = root / "generated"
    extracted.mkdir(parents=True, exist_ok=True)
    generated.mkdir(parents=True, exist_ok=True)
    return extracted, generated


def publish(
    generated_root: Path,
    deliverables_dir: Path,
    requested_formats: list[str],
    orientation: str,
    *,
    overwrite: bool,
) -> list[Path]:
    deliverables_dir.mkdir(parents=True, exist_ok=True)
    allowed_orientations = (
        {"portrait", "landscape"}
        if orientation == "both"
        else {orientation}
    )
    outputs: list[Path] = []
    sources = sorted(
        [*generated_root.rglob("*.docx"), *generated_root.rglob("*.pptx")]
    )
    for source in sources:
        kind = source.parent.name
        if "_" not in kind:
            continue
        file_format, file_orientation = kind.split("_", 1)
        if (
            file_format not in requested_formats
            or file_orientation not in allowed_orientations
        ):
            continue
        destination = deliverables_dir / (
            f"{source.stem}_{file_orientation}{source.suffix.lower()}"
        )
        if destination.exists() and not overwrite:
            raise RuntimeError(
                f"Refusing to overwrite existing deliverable: {destination}. "
                "Use --overwrite only after confirming the target."
            )
        shutil.copy2(source, destination)
        outputs.append(destination)
    expected = len(requested_formats) * len(allowed_orientations)
    if len(outputs) != expected:
        raise RuntimeError(
            f"Expected {expected} deliverables but collected {len(outputs)}"
        )
    return outputs


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--spec", type=Path, required=True)
    parser.add_argument("--photo", type=Path, required=True)
    parser.add_argument("--batch-root", type=Path, required=True)
    parser.add_argument("--deliverables-dir", type=Path, required=True)
    parser.add_argument("--formats", type=formats, default=formats("docx,pptx"))
    parser.add_argument(
        "--orientation",
        choices=("portrait", "landscape", "both"),
        default="both",
    )
    parser.add_argument("--overwrite", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.spec.is_file():
        raise SystemExit(f"Specification does not exist: {args.spec}")
    if not args.photo.is_file():
        raise SystemExit(f"Profile photo does not exist: {args.photo}")

    batch_root = args.batch_root.resolve()
    extracted, generated = prepare_batch(batch_root)
    raw_json = extracted / "cv_data.json"
    preprocessed_json = extracted / "preprocessed_cv_data.json"
    python = sys.executable

    run(
        "structured input",
        [
            python,
            str(ROOT / "scripts" / "prepare_cv_input.py"),
            "--spec",
            str(args.spec.resolve()),
            "--photo",
            str(args.photo.resolve()),
            "--output",
            str(raw_json),
        ],
    )
    run(
        "preprocessing",
        [
            python,
            str(ROOT / "scripts" / "v3" / "preprocess_cv_data_v3.py"),
            "--input",
            str(raw_json),
            "--output",
            str(preprocessed_json),
        ],
    )
    if "docx" in args.formats:
        run(
            "DOCX rendering",
            [
                python,
                str(ROOT / "scripts" / "v3" / "render_docx_v3.py"),
                "--data",
                str(preprocessed_json),
                "--output-root",
                str(generated),
                "--skip-refresh",
                "--orientation",
                args.orientation,
            ],
        )
    if "pptx" in args.formats:
        run(
            "PPTX rendering",
            [
                python,
                str(ROOT / "scripts" / "v3" / "render_pptx_v3.py"),
                "--data",
                str(preprocessed_json),
                "--output-root",
                str(generated),
                "--orientation",
                args.orientation,
            ],
        )
    deliverables = publish(
        generated,
        args.deliverables_dir.resolve(),
        args.formats,
        args.orientation,
        overwrite=args.overwrite,
    )
    manifest = {
        "spec": str(args.spec.resolve()),
        "photo": str(args.photo.resolve()),
        "raw_json": str(raw_json),
        "preprocessed_json": str(preprocessed_json),
        "generated_root": str(generated),
        "deliverables": [str(path) for path in deliverables],
    }
    manifest_path = batch_root / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"\nWrote {manifest_path}")
    for path in deliverables:
        print(f"Deliverable: {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
