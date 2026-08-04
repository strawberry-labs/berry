# AESG artifact skills: build, modify, and deploy runbook

This is the handoff for rebuilding or changing AESG-branded PDF, DOCX, XLSX,
PPTX, and CV generation in Berry.

> **New-agent note:** Treat the committed files under `deploy/skills` and
> `deploy/e2b-aesg` as the current source of truth. The original AESG sample
> pack is evidence, not a directory to copy wholesale. Inspect privacy,
> package integrity, and template structure before importing any source file.
> Never expose `deploy/.env.production`, licensed fonts, employee data, or
> proposal content.

## 1. What the system contains

Berry uses six managed skills:

| Skill | Responsibility |
|---|---|
| `aesg-branding` | Brand authority, approved templates, assets, validation, and rendering |
| `docx` | Template-preserving Word generation |
| `pdf` | AESG Word-to-PDF generation and PDF operations |
| `xlsx` | Sanitized branded workbook generation |
| `pptx` | Template-preserving slide generation |
| `cv-creator` | AESG V3 portrait and landscape CV generation from structured data or source PDFs |

The committed implementation is:

```text
deploy/
├── skills/
│   ├── aesg-branding/
│   │   ├── SKILL.md
│   │   ├── references/brand-system.md
│   │   ├── scripts/
│   │   │   ├── validate_artifact.py
│   │   │   └── render_artifact.py
│   │   └── assets/
│   │       ├── brand-tokens.json
│   │       ├── template-manifest.json
│   │       ├── extracted/
│   │       └── templates/
│   ├── docx/
│   │   ├── SKILL.md
│   │   └── scripts/create_aesg_docx.py
│   ├── pdf/
│   │   ├── SKILL.md
│   │   └── scripts/create_aesg_pdf.py
│   ├── xlsx/
│   │   ├── SKILL.md
│   │   └── scripts/create_aesg_xlsx.py
│   ├── pptx/
│   │   ├── SKILL.md
│   │   └── scripts/create_aesg_pptx.py
│   └── cv-creator/
│       ├── SKILL.md
│       ├── references/input-schema.md
│       ├── assets/templates/v3/
│       └── scripts/
└── e2b-aesg/
    ├── template.ts
    ├── build.ts
    ├── smoke.ts
    ├── sync-skills.sh
    ├── requirements.lock
    └── package-lock.json
```

There are four layers to keep aligned:

1. Committed skill instructions, generators, references, and sanitized assets.
2. The versioned E2B image containing those files and all dependencies.
3. The six `organization_capabilities` records for the AESG tenant.
4. `BERRY_E2B_TEMPLATE_ID` in `deploy/.env.production`.

Updating only one layer can leave new tasks using stale instructions or code.

## 2. Non-negotiable contracts

### Privacy and licensing

- Do not package the original Excel workbook. Its hidden `Joiners` sheet
  contains employee data.
- Do not package the large bid DOCX or bid PPTX files. They contain live
  people, clients, projects, awards, and proposal material.
- The landscape bid deck also contains a corrupt ZIP member at
  `ppt/media/image5.jpeg`; do not use it as a runtime template.
- Commit only sanitized templates and approved extracted assets.
- Do not commit Verdana font files. They are licensed, ignored by Git, and
  supplied to the E2B build separately.
- Never upload the wider repository or `deploy/.env.production` to E2B.
  `build.ts` must continue to construct a minimal, audited build context.

### Sandbox paths

- Use `/managed-skills` in agent shell commands.
- Never place `/.berry` in a shell command. Berry treats it as a protected
  configuration path and rejects the command.
- Use `/workspace/tmp/<format>` for specifications, conversions, and previews.
- Put only final deliverables in `/workspace/outputs`.
- Do not copy a bundled generator or write a replacement after a path error.
  Correct the path to `/managed-skills` and rerun the canonical command.

### Artifact publication

Persist each final file once, with its correct extension and exact media type:

| Format | Media type |
|---|---|
| PDF | `application/pdf` |
| DOCX | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` |
| XLSX | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` |
| PPTX | `application/vnd.openxmlformats-officedocument.presentationml.presentation` |

Never persist specifications, Python scripts, temporary DOCX files, rendered
previews, or extracted images as deliverables.

### Production safety

- Production secrets live only in `deploy/.env.production`.
- Never commit, print, replace, or copy that file into a build context.
- Back it up before changing the template ID.
- Change only `BERRY_E2B_TEMPLATE_ID`.
- A template-only change requires recreating only the API service.
- Always use a new E2B alias. Never overwrite or reuse the active alias.
- Keep the previous template ID, Git commit, and database backup for rollback.

## 3. Rebuild the skills from scratch

Use this section when starting with only the AESG source pack.

### Step 1: establish inputs and examples

The source pack used for the current implementation was:

```text
/Users/chiragasarpota/Documents/aesg-skills/
└── AESG Sample Templates/
    ├── AESG_BrandGuidelines.pdf
    ├── AESG_ Letterhead_Dubai.docx
    ├── AESG Excel Template 2023.xlsx
    ├── Powerpoint Presentation Template.pptx
    └── aesg-files-sample/
```

Set a task-specific variable if the location changes:

```bash
AESG_SOURCE_DIR="/absolute/path/to/aesg-skills"
```

Define concrete acceptance prompts before writing the skills:

- “Create an AESG project-status PDF.”
- “Create an AESG-branded Word report.”
- “Create an AESG Excel register with formulas and a chart.”
- “Create an AESG 16:9 presentation.”

These examples determine what instructions, scripts, templates, and validators
must be reusable.

### Step 2: audit every source before importing it

For each PDF or OpenXML file:

1. Record its path, size, SHA-256 hash, and purpose.
2. Check package integrity with `unzip -t` for DOCX, XLSX, and PPTX.
3. Inspect document properties, embedded media, relationships, and visible
   text.
4. Inspect all Excel sheet names and visibility states.
5. Search Word and PowerPoint text for people, clients, projects, awards,
   commercial terms, and proposal content.
6. Classify the file as:
   - approved runtime template;
   - visual evidence only;
   - prohibited due to privacy;
   - rejected due to corruption.
7. Write the decision and hash into
   `deploy/skills/aesg-branding/assets/template-manifest.json`.

Do not infer that a hidden sheet or off-slide content is harmless. OpenXML
packages can retain content that is not visible in Office.

### Step 3: extract the measured brand system

Read the brand manual and retained templates together. Record:

- Office font: Verdana.
- Marketing font: Ubuntu.
- Arabic marketing font: Tahoma.
- Primary colours: Green `#008C95`, Gray `#343741`, White `#FFFFFF`.
- Secondary colours: Purple `#6D2077`, Red `#DA291C`,
  Yellow `#FFC72C`.
- Logo aspect ratio and clear-space rules.
- British English and AESG date conventions.
- Word page size, margins, headers, footers, and style sizes.
- Excel row heights, column treatment, number formats, and chart order.
- PowerPoint aspect ratio, master/layout count, recurring furniture, and text
  capacities.

Store machine-readable values in `assets/brand-tokens.json`. Store human and
editorial rules in `references/brand-system.md`. Do not duplicate long
explanations in every format skill.

### Step 4: choose retain-versus-rebuild per format

#### DOCX

Retain the approved letterhead DOCX. Modify a copy with `python-docx` while
preserving:

- sections and A4 geometry;
- first-page and continuation headers/footers;
- fields, relationships, media, and page furniture;
- approved styles.

Replace only sample body content. Do not redraw the letterhead.

#### PDF

For branded office reports:

1. Generate the AESG DOCX.
2. Convert it with headless LibreOffice.
3. Validate the resulting PDF.

This preserves the Word template more reliably than reconstructing the report
with ReportLab. Reserve direct ReportLab generation for non-AESG PDFs or
explicit marketing collateral.

#### XLSX

Do not clone the original workbook because of its hidden employee sheet.
Generate a new workbook with `openpyxl` using measured AESG styles:

