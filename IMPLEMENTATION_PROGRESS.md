# Implementation progress — 2026-10-14 audit

Tracks implementation of the issues in [ISSUES.md](ISSUES.md), using the evidence in
`output/platform-audit-2026-10-14/` (completion findings, report, coverage) and the
[prompt proposal](SYSTEM_PROMPT.md). One focused commit per issue; shared
prerequisites are committed separately. Issue IDs appear in every commit message.

## Ground rules applied

- **Local only.** No production deployment, prompt, skill, memory, database or
  configuration change was made from this work. Every entry records deployment
  separately; "Committed" never means "Verified in production".
- **Dirty checkout.** Branch `codex/web-audit` started at `99964f1` with ~230 unrelated
  modified/untracked paths (mobile companion app, scheduled tasks, file download
  ranges, `@berry/client-core` extraction, AESG skill/template edits, docs). Those are
  left in place, unstaged and uncommitted. Prepared fixes that belong to an audited
  issue are committed hunk-by-hunk under that issue after revalidation, keeping
  their original wording.
- **Isolated verification.** Each staged commit is applied onto a clean worktree of
  the parent commit and type-checked/tested there, so no commit silently depends on
  unrelated uncommitted work. Results below come from that isolated snapshot unless
  stated otherwise.
- **Integration fixtures.** Queue/recovery checks use a disposable loopback
  `pgvector/pgvector:0.8.2-pg16-bookworm` database migrated with the production
  migrations (`scripts/setup-queue-test-db.mjs`). Never point them at production.

## Production data safety (ai.aesg.com)

Production data must not be disrupted or lost. Rules for every change in this log:

- Prefer no schema change; reuse existing columns and JSON fields where they suffice.
- If a migration is unavoidable it must be additive, idempotent (`IF NOT EXISTS`),
  online (no long locks; `CONCURRENTLY` for indexes), and must not drop, rewrite or
  backfill existing rows. Each one is listed in the table below with its risk.
- Nothing here runs against production. Deployment, including any migration, happens
  later and deliberately; historical backlog deletion needs its own reviewed plan.

| Commit | Issue | Migration / data impact |
| --- | --- | --- |
| `d7a806a` | H-001 | None. Uses existing queue/budget tables; writes one new JSON key (`queuedBudgetRequestId`) inside `queued_follow_up_items.runtime_request` for new rows only. |
| `d5b9138` | H-002 | None (prompt text). |
| `0cfe1d4` | H-009 | None. |
| `d481431` | H-014 | None. |
| `39d02c8` | H-011 | None (worker dependency only). |
| `e6b2fa8` | H-051/H-072 | None. New JSON keys in `turn_runs.runtime_request` for new continuation runs only. |
| `eda27eb` | H-014 (Continue intent) | None (prompt assembly only). |
| `f2bace0` | H-046/H-060/H-071 | None. |
| `91208bc` | H-009 (text-only finalisation) | None. |
| `d95b252` | H-075 | None (read-only lookup of `turn_runs`/`tasks`/`tenant_memberships`). |
| `52c0260` | H-033 | None. |
| `3a27931` | H-032 (diagnostics) | None. |
| `9eecde6` | H-032 (prompt layout) | None (prompt assembly only). |
| `f2923b2` | H-068 | None. |
| `920a84c` | H-076 | None. |
| `430d396` | H-070 | None. |
| `b7b1e94` | H-053 | None. |
| `1df00a9` | H-030 | None. |
| `e4bc64b` | H-054 | None. |
| `c4f419b` | H-011 (binary reads) | None. Only new tool results are sanitised; existing journal rows are untouched. |
| `2bd8ff5` | H-039 | No schema change and no deletion. The prompt-version bump stops reuse of existing `vision_observation_cache` rows; the existing retention job removes them once unused. |
| `03d4682` | H-061 | None. |
| `5cd4189` | H-042 | None (in-memory model previews only; user files untouched). |
| `c94340b` | H-041 | None. New generated files are stored under their real format; existing files and rows are untouched. |
| `67a22fa` | H-059 | None (skill script). Publishing it is a skill-package sync, not a database migration. |
| `375f8dd` | H-040 (Mem0 input) | None. Changes only what new turns send to Mem0; existing memories are untouched (removing contaminated ones needs user controls or a reviewed plan). |
| `54c9255` | H-041 test fixture | None (test only). |
| `b9200f0` | H-057 | None. |
| `f6433f9` | H-049 | None. |
| `f4f2b1e` | H-062 | No schema change. New index failures set the file's own row from `processing` to `available`; the 249 existing rows are untouched (reconciliation proposed below, not run). |
| `e241a6b` | H-028 | None. Publication receipts gain a `sha256` field for new publications only. |
| `37285db` | H-036 | None. |
| `f027f27` | H-016 | None. |
| `6c46724` | H-050 | None. |
| `8f966ed` | H-038 | None. |
| _pending_ | H-008 | None. |
| `3104547` | H-069 | No schema change. Deletes only the Library row the legacy trigger creates for a *new* temporary connector import, inside the same transaction. Existing Library rows (including the 261 historical temporary imports) are untouched. |
| `f6f9074` | H-064/H-007 (skill staging) | None. Reads existing `*_skill_files`; writes only inside sandboxes. |
| `29dd951` | H-032 (metrics) | None. New rows record declared eligibility only; historical `cache_eligible` values are not rewritten (the dashboard no longer depends on them). |
| `f30b651` | H-031 | None. Fixes how *new* receipts are written; the 834 historical dead-letter rows are not touched (separate reviewed plan required). |
| `49815ef` | H-048 | None. New `session_entries` projections of failed messages store the error as a typed `error` part; existing rows are not rewritten (legacy shape is handled at read time). |
| `2a7af6b` | H-066 | None. On operator Retry/Mark complete: one new `budget_reservations` row (`<request>:recovery:<n>`) through the normal budget path and new JSON keys merged into that run's `runtime_request`. Existing settled reservations, usage rows and ledger entries are never modified. |

## Status legend

`Revalidating` → `Confirmed` → `Implementing` → `Validated locally` → `Committed` →
`Verified in production`. Also `Already resolved`, `Blocked`, `Not reproduced`.

## Baseline (before any change)

| Check | Result |
| --- | --- |
| `pnpm --filter @berry/worker... typecheck` (dirty tree) | pass |
| `pnpm --filter @berry/api... typecheck` (dirty tree) | pass |
| Worker unit suite (dirty tree) | 908 passed, 6 skipped (58 files, 4 skipped files) |

No pre-existing failures were observed in these suites.

**Pre-existing failures found later (present at base `99964f1`, not caused by this work):**

| Suite | Failure | Evidence |
| --- | --- | --- |
| `apps/api/src/usage/usage.controller.test.ts` | 4 tests: "Nest can't resolve dependencies of the QueuedFollowUpService (?) … CloudDatabaseService at index [0]" | Same 4 failures on a clean checkout of `99964f1` and of `52c0260`; test-module DI wiring, untouched by these commits. |
| `apps/api` controller suites: `audit` (3), `billing` (2), `identity` (9), `model-governance` (4), `policy-distribution` (2), plus `usage` (4) above | 24 tests in total, same Nest DI error | Found with a full API run on 14 October: identical 24 failures on clean checkouts of `99964f1` and `c4f419b`. Earlier entries cited only the `usage` suite. |

**Correction to recorded worker test counts.** Vitest 4 also collects compiled
`dist/*.test.js` files, and the verification tree's `apps/worker/dist` held compiled
tests from earlier builds. Worker totals recorded up to `c4f419b` (908 → 995) therefore
double-count; their pass/fail results stand, since both copies passed. Source-only counts:
base `99964f1` 433 passed / 3 skipped; `c4f419b` 506 / 3. From H-039 on, the
verification script deletes compiled tests first and counts are source-only.

**Per-commit typecheck sweep (14 October).** Every commit from `b317990` to `54c9255`
was checked out in a separate worktree; package dependencies were rebuilt, then
`@berry/worker` and `@berry/api` were type-checked. All pass except `c94340b`,
`67a22fa` and `375f8dd`, which fail worker typecheck only because of the H-041 test
fixture; this is fixed in `54c9255`.

## Summary

