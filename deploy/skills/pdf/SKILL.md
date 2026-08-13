---
name: pdf
description: Create, inspect, validate, or convert PDF files. Use for every PDF request; combine with aesg-branding for AESG reports, letters, briefs, policies, and other branded office PDFs.
---

# PDF

For an AESG office PDF, activate `aesg-branding`, `docx`, and `pdf`, then
generate the matching AESG DOCX first and convert that copy. This preserves
the new General Report Template or retained letterhead.

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
