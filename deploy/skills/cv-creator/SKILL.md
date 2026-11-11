---
name: cv-creator
description: Create AESG-branded CVs from user-supplied profile details, an existing CV or resume, or a folder of CV PDFs. Use when Berry must collect missing candidate data, extract it into the AESG V3 structured contract, recover or require a profile headshot, and generate the four standard portrait and landscape DOCX and PPTX deliverables.
---

# CV Creator

Use the retained AESG V3 templates and bundled pipeline. Generate four final
files for one candidate by default:

1. Portrait DOCX
2. Landscape DOCX
3. Portrait PPTX
4. Landscape PPTX

Generate fewer variants only when the user explicitly requests a subset. Do
not create QA PDFs, contact sheets, rendered previews, or other QA artifacts.

## Fast execution and stopping point

This package owns CV generation, template choice and validation. Its V3 assets
already carry AESG branding. Do not activate generic branding, DOCX, PPTX or PDF
skills merely to generate or validate these CVs; their generic QA workflows are
not part of this route. Follow an explicit user request for a separate layout
audit or additional output.

Read the source and input schema once, recover/verify the photo, write one
specification, run the bundled generator, then persist the requested files.
Trust the documented schema; do not browse renderer source to rediscover it.
Batch independent staging and reads instead of making each small check a
separate model turn.

Generation success plus non-empty structurally validated packages is the normal
completion point. Do not convert outputs to PDF, inspect template XML, measure
pixels, or tune margins during ordinary CV generation. The renderer's
`[estimated]` pagination label is informational, not an error to investigate.
Do not claim visual QA was performed.

On input validation failure, correct the named field once using source evidence,
or ask for missing facts. On missing staged resources, stage the full set below
and retry once. Do not repeat an unchanged failure. If a renderer defect is
discovered, preserve successful files, identify the affected variant as requiring
review, report the precise defect, and stop. Do not claim a known defective
variant is ready or enter a template-repair loop.

## Word layout contract

The bundled portrait and landscape DOCX templates own formatting. Experience
uses one measured Verdana tab stop with matching hanging indents. Project
narratives are left aligned, with 6pt above and 12pt below; no synthetic blank
lines. Titles and metadata stay with the narrative start, while long paragraphs
can flow onto the next page. Portrait projects begin wherever their heading
and opening lines fit, including beside a sidebar that continues onto page two;
the generator does not require the whole narrative to fit before starting it.
Later projects retain the full-width continuation. Landscape continuations use one flowing table,
without forced page breaks between project pairs. Generation uses one pass;
render probing is opt-in and runs at most once. Do not add empty paragraphs, justify project text,
or force whole descriptions to stay together. Keep source paragraph content.
Photo handling is unchanged. A missing Verdana error requires the AESG runtime
font dependency to be restored, not a substitute font or an AI formatting loop.

## Direct mappings and compact input

- If the user says "No expertise section", set `omit_key_expertise: true`
  and `key_expertise: []`. The pipeline suppresses the section in all four
  outputs, including inferred expertise and qualification fallback. Do not
  inspect or patch templates to do this.
- When the user explicitly authorises applying the source's shared
  responsibilities to selected projects, put the exact wording once in
  `shared_project_description`. Set `use_shared_description: true` on each
  applicable project. A project's explicit `description` takes precedence.
  Do not repeat the shared paragraph in every record or assign it to unrelated
  projects. Keep distinct project narratives where supplied.
- Preserve facts and wording. Omit optional duplicate audit content from the
  input specification: contacts and work-experience descriptions are not
  displayed by these templates. Include them when the user requests retention.
- Write JSON using the write tool's actual `path` and `content` fields.
  Do not wrap the call in `raw`. If a long call is rejected, use smaller
  structured writes to temporary JSON fragments and combine them locally;
  do not regenerate the same oversized call unchanged.