| ID | Status | Commit | Deployment |
| --- | --- | --- | --- |
| H-001 | Committed | `d7a806a` | Not deployed (API + worker + web must ship together) |
| H-009 (reconnect after cross-worker pause) | Committed — partial | `0cfe1d4` | Not deployed (worker + sandbox-contract) |
| H-014 (prerequisite: late mutation receipts) | Committed — source of the already-deployed hotfix | `d481431` | Deployed 2026-09-30 per record; exact production byte parity not reproducible (see entry) |
| H-011 (image payload guard) | Committed — partial | `39d02c8` | Not deployed (worker image; needs Sharp's Linux binary from the frozen lockfile) |
| H-051 / H-072 (Continue workspace lineage) | Committed | `e6b2fa8` | Not deployed (API + worker; either order is compatible) |
| H-066 (recovery budget generation) | Committed | `2a7af6b` | Not deployed (API + worker together; see entry) |
| H-048 (provider errors in history) | Committed | `49815ef` | Not deployed (API + worker; either order safe) |
| H-014 (phase-aware Continue) | Committed — partial | `eda27eb` | Not deployed (worker) |
| H-046 / H-060 / H-071 (image path lifetime and selection) | Committed | `f2bace0` | Not deployed (worker) |
| H-009 (text-only finalisation) | Committed — partial | `91208bc` | Not deployed (worker) |
| H-075 (internal connector session lifetime) | Committed | `d95b252` | Not deployed (API only) |
| H-031 (blob-deletion receipt SQL) | Committed | `f30b651` | Not deployed (worker); backlog reconciliation not started |
| H-033 (revision provenance) | Committed — partial | `52c0260` | Not deployed (shared package; API + worker rebuild) |
| H-032 (cache metric truth) | Committed — partial | `29dd951` | Not deployed (worker + API + web) |
| H-032 (served backend + retention diagnostics) | Committed — partial | `3a27931` | Not deployed (worker) |
| H-032 (per-turn context out of the system prefix) | Validated locally (offline); live evaluation pending | `9eecde6` | Not deployed (worker) |
| H-064 / H-007 (skill dependency closure + staging) | Committed — platform part; AESG manifests pending | `f6f9074` | Not deployed (worker) |
| H-068 (import readiness) | Committed | `f2923b2` | Not deployed (worker) |
| H-069 (temporary imports kept out of Library) | Committed | `3104547` | Not deployed (API) |
| H-076 (shared-drive scope) | Committed | `920a84c` | Not deployed (API) |
| H-070 (bounded MCP results keep structure and cursors) | Committed — partial | `430d396` | Not deployed (worker) |
| H-053 (repeat guard after source edits) | Committed | `b7b1e94` | Not deployed (worker) |
| H-030 (bounded polling of running jobs) | Committed | `1df00a9` | Not deployed (worker) |
| H-054 (vision retry by failure class) | Committed | `e4bc64b` | Not deployed (worker) |
| H-011 (binary and UTF-16 reads; NUL-safe journal) | Committed — partial | `c4f419b` | Not deployed (worker) |
| H-039 (truncated vision observations) | Committed — partial | `2bd8ff5` | Not deployed (worker) |
| H-061 (questions dropped by overview mode) | Committed | `03d4682` | Not deployed (worker) |
| H-042 (transparent images seen as blank) | Committed | `5cd4189` | Not deployed (worker) |
| H-041 (generated image metadata from returned bytes) | Committed — worker path | `c94340b` | Not deployed (worker) |
| H-059 (XLSX rows sized to wrapped text) | Committed | `67a22fa` | Not published (organization `xlsx` skill package) |
| H-040 (assistant text kept out of personal memory extraction) | Committed — partial | `375f8dd` | Not deployed (worker) |
| H-041 fixture (typecheck) | Committed | `54c9255` | Test only |
| H-057 (malformed question batches) | Committed | `b9200f0` | Not deployed (worker) |
| H-049 (PDF pages without text reported as unreviewed) | Committed — partial | `f6433f9` | Not deployed (worker) |
| H-062 (failed indexing leaves files processing) | Committed — worker state; UI open | `f4f2b1e` | Not deployed (worker); backlog not reconciled |
| H-028 (rebuilt files suppressed as duplicate publications) | Committed | `e241a6b` | Not deployed (worker) |
| H-036 (tool results past the history budget sent empty) | Committed — partial | `37285db` | Not deployed (worker) |
| H-016 (earlier shell failures masked by a final success) | Committed — partial | `f027f27` | Not deployed (worker) |
| H-050 (ready optional capability discarded at the admission deadline) | Committed — partial | `6c46724` | Not deployed (API) |
| H-038 (streamed tool calls merged when indices restart) | Committed — worker path | `8f966ed` | Not deployed (worker) |
| H-008 (workspace outputs/ and tmp/ guaranteed) | Committed — partial | _pending_ | Not deployed (worker) |
| H-015 (expired queued text) | Blocked — web queue model is mid-refactor in uncommitted work | — | — |
| H-043 (presentation font inheritance) | Blocked — python-pptx unavailable offline; template change collides with prepared manifest | — | — |
| H-056 / H-058 (DOCX duplicate keys, placeholder validator) | Blocked — fixes belong in prepared, already-published AESG sources | — | — |
| H-004 (repair loops across changed arguments) | Blocked — needs a targeted reproduction; no change | — | — |
| H-002 (prerequisite) | Committed — source of the already-deployed hotfix | `d5b9138` | Already in production since 2026-09-24 (hash-verified); prompt work itself still open |

## Issue log

### H-001 — Queue delivery and steering (P0)

- **Evidence.** Audit: 83 terminal `session_entries_run_id_fkey` failures / 67 tasks /
  42 users in the month (latest 12 Oct); final-window tasks 22, 25, 30, 35, 170;
  deployed API/worker hashes match the faulty path.
- **Reproduced on `99964f1`.** Real PostgreSQL + real worker, using a reduced copy of the
  first `scripts/test-queue-steering.mjs` scenario against `99964f1` builds: admit a turn, enqueue one follow-up, let the worker complete.
  Result: the completed run is rewritten to `failed` with
  `insert or update on table "session_entries" violates foreign key constraint
  "session_entries_run_id_fkey"`, the queue row is left `paused` with
  `attempt_count=0` (the increment rolled back), and no follow-up run exists. This
  matches the audited symptom "usable draft followed by a failure" and explains why
  stored attempt zero does not prove no attempt.
- **Root cause (confirmed).** `promoteQueuedFollowUp` inserted the user-message
  journal entry (`session_entries.run_id = new run`) before inserting that run into
  `turn_runs`, inside the same transaction that settled the predecessor; the FK is
  not deferrable, so the whole terminal transaction rolled back.
- **Decision.** Adopt the prepared local fix after review (it addresses the cause and
  the secondary defects it exposed) rather than redesigning the queue:
  - worker: insert `turn_runs` before the journal entry; promote *after* the
    predecessor's projection update; run promotion inside a savepoint so a bad
    queued input marks only that item `failed` (text kept, retryable) and never rolls
    back the completed answer; strict FIFO (a paused/failed head blocks later items);
    lock the task/session rows; `promoteIdleQueuedFollowUps` from the outbox tick so
    Resume/Retry progress when no turn is active, and zero-cost queue budget
    reservations of cancelled/expired items are released;
  - API: queue admission reserves budget through the normal budget service with a
    stable `queued:<idempotencyKey>` identity reused across delivery retries;
    idempotency keys are bound to their session; cancelling the active turn pauses
    queued items instead of letting them auto-run after a steer;
  - web: retain composer text and reuse the same idempotency key when an enqueue
    response is lost; queued-item **Steer** cancels the active turn, moves the item to
    the head and re-attaches the stream; resumed queues re-attach the stream.
- **Files.** `apps/worker/src/turn-runner.ts` (queue hunks only), `apps/worker/src/outbox.ts`,
  `apps/api/src/runtime/queued-follow-up.service.ts`, `apps/api/src/runtime/durable-turn.service.ts`,
  `apps/api/src/http/agent-api.controller.ts` (enqueue hunk only),
  `apps/web/src/components/app-shell.tsx` and `tasks/web-composer.tsx` (queue hunks only),
  `apps/worker/src/turn-runner.test.ts` (billing-identity test),
  `scripts/{setup-queue-test-db,test-queue-steering,queue-steering-browser-server}.mjs`,
  `apps/web/{playwright.queue.config.ts,tests/queue-steering.spec.ts}`.
- **Verification (isolated snapshot).** worker/API/web typecheck pass; web production build passes;
  `turn-runner.test.ts` + `outbox.test.ts` 126/126; real PostgreSQL suite 8/8
  (FIFO delivery with journal/budget/projection/outbox, concurrent duplicate enqueue
  reserves once, steering pause/resume, bad follow-up cannot roll back a completed
  answer, paused head blocks FIFO + reorder/cancel, late predecessor completion cannot
  overwrite a steer, spend limits enforced, expired entries never auto-start and
  release budget); Chromium 4/4 (durable Enter queue across reload, lost enqueue
  response retains text and reuses the key, Ctrl+Enter cancel→append→admit order,
  queued-item Steer).
- **Deployment.** Not deployed. API, worker and web must ship together (the API
  now writes `queuedBudgetRequestId`; the worker reads it and falls back to the old
  identity for rows queued before the upgrade).
- **Remaining uncertainty.** A budget reservation made by `enqueue` whose surrounding
  transaction later fails is left `reserved` at zero cost until reconciliation; no
  quota impact observed in tests. Expired-item recovery UI is H-015. Historical expired
  requests must not be replayed.
- **Next action.** Deploy API/worker/web together; run a synthetic queue + steer flow
  in production.

- **Commit.** `d7a806a`.

### H-002 prerequisite — commit the deployed faithful-rewriting hotfix

- **Evidence.** `output/rewrite-prompt-2026-09-24/deployment.md`: the faithful
  copy-editing instruction was deployed to all six workers on 2026-09-24 as a
  source/image hotfix over `99964f1`, with prompt SHA-256 `de72fe1a…f6255`, and "a
  later Git deployment must include this amendment to retain it". It was still only in
  the uncommitted working tree.
- **Risk addressed.** Any Git-based worker deployment from this branch would have
  silently removed a prompt that is live in production (a regression), so this is
  committed before further prompt work.
- **Verification.** The `DURABLE_REWRITING_PROMPT` string in source hashes to
  `de72fe1a79f0dc81c18f34fd2cb6dbe9266c019c6d24b2515c2af74b2e9f6255`, identical to the
  recorded deployed hash and to `output/rewrite-prompt-2026-09-24/prompt.txt`. Isolated
  snapshot: worker typecheck pass; `turn-runner.test.ts` 110/110 including the test that
  the instruction reaches the actual provider system messages.
- **Files.** `apps/worker/src/turn-runner.ts` (constant + stable-prompt entry),
  `apps/worker/src/turn-runner.test.ts`, `scripts/eval-rewriting.mjs`,
  `scripts/rewrite-eval-cases.json` (synthetic-only evaluation harness used for the
  deployment; reads credentials from the environment and never prints them).
- **Deployment.** Already deployed (hash-verified in the record); this commit only
  aligns Git with production. No behaviour change relative to production.
- **Remaining.** The H-002 meaning-drift findings (could→can, personal→company
  responsibility, requirement→compliance) are *not* addressed by this commit; see the
  H-002 entry once prompt evaluation work starts.
- **Commit.** `d5b9138`.

### H-009 — Sandbox recovery: reconnect a sandbox paused by another worker

- **Evidence.** Diagnosed production incident (`output/sandbox-task-25207229-2026-10-07/diagnosis.json`,
  task `25207229…`, run `c32778e8…`): worker-foreground-11 connected at 07:30:14,
  worker-1 paused the sandbox at 07:30:18 during terminal cleanup, and the foreground
  worker's attachment `file.writeStream` failed at 07:30:25 with "The sandbox was not
  found" without reconnecting; zero model attempts were made and a later run reused the
  same sandbox. The audit confirms the reconnect repair is absent from all six deployed
  workers and that the month has 48 + 15 missing/unavailable sandbox variants (not
  unioned; not all attributable to this cause).
- **Root cause (confirmed for this variant).** `E2BSandboxProvider.resume` took a fast
  path for a cached handle whose *local* lease had not expired, skipping `connect`, so
  operations targeted compute another worker had paused.
- **Decision.** Commit the prepared, previously validated fix unchanged: an optional
  `force_reconnect` on the resume contract; follow-up turns always reconnect the prior
  E2B sandbox, and a resumed run reconnects when its persisted state is not `running`.
  Active phases keep cheap handle reuse; no replacement on generic errors.
- **Files.** `packages/sandbox-contract/src/{schemas,e2b-provider}.ts` (+test),
  `apps/worker/src/sandbox-continuity.ts` (two resume inputs only) + test,
  `docs/durable-sandbox-lifecycle.md`.
- **Verification (isolated snapshot).** sandbox-contract/worker/API typecheck pass;
  `e2b-provider.test.ts` 25/25; `sandbox-continuity.test.ts` + `turn-runner.test.ts`
  207/207. Regression proof: with the pre-fix provider and continuity sources the new
  tests fail (1 provider test, 2 attachment-staging tests) and pass with the fix.
- **Deployment.** Not deployed.
- **Remaining (H-009 stays open).** Typed lifecycle classification for other
  missing-sandbox variants (operation failure after handle acquisition, policy/auth vs
  true disappearance) and fault-injection coverage across expiry during model wait.
  Text-only finalisation that still requires a sandbox is tracked under H-013/task 176.
- **Commit.** `0cfe1d4`.

### H-014 prerequisite — commit the deployed late-result recovery hotfix

- **Evidence.** `output/kate-recovery-2026-09-30/README.md`: a non-idempotent LibreOffice
  recalculation was deliberately awaited past its deadline; it succeeded, but
  `withHeartbeat` re-threw the already-fired timeout, so a known outcome became
  `recovery_required` (three red messages, manual recovery). The patch was deployed to
  the five foreground workers on 2026-09-30 with patched JS SHA-256 `c030d2ca…`, which
  is also the worker turn-runner hash the 2026-10-14 audit observed on all six
  workers. The source change was never committed. The audit explicitly says not to
  reopen this fixed cause.
- **Decision.** Commit the prepared source unchanged so a Git deployment cannot regress
  production: a fulfilled result of a non-abortable `non_idempotent_manual` tool is
  kept after its idle/wall deadline; rejections, lease loss, cancellation and
  abortable/read-only timeouts keep their existing guards.
- **Verification (isolated snapshot).** Worker typecheck pass; `turn-runner.test.ts`
  114/114 including the four late-receipt cases (idle and wall deadline preserved,
  rejection after deadline still requires recovery, late receipt after lease loss
  rejected).
- **Production parity check — not established.** Building `99964f1` + the rewriting
  hotfix + this patch gives `dist/turn-runner.js` SHA-256 `81e4025d…`, not the deployed
  `c030d2ca…`. The recorded `turn-runner.before.ts` is the local dirty copy (it contains
  queue and image-guard edits), not production source. Production therefore may carry
  further undocumented differences (consistent with the `+production-hotfixes`
  revision in H-033). **Before any Git-based worker deployment, diff the production
  `/opt/berry/apps/worker/src` tree against the branch being deployed.**
- **Files.** `apps/worker/src/turn-runner.ts` (four hunks), `apps/worker/src/turn-runner.test.ts`.
- **Remaining (H-014 stays open).** Operation-specific recovery actions/UX and
  metadata-only bash classification.
- **Commit.** `d481431`.

### H-011 — Image payload guard before provider submission

- **Evidence.** Task `ebb508e9…`, run `17fe4e71…` (`output/model-image-guard-2026-09-29/README.md`):
  after two image reads the message content grew from 3.95 M to 6.32 M characters and
  the route returned HTTP 413 in ~0.5 s with no usage. Audit finding 7: tasks 65, 84,
  85, 131 and 75 also end with terminal 413s; the month has 36 HTTP 413 runs / 17 tasks.
  The guard was prepared on 29 September and held back only because deployment was
  deferred; it is absent from all six deployed workers.
- **Root cause.** Model requests accumulated full-resolution image bytes from workspace
  reads/attachments with only a per-file 20 MiB and 50 MiB combined *source* limit, and
  no final check of the serialized request size. The rejecting component's exact byte
  ceiling is not retained, so the 4 MiB target is conservative rather than measured.
- **Decision.** Commit the prepared guard unchanged (it addresses the cause without
  touching durable history or user files): Sharp-based previews (EXIF-corrected, ≤2000 px,
  ≤600 KiB base64 each, ≤3 MiB combined, ≤5 images), content-keyed preview cache,
  actionable omission notices instead of throws, and a final gate in both model
  transports that counts UTF-8 text, tool schemas and JSON framing and replaces the
  oldest image parts with notices when the request would exceed 4 MiB. HTTP 413 now
  explains payload size. Vision inspection shares the preprocessing and keys its cache
  on omission notes.
- **Dependency.** `sharp@0.35.5` for the worker. The lockfile in this commit was
  regenerated with `pnpm install --lockfile-only --offline` against exactly the
  committed manifests (+307 lines, sharp and its platform packages only), not copied
  from the dirty lockfile that also carries mobile-app dependencies.
- **Files.** `apps/worker/src/model-image.ts` (+test), `sandbox-continuity.ts` (image
  collection), `vision-tools.ts`, `turn-runner.ts` (final gate + 413 message) and their
  tests, `apps/worker/package.json` (sharp only), `pnpm-lock.yaml`.
- **Verification (isolated snapshot, frozen lockfile install).** `@berry/worker...`
  typecheck pass; model-image + sandbox-continuity + vision-tools + turn-runner
  240/240; worker build pass.
- **Deployment.** Not deployed. Worker image must be built from the frozen lockfile so
  Sharp's Linux binaries are present. No API/web/schema change.
- **Remaining (H-011 stays open).** Binary/text decoding (BOM-less UTF-16, PBIX/ZIP/PPSX
  NUL bytes), malformed tool JSON and per-route measured limits are separate. H-042
  (transparent PNG previews keep alpha) is handled as its own change on top of this.
- **Commit.** `39d02c8`.

### H-051 / H-072 — Continue recovers the interrupted run's workspace

- **Evidence.** H-051 task 682: the edited graphic and preview were written, the run was
  cancelled, a complete checkpoint finished at 08:34:54.267, and Continue (08:34:55.462)
  started in a new sandbox without the preview; the audit replayed the exact deployed
  SQL and got neither prior sandbox nor snapshot. H-072 task 676: an unpublished amended
  NDA exists in the interrupted snapshot but Continue excludes it. Month: 129 explicit
  Continue runs; 53 runs / 42 tasks have no eligible prior sandbox or snapshot (lookup
  conditions, not proved file losses).
- **Root cause (confirmed).** Continue admission reuses the interrupted request message
  (`continuableRequestMessageId`) and leaves the journal leaf on the interrupted run's
  entries, so the *conversation* resumes from that work. The worker's
  `SqlSandboxSnapshotRepository.continuity` built its eligible branch from the ancestors
  of `request_message_id`; the user entry carries no `run_id` and the interrupted run's
  own entries/checkpoint leaf are descendants, so neither its sandbox nor its snapshot
  qualified. Conversation and filesystem continued on different branches. H-051 and
  H-072 are the same defect.
- **Fix.** At Continue admission the API records `continuationSourceRunId` and, only if
  the current journal leaf descends from (or is) the continued request message,
  `continuationHeadEntryId`. For runs flagged `continueInterruptedTurn` the worker
  anchors the eligible branch at that head (otherwise at the request message, so normal
  turns, edits and legacy rows behave exactly as before). No unscoped "latest
  checkpoint" fallback; ownership, tenant scope, timestamps and branch checks are
  unchanged.
- **Files.** `apps/api/src/runtime/durable-turn.service.ts`, `apps/worker/src/sandbox-continuity.ts`,
  their unit tests (SQL-text fixtures updated and strengthened to assert the recorded
  source/head), `scripts/test-continue-lineage.mjs` (new real-PostgreSQL regression).
- **Verification.** Real PostgreSQL (isolated snapshot): 4/4 — Continue restores the
  cancelled run's sandbox *and* checkpoint; Continue after a failure before any output
  still restores earlier completed work (healthy path); editing an earlier message
  never inherits descendant workspace state; a head on an unrelated branch is not
  trusted. **Regression proof:** scenario 1 against the pre-fix build fails with
  "continuation must see the interrupted workspace". API runtime suite 61/61, worker
  `sandbox-continuity` + `turn-runner` 213/213, API/worker typecheck pass; queue suite
  still 8/8.
- **Deployment.** Not deployed. Compatible in either order: an old API writes no head
  (worker falls back to the request message); an old worker ignores the new fields.
- **Remaining.** Missing historical image paths still abort model preparation (H-046);
  phase-aware Continue instructions and exhausted allowances are H-048/H-066/task 176.
  Recovery for continuation runs admitted before deployment uses the old lookup.
- **Commit.** `e6b2fa8`.

### H-066 — Operator recovery reopens a turn with a settled budget

- **Evidence.** Five runs / five tasks / four users (30 Sep–12 Oct) end with "The budget
  reservation for this turn is no longer active", each right after an explicit operator
  Retry; tasks 1187, 1158 and 983 delivered no requested answer, and all five runs were
  recorded `completed`. All five reservations were reconciled before the retry.
- **Reproduced on `e6b2fa8`** (real PostgreSQL + real worker, `scripts/test-recovery-budget.mjs`):
  a budgeted run whose mutating tool loses its receipt reaches `recovery_required`; its
  reservation is reconciled (actual 5000). After `recover(retry)` the worker refuses the
  next model call and the run ends `completed` with "I stopped because the budget
  reservation for this turn is no longer active. Increase the applicable allowance…" —
  the exact production signature.
- **Root cause (confirmed).** Terminal settlement for `recovery_required` reconciles the
  run's reservation; `DurableTurnService.recover` reopens the same run without any budget
  admission; `reserveNextModelCall` correctly refuses a settled reservation; and
  `finishForBudget` reports that lifecycle refusal as an allowance problem and marks the
  run completed.
- **Fix (no reactivation, no double billing).**
  - API: Retry/Mark complete reserve a new budget generation `<base request>:recovery:<n>`
    through the normal `BudgetService.reserve` (billing health + hard limits) *before*
    reopening, and record a baseline in the run's runtime request (last journal event
    sequence and settled cost). The settled reservation and its ledger stay untouched.
    The controller releases the new reservation if recovery does not go through; Cancel
    reserves nothing and stays terminal.
  - Worker: reservation extension subtracts the settled baseline (only the new
    generation's usage plus the next estimate is reserved); terminal settlement (worker
    and API paths) counts only usage events after the baseline, so each generation gets
    exactly one `usage_events` row and one reserve/reconcile ledger pair.
  - Inactive or missing reservations now fail the run with an accurate message ("…your
    work so far is saved. Continue the task or send a new message…") instead of
    `completed` + "Increase the applicable allowance". Genuine spend-limit stops are
    unchanged.
- **Files.** `apps/api/src/runtime/durable-turn.service.ts`, `apps/api/src/http/agent-api.controller.ts`
  (recovery endpoint hunk only), `apps/worker/src/turn-runner.ts`, `apps/worker/src/turn-runner.test.ts`,
  `scripts/test-recovery-budget.mjs`.
- **Verification (isolated snapshot).** Real PostgreSQL 4/4: Retry and Mark complete each
  reach the next model call and answer; reservations are `<req>` reconciled 5000 and
  `<req>:recovery:1` reconciled 7000; usage rows 5000 + 7000; org ledger total 12000 over
  exactly four entries (no duplicates/refunds); a true hard limit still blocks recovery,
  leaves the run `recovery_required` and no active reservation; Cancel stays terminal with
  no new reservation. Continue-lineage 4/4 and queue 8/8 still pass. Unit: worker
  turn-runner/outbox/sandbox-continuity 232/232 (new: inactive reservation fails honestly;
  extension excludes the settled baseline), API runtime/controller/budget 146/146;
  API/worker typecheck pass.
- **Deployment.** Not deployed. Deploy API and worker together: a new API with an old
  worker would bill the whole run again at the second settlement; an old API with a new
  worker behaves as today. Runs already stuck in `completed` with the inactive-reservation
  message are not changed retroactively.
- **Remaining.** Spend-limit stops are still recorded as `completed` (outcome labelling,
  H-034/H-014); distinct user-facing actions per refusal type are not yet surfaced in the
  web UI.
- **Commit.** `2a7af6b`.

### H-048 — Provider-error placeholders replayed as assistant history

- **Evidence.** Task 464: eight Gemini HTTP 400 failures; after switching to MiniMax the
  run made a successful call (26,884 input / 24 output tokens) whose whole answer was the
  earlier provider-configuration error; the run completed and the question went
  unanswered. One exact-text match in the month (narrow detector, not a rate).
- **Reproduced on `2a7af6b`** (real PostgreSQL, `scripts/test-provider-error-history.mjs`):
  a provider 400 fails the run and leaves an assistant message with an `error` part;
  the next admission's `syncMessageJournal` projects it into the journal and the next
  model history contains "The model provider rejected the request (HTTP 400)…" as an
  assistant turn.
- **Root cause (confirmed).** `projectMessageParts` (API) mapped every non-special part,
  including `error`, to `{type:"text"}`; the worker's `modelMessages` forwards assistant
  text regardless of `stopReason`. The failure diagnostic therefore became something
  "the assistant said".
- **Fix (structural, not keyword-based).** New projections keep error parts typed
  (`{type:"error"}`), which the history builder never forwards. For journal rows already
  projected in the old shape, the worker skips assistant entries that are failed
  projections (`projectionSource:"messages"` and `stopReason:"error"`) unless they carry
  tool calls. Partial output the worker journals itself (stopReason `failed`/`cancelled`),
  tool results and all user text — including a user quoting the error — are unchanged.
  The UI transcript still shows the error.
- **Files.** `apps/api/src/runtime/durable-turn.service.ts` (one branch),
  `apps/worker/src/turn-runner.ts` (history builder), `apps/worker/src/turn-runner.test.ts`,
  `scripts/test-provider-error-history.mjs`.
- **Verification (isolated snapshot).** PostgreSQL 1/1 (error visible to the user, absent
  from the next model history, pending question last); unit test covering legacy text
  projection, typed projection, a worker partial and a user quoting the error. Both fail
  on the pre-fix code. API runtime 61/61; worker turn-runner/compaction/sandbox 233/233;
  recovery-budget 4/4, continue-lineage 4/4, queue 8/8; API/worker typecheck pass.
- **Deployment.** Not deployed; API and worker are independent (either order is safe).
  Removing these placeholders changes the serialized history of sessions that contain
  failures once (one cache miss), which is intended.
- **Remaining.** Compaction's fallback summary can still quote failed-projection text;
  a "no answer" outcome state for responses that only restate a platform error is not
  added.
- **Commit.** `49815ef`.

### H-014 — Continue answers the pending request (phase-aware continuation)

- **Evidence.** Audit finding 5 / task 176: a new "focus on remote monitoring" request
  failed with Gemini HTTP 400 before any output; Continue kept the correct
  `request_message_id` but replied with a pointer to an old comment and no revised draft.
  The continuation run always added the system line "Continue the interrupted assistant
  response from the persisted partial output…" and a synthetic user turn "Continue the
  interrupted response from where it stopped", even when no response to the latest
  request had begun. (The exact wire request for task 176 is not retained; causal
  contribution is rated medium by the audit.)
- **Cause (code-confirmed).** `modelMessages` emitted the same partial-output
  continuation instructions regardless of what the interrupted attempt produced, so with
  no partial output the nearest "interrupted response" in history was an earlier answer.
- **Fix.** Derive the continuation phase from the journal after the continued request
  message: `no_response` (nothing, or only failed-provider projections — see H-048),
  `partial_response` (assistant text), or `after_tools` (tool calls/results). For
  `no_response` the instruction says to answer the latest message and no synthetic
  "continue" user turn is added (the pending request stays the last message); the
  partial-output wording is unchanged; after tools, the model is told to finish from the
  completed results. Unknown anchors keep the historic wording.
- **Files.** `apps/worker/src/turn-runner.ts`, `apps/worker/src/turn-runner.test.ts`.
- **Verification (isolated snapshot).** Worker typecheck pass; turn-runner + compaction
  138/138. The new no-response and after-tools tests fail against the previous source;
  the partial-output test passes on both (preserved behaviour).
- **Deployment.** Not deployed (worker only).
- **Remaining (H-014 stays open).** Live model evaluation of the Continue wording;
  operation-specific recovery UX; distinguishing completed vs unknown external outcomes
  in the Continue instruction (recovery-required runs use operator recovery instead).
- **Commit.** `eda27eb`.

### H-046 / H-060 / H-071 — Historical image paths, re-read recency and silent omission

- **Evidence.** H-046: tasks 1103 (temp image deleted), 774 (moved to `tmp`) and 956
  (first generation removed) each fail at the *next* model preparation in 0.2–0.8 s
  although the replacement work was already delivered; 26 monthly runs / 21 tasks match a
  missing path to a completed same-run read or generation. Tasks 100/103/114: nonexistent
  or mistyped image paths reported as successful reads. H-060: task 219 and 658 re-read
  older images that stay excluded, forcing filename copies. H-071: task 1217 reads 7–8
  images per batch; the first ones are silently dropped although each receipt promised
  attachment (13 over-five exposures / 9 tasks in the month).
- **Root causes (code-confirmed, worker `sandbox-continuity.ts`).**
  1. The `read` image branch returned success from the file extension alone.
  2. `exposedSandboxImagePaths` kept every completed read/generation path and
     deduplicated with `new Set`, i.e. by *first* occurrence, then kept the last five —
     a re-read never renewed recency and a large batch silently lost its first images.
  3. `modelContent` loaded those historical paths with an uncaught `Promise.all`; one
     moved or deleted file rejected the whole model preparation and failed the run.
- **Fix.**
  1. Image reads confirm the file exists and is non-empty via a parent-directory listing
     (no byte transfer) and otherwise fail with a repairable "File not found: … list its
     directory" error.
  2. Selection ranks by most recent read; images read since the last completed model call
     that do not fit the five-image window are reported as `[Image not sent: …; read this
     image again on its own or in a batch of at most 5]`. Older, already-delivered images
     rotate out silently as before (no notice noise).
  3. A historical image that no longer exists becomes `[Image not sent: …; the file no
     longer exists at this path…]` instead of an exception; other images still load.
     Explicit `inspect_images` requests for a missing path still fail with "could not load
     the exact requested image path" (never a silent visual check). Non-missing provider
     errors still propagate.
- **Not done (deliberately).** Persisting immutable image bytes at read time (the audit's
  fuller proposal) would add storage, retention and ACL design; the omission notice meets
  the acceptance criterion ("preserves acquired content *or* clearly reports omission
  without a terminal crash").
- **Files.** `apps/worker/src/sandbox-continuity.ts`, `apps/worker/src/sandbox-continuity.test.ts`
  (existing binary-read fixture now returns a directory listing; its assertion that image
  bytes never go through the UTF-8 reader is unchanged).
- **Verification (isolated snapshot).** Worker typecheck pass; full worker suite 922
  passed / 6 skipped (baseline 908). The five new tests (missing path read, moved/deleted
  earlier image, re-read recency, 7-image batch disclosure, explicit missing inspection)
  all fail against the previous source.
- **Deployment.** Not deployed (worker only).
- **Remaining.** Same-path overwrite/version binding (H-046 task 956 note) and splitting
  oversized batches into multiple inspection groups automatically.
- **Commit.** `f2bace0`.

### H-009 — A delivered text answer must not fail on an unavailable sandbox

- **Evidence.** Audit finding 4 / task 176 run `87582f47…`: the run delivered its text and
  editable draft, then failed with sandbox-not-found although no file was requested. The
  exact throw site is not retained.
- **Cause (code-confirmed).** `SandboxContinuityManager.finalize` ensures (resumes or
  restores) the run's associated sandbox and scans `outputs/` whenever the run has any
  sandbox id — including one inherited from an earlier turn. If ensuring fails, the
  exception propagates through `DurableTurnRunner.finalize` and the completed answer is
  recorded as a failed run.
- **Fix (conservative).** Behaviour is unchanged whenever the sandbox is reachable (the
  scan still publishes any unpublished outputs). If ensuring or scanning fails *and the
  run executed no tool able to write files* (only read/find/ls/grep, skill activation,
  questions, compose, image inspection/creation, explicit publication or memory/skill
  saves), finalisation completes without the scan and emits a
  `sandbox.operation` event (`finalize.output_scan` / `skipped_sandbox_unavailable`).
  Unknown tools (MCP, skills, future built-ins) count as possibly writing. Runs that ran
  bash/write/edit still fail visibly, so genuinely lost outputs are never hidden.
- **Files.** `apps/worker/src/sandbox-continuity.ts`, `apps/worker/src/sandbox-continuity.test.ts`.
- **Verification (isolated snapshot).** Worker typecheck pass; sandbox-continuity +
  turn-runner 227/227. New cases: text-only and read/draft-only runs complete when the
  sandbox cannot be resumed (both fail on the previous source); a run that executed bash
  still fails.
- **Deployment.** Not deployed (worker only).
- **Remaining.** Skipping the resume entirely for text-only follow-ups would save
  latency/cost but changes when leftover outputs are published; it needs measurement
  first (audit H-013). Snapshot-timeout cancellation is H-010.
- **Commit.** `91208bc`.

### H-075 — Internal connector session expires while the run still uses it

- **Evidence.** Task 139 run `f6a54…`: seven invalid/expired Google connector calls after a
  long model interval, repeated waits and advice to reconnect Google; a fresh run works
  without reconnecting. Deployed API/worker modules match local code (audit SSM check).
  Exact token age for the incident is not retained.
- **Root cause (code-confirmed).** `ConnectorsService.runtime` signs a task-scoped
  internal session with `exp = now + 20 min` at turn admission; the worker keeps that
  credential for the whole run (`mcp-tools.ts` turn context, no renewal); and
  `handleGoogleMcp` rejects it as "Connector token is invalid or expired" *before* the
  Google OAuth refresh, which the model then reports as a Google reconnect problem.
- **Fix (API only, bounded).** Past its 20-minute lease, a *task-scoped* session is
  accepted only while its run is still active (not completed/failed/cancelled/
  recovery_required), the user still owns the non-deleted task and is an active,
  non-deprovisioned tenant member — re-checked on every call — and never beyond a 24-hour
  hard cap from expiry. Signature, audience, connector enablement, Google connection
  status, access level and scopes are still checked per call exactly as before, so
  revoked Google authorization still fails and still needs Reconnect. Sessions without
  task scope keep strict expiry. A non-renewable expiry now says explicitly that it is not
  a Google sign-in problem. No longer-lived tokens are minted and the worker (and its
  discovered-tool state) is unchanged.
- **Files.** `apps/api/src/connectors/connectors.service.ts`, `apps/api/src/connectors/connectors.service.test.ts`.
- **Verification (isolated snapshot).** API typecheck pass; connectors + http suites
  168/168. Fake-clock tests on a really minted token: usable at 35 minutes and at 23 hours
  while the run is active (one run-state lookup with tenant/task/session/user); no lookup
  while the lease is valid; ended run / removed access, past the hard cap, and no task
  scope all end with the explicit non-Google message; a tampered signature is still
  rejected. The active-run cases fail on the previous source. The lookup SQL was
  prepared and executed against the migrated PostgreSQL schema.
- **Deployment.** Not deployed (API only; worker unchanged).
- **Remaining.** A per-run credential refresh in the worker would also cover runs longer
  than 24 hours; not needed for the observed incident. Safe-read auto-retry after a
  transient connector error is separate (H-003).
- **Commit.** `d95b252`.

### H-031 — Blob-deletion receipt fails PostgreSQL parameter inference (P0 maintenance)

- **Evidence.** 834 monthly `file.delete-blob` dead letters; ≥4,805 matching failures in
  the latest 5,000 retained Redis failed jobs; stack traces reach `acknowledgeBlobOutbox`
  after the remote deletion; read-only PREPARE in production reproduced it.
- **Reproduced locally.** `PREPARE` of the exact statement on PostgreSQL 16:
  `ERROR: could not determine data type of parameter $4` (the nullable note appears both
  as `last_error = $4` and in `CASE WHEN $4 IS NULL`).
- **Fix.** Type the parameter (`$4::text`) in both places. A repository-wide scan for the
  same untyped `$n IS NULL` pattern found one other statement
  (`cloud-task-store.ts`), whose parameters are already typed earlier in the statement —
  not a defect.
- **Files.** `apps/worker/src/file-blobs.ts` (cast + export for the test),
  `scripts/test-blob-receipt.mjs` (real PostgreSQL regression).
- **Verification (isolated snapshot).** Worker typecheck pass; file-blobs/file-deletion/
  outbox 41/41; PostgreSQL 4/4 (successful deletion with null note, cancelled with note
  and category, duplicate delivery idempotent, lost lease still rejected). With the
  previous SQL the same script fails with `could not determine data type of parameter $4`.
- **Deployment.** Not deployed (worker). New deletions will record receipts once
  deployed.
- **Not done (needs its own reviewed plan).** Reconciling the historical dead-letter
  backlog: the remote objects may already be deleted, so replay must check immutable
  object version, live references, tenant and lease; no production rows were touched.
- **Commit.** `f30b651`.

### H-033 — Deployed revision rejected by the telemetry validator

- **Evidence.** 1,924 monthly runs record revision `unknown`; every inspected worker
  environment uses a build revision containing `+production-hotfixes`.
- **Root cause (confirmed).** `sourceRevisionFromEnv` and the operational-log field filter
  both accepted only `[A-Za-z0-9._/-]`, so any revision with `+` build metadata became
  `unknown`.
- **Fix.** One shared pattern that also allows `+`; spaces/shell metacharacters are still
  rejected.
- **Files.** `packages/shared/src/operational-telemetry.ts` (+test).
- **Verification (isolated snapshot).** shared/worker/API typecheck pass; shared suite
  122/122; the new `<sha>+production-hotfixes` assertions fail on the previous source.
- **Deployment.** Not deployed; takes effect when API and worker are rebuilt.
- **Remaining (H-033 stays open).** Unique provider-attempt identities and an immutable
  release/hotfix manifest belong with the cache instrumentation (H-032). Note that the
  revision string itself cannot prove what code runs (see the H-014 parity finding).
- **Commit.** `52c0260`.

### H-032 (part 1) — Cache metrics that do not overstate savings

- **Evidence.** Final window: 87.41% of main calls read *some* cached input, but only
  17.81% of input tokens were served from cache. The admin dashboards preferred a
  "Cache hit rate" computed as `hit ∧ eligible / eligible`.
- **Root cause (code-confirmed).** The worker recorded `cacheEligible = plan.eligible ||
  cacheReadTokens > 0` (and the prompt-improvement path `cacheEligible = cacheReadTokens > 0`),
  so every observed hit was also "eligible"; for routes without declared cache
  capability the dashboard's hit rate was effectively hits/hits. The analytics query
  also only counted hits that were flagged eligible.
- **Fix.** Record declared eligibility only; count requests with any cache read
  independently of eligibility; make **cached input-token share** the primary
  dashboard metric (correct on historical rows, which are not rewritten), with the
  any-hit request count as a hint; the request hit rate is only a fallback when token
  totals are missing.
- **Files.** `apps/worker/src/turn-runner.ts` (one line), `apps/api/src/http/agent-api.controller.ts`
  (prompt-improvement hunk only), `apps/api/src/usage/usage.repository.ts` (two analytics
  hunks only), `apps/web/src/components/management/usage-controls.tsx` (+test).
- **Verification (isolated snapshot).** worker/API/web typecheck pass; worker
  turn-runner 121/121; web usage-controls 5/5 (new: the audit's 87%-any-hit / 17.8%-token
  shape reports 17.8% token share); API usage repository + controller suites pass except
  the 4 pre-existing `usage.controller.test.ts` failures listed in the baseline section.
- **Deployment.** Not deployed.
- **Remaining.** See H-032 part 2 (prompt-prefix stability) below.
- **Commit.** `29dd951`.

### H-032 (part 2) — Diagnostics needed to split cache misses by route

- **Findings (code-confirmed).**
  1. `RouterDurableTurnModel` ignored `chunk.attribution`, so usage events never carried
     the router-attributed serving provider (and only the response `model` for the
     served model). The audit's unresolved split (394 severe drops with unchanged
     tracked prefixes) needs exactly this to compare backends/affinity.
  2. The miss classifier judged `long` retention against 1 hour while the wire request
     asks for `prompt_cache_retention=24h`, so 1–24 h gaps were mislabelled
     `cache_expired`.
  3. Already correct, no change: the router client keeps a measured cache-read count when
     a later stream chunk omits it (in `99964f1`); tool definitions are sorted
     canonically; per-message request-prefix hashes are recorded.
- **Fix.** Record `servedProvider` and the attributed `servedModel` from router
  attribution when present; long retention uses 24 h.
- **Files.** `apps/worker/src/turn-runner.ts` (attribution hunks only), `apps/worker/src/prompt-cache.ts`, and tests.
- **Verification (isolated snapshot).** Worker typecheck pass; prompt-cache + turn-runner
  130/130 (new: 2 h after a long-retention call is `unknown`, 25 h is `cache_expired`;
  attribution reaches the usage event).
- **Deployment.** Not deployed (worker).
- **Out of scope here.** The hosted Berry Router (separate product/repository) and the
  upstream provider's cache routing/affinity cannot be changed or verified from this
  repository; served-route header names emitted by the hosted Router remain unverified.
- **Commit.** `3a27931`.

### H-032 (part 3) — Keep per-turn context out of the stable prompt prefix

- **Evidence.** Audit cause register: the first system message combined stable text with
  per-turn grounding, routed tool guidance, intent, recovery and automatic skill
  guidance; first-message changes were confirmed (30 calls at 1.17% coverage) and the
  first call of every run/model covered 2.24%. The audit also notes 394 severe drops
  with *unchanged* tracked prefixes, so this change cannot explain or fix all loss.
- **Measured before change (offline, deterministic).** `scripts/measure-prompt-prefix.mjs`
  renders real upstream requests (actual `modelMessages`, tool definitions and wire
  serialisation; system text before tools as in DeepSeek/Qwen templates) for synthetic
  sessions and reports the share of each request that is an exact prefix of an earlier
  one — the ceiling a provider prefix cache could reach, not a provider measurement.
  Before: within-run later calls already reuse 89–95%; the **first call of each
  follow-up turn reuses only 6.6–19%** because grounding changes inside the system
  message. Candidate placements were compared on a 6-turn × 6-call session: context at
  the very end 91.8% overall / 91.7% later calls; context right after the request
  90.7% / 94.8% (within-run reuse unchanged) — chosen as the smaller behavioural change.
- **Fix.** The system message now holds only session-stable text (stable prompt, profile,
  installed skills, direct-vision note, runtime environment). Per-turn items move, in
  their original order, into a `<berry_turn_context>` **user-role** message placed right
  after the turn's request message (user role because several chat templates hoist
  system messages to the front). The rare empty-response recovery note is appended at
  the end. If the request message is not in the uncompacted journal (legacy/compacted),
  the prompt is assembled exactly as before. Continue's phase is now judged against the
  admission-time journal head so it cannot change mid-run.
