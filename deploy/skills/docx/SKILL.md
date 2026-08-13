---
name: docx
description: Create, edit, inspect, or convert Word DOCX files. Use for every Word-document request; combine with aesg-branding for AESG reports, letters, briefs, policies, proposals, technical documents, and other branded Word output.
---

# DOCX

For AESG output, activate `aesg-branding`, read
`<aesg-branding-skill-directory>/references/brand-system.md`, and use the bundled
generators from their activated skill directories. This routes reports through the new General Template and letters
through the retained letterhead.

## Canonical workflow

Create `/workspace/tmp/docx/spec.json`:

```json
{
  "kind": "report",
  "title": "Environmental monitoring report",
  "project": "Project North",
  "client": "Client organisation",
  "date": "06 August 2026",
  "approvalPage": true,
  "documentControl": {
    "issue": "01",
    "revision": "00",
    "preparedBy": "AESG",
    "reviewedBy": "AESG",
    "approvedBy": "AESG"
  },
  "sections": [
    {
      "heading": "Executive summary",
      "divider": true,
      "paragraphs": ["Concise, evidence-based summary."],
      "bullets": ["Finding one", "Finding two"],
      "callout": "Overall status: on track"
    },
    {
      "heading": "Key metrics",
      "table": {
        "caption": "Table 1: Monitoring results",
        "headers": ["Metric", "Result"],
        "rows": [["Coverage", "94%"], ["Status", "On track"]]
      }
    }
  ]
}
```

Run:

```bash
mkdir -p /workspace/tmp/docx /workspace/outputs
python <docx-skill-directory>/scripts/create_aesg_docx.py \
  --spec /workspace/tmp/docx/spec.json \
  --branding-skill-dir <aesg-branding-skill-directory> \
  --output /workspace/outputs/environmental-monitoring-report.docx
python <aesg-branding-skill-directory>/scripts/validate_artifact.py \
  /workspace/outputs/environmental-monitoring-report.docx
python <aesg-branding-skill-directory>/scripts/render_artifact.py \
  /workspace/outputs/environmental-monitoring-report.docx \
  --output-dir /workspace/tmp/docx/rendered
```

Supported report blocks include paragraphs, bullets, numbering, callouts,
tables, images with captions/sources, page breaks, approval pages, and branded
section dividers. Image objects accept `path`, `caption`, `source`, and
`widthInches`.

For `kind: "letter"`, also use `recipient`, `reference`, `subject`,
`salutation`, `closing`, `signatory`, and `designation`. Do not use the report
cover for a letter.

## Editing and output

- Preserve existing sections, styles, fields, headers, footers, relationships,
  and media when editing an AESG DOCX.
- Use OOXML only for features `python-docx` cannot preserve.
- Inspect every rendered page. Correct orphan headings, broken tables,
  stretched images, and stray sample text.
- Publish only the final `.docx` with media type
  `application/vnd.openxmlformats-officedocument.wordprocessingml.document`.
