# AESG image generation

Use this workflow for new images, edits, composites, campaign visuals, social
assets, website heroes, email banners, office or site scenes, architecture,
project renders, and requests such as “create an image of AESG headquarters”.

## 1. Classify the output

- **Source image:** a photograph or visual ingredient. Apply AESG photography
  direction, but do not bake in a logo unless the user asks for one.
- **Final branded creative:** a publishable AESG composition. Apply the imagery
  direction and place one exact approved logo in the final file.
- **Factual location or project:** use user-supplied or authoritative visual
  references. Without them, produce a clearly conceptual interpretation and do
  not invent AESG signage, project names, or claims.

## 2. Load the references

Pass local paths through `create_image.reference_image_paths`. Supply them in
this order so their roles are unambiguous:

1. The user's target image, only when editing an existing image.
2. `assets/reference/AESG_Image_Generation_Photography_Reference.jpg`.
3. `assets/reference/AESG_Image_Generation_Identity_Reference.jpg`.
4. Exactly one logo:
   - default/light composition: `assets/logos/aesg-brandmark-rgb.png`;
   - green, gray, or dark composition: `assets/logos/aesg-brandmark-white-rgb.png`.

Always pass one logo, even when generating a source image. In that case, label
it as identity reference only and tell the model not to render it. Never pass
both logo variants to one generation.

## 3. Write a role-labelled prompt

State what every reference means. Include all applicable constraints:

- Reference 1, when present, is the image to edit and must retain the requested
  subject or structure.
- The photography board controls lighting, subject treatment, contrast, and
  colour character.
- The identity board controls palette balance, breathing space, and geometric
  restraint. It is reference material, not a collage to copy.
- The logo file is the exact identity reference. Do not redraw, imitate, alter,
  or render it into the generated pixels.
- Reserve a quiet placement zone for the selected logo: white or light for the
  full-colour logo, uniformly dark/green/gray for the white logo.
- Do not generate legible signage, labels, watermarks, UI, or decorative text.
- Keep architecture, PPE, human anatomy, reflections, and perspective credible.

For an unsourced headquarters request, use wording such as “conceptual AESG
regional headquarters visual” rather than asserting that the architecture is
the real building.

## 4. Place the exact logo

For final branded creative, do not accept an AI approximation of the mark.
Generate the scene and clean placement zone first, then alpha-composite the
selected PNG:

```bash
python <aesg-branding-skill-directory>/scripts/composite_logo.py \
  <generated-image> \
  <final-output.png> \
  --logo <aesg-branding-skill-directory>/assets/logos/aesg-brandmark-rgb.png \
  --position top-right \
  --width-percent 18
```

Use the white logo path instead when the reserved area is dark, green, or gray.
The script preserves the native aspect ratio and defaults to one rendered logo
height of clear space. It writes a new PNG and never overwrites the generated
source.

If the generated image accidentally contains a fake logo or text, regenerate
or remove that content before adding the exact PNG. Do not cover a fake mark
with the real one and leave remnants visible.

## 5. Inspect before publishing

View the final image at full size and confirm:

- the logo is the supplied PNG, not a generated facsimile;
- the chosen variant has strong contrast and no effects;
- the mark is not distorted, cropped, or too close to an edge;
- there is no invented signage, label, watermark, or factual claim;
- the image matches the selected AESG photography category;
- the output is described as conceptual when no real-site reference was used.

Publish only the final composited image for branded creative. For source-image
requests, publish the clean unbranded generation.
