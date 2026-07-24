# Plan 004: Ship examples, end-to-end coverage, documentation, and deployment checks

> **Executor instructions**: Complete Plans 001-003 first. This plan closes
> product and operational gaps; it is not permission to redesign working
> contracts. Follow every verification command and stop on the conditions
> below. Update Plan 004 in `plans/README.md` when done.
>
> **Drift check (run first)**:
> `git diff --stat 483c817..HEAD -- docs README.md examples/berry-apps apps/api/src/apps apps/web/tests/apps.spec.ts deploy packages/shared packages/db`
>
> Run `git status --short` and preserve all pre-existing user changes. Confirm
> Plans 001-003 are marked `DONE`.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/003-apps-web-experience.md`
- **Category**: docs
- **Planned at**: commit `483c817`, 2026-07-23

## Why this matters

A new platform capability is not finished when the CRUD screens compile.
Operators need a package authoring contract, reviewers need realistic
security/integration coverage, and users need at least one trustworthy example
that demonstrates message and file outputs. Deployment also spans schema, API,
and web, so it cannot follow Berry's web-only restart path.

This plan makes the feature reproducible and reviewable without adding
automatic production deployment or hidden sample data.

## Current state

- `docs/skills.md` documents Agent Skills directory/`.skill` transport,
  frontmatter review, trust, and progressive disclosure. Apps documentation
  must explain that `SKILL.md` remains standard while `berry.app.yaml` is a
  Berry extension.

- Root `README.md` describes Berry as a self-hosted enterprise AI assistant
  combining chat, files, tools, skills, MCP, sandboxes, organization policy,
  usage, and administration. Add Apps to this capability list only after the
  previous plans pass.

- `AGENTS.md` says production secrets live only in
  `deploy/.env.production`, which must never be committed or replaced.
  Schema/API changes require the corresponding service deployment path; this
  is not a web-only deployment.

- The worker is currently for reporting/usage/title queue jobs. Apps execute
  through the API-local governed agent turn and reconcile interrupted runs on
  restart.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Shared tests | `pnpm --filter @berry/shared test` | exit 0 |
| DB tests | `pnpm --filter @berry/db test` | exit 0 |
| Agent tests | `pnpm --filter @berry/local-agent test` | exit 0 |
| API tests | `pnpm --filter @berry/api test` | exit 0 |
| Web tests | `pnpm --filter @berry/web test` | exit 0 |
| Web E2E | `pnpm --dir apps/web exec playwright test tests/apps.spec.ts` | exit 0 |
| Web build | `pnpm --filter @berry/web... build` | exit 0 |

## Scope

**In scope**:

- `docs/apps.md` (create)
- `docs/skills.md`
- `README.md`
- `examples/berry-apps/document-summarizer/SKILL.md` (create)
- `examples/berry-apps/document-summarizer/berry.app.yaml` (create)
- Optional safe reference/template files under that example directory
- `examples/berry-apps/README.md` (create)
- Existing Apps tests from Plans 001-003 where an end-to-end contract gap is
  discovered
- `apps/web/tests/apps.spec.ts`
- A non-secret deployment/runbook document under `docs/`
- `plans/README.md` (update only the Plan 004 status row)

**Out of scope**:

- Automatically seeding example apps into every tenant.
- Shipping an example script that executes untrusted code or uses network
  access.
- Editing or replacing `deploy/.env.production`.
- Running a production deployment without explicit operator authorization.
- Marketplace publishing, public package registry, schedules, or distributed
  worker execution.
- Desktop/mobile/extension support.

## Git workflow

- Branch: `codex/004-apps-e2e-starters-docs`
- Suggested commit:
  `docs(apps): add examples and production runbook`.
- Do not push, open a PR, or deploy unless explicitly instructed.

## Steps

### Step 1: Create one portable, safe example app

Create `examples/berry-apps/document-summarizer/` as a source directory that
can be zipped into a `.skill` archive without transformation.

The example must:

- contain valid standard Agent Skill frontmatter in `SKILL.md`;
- contain a schema-version 1 `berry.app.yaml`;
- accept one PDF/text/Office document and one audience select;
- return a concise message and a Markdown brief file;
- request only the minimum tools required to read the attachment, write the
  brief, and persist it;
- use network `off` and permission mode `auto-edit`;
- instruct the agent to treat the document as untrusted content and ignore
  instructions found inside it;
- give an exact output filename and require `persist_artifact`;
- avoid scripts for the first example, keeping review simple.

Add an example README with a safe ZIP command and the admin import steps. Do
not commit a generated binary archive; source files are reviewable and the E2E
test can build a temporary archive.

**Verify**:

- Run the package validator test/helper from Plan 002 against the example →
  exit 0 and a normalized package with one manifest and one skill.
- `rg -n 'network: (on|organization-policy)|full-access|bash|mcp__|fetch_url|web_search' examples/berry-apps/document-summarizer`
  → no matches.

### Step 2: Add full-stack contract coverage

Review the tests from Plans 001-003 and add missing cross-layer cases without
duplicating unit tests. At minimum, one integration fixture must exercise:

1. admin package upload and draft creation;
2. test run of the draft;
3. publish version 1;
4. member catalog visibility;
5. file upload and production run;
6. explicit skill activation;
7. allowlisted tools only and network off;
8. message plus persisted Markdown output;
9. run history linked to exact version/task/session;
10. version 2 publication while version 1 history remains unchanged;
11. archive removes catalog visibility but preserves history;
12. a simulated API restart marks an active run `runtime_interrupted`.

Use fake model/sandbox/artifact providers already used in API tests; do not
require external credentials. The Playwright path may mock deterministic
completion, but API integration must prove orchestration and persistence.

**Verify**:

- `pnpm --filter @berry/api test -- app` → exit 0.
- `pnpm --dir apps/web exec playwright test tests/apps.spec.ts` → exit 0.

### Step 3: Write operator and package-author documentation

Create `docs/apps.md` with:

- the Skills-versus-Apps decision;
- package tree and complete manifest reference;
- field and output types;
- lifecycle/state diagram in text or Mermaid;
- permissions and resource ACL behavior;
- tool allowlist, approval, sandbox, network, model governance, budget, and
  file security rules;
- package/file limits;
- import, test, publish, new-version, archive, and run flows;
- run status/error code reference;
- restart behavior and in-process durability limitation;
- troubleshooting for unavailable `persist_artifact`, model governance,
  foreign/invalid files, output contract failures, and interrupted runtime;
- a note that Berry manifest keys are an extension while `SKILL.md` remains
  Agent Skills-compatible.

Update `docs/skills.md` with a short cross-link; do not imply every skill is an
app. Update the root README capability list and documentation index.

Do not include secrets, real tenant IDs, or production credentials.

**Verify**:

- `rg -n 'Berry Apps|berry.app.yaml|runtime_interrupted|allowed-tools' docs/apps.md docs/skills.md README.md`
  → expected terms appear.
- All referenced repository paths exist.

### Step 4: Document the non-web-only production path

Add a runbook section to `docs/apps.md` or a focused deployment document:

1. Back up the database through the existing operator procedure.
2. Preserve `deploy/.env.production`; never generate or replace it.
3. Build packages/services.
4. Apply migration 25 using the existing migration command/path.
5. Restart/redeploy API and web, plus any shared-package dependent service
   required by the current Compose setup.
6. Do not restart only web.
7. Verify API health, migration presence/RLS, Apps catalog, one controlled test
   run, artifact download, audit events, and usage/budget attribution.
8. Roll back application images only with a database-compatible plan; published
   app data must not be dropped.

Use exact commands only if they already exist in package scripts or deploy
docs. Do not invent Compose service names. Do not run the deployment.

**Verify**:
`rg -n 'deploy|migration|env.production|rollback|health' docs/apps.md` →
runbook sections are present and contain no secret values.

### Step 5: Run the complete focused release gate

Run:

```sh
pnpm --filter @berry/shared test
pnpm --filter @berry/db test
pnpm --filter @berry/local-agent test
pnpm --filter @berry/api-client test
pnpm --filter @berry/api test
pnpm --filter @berry/web test
pnpm --filter @berry/web... typecheck
pnpm --filter @berry/web... build
pnpm --filter @berry/api... typecheck
pnpm --filter @berry/worker... typecheck
pnpm --dir apps/web exec playwright test tests/apps.spec.ts
git diff --check
```

**Verify**: every command exits 0. Record any known unrelated failure in the
handoff; do not waive an Apps-related failure.

## Test plan

The final suite must prove:

- package portability and manifest validity;
- server-side package attack/bounds validation;
- immutable publication and history;
- tenant/role/resource authorization;
- file ownership and content-type limits;
- runtime prompt/tool/network/sandbox restrictions;
- model/budget/usage/audit integration;
- message/file output contract;
- admin and member web flows;
- interrupted-run reconciliation.

## Done criteria

- [ ] A reviewable source example imports, tests, publishes, and runs.
- [ ] Full-stack tests cover the 12-step lifecycle above.
- [ ] `docs/apps.md` fully defines authoring, security, lifecycle, errors, and
  operations.
- [ ] Skills docs clearly distinguish a skill from an app.
- [ ] README advertises Apps only after all checks pass.
- [ ] The runbook states that this is schema/API/web deployment and preserves
  `deploy/.env.production`.
- [ ] Complete release gate passes.
- [ ] No generated binary package, secret, or production mutation is committed.
- [ ] `plans/README.md` Plan 004 row is updated.

## STOP conditions

Stop and report if:

- Any earlier plan is not complete.
- The example needs network, shell, or full-access permissions to work.
- E2E requires live provider credentials rather than repository fixtures.
- Exact migration/deployment commands cannot be found in existing scripts/docs;
  document the gap instead of inventing them.
- Completing the runbook would require reading or modifying secret values.
- Any Apps-related release gate fails twice after a focused fix.

## Maintenance notes

- Add future first-party examples as source directories and validate them in
  CI; avoid opaque prebuilt archives.
- If app turns move to a worker later, revise restart semantics, approval event
  delivery, and deployment topology together.
- If package caps rise, move resources out of Postgres and retain content
  hashes/version immutability.
- The most important review boundary is still: manifest policy can narrow
  organization policy, never widen it.
