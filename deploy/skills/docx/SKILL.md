---
name: docx
description: Create, edit, inspect, or convert Word DOCX files. Use for every Word-document request and combine with aesg-branding for AESG output. Route direct, recipient-led, or signed correspondence such as letters, leave requests, short memos, confirmations, and notices to the AESG Letterhead, and route reports, proposals, studies, policies, technical notes, project briefs, and other structured publications to the AESG General Report template only when the user has not supplied or named another template. Choose by purpose and structure, not page count alone.
---

# DOCX

For AESG output, activate `aesg-branding`, read
`<aesg-branding-skill-directory>/references/brand-system.md`, and use the bundled
generators from their activated skill directories. This routes reports through
the General Template and letters through the retained letterhead.

If the user supplies or explicitly names a DOCX template, use that exact file
as the structural and visual authority and pass it to the generator with
`--template` when supported. The bundled AESG General Report and Letterhead are
fallbacks only when no user template is supplied. If the user supplies a PDF
template but requests an editable DOCX, inspect that exact PDF and reconstruct
its structure in the DOCX; do not substitute the bundled General Report.

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

The report route uses an explicit typography contract: Verdana 10 pt in
`#343741` for body, bullet, numbered, table, and callout text; Verdana 22/16/14
pt in `#059B9B` for H1/H2/H3; 1.15 line spacing; and 6 pt paragraph spacing
before and after. The generated body section uses a 1080 DXA top margin on
every page. Do not depend on a retained specimen run to supply any of those
values.

## Repairing an existing generated report

When an existing AESG report has been generated with a legacy template or
conflicting Word theme metadata, repair the delivered DOCX before asking the
user to review it:

```bash
python <docx-skill-directory>/scripts/repair_aesg_docx.py \
  --input /workspace/input/report.docx \
  --output /workspace/outputs/report-repaired.docx
python <aesg-branding-skill-directory>/scripts/validate_artifact.py \
  /workspace/outputs/report-repaired.docx
python <aesg-branding-skill-directory>/scripts/render_artifact.py \
  /workspace/outputs/report-repaired.docx \
  --output-dir /workspace/tmp/docx/repaired-rendered
```

The repair pass makes fonts and colours explicit in every report story,
removes conflicting theme font mappings and accidental automatic heading
numbering, restores the measured page/header/footer geometry, splits body
items that were joined with manual line breaks, removes source-system tokens,
and removes only empty or incomplete unmerged gap-table scaffolding. It preserves
source-authored findings and manual section labels, so content review remains
separate from layout repair. Inspect the rendered first page, a continuation
page, each table sequence, and the final page before publishing.

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
- Check the first content line on page 1 and on a continuation page. It must
  sit at the same measured distance below the retained header; do not fix this
  by adding leading blank paragraphs.
- Validation scans document stories, content controls, and text boxes, not
  only high-level paragraphs and tables.
- Publish only the final `.docx` with media type
  `application/vnd.openxmlformats-officedocument.wordprocessingml.document`.
