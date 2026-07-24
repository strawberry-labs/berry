---
name: pdf
description: Create, read, extract, merge, split, rotate, OCR, secure, or fill PDF files. Use whenever the user mentions a PDF, attaches a .pdf, or asks for a PDF deliverable.
---

# PDF workflow

## Workspace contract

- Work from `/workspace`.
- Put only finished PDF deliverables in `/workspace/outputs`, with descriptive names ending in `.pdf`.
- Put generator scripts, source Markdown, extracted images, and rendered previews in `/workspace/tmp/pdfs`.
- After validation, call `persist_artifact` once so the exact artifact link is available before the final response. Pass a name ending in `.pdf` and `media_type: application/pdf`.
- Do not publish the same file twice. The runtime will skip its automatic copy after a successful manual publication.
- Never place helper `.py`, `.js`, or shell files in `/workspace/outputs`.

## Fast path for a new PDF

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
- For AESG-branded work, activate `aesg-branding` and follow its PDF and asset rules before generating.
- In the final response, link the published PDF. Do not present helper files or internal workspace paths as deliverables.