- **Measured after (same harness, pre-change build `29dd951` vs this change).**

  | Synthetic scenario | Overall reusable | Later calls | First call of follow-up turns |
  | --- | --- | --- | --- |
  | 6 turns × 6 calls, 4 KB grounding, 8 KB tool results | 82.0% → **90.8%** | 94.8% → 94.8% | 6.6% → **69.4%** |
  | 3 × 4, stable tools | 73.8% → 80.4% | 89.1% → 89.2% | 18.4% → 57.1% |
  | PDF skill guidance activates mid-run | 71.5% → 79.3% | 86.1% → 88.2% | 19.2% → 55.1% |
  | MCP discovery adds tools mid-run | 69.6% → 75.7% | 83.9% → 83.3% | 18.3% → 57.3% |
  | Five images re-sent at the tail | 57.4% → 62.6% | 65.6% → 65.7% | 18.4% → 57.1% |

- **Files.** `apps/worker/src/turn-runner.ts` (`modelMessages`, `continuationPhase`),
  `apps/worker/src/turn-runner.test.ts` (new layout tests; Continue tests now read the
  instruction from the turn context), `scripts/measure-prompt-prefix.mjs`.
- **Verification (isolated snapshot).** Worker typecheck pass; full worker suite 948
  passed / 6 skipped; PostgreSQL suites (queue 8, continue-lineage 4, recovery-budget 4,
  provider-error-history 1) pass. New tests: system message identical across turns when
  grounding/routed tools change and earlier turns reused verbatim; within-run calls only
  append; recovery text only at the end; legacy fallback unchanged.
