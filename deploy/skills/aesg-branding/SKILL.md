---
name: aesg-branding
description: Apply AESG's approved identity and select the correct AESG assets or template for generated images and DOCX, PDF, PPTX, or XLSX output. Use when creating, editing, reviewing, or converting an AESG-branded artifact; when AESG is the author or requested visual identity; or when a visual is meant to depict an AESG office, headquarters, person, project, building, or campaign. Pair with the matching format skill. For Word or office PDF output, use Letterhead for direct correspondence and General Report for structured publications. For generated images, use the bundled visual references and one approved PNG, then composite the exact logo only when the output is a finished branded communication.
---

# AESG brand authority

Read `references/brand-system.md` for every AESG task. For image creation or
editing, also read `references/image-generation.md`. Treat the retained Office
template as the design authority for its format. Treat `brand-system.md` and
`assets/brand-tokens.json`, distilled from the audited January 2022 manual, as
the runtime authority for identity, imagery, and cross-channel rules.

## Select the format and route

| Request | Required route |
|---|---|
| Generated or edited image, hero, campaign, social, web, or email visual | This skill plus `create_image`; follow `references/image-generation.md` |
| Direct correspondence: a letter, leave request, short memo, confirmation, notice, or other recipient-led or signed communication | This skill plus `docx`; use `kind: "letter"` and `assets/templates/AESG_Letterhead_Dubai.docx` |
| Structured publication: a report, proposal, study, policy, technical note, project brief, or document needing a cover, document control, approval, sections, tables, or figures | This skill plus `docx`; use `kind: "report"` and `assets/templates/AESG_General_Report_Template.docx` |
| Office PDF | First select the Letterhead or General Report route above, then use this skill plus `pdf` and `docx` to generate DOCX and convert it with LibreOffice |
| Presentation | This skill plus `pptx`; use `assets/templates/AESG_General_Presentation.pptx` |
| Workbook | This skill plus `xlsx`; use the measured AESG Excel system and sanitised workbook evidence |

Choose by purpose and structure, not page count alone. A short technical note
can still be a report. A longer signed letter can still use the letterhead and
its continuation pages. When signals are mixed, use Letterhead if the document
is fundamentally sender-to-recipient correspondence; use General Report if it
is a publication, record, or formal project deliverable.

Brand-guided source photography does not automatically need a baked-in logo.
A finished AESG communication normally does. Distinguish those two outputs
before generating anything.

## Runtime contract

- Work under `/workspace`; keep intermediates in `/workspace/tmp` and final
  deliverables in `/workspace/outputs`.
- Use the exact skill directory returned by `activate_skill`. Resolve every
  `scripts/`, `references/`, and `assets/` path against it. Never guess a
  global skill path or reference a protected `/.berry` path.
- Use the matching format generator before considering custom document code.
  Extend its JSON specification when the existing fields can express the
  request.
- Do not install packages, copy generators, publish specifications, or publish
  previews.

## Non-negotiable rules

- Use AESG Green `#008C95`, Gray `#343741`, and White `#FFFFFF` as the primary
  palette. Aim for 55% white space and keep all secondary colour together near
  15% or less.
- Use Verdana for Office artifacts, Ubuntu for English marketing material, and
  Tahoma for Arabic marketing material.
- Preserve the logo as one exact composition at its native 3.465:1 ratio. Do
  not redraw, recreate, separate, recolour, distort, rotate, crop, or add
  effects.
- Use the full-colour logo by default on white or a light, quiet background.
  Use the white logo on AESG Green, AESG Gray, or a uniformly dark image.
- Maintain clear space equal to at least the height of the `A` in the AESG
  logotype. When that measurement is unavailable, one rendered logo height is
  a safe conservative margin.
- Use British English and dates such as `01 January 2026`.
- Cite reproduced images, figures, tables, data, and external claims.
- Do not present generated architecture as a factual AESG office, project, or
  headquarters unless the user supplies an authoritative reference.

## Minimal runtime set

- Operational rules: `references/brand-system.md`.
- Machine-readable values: `assets/brand-tokens.json`.
- Image identity board: `assets/reference/AESG_Image_Generation_Identity_Reference.jpg`.
- Photography direction board: `assets/reference/AESG_Image_Generation_Photography_Reference.jpg`.
- Full-colour logo: `assets/logos/aesg-brandmark-rgb.png`.
- White logo: `assets/logos/aesg-brandmark-white-rgb.png`.

The audited 60-page source manual is maintenance evidence, not a runtime
dependency. Its edition, page count, and SHA-256 remain in
`assets/template-manifest.json`; consult the original source pack only when
maintaining or re-auditing this skill.

Use exactly one logo variant per composition. The Office templates already
embed their approved supergraphics and service artwork; do not reconstruct
those elements from loose files.

The presentation runtime retains the 17 approved specimen slides and their 17
layouts at the native `10.833 × 7.5 in` size. It intentionally prunes the
source-only second master and 42 unused layouts. Use only semantic routes
exposed by the PPTX generator; it edits native specimen slots and removes
unused placeholders.

## Completion gate

For images:

1. Generate with the required reference images and a clean logo placement zone.
2. If the final communication needs a logo, place the exact PNG with
   `scripts/composite_logo.py`; never rely on a generated approximation.
3. Inspect the final image at full size for logo integrity, contrast,
   clearspace, invented text, and visual artefacts.
4. Publish only the final image.

For Office artifacts:

1. Run the matching format generator.
2. Run `python <aesg-branding-skill-directory>/scripts/validate_artifact.py <final-file>`.
3. Render with `python <aesg-branding-skill-directory>/scripts/render_artifact.py <final-file> --output-dir <tmp-dir>`.
4. Inspect every rendered page, slide, or relevant sheet and correct clipping,
   overlap, blank placeholders, weak pagination, or distorted images.
5. Publish only the final artifact, once, with the correct extension and MIME
   type.
