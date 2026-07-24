---
name: pdf
description: Create, read, extract, merge, split, rotate, OCR, secure, or fill PDF files. Use whenever the user mentions a PDF, attaches a .pdf, or asks for a PDF deliverable.
---

# PDF workflow

For AESG output, activate `aesg-branding`, read
`aesg-branding/references/brand-system.md`, and use the retained Word
letterhead route below. Office/report PDFs inherit exact Verdana styles and
page furniture from the approved DOCX template.

## Workspace contract

- Work from `/workspace`.
- Put only finished PDF deliverables in `/workspace/outputs`, with descriptive names ending in `.pdf`.
- Put source Markdown, extracted images, and rendered previews in `/workspace/tmp/pdfs`.
- AESG reports do not need a helper script: use the bundled generator directly.
- After validation, call `persist_artifact` once so the exact artifact link is available before the final response. Pass a name ending in `.pdf` and `media_type: application/pdf`.
- Do not publish the same file twice. The runtime will skip its automatic copy after a successful manual publication.
- Never place helper `.py`, `.js`, or shell files in `/workspace/outputs`.

## AESG golden path

Use the same JSON schema as the `docx` skill:

Use `/managed-skills` for bundled scripts. Never use
`/workspace/.berry/managed-skills` in a command; `/.berry` is protected. If a
path is rejected, correct the prefix and rerun. Do not copy or rewrite the
generator.

```bash
mkdir -p /workspace/tmp/pdfs /workspace/outputs
python /managed-skills/pdf/scripts/create_aesg_pdf.py \
  --spec /workspace/tmp/pdfs/spec.json \
  --output /workspace/outputs/aesg-report.pdf
python /managed-skills/aesg-branding/scripts/validate_artifact.py \
  /workspace/outputs/aesg-report.pdf
python /managed-skills/aesg-branding/scripts/render_artifact.py \
  /workspace/outputs/aesg-report.pdf \
  --output-dir /workspace/tmp/pdfs/rendered
```

This generates the AESG DOCX under `/workspace/tmp/pdfs`, converts it with
LibreOffice, checks the PDF, and leaves only the final PDF in
`/workspace/outputs`. Publish once with `media_type: application/pdf`.

## Fast path for a non-AESG PDF

For one straightforward report, brief, summary, or letter:

1. Skip `todo_write` and dependency discovery.
2. Create `/workspace/tmp/pdfs` and `/workspace/outputs` in one command.
3. Use the installed ReportLab Platypus library. Keep a one-off generator under about 80 lines and save it under `/workspace/tmp/pdfs`.
4. Generate the final PDF directly into `/workspace/outputs`.
5. Run `pdfinfo` and `pdftotext` once. Confirm the file is valid, the page count is sensible, and expected headings and citations are present.
6. Render with `pdftoppm` only when layout is complex, visual fidelity matters, or the PDF is branded. Inspect every rendered page when an image-view tool is available.

Do not search for or install dependencies before the first attempt. The prepared runtime includes ReportLab, pypdf, pdfplumber, Poppler, qpdf, Pandoc, and LibreOffice. React only to an actual missing-tool error.

## Existing PDFs

- Use runtime-extracted text for ordinary reading, searching, and summarizing.
- Use `pdftotext -layout` or pdfplumber when text structure or tables matter.
- Render pages when the request depends on diagrams, positioning, handwriting, scans, or visual review.
- Run OCR only when extracted text is empty or clearly incomplete.
- Use pypdf for merge, split, rotate, metadata, encryption, and form operations. Preserve the source file unless the user asks to replace it.
- For forms, verify both field values and rendered appearances. Flatten only when the user explicitly requests a static result.

## Quality

- Default to A4 unless the source or user requires another page size.
- Use consistent type, margins, spacing, headings, page numbers, and readable link text.
- Keep source URLs human-readable and verify that every factual citation appears in the final PDF.
- Avoid clipped text, overlaps, black-box glyphs, blank pages, and rasterized body text.
- For AESG reports, use the bundled DOCX-to-PDF generator; direct ReportLab is
  only for true marketing collateral or an explicit direct-PDF request.
- In the final response, link the published PDF. Do not present helper files or internal workspace paths as deliverables.
