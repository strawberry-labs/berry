# Plan 003: Build the member and administrator Apps web experience

> **Executor instructions**: Complete Plans 001 and 002 first. Follow every
> step and verification gate. Stop rather than guessing when a contract has
> drifted. Update the Plan 003 row in `plans/README.md` when complete unless a
> reviewer owns the index.
>
> **Drift check (run first)**:
> `git diff --stat 483c817..HEAD -- apps/web/src/lib/cloud-shell-state.ts apps/web/src/components/app-shell.tsx apps/web/src/components/shell/web-sidebar.tsx apps/web/src/components/apps apps/web/src/components/management/management-navigation.ts apps/web/src/components/management/admin-screens.tsx apps/web/src/routes packages/api-client/src/index.ts apps/web/src/styles.css`
>
> Then run `git status --short`. At planning time, these user-owned files were
> already modified and must not be overwritten:
> `apps/web/src/components/management/general-settings-screen.tsx`,
> `apps/web/src/components/prompt-editor.tsx`,
> `apps/web/src/components/prompt-editor.test.ts`,
> `apps/web/src/components/tasks/web-composer.tsx`,
> `apps/web/tests/web-shell.spec.ts`,
> `apps/web/src/lib/composer-submit-intent.ts`, and its test.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: `plans/002-apps-domain-api.md`
- **Category**: direction
- **Planned at**: commit `483c817`, 2026-07-23

## Why this matters

The Apps idea is valuable because it hides prompt engineering behind a
purpose-built interaction. If users still have to open chat, know the skill
name, attach files in the right order, and phrase instructions correctly, Apps
have not delivered that value.

This plan adds a compact catalog, manifest-driven run form, live result state,
history, and an administrator import/test/publish workflow while staying inside
Berry's existing shell and design system.

## Current state

- `apps/web/src/lib/cloud-shell-state.ts:1-29` parses top-level home, task,
  settings, library, admin, and platform locations. There is no Apps route
  kind.

- `apps/web/src/components/shell/web-sidebar.tsx:70-121` renders New chat,
  Search, Skills, and Library. Apps should be a first-class destination beside
  Skills and Library.

- `apps/web/src/components/app-shell.tsx:105-169` derives the route surface and
  later composes sidebar/main surfaces. `ArtifactLibrary` is the closest
  lazy-loaded non-chat surface to follow.

- `apps/web/src/routes/library.$tab.tsx` demonstrates the thin route-file
  pattern: route modules exist for the router while `AppShell` owns the main
  surface.

- `apps/web/src/components/library/artifact-library.tsx` demonstrates file
  cards, download actions, loading/error/empty states, and the existing API
  client/session context.

- `apps/web/src/components/management/admin-catalog-screens.tsx:255-265`
  currently imports a skill package but sends only `SKILL.md` content and file
  names. The Apps importer must retain every package file's bytes and send the
  Plan 002 package payload.

- `apps/web/src/lib/skill-import.ts:13-40` validates a `.skill` archive and
  returns `SKILL.md` plus names, not resource bytes. It may be extended with a
  reusable bounded package reader, but existing skill-import behavior must not
  regress.

- `AGENTS.md` requires:
  - all surfaces/text/borders/accents use existing `--berry-*` variables;
  - compact sizing: 14px body, 12px secondary, 11px metadata;
  - clear focus states;
  - interruptible motion and reduced-motion support.

- Use existing components from `@berry/desktop-ui`; do not introduce another
  component library or hard-coded theme colors.

## UX contract

### Member surfaces

1. `/apps`
   - searchable catalog;
   - optional category chips/filter;
   - compact app cards with icon, name, description, and category;
   - authorized published apps only;
   - loading skeleton, empty state, and retryable error.
2. `/apps/:appId`
   - app header and manifest-generated form;
   - one primary `Run app` action;
   - recent runs for this app;
   - field validation before submit.
3. `/apps/:appId/runs/:runId`
   - status/progress;
   - approval deep link into the underlying task when needed;
   - final message;
   - output file cards/downloads;
   - safe failure message with `Open task` for diagnostic context.

After submit, navigate to the run URL immediately. Live progress should use the
existing task/session stream when easy to compose; poll run detail with bounded
backoff as the reliable fallback. Stop polling on terminal status and when the
component unmounts.

