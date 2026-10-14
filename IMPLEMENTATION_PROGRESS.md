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

## Summary

| ID | Status | Commit | Deployment |
| --- | --- | --- | --- |
| H-001 | Committed | `d7a806a` | Not deployed (API + worker + web must ship together) |
| H-009 (reconnect after cross-worker pause) | Committed — partial | `0cfe1d4` | Not deployed (worker + sandbox-contract) |
| H-014 (prerequisite: late mutation receipts) | Committed — source of the already-deployed hotfix | `d481431` | Deployed 2026-09-30 per record; exact production byte parity not reproducible (see entry) |
| H-011 (image payload guard) | Committed — partial | `39d02c8` | Not deployed (worker image; needs Sharp's Linux binary from the frozen lockfile) |
| H-051 / H-072 (Continue workspace lineage) | Committed | _pending_ | Not deployed (API + worker; either order is compatible) |
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
