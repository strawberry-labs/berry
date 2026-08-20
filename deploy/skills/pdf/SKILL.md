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

PDF typography is inherited from the generated DOCX, but conversion is a
separate quality gate. The current General Template contract is Verdana 10 pt
`#343741` body text, Verdana 22/16/14 pt `#008C95` H1/H2/H3, 3 pt body spacing
after, and a 1701 DXA portrait narrative top margin (720 DXA for landscape
monitoring pages). Table captions are 9 pt `#04999A`; figure captions are 9 pt
italic `#008C95`. Set `AESG_SOFFICE` to the approved LibreOffice binary when
the runtime has more than one office installation. The converter must produce
Verdana for AESG office text; a fallback such as Linux Libertine is a failure,
not an acceptable approximation. Run `pdffonts` as part of validation and
render every PDF page after conversion. Screenshot QA must load the approved
Verdana faces before rendering; the bundled converter creates a task-local
fontconfig cache automatically, while a manual LibreOffice/render command must
set `FONTCONFIG_FILE` to a config that includes the supplied Verdana directory.

## Direct PDF work

Use direct PDF libraries only when the request is not an office document, such
as filling a form, extracting pages, adding annotations, or creating explicit
marketing collateral. Preserve existing forms, bookmarks, links, crop boxes,
and accessibility metadata when editing.

## Runtime reading in Berry

When the durable runtime exposes the `read` tool, use it for PDF inspection.
Call `read` with the exact sandbox path supplied for the attachment; the
runtime invokes the safe PDF text extractor and preserves page markers. Use
`page_start` and `page_end` for targeted pages, and use `offset`/`limit` only
for line-level continuation inside an already selected page range.

If the attachment is a ZIP, call `read` on the ZIP path first. The runtime
safely extracts the archive and returns exact entry paths; call `read` on the
returned PDF path. Prefer the runtime reader for ordinary extraction because
its output is bounded and page-numbered. Use the shell utilities in this skill
as a fallback when `read` reports no extractable text, or when the user's
request depends on visual layout, diagrams, scanned pages, or a PDF
transformation.

Validate with `qpdf --check` and `pdfinfo`, render every page, and inspect
fonts, pagination, tables, images, and link placement. Publish only the final
file with media type `application/pdf`.
