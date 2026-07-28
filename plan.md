# Berry durable memory, project knowledge, prompt caching, and long-running tasks

> **Executor instructions**
>
> Read this file and the repository `AGENTS.md` completely before changing code.
> Execute the work packets in order and keep the progress ledger current. The
> priority is a complete, coherent implementation. Write only the focused tests
> named here, run fast code-level checks, and do not spend the initial execution
> cycle on broad test coverage.
>
> Do not run agent-browser, browser automation, broad end-to-end suites, load
> tests, chaos tests, soak tests, the full cross-platform suite, or exhaustive
> unit tests. Do not deploy to production. Never read, replace, or commit
> `deploy/.env.production`.
>
> **Drift check (run first)**
>
> ```sh
> git diff --stat ae3abd9..HEAD -- \
>   apps/api apps/web apps/worker packages/db packages/harness \
>   packages/local-agent packages/router-client packages/shared deploy
> git status --short
> ```
>
> If an in-scope area has changed since commit `ae3abd9`, inspect the live code
> before editing and adapt this plan without discarding compatible user work.
> At planning time, `deploy/e2b-aesg/README.md` was modified and
> `docs/aesg-artifact-skills-runbook.md` was untracked; those changes are
> unrelated and must be preserved.

## Status

- **Priority:** P0
- **Effort:** XL, intended for one persistent goal with resumable work packets
- **Risk:** High; this changes storage, the turn lifecycle, provider adapters,
  worker execution, and user-facing settings
- **Depends on:** None
- **Category:** feature, architecture, reliability, performance, security
- **Planned at:** commit `ae3abd9`, 2026-07-28
- **Execution status:** COMPLETE

## Objective

Implement four connected capabilities for the Berry web platform:

1. Durable memory scoped to one tenant and one user, available across all of
   that user's chats without leaking to another user.
2. Shared project knowledge across every chat in a project, including project
   files and useful outcomes from earlier tasks.
3. Provider prompt caching that is actually enabled when supported, preserves a
   stable prefix, and exposes cache reads, writes, eligibility, and miss reasons.
4. Portable, structured compaction and a durable task runner that can resume
   24–48 hour tasks after API, worker, stream, or sandbox interruptions.

The result must use one identity and access-control model, one source of truth in
Postgres, and one context assembly path. Prompt caching is an optimization, not
a substitute for memory. Compaction is session state, not automatically a
personal fact. BullMQ is a dispatcher, not the authoritative run ledger.

## Outcome checklist

- [x] A fact stored for `(tenant_id, user_id)` can be recalled in a different
      general chat and a different project chat owned by the same user.
- [x] That fact cannot be retrieved by another user or tenant.
- [x] Every project chat can retrieve authorized project files, task outcomes,
      decisions, and checkpoints through hybrid full-text/vector search.
- [x] Project uploads are linked directly to the workspace instead of inferred
      by loading all user files and filtering task IDs in the browser.
- [x] OpenAI-compatible and Anthropic-compatible adapters send supported cache
      controls and report cache-read/cache-write tokens end to end.
- [x] Dynamic memory and retrieval context is placed after the stable cached
      prompt prefix.
- [x] Compaction creates a validated `SessionCheckpointV2`, retains provenance,
      and has deterministic recovery when model summarization is invalid.
- [x] Turn state, step state, events, tool calls, approvals, and checkpoints are
      durable in Postgres.
- [x] A worker can reclaim an expired run lease and continue from the next safe
      step without blindly repeating a non-idempotent tool.
- [x] SSE clients can reconnect using `Last-Event-ID` and replay missed events.
- [x] Sandboxes can be reconnected or restored from object-storage snapshots.
- [x] The web UI exposes project knowledge status and personal-memory controls.
- [x] Focused tests exist for the highest-risk deterministic behavior, and the
      required typechecks/build complete successfully.

## Progress ledger

Update the status column as work proceeds: `TODO`, `IN PROGRESS`, `DONE`, or
`BLOCKED: <reason>`.

| Work packet | Description | Status |
|---|---|---|
| 0 | Confirm invariants and implementation seams | DONE |
| 1 | Add shared contracts, database schema, and deployment dependencies | DONE |
| 2 | Build project-file ingestion and hybrid knowledge retrieval | DONE |
| 3 | Build personal/project memory and turn-time context assembly | DONE |
| 4 | Make prompt caching effective and observable | DONE |
| 5 | Add portable structured compaction | DONE |
| 6 | Move long-running turn execution onto a durable worker state machine | DONE |
| 7 | Add web controls and status surfaces | DONE |
| 8 | Finish backfills, focused tests, checks, and operator documentation | DONE |

## Implementation principles

These are non-negotiable across all work packets.

### Identity and authorization

- Scope every new row by `tenant_id`.
- Personal memory is keyed by immutable `user_id`, never email.
- Project knowledge is keyed by `workspace_id`; verify the workspace belongs to
  the tenant and the caller is authorized before reading or mutating it.
- Apply the repository's existing RLS/tenant-context pattern to every new
  tenant-owned table. Never rely on an application filter alone.
- A source's ACL is applied in SQL before ranking. Do not fetch broad candidates
  and filter them in JavaScript.

### Sources of truth

- Postgres is authoritative for memory, knowledge metadata/chunks, sessions,
  run state, checkpoints, events, leases, and outbox state.
- Existing object storage is authoritative for file bytes and sandbox snapshot
  archives.
- Redis/BullMQ only schedules and wakes workers. Queue loss must be recoverable
  by scanning durable outbox/run rows.
- The current local SQLite harness store may remain as a local/desktop adapter,
  but web production must use a Postgres-backed session journal.

### Context boundaries

Assemble model input in this order:

1. stable system instructions;
2. stable tool schemas and capability/policy instructions;
3. stable project instructions where possible;
4. portable session checkpoint;
5. dynamic personal memory and project retrieval;
6. recent conversation turns;
7. the current user request.

Keep items 1–3 byte-stable for prompt caching. Dynamic retrieval must not alter
the beginning of the prompt. Retrieved documents are untrusted data, delimited
and labeled with source IDs, and must never be treated as system instructions.

### Data lifecycle and provenance

- Store the source task/session/message/file/chunk IDs for every derived memory
  item and checkpoint decision.
- Use tombstones/status changes rather than destructive history rewrites.
- Deleting a file, workspace, user, or memory item must make its derived chunks
  immediately non-retrievable and enqueue idempotent cleanup.
- Do not index hidden reasoning, secrets, raw credential-bearing tool output, or
  noisy terminal/browser logs.
- Do not automatically promote a compaction summary into personal memory.

### Reliability and idempotency

