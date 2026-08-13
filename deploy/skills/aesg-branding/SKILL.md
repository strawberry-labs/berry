---
name: aesg-branding
description: Apply AESG's approved identity, retained General Templates, logos, supergraphics, service icons, editorial rules, and quality checks to DOCX, PDF, PPTX, and XLSX deliverables. Use for every AESG-branded artifact together with all matching format skills.
---

# AESG brand authority

Use this skill with every required format skill: `docx`, `pdf`, `pptx`, or `xlsx`.
PDF creation also activates `docx` because the approved route is Word-to-PDF. Treat the
retained Office template as the design authority for that format.

## Runtime contract

- Work under `/workspace`; keep intermediates in `/workspace/tmp` and final
  deliverables in `/workspace/outputs`.
- Use the exact skill directory returned by `activate_skill`. Resolve every
  `scripts/`, `references/`, and `assets/` path against it. Never guess a
  global skill path or reference a protected `/.berry` path.
- Use the matching format generator before considering custom code. Extend its
  JSON specification when the existing fields can express the request.
- Do not install packages, copy generators, publish specs, or publish previews.

## Required brand rules

Read `references/brand-system.md` before authoring. Apply these rules:

- Use Verdana for Office artifacts, Ubuntu for English marketing material, and
  Tahoma for Arabic marketing material.
- Use AESG Green `#008C95`, Gray `#343741`, and White `#FFFFFF` as the core
  palette. Keep Purple, Red, and Yellow together below 15% of a layout.
- Preserve the approved logo composition and its native 3.465:1 ratio.
- Use British English and dates such as `01 January 2026`.
- Cite reproduced images, figures, tables, data, and external claims.

## Template routing

| Output | Required source |
|---|---|
| Report or long-form DOCX | `assets/templates/AESG_General_Report_Template.docx` |
| Letter DOCX | `assets/templates/AESG_Letterhead_Dubai.docx` |
| Office/report PDF | Generate the matching DOCX, then convert it with LibreOffice |
| Presentation | `assets/templates/AESG_General_Presentation.pptx` |
| Workbook | Generate from the measured AESG Excel system; use the sanitised workbook only as evidence |

The presentation retains two masters and 59 layouts at its native
`10.833 × 7.5 in` size. Use only the specimen-backed layouts exposed by the
PPTX generator. Do not route content through the unclassified second master.

## Asset library

- Canonical manual: `assets/reference/AESG_Brand_Guidelines_2022.pdf`.
- Full-colour and white logos: `assets/logos`.
- Primary and elemental RGB supergraphics: `assets/supergraphics`.
- Thirteen individual service icons plus the combined services sheet:
  `assets/icons/services`.

Do not use the SGW co-brand, CMYK print files, duplicate guideline copies, or
social-media guidance for ordinary Office artifacts.

## Completion gate

1. Run the matching format generator.
2. Run `python <aesg-branding-skill-directory>/scripts/validate_artifact.py <final-file>`.
3. Render with `python <aesg-branding-skill-directory>/scripts/render_artifact.py <final-file> --output-dir <tmp-dir>`.
4. Inspect every rendered page, slide, or relevant sheet and correct clipping,
   overlap, blank placeholders, weak pagination, or distorted images.
5. Publish only the final artifact, once, with the correct extension and MIME
   type.
