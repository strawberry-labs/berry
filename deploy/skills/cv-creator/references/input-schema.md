# AESG CV input contract

Use this schema when converting chat content, an attached CV, or extracted text
into the structured input consumed by `scripts/generate_cv_from_spec.py`.

## JSON example

```json
{
  "source_filename": "Samira Khan - CV.pdf",
  "name": "Samira Khan",
  "role": "Senior Sustainability Consultant",
  "overview": "Source-faithful professional overview supplied by the user.",
  "work_experience": [
    {
      "start_date": "2022",
      "end_date": "Present",
      "role": "Senior Sustainability Consultant",
      "organisation": "Organisation name",
      "location": "Dubai, UAE",
      "description": "Optional source-faithful detail retained in raw data."
    }
  ],
  "key_expertise": [
    "Whole-life carbon assessment",
    "Green building certification frameworks"
  ],
  "qualifications": [
    "MSc Sustainable Design, University name, 2020"
  ],
  "memberships": [
    "LEED Accredited Professional"
  ],
  "selected_projects": [
    {
      "name": "Project name",
      "duration": "2023 - Present",
      "role": "Sustainability Lead",
      "client": "Client name",
      "location": "Riyadh, KSA",
      "description": "The complete project narrative supplied by the user.",
      "bullets": []
    }
  ],
  "confirm_no_work_experience": false,
  "confirm_no_selected_projects": false,
  "contacts": {
    "emails": [],
    "phones": [],
    "urls": []
  },
  "additional_sections": [],
  "source_quality_flags": [],
  "warnings": []
}
```

## Required information

- `name`: full display name.
- `role`: current or target professional title.
- `overview`: complete professional summary. Preserve the user's wording.
- `work_experience`: one or more records with a role, organisation, and at
  least one date endpoint. Set `confirm_no_work_experience` to `true` only
  after the user explicitly confirms there is none.
- `selected_projects`: one or more narrative projects. Each project needs a
  name and a real narrative description. Set `confirm_no_selected_projects`
  to `true` only after the user explicitly confirms there are none.
- Profile photo: pass separately with `--photo`. Use a real JPG or PNG
  headshot of at least 240 x 240 pixels. Never invent a person's likeness.

## Optional information

- `key_expertise`: use supplied wording. If empty, preprocessing may infer a
  compact set from the role, overview, qualifications, and projects.
- `qualifications` and `memberships`: use empty arrays when the user confirms
  there are none or does not want those sections.
- Project `duration`, `role`, `client`, and `location`: preserve them when
  explicitly stated. Never infer a client or project role.
- `contacts`: retained in raw JSON but not displayed by the current templates.
- `additional_sections`: retained for audit but not displayed by the standard
  templates.
- Education is not rendered by the current V3 templates. Do not block CV
  generation on education data.

## Extraction rules

1. Copy source wording; do not polish, compress, or embellish it without an
   explicit user request.
2. Normalize only whitespace and unambiguous date separators.
3. Keep `start_date` and `end_date` as separate endpoints. Normalize Current
   or Ongoing to Present only in date fields.
4. Put only narrative projects in `selected_projects`. Do not convert project
   tables or inventories into invented narratives.
5. Leave unsupported client, role, date, or location fields empty.
6. If a project lacks a narrative description, ask the user for it. Do not
   manufacture one.
7. Record source ambiguities in `warnings` or `source_quality_flags` and tell
   the user before publishing a client-facing CV.

## Renderer contract

The pipeline uses two data layers:

1. `cv_data.json`: loss-minimized raw sections, source facts, and the embedded
   profile photo.
2. `preprocessed_cv_data.json`: normalized V3 data consumed by both DOCX and
   PPTX renderers.

Only the profile photo is rendered. Other source-PDF images remain outside the
template-safe contract.
