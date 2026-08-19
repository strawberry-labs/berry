# AESG brand system

## Source priority

1. Explicit user instruction that does not alter or misuse the AESG mark.
2. Retained template for the requested Office format.
3. This operational reference, distilled from AESG Brand Guidelines, January
   2022.
4. `assets/brand-tokens.json` and the two visual reference boards.
5. Generic format guidance.

An attached or explicitly named template is the retained template for this
request and therefore outranks bundled AESG templates, personal memory, and
generic defaults. Preserve its structure and visual hierarchy. A separate
request for AESG formatting adds only compatible identity styling; it does not
authorise substituting the General Report or adding brand-specific pages that
are absent from the supplied template.

The original 60-page manual was text-extracted and visually inspected in full
during skill maintenance. It is intentionally not bundled at runtime. If a
rule is not captured here, do not invent it; consult the original source pack
while maintaining the skill or ask for AESG Marketing guidance. Never claim
that approval has been obtained unless the user confirms it.

## Brand idea

- Values: Agile, Dynamic, Passionate, Detail Orientated.
- Mission: To solve our client's greatest challenges, through collaboration,
  innovation and advanced technical solutions.
- Vision: To transform specialist consultancy, providing solutions for a more
  sustainable world.

Use these ideas as creative direction, not as filler copy that must appear in
every artifact.

## Where the guidelines apply

| Application | Apply visual system | Include logo | Special rule |
|---|---:|---:|---|
| Final client, marketing, campaign, social, web, email, or team communication | Yes | Normally yes | Use one approved PNG and the correct background variant |
| Generated source photograph or visual ingredient | Photography direction only | No, unless explicitly requested | Keep a clean area so it can become branded creative later |
| DOCX, PDF, PPTX, or XLSX | Yes | Yes | Start from the retained template or measured generator route |
| Physical stationery or production print | Yes | Yes | Use supplied production artwork; do not rebuild it from tokens |
| Partner or co-branded communication | Yes | Only an approved lockup | Do not invent a co-brand arrangement from the default AESG logo |
| Internal working draft | Yes where practical | Optional until final | Final delivery must pass the normal brand checks |

The manual says the identity belongs on AESG business, client, corporate
advertising, marketing, customer, and team communications. It does not mean a
logo must be baked into every raw source photograph.

## Logo choice and handling

| Background | Variant | File |
|---|---|---|
| White, light neutral, or quiet light image area | Full-colour, default | `assets/logos/aesg-brandmark-rgb.png` |
| AESG Green, AESG Gray, or uniformly dark image area | White | `assets/logos/aesg-brandmark-white-rgb.png` |
| Busy, low-contrast, or clashing image area | Neither until a quiet zone is created | Recompose the layout; do not modify the logo |

- Use one complete brandmark. Do not redraw, recreate, split, recolour,
  distort, rotate, crop, outline, shadow, glow, or add effects.
- Preserve its native `4283 × 1236` dimensions and 3.465:1 ratio when scaling.
- Maintain clear space equal to the height of the `A` in the AESG logotype on
  all sides. If that exact measure is unavailable, one rendered logo height is
  a conservative fallback.
- The manual gives a 10 mm minimum width for offset print reproduction. Digital
  work must also remain clearly legible at its actual display size.
- Ideal placement is on white. When the mark sits over a photograph, choose a
  quiet area with strong contrast rather than adding an unauthorised effect.
- For generated creative, pass one approved PNG as a reference and then place
  that exact file deterministically in the final image. A model-rendered logo
  is not an acceptable substitute.

## Colour and typography

| Role | Hex | Use |
|---|---|---|
| AESG Green | `#008C95` | Primary fields, headings, links, first chart series |
| AESG Gray | `#343741` | Body text, neutral fields, second chart series |
| White | `#FFFFFF` | Main background and reversed copy |
| Purple | `#6D2077` | Small secondary series or accent |
| Yellow | `#FFC72C` | Small secondary highlight |
| Red | `#DA291C` | Small secondary series, risk, or warning |
| Black | `#000000` | Use only where the retained design or reproduction requires it |

The manual's visual hierarchy is approximately 55% white space, 30% primary
colour, and 15% secondary colour in total. Treat those numbers as composition
guidance, not a need to fill every layout with colour. Preserve legacy colours
already embedded in retained template artwork.

- Office artifacts: Verdana Regular/Bold/Italic/Bold Italic.
- English external marketing: Ubuntu.
- Arabic external marketing: Tahoma.
- Never claim exact typographic fidelity after silently substituting fonts.

### Office typography contract

The generators must set role formatting on the generated text runs. They must
not rely on the font, colour, or size inherited from a specimen slot or a
converter fallback.

| Artifact | Role | Font | Size | Colour |
|---|---|---|---:|---|
| General Report DOCX/PDF | Body, bullets, numbered text, table text | Verdana | 10 pt | `#343741` |
| General Report DOCX/PDF | H1 / H2 / H3 | Verdana | 22 / 16 / 14 pt | `#059B9B` |
| Letterhead DOCX/PDF | Body, metadata, lists | Verdana | 9 pt | `#53565A` |
| Letterhead DOCX/PDF | Subject / optional heading | Verdana | 12 pt | `#53565A` / `#008C95` |
| AESG PPTX | Body text | Verdana | 9 pt | `#343741` |
| AESG PPTX | Title / section label | Verdana | 21 / 8.5 pt | `#343741` / `#008C95` |
| AESG PPTX | Divider text | Verdana | 22 pt | `#FFFFFF` |

