---
name: pdf
description: Create, inspect, validate, or convert PDF files. Use for every PDF request. For an AESG office PDF, combine with aesg-branding and docx, select Letterhead for direct, recipient-led, or signed correspondence, or General Report for a structured publication only when the user has not supplied or named another template, then convert the generated DOCX. Choose the source template by purpose and structure, not page count alone.
---

# PDF

For an AESG office PDF, activate `aesg-branding`, `docx`, and `pdf`, then
generate the matching AESG DOCX first and convert that copy. This preserves
the General Report Template or retained letterhead, including the native
cover, approval page, photographic section dividers, tables, and captions.
Use the DOCX `kind: "letter"` route, or one of its letterhead aliases, for
direct correspondence such as letters, leave requests, short memos,
confirmations, and notices. Use `kind: "report"` for structured publications
and formal project deliverables. The PDF must come from the selected generated
DOCX rather than a direct PDF recreation. Do not choose Letterhead merely
because the document is short.

When the user attaches or explicitly names a template, that exact template
outranks the bundled AESG templates. For a DOCX template, pass the file through
to the DOCX generator with `--template` when supported. For a PDF template,
read or render that exact PDF as the authoritative visual and structural
reference; if an editable DOCX is requested, reconstruct its structure and
apply AESG styling only where compatible. Do not add the General Report cover,
approval page, or photographic dividers unless they are present in the supplied
template or explicitly requested.

## Canonical workflow

Create `/workspace/tmp/pdfs/spec.json` using the DOCX skill schema, then run:

```bash
mkdir -p /workspace/tmp/pdfs /workspace/outputs
python <pdf-skill-directory>/scripts/create_aesg_pdf.py \
  --spec /workspace/tmp/pdfs/spec.json \
  --docx-skill-dir <docx-skill-directory> \
  --branding-skill-dir <aesg-branding-skill-directory> \
  --output /workspace/outputs/environmental-monitoring-report.pdf
python <aesg-branding-skill-directory>/scripts/validate_artifact.py \
  /workspace/outputs/environmental-monitoring-report.pdf
python <aesg-branding-skill-directory>/scripts/render_artifact.py \
  /workspace/outputs/environmental-monitoring-report.pdf \
  --output-dir /workspace/tmp/pdfs/rendered
```

The generator keeps its temporary DOCX and LibreOffice profile under
`/workspace/tmp`. Do not publish either.

## Direct PDF work

Use direct PDF libraries only when the request is not an office document, such
as filling a form, extracting pages, adding annotations, or creating explicit
marketing collateral. Preserve existing forms, bookmarks, links, crop boxes,
and accessibility metadata when editing.

Validate with `qpdf --check` and `pdfinfo`, render every page, and inspect
fonts, pagination, tables, images, and link placement. Publish only the final
file with media type `application/pdf`.
