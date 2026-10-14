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
| H-002 (prerequisite) | Committed — source of the already-deployed hotfix | _pending_ | Already in production since 2026-09-24 (hash-verified); prompt work itself still open |

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
