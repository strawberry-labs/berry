"""Wrapped text in generated AESG workbooks must fit its row (H-059).

Run: python3 -B -m unittest deploy/tests/test_aesg_xlsx_geometry.py
(Text extraction cannot detect clipping, since clipped glyphs stay in the PDF, so
rendered fit was checked visually when this test was written.)
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from openpyxl import load_workbook

REPOSITORY = Path(__file__).resolve().parents[2]
GENERATOR = REPOSITORY / "deploy/skills/xlsx/scripts/create_aesg_xlsx.py"
BRANDING = REPOSITORY / "deploy/skills/aesg-branding"
LONG_COMMENT = (
    "Provide the coordinated cable containment layout for the plant room, including the "
    "tray sizes, segregation between LV and ELV services, the fire-stopping detail at each "
    "wall penetration, and confirmation that the luminaire spacing meets the design lux "
    "levels in the circulation zones before the drawings are reissued for approval."
)


def generate(directory: Path, spec: dict) -> tuple[Path, dict]:
    spec_path = directory / "spec.json"
    output = directory / "register.xlsx"
    spec_path.write_text(json.dumps(spec), encoding="utf-8")
    completed = subprocess.run(
        [sys.executable, "-B", str(GENERATOR), "--spec", str(spec_path), "--output", str(output), "--branding-skill-dir", str(BRANDING)],
        check=True,
        capture_output=True,
        text=True,
    )
    return output, json.loads(completed.stdout)


def comments_spec(width: float) -> dict:
    return {
        "title": "Electrical SD comments",
        "sheets": [{
            "sheet": "Comments",
            "columns": [
                {"key": "ref", "label": "Ref", "width": 8},
                {"key": "comment", "label": "Comment", "width": width},
                {"key": "qty", "label": "Qty", "format": "#,##0"},
            ],
            "rows": [
                {"ref": "E-01", "comment": LONG_COMMENT, "qty": 3},
                {"ref": "E-02", "comment": "Noted.", "qty": 1},
                {"ref": "E-03", "comment": "Line one\nLine two\nLine three", "qty": 2},
            ],
        }],
    }


class WrappedRowGeometryTest(unittest.TestCase):
    def test_requested_width_is_kept_and_rows_fit_their_text(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output, receipt = generate(Path(temporary), comments_spec(65))
            self.assertTrue(receipt["ok"])
            self.assertNotIn("warnings", receipt)
            sheet = load_workbook(output)["Comments"]
            self.assertEqual(sheet.column_dimensions["B"].width, 65)
            # The source text is stored unchanged.
            self.assertEqual(sheet["B4"].value, LONG_COMMENT)
            # 311 characters at width 65 need several lines; a fixed 19.5 points clipped them.
            self.assertGreaterEqual(sheet.row_dimensions[4].height, 6 * 12)
            # Short and numeric rows keep the compact default.
            self.assertEqual(sheet.row_dimensions[5].height, 19.5)
            self.assertGreaterEqual(sheet.row_dimensions[6].height, 3 * 12)

    def test_out_of_range_width_is_reported_instead_of_silently_clamped(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output, receipt = generate(Path(temporary), comments_spec(150))
            self.assertEqual(load_workbook(output)["Comments"].column_dimensions["B"].width, 100)
            self.assertEqual(len(receipt["warnings"]), 1)
            self.assertIn("'Comment' width 150 was set to 100", receipt["warnings"][0])


if __name__ == "__main__":
    unittest.main()
