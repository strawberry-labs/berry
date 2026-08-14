---
name: docx
description: Create, edit, inspect, or convert Word DOCX files. Use for every Word-document request and combine with aesg-branding for AESG output. Route direct, recipient-led, or signed correspondence such as letters, leave requests, short memos, confirmations, and notices to the AESG Letterhead. Route reports, proposals, studies, policies, technical notes, project briefs, and other structured publications to the AESG General Report template. Choose by purpose and structure, not page count alone.
---

# DOCX

For AESG output, activate `aesg-branding`, read
`<aesg-branding-skill-directory>/references/brand-system.md`, and use the bundled
generators from their activated skill directories. This routes reports through
the General Template and letters through the retained letterhead.

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
        "widths": [2, 1],
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
`widthInches`. Table `widths` accepts one positive relative width per header.
The generator clones the native cover, approval table, and complete
photographic divider component; it clears unused approval placeholders and
keeps image captions after their figures.

Use `kind: "letter"` for direct correspondence: formal letters, leave
requests, short memos, confirmations, notices, and other recipient-led or
signed communication. The aliases
`letterhead`, `leave-request`, `memo`, and `simple-document` route to the same
retained letterhead. If `kind` is omitted but letter fields are present, the
generator selects the letterhead automatically.

```json
{
  "kind": "leave-request",
  "date": "14 August 2026",
  "recipient": ["People & Culture Manager", "AESG"],
  "reference": "LR-2026-001",
  "subject": "Annual leave request: 24-28 August 2026",
  "salutation": "Dear People & Culture Team,",
  "sections": [{"paragraphs": ["Request text and handover details."]}],
  "closing": "Kind regards,",
  "signatory": "Employee name",
  "designation": "Job title"
}
```

The letterhead route preserves its measured A4 margins, full first-page logo,
Dubai address footer, continuation-page symbol and page number, Verdana 9 pt
body text, and Verdana 12 pt Bold subject. Do not use the report cover or
approval page for these documents.

Use `kind: "report"` for structured publications and formal project
deliverables, including reports, proposals, studies, policies, technical
notes, and project briefs. Indicators include a cover, document control,
approval, multiple sections, tables, figures, or a publication-style reading
flow. Length is secondary: a short technical note may need the report route,
while a multi-page signed letter may use letterhead continuation pages.

## Editing and output

- Preserve existing sections, styles, fields, headers, footers, relationships,
  and media when editing an AESG DOCX.
- Use OOXML only for features `python-docx` cannot preserve.
- Inspect every rendered page. Correct orphan headings, broken tables,
  stretched images, and stray sample text.
- Validation scans document stories, content controls, and text boxes, not
  only high-level paragraphs and tables.
- Publish only the final `.docx` with media type
  `application/vnd.openxmlformats-officedocument.wordprocessingml.document`.
