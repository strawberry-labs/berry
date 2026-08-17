# Plan 009: Make skill activation metadata-only until resources are requested

> **Executor instructions**: Complete Plan 008 first. Follow this plan in order
> and run every verification command. Preserve unrelated changes. Do not commit,
> push, deploy, or open a PR. When finished, leave the verified diff in the
> working tree, mark this plan `IN REVIEW`, and wait for code review. Stop rather
> than inventing a different caching or staging system.
>
> **Drift check (run first)**:
> `git diff --stat b36c77d3dc91f4c35454dbbefef54648e6877659..HEAD -- apps/worker/src/personal-skills/tools.ts apps/worker/src/personal-skills/tools.test.ts apps/worker/src/sandbox-continuity.ts apps/worker/src/sandbox-continuity.test.ts docs/skills.md docs/durable-sandbox-lifecycle.md`
>
> Plan 008 will intentionally change signal-related excerpts in these files.
> Accept those planned changes. Any other behavioral mismatch is a STOP
> condition until this plan is reconciled.

## Status

- **Priority**: P1
- **Effort**: M (about one focused engineering day)
- **Risk**: MED
- **Depends on**: `plans/008-bound-sandbox-file-operations.md`
- **Category**: bug, performance, tech-debt
- **Planned at**: commit `b36c77d`, 2026-08-17

## Why this matters

Instructions-only `activate_skill` currently creates/connects an E2B sandbox,
reads a hidden staging manifest, writes `SKILL.md`, and writes the manifest even
when the model requested no resource. Direct `read`, `grep`, `find`, and `ls`
can silently repeat the same staging. This violates Berry's progressive-
disclosure contract and made simple skill activation depend on remote file I/O.

The simplest correct design is: load instructions and resource metadata from
the database; touch E2B only when `activate_skill` explicitly names resources.
When resources are requested, use one idempotent batch write. The content-
addressed directory already makes overwrites safe, so the hidden E2B manifest
cache is unnecessary.

## Regression evidence

- Commit `d366c59` routed dynamic organization skills through runtime E2B
  staging. Production activation latency changed immediately after deployment:
  the pre-deploy maximum was about 13 ms; afterward p50 was 25.376 s, p95 was
  68.630 s, and the first slow call took about 57 s.
- Commit `f60f425` added lazy resources, batch writes, and
  `.berry-staged-files.json`. It improved the median but retained an E2B read
  and writes for activation.
- Commit `825c605` added automatic resource materialization inside direct file
  tools, making a user-visible `read` perform hidden E2B writes.
- Task `740ea3ff-0b6f-4d32-8724-ce361f148e87` showed the result: an xlsx
  activation took 135.016 s, a PDF `read` took 135.019 s because it first
  materialized a skill resource, and a no-resource branding activation took
  135.012 s.

## Current state

- `docs/skills.md` says the runtime catalog carries name/description, activation
  loads `SKILL.md`, and referenced files are loaded only when needed. It also
  says the execution image is generic and does not contain tenant skills.
  Preserve both constraints.
- `apps/worker/src/personal-skills/tools.ts:208-303` always builds package files
  and calls `stageSkillPackage`, even when `requestedResources` is empty.
- `apps/worker/src/personal-skills/tools.ts:307-337` silently calls
  `activateSkill` before `read`, `grep`, `find`, or `ls` when a known resource is
  deferred.
- `apps/worker/src/sandbox-continuity.ts:628-738` always calls `ensureSandbox`.
  It reads `.berry-staged-files.json`, writes missing files, then writes the
  manifest.
- `durablyStagedSkillPackagePaths` already uses completed activation output plus
  `stagingSandboxId` to avoid duplicate writes within the current durable run.
- Package roots are content-addressed from path, size, and SHA-256. Rewriting a
  requested resource in a later run is safe and deterministic.

## Target behavior

| Request | Database work | Sandbox/E2B work | Result |
|---|---|---|---|
| First `activate_skill({name})` | Load resource metadata | None | Instructions plus available/deferred resource list |
| Repeated `activate_skill({name})` | None when prior completed output is reusable | None | `alreadyActive: true` and prior resource state |
| `activate_skill({name, resources:[...]})` | Validate metadata; load only named bytes | Ensure sandbox; one batch write for `SKILL.md` plus missing named files | Exact staged paths returned |
| Direct read of a deferred resource | None beyond snapshot lookup | None | Immediate `RESOURCE_NOT_STAGED` repair error naming the required activation call |
| Direct read of a staged/ordinary path | None | Normal delegated read only | Existing behavior |

