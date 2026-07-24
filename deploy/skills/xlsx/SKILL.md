---
name: xlsx
description: Create, edit, inspect, calculate, or convert Excel XLSX files. Use for every spreadsheet request; activate aesg-branding for AESG output.
---

# XLSX

For AESG output, read `aesg-branding/references/brand-system.md` and use the
bundled generator before writing custom workbook code.

## Golden path

Create `/workspace/tmp/xlsx/spec.json`:

```json
{
  "title": "Project Status Register",
  "sheet": "Status",
  "columns": [
    {"key": "project", "label": "Project", "width": 28},
    {"key": "status", "label": "Status", "width": 16},
    {"key": "progress", "label": "Progress", "width": 14, "format": "0%"},
    {"key": "budget", "label": "Budget (AED)", "width": 18, "format": "#,##0"}
  ],
  "rows": [
    {"project": "Example A", "status": "On track", "progress": 0.75, "budget": 250000},
    {"project": "Example B", "status": "At risk", "progress": 0.4, "budget": 180000}
  ],
  "chart": {"type": "bar", "category": "project", "value": "progress", "title": "Progress"}
}
```

Run:

```bash
mkdir -p /workspace/tmp/xlsx /workspace/outputs
python /workspace/.berry/managed-skills/xlsx/scripts/create_aesg_xlsx.py \
  --spec /workspace/tmp/xlsx/spec.json \
  --output /workspace/outputs/project-status.xlsx
python /workspace/.berry/managed-skills/aesg-branding/scripts/validate_artifact.py \
  /workspace/outputs/project-status.xlsx
python /workspace/.berry/managed-skills/aesg-branding/scripts/render_artifact.py \
  /workspace/outputs/project-status.xlsx \
  --output-dir /workspace/tmp/xlsx/rendered
```

Cells beginning with `=` are preserved as formulas. Use formulas for derived
values, explicit number formats, bounded ranges, data validation for editable
categories, and a useful print area. The final workbook must contain zero
formula errors.

Never use the original sample workbook: its hidden `Joiners` sheet contains
employee data. The generator reproduces the approved sanitized style without
copying that workbook's inflated used range or unused sample charts.

## Output contract

- Working files: `/workspace/tmp/xlsx`.
- Final `.xlsx` only: `/workspace/outputs`.
- Publish once with media type
  `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`.
- Do not publish CSV sources, previews, spec files, or generator scripts.