- **Not yet measured (blocked on authorised live access).** Provider-reported cache
  coverage, TTFT, cost and answer quality per route (DeepSeek V4 Flash, Qwen 3.8 Flash
  Next, MiniMax M3) with and without this change. This is a prompt-layout change:
  grounding and tool guidance now arrive as Berry-labelled user-role context rather than
  system text, so a paired behavioural evaluation is required before rollout. No
  billable provider calls were made.
- **Remaining contributors.** MCP discovery still changes tool membership mid-run (needs a
  stable permission-scoped tool surface — a design decision with tool-selection-quality
  trade-offs); images re-sent at the tail each call; provider routing/affinity for the
  unchanged-prefix drops (needs the new `servedProvider` data plus hosted Router access).
  The 85–90% warm target cannot be claimed until live data exists.
- **Commit.** `9eecde6`.

### H-064 / H-007 — Stage what a skill entry point needs, progressively

- **Evidence.** Task 821: activating the DOCX generator staged `create_aesg_docx.py` and
  some branding assets but not its helpers; the run hit FileNotFoundError for
  `report_structure.py`, then ModuleNotFoundError for `normalise_office_templates`, before
  a third activation succeeded (generation itself took 9.83 s). Month: 391 missing-helper
  bash-step candidates / 261 tasks / 84 users (258 `office_converter`, 83 `normalise_office_templates`,
  51 `report_structure`) — symptom counts, not 391 proved staging defects.
