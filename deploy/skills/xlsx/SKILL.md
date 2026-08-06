---
name: xlsx
description: Create, edit, inspect, calculate, or convert Excel XLSX workbooks. Use for every spreadsheet request; combine with aesg-branding for AESG registers, trackers, analyses, schedules, dashboards, and reporting workbooks.
---

# XLSX

For AESG output, generate a clean workbook from the measured AESG Excel system.
The original source workbook contained a hidden employee sheet; never clone or
restore it.

## Canonical workflow

Create `/workspace/tmp/xlsx/spec.json`:

```json
{
  "title": "Project controls register",
  "sheets": [
    {
      "sheet": "Register",
      "columns": [
        {"key": "item", "label": "Item", "width": 28},
        {"key": "owner", "label": "Owner", "width": 20},
        {"key": "status", "label": "Status", "validation": ["On track", "At risk", "Closed"]},
        {"key": "budget", "label": "Budget", "format": "#,##0"},
        {"key": "actual", "label": "Actual", "format": "#,##0"},
        {"key": "variance", "label": "Variance", "formula": "=D{row}-E{row}", "format": "#,##0"}
      ],
      "rows": [
        {"item": "Package A", "owner": "Team A", "status": "On track", "budget": 120000, "actual": 110000},
        {"item": "Package B", "owner": "Team B", "status": "At risk", "budget": 90000, "actual": 96000}
      ],
      "chart": {
        "type": "bar",
        "title": "Budget and actual",
        "category": "item",
        "values": ["budget", "actual"]
      }
    }
  ]
}
```

Run:

```bash
mkdir -p /workspace/tmp/xlsx /workspace/outputs
python /managed-skills/xlsx/scripts/create_aesg_xlsx.py \
  --spec /workspace/tmp/xlsx/spec.json \
  --output /workspace/outputs/project-controls-register.xlsx
python /managed-skills/aesg-branding/scripts/validate_artifact.py \
  /workspace/outputs/project-controls-register.xlsx
python /managed-skills/aesg-branding/scripts/render_artifact.py \
  /workspace/outputs/project-controls-register.xlsx \
  --output-dir /workspace/tmp/xlsx/rendered
```

Use typed numeric/date values and auditable formulas. Formula templates may
use `{row}`. Charts accept `bar`, `line`, or `pie`; `values` supports multiple
series. Add more entries to `sheets` for multi-sheet workbooks.

Inspect every rendered sheet. Confirm no hidden sheets, formula errors,
truncated labels, distorted charts, or unbounded print areas. Publish only the
final `.xlsx` with media type
`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`.