The one-batch target applies to the E2B provider, which implements
`writeManyBytes`. Keep provider-neutral fallbacks for providers without batch
support.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Personal skill tests | `pnpm --filter @berry/worker test -- personal-skills/tools` | exit 0; all selected tests pass |
| Staging tests | `pnpm --filter @berry/worker test -- sandbox-continuity` | exit 0; all selected tests pass |
| Worker typecheck | `pnpm --filter @berry/worker typecheck` | exit 0, no TypeScript errors |
| Worker build | `pnpm --filter @berry/worker build` | exit 0 |

## Scope

**In scope**:

- `apps/worker/src/personal-skills/tools.ts`
- `apps/worker/src/personal-skills/tools.test.ts`
- `apps/worker/src/sandbox-continuity.ts`
- `apps/worker/src/sandbox-continuity.test.ts`
- `docs/skills.md`
- `docs/durable-sandbox-lifecycle.md` only for a short clarification if needed
- `plans/README.md` status row

**Out of scope**:

- Baking organization skills into E2B templates or changing database storage.
- Removing lazy loading, content-addressed roots, package validation, path
  validation, SHA-256 validation, or byte-size limits.
- Adding a replacement manifest, existence-probe, list call, cache service, or
  background prefetch.
- Automatically staging a resource from `read`, `grep`, `find`, or `ls`.
- Changing tool timeout semantics; Plan 010 owns that.
- API/web changes, schema changes, production secrets, deployment, and commits.

## Git workflow

- Work on the current branch; preserve unrelated changes and Plan 008's diff.
- Do not commit, push, deploy, or open a PR.
- Leave all passing changes uncommitted for a combined review.

## Steps

### Step 1: Replace old tests with the desired contract

In `personal-skills/tools.test.ts`, change the current tests that expect
instructions-only staging and hidden direct-file materialization.

Add assertions that:

1. Instructions-only activation never calls `stageSkillPackage` and never loads
   resource content bytes.
2. Its `location`/`directory` use the stored virtual skill path
   (`/organization-skills/<id>/SKILL.md`) until resources are staged.
3. It reports all metadata rows as `availableResources` and
   `deferredResources`, with empty staged arrays and no `stagingSandboxId`.
4. A repeated no-resource activation uses the prior completed activation output
   and does not query metadata or call staging again.
5. Explicit resource activation loads only exact requested bytes, calls
   `stageSkillPackage` once, forwards Plan 008's signal/progress options, and
   returns the E2B paths.
6. A direct file tool aimed at a known deferred resource throws
   `ResourceNotStagedError`; it must not call staging or the base file tool.
7. A staged resource and an unrelated/unknown path still delegate normally.

The regression tests may fail before Steps 2-4. Do not leave the branch in that
state at the end of a step group.

### Step 2: Make instructions-only activation metadata-only

Refactor `activateSkill` in `personal-skills/tools.ts`:

1. Locate the stored skill and latest completed activation for the same name.
2. If no resources are requested and prior output is valid, return an
   `alreadyActive` result derived from that output without database or sandbox
   calls. Do not trust arbitrary paths outside the existing helper validation.
3. Otherwise query only resource metadata and validate requested paths exactly
   as today.
4. If `requestedResources.length === 0`, do not require or invoke
   `base.stageSkillPackage`. Use `skill.filePath` as `location`, derive its
   directory, keep staged arrays empty, omit `stagingSandboxId`, inline
   `formatSkillInvocation(skill)`, and include the existing deferred-resource
   instructions.
5. Only the non-empty requested-resource branch defines `loadContentBytes` and
   invokes `stageSkillPackage`.

Do not stage a placeholder `SKILL.md`. The instructions are already present in
`runtime.extraSkills[].content` and returned in the tool result.

**Verify**:
`pnpm --filter @berry/worker test -- personal-skills/tools` -> exit 0.

### Step 3: Make resource loading explicit

Replace `materializeKnownResourceForDirectFileTool` with a validation-only
helper. For `read`, `grep`, `find`, and `ls`:

- If `knownDeferredSkillResource` identifies the exact path, throw
  `ResourceNotStagedError` before delegating.
- The error detail must tell the model exactly to call
  `activate_skill` with the skill name and one relative resource path.
- Do not query the database, call `activateSkill`, call `stageSkillPackage`, or
  touch E2B from this helper.
- If the resource is already listed in staged paths, delegate as today.
- If the path is unrelated or unknown, delegate as today and preserve ordinary
  not-found behavior.

This keeps user-visible file tools honest: `read` reads; activation stages.

**Verify**:
`pnpm --filter @berry/worker test -- personal-skills/tools` -> exit 0.