- **Current implementation (inspected before designing).** Already correct and kept:
  metadata-only activation returns the inventory without touching a sandbox;
  resource activation stages only requested paths plus SKILL.md; content-addressed
  `runtime-skills/<id>-<revision>` roots invalidate changed packages; every file is
  hash/size verified; tenant-scoped package queries. Missing: no entry-point dependency
  closure, reuse only within one run, no protection against trusting a file left
  partially written by an interrupted transfer, no transfer accounting.
- **Fix (extends the existing stager).**
  - *Sibling closure:* a requested `.py` resource also stages same-package modules it
    imports (plain/`from`/relative/parenthesised/function-local imports, packages'
    `__init__.py`), transitively. Standard-library/third-party names are ignored; nothing
    is guessed outside the package.
  - *Declared dependencies:* optional `skill-dependencies.json` (version 1) declares,
    per entry point, extra same-package resources and resources of another skill.
    Cross-skill resources are staged into that skill's own activated directory (only if
    the skill is admitted to this run; otherwise an actionable error before execution),
    with its own sibling closure; cycles/depth > 3 are rejected.
  - *Readiness and handles:* the receipt reports `readiness: "ready"`, `addedResources`,
    `dependencies[{skill, directory, resources}]` and a `<resolved_dependencies>` block
    telling the model the exact directory to pass; failures name the missing piece.
  - *Reuse and integrity:* when ≥256 KiB is still to transfer, one `sha256sum` exec over the
    content-addressed root reuses files whose bytes still hash to the package revision
    (later runs, same sandbox) — partial, edited or deleted files are re-sent; small
    script-only activations skip the extra round trip. Concurrent activations in a worker
    share one in-flight transfer. Files staged as another skill's dependency count as
    staged for that skill within the run.
  - *Accounting:* `transfer {files, bytes, reusedFiles, reusedBytes}` per activation.
  - Large optional templates are never added by closure; they stage only when requested
    or declared required.
- **Measured (in-memory sandbox, real activation/staging code; wall time is not real E2B latency).**

  | Scenario | Provider calls | Bytes transferred | Bytes reused |
  | --- | --- | --- | --- |
  | Metadata-only activation | 0 | 0 | 0 |
  | Script + 2 sibling imports + declared cross-skill helper (+ its sibling) | 4 | 957 | 0 |
  | Operation needing the 6 MiB template, cold | 3 | 6,291,539 | 0 |
  | Same template in a later run (warm) | 2 | 0 | 6,291,539 |
  | Changed dependency version | 4 | 960 (new directory) | 0 |
  | Retry after an interrupted transfer | 3 | 6,291,539 | 0 (partial file not trusted) |
  | Two concurrent activations of the template | 4 + 4 | 6,291,539 once | — |

- **Files.** `apps/worker/src/personal-skills/dependencies.ts` (+test),
  `apps/worker/src/personal-skills/tools.ts` (+test), `apps/worker/src/sandbox-continuity.ts`
  (+test), `apps/worker/src/turn-runner.ts` (transfer type), `apps/worker/src/skill-staging.test.ts`.
- **Verification (isolated snapshot).** Worker `...` typecheck pass; full worker suite 959
  passed / 6 skipped. The end-to-end test executes the staged entry point with Python
  (sibling imports + cross-skill helper resolve; output "Report Ready"). Six of the seven
  end-to-end cases fail on the previous sources; metadata-only activation passes on both.
- **Deployment.** Not deployed (worker).
- **Pending (next commit for this issue).** `skill-dependencies.json` for the AESG `docx`
  (generator and repair → `aesg-branding` `report_structure`, `normalise_office_templates`,
  `office_converter`) and `pdf` (`create_aesg_pdf` → `office_converter`) packages are written
  but not committed: they reference `aesg-branding/scripts/report_structure.py`, which is
  published in production (task 821 staged it) but exists here only as an uncommitted,
  prepared file owned by the AESG skill work. They land with that review; publishing them
  is a skill-package sync, not a code deployment. Against the working-tree packages the
  manifests resolve every helper for all four Office entry points without staging
  templates, and every staged script compiles.
- **Commit.** `f6f9074`.

### H-068 — Connector import reports ready before the file can be used

- **Evidence.** 217 of 270 first Drive-import receipts in the month (80.37%) returned no
  sandbox path (49 tasks / 14 users); task 559 then probed the filesystem three times;
  timestamp correlations in tasks 1191 (75 ms), 1172 (472 ms), 1189 (~73 ms) and 1217
  (~351 ms) show the receipt completing before blob verification. One counterexample
  (an already verified blob) shows timing is not the only cause.
- **Root cause (code-confirmed).** `importConnectorArtifact` returns before its blob is
  verified; the worker's `stageAssociatedInputFiles` read the verified-only input list
  once and returned an empty list; the MCP wrapper then reported a successful download
  ("stored as a task-scoped Berry artifact") with no path or next step. Attachments
  already have a bounded verification wait; imports did not use it.
- **Fix.** Imports wait for verification with a 30 s bound and 250 ms polls (attachments
  keep 75 s / 1 s), never reading unverified bytes. If still unverified, the receipt says
  so explicitly ("still verifying… call this import again for the same file… do not
  search the filesystem") and carries `stagingStatus: "pending_verification"` (or
  `"ready"`). Executors without staging keep the previous wording.
- **Files.** `apps/worker/src/sandbox-continuity.ts`, `apps/worker/src/mcp-tools.ts`, and tests.
- **Verification (isolated snapshot).** Worker typecheck pass; full worker suite 963 /
  6 skipped. New: an import verified on the second poll is staged; one still unverified
  at the deadline returns no path without staging; pending receipt wording. Two of
  these fail on the previous source.
- **Deployment.** Not deployed (worker).
- **Remaining.** The audit's counterexample (missing path with an already-verified blob)
  and the API-side typed pending state are not addressed; H-069 (Library persistence)
  is separate.
- **Commit.** `f2923b2`.

### H-069 — Temporary connector imports silently added to Library

- **Evidence.** 261 of 270 first Drive-import receipts said `library=false`, yet every one of
  those files had an active Library entry created at file-insert time (54 tasks / 17 users;
  1.5 GB logical size, not proven safe to delete). Task 1191's repeat import then reported
  `library=true`, revealing the existing entry.
- **Reproduced locally.** Real PostgreSQL with the production migrations: a temporary
  import through `FilePlatformService.importConnectorArtifact` leaves one Library row
  (`scripts/test-connector-import-library.mjs` fails with actual 1, expected 0 on the old
  code). The existing unit test could not see this because the row comes from a trigger.
- **Root cause (confirmed).** Migration 44's `files_library_after_insert_compat` trigger
  inserts a Library entry for every new owned file regardless of origin; the API's
  connector path correctly only calls `reviveLibraryEntry` for `saveToLibrary=true`, but
  the trigger overrides that choice.
- **Decision.** The audit suggests narrowing the trigger through a reviewed migration. I
  chose the smaller change with no DDL: in the same transaction that creates a *new*
  temporary connector import, delete the Library row the trigger just created for that
  file (no FKs or triggers depend on Library rows; nothing else is touched). Explicit
  saves still upsert their entry. This avoids a migration that would also collide with
  the uncommitted migrations 71–73 in this checkout. Narrowing the trigger remains the
  cleaner long-term option.
- **Files.** `apps/api/src/files/file-platform.service.ts` (one hunk), its unit test (one
  hunk), `scripts/test-connector-import-library.mjs`.
- **Verification (isolated snapshot).** API typecheck pass; files suites 59/59; PostgreSQL
  3/3 (temporary import has no Library row and is still a task input, repeat import stays
  temporary; explicit save adds exactly one entry; saving a previously temporary import
  adds it). Old code fails the first scenario.
- **Deployment.** Not deployed (API).
- **Not done (needs its own reviewed plan).** Historical temporary imports already in
  users' Libraries are not removed; later deliberate saves cannot be distinguished
  safely from current membership alone.
- **Commit.** `3104547`.

### H-076 — Shared-drive scope lost during discovery and traversal

- **Evidence.** Task 139: a filename search was empty until the known shared-drive ID was
  supplied; tasks 86/101/114 show related discovery friction. Deployed `google-tools.js`
  matches local source (audit).
- **Root cause (confirmed).** `drive_search_files` used `corpora=user` unless a `driveId`
  was passed — Google's `user` corpus covers files the user created, opened or was
  directly shared, not every file of their shared drives — and `drive_list_children`
  could neither accept nor infer the folder's drive, so shared-drive folders were listed
  in the wrong corpus. `supportsAllDrives` does not carry drive identity.
- **Fix.** Child listing infers the folder's `driveId` with one metadata call (skipped when
  supplied) and lists within that drive; the result returns `driveId` for pagination. An
  unscoped search whose first page is empty retries once with `corpora=allDrives`
  (bounded; Google applies the user's own permissions). Results report `searchScope`
  (`user` / `allDrives` / `drive`) and `incompleteSearch` explicitly; continuation pages
  never widen.
- **Files.** `apps/api/src/connectors/google-tools.ts` (+test).
- **Verification (isolated snapshot).** API typecheck pass; connectors suites 44/44. New
  fetch-mocked cases: shared-drive folder listed in its drive; supplied drive ID kept
  through pagination; empty unscoped search retried across drives with
  `incompleteSearch` surfaced; non-empty and continuation searches not widened; named
  drive searched alone. The first three fail on the previous source.
- **Deployment.** Not deployed (API).
- **Remaining.** Ancestry-aware scope for a *file* (not folder) selected via the picker is
  not inferred; no live Google verification was possible here.
- **Commit.** `920a84c`.

### H-070 — Large MCP results silently cut, cursors lost

- **Evidence.** 86 of 4,137 completed MCP outputs in the month (2.08%) hit exactly 120,000
  characters; 58 were JSON made invalid by the cut; 11 had a next-page token only in
  structured metadata. Task 1189 then invented a page token (HTTP 400) and repeated the
  first page.
- **Root cause (confirmed).** The worker joined MCP text and applied `.slice(0, 120_000)`
  with no receipt; the model only sees that text.
- **Fix.** `boundedMcpText` keeps results within the same 120,000-character budget but:
  JSON stays valid by shortening the largest top-level list (binary search on item
  count), every other top-level field — including the cursor — is kept, a cursor present
  only in structured metadata is restored, and a `berryTruncation` receipt states the
  field, returned/total items and original size. Non-JSON text gets an explicit marker
  with character counts and the exact cursor. Results within the limit are unchanged.
- **Files.** `apps/worker/src/mcp-tools.ts` (+test).
- **Verification (isolated snapshot).** Worker typecheck pass; full worker suite 982 /
  6 skipped. New tests use the audit's shape (100 metadata-heavy Drive records,
  233,454 characters, 444-character cursor): output ≤120,000 characters, parses as JSON,
  exact cursor kept, identifiers are the leading items, cut disclosed.
- **Deployment.** Not deployed (worker).
- **Remaining (H-070 stays open).** Compact per-tool projections (e.g. Drive listings
  without full capability blocks) to fit more items, retrievable handles for omitted
  content, and the journal sanitizer's silent 256-item/128-key limits on stored details.
- **Commit.** `430d396`.

### H-053 — Repeat guard blocks a renderer after its source file changes

- **Evidence.** Task 718: the diagram script was edited between renderer runs that each
  printed the same "saved …" line; the guard suppressed the third run, a cosmetic `ls`
  bypassed it once, and the next identical run ended the task with
  `duplicate_tool_call_loop` (the image was never published). The audit reproduced this
  with the deployed functions. Month: 64 guard steps / 37 tasks, of which 10 steps / 9
  tasks had an intervening write/edit of a file the blocked command referenced
  (condition cohort, not all false positives).
- **Root cause (confirmed).** `assessRepeatedToolCall` counted every earlier identical
  call (same tool + arguments) and its identical result, regardless of edits made to the
  files the command uses in between; once suppressed, the next identical call terminated.
- **Fix.** For `compare_result` tools (bash, read, grep, find, ls, image inspection,
  read-only MCP), earlier identical calls made *before* the latest completed `write`/`edit`
  of a path named in the call's arguments (full path, or a distinctive basename) no longer
  count. `block_after_success` tools (external writes, publication) are untouched, and
  edits of unrelated files reset nothing.