- All worker jobs have deterministic IDs and can be safely delivered more than
  once.
- Every bounded worker step records its result and next state transactionally
  before the queue job is acknowledged.
- Tool definitions declare one retry class:
  `read_only`, `idempotent`, `idempotent_with_key`, or
  `non_idempotent_manual`.
- After an ambiguous crash, a `non_idempotent_manual` tool step enters
  `recovery_required`; it is not repeated automatically.
- Approval waits, user-input waits, provider backoff, and long sandbox sleeps
  release the worker slot.

## Current repository state

The executor has no dependency on earlier research. Confirm these facts against
the live code before editing:

- `packages/db/src/index.ts` defines workspaces, tasks, sessions, messages,
  files, file associations, and derivatives. Files can be associated with a
  task/session/message/turn, but there is no first-class workspace-file link.
- `apps/api/src/files/file-platform.service.ts` completes an upload by making
  the file available. It does not enqueue a general extraction/chunk/embed
  pipeline.
- `apps/web/src/components/library/task-file-library-dialog.tsx` constructs its
  project view by fetching a large user file list and filtering by project task
  IDs in the browser.
- `apps/api/src/http/agent-api.controller.ts` starts a runtime turn without a
  personal-memory or project-retrieval stage and currently persists
  `tokensCached: 0`.
- `apps/api/src/main.ts` creates the Postgres task store but configures the
  runtime harness with `BERRY_RUNTIME_DB_PATH`, a local SQLite file.
- `apps/api/src/http/event-stream.service.ts` uses an in-memory RxJS subject map;
  events disappear across process restarts.
- `packages/local-agent/src/session-store.ts` is an append-only SQLite
  `SessionStorage` implementation. The append-only shape is useful, but its
  storage is not durable across replaceable API containers.
- `packages/harness/src/harness/compaction/compaction.ts` already has token-aware
  thresholds and safe cut points, and `agent-harness.ts` invokes compaction
  before turns and inside tool loops. Preserve those strengths.
- The present compaction output is primarily free-form text. The worker's
  `session.compact` implementation in `apps/worker/src/main.ts` is a placeholder.
- `packages/harness/src/harness/agent-harness.ts` passes cache retention and
  session identity to the model layer, but Berry's custom provider adapters do
  not consistently transmit provider cache controls.
- `packages/local-agent/src/model.ts` does not send OpenAI prompt-cache fields,
  does not annotate Anthropic cache breakpoints, and does not normalize all
  cached-token details.
- `packages/router-client/src/index.ts`,
  `packages/local-agent/src/runtime.ts`, and `packages/shared/src/index.ts`
  reduce usage to input/output/total token counts, losing cache-write/read
  details before the API persists usage.
- `apps/worker` already uses BullMQ and has typed jobs. Extend it; do not add a
  second queue framework.
- `deploy/compose.yaml` currently uses `postgres:16-alpine`; pgvector is not
  installed. The runtime SQLite file is mounted under `/data`.
- The repository uses `@earendil-works/pi-ai` as its agent/model abstraction.
  Do not introduce a second agent framework such as the Vercel AI SDK or full
  LangChain runtime.

## Chosen libraries and methods

Use small, replaceable dependencies:

- Pin the official pgvector Postgres image to
  `pgvector/pgvector:0.8.2-pg16-bookworm` and enable the `vector` extension in a
  numbered cloud migration. Rehearse the image change against a disposable copy
  or fresh database; do not point test commands at production.
- Add `@langchain/textsplitters` only to the worker for document-aware and
  recursive chunking. Do not add the rest of LangChain.
- Add an Apache Tika 3.x sidecar for broad self-hosted document extraction.
  Plain text/Markdown/JSON can be decoded directly; Tika handles office/PDF and
  other supported formats. Make the endpoint configurable.
- Implement a provider-neutral `EmbeddingProvider`. The first profile is one
  pinned model/dimension pair, defaulting to a 1536-dimension
  OpenAI-compatible embedding endpoint. Store provider, model, dimensions, and
  profile version on every embedding. Reject a dimension mismatch at startup.
- Use Postgres full-text search plus pgvector and combine rankings with
  Reciprocal Rank Fusion (RRF). Start with exact vector search for small
  collections; create a partial HNSW index once the table size/config threshold
  warrants it. If HNSW is used with ACL filters, enable pgvector iterative scans.
- Follow the useful part of the Mem0 method—extract candidate facts,
  consolidate deterministically, retrieve selectively—but keep Berry Postgres
  as the source of truth. Do not make an external memory SaaS a required
  dependency.
- Use Zod schemas already standard in the repository for memory operations,
  retrieval results, job payloads, and `SessionCheckpointV2`.

Reference material:

