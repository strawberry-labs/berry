# AESG artifact sandbox

This is the reproducible E2B image used by the AESG Berry deployment. It
contains the five managed skills under `deploy/skills`, retained sanitized
templates, deterministic generators, Office/PDF renderers, and exact licensed
Verdana files supplied at build time.

`build.ts` creates an ignored, minimal `.build-context` containing only those
skills, the dependency lock, and the four font files. The E2B uploader never
receives the wider `deploy` directory or any `.env` file.

## Licensed font handling

Verdana files are intentionally not committed. Before a production build,
place these files in `deploy/e2b-aesg/fonts/Verdana/`:

- `Verdana.ttf`
- `Verdana-Bold.ttf`
- `Verdana-Italic.ttf`
- `Verdana-BoldItalic.ttf`

Confirm the licence, then set `AESG_FONTS_CONFIRMED=1`. The build refuses to
run without both the confirmation and all four files.

## Build

From the repository root:

```bash
cd deploy/e2b-aesg
npm install
cd ../..
E2B_TEMPLATE_ALIAS=aesg-artifacts-2026-07-vN \
AESG_FONTS_CONFIRMED=1 \
./node_modules/.bin/tsx deploy/e2b-aesg/build.ts
```

When dependencies are installed only in this directory, use:

```bash
E2B_TEMPLATE_ALIAS=aesg-artifacts-2026-07-vN \
AESG_FONTS_CONFIRMED=1 \
deploy/e2b-aesg/node_modules/.bin/tsx deploy/e2b-aesg/build.ts
```

The alias must be a new version. Never overwrite the active production alias.
Run `smoke.ts` against the returned template ID before changing
`E2B_TEMPLATE`.