Report body paragraphs use 1.15 line spacing with 6 pt before and after. The
first content section uses a 1080 DXA (54 pt) top margin so page one and every
following page begin at the same distance below the retained header. The
letterhead geometry remains the retained measured geometry above.

## Photography and generated imagery

| Subject | Direction |
|---|---|
| Headshots | Office setting with greenery or nature; natural light; soft out-of-focus background; vibrant but not overexposed or oversaturated |
| Office or site | People working or in action; a clear main subject; natural light; close or distant views; generous breathing space; vibrant but not oversaturated |
| Architecture or environment | Architecture, material, or texture; close or distant view; high contrast; colour or black and white; bright and saturated without clipping |
| Client or internal render | Architecture-led; high contrast; full colour; bright and saturated without clipping |

Do not use generic corporate handshakes, implausible safety practice, invented
signage, fake project labels, or synthetic text. An unsourced image described
as an AESG headquarters, office, or project must be presented as a conceptual
visual, not documentary evidence. Follow `references/image-generation.md` for
the tool and reference-image workflow.

## Editorial rules

- Use British English, `-ise` spellings, and dates such as `01 January 2026`.
- Keep body copy left aligned. Use real bullets and numbering.
- Add captions and source notes for reproduced visuals and data.
- Remove sample copy, personal author metadata, and off-canvas source content
  from final artifacts.

## Word/report system

- Use `AESG_Letterhead_Dubai.docx` for direct correspondence: letters, leave
  requests, short memos, confirmations, notices, and other recipient-led or
  signed communication. Do not add a report cover or approval page.
- Use `AESG_General_Report_Template.docx` for structured publications and
  formal project deliverables: reports, proposals, studies, policies,
  technical notes, project briefs, and documents that need a cover, document
  control, approval, sections, tables, or figures.
- Choose by purpose and structure, not page count. A short technical note can
  still be a report; a multi-page signed letter can use the letterhead's
  continuation pages.
- The letterhead is A4 portrait (`11900 × 16840` DXA) with margins of 2410 top,
  1268 right, 2127 bottom, and 1560 left DXA. Header and footer distances are
  708 and 878 DXA. Preserve `differentFirstPage`.
- Letterhead body text is Verdana 9 pt in `#53565A`. The subject is Verdana
  12 pt Bold in `#53565A`; optional section headings are Verdana 12 pt Bold in
  AESG Green. Recipient and reference blocks use 13.8 pt line spacing.
- Preserve the full first-page brandmark, Dubai office/address footer, and
  multicolour curves. Continuation pages use the circular AESG symbol, reduced
  curve footer, and native page-number field.
- The General Template is A4, with `11900 × 16840` DXA page geometry, 720 DXA
  left/right/bottom margins, a 1080 DXA content top margin, and 1134 DXA
  header/footer distances. Preserve the cover's native visual geometry; apply
  the content top margin to the report body section, not by inserting arbitrary
  blank paragraphs.
- Preserve its cover artwork, section relationship hierarchy, media, and AESG
  styles. Main headings are 22 pt, first subheadings 16 pt, and second
  subheadings 14 pt in the retained template.
- Clone the specimen-backed cover, approval table, and complete photographic
  divider component. Compose body content with the retained styles and fixed
  table geometry. Do not copy the 66 pages of Lorem Ipsum samples into output
  documents.

## PowerPoint system

- Use `AESG_General_Presentation.pptx` at its native `10.833 × 7.5 in` size.
- The repaired source contained 2 masters and 59 layouts. The runtime is a
  losslessly pruned package with the same 17 visible specimen slides, 1 master,
  and 17 reachable layouts. Do not restore unused layouts or their media.
- Build slides by cloning the approved specimen library and editing its native
  slide-local slots. Do not flatten the master, add generic title overlays, or
  rebuild the city imagery and page furniture.
- Use `pptx/references/layout-catalog.md` for supported semantic layouts, image
  requirements, and retained layout inventory. The organisation-chart specimen
  is reference-only because its labels are inherited and are not a safe
  generator route.
- Keep text within the generator's capacity checks. Split content rather than
  shrinking it into illegibility.

## Excel system

- The General Template transfer pack contains no Excel template. Keep the
  privacy-safe generated workbook route rather than inventing an Excel source
  from the Word or PowerPoint files.
- Use the sanitised one-sheet workbook only as style evidence. Never restore
  the original hidden employee/Joiners sheet.
- Place the approved full-colour logo at upper left.
- Use a Green title band, a Gray header row, white Verdana Bold labels, 19.5 pt
  body rows, hidden gridlines, restrained separators, and formula-driven
  calculations.
- Use chart series in this order: Green, Gray, Purple, Red, Yellow.
- Set a bounded print area and use landscape orientation for tables wider than
  six columns.