- After clarification, translate the answers into these fields and generate.
  A missing capability is a reason to report the limitation, not to explore
  renderer internals. Keep progress messages to phase changes and deliver
  file links with material warnings, without repeating the CV in chat.

## Stage the complete interactive runtime once

Initial activation exposes instructions; it does not necessarily stage imports
or templates. Before running a script, call `activate_skill` with
`name: "cv-creator"` and this complete `resources` array:

```json
[
  "scripts/cv_template_common.py",
  "scripts/extract_pdf_content.py",
  "scripts/extract_pdf_with_llm.py",
  "scripts/extract_profile_photo.py",
  "scripts/generate_cv_from_spec.py",
  "scripts/prepare_cv_input.py",
  "scripts/text_normalization.py",
  "scripts/v3/preprocess_cv_data_v3.py",
  "scripts/v3/render_docx_v3.py",
  "scripts/v3/word_layout.py",
  "scripts/v3/render_pptx_v3.py",
  "assets/templates/v3/aesg_cv_landscape_v3.docx",
  "assets/templates/v3/aesg_cv_landscape_v3.pptx",
  "assets/templates/v3/aesg_cv_portrait_v3.docx",
  "assets/templates/v3/aesg_cv_portrait_v3.pptx",
  "assets/templates/v3/aesg_logo_white.png",
  "references/input-schema.md"
]
```

Use the returned directory. These are paths to stage, not files to read into
context. Read only `references/input-schema.md`. For PDF batch migration,
also stage `scripts/v3/run_cv_pipeline_v3.py`.

## Runtime contract

- Use the workspace root supplied by the runtime (for example
  `/home/user/workspace`). Substitute it for `/workspace` in the examples below.
- Keep specifications, raw JSON, preprocessed JSON, extracted images, and
  generated intermediates under `/workspace/tmp/cv-creator`.
- Put only the four final requested DOCX and PPTX files in
  `/workspace/outputs`.
- Use the exact CV Creator skill directory returned by `activate_skill` in
  every shell command. Never guess a global skill path or reference a
  protected `/.berry` path.
- Run the bundled Python commands directly. Do not source or activate a virtual
  environment; the managed runtime already provides their dependencies.
- Do not install dependencies, copy bundled generators, rebuild templates, or
  write a replacement renderer.

## 1. Inventory the request

Read the prompt and attachments first. Reuse every fact already supplied and
never ask for it again. Determine whether the source is an existing CV/resume
or facts supplied in chat, and locate a separate JPG/PNG headshot or a suitable
image embedded in a supplied PDF or DOCX.

Default to all four outputs. Do not ask the user to choose format or
orientation unless their request is genuinely ambiguous about wanting fewer
files.

## 2. Ask once for missing data

Ask one compact, consolidated question containing only the missing fields.
Treat these as blockers:

- full name;
- current professional role/title;
- professional overview;
- work experience, or explicit confirmation that there is none;
- selected narrative projects, or explicit confirmation that there are none;
- a real profile headshot, either attached separately or recoverable from the
  source PDF or DOCX.

For each work-experience record ask for start date, end date, role,
organisation, and location. Description is optional because the current
template displays the compact role and organisation line.

For each selected project ask for name and a genuine narrative description.
Ask for duration, project role, client, and location when absent, while
allowing the user to answer `unknown` or `not stated`. Never infer a project
client or role.

Also ask whether the candidate has key expertise, qualifications, or
memberships when those sections are absent. Accept `none`. Education and
contacts do not block generation because the current templates do not display
them.

Require a clear, current JPG or PNG headshot of at least 240 x 240 pixels.
Never fabricate a person's likeness or substitute a logo or project image.

## 3. Structure the content

Read `references/input-schema.md`. Create one JSON specification under
`/workspace/tmp/cv-creator/<candidate>/cv-input.json`.

