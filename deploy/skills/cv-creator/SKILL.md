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

## Runtime contract

- Work under `/workspace`.
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
metadata and no narrative description, ask for the missing narrative rather
than manufacturing one.

For attached PDF or DOCX CVs without a separate photo, recover the likely
embedded headshot before asking the user for another upload:

```bash
python <cv-creator-skill-directory>/scripts/extract_profile_photo.py \
  /workspace/inputs/<file-id>/candidate.docx \
  --output /workspace/tmp/cv-creator/candidate/profile-photo.jpg
```

If recovery fails or selects an unsuitable image, stop and ask for a headshot.

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
