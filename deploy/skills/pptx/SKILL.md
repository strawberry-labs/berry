---
name: pptx
description: Create, edit, inspect, or convert PowerPoint PPTX presentations. Use for every slide-deck request; combine with aesg-branding for AESG proposals, briefings, reports, workshops, and other branded presentations.
---

# PPTX

For AESG output, clone approved specimen slides from the repaired and
sanitised General Template. Preserve its two masters, 59 layouts, inherited
artwork, and native `10.833 × 7.5 in` size.

Read `references/layout-catalog.md` before choosing layouts.

## Canonical workflow

Create `/workspace/tmp/pptx/spec.json`:

```json
{
  "title": "Project performance review",
  "slides": [
    {
      "layout": "cover",
      "title": "Project performance review",
      "subtitle": "Quarterly steering committee",
      "client": "Client organisation",
      "date": "06 August 2026"
    },
    {
      "layout": "divider",
      "title": "Performance overview"
    },
    {
      "layout": "two_columns",
      "section": "Performance overview",
      "title": "What changed this quarter",
      "columns": [
        {"title": "Progress", "bullets": ["Milestone one complete", "Coverage at 94%"]},
        {"title": "Action", "bullets": ["Close two open risks", "Confirm September owners"]}
      ]
    },
    {
      "layout": "text_image",
      "title": "Site observations",
      "body": "Use the visual to support one clear conclusion.",
      "image": "/workspace/tmp/pptx/site.jpg"
    },
    {"layout": "closing"}
  ]
}
```

Run:

```bash
mkdir -p /workspace/tmp/pptx /workspace/outputs
python /managed-skills/pptx/scripts/create_aesg_pptx.py \
  --spec /workspace/tmp/pptx/spec.json \
  --output /workspace/outputs/project-performance-review.pptx
python /managed-skills/aesg-branding/scripts/validate_artifact.py \
  /workspace/outputs/project-performance-review.pptx
python /managed-skills/aesg-branding/scripts/render_artifact.py \
  /workspace/outputs/project-performance-review.pptx \
  --output-dir /workspace/tmp/pptx/rendered
```

Image layouts require real image paths. The generator crops images to cover
their approved slots and rejects text beyond measured capacities. Split dense
content across slides rather than bypassing those checks.

Render and inspect every slide. Confirm titles, page numbers, image crops,
alignment, master artwork, and absence of placeholder text. Publish only the
final `.pptx` with media type
`application/vnd.openxmlformats-officedocument.presentationml.presentation`.