### Step 4: Remove the E2B staging manifest

In `sandbox-continuity.ts`, remove:

- `SKILL_STAGE_MANIFEST_NAME` and `SKILL_STAGE_MANIFEST_VERSION`;
- `readSkillStageManifest`;
- the manifest read and manifest write in `stageSkillPackage`.

Preserve package validation, revision hashing, content-addressed roots,
`durablyStagedSkillPackagePaths`, lazy database byte loading, integrity checks,
batch write, and provider fallbacks.

The resulting algorithm must be:

1. Ensure the sandbox only because this method was called for real staging.
2. Compute and validate the immutable package root.
3. Get already-staged paths from completed steps for the same root and sandbox.
4. Select `SKILL.md` plus exact requested resources.
5. Load bytes only for missing selected resources.
6. Perform one `writeManyBytes` call when supported; otherwise use the existing
   bounded fallback.
7. Return paths; perform no manifest/existence read and no bookkeeping write.

Across a later run with no durable step output, rewriting the same immutable
paths is the accepted tradeoff. Do not replace the manifest with `getInfo`,
`list`, or another remote cache check.

Update `sandbox-continuity.test.ts`:

- A fresh explicit resource activation makes no provider read and one batch
  write containing `SKILL.md` and the named resources.
- Incremental activation in the same sandbox writes only newly requested files.
- A replacement sandbox rewrites the selected files.
- A later run may rewrite the same content-addressed files; assert correctness,
  not cross-run skip behavior.
- No test expects `.berry-staged-files.json`.

**Verify**:
`pnpm --filter @berry/worker test -- sandbox-continuity` -> exit 0.

### Step 5: Align documentation and run the full worker gate

Update `docs/skills.md` to state:

- activation loads stored instructions without creating a sandbox;
- resources are materialized only by an explicit `resources` list;
- direct file tools return `RESOURCE_NOT_STAGED` for deferred paths;
- explicit staging uses an idempotent content-addressed batch write;
- organization skills remain dynamic and are never baked into a shared image.

If needed, add one sentence to `docs/durable-sandbox-lifecycle.md` confirming
that metadata-only skill activation is not a sandbox lifecycle trigger.

**Verify**:

1. `rg -n "SKILL_STAGE_MANIFEST|berry-staged-files|readSkillStageManifest|materializeKnownResourceForDirectFileTool" apps/worker/src` -> no matches.
2. `pnpm --filter @berry/worker test -- personal-skills/tools sandbox-continuity` -> exit 0.
3. `pnpm --filter @berry/worker typecheck` -> exit 0.
4. `pnpm --filter @berry/worker build` -> exit 0.

## Test plan

- Instructions-only first activation: DB metadata only, zero sandbox calls.
- Repeated activation: prior durable output, zero DB/content/sandbox calls.
- Explicit one and many resources: exact byte query and one batch write.
- Unknown resource: rejected before content load or sandbox staging.
- Deferred direct read/grep/find/ls: actionable error, zero hidden side effects.
- Staged and unrelated reads: normal delegation.
- Same sandbox incremental staging and replaced-sandbox restaging.
- Package revision isolation and large binary byte handling remain covered.

## Done criteria

- [ ] No-resource activation calls neither `stageSkillPackage` nor any sandbox
      provider.
- [ ] Explicit activation is the only dynamic-skill resource staging path.
- [ ] E2B staging has no manifest read/write and uses one batch write on the
      normal production path.
- [ ] Dynamic database storage, lazy bytes, hashes, package limits, and
      content-addressed paths remain intact.
- [ ] The four direct file tools do no hidden staging.
- [ ] Focused tests, worker typecheck, and worker build pass.
- [ ] Documentation matches the new behavior.
- [ ] No commit, push, or deployment was performed.

## STOP conditions

Stop and report if:

- Organization skill instructions are absent from `runtime.extraSkills` and
  therefore cannot be returned without reading E2B.
- A consumer requires a physically present `SKILL.md` before any resources are
  requested. Identify that consumer with exact file/line evidence; do not add
  placeholder staging.
- Removing the manifest would overwrite mutable, non-content-addressed paths.
- The explicit resource branch cannot use Plan 008's signal.
- An in-scope behavior has drifted or a verification fails twice.

## Review and maintenance notes

The reviewer should count provider calls, not only elapsed time. The required
counts are zero for instructions-only activation and, on E2B, one batch file
write for a fresh explicit resource request. A later explicit request may make
one more idempotent batch write; that is preferred over remote manifest
bookkeeping. Reject any replacement cache or transparent direct-file staging.