### Administrator surfaces

Add an Apps administration section that supports:

- list with draft/published/archived status and current version;
- import `.skill`;
- review normalized manifest, `SKILL.md` metadata, requested tools, network
  mode, output contract, resource paths/sizes/hashes, and validation warnings;
- save/update draft;
- test draft using the same form renderer;
- publish with a confirmation that the version becomes immutable;
- create a new draft version from the current version;
- archive an app.

Do not build a visual workflow canvas. The package is the source of executable
truth; the admin UI is review, test, and lifecycle management.

### Form behavior

- `text`: single-line input with remaining-length feedback near its limit.
- `textarea`: compact multiline input.
- `file`: use Berry's existing file upload flow, then submit the resulting
  file ID; show name, MIME, size, replace/remove.
- `select`: native or existing select component; values come only from the
  manifest.
- `boolean`: checkbox/switch with accessible label.
- Required/error/help text must be connected with accessible IDs.
- Disable submit during validation/upload/request, and prevent duplicate
  submits.
- Never render manifest labels/descriptions as HTML.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Web tests | `pnpm --filter @berry/web test` | exit 0 |
| API client tests | `pnpm --filter @berry/api-client test` | exit 0 |
| Web typecheck | `pnpm --filter @berry/web... typecheck` | exit 0 |
| Web build | `pnpm --filter @berry/web... build` | exit 0 |
| Focused E2E | `pnpm --dir apps/web exec playwright test tests/apps.spec.ts` | exit 0 |

## Scope

**In scope**:

- `apps/web/src/lib/cloud-shell-state.ts` and its tests
- `apps/web/src/lib/skill-import.ts` and its tests, only to add a reusable
  byte-preserving bounded package reader
- `apps/web/src/components/app-shell.tsx`
- `apps/web/src/components/shell/web-sidebar.tsx`
- `apps/web/src/components/apps/app-catalog.tsx` (create)
- `apps/web/src/components/apps/app-detail.tsx` (create)
- `apps/web/src/components/apps/app-run-form.tsx` (create)
- `apps/web/src/components/apps/app-run-result.tsx` (create)
- `apps/web/src/components/apps/app-run-history.tsx` (create)
- `apps/web/src/components/apps/apps-admin-screen.tsx` (create)
- `apps/web/src/components/apps/app-package-review.tsx` (create)
- Colocated component/helper tests (create)
- `apps/web/src/components/management/management-navigation.ts`
- `apps/web/src/components/management/admin-screens.tsx`
- New route files:
  - `apps/web/src/routes/apps.index.tsx`
  - `apps/web/src/routes/apps.$appId.tsx`
  - `apps/web/src/routes/apps.$appId.runs.$runId.tsx`
- `apps/web/src/styles.css`
- `apps/web/tests/apps.spec.ts` (create; do not modify dirty
  `web-shell.spec.ts`)
- `packages/api-client/src/index.ts` only for small corrections proven by web
  integration; Plan 002 should already own its main changes
- `plans/README.md` (update only the Plan 003 status row)

**Out of scope**:

- Existing prompt editor, composer, and dirty `web-shell.spec.ts` changes.
- Editing executable scripts/resources in the browser.
- A WYSIWYG prompt editor or visual workflow builder.
- Marketplace, ratings, public sharing, schedules, batch runs, or custom app
  theming.
- New hard-coded colors or a new UI framework.
- Desktop/mobile/extension navigation.

## Git workflow

- Branch: `codex/003-apps-web-experience`
- Suggested commits:
  `feat(web): add apps catalog and run flow` and
  `feat(admin): add app package lifecycle`.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Extend route parsing and shell navigation

Add typed route states for:

- Apps catalog;
- app detail;
- app run detail.

Create the three thin router files and teach `AppShell` to select the
corresponding surface. Add an Apps sidebar item with an existing icon and
correct active-state behavior. Preserve chat/task navigation and responsive
sidebar behavior.

Add route-parser tests for valid IDs, trailing slashes/query strings, and
unknown paths.

**Verify**:
`pnpm --filter @berry/web test -- cloud-shell-state web-sidebar` → exit 0;
route and active-state cases pass.