Preserve source wording. Repair only obvious PDF wrapping, whitespace, and
unambiguous date separators. Do not rewrite, shorten, polish, infer, or invent
CV content unless the user explicitly asks for editing. If a project has only
metadata, ask for a narrative or explicit permission to apply an existing
shared responsibilities block. Never manufacture a narrative.

For attached PDF or DOCX CVs without a separate photo, recover the likely
embedded headshot before asking the user for another upload:

```bash
python <cv-creator-skill-directory>/scripts/extract_profile_photo.py \
  /workspace/inputs/<file-id>/candidate.docx \
  --output /workspace/tmp/cv-creator/candidate/profile-photo.jpg \
  --candidates-dir /workspace/tmp/cv-creator/candidate/photo-candidates
```

The default selection is a size/texture heuristic, not face detection. A large
branded background can outrank a real headshot. Use the printed candidate paths
for one batched visual inspection, select the actual candidate portrait, and
pass that file to the generator. Do not inspect candidates one per model turn
or unpack the DOCX manually. If none is suitable, ask for a headshot. Dimensions
alone do not prove that an image is a portrait.

## 4. Generate the four files

Use this route for facts supplied in chat, attached CV text that Berry has
structured, or a corrected extraction:

```bash
python <cv-creator-skill-directory>/scripts/generate_cv_from_spec.py \
  --spec /workspace/tmp/cv-creator/candidate/cv-input.json \
  --photo /workspace/tmp/cv-creator/candidate/profile-photo.jpg \
  --batch-root /workspace/tmp/cv-creator/candidate/batch \
  --deliverables-dir /workspace/outputs
```

The defaults are `--formats docx,pptx --orientation both`, producing exactly
four files. Use `--formats` or `--orientation` only when the user explicitly
requests fewer variants.

The generator rejects missing core data, empty unconfirmed experience or
project lists, missing photos, and accidental output overwrites. It writes raw
and preprocessed data under the batch root and adds orientation suffixes to
final filenames.

The PPTX templates intentionally retain two approved visual variants for each
orientation in one deck. Do not remove one as a suspected duplicate unless the
user explicitly requests a single variant.

## 5. Run a PDF batch migration

Use the finalized batch runner only when the user supplies a folder of source
PDFs and the runtime has `CANOPYWAVE_API_KEY` configured:

```bash
python <cv-creator-skill-directory>/scripts/v3/run_cv_pipeline_v3.py \
  /workspace/inputs/<batch-file-id>/cvs \
  --batch-root /workspace/tmp/cv-creator/batch \
  --deliverables-dir /workspace/outputs \
  --workers 4 \
  --llm-timeout 300
```

This runs PDF extraction, raw JSON creation with embedded images, V3
preprocessing, both DOCX orientations, and both PPTX orientations. It does not
generate QA files. It preserves source subfolders in `/workspace/outputs` to
avoid filename collisions and refuses to overwrite existing deliverables. Do
not print, request, or store the API key in the workspace.

After the runner completes, inspect the structured values in
`extracted/cv_data.json` and `extracted/preprocessed_cv_data.json`. Confirm each
CV has a name, role, overview, experience, projects, and
`profile_photo.base64` before presenting or persisting the generated files.
Surface material `source_quality_flags` to the user.

If the key is unavailable, use the interactive structured-data route. Do not
install another client or send CV data to a different provider.

## 6. Deliver

Confirm the expected files exist and are non-empty. The bundled DOCX and PPTX
renderers perform structural package validation during generation.

Keep raw JSON, preprocessed JSON, extracted images, manifests, and all other
intermediate files under `/workspace/tmp`. Persist only the four final files,
once each, using the exact media type:

- DOCX: `application/vnd.openxmlformats-officedocument.wordprocessingml.document`
- PPTX: `application/vnd.openxmlformats-officedocument.presentationml.presentation`

Tell the user that the four deliverables are portrait DOCX, landscape DOCX,
portrait PPTX, and landscape PPTX, and surface any unresolved source-quality
warning.