- one or more intentionally visible sheets;
- bounded used ranges and print areas;
- Verdana;
- AESG title and header bands;
- formulas for derived values;
- explicit formats and validations;
- charts using the approved series order.

#### PPTX

Retain the standard 16:9 template. Use a clone-and-fill generator that copies
approved source slides and preserves the master/layout hierarchy,
relationships, artwork, and logo.

Map simple semantic layout names to known template slides. The current set is:

```text
title
statement
three_columns
process
four_cards
seven_points
comparison
star
table
image_text
two_columns
```

When the template changes, rediscover slide and shape IDs. Never assume the old
mapping still applies.

### Step 5: create the skill folders

Each skill needs a concise `SKILL.md` with only `name` and `description` in
frontmatter. Put deterministic code in `scripts/`, detailed brand rules in
`references/`, and output resources in `assets/`.

If the directories do not exist, initialize them with the system
`skill-creator` script rather than hand-building the folder skeleton:

```bash
SKILL_CREATOR_DIR="/Users/chiragasarpota/.codex/skills/.system/skill-creator"

python3 "$SKILL_CREATOR_DIR/scripts/init_skill.py" aesg-branding \
  --path deploy/skills \
  --resources scripts,references,assets

python3 "$SKILL_CREATOR_DIR/scripts/init_skill.py" docx \
  --path deploy/skills \
  --resources scripts

python3 "$SKILL_CREATOR_DIR/scripts/init_skill.py" pdf \
  --path deploy/skills \
  --resources scripts

python3 "$SKILL_CREATOR_DIR/scripts/init_skill.py" xlsx \
  --path deploy/skills \
  --resources scripts

python3 "$SKILL_CREATOR_DIR/scripts/init_skill.py" pptx \
  --path deploy/skills \
  --resources scripts
```

Replace all generated placeholders. If `agents/openai.yaml` is retained,
regenerate it after major changes so its display name, short description, and
default prompt still match the skill.

The format skills should contain:

1. A short JSON specification example.
2. One canonical generator command.
3. One validation command.
4. One render command.
5. A clear temporary/final output contract.
6. The exact publication media type.
7. A direct instruction not to install dependencies or rewrite the generator.

Use `/managed-skills` in every canonical command.

### Step 6: implement deterministic generators

Keep generator interfaces small:

```bash
python /managed-skills/docx/scripts/create_aesg_docx.py \
  --spec /workspace/tmp/docx/spec.json \
  --output /workspace/outputs/report.docx

python /managed-skills/pdf/scripts/create_aesg_pdf.py \
  --spec /workspace/tmp/pdfs/spec.json \
  --output /workspace/outputs/report.pdf

python /managed-skills/xlsx/scripts/create_aesg_xlsx.py \
  --spec /workspace/tmp/xlsx/spec.json \
  --output /workspace/outputs/register.xlsx

python /managed-skills/pptx/scripts/create_aesg_pptx.py \
  --spec /workspace/tmp/pptx/spec.json \
  --output /workspace/outputs/deck.pptx
```

Prefer extending the JSON schema over asking the agent to generate another
Python program. The script is the low-freedom, reliable path; the JSON is the
high-freedom content layer.

### Step 7: add shared validation and rendering

`validate_artifact.py` should reject:

- corrupt or empty files;
- invalid PDF signatures or MIME types;
- placeholder text;
- missing AESG font declarations;
- hidden or prohibited Excel sheets;
- formula error tokens;
- invalid PowerPoint packages.

`render_artifact.py` should render:

- every PDF and DOCX page;
- every PowerPoint slide;
- relevant Excel sheets.

Visual inspection remains necessary for clipping, overlap, poor pagination,
broken charts, tiny text, or misplaced template artwork.

### Step 8: create the E2B runtime

`deploy/e2b-aesg/template.ts` installs:

- LibreOffice Writer, Calc, and Impress;
- Poppler, qpdf, Ghostscript, and Tesseract;
- Python and the pinned packages in `requirements.lock`;
- Node.js;
- Noto, Ubuntu, and licensed Verdana fonts;
- the six skill directories.

