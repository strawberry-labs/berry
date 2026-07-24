---
name: docx
description: Create, edit, inspect, or convert Word DOCX files. Use for every Word document request; activate aesg-branding for AESG output.
---

# DOCX

For AESG output, read `aesg-branding/references/brand-system.md` and use the
bundled generator first.

## Golden path

Create `/workspace/tmp/docx/spec.json`:

```json
{
  "kind": "report",
  "title": "Project Brief",
  "subtitle": "Executive summary",
  "date": "24 July 2026",
  "sections": [
    {
      "heading": "Executive summary",
      "paragraphs": ["Concise report text."],
      "bullets": ["First finding.", "Second finding."]
    },
    {
      "heading": "Key metrics",
      "table": {
        "headers": ["Metric", "Value"],
        "rows": [["Coverage", "94%"], ["Status", "On track"]]
      }
    }
  ]
}
```

Run:

```bash
mkdir -p /workspace/tmp/docx /workspace/outputs
python /workspace/.berry/managed-skills/docx/scripts/create_aesg_docx.py \
  --spec /workspace/tmp/docx/spec.json \
  --output /workspace/outputs/project-brief.docx
python /workspace/.berry/managed-skills/aesg-branding/scripts/validate_artifact.py \
  /workspace/outputs/project-brief.docx
python /workspace/.berry/managed-skills/aesg-branding/scripts/render_artifact.py \
  /workspace/outputs/project-brief.docx \
  --output-dir /workspace/tmp/docx/rendered
```

`kind` may be `report` or `letter`. For letters, the JSON may also contain
`recipient`, `reference`, `subject`, `salutation`, `closing`, `signatory`, and
`designation`.

The generator preserves the retained AESG template's sections, headers,
footers, page fields, media, and A4 geometry while replacing all sample body
content. Prefer it over a one-off script.

## Editing existing DOCX

Use `python-docx` for normal paragraph, run, list, and table work. For a
template, preserve its section properties, styles, headers, footers,
relationships, fields, and media. Never rebuild AESG letterhead from scratch.
Use OOXML only for features `python-docx` cannot preserve.

## Output contract

- Working files: `/workspace/tmp/docx`.
- Final `.docx` only: `/workspace/outputs`.
- Render every page for branded or layout-sensitive work.
- Publish once with media type
  `application/vnd.openxmlformats-officedocument.wordprocessingml.document`.
- Do not publish spec files, temporary PDFs, previews, or Python scripts.
