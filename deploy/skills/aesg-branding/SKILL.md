---
name: aesg-branding
description: Apply AESG's approved brand, fonts, retained templates, and quality checks to PDF, DOCX, XLSX, and PPTX deliverables. Use for every AESG-branded artifact together with the matching format skill.
---

# AESG brand authority

Use this skill with exactly one format skill: `docx`, `pdf`, `xlsx`, or `pptx`.
The retained Office templates override generic design advice.

## Prepared Berry runtime

- Work from `/workspace`.
- Write working JSON, scripts, conversions, and previews under `/workspace/tmp`.
- Put only final deliverables in `/workspace/outputs`.
- This skill is at `/workspace/.berry/managed-skills/aesg-branding`.
- Templates are in `assets/templates`; scripts are in `scripts`.
- Verdana, Ubuntu, LibreOffice, Poppler, qpdf, Python packages, and Node
  packages are preinstalled. Do not run package installation or dependency
  discovery unless the first canonical command fails.
- Use the format skill's bundled generator before writing a one-off generator.

## Exact identity

Read `references/brand-system.md` before authoring. Core rules:

- Office documents: Verdana.
- External English marketing collateral: Ubuntu.
- Arabic marketing collateral: Tahoma.
- Primary Green `#008C95`, Gray `#343741`, and White `#FFFFFF`.
- Secondary Purple `#6D2077`, Red `#DA291C`, and Yellow `#FFC72C` together
  occupy no more than 15% of the design.
- Preserve the logo as a locked composition and at its native 3.467:1 ratio.
- Use British English and dates such as `01 January 2026`.
- Cite reproduced photographs, figures, charts, tables, and external claims.

## Template routing

| Output | Runtime template |
|---|---|
| Letter or A4 report DOCX | `assets/templates/AESG_Letterhead_Dubai.docx` |
| Office/report PDF | Generate DOCX from the letterhead, then convert it |
| XLSX | Generator reproduces the sanitized workbook's measured style system |
| Standard 16:9 PPTX | `assets/templates/AESG_Presentation_16x9.pptx` |

The source workbook in the original sample pack contains a hidden employee
sheet. It is prohibited. Only the sanitized one-sheet workbook in this skill
may be used as a reference. The large bid decks and bid document are design
evidence only: they contain live people, client, portfolio, and proposal
content and are deliberately not packaged in production.

## Fast completion gate

Run the format generator, then:

1. Run `python scripts/validate_artifact.py <final-file>`.
2. Render branded or layout-sensitive output with
   `python scripts/render_artifact.py <final-file> --output-dir <tmp-dir>`.
3. Inspect every rendered page/slide or every relevant sheet.
4. Confirm no Lorem Ipsum, sample names, template prompts, hidden employee
   data, or generator files remain.
5. Publish the final file once with `persist_artifact`, using the exact Office
   or PDF media type and a filename with the correct extension.

Never publish a helper `.py`, `.js`, source JSON, preview, or temporary DOCX.
