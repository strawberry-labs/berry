---
name: pptx
description: Create, edit, inspect, or convert PowerPoint PPTX presentations. Use for every slide-deck request; combine with aesg-branding for AESG proposals, briefings, reports, workshops, and other branded presentations.
---

# PPTX

For AESG output, clone approved specimen slides from the compact, repaired, and
sanitised General Template. Preserve its 17 specimen layouts, one retained
master, inherited artwork, and native `10.833 × 7.5 in` size. The larger
2-master/59-layout file is source evidence, not the runtime template.

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
      "section": "Performance overview",
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
python <pptx-skill-directory>/scripts/create_aesg_pptx.py \
  --spec /workspace/tmp/pptx/spec.json \
  --branding-skill-dir <aesg-branding-skill-directory> \
  --output /workspace/outputs/project-performance-review.pptx
python <aesg-branding-skill-directory>/scripts/validate_artifact.py \
  /workspace/outputs/project-performance-review.pptx
python <aesg-branding-skill-directory>/scripts/render_artifact.py \
  /workspace/outputs/project-performance-review.pptx \
  --output-dir /workspace/tmp/pptx/rendered
```

Image layouts require real image paths. The generator replaces native specimen
slots, crops images to cover, removes unused slots, and rejects text beyond
measured capacities. Some visual specimens are intentionally titleless; do not
add `title` or `section` to those routes. Split dense content across slides
rather than bypassing the checks or adding generic overlays.

Every generated text role is formatted explicitly after the slot is cloned:
Verdana 21 pt dark-grey titles, Verdana 8.5 pt AESG Green section labels,
Verdana 9 pt dark-grey body text, and Verdana 22 pt white divider text. Never
leave body size, colour, boldness, or font family to the specimen slot's
inheritance. This is required because the compact template contains legacy
specimen text in more than one font.

Render and inspect every slide. Confirm titles, page numbers, image crops,
alignment, master artwork, and absence of placeholder text or empty picture
slots. Publish only the final `.pptx` with media type
`application/vnd.openxmlformats-officedocument.presentationml.presentation`.