- **Files.** `apps/worker/src/turn-runner.ts`, `apps/worker/src/turn-runner.test.ts`.
- **Verification (isolated snapshot).** Worker typecheck pass; full worker suite 984 /
  6 skipped. New task-718 regression (render → edit → render ×3 with identical stdout)
  runs all four renders; with only unrelated edits the existing bound still suppresses and
  terminates; the existing "third identical bash suppressed, fourth terminates" test is
  unchanged. The regression fails on the previous source.
- **Deployment.** Not deployed (worker).
- **Remaining.** Edits made through bash (e.g. `sed -i`) are not tracked as mutations;
  H-030 (async polling) and H-054 (vision failure classes) are separate fixes.
- **Commit.** `b7b1e94`.

### H-030 — Legitimate asynchronous polling terminated as a loop

- **Evidence.** Task 917: extraction-job reads returned identical `RUNNING` results; the
  third poll was suppressed and the next terminated the run as `duplicate_tool_call_loop`
  after ~170 s of sleeps; changing output format only evaded the signature temporarily.
- **Root cause (confirmed).** Read-only MCP calls get the `compare_result` repeat policy,
  which suppresses after two identical results; the harness's existing `bounded_polling`
  semantics were never applied to job-status reads.
- **Fix.** When the previous identical result reports a non-terminal job state (a
  `status`/`state` field of running, pending, queued, processing, in progress, started,
  scraping or waiting — including the escaped form inside a JSON string field), the
  repeat is allowed as polling. Each identical poll still counts against the existing
  no-progress budget (warning at 3, stop at 5), so a job that never finishes is still
  stopped, now with `no_progress_budget` rather than a loop accusation. Completed/failed
  states and ordinary repeated reads keep the old behaviour.
- **Files.** `apps/worker/src/turn-runner.ts`, `apps/worker/src/turn-runner.test.ts`.
- **Verification (isolated snapshot).** Worker typecheck pass; full worker suite 986 /
  6 skipped. Task-917 regression: RUNNING ×3 then COMPLETED runs all four polls; a job
  that never leaves RUNNING stops on the no-progress budget within six polls. Both fail on
  the previous source. (A first version of the test mis-numbered steps and passed on the
  old code; it was corrected before committing, which also exposed and fixed the
  escaped-JSON case in the detector.)
- **Deployment.** Not deployed (worker).
- **Remaining.** No preserved job handle/recovery action when the budget ends polling;
  backoff is left to the model.
- **Commit.** `1df00a9`.

### H-054 — Vision retry guard ignores the cause of the previous failure

- **Evidence.** Task 843: a provider HTTP 500 on a headshot inspection; the identical retry
  was rejected locally in 0.01 s with no provider attempt, and the model then claimed a
  real headshot from file metadata alone. Month: 9 guard events (four 500s, one 504, two
  fetch errors, two 413s). The audit also found that a completed inspection did not clear
  an older matching failure.
- **Root cause (confirmed).** `latestUnresolvedVisionFailure` blocked any retry of the same
  normalised selection after *any* failure, cleared only by a new image exposure.
- **Fix.** Failures are classified: after a single transient failure (5xx, 408, 429,
  timeouts, connection resets, fetch/network errors, overload, rate limit) one identical
  retry is allowed; a second failure, or any deterministic failure (invalid input, other
  4xx, exhausted empty observations), still blocks. A later successful inspection of the
  same selection, or a newly exposed image, resolves earlier failures.
- **Files.** `apps/worker/src/vision-tools.ts` (+test).
- **Verification (isolated snapshot).** Worker typecheck pass; full worker suite 989 /
  6 skipped. New cases: 500 → one retry reaches the provider; 500 + 504 → blocked without
  a provider call; a completed inspection resolves an earlier 400. Existing guard tests
  (empty observation blocks; latest matching failure) unchanged. Two of the new cases fail
  on the previous source.
- **Deployment.** Not deployed (worker).
- **Remaining.** Retry backoff/provider retry-after handling, and explicit 413/401/402
  recovery guidance in the error text.
- **Commit.** `e4bc64b`.

### H-011 — Binary and UTF-16 reads fail the run in the JSONB journal

- **Evidence.** Month: 15 terminal `unsupported Unicode escape sequence` runs / 13 tasks /
  7 users. Reviewed run `05c124d3…` reads a `.skill` ZIP; PPSX reads take the same path.
  On real PostgreSQL, `SELECT '{"content":"PK\u0003\u0004\u0000"}'::jsonb` fails with
  exactly that error, while U+FFFD is accepted.
- **Root cause (confirmed).** `read` sends any file whose extension is not in
  `binaryMediaType` through the in-sandbox UTF-8 line reader. Binary bytes decode to text
  containing U+0000, the tool result is journaled as JSONB, the write is rejected and the
  run fails. `.skill`, `.pbix`, `.epub` and Office variants such as `.ppsx` were missing
  from the extension map; UTF-16LE text (Windows exports) carried NULs the same way.
- **Fix.**
  1. The in-sandbox reader sniffs the first chunk. A UTF-16LE BOM, or the UTF-16LE NUL
     pattern of mostly-ASCII text, decodes as UTF-16LE (correct lines, CRLF and offsets;
     `encoding: "utf-16le"` in the details). Any other NUL in the first 8000 bytes (git's
     rule) returns `{ binary, sizeBytes }` without content, and the worker answers with a
     binary receipt and inspection guidance instead of text.
  2. `.skill`, `.pbix`, `.pbit` and `.epub` use the existing safe ZIP extraction;
     `.docm`, `.dotx`, `.xltx`, `.pptm`, `.potx` and `.ppsx` use the existing document
     extractor.
  3. Backstop: `journalSafeToolResult` replaces U+0000 with U+FFFD in any tool result
     (values and keys) before it is journaled, and tool-failure messages get the same
     replacement, so a NUL from bash, an MCP server or a later chunk cannot fail a run.
- **Files.** `apps/worker/src/sandbox-continuity.ts`, `apps/worker/src/turn-runner.ts` and
  their tests; `scripts/test-binary-tool-output.mjs` (real PostgreSQL).
- **Verification (isolated snapshot).** Worker typecheck pass; full worker suite 995
  passed / 6 skipped (989 before; six new cases: reader decoding UTF-16LE with and without
  a BOM and reporting ZIP bytes as binary, UTF-8 unchanged; worker binary receipt;
  `.skill`/`.ppsx` routing; NUL in a tool result and in a tool error; clean results
  returned unchanged). PostgreSQL script 1/1: a tool returning `PK\u0003\u0004\u0000…`
  completes and the stored step output holds U+FFFD. **Pre-fix:** with the previous worker
  source the same script's run ends `failed` with `unsupported Unicode escape sequence`
  (the production error), and all six unit cases fail.
- **Deployment.** Not deployed (worker). No API, web or schema change.
- **Remaining (H-011 stays open).** Malformed tool-argument JSON and HTTP 400 schema
  failures need their own tracing; XML-spreadsheet content with an `.xls` extension
  (task `08285ac9…`, shared with H-008) still selects the extractor by extension;
  UTF-16BE and BOM-less UTF-16LE in non-Latin scripts are reported as binary rather than
  decoded (previously they failed the run).
- **Commit.** `c4f419b`.

### H-004 — Repair loops across changed arguments (revalidated; no change)

- **Code finding (confirmed).** `matchingToolFailureCount` counts consecutive failures of
  the same tool type with the same argument fingerprint and error identity, so changing a
  path or quoting starts a new count.
- **Existing bounds that still apply.** The no-progress budget (warning at 3, stop at 5
  repeated signature/result pairs), the 200-iteration model limit, per-tool deadlines and
  spend limits. H-053, H-030 and H-054 (committed above) relaxed these guards only for
  specific, evidenced cases, each still bounded.
- **Not established.** The three weekly terminal duplicate-loop failures were ended by the
  existing guard; no trace shows a long loop sustained *because* arguments changed. The
  reviewed long repairs (tasks 538, 539, 523, 80, 748, 1214) mostly succeed after
  argument changes that were genuine repairs, and their errors often embed the changing
  path, so a cross-argument counter would need semantic error normalisation to work at
  all and would risk stopping valid iterative work.
- **Decision.** No change. A safe design needs a targeted reproduction plus a measured
  normalisation of error category and target identity, designed together with
  H-028/H-053 rather than another blanket counter.
- **Next action.** Reproduce one cosmetic-variation loop (for example task 523's mistyped
  file ID) as a fixture, then decide between guidance after repeated equivalent failures
  and a hard stop.

### H-039 — Vision observations cut off at the output limit are accepted and cached

- **Evidence.** Month: 1,535 completed `inspect_images` steps end with
  `finishReason=length` (362 tasks / 106 users; 51.3% of completed cache-miss
  observations with diagnostics; a truncation rate, not a wrong-answer rate). Task 977
  lists 16 of 35 claimed employees before stopping; task 110 accepts a focused answer
  that ended at the limit.
- **Root cause (confirmed in code).** The adapter accepted any non-empty content as the
  observation, cached it, and returned it with no completeness signal; a cache hit then
  served the partial text as a finished answer, and `ON CONFLICT` never replaced it.
- **Fix.** A final finish reason of `length`/`max_tokens` marks the observation
  incomplete: the result carries `vision.complete: false`, a Berry notice after the
  untrusted observation tells the model not to treat it as a complete check and to ask
  a narrower focused question for the rest, the summary says so, and it is **not
  cached**. Complete observations are cached and reused as before (hits report
  `complete: true`). The prompt version moves to `vision-observation-v4` so v3 entries
  of unknown completeness are no longer served.
- **Deliberately not changed.** The first focused call's stable-intent cache key
  (commit `5b334f3`, with its own test) stays: the audit's collision case is a
  code-proven risk with no observed wrong answer, and question-only keys would remove a
  working reuse path. No automatic larger-budget retry: it changes vision cost and
  latency for about half of all inspections and needs a live measurement first.
- **Files.** `apps/worker/src/vision-tools.ts` (+test).
- **Verification (isolated snapshot).** Worker typecheck pass; worker suite (source-only)
  508 passed / 3 skipped. New cases: a length-stopped focused answer is reported
  incomplete, not cached, and recomputed on repeat; a complete answer is still cached
  and the hit reports `complete: true`. Both fail on the previous source.
- **Data impact.** No schema change and nothing deleted. Existing cache rows simply stop
  matching and are removed by the existing `vision_observations` retention phase once
  unused; expect a one-time re-inspection cost for images asked about again.
- **Deployment.** Not deployed (worker).
- **Remaining.** Measured adaptive budget or targeted continuation for truncated
  answers; coverage for multi-page inspections ("stopped on page five"); H-061 (overview
  mode replaces the supplied question).
- **Commit.** `2bd8ff5`.

### H-061 — `inspect_images` silently discards the model's question

- **Evidence.** Month: 703 completed calls in 447 runs / 296 tasks / 100 users passed a
  non-empty question but ran as overview (685 explicit overview, 18 with no mode); task
  142's four exact-text questions all came back as generic digests. Exposure, not a
  wrong-answer count.
- **Root cause (confirmed in code).** The executor treated anything except
  `mode: "focused"` as overview and then sent the fixed digest prompt, and the tool
  schema gave no hint that the question is ignored outside focused mode.
- **Fix.** A question with no mode is answered as a focused question. Explicit overview
  keeps its reusable digest and cache behaviour, but the result now says
  `questionSent: false` and tells the model to call focused mode if the digest does not
  answer it. The same effective-mode rule feeds the H-054 failure signature. The tool
  schema now describes both fields (and drops the misleading `default: "overview"`).