Important runtime details:

- `/managed-skills` points to `/opt/aesg/skills`.
- `/workspace/output` points to `/workspace/outputs`.
- `python` and `python3` use launcher wrappers that execute the pinned virtual
  environment. A plain symlink can resolve back to system Python and lose the
  installed packages.
- Generate `package-lock.json` in Linux or ensure it contains Linux optional
  packages such as `@esbuild/linux-x64`. A macOS-only lock can fail on the
  production server.

`build.ts` must:

1. Require a new versioned alias.
2. Require explicit font-licence confirmation.
3. Require all four Verdana files.
4. Create an ignored `.build-context`.
5. Reject symlinks and `.env` files.
6. Allow only the expected top-level build roots.

### Step 9: validate before production

Unless the owner explicitly asks to skip validation, run:

```bash
SKILL_CREATOR_DIR="/Users/chiragasarpota/.codex/skills/.system/skill-creator"

for skill in \
  deploy/skills/aesg-branding \
  deploy/skills/docx \
  deploy/skills/pdf \
  deploy/skills/xlsx \
  deploy/skills/pptx
do
  python3 "$SKILL_CREATOR_DIR/scripts/quick_validate.py" "$skill"
done
```

Compile the Python scripts, generate all four formats, run the shared
validator, render each output, and visually inspect the results.

The E2B smoke test should launch a fresh sandbox and generate all four
artifacts. It must also confirm that `/workspace/outputs` contains only the
four final files.

## 4. Build and deploy to AESG production

The production host is `root@aesg-v2.berry.me`, and the checkout is
`/opt/berry`.

### Step 1: commit and push

```bash
git diff --check
git add deploy/skills deploy/e2b-aesg docs/aesg-artifact-skills-runbook.md
git commit -m "feat: update AESG artifact skills"
git push origin main
git rev-parse HEAD
```

Record the full commit SHA. Deploy that exact SHA:

```bash
ssh root@aesg-v2.berry.me \
  "/opt/berry/deploy/server-deploy.sh <full-commit-sha>"
```

Do not deploy an uncommitted local working tree.

### Step 2: supply the licensed fonts

On the production checkout, the ignored directory must contain:

```text
/opt/berry/deploy/e2b-aesg/fonts/Verdana/
├── Verdana.ttf
├── Verdana-Bold.ttf
├── Verdana-Italic.ttf
└── Verdana-BoldItalic.ttf
```

Confirm the licence before uploading. Do not add these files to Git.

### Step 3: audit the build payload

Prepare the build context without contacting E2B:

```bash
cd /opt/berry/deploy/e2b-aesg
E2B_TEMPLATE_ALIAS=aesg-artifacts-YYYY-MM-vN \
AESG_FONTS_CONFIRMED=1 \
AESG_PREPARE_ONLY=1 \
./node_modules/.bin/tsx build.ts
```

If the server does not have Node.js, use the repository-mounted
`node:20-bookworm-slim` container as shown in
`deploy/e2b-aesg/README.md`.

The output must contain only the expected skill, dependency, and font roots.
No environment file may appear.

### Step 4: build a new E2B image

Use a new alias:

```text
aesg-artifacts-YYYY-MM-vN
```

Read `E2B_API_KEY` from `deploy/.env.production` inside the server shell
without printing it. Pass only that variable into the disposable build
container. Run `build.ts` and record the returned immutable template ID.

Never pass the whole production environment into the container, and never put
the API key in command output, source code, or chat.

### Step 5: smoke the new image

Unless explicitly skipped:

```bash
E2B_TEMPLATE_ID=<new-template-id> \
./node_modules/.bin/tsx smoke.ts
```

Do not activate an image that cannot generate and validate all four formats
inside a fresh sandbox.

### Step 6: activate the template

Back up the production environment file:

```bash
env_path=/opt/berry/deploy/.env.production
backup_path="${env_path}.bak-aesg-skills-$(date -u +%Y%m%dT%H%M%SZ)"
cp -a "$env_path" "$backup_path"
```