### Step 2: Build the catalog

Implement `AppCatalog` with:

- API-backed cursor/search/category state;
- debounced search using existing web patterns;
- accessible app-card links;
- no unsafe HTML rendering;
- loading, empty, failure/retry, and pagination states;
- cancellation or stale-response protection when filters change.

Use 14/12/11px type roles and existing Berry variables. App icon keys map to a
closed local icon registry; unknown keys use a safe fallback.

**Verify**:
`pnpm --filter @berry/web test -- app-catalog` → exit 0; loading, success,
empty, retry, filtering, stale response, and safe icon fallback cases pass.

### Step 3: Build a schema-driven form with exhaustive controls

Create `AppRunForm` as a discriminated-union renderer over the shared manifest
schema. Keep field components small and exhaustively switch on the input
`type`; a future unhandled type should fail TypeScript.

Integrate the existing upload API for file fields. Validate required,
max-length, select membership, MIME, and size in the browser for fast feedback,
while treating server validation as authoritative. Submit only normalized
values/file IDs.

Test keyboard labels, error associations, duplicate-submit prevention, upload
replacement/removal, server validation mapping, and unmount cancellation.

**Verify**:
`pnpm --filter @berry/web test -- app-run-form` → exit 0; every input type and
validation/submission edge case passes.

### Step 4: Build app detail and immediate run navigation

Compose header, form, and recent history in `AppDetail`. On successful
`POST /v1/apps/:id/runs`, immediately navigate to the returned run URL. Keep
the underlying task/session IDs in the response; do not create a second chat
turn from the browser.

If an app becomes unpublished between load and submit, show the API's safe
not-found/unavailable state and return to the catalog without losing uploaded
file ownership semantics.

**Verify**:
`pnpm --filter @berry/web test -- app-detail app-run-history` → exit 0; run
creation, redirect, recent history, and unpublished conflict cases pass.

### Step 5: Build result, approval, and failure states

Implement `AppRunResult`:

- poll the run endpoint with bounded backoff or subscribe via existing session
  events plus polling fallback;
- display queued/running/waiting/completed/failed/cancelled distinctly;
- for `waiting-for-approval`, link to the normal task where Berry's existing
  approval UI operates;
- render the final assistant message through Berry's existing safe message
  renderer where practical;
- render output files through existing artifact/file-card patterns and
  permission-checked download URLs;
- provide `Run again` and `Open task` actions;
- stop timers/listeners on terminal state and unmount;
- respect `prefers-reduced-motion`.

Do not build a second approval decision UI in the Apps surface for MVP.

**Verify**:
`pnpm --filter @berry/web test -- app-run-result` → exit 0; progress,
approval, message/files, failure, cancellation, timer cleanup, and retry cases
pass.

### Step 6: Preserve all package bytes in the browser importer

Extend `skill-import.ts` with a reusable reader that returns every regular file
as `{ path, mediaType, dataBase64 }` while enforcing client-side count and size
limits. This is convenience and early feedback only; Plan 002's server
validation remains authoritative.

Keep the current skill importer public return shape or adapt its caller without
silently changing organization-skill behavior. Apps must send the complete
package payload so `scripts/`, `references/`, and `assets/` are not discarded.

Test required root files, nested resources, binary bytes, path rejection,
count/size bounds, and abort/error handling.

**Verify**:
`pnpm --filter @berry/web test -- skill-import` → exit 0; package resources
round-trip byte-for-byte in tests.

### Step 7: Build the administrator lifecycle screen

Add an Apps entry to management navigation and compose a dedicated
`AppsAdminScreen`; do not enlarge the already dense
`admin-catalog-screens.tsx`.

Implement:

- status-filtered list;
- import dropzone/file picker;
- package validation/review panel;
- draft save/update;
- test-run form/result;
- publish confirmation;
- new-version action;
- archive confirmation;
- stale-version/conflict recovery by refetching.

Publishing confirmation must show version number, requested tools, network
mode, and immutable-version consequence. Destructive/archive actions use the
existing confirmation pattern and focus management.

**Verify**:
`pnpm --filter @berry/web test -- apps-admin app-package-review` → exit 0;
import, validation errors, save, test, publish, conflict, new version, archive,
focus, and permission-disabled states pass.

