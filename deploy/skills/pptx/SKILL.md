---
name: pptx
description: Create, edit, inspect, or convert PowerPoint PPTX presentations. Use for every deck or slide request; activate aesg-branding for AESG output.
---

# PPTX

For AESG output, read `aesg-branding/references/brand-system.md`. Use the
retained AESG 16:9 deck and the bundled clone-and-fill generator.

## Golden path

Use `/managed-skills` for bundled scripts. Never use
`/workspace/.berry/managed-skills` in a command; `/.berry` is protected. If a
path is rejected, correct the prefix and rerun. Do not copy or rewrite the
generator.

Create `/workspace/tmp/pptx/spec.json`:

```json
{
  "title": "Sustainability Update",
  "slides": [
    {"layout": "title", "title": "Sustainability Update"},
    {
      "layout": "statement",
      "title": "Executive summary",
      "body": "Three decisions define the next phase."
    },
    {
      "layout": "three_columns",
      "columns": [
        {"title": "Measure", "body": "Establish the baseline."},
        {"title": "Prioritise", "body": "Focus on material impact."},
        {"title": "Deliver", "body": "Track accountable actions."}
      ]
    },
    {
      "layout": "comparison",
      "left": {"title": "Current", "body": "Fragmented reporting."},
      "right": {"title": "Target", "body": "One governed view."}
    }
  ]
}
```

Run:

```bash
mkdir -p /workspace/tmp/pptx /workspace/outputs
python /managed-skills/pptx/scripts/create_aesg_pptx.py \
  --spec /workspace/tmp/pptx/spec.json \
  --output /workspace/outputs/sustainability-update.pptx
python /managed-skills/aesg-branding/scripts/validate_artifact.py \
  /workspace/outputs/sustainability-update.pptx
python /managed-skills/aesg-branding/scripts/render_artifact.py \
  /workspace/outputs/sustainability-update.pptx \
  --output-dir /workspace/tmp/pptx/rendered
```

Supported layout names are `title`, `statement`, `three_columns`, `process`,
`four_cards`, `seven_points`, `comparison`, `star`, `table`, `image_text`, and
`two_columns`. The generator duplicates source slides and retains the original
master/layout hierarchy, relationships, logo, and brand furniture.

Keep copy concise enough for the inherited slots. Choose another layout or
split content rather than shrinking text. Inspect every rendered slide and
check for leftover prompts.

The large AESG bid decks are not runtime templates: they include live people,
clients, projects, awards, and proposal content. Do not copy that content into
new presentations.

## Output contract

- Working files: `/workspace/tmp/pptx`.
- Final `.pptx` only: `/workspace/outputs`.
- Publish once with media type
  `application/vnd.openxmlformats-officedocument.presentationml.presentation`.
- Do not publish source decks, specs, previews, or Python scripts.