- [pgvector](https://github.com/pgvector/pgvector)
- [Apache Tika server](https://cwiki.apache.org/confluence/display/TIKA/TikaServer)
- [LangChain text splitters](https://js.langchain.com/docs/concepts/text_splitters/)
- [OpenAI prompt caching](https://platform.openai.com/docs/guides/prompt-caching)
- [Anthropic prompt caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)

## Configuration

Add non-secret examples and typed validation for:

```text
BERRY_MEMORY_ENABLED=true
BERRY_IMPLICIT_MEMORY_ENABLED=true
BERRY_PROJECT_KNOWLEDGE_ENABLED=true
BERRY_PROMPT_CACHE_ENABLED=true
BERRY_DURABLE_RUNNER_ENABLED=true
BERRY_TIKA_URL=http://tika:9998
BERRY_EMBEDDING_PROVIDER=openai-compatible
BERRY_EMBEDDING_MODEL=<deployment-selected-model>
BERRY_EMBEDDING_DIMENSIONS=1536
BERRY_EMBEDDING_PROFILE_VERSION=1
BERRY_KNOWLEDGE_CHUNK_TOKENS=600
BERRY_KNOWLEDGE_CHUNK_OVERLAP_TOKENS=80
BERRY_RETRIEVAL_TOKEN_BUDGET=5000
BERRY_RUN_LEASE_SECONDS=90
BERRY_SANDBOX_SNAPSHOT_INTERVAL_SECONDS=900
```

Reuse existing model/provider credentials and object-storage configuration.
Never add real keys or secrets to examples. Define safe degradation:

- if Tika is unavailable, retry extraction and expose `failed` with a reason;
- if embeddings are unavailable, continue with full-text retrieval and leave
  vector indexing retryable;
- if prompt caching is unsupported, omit provider fields and record
  `provider_unsupported`;
- if the durable runner feature flag is disabled, retain the existing inline
  turn path as a rollback seam during rollout.

## Work packet 0 — confirm seams and freeze contracts

### Tasks

- [x] Read the root `AGENTS.md`, the package manifests for all in-scope
      packages, and the current implementations named in “Current repository
      state.”
- [x] Trace one web turn from controller to runtime, model adapter, streamed
      event, usage persistence, and task completion. Record the exact symbols in
      a short implementation note inside this file if they differ from the paths
      above.
- [x] Trace file upload completion and file listing from API to web.
- [x] Trace approval pause/resume and tool-call persistence.
- [x] Confirm the database migration convention in
      `packages/db/src/index.ts` and `CloudDatabaseService.migrate()`.
- [x] Decide the exact stable internal names for the shared contracts listed
      below before adding implementation. Prefer additive changes and retain
      backward-compatible optional fields while callers migrate.

### Shared contracts to freeze

- `MemoryItem`, `MemoryOperation`, `MemoryScope`, `MemoryStatus`
- `KnowledgeSource`, `KnowledgeChunk`, `RetrievalCandidate`,
  `RetrievalSnapshot`, `GroundingContext`
- `EmbeddingProfile`, `EmbeddingProvider`
- expanded usage fields for cache reads/writes/eligibility/miss reason
- `SessionCheckpointV2`
- `TurnRun`, `TurnStep`, `TurnEvent`, retry-safety classification

### Gate

No command is required beyond read-only inspection. Mark this packet done only
when names and ownership are clear enough that later packets will not create
parallel representations.

### Implementation note (2026-07-28)

- Turn admission is `AgentApiController.startTurn()` in
  `apps/api/src/http/agent-api.controller.ts`. It resolves governance and a
  budget reservation, then calls `SessionHostService.startTurn()`.
  `SessionHostService` delegates to `RuntimeSessionHost`, which delegates to
  `BerryAgentRuntime.startTurn()` in `packages/local-agent/src/runtime.ts`.
  Runtime events return through the controller's `onEvent` callback, are fanned
  out by `ApiEventStreamService.publish()`, and usage is persisted by
  `PostgresUsageRepository.ingestInternal()`. The durable runner must replace
  this controller-owned lifecycle behind the rollout flag.
- Upload initiation/completion is
  `FilePlatformController.initiate()/complete()` to
  `FilePlatformService.initiateUpload()/completeUpload()`. Completion currently
  changes the file directly to `available`. Listing is
  `FilePlatformController.list()` to `FilePlatformService.list()` and the web
  project tab still filters task-linked files in
  `TaskFileLibraryDialog.refresh()`.
- Approval waits are held in `BerryAgentRuntime.#pendingApprovals`; decisions
  reach them through `AgentApiController.decideApproval()` and
  `SessionHostService.resolveApproval()`. Settled tool calls are projected by
  the controller's `onToolCall` callback. These are not restart-safe yet.
- Live events are held by `ApiEventStreamService` RxJS subjects. The service
  supports only caller-supplied in-memory replay and has no durable cursor.
- Cloud migrations are applied in ascending array order by
  `CloudDatabaseService.migrate()` under a transaction advisory lock and
  recorded in `schema_migrations`. The current highest migration ID is 26; this
  implementation adds migration 27 without rewriting existing migrations.
- Shared contract ownership is frozen in `@berry/shared`: `MemoryItem`,
  `MemoryOperation`, `MemoryScope`, `MemoryStatus`, `KnowledgeSource`,
  `KnowledgeChunk`, `RetrievalCandidate`, `RetrievalSnapshot`,
  `GroundingContext`, `EmbeddingProfile`, `EmbeddingProvider`,
  `SessionCheckpointV2`, `PromptManifest`, `TurnRun`, `TurnStep`, `TurnEvent`,
  and `ToolRetryClass`. Storage adapters and provider implementations remain in
  API, worker, local-agent, and harness packages.

## Work packet 1 — shared contracts, schema, and deployment foundation

### 1.1 Shared types and schemas

Modify `packages/shared/src/index.ts` or split cohesive modules from it and
re-export them through the package public API.

- [x] Add Zod-backed types for all frozen contracts.
- [x] Extend usage without breaking old producers:
      `inputTokens`, `outputTokens`, `totalTokens`, `cacheReadTokens`,
      `cacheWriteTokens`, `cacheCreationTokens1h`,
      `cacheCreationTokens5m`, `cacheEligible`, `cacheProvider`,
      `cacheKeyHash`, `promptManifestHash`, and `cacheMissReason`.
- [x] Define a closed miss taxonomy:
      `provider_unsupported`, `below_minimum_tokens`, `first_request`,
      `prefix_changed`, `cache_expired`, `routing_changed`,
      `retention_unsupported`, `unknown`.
- [x] Add `GroundingContext` sections for personal memory, project facts,
      sources/citations, and retrieval metadata. Do not use raw HTML.
- [x] Add `SessionCheckpointV2` as specified in work packet 5.

### 1.2 Postgres schema and numbered migrations

Extend `packages/db/src/index.ts` and the repository's `cloudMigrations`.
Prefer enums only where values are genuinely closed; use text plus checks where
future providers/source types will expand.

Create:

- [x] `memory_items`: tenant, owning user, optional workspace scope, kind,
      stable key, display content, structured value, status, explicit flag,
      confidence, salience, valid/expiry timestamps, extractor version,
      provenance IDs, superseded item ID, and timestamps.
- [x] `memory_item_versions`: append-only before/after operation records,
      actor/source metadata, and timestamps.
- [x] `workspace_files`: direct workspace/file relation, visibility
      (`project` or `task_only`), optional originating task, index status,
      created-by user, and timestamps.
- [x] `knowledge_sources`: file/task-outcome/message/checkpoint/memory source
      type, tenant/user/workspace scope, source revision/hash, authority,
      visibility/ACL version, extraction/index status, extractor/chunker
      versions, failure reason, and tombstone timestamp.
- [x] `knowledge_chunks`: source, ordinal, text, token estimate, page/heading/
      sheet/turn metadata, generated `tsvector`, fixed-dimension vector,
      embedding profile/model/version/hash, and timestamps.
- [x] `retrieval_snapshots`: turn/run/query hashes, selected source/chunk IDs,
      component scores, selection reason, token budget, and version metadata.
- [x] `session_entries`: Postgres equivalent of the harness append-only session
      tree, including parent/leaf relationships and entry sequence.
- [x] `session_checkpoints`: immutable segment plus rolling checkpoint payloads,
      coverage range, source leaf, schema version, validation status, and model
      metadata.
- [x] `turn_runs`: durable run state, attempt, lease owner/expiry, next action,
      waiting reason, heartbeat, error, and timestamps.
- [x] `turn_steps`: ordered step type/state, input/output references, retry
      class, idempotency key, attempt, and timestamps.
- [x] `turn_events`: monotonically sequenced durable event payloads with a
      unique `(run_id, sequence)`.
- [x] `runtime_outbox`: event/job type, aggregate ID, payload, available time,
      attempts, lease, and completion timestamp.
- [x] `sandbox_snapshots`: run/session/sandbox references, object-storage file
      ID/key, content hash, sequence, status, and timestamps.

For each table:

- [x] add foreign keys, uniqueness rules that make retries idempotent, tenant/
      scope indexes, and cleanup indexes;
- [x] add RLS policies using the existing `berry_set_tenant_id` pattern;
- [x] add tests to the current migration/schema test only for table presence,
      critical indexes/policies, and repeatable migration application;
- [x] use migration IDs after the current maximum; never rewrite an applied
      migration.

Enable `CREATE EXTENSION IF NOT EXISTS vector`. Use a pinned
`vector(1536)` column for v1. A future dimension/model change must use a new
profile and reindex/dual-write migration rather than silently mixing vectors.

### 1.3 Deployment/config foundation

- [x] Update `deploy/compose.yaml` to the pinned pgvector Postgres image.
- [x] Add a pinned Tika service with a health check and internal-only network
      access.
- [x] Pass non-secret Tika/feature/config variables to API and worker.
- [x] Update Helm values/templates with equivalent optional Tika and feature
      configuration. Do not put secrets in ConfigMaps.
- [x] Update `deploy/.env.example` and
      `deploy/.env.production.example`; do not touch
      `deploy/.env.production`.
- [x] Add dependency declarations and lockfile changes only through pnpm.

### Fast gate

```sh
pnpm --filter @berry/shared typecheck
pnpm --filter @berry/db typecheck
pnpm --filter @berry/api typecheck
pnpm --filter @berry/worker typecheck
```

Expected: every command exits 0 with no TypeScript errors. Do not run the full
test suite here.

## Work packet 2 — project-file ingestion and hybrid retrieval

### 2.1 Direct project file ownership

In `apps/api/src/files/`:

- [x] Extend upload/link APIs so an authorized project upload creates a
      `workspace_files` row transactionally.
- [x] Add a server-side list endpoint/repository query by tenant, workspace,
      visibility, status, and pagination.
- [x] Keep task-only attachments distinct from reusable project files.
- [x] Preserve existing file associations for messages/turns; the new relation
      supplements rather than replaces them.
- [x] On unlink/delete, tombstone the knowledge source immediately and enqueue
      cleanup. The file may remain if another authorized association owns it.

Replace the browser-side aggregation in
`apps/web/src/components/library/task-file-library-dialog.tsx` with this
workspace endpoint in work packet 7.

### 2.2 Typed ingestion jobs

Extend `apps/worker/src/jobs.ts`, `bullmq.ts`, `processor.ts`, and `main.ts` with:

- `knowledge.extract`
- `knowledge.chunk`
- `knowledge.embed`
- `knowledge.index-task`
- `knowledge.delete`
- `knowledge.reindex`

Each job:

- [x] has a Zod payload with tenant and deterministic source/revision IDs;
- [x] uses a deterministic BullMQ job ID;
- [x] locks or compare-and-swaps the current source revision;
- [x] is safe to replay and ignores stale revisions;
- [x] persists failure/status before returning an error.

Add an outbox dispatcher so API transactions write `runtime_outbox`, and a
short polling process enqueues undispatched jobs. A reconciliation scan must
re-enqueue due outbox records if Redis was unavailable.

### 2.3 Extract, normalize, chunk, and embed

- [x] Change upload completion from directly `available` to
      `processing` when indexing is required.
- [x] For text-like MIME types, decode and normalize directly.
- [x] For supported binary documents, call Tika with timeout, response-size,
      MIME, and retry limits. Never let extracted content become instructions.
- [x] Reuse/create `file_derivatives.text_extract` so extraction output is
      inspectable and not recomputed for every reindex.
- [x] Use document-aware splitters where metadata is available and
      `RecursiveCharacterTextSplitter` as fallback.
- [x] Target roughly 600 tokens with roughly 80-token overlap, while preserving
      page, heading, slide, sheet, row-range, and source offsets when present.
- [x] Hash normalized content and chunks so unchanged revisions are no-ops.
- [x] Batch embedding calls, validate vector dimensions, store the embedding
      profile, and support retrying embedding independently from extraction.
- [x] Mark the file `available` and source `indexed` once text search is ready;
      expose a separate vector-ready flag so FTS can work during embedding
      retry.

### 2.4 Index useful previous-task knowledge

At successful task finalization:

- [x] create a versioned task-outcome source from the original user request,
      final assistant result, explicit decisions, artifacts, and current
      portable checkpoint;
- [x] omit hidden reasoning, raw tool traffic, secrets, and repetitive terminal
      output;
- [x] enqueue `knowledge.index-task`;
- [x] supersede the previous source revision when a task is resumed and
      completed again.

### 2.5 Hybrid retrieval service

Add cohesive knowledge modules in `apps/api/src/knowledge/` and worker adapters
in `apps/worker/src/knowledge/`. Reuse shared pure ranking functions.

- [x] Build a retrieval query from the current request, task title, checkpoint
      goal, constraints, and open items.
- [x] Retrieve structured exact matches first.
- [x] Run scoped Postgres FTS and vector queries with tenant/workspace/user/ACL
      restrictions inside SQL.
- [x] Fuse results with configurable RRF. Add small, explicit boosts for source
      authority and recency; do not bury semantic relevance under heuristics.
- [x] Deduplicate overlapping chunks, cap chunks per source, preserve source
      diversity, and enforce a token budget.
- [x] Record the candidate/selected IDs, component scores, versions, and reason
      in `retrieval_snapshots`.
- [x] Return citation-ready labels such as file name/page, task title, and
      source timestamp.
- [x] Return FTS-only results when the embedding provider is unavailable.

Do not add HNSW until exact search is functional. If the implementation adds it
in this packet, use a partial index for active vector-ready chunks and enable
iterative scans for filtered queries.

### Focused tests

Add a small deterministic test file for:

1. tenant/workspace filters are present in repository queries;
2. RRF produces a stable order for a fixed FTS/vector fixture;
3. token budget and per-source diversity are honored;
4. deleting/tombstoning a source excludes it.

Use a fake embedding provider and fixture text. Do not start Tika, Postgres,
Redis, or a browser for these tests.

### Fast gate

```sh
pnpm --filter @berry/worker typecheck
pnpm --filter @berry/api typecheck
pnpm --filter @berry/worker test -- src/knowledge
pnpm --filter @berry/api test -- src/knowledge
```

Expected: typechecks exit 0; only the new focused knowledge tests run and pass.

Implementation note (2026-07-28): direct project-file ownership, the durable
outbox/BullMQ ingestion chain, Tika/direct extraction, derivative reuse,
document chunking, versioned task-outcome indexing, hybrid FTS/vector
retrieval, persisted snapshots, and citation-ready results are implemented.
The API client, API, and worker typechecks pass. The focused knowledge suites
pass (worker: 3 tests; API: 1 test) using only fakes and fixture text.

## Work packet 3 — personal/project memory and context assembly

### 3.1 Memory repository and consolidation rules

Add `apps/api/src/memory/` and corresponding worker processing.

Personal memory rows use `(tenant_id, user_id)`. Project memory rows additionally
use `workspace_id`. Implement:

- [x] paginated list/get;
- [x] explicit create/update/forget;
- [x] candidate extraction;
- [x] deterministic consolidate;
- [x] retrieval by scope and current context;
- [x] provenance display data;
- [x] export and soft-delete.

Use these operation types:

- `ADD`: no active equivalent exists;
- `SUPERSEDE`: a newer fact conflicts with or replaces an active fact;
- `REFRESH`: the same fact is reconfirmed and its confidence/last-seen changes;
- `NOOP`: duplicate, low-value, unsafe, or unsupported content.

Rules:

- [x] explicit user memory outranks implicit extraction;
- [x] a new implicit candidate cannot silently overwrite an explicit fact;
- [x] conflicting facts keep version history and provenance;
- [x] ephemeral task details, credentials, secrets, and copied project documents
      are rejected as personal memory;
- [x] preferences, stable profile facts, recurring working conventions, and
      durable relationships are eligible;
- [x] expiry can be set for facts that are likely temporary;
- [x] “forget” immediately makes the fact non-retrievable.

### 3.2 Explicit and implicit memory paths

- [x] Add scoped runtime tools for explicit remember/forget operations. The
      server derives tenant/user/workspace identity; the model cannot choose
      another user's identifiers.
- [x] After a completed turn, enqueue `memory.extract` with only the allowed
      user text, assistant final text, and source IDs.
- [x] Use the existing model abstraction with structured Zod output to propose
      operations. Validate once, optionally repair once, then safely no-op.
- [x] Apply operations in a transaction and write
      `memory_item_versions`.
- [x] Keep extraction asynchronous for latency, while the explicit tool path is
      synchronous.
- [x] Add an idempotency key based on source message/revision/extractor version.

### 3.3 Turn-time retrieval and injection

In the API turn-start path:

- [x] load active personal memory for the current user;
- [x] load project memory and hybrid knowledge for the current workspace;
- [x] rank and trim both under separate budgets so one cannot starve the other;
- [x] create one `GroundingContext` with citation/provenance labels;
- [x] persist a retrieval snapshot;
- [x] pass it through a typed runtime request.

In the harness/local runtime:

- [x] add an ephemeral grounding-context seam if none exists;
- [x] do not concatenate generated context into the persisted user-authored
      message;
- [x] insert it after the stable cached prefix and portable checkpoint;
- [x] clearly label retrieved text as untrusted reference material;
- [x] retain source IDs in run metadata so the final UI can cite them.

Do not fetch all memories on every turn. Retrieve structured exact/high-salience
facts first, then semantic candidates, and enforce a small budget.

### Focused tests

Add one focused memory service test covering:

1. the same user retrieves a fact across two tasks;
2. another user and another tenant retrieve nothing;
3. explicit memory survives a conflicting implicit candidate;
4. `SUPERSEDE`, `REFRESH`, and `forget` retain history but change active recall;
5. context assembly places dynamic grounding after stable prompt components.

Use repository fakes; do not call a live model or database.

### Fast gate

```sh
pnpm --filter @berry/shared typecheck
pnpm --filter @berry/api typecheck
pnpm --filter @berry/worker typecheck
pnpm --filter @berry/api test -- src/memory
```

Expected: exit 0 and only the focused memory tests run.

Implementation note (2026-07-28): scoped memory CRUD/settings/export,
explicit runtime tools, asynchronous structured extraction through the existing
router client, deterministic conflict rules, append-only provenance, and
personal/project recall are implemented. Turn start now assembles one typed
grounding envelope, loads the latest validated checkpoint, and appends
untrusted dynamic references after the stable prompt/checkpoint boundary.
Shared/API/worker typechecks pass and the three focused fake-repository memory
tests pass.

## Work packet 4 — effective and observable prompt caching

### 4.1 Stable prompt manifest

Define and persist a `PromptManifest` for each model request:

- model/provider/routing identity;
- system prompt component IDs and content hashes;
- ordered tool-schema hashes;
- policy/capability/project-instruction hashes;
- cache retention request;
- stable-prefix token estimate;
- dynamic-context boundary;
- overall stable-prefix hash.

Build stable components in a deterministic order. Do not include timestamps,
random IDs, request IDs, dynamic memory, retrieved chunks, or current user text
inside the stable prefix. Use canonical JSON when hashing tool schemas.

Derive provider cache keys from tenant/session plus the manifest hash without
including secret or raw prompt text.

### 4.2 Provider controls

In `packages/local-agent/src/model.ts` and existing adapters:

- [x] OpenAI Responses/compatible path: send the supported prompt-cache key and
      retention option only when the selected provider/model capability declares
      support. Preserve exact stable prefixes across requests.
- [x] Anthropic path: place `cache_control` breakpoints on stable system/tool
      blocks according to current provider limits; do not mark dynamic retrieval
      blocks cacheable.
- [x] Other providers: explicitly return unsupported capability rather than
      guessing request fields.
- [x] Keep capability checks in the provider matrix/router layer, not scattered
      string comparisons.

Treat caching as best-effort. A cache hit cannot be guaranteed; the code must
maximize eligibility and explain misses.

### 4.3 Usage normalization and persistence

Carry cache fields through:

- provider response parsing in `packages/local-agent/src/model.ts`;
- router usage in `packages/router-client/src/index.ts`;
- runtime events in `packages/local-agent/src/runtime.ts`;
- shared event/usage types in `packages/shared/src/index.ts`;
- API usage persistence in `apps/api/src/http/agent-api.controller.ts`;
- existing rollups/reporting surfaces where token usage is aggregated.

Remove the hardcoded `tokensCached: 0`. Distinguish cache-read from cache-write
tokens, while mapping legacy `tokensCached` to cache-read for compatibility.

Classify an observed miss using manifest comparison and provider metadata:

- below provider threshold;
- no previous eligible request;
- stable prefix changed, including which component hash changed;
- provider/model route changed;
- cache expired/retention unsupported;
- provider unsupported;
- unknown.

Log only hashes/counts/reasons, never prompt bodies.

### Focused tests

Extend existing adapter/usage tests with a few fixtures:

1. OpenAI-compatible request contains cache fields when supported and omits
   them when unsupported;
2. Anthropic stable blocks receive cache control while dynamic blocks do not;
3. representative provider responses normalize read/write tokens correctly;
4. manifest hash is stable for semantically identical ordered input and changes
   when one stable component changes;
5. API persistence no longer forces zero.

No live provider calls.

### Fast gate

```sh
pnpm --filter @berry/router-client typecheck
pnpm --filter @berry/local-agent typecheck
pnpm --filter @berry/harness typecheck
pnpm --filter @berry/api typecheck
pnpm --filter @berry/local-agent test -- src/model-adapters.test.ts src/usage.test.ts
pnpm --filter @berry/router-client test -- src/index.test.ts
```

Expected: exit 0; only named tests run.

Implementation note (2026-07-28): deterministic prompt manifests now hash
ordered stable system/policy/project sections, canonical tool schemas, cache
capabilities, provider/model/route, retention, and the stable/dynamic boundary.
Opaque cache keys are tenant/session/manifest-derived. Explicit provider/model
capabilities gate OpenAI cache keys/24-hour retention and Anthropic stable
system/tool breakpoints; unsupported transports send no guessed fields.
OpenAI/Anthropic/router usage now carries cache reads, writes, creation
durations, eligibility, manifest hashes, and classified miss reasons through
runtime events, API persistence, CSV/reporting, and daily rollups, with legacy
`tokensCached` mapped to reads. Shared/router/local-agent/harness/API/worker
typechecks pass. The named adapter/router/rollup fixtures and the focused API
persistence assertion pass without live provider calls.
The final durable-path audit applies the same capability gate to worker model
calls, persists a stable system/tool manifest on each run, compares the prior
session manifest for miss classification, and carries cache fields into the
worker-owned usage event. Compose and Helm now give the worker the same
provider/model metadata as the API; the inline rollback path strips cache
capabilities when the feature flag is disabled.

## Work packet 5 — portable structured compaction

### 5.1 `SessionCheckpointV2`

The Zod schema must contain:

- schema/version and generated-at metadata;
- current goal and user-visible success criteria;
- constraints and standing instructions;
- completed work;
- current work;
- blockers/waiting state;
- decisions with source entry IDs;
- unresolved questions;
- exact next action;
- files read and files modified;
- artifacts and their durable IDs/paths;
- commands/checks run and results;
- tool calls, retry class, idempotency key, and outcome;
- approvals requested/resolved/pending;
- prompt-manifest hash;
- covered entry range and current leaf;
- short narrative summary for model readability.

Keep deterministic fields—files, tools, approvals, commands, durable artifact
IDs—derived from the journal. The model may summarize intent and decisions but
must not invent these records.

### 5.2 Compaction algorithm

Extend `packages/harness/src/harness/compaction/compaction.ts` without removing
its token thresholds or safe cut points.

- [x] Generate immutable segment summaries for newly compacted entry ranges.
- [x] Maintain one rolling checkpoint for quick resume.
- [x] Periodically rebase from segment summaries plus recent raw entries instead
      of repeatedly summarizing a summary.
- [x] Validate structured output. If invalid, repair once. If still invalid,
      preserve the previous valid checkpoint and append a deterministic delta.
- [x] Keep provider-native opaque compaction items where required, but always
      create the portable Berry checkpoint as well.
- [x] Include retrieval/prompt manifest references, not full retrieved
      documents, in the checkpoint.
- [x] Make compaction idempotent by session, source leaf, covered range, and
      schema version.

### 5.3 Real worker compactor

Replace the placeholder in `apps/worker/src/main.ts`:

- [x] read the Postgres session journal and current checkpoint;
- [x] acquire a per-session compaction lease;
- [x] call the configured model through existing provider governance;
- [x] write segment and rolling checkpoints transactionally;
- [x] update session status/metadata;
- [x] no-op when the requested leaf/range is already compacted;
- [x] surface retryable vs terminal errors.

The inline harness may compact at an urgent threshold, but it must persist the
same schema and never diverge from worker semantics.

### Focused tests

Create/extend one compaction test file covering:

1. schema validation;
2. safe cut points preserve tool-call/result pairs;
3. invalid model JSON repairs once, then falls back without losing the previous
   checkpoint;
4. repeated compaction of the same leaf is a no-op;
5. rolling rebase retains an old constraint and the latest next action.

Use fake model output.

### Fast gate

```sh
pnpm --filter @berry/harness typecheck
pnpm --filter @berry/worker typecheck
pnpm --filter @berry/harness test -- src/harness/compaction
pnpm --filter @berry/worker test -- src/compaction
```

Expected: exit 0; only focused compaction tests run.

Implementation note (2026-07-28): shared checkpoint helpers now validate,
overlay journal-derived fields, merge immutable segments, preserve prior state
on fallback, and periodically rebase rolling state. Harness compaction keeps
the existing token thresholds and safe cut points while emitting immutable
segment and rolling checkpoints; malformed model output gets one repair, then
a deterministic delta. Native opaque Responses compaction is retained and
augmented with the portable checkpoint. Migration 28 adds tenant-RLS-protected
per-session compaction leases. The worker now claims a lease, reads the
Postgres journal/checkpoints, applies model governance, calls the configured
Berry Router model when available, transactionally writes idempotent
segment/rolling rows, updates session/lease metadata, no-ops on an already
covered leaf, and classifies retryable versus terminal failures. The focused
schema/merge/rebase, harness repair/fallback, safe-cut, and worker idempotency
fixtures pass; shared, DB, harness, and worker typechecks pass.
The durable turn runner now triggers this compactor before a model call when
uncompacted journal tokens reach the configured/model-relative threshold.
Checkpoint generation heartbeats both leases; the following delivery reloads
the latest validated rolling checkpoint and excludes entries through its
covered leaf, preventing one long task from rebuilding unbounded history.

## Work packet 6 — durable 24–48 hour turn runner

### 6.1 Transactional turn admission

Refactor the API start-turn path so one transaction:

1. validates identity, tenant, workspace, session, permissions, and budget;
2. stores the original user message;
3. appends the session entry;
4. creates `turn_runs` in `queued`;
5. creates the first `turn_steps` row;
6. appends the initial durable `turn_events`;
7. inserts a `runtime_outbox` wakeup.

Return the run/turn ID immediately. The outbox dispatcher schedules a
deterministic `turn.execute` job. Keep the inline path behind the rollback flag
until the worker path reaches the final gate.

### 6.2 Bounded worker state machine

Add typed `turn.execute`, `turn.resume`, and `sandbox.snapshot` jobs. Implement
bounded states such as:

```text
queued
  -> assembling_context
  -> calling_model
  -> persisting_response
  -> executing_tool | compacting | waiting
  -> calling_model
  -> finalizing
  -> completed | failed | cancelled | recovery_required
```

Each queue invocation performs one bounded step or a small bounded batch, then
persists the next step and re-enqueues. It must:

- [x] claim a Postgres lease with compare-and-swap;
- [x] heartbeat while doing provider/tool/snapshot work;
- [x] allow another worker to reclaim an expired lease;
- [x] persist model response/tool intent before acting;
- [x] persist tool outcome before moving the conversation leaf;
- [x] use provider request/idempotency keys where supported;
- [x] release its lease/slot while waiting for approval, user input, scheduled
      retry, or a long external operation;
- [x] check cancellation before and after each external side effect;
- [x] finalize usage, memory extraction, task knowledge indexing, and events
      through outbox records.

Remove the assumption in the API startup reconciliation that all prior-process
running tasks are necessarily dead. Reconcile by lease/step state.

### 6.3 Postgres session storage adapter

Implement the harness `SessionStorage` contract using `session_entries`:

- [x] append with per-session monotonic sequence;
- [x] list/tree/leaf traversal matching SQLite semantics;
- [x] fork/rewind metadata;
- [x] transactionally bind run steps and checkpoints to entry IDs;
- [x] maintain SQLite as a supported local/desktop adapter.

Configure web/API/worker production to use Postgres. Stop treating
`BERRY_RUNTIME_DB_PATH` as the web runtime's authoritative state.

### 6.4 Durable events and SSE replay

Persist every externally meaningful stream event to `turn_events` before live
fanout:

- [x] allocate a per-run sequence;
- [x] publish after commit to the existing RxJS live path;
- [x] accept `Last-Event-ID` or an explicit cursor on reconnect;
- [x] replay authorized durable events in order, then subscribe to live events;
- [x] make client reconciliation ignore duplicates by run/sequence;
- [x] retain events according to a documented policy after finalization.

RxJS remains a low-latency optimization, not storage.

### 6.5 Approval and tool recovery

- [x] Persist approval request/state before emitting it.
- [x] Approval decisions append an event and outbox wakeup.
- [x] Store tool retry class with the step.
- [x] Use deterministic idempotency keys for supported writes.
- [x] On ambiguous `non_idempotent_manual` recovery, show
      `recovery_required` with enough metadata for a human to retry, mark
      complete, or cancel.
- [x] Do not automatically replay shell commands or external writes merely
      because a lease expired.

### 6.6 Sandbox continuity

Use the existing sandbox provider reconnect metadata:

- [x] persist sandbox provider/ID/state/heartbeat on the run;
- [x] reconnect when the provider sandbox still exists;
- [x] periodically archive `/workspace` through the existing file/object
      storage abstraction;
- [x] hash snapshots and skip unchanged content;
- [x] persist snapshot metadata and the last durable session leaf;
- [x] restore the newest complete snapshot when the sandbox is gone;
- [x] exclude configured secrets, transient caches, dependency stores, and
      unsafe paths;
- [x] keep snapshots asynchronous and resumable.

Increasing sandbox TTL alone does not satisfy this packet.

Implementation note (2026-07-28): the web runner now admits turns
transactionally, advances bounded Postgres-backed states through typed BullMQ
jobs, persists approvals/questions/events before fanout, and resumes by durable
lease/outbox state. Postgres session storage and sandbox snapshot
reconnect/restore are active on the durable path. Finalized events have a
documented 30-day policy enforced by the bounded retention cleanup job.
Each lease claim has a unique delivery owner, durable admission creates or
reuses only the current unjournalled user message, and input-file associations
are written in the admission transaction. Compose and Helm pass live router,
sandbox, and snapshot credentials/configuration to the worker rather than
silently selecting its fixture model.

### Focused tests

Add one state-machine test suite with fakes for Postgres repository, queue,
model, tool, event publisher, and snapshot storage. Cover only:

1. duplicate queue delivery does not duplicate a completed step;
2. an expired lease is reclaimed from the persisted next step;
3. a read-only/idempotent tool may resume;
4. an ambiguous non-idempotent tool becomes `recovery_required`;
5. approval wait releases the lease and resumes after an outbox wakeup;
6. SSE replay returns durable sequences without duplicating live events.

Do not run a 24-hour soak, Docker integration environment, agent browser, or a
real sandbox during this initial goal.

### Fast gate

```sh
pnpm --filter @berry/api typecheck
pnpm --filter @berry/worker typecheck
pnpm --filter @berry/local-agent typecheck
pnpm --filter @berry/worker test -- src/turn-runner
pnpm --filter @berry/api test -- src/http/event-stream.service.test.ts
```

Expected: exit 0; only focused runner/replay tests run.

## Work packet 7 — web controls and status

Follow `AGENTS.md`: use existing `--berry-*` variables, keep 14px body/12px
secondary/11px metadata sizing, preserve Lexical mention behavior, keep motion
interruptible, and respect reduced motion.

### 7.1 Personal memory settings

Add a compact Settings > Memory surface:

- [x] memory enabled/disabled and implicit extraction enabled/disabled;
- [x] paginated active memory list grouped by kind;
- [x] create/edit/forget actions;
- [x] explicit vs inferred indicator;
- [x] confidence/last-used/expiry where useful;
- [x] provenance link back to the source task/message when authorized;
- [x] clear-all flow with confirmation and an export action;
- [x] loading, empty, error, and disabled states.

The UI may never choose tenant/user IDs directly; use the authenticated
current-user API.

### 7.2 Project knowledge

Update the project file/library surface:

- [x] call the direct workspace-file endpoint;
- [x] show extracting/indexing/indexed/failed status;
- [x] allow retry and unlink/delete when authorized;
- [x] distinguish project-wide files from task-only attachments;
- [x] show which prior tasks have indexed outcomes;
- [x] display retrieval citations on assistant responses using stored source
      metadata.

### 7.3 Long-running task state

- [x] Reconcile stream events by durable sequence.
- [x] Show queued/running/waiting/reconnecting/recovering/
      `recovery_required` states.
- [x] Preserve pending approval/user-input surfaces after page reload.
- [x] Provide safe recovery actions only for states exposed by the API.
- [x] Show cache read/write tokens and miss reason in an existing developer/
      usage detail surface; do not clutter normal chat.

Implementation note (2026-07-28): Settings now includes authenticated
personal-memory controls and cache diagnostics. The Library includes direct
project knowledge files, outcome status, retry/unlink controls, visibility, and
stored citations. Task streams persist cursors, deduplicate by run/sequence,
rebuild approval/question state after reload, and expose only server-supported
manual recovery actions.

### Lightweight component tests

Add only small render/state tests for:

1. memory list/forget state;
2. project indexing status;
3. durable event dedupe;
4. recovery-required action visibility.

Do not add visual-regression or browser tests.

### Fast gate

```sh
pnpm --filter @berry/web... typecheck
pnpm --filter @berry/web... build
pnpm --filter @berry/web test -- src/components/management src/components/library src/lib/message-reconciliation.test.ts
```

Expected: typecheck/build exit 0 and only the named focused tests run.

## Work packet 8 — backfills, documentation, and final checks

### 8.1 Safe migration/backfill behavior

- [x] Add an idempotent backfill job that creates `workspace_files` for existing
      task-linked files where the task belongs to a project.
- [x] Add an idempotent knowledge-source backfill for active project files and
      completed task outcomes.
- [x] Do not implicitly create personal memory from historical chats during the
      initial rollout.
- [x] Make backfill batches bounded, checkpointed, tenant-scoped, and resumable.
- [x] Add operator-visible progress/failure counts.

### 8.2 Operational documentation

Update `deploy/README.md`, `deploy/PRODUCTION.md`, or a focused new runbook with:

- [x] architecture and source-of-truth boundaries;
- [x] pgvector image migration/rollback procedure;
- [x] Tika and embedding configuration;
- [x] reindex and backfill commands;
- [x] cache telemetry interpretation;
- [x] turn lease/recovery behavior;
- [x] sandbox snapshot restore;
- [x] memory export/delete behavior;
- [x] feature-flag rollback order;
- [x] data retention and cleanup jobs.

Implementation note (2026-07-28): additive migration 32 records
tenant-scoped maintenance progress. Typed `context.backfill` and
`context.cleanup` jobs advance bounded durable cursors through the outbox; the
operator CLI starts, inspects, and cancels runs. The focused durable-context
runbook documents rollout, rollback, reindex, telemetry, recovery, memory, and
retention behavior. The final gate passed every required typecheck and the web
client/SSR build; focused cache, compaction, runner, API stream/runtime, memory,
knowledge, migration, and UI tests pass without live services or a browser.

Do not document or expose secret values.

### 8.3 Focused test inventory

The entire initial goal should add roughly these focused suites, reusing
existing test files where practical:

- schema/migration idempotency and RLS/index presence;
- knowledge ranking/scope/tombstone;
- memory scope/consolidation/forget;
- prompt-cache request/usage normalization;
- checkpoint validation/fallback/idempotency;
- durable runner lease/retry/approval;
- SSE replay/dedupe;
- four small web state/component cases.

Do not expand coverage beyond nearby regression cases discovered while coding
unless a fast test is required to prove a critical fix.

### Final required checks

Run these one at a time and fix code-level failures:

```sh
pnpm --filter @berry/shared typecheck
pnpm --filter @berry/db typecheck
pnpm --filter @berry/harness typecheck
pnpm --filter @berry/local-agent typecheck
pnpm --filter @berry/router-client typecheck
pnpm --filter @berry/web... typecheck
pnpm --filter @berry/api... typecheck
pnpm --filter @berry/worker... typecheck
pnpm --filter @berry/web... build
```

Expected: all exit 0. The `...` filters intentionally include shared
dependencies where the repository's web verification policy calls for them.

Run only the targeted tests added/changed by the work packets. Do not run:

```text
pnpm test
pnpm build
agent-browser ...
Playwright/Cypress/browser automation
Docker-wide integration suites
load/chaos/soak suites
desktop/mobile/extension/release builds
```

Before finishing:

```sh
git status --short
git diff --check
```

Expected: `git diff --check` exits 0. `git status` contains only files changed
for this plan plus the pre-existing user-owned changes named at the top.

## Done criteria

All must hold:

- [x] Every outcome checklist item is implemented.
- [x] New storage uses Postgres and tenant RLS; no new API-local authoritative
      state was introduced.
- [x] Personal memory is isolated by tenant/user and supports edit/forget/
      provenance.
- [x] Project knowledge includes direct workspace files and selected earlier
      task outcomes, with FTS/vector hybrid retrieval and citations.
- [x] Retrieval uses SQL scope/ACL filters and treats source text as untrusted.
- [x] Provider prompt-cache controls are capability-gated, stable-prefix-aware,
      and cache token usage reaches persistence/reporting.
- [x] Compaction emits a validated portable checkpoint and the real worker
      compactor replaces the placeholder.
- [x] Durable run steps, leases, events, approvals, and recovery paths exist.
- [x] SSE replay and sandbox snapshot restore are implemented.
- [x] Inline runtime fallback remains available behind a documented feature
      flag, while the durable runner is the enabled self-host web path.
- [x] Focused tests described above exist and pass.
- [x] Every final required typecheck/build passes.
- [x] No agent-browser, broad E2E, load, chaos, or soak test was run.
- [x] Production was not deployed and `deploy/.env.production` was untouched.
- [x] The progress ledger and execution status at the top are updated.

## STOP conditions

Stop and report instead of improvising if:

- An in-scope file has overlapping user changes that cannot be preserved with
  an additive or carefully merged implementation.
- The current database cannot load the vector extension with the pinned image,
  and resolving it would require destructive database operations.
- A required schema change would rewrite an already-applied migration rather
  than add a new one.
- The only apparent way to implement isolation bypasses existing tenant RLS or
  trusts client-provided tenant/user IDs.
- The only apparent long-run retry strategy would blindly repeat a
  non-idempotent external side effect.
- Required functionality needs new production credentials or a production
  deployment. Finish all code/config/docs that do not need them, then report the
  exact external requirement.
- A required fast check fails twice after a reasonable, scoped correction and
  the remaining fix would materially expand scope.

Missing live provider, Tika, Redis, object-storage, or sandbox credentials are
not blockers for writing the implementation and fake-based focused tests. Do
not substitute real external calls for deterministic test doubles.

## Deferred until after functional completion

These are useful follow-ups, not part of the initial goal:

- 24–48 hour soak testing and forced process/sandbox failure drills;
- large-scale retrieval relevance evaluation and HNSW parameter tuning;
- load testing cache-hit behavior and queue throughput;
- OCR-heavy extraction with Unstructured or a dedicated OCR service;
- automatic historical personal-memory mining;
- multi-region leases, event replication, and active/active workers;
- broad browser, visual-regression, mobile, desktop, and extension testing.

The code should expose metrics and seams that make those follow-ups possible,
but the executor must not delay functional completion to perform them.