### Step 8: Add CSS through Berry tokens

Add only necessary Apps classes to `styles.css`. Use existing
`--berry-*` variables for every surface, text, border, focus ring, status, and
accent. Keep layout compact and responsive:

- catalog: one column narrow, two medium, three wide;
- form/result max width aligned with existing content surfaces;
- long app/resource/file names truncate without hiding accessible names;
- focus-visible styles on cards, controls, and actions;
- transitions are short, interruptible, and disabled/reduced under
  `prefers-reduced-motion`.

Search the added CSS for raw hex/rgb/hsl colors and replace them with Berry
tokens.

**Verify**:

- `rg -n '#[0-9a-fA-F]{3,8}|rgb\\(|hsl\\(' apps/web/src/components/apps apps/web/src/styles.css`
  → no new Apps-specific color matches.
- `pnpm --filter @berry/web... typecheck` → exit 0.

### Step 9: Add focused web E2E without touching user changes

Create `apps/web/tests/apps.spec.ts`. Mock or seed through the existing E2E
API pattern. Cover:

1. member opens catalog and app;
2. fills text/select/boolean and uploads a fixture;
3. starts run and lands on run URL;
4. sees running then message/file result and opens/downloads output;
5. waiting approval links to the underlying task;
6. admin imports a package, reviews it, test-runs, publishes, versions, and
   archives it;
7. unauthorized controls/surfaces are absent.

Do not modify `apps/web/tests/web-shell.spec.ts`, which had user changes at
planning time.

**Verify**:
`pnpm --dir apps/web exec playwright test tests/apps.spec.ts` → exit 0; all
new Apps scenarios pass.

### Step 10: Run the web production gates

Run the exact focused checks required by `AGENTS.md`.

**Verify**:

- `pnpm --filter @berry/web test` → exit 0.
- `pnpm --filter @berry/web... typecheck` → exit 0.
- `pnpm --filter @berry/web... build` → exit 0.
- `pnpm --filter @berry/api... typecheck` → exit 0.
- `pnpm --filter @berry/worker... typecheck` → exit 0.
- `git diff --check` → exit 0.

## Test plan

Add component tests for:

- route and sidebar active states;
- catalog loading/search/filter/pagination/errors;
- every manifest input type and accessibility association;
- upload lifecycle and normalized submission;
- duplicate-run prevention;
- result polling/event cleanup and every terminal state;
- safe message/output rendering;
- package byte preservation and client bounds;
- admin permission, review, test, publish/version/archive flows.

Add E2E in the new `apps.spec.ts`; leave dirty existing tests untouched.

## Done criteria

- [ ] `/apps`, app detail, and run detail are navigable and deep-linkable.
- [ ] Catalog shows only API-provided authorized published apps.
- [ ] All five MVP input types render and submit normalized values.
- [ ] File uploads submit stored IDs, not data URLs.
- [ ] Run results handle progress, approvals, message/files, and failures.
- [ ] Admin can import complete packages, review, test, publish, version, and
  archive.
- [ ] Package scripts/assets/references are preserved in the upload payload.
- [ ] UI uses Berry variables, compact typography, focus states, and reduced
  motion.
- [ ] Web tests, typecheck, build, and focused Playwright pass.
- [ ] User-owned dirty files remain untouched.
- [ ] `plans/README.md` Plan 003 row is updated.

## STOP conditions

Stop and report if:

- Plan 002 shared/API contracts are incomplete or drifted.
- Implementing file fields would require bypassing the existing upload/file
  ownership path.
- Any package resource must be executed or interpreted in the browser.
- A required change overlaps a user-owned dirty file.
- The Apps surface would need hard-coded theme colors or a second component
  library.
- The existing approval flow cannot be deep-linked without building a second
  authorization path.
- Any verification fails twice after a focused fix.

## Maintenance notes

- Keep the form renderer exhaustive when new manifest input kinds are added.
- The browser package limits are usability checks; server validation is the
  security boundary.
- A dedicated in-surface approval UI and richer app builder are follow-ups,
  not reasons to couple Apps to the chat composer.
- Reviewers should test keyboard-only import, form, publish confirmation, run
  navigation, and result download.
