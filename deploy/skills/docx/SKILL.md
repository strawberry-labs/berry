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
  "tableOfContents": true,
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
      "bullets": [
        "Finding one",
        {"text": "Finding two", "items": ["Supporting point", {"text": "Detail", "items": ["Evidence"]}]}
      ],
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
When source order matters, use an ordered `blocks` array instead of the legacy
grouped fields. `bullets`, `numbered`, and `items` accept strings or nested
objects `{"text": "...", "items": [...]}` up to three levels; bullets render as
`a.` → `i` → `•` and numbered items as `1.` → `a.` → `i.`, restarting for every
list block. Supported block types are `paragraph`, `label`,
`finding-header`, `bullets`, `numbered`, `callout`, `table`, `image`, and
`page-break`. For example:

```json
{
  "heading": "Immediate actions",
  "level": 2,
  "blocks": [
    {"type": "paragraph", "text": "The assessment identified three actions."},
    {"type": "label", "text": "Recommendations:"},
    {"type": "bullets", "items": ["Action one", "Action two", "Action three"]},
    {"type": "finding-header", "text": "Finding:"},
    {"type": "paragraph", "text": "Supporting evidence and analysis."}
  ]
}
```

Do not stream every non-heading source paragraph into `paragraphs`. Classify
source content before generation and preserve explicit list introductions,
list items, finding labels, tables, and paragraph boundaries in `blocks`.
Use real `bullets` or `numbered` blocks for list-shaped content; never imitate a
list with line breaks or consecutive body paragraphs, and never type `a.`,
`i`, `-`, or `•` markers into item text. Express sub-points as nested `items`. `Objective:` normally
introduces one prose statement, not a list. Treat `Recommendations:`,
`Examples:`, `Suggested priorities:`, and `The locking strategy should
include:` as list signals when meaningful items follow. Heading numbers are
automatic Word numbering: put only the title in `heading` and set `level`
1, 2, or 3. When the source heading starts with a sequence number such as
`4.`, `4.1`, or `4.1.1`, strip that number from `heading` and let the template
number it. Set `headingNumbered: false` only for headings that must not be in
the sequence, such as `Appendices`, `Appendix A`, `Glossary`, or when the user
explicitly requires the source numbers verbatim.

Keep report-specific editorial cleanup outside the generic skill. Remove
unambiguous placeholders and window-title fragments, but do not globally strip
people's names or infer section renumbering. Flag duplicate section labels,
ambiguous anchors, and uncertain editorial notes for review.

Validation fails when headings are typed as static numbered text instead of
Heading styles, Heading 1-3 lose their automatic numbering or spacing, a
report with headings has no TOC field, list items lack Word list numbering,
source-numbered headings still inherit template numbering, list-shaped blocks
remain flat body paragraphs, compliance tables retain empty scaffold rows, or
RAG values use inconsistent case. Fix the spec
or run the repair pass, then validate again before screenshot QA.

Use `pattern: "images"` for the supplied three-column evidence table (white
header with teal labels and alternating body rows) and `pattern: "monitoring"`
for the landscape monitoring table (teal header, grey banding, and dark grouped
edge columns). Monitoring tables may use `rowSpans` objects such as
`{ "column": 0, "start": 0, "span": 4 }` to merge group labels across rows.
Set a heading's `headingNumbered` field to `false` for unnumbered headings
such as `Appendices`.
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

The report route follows the supplied `General Template_AESG.docx` contract:
Verdana 10 pt in `#343741` for body, bullet, numbered, table, and callout text;
1.15 line spacing; and 3 pt body paragraph spacing after (0 pt before).
Headings are the built-in Word `Heading 1` / `Heading 2` / `Heading 3` styles:
Verdana 14 / 12 / 11 pt in `#008C95`, single spaced, 14/14, 12/12, and
11/11 pt before/after, numbered automatically as `4.` / `4.1` / `4.1.1` with
one 1.9 cm hanging indent at every level. The generator inserts a Word
`TOC \o "1-3" \h \z \u` field after the cover/approval pages (set
`"tableOfContents": false` to omit it, `"tocTitle"` to rename it), bookmarks
every heading, and fills the cached page numbers from a LibreOffice render;
no open-time "update fields" prompt is set. That pass needs `soffice` and
`pdftotext`; if it is skipped (`--no-toc-pages`) or fails, the generator
enables Word's open-time field update instead so the TOC is not left blank. Table captions are centred,
Verdana 9 pt in `#04999A`; figure captions are centred, Verdana 9 pt italic in
`#008C95`. The narrative portrait section uses the template's 1701 DXA top
margin; landscape monitoring pages use 720 DXA. Left, right, and bottom margins
are 720 DXA and header/footer distances are 1134 DXA. Preserve continuous page
numbering across section breaks. Do not depend on a retained specimen run to
supply any of those values.

For screenshot QA, load the approved Verdana faces before invoking LibreOffice.
On the AESG artifact image they are installed and refreshed with `fc-cache -f`;
on a local workstation set `FONTCONFIG_FILE` to a task-local fontconfig file
that includes the supplied Verdana directory. A screenshot or PDF containing
Linux Libertine, Liberation, DejaVu, or another fallback is a failed QA pass,
even when the DOCX XML declares `Verdana`.

The bundled report source is the supplied `General Template_AESG.docx` after
metadata-only Verdana sanitisation. It is a 66-page visual reference, not a
content library: clone only its cover/control parts, photographic divider, page
chrome, and table patterns. Do not copy its TOC fields, bookmark errors,
placeholder image frames, floating caption/image specimens, chart objects, or
sample text. Use inline images and fixed-width tables in generated content.

## Repairing an existing generated report

When an existing AESG report has been generated with a legacy template or
conflicting Word theme metadata, repair the delivered DOCX before asking the
user to review it:

```bash
python <docx-skill-directory>/scripts/repair_aesg_docx.py \
  --input /workspace/input/report.docx \
  --output /workspace/outputs/report-repaired.docx \
  --branding-skill-dir <aesg-branding-skill-directory>
python <aesg-branding-skill-directory>/scripts/validate_artifact.py \
  /workspace/outputs/report-repaired.docx
python <aesg-branding-skill-directory>/scripts/render_artifact.py \
  /workspace/outputs/report-repaired.docx \
  --output-dir /workspace/tmp/docx/repaired-rendered
```

The repair pass makes fonts and colours explicit in every report story,
removes conflicting theme font mappings, relinks headings to the automatic
`4.` / `4.1` / `4.1.1` numbering and lists to the multilevel definitions,
adds a Word TOC when the report has none, renumbers divider pages to match
their chapter, restores the measured page/header/footer geometry, splits body
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
- Never write a report with raw `python-docx` or OOXML in place of the
  generator: hand-built reports lose the heading numbering, multilevel lists,
  and TOC. If the generator cannot express something, extend the spec or ask.
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