- **Deliberately not changed.** Explicit overview is not silently converted to focused:
  that would lose digest reuse and use the smaller focused output cap for broad
  requests (the audit's caution); the focused cache identity stays as described under
  H-039.
- **Files.** `apps/worker/src/vision-tools.ts` (+test), `apps/worker/src/turn-runner.ts`
  (tool schema text only).
- **Verification (isolated snapshot).** Worker typecheck pass; worker suite 511 passed / 3
  skipped. New cases check the actual provider request: no mode + question sends the
  question with the focused cap; explicit overview + question does not send it and says
  so; the questionless overview is unchanged. The first two fail on the previous source.
- **Deployment.** Not deployed (worker). The changed tool-schema text alters the cached
  tool prefix once after deployment (expected cold cache, see H-032).
- **Remaining.** Measure digest-versus-focused accuracy and repeat inspections for
  explicit-overview questions before deciding whether overview should answer them.
- **Commit.** `03d4682`.

### H-042 — Transparent images reach the model unflattened and read as blank

- **Evidence.** Task `f65e8afa…`, run `1d7dca12…`: a valid 4,697×131 palette PNG with
  dark text on transparency was described as uniformly black; the original (SHA-256
  `560661a8…`, 18 alpha levels) shows three legible paragraphs on white. One
  source-verified task; frequency unknown.
- **Root cause (confirmed in code).** The model-image guard (committed in `39d02c8`)
  passed small transparent PNG/WebP files through unchanged and kept alpha when it
  resized to PNG, so the provider decided how to composite transparency; compositing on
  black hides dark text. Only the JPEG fallback flattened (onto white). The guard's own
  tests asserted this alpha preservation.
- **Fix.** Images with real transparency (`hasAlpha` and not opaque) are flattened for
  the model derivative onto an explicit matte: white, or black when the alpha-weighted
  visible content is light (for example a white logo), so either kind stays legible. The
  preview note tells the model which matte was used. Fully opaque images, including RGBA
  screenshots, still pass through byte-for-byte; original files are never modified.
- **Files.** `apps/worker/src/model-image.ts` (+test), `apps/worker/src/sandbox-continuity.ts`
  (preview note).
- **Tests.** The two existing assertions of alpha preservation now assert the corrected
  behaviour: an opaque RGBA PNG passes through byte-for-byte, and a fully transparent
  image becomes uniformly white (still correctly blank). New cases: the incident's shape
  (4,697×131 palette PNG, dark band) is shown dark-on-white and the source bytes are
  unchanged; white content is shown on black.
- **Verification (isolated snapshot).** Worker typecheck pass; worker suite 513 passed / 3
  skipped. Pre-fix: three cases fail on the previous source; the opaque passthrough passes
  on both. A 36 MP transparent PNG prepares in about 0.4 s locally (5 s sharp timeout).
- **Deployment.** Not deployed (worker; ships with the `39d02c8` image guard).
- **Remaining.** Provider-side behaviour across vision models and the alpha-unaware
  shell recovery seen in the task (the model converted to RGB and ignored Pillow's warning)
  remain behavioural; no cross-model evaluation was run.
- **Commit.** `5cd4189`.

### H-041 — Generated image metadata is taken from the request, not the returned bytes

- **Evidence.** 234 completed image calls / 71 tasks report dimensions inconsistent with
  the requested ratio; task 333's image `c67cb377…` is 1536×1024 (3:2) but labelled 16:9;
  task 166 returns 1024×1536 (2:3) while the tool and final answer say 3:4.
- **Root cause (confirmed in code).** `create_image` derived `width`/`height` from the
  request mapping (3:4 and 9:16 → 1024×1536, 4:3 and 16:9 → 1536×1024), echoed the
  requested `aspectRatio`, and always stored the bytes as `.png`/`image/png` with the
  requested transparency flag, without looking at what the provider returned.
- **Fix.** The returned bytes are inspected with sharp: width, height, format and real
  transparency. Metadata, file extension and stored media type follow them; the
  `aspectRatio` label is the preset nearest the actual shape (the strict shared schema
  only allows five presets), and `transparentBackground` is true only when transparency
  was requested *and* present. The tool text gives the actual size and ratio and states
  each mismatch (ratio, explicit size, transparency) with deterministic crop/pad guidance
  that warns against losing content. Bytes that are not a readable image are rejected
  instead of being published.
- **Files.** `apps/worker/src/sandbox-continuity.ts`, `apps/worker/src/model-image.ts`
  (`describeImageBytes`), `apps/worker/src/sandbox-continuity.test.ts`.
- **Tests.** The existing create_image test used a 4-byte PNG signature and asserted the
  request-derived 1536×1024; it now uses a real 1536×1024 PNG and also asserts the
  nearest preset and the 16:9 mismatch note. New cases: a JPEG returned for a transparent
  16:9 request is stored as `.jpg`/`image/jpeg` with actual 1024×1024, `1:1`, no
  transparency and both notes; a matching transparent PNG gets no note; non-image bytes
  are rejected.
- **Verification (isolated snapshot).** Worker suite 516 passed / 3 skipped; the three new
  cases fail on the previous source. **Correction:** the worker typecheck *failed* on this
  commit. The new test fixture omitted `editsEndpoint`, and the check's output, piped
  through `tail -1`, was misread. The fixture is fixed in `54c9255`; the verification
  script no longer pipes the typecheck.
- **Deployment.** Not deployed (worker).
- **Remaining.** Provider-aware ratio support (choosing a supported size per model rather
  than the fixed three), and the desktop/local-agent and API legacy paths that repeat the
  mapping (lower priority per AGENTS.md).
- **Commit.** `c94340b`.

### H-059 — XLSX generator clips wrapped text with fixed row heights

- **Evidence.** Task 529's published workbook (SHA-256 `ed112870…`) stores all 153
  source items but gives every data row 19.5 points with wrap on, and the requested
  65-character comment column was clamped to 45; a rendered copy clips several comments.
  Task 517 needed a manual 118.5-point repair. The production script matches the local
  file (`cff9548f…`), which had no uncommitted changes.
- **Root cause (confirmed).** `create_aesg_xlsx.py` clamped every width to 8–45 without
  saying so and set a fixed 19.5-point height on every data row (24.75 for the header)
  regardless of wrapped text.
- **Fix.** Requested widths are kept up to 100 (8 minimum); anything outside that range is
  set to the limit and reported in a new `warnings` list in the generator's JSON receipt.
  Header and data rows are sized from their wrapped line count (conservative estimate for
  Verdana; explicit line breaks counted), keeping the old heights as minimums, so short
  rows look the same. Heights above Excel's 409-point limit are capped with a warning to
  split the text or widen the column. Cell text is never shortened.
- **Files.** `deploy/skills/xlsx/scripts/create_aesg_xlsx.py`;
  `deploy/tests/test_aesg_xlsx_geometry.py` (new; runs with the system openpyxl).
- **Verification.** `python3 -B -m unittest deploy/tests/test_aesg_xlsx_geometry.py`:
  2/2 on the isolated snapshot; both fail on the previous script (width 45 instead of 65,
  and 45 instead of 100 with no warning). LibreOffice renders of the same spec, compared
  visually: the old script clips the 311-character comment to about two partial lines
  and the three-line cell to one; the new one shows every line, with roughly one spare
  line on the long comment. A text-extraction check was dropped because clipped glyphs
  stay in the PDF, so it passed on the old script too. No Excel desktop rendering.
- **Deployment.** Not published. The organization `xlsx` skill package must be synced for
  this to take effect (`deploy/e2b-aesg/sync-skills.sh` syncs every package from the
  server checkout, so run it only from a checkout that also carries the currently
  published AESG packages; see the H-064 note on those uncommitted sources).
- **Remaining.** Missing-logo reporting (`add_logo` silently skips a missing file; task
  529) belongs with the H-064 dependency work; Excel-specific glyph metrics are estimated,
  not measured.
- **Commit.** `67a22fa`.

### H-040 — Assistant statements become personal memories under the user's provenance

- **Evidence.** Task 973 guesses a 5 mm measurement and later admits it does not know;
  task 978 then retrieves memory `16fd6cfb…` saying the user confirmed 3–8 mm / 5 mm,
  although the linked user message only says "it is few mm". The memory is still live in
  production Mem0 (confidence 0.75, no expiry).
- **Root cause (confirmed in code).** `MemoryProcessor.ingestPersonal` sends both the
  user message and the assistant's final answer to Mem0 with `infer: true` and the
  user message as provenance. mem0ai 3.1.2's extraction prompt explicitly extracts from
  both roles ("You extract from BOTH user and assistant messages"), so the service's own
  custom instruction against storing assistant speculation is not enough; this is why a
  prompt-only restatement was ruled out.
- **Fix.** Personal (Mem0) inference now receives only the sanitised user message, so
  every implicit personal memory is supported by the user's own words. Explicit
  memories (the `remember` path, `infer: false`) are unchanged, and project-scope
  extraction by Berry's own generator is unchanged.
- **Trade-off.** A short user confirmation of an assistant proposal ("yes, always do it
  like that") no longer has the proposal as extraction input, so such preferences are
  captured only when stated explicitly or saved through the explicit path. This is the
  audit's "user-supported durable-memory extraction" direction.
- **Files.** `apps/worker/src/memory/processor.ts` (+test). The existing test asserted
  that the assistant reply was sent; it now asserts the user message alone. A new case
  reproduces task 978's shape.
- **Verification (isolated snapshot).** Worker suite 517 passed / 3 skipped; both cases fail
  on the previous source. The worker typecheck failed here only because of the H-041
  fixture above; it passes once that fixture is fixed.
- **Data impact.** None. Existing memories (including `16fd6cfb…`) are not modified;
  users can delete them in memory settings, and any bulk cleanup needs its own reviewed
  plan.
- **Deployment.** Not deployed (worker).
- **Remaining (H-040 stays open).** Retrieval relevance thresholds and raw-similarity
  telemetry, task-outcome source authority, pasted/quoted content inside user messages,
  and expiry for task-specific memories.
- **Commit.** `375f8dd`.

### Blocked: prepared AESG skill sources (H-064 manifests, H-056, H-058)

- **Finding.** The working tree's AESG skill files are byte-identical to the packages
  production has published: `docx/scripts/create_aesg_docx.py` (`a496e98a…`, 72,381
  bytes) and `aesg-branding/scripts/validate_artifact.py` (`d1420967…`) match the
  audit's SSM hashes. HEAD still has older versions (`create_aesg_docx.py` 53,492 bytes;
  `report_structure.py` absent). These are the prepared, user-confirmed memo fixes, made
  outside this session and never committed.
- **Why blocked.** The H-064 dependency manifests
  (`deploy/skills/docx/skill-dependencies.json`, `deploy/skills/pdf/skill-dependencies.json`,
  written in this session, uncommitted) name `report_structure.py`, which exists only in
  those uncommitted sources; at HEAD they would fail activation. H-056 (strict
  `json.loads` with a duplicate-key hook at the generator's spec parse) and H-058
  (anchored placeholder patterns in `validate_artifact.py`) are edits inside the same
  prepared files. Committing them means committing another owner's work, and their
  Python suite needs python-docx/python-pptx, which are not installed here (no network
  installs in this session).
- **Risk to note.** `deploy/e2b-aesg/sync-skills.sh` republishes every organization
  package from the server checkout. A Git-based checkout of HEAD followed by a sync would
  replace the published AESG packages with the older committed versions and undo the
  memo fixes.
- **Decision needed.** Commit the prepared AESG sources as their own provenance commit
  (unchanged, hash-checked against production). The manifests (with the saved
  published-package test) and the H-056/H-058 fixes can then follow as small commits.

### Blocked: H-015 — expired queued text

- **Finding (confirmed).** `QueuedFollowUpService.list` returns only active statuses with
  `expires_at > now()`, so expired text (56 items in the month) stays in the database but
  disappears from the UI. The shared schema already allows `expired`.
- **Why blocked.** The fix needs the API listing *and* a UI state together: the current
  client mapping (`serverQueuedFollowUpToClient`) turns unknown statuses into `queued`, so
  an API-only change would show expired items as still pending. The working tree is
  moving that client model into the untracked `packages/client-core`
  (`apps/web/src/lib/queued-follow-ups.ts` is now a re-export, and its tests are deleted).
  Changing HEAD's file would create merge work for that refactor.
- **Design for when it lands.** List expired items from (say) the last seven days, never
  re-deliver them, and show "Expired — not sent" with Copy, Restore to composer (manual
  send) and Remove, where Remove moves the item to `cancelled`.

### Blocked: H-043 — presentation font inheritance

- **Finding (confirmed).** The General Presentation template's theme uses Arial for
  major and minor fonts, and its slide-number field (`<a:fld type="slidenum">`) has no
  run properties, so it inherits Arial. The sandbox has no Arial, LibreOffice substitutes
  Liberation Sans, and the font gate fails. `create_aesg_pptx.py` sets only the field text.
- **Why blocked.** The generator cannot run here (python-pptx is not installed and the
  local worker images have no Python), so a fix could not be executed or rendered.
  Fixing the template instead would change a file whose hash is pinned in
  `aesg-branding/assets/template-manifest.json`, which has prepared uncommitted edits.
- **Design.** In the generator (a clean package), after filling the slides set the output
  theme's major and minor `a:latin` to Verdana, and give each slide-number field an
  explicit Verdana `a:rPr`. This is the repair the model applied by hand in task 1228 before
  publishing successfully. Verify with a production-image render of every supported layout.

### H-057 — Malformed question batches silently lose questions and choices

- **Evidence.** Task 1105, step `bcf7d580…`: three batch items used `label` instead of
  `question`; Berry dropped all three and showed one legacy open question with no
  choices, and the user had to repeat details already supplied. One malformed batch out
  of 305 in the month.
- **Root cause (confirmed in code).** `durableQuestionItems` silently skipped invalid
  items, fell back to the root `question`, and sliced batches above five questions and
  twelve options, although the tool schema declares those limits. A call with no valid
  question at all ended the run with a terminal error.
- **Fix.** `questionBatchProblem` checks the arguments against the declared schema
  (1–5 questions, each with non-empty `question`; up to 12 options, each with a
  non-empty `label`). A problem now fails the tool step with a field-specific message
  (for example `questions[0] needs a non-empty "question" string (received: label,
  options)`), so nothing is shown to the user and the model repairs the call within the
  existing bounded repair budget. Legacy root `question`/`options` calls without a batch
  are unchanged; normalisation still trims overlong text.
- **Files.** `apps/worker/src/turn-runner.ts` (+test).
- **Verification (isolated snapshot).** Worker typecheck pass (checked without a pipe);
  worker suite 520 passed / 3 skipped. New cases: task 1105's payload gives a repair
  error with no question event or waiting state; a batch with one invalid option is
  rejected rather than reduced; a legacy single question still waits. The first two fail
  on the previous source; the existing batch test still passes.
- **Deployment.** Not deployed (worker).
- **Remaining.** A shared validation boundary for other built-in tool arguments.
- **Commit.** `b9200f0`.

### H-049 — PDF pages without a text layer are treated as reviewed

- **Evidence.** Task 383: a 10-page RFP's page 7 holds the environmental scope extract as
  an image; Berry read the PDF as text, said all attachments were read and asked the user
  for the "missing" extract. Month: 102 mixed text/no-text input-PDF reads across 34
  tasks / 22 users (candidates, not confirmed errors).
- **Root cause (confirmed in code).** `piReadPdfContent` put "[No extractable text on
  this page.]" in the body but counted the page in `outputPages` and returned
  `extractedText: true` with no structured sign that coverage was partial.
- **Fix.** For pages shown in the output whose text layer is empty, the result now
  carries `textCoverage: "partial"` and `pagesWithoutText` (up to 50 page numbers), and
  a notice names them and says they were not reviewed: before saying information is
  missing, render those pages (an exact `pdftoppm` example is given) and inspect them,
  or run OCR. Fully textual PDFs, and PDFs with no text at all (which already say so),
  are unchanged.
- **Files.** `apps/worker/src/sandbox-continuity.ts` (+test).
- **Verification (isolated snapshot).** Worker typecheck pass; worker suite 521 passed / 3
  skipped. The new case (task 383's shape, page 7 empty) fails on the previous source;
  a fully textual PDF gets no notice.
- **Deployment.** Not deployed (worker).
- **Remaining.** Automatic selective page rendering/OCR with bounded cost, and a
  "fully reviewed" claim check; whether OCR recovers every affected page is unmeasured.
- **Commit.** `f6433f9`.

### H-062 — Failed search indexing leaves stored files "processing"

- **Evidence.** 249 of 6,744 undeleted files created in the month are
  `files.status='processing'` while their knowledge source is `index_status='failed'`
  (39 users; newest 13 October). Example: task 60's screenshot `02ce5556…` is intact and
  was used successfully through vision, but its index failed with "Document extraction
  produced no text".
- **Root cause (confirmed in code).** `SqlKnowledgeRepository.markFailed` updated the
  source and the workspace index state but not the file row, while the success path
  (`markTextReady`) sets `files.status='available'`. Beyond display, sandbox outputs and
  generated images promoted to knowledge are only staged into later turns when
  `available`, so a failed index could strand them.
- **Fix.** `markFailed` also moves the file from `processing` to `available` (bytes are
  stored; only search preparation failed), but only for a file source of the current
  revision that is not tombstoned. Other states such as `quarantined` during blob
  verification are left alone. The workspace and source rows keep `failed` and the
  failure reason.
- **Files.** `apps/worker/src/knowledge/repository.ts`;
  `scripts/test-index-failure-file-state.mjs` (real PostgreSQL).
- **Verification (isolated snapshot).** Worker typecheck pass; worker suite 521 passed / 3
  skipped; PostgreSQL script 3/3 (failed index → file available, source and workspace
  failed; stale revision → unchanged; quarantined → unchanged). **Pre-fix:** the first
  scenario leaves the file `processing`, the production state.
- **Data impact.** Only rows touched by new failures. The existing 249 rows are not
  changed. A reconciliation, proposed only and needing its own reviewed plan with a dry
  run and counts first, would set `status='available'` for undeleted files in
  `processing` whose current, non-tombstoned file sources are all `failed`.
- **Deployment.** Not deployed (worker).
- **Remaining.** Showing "Stored; not searchable" with the reason and the existing retry
  API in the Library and task file surfaces (web, currently mid-refactor in uncommitted
  work), and selective OCR for textless scans.
- **Commit.** `f4f2b1e`.

### H-028 — Rebuilt files are suppressed as duplicate publications

- **Evidence.** Task `f8051092…` rebuilt two files after the user reported they would
  not open, then got "Duplicate tool call suppressed" on both publications and still
  told the user the rebuilt files were ready.
- **Root cause (confirmed in code).** `persist_artifact` uses `block_after_success`, keyed
  on tool name and arguments only, so publishing the same path again was suppressed
  however the bytes had changed. H-053 deliberately left publication out of its
  freshness reset.
- **Fix.**
  1. The runner lets a publication of the same path through when a later completed
     write, edit or shell command names the file (its path, or a distinctive basename).
  2. The executor still keeps publication idempotent by content: when the bytes, path,
     name and type match the run's latest earlier publication, it returns that receipt
     marked `unchanged: true` and creates nothing new. Changed bytes publish a new
     version. Receipts now carry `sha256`.
  3. A publication that is still suppressed gets an explicit message: no new version
     was created, the earlier file is current, and the model must not claim a rebuilt
     version was published.
- **Files.** `apps/worker/src/turn-runner.ts`, `apps/worker/src/sandbox-continuity.ts` and
  their tests.
- **Verification (isolated snapshot).** Worker typecheck pass; worker suite 524 passed / 3
  skipped. New cases: publish, rebuild via a command naming the file, publish → executes;
  publish, unrelated command, publish → suppressed with the new message; executor:
  identical bytes → earlier receipt and no new upload, changed bytes → new version.
  All three fail on the previous source.
- **Deployment.** Not deployed (worker).
- **Limits.** A rebuild by a script that never names the output file is still treated as
  unchanged by the runner; identical-bytes reuse relies on `sha256`, which publications
  made before deployment lack. If the user deleted the earlier file mid-run,
  republishing identical bytes returns that deleted file's receipt (rare; a new name
  publishes a fresh copy).
- **Commit.** `e241a6b`.

### H-036 — Tool results past the shared history budget are sent empty

- **Evidence.** Code finding only: `boundedToolResultContext` returned `""` once the
  shared tool-result budget was spent (and a cut-off reference when little remained). No
  production occurrence has been established.
- **Root cause (confirmed in code).** The history builder spends the budget oldest-first,
  so every later result in a long turn became an empty tool message, indistinguishable
  from a tool that returned nothing.
- **Fix.** An exhausted (or too small) budget now yields the full durable reference plus
  "It was omitted here to stay within the model's context limit." The oldest-first order
  is deliberately kept: it leaves earlier history byte-stable for the H-032 prefix cache,
  and the marker depends only on the entry ID. The overrun is about 200 characters per
  omitted result.
- **Files.** `apps/worker/src/turn-runner.ts` (+test).
- **Verification (isolated snapshot).** Worker typecheck pass; worker suite 525 passed / 3
  skipped. New case: two 200,000-character results in a 32k window; the second now
  carries the omission marker instead of `""`. It fails on the previous source; the
  existing bounding test passes on both.
- **Deployment.** Not deployed (worker).
- **Remaining.** Preferring the latest decisive result over older ones would conflict
  with prefix caching and needs measurement; compaction remains the main bound.
- **Commit.** `37285db`.

### H-016 — An earlier failed shell command is masked by a later success

- **Evidence.** Task `48f28292…`, call `1eab87f3…`: `curl` failed with exit 35, a trailing
  `echo` left the shell status at 0, and the tool reported success. Pipelines ending in
  `tail` show the same effect (H-043, H-059 and task 517 evidence).
- **Root cause (confirmed).** The bash wrapper reports the script's final status, which
  is only that of the last command; failures earlier in the script, or upstream in a
  pipeline, leave no trace.
- **Fix (diagnostic, not a reinterpretation).** The wrapper installs an ERR trap in the
  model's shell that records each command exiting non-zero (outside conditions and `&&`/`||`
  lists) to a temporary file. When the final status is 0 and something was recorded, it
  appends "the command finished with status 0, but these commands exited non-zero
  earlier; check that their work succeeded", listing up to ten `exit N: command` lines.
  The exit status, the tee'd full-output log and the command's own `$?` are unchanged; a
  model-defined ERR trap takes precedence.
- **Why not `pipefail`.** Turning it on for the model's commands would change their meaning
  and produce false failures (SIGPIPE in `… | head`, `find / … | head` returning 1), which
  the issue explicitly warns against.
- **Files.** `apps/worker/src/sandbox-continuity.ts` (`PI_BASH_WRAPPER_SCRIPT`, +test).
- **Verification.** Real bash (local 3.2): a masked failure is listed; `$?` stays 1 inside
  the script; success, `if false`, `||` lists and a final `exit 9` add no note and keep
  their status; no temporary files remain. The multi-line wrapper also survives the E2B
  provider's argument quoting. Isolated snapshot: worker typecheck pass; worker suite 526
  passed / 3 skipped; the new case fails on the previous source and the existing
  exit-status test passes on both.
- **Deployment.** Not deployed (worker). Bash 5 in the sandbox supports everything used.
- **Remaining.** Upstream failures inside a pipeline (`producer | tail`) are still not
  detected without changing pipeline semantics; structured helpers for downloads and
  conversions remain the issue's longer-term proposal.
- **Commit.** `f027f27`.

### H-050 — A ready optional capability is discarded at the admission deadline

- **Evidence.** Code finding with a deployed-function fixture: once the shared two-second
  admission deadline has passed, `resolveOptionalAdmissionPreparation` returned the
  fallback (and logged a timeout) without checking whether the work had already
  succeeded. Related: 54 rejected `inspect_images` calls in 36 runs where the adapter was
  missing from the turn (causes not captured; not all deadline losses).
- **Root cause (confirmed in code).** An early `remainingMs === 0` return skipped the
  race altogether.
- **Fix.** The work is always raced first against the deadline; when the deadline has
  already passed, the race is against an already-resolved timeout, so work that settled
  earlier wins and only work still pending falls back. The two-second SLA, the
  rejection fallback and the logging are unchanged.
- **Files.** `apps/api/src/http/agent-api.controller.ts` (function now exported for its
  test; only these hunks staged, other uncommitted controller edits left alone);
  `apps/api/src/http/admission-preparation.test.ts` (new).
- **Verification (isolated snapshot).** API typecheck pass; API suite 450 passed / 24
  failed (exactly the 24 pre-existing DI failures; HEAD without the change: 447 / 24).
  One earlier full run also showed one failure each in `artifact.controller.test.ts` and
  `agent-api.controller.test.ts`. These did not recur in two reruns or in isolation, with or
  without this change, so they are recorded as load-related flakiness. Pre-fix (old
  function, export added): the ready-before-deadline case fails and both fallback
  cases pass.
- **Deployment.** Not deployed (API).
- **Remaining.** Persisting a scoped availability reason and telling the model when a
  capability changes between turns.
- **Commit.** `6c46724`.

### H-038 — Streamed tool calls merge when a gateway restarts indices

- **Evidence.** 12 concatenated native-tool failures across 5 Gemini tasks; task
  `fe764378…` repeats `activate_skillread` four times. A local synthetic stream
  reproduces the merged name and concatenated JSON.
- **Root cause (confirmed in code).** The worker accumulated streamed tool calls by
  provider index and appended every `id`, `name` and `arguments` fragment. The Google
  gateway restarts the index at 0 for each event, so separate calls were merged (and a
  repeated identical id was doubled).
- **Fix.** Calls are kept per arrival slot. A delta that carries both an id and a name,
  arriving on an index that already holds a named call with a different id, starts a new
  call. A repeated identical id is not appended again. Fragments without a new id and
  name still extend the current call, so ordinary OpenAI-style streams are unchanged.
  Results are ordered by provider index, then arrival.
- **Files.** `apps/worker/src/turn-runner.ts` (+test).
- **Verification (isolated snapshot).** Worker typecheck pass; worker suite 527 passed / 3
  skipped. The new case (two calls each at index 0 plus a call whose id repeats on every
  fragment) yields three correct calls; on the previous source it yields one merged call.
  The existing fragmented-stream test passes on both.
- **Deployment.** Not deployed (worker).
- **Remaining.** `packages/local-agent/src/model.ts` (desktop) has the same index-based
  accumulation (lower priority per AGENTS.md); calls without ids that restart indices
  cannot be told apart; the remote gateway build is unverified.
- **Commit.** `8f966ed`.

### H-008 — The workspace's outputs/ and tmp/ directories are not guaranteed

- **Evidence.** Task 1211 (12 October): the first document run failed a runtime probe only
  because the standard outputs directory was missing; python-docx, LibreOffice and
  Verdana were all available. Prompts and skills use `<root>/outputs` and `<root>/tmp`
  throughout.
- **Root cause (confirmed in code).** Sandbox creation makes only the workspace root (the
  E2B provider calls `makeDir(cwd)`), and snapshot restore excludes `tmp/`.
- **Fix.** The bash wrapper, which already creates its log directory
  `<root>/.berry-tool-output`, now also runs `mkdir -p` for `<root>/outputs` and
  `<root>/tmp` before each command. It does this only when the log path has that conventional
  form and never fails because of it. This adds no provider round trip, so the tests that pin
  "no shell-command amplification" stay unchanged. A first attempt that added an exec at
  sandbox creation broke three of those tests and was dropped. It also covers resumed
  sandboxes and a model that deleted the folders.
- **Files.** `apps/worker/src/sandbox-continuity.ts` (`PI_BASH_WRAPPER_SCRIPT`, +test).
- **Verification (isolated snapshot).** Worker typecheck pass; worker suite 528 passed / 3
  skipped. New case in a temporary workspace: the command sees `outputs/` and `tmp/`; a
  non-conventional log path creates nothing. It fails on the previous source. (A manual
  prototype run briefly created an empty `outputs/probe.txt` in the repository's ignored
  `outputs/` folder; it was removed, and the committed test uses a temporary directory.)
- **Deployment.** Not deployed (worker).
- **Remaining.** The issue's execution contract (verified interpreter, packages and skill
  paths; missing import versus unstaged module diagnostics).
