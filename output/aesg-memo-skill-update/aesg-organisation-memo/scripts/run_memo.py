#!/usr/bin/env python3
"""Build, validate and optionally render an AESG memo in one invocation."""
import argparse
import json
import subprocess
import sys
from pathlib import Path
from build_memo import build


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--spec", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--template", type=Path)
    parser.add_argument("--render-dir", type=Path)
    args = parser.parse_args()
    scripts = Path(__file__).resolve().parent
    spec = json.loads(args.spec.read_text())
    key = spec.get("template")
    if key not in ("HR", "Finance", "IT", "Operational"):
        raise ValueError("template must be HR, Finance, IT or Operational")
    template = args.template or scripts.parent / "assets" / "templates" / f"{key} Memo Template.docx"
    build(spec, template, args.output)
    check = subprocess.run([sys.executable, str(scripts / "validate_artifact.py"), str(args.output)], capture_output=True, text=True)
    if check.returncode:
        print(json.dumps({"ok": False, "phase": "validation", "error": check.stdout + check.stderr}))
        return 1
    result = {"ok": True, "validated": True, "output": str(args.output.resolve()), "pages": []}
    if args.render_dir:
        try:
            rendered = subprocess.run([sys.executable, str(scripts / "render_artifact.py"), str(args.output), "--output-dir", str(args.render_dir)], capture_output=True, text=True, timeout=90)
            if rendered.returncode:
                result["render_error"] = (rendered.stdout + rendered.stderr)[-3000:]
            else:
                result["pages"] = [str(path.resolve()) for path in sorted(args.render_dir.glob("page-*.png"))]
        except subprocess.TimeoutExpired:
            result["render_error"] = "Rendering exceeded 90 seconds; validated DOCX retained."
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, FileNotFoundError) as error:
        print(json.dumps({"ok": False, "phase": "input", "error": str(error)}))
        raise SystemExit(1)