Replace only:

```text
BERRY_E2B_TEMPLATE_ID=<new-template-id>
```

Recreate only the API:

```bash
cd /opt/berry
docker compose \
  --env-file deploy/.env.production \
  -f deploy/compose.yaml \
  up -d --no-deps --force-recreate api
```

### Step 7: sync the six organization skills

Run:

```bash
cd /opt/berry
sh deploy/e2b-aesg/sync-skills.sh
```

The script:

1. Dumps `organization_capabilities` to a timestamped backup.
2. Upserts all six skills for tenant
   `00000000-0000-7000-8000-000000000001`.
3. Sets them to `required`.
4. Prints the resulting SHA-256 hashes.

The database backup is written under:

```text
/opt/berry/backups/organization-skills/
```

### Step 8: production acceptance

Unless explicitly skipped, create one task per format and confirm:

- the final file opens;
- the extension and media type are correct;
- AESG branding is retained;
- no helper script or specification is persisted;
- the completed task shows `Worked for …`;
- the activity accordion opens and closes after completion.

For `cv-creator`, also confirm one representative profile produces the four
expected portrait/landscape DOCX/PPTX deliverables and publishes no extracted
JSON, photo, or other intermediate file.

## 5. Modify or tweak an existing implementation

Start by identifying the change type:

| Change | Files to inspect | Required deployment |
|---|---|---|
| Prompt/workflow wording | Format `SKILL.md` and `aesg-branding/SKILL.md` | Commit, new E2B image, template switch, skill sync |
| Brand rule or token | `brand-system.md`, `brand-tokens.json`, affected generators | Revalidate all affected formats, new image, skill sync |
| DOCX generation | `create_aesg_docx.py`, letterhead template | New image; PDF also needs review because it depends on DOCX |
| PDF generation | `create_aesg_pdf.py`, DOCX generator, LibreOffice runtime | New image |
| XLSX generation | `create_aesg_xlsx.py`, workbook style evidence | New image |
| PPTX layout | `create_aesg_pptx.py`, retained PPTX, shape/layout map | New image |
| Template or asset | `assets/templates`, `assets/extracted`, manifest hashes | Privacy audit, visual QA, new image |
| Python dependency | `requirements.lock`, `template.ts` | Full image rebuild |
| Node/E2B build dependency | `package.json`, Linux-generated lockfile | Full image rebuild |
| Artifact MIME/persistence | API/worker artifact code, not only the skill | Deploy the affected service |
| `Worked for …` or accordion UI | Web task/thread components, not the skill | Web build and web-service deployment |

### Safe modification workflow

1. Reproduce or inspect the exact failure.
2. Decide whether it belongs to instructions, generator code, template data,
   sandbox runtime, artifact persistence, or web UI.
3. Make the smallest change in the authoritative layer.
4. Update documentation and examples only when behaviour changed.
5. Update `template-manifest.json` whenever an asset changes.
6. Rebuild the E2B image whenever a sandbox file or dependency changes.
7. Sync organization skills whenever a `SKILL.md` changes.
8. Keep the previous commit, template ID, and database backup until the new
   version is accepted.

### Adding a new JSON feature

Prefer this sequence:

1. Add the field to the generator with a safe default.
2. Add one concise example to the relevant `SKILL.md`.
3. Add validation for malformed input where failure would be confusing.
4. Add a representative smoke specification.
5. Avoid adding a new helper script for a variation the existing generator can
   express.

### Replacing a template

1. Treat the new file as untrusted.
2. Audit visible and hidden content.
3. Check ZIP integrity and relationships.
4. Compare dimensions, styles, layouts, master count, and shape IDs.
5. Update generator mappings.
6. Remove all sample content that is not approved for runtime.
7. Recalculate SHA-256 hashes in the manifest.
8. Re-render representative outputs.

## 6. Failures already encountered

### Protected `/.berry` path

**Symptom:** Shell commands fail with:

```text
Shell command references protected credential/config path: /.berry
```

**Cause:** Skill examples used
`/workspace/.berry/managed-skills`.

**Fix:** Use `/managed-skills`. Do not copy or rewrite the bundled generator.

### Unnecessary helper scripts were persisted

**Cause:** The agent could not execute the canonical generator, wrote a
replacement, and automatic artifact discovery exposed it.

**Fix:** Keep helper files under `/workspace/tmp`, final files under
`/workspace/outputs`, use the bundled generator, and persist the final artifact
once.

### PDF displayed as `application/octet-stream`

**Cause:** Artifact persistence did not preserve or infer the final filename
and PDF media type correctly.

**Fix:** The platform persistence path must retain `.pdf`, sniff the actual
file when needed, and store `application/pdf`. The skill also requires the
exact media type when publishing.

This is not solved by changing PDF bytes alone.

### macOS lockfile failed on Linux

**Symptom:** `tsx` could not load the Linux esbuild binary on the production
server.

**Fix:** Regenerate or normalize `package-lock.json` in Linux and ensure
`@esbuild/linux-x64` is present.

### Python existed but could not import installed packages

**Cause:** A symlink to a virtualenv interpreter resolved back to system
Python.

**Fix:** Use launcher wrappers for `python` and `python3` that execute
`/opt/aesg/venv/bin/python`.

### “Worked for …” disappeared after completion

**Cause:** This was a web task/thread rendering issue, not a document skill
issue.

**Fix:** Preserve completed-run timing data and render it in the completed
accordion state. Deploy the web change separately from skill changes.

## 7. Rollback

Record before every activation:

- previous Git commit SHA;
- previous `BERRY_E2B_TEMPLATE_ID`;
- environment backup path;
- organization capability backup path.

To roll back:

1. Restore the previous template ID in `deploy/.env.production`.
2. Recreate only the API service.
3. Deploy the previous known-good Git commit with
   `deploy/server-deploy.sh`.
4. Run that commit’s `sync-skills.sh` to restore the previous skill content.
5. Keep the database dump as an additional recovery source.

Do not use destructive Git resets or overwrite the whole production
environment file.

## 8. Completion checklist

### Repository

- [ ] Six skills exist and pass skill validation.
- [ ] Canonical commands use `/managed-skills`.
- [ ] No source PII or proposal content is packaged.
- [ ] Verdana files remain untracked.
- [ ] Template hashes match the committed files.
- [ ] Python and Node dependencies are pinned.
- [ ] The working tree contains only intended changes.

### Artifacts

- [ ] DOCX retains approved letterhead and page furniture.
- [ ] PDF is a valid A4 PDF with embedded AESG fonts.
- [ ] XLSX has no hidden employee sheet or formula errors.
- [ ] PPTX retains the approved master/layout system.
- [ ] Rendered outputs have no clipping, overlap, or placeholder text.
- [ ] Only final deliverables are published.

### Production

- [ ] Exact commit deployed to `/opt/berry`.
- [ ] New immutable E2B template ID recorded.
- [ ] Environment file backed up.
- [ ] API recreated with the new template ID.
- [ ] Six organization skills synced with expected hashes.
- [ ] Previous template ID and backups retained for rollback.

## 9. Historical reference

The implementation was introduced through these commits:

```text
6670e60  feat: add AESG artifact skills and sandbox
0834882  chore: isolate AESG E2B build context
0b93245  fix: include Linux E2B build dependencies
1013625  test: generate all AESG artifact formats in sandbox smoke
047fefe  fix: expose pinned Python in AESG sandbox
16a1c9e  fix: preserve AESG sandbox virtualenv
4ffcd5d  fix: use safe AESG managed skill mount
```

At the time this runbook was written, the latest production image was:

```text
Alias:       aesg-artifacts-2026-07-v10
Template ID: fbsdxzzvfouhhshlqn5m
```

Treat that ID as historical evidence. Read the current
`BERRY_E2B_TEMPLATE_ID` from production before making or rolling back a later
deployment.
