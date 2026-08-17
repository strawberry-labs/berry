# Berry agent harness production audit

> [!WARNING]
> **Superseded. Do not use this report as an implementation checklist.** The [final adversarial review](./agent-harness-production-audit-final.md) corrected several headline conclusions below, including the alleged 81st provider call, the meaning of `turn_runs.attempt`, the deletion-row backlog, and failure-path artifact loss. This file is retained only as the original audit record.

Audit date: 2026-08-16<br>
Scope: the production agent harness serving `ai.aesg.com`<br>
Access method: read-only AWS SSM commands through the `aesg-production` profile in `eu-west-1`<br>
Status: superseded historical audit; no production data, application code, deployment, or configuration was changed during collection.

## Executive summary

The retained production journal contains 675 tasks and 1,650 durable turn runs. At the audit snapshot:

- 1,275 runs completed successfully (77.3%).
- 228 runs failed or entered recovery-required (13.8%).
- 132 were cancelled (8.0%).
- 15 remained active or waiting (0.9%); 12 were waiting for user input.
- 20 of 21 non-terminal task projections were older than 30 minutes. This is a staleness proxy, not a direct measurement of user abandonment.

The dominant reliability pattern is not a single provider outage. It is a harness that can spend too long trying to make progress after the task has stopped making progress:

1. The model-iteration guard checks `>` rather than `>=`, so the configured 80-call limit permits an 81st model call. Several failed production runs ended at 81 model calls.
2. Tool execution is heartbeated but has no default per-tool wall-clock limit. The longest observed tool phase lasted about 2.6 hours.
3. Exact-argument repetition is guarded only when the same tool call fails with the same error. Successful-but-non-progressing repetitions are not stopped. Production has repeated `bash`, `read`, `run_command`, `compose_message`, and mail-search calls.
4. `ask_user_question` deliberately transitions a run to `waiting`, but there is no expiry or stale-wait supervisor. The oldest waiting runs were about 6.1 days old.
5. Artifact finalization runs on the success path only. Failure and cancellation paths persist terminal state without invoking the finalizer. This is a confirmed code-path gap; the incidence of lost user-visible artifacts cannot be measured from the retained records.

The highest-value harness changes are therefore bounded execution, durable artifact salvage/finalization, stale-wait recovery, and phase-level telemetry. Provider retry classification already exists in the current source; the production evidence supports better provider diagnostics and routing measurement, but does not by itself prove a provider retry bug.

## Reading the evidence

`Fact` means directly counted in production or directly visible in the current source. `Inference` means a reasoned interpretation of those facts. Confidence is high when the evidence is direct and joined by durable identifiers; medium when classification or causality is heuristic; low when the product does not retain the needed signal.

The production queries used tenant-scoped, read-only transactions. Prompt, response, identity, file, URL, provider request, and tenant identifiers were aggregated in memory and were not printed into the audit output.

## Data coverage and limitations

### Retained production records

The database snapshot covered one retained tenant and approximately 2026-08-09 10:31 UTC through 2026-08-16 12:12 UTC. Counts were live while the audit ran, so a few fast-changing counts moved by several rows between queries.

| Surface | Rows observed | Use in this audit |
|---|---:|---|
| `tasks` | 675 | User-visible task funnel and status projection |
| `sessions` | 675 | Session continuity; all were `active` at the snapshot |
| `messages` | 25,754 | User/assistant/tool message projection and terminal states |
| `message_parts` | 42,045 | Streamed message shape and part volume; content not emitted |
| `tool_calls` | about 13,221 | Tool volume and terminal status |
| `turn_runs` | 1,650 | Durable end-to-end state machine |
| `turn_steps` | 28,906 | Model/tool/finalization phases, attempts, and timings |
| `turn_events` | 659,351 | Admission, streaming, tool, question, error, and terminal events |
| `usage_events` | 1,734 | Turn-level provider/model usage records |
| `runtime_outbox` | 36,831 | Durable wakeups, post-turn work, retries, and stale backlog |

There were 1,631 user messages and 24,113 assistant messages. The journal is rich enough to reconstruct control flow and timing, but it does not retain a reliable product-level “user abandoned” event, user satisfaction signal, or artifact-download/consumption signal.

### Logs

All audited containers used Docker's `json-file` driver. The aggregate covered the same retention window with a small safety margin; raw log lines were never included here.

| Service group | Containers/log lines | Observed signal summary |
|---|---:|---|
| `api` | 1 / 752 | 20 timeout-like, 7 database-like, and 2 provider-5xx-like lines |
| `worker` | 1 / 131 | 120 queue-like lines; no error-like lines in the bounded scan |
| `worker-foreground` | 5 / 1,104 | 690 queue-like, 5 provider-4xx-like, and 5 error-like lines |
| `mem0` | 1 / 10 | 2 warning-like and 1 memory-like line |

These are bounded keyword classifications, not structured incident counts. The logs are sparse and do not provide a dependable per-run correlation path, so the database journal is the primary source for rates and causes. The driver options did not show an explicit `max-size`/`max-file` policy, which limits confidence about what was retained.

### Important limitations

- Row-level security required a tenant context for the runtime connection. Aggregates were run only after setting that context in a read-only transaction; no tenant identifier was printed.
- Prompt and response content was not displayed. Categories below are keyword-based paraphrases over retained content, not representative quotes. They should be used for product shape, not intent adjudication.
- Admission telemetry is incomplete: 710 admission-intent rows were retained, 625 had an admitted preparation duration, and 85 remained `preparing`. The latency sample is therefore `n=625`, not all 1,650 runs.
- `usage_events.latency_ms` was null in the retained usage rows. Latency below comes from `turn_steps` timestamps and is measured at run/phase granularity.
- `turn.finalize` rows were written as already-completed steps without phase timestamps. Finalization latency is consequently not measurable from the current journal.
- “Abandonment” is inferred from stale non-terminal state. A task may be waiting for an answer, paused by an external client, or genuinely abandoned.
- Source evidence is mapped to the current checkout. Production image-to-checkout commit equivalence was not independently verified; static behavior confidence is high, deployed applicability is medium where versions could differ.

## User behavior and prompt categories

The classifier assigns each retained user message to a paraphrased workflow bucket. It intentionally suppresses prompt text and identities. Turn-run counts are a separate workflow view; follow-up messages can change a task's category, so message and task views should not be added together.

| Anonymized workflow | User messages | Share | Turn runs |
|---|---:|---:|---:|
| General assistance and planning | 689 | 42.2% | 712 |
| Documents and artifacts | 307 | 18.8% | 317 |
| Image and visual work | 153 | 9.4% | 141 |
| Email and communications | 145 | 8.9% | 143 |
| Code and repository work | 110 | 6.7% | 121 |
| File and data operations | 108 | 6.6% | 103 |
| Calendar and scheduling | 75 | 4.6% | 71 |
| Web research and extraction | 36 | 2.2% | 28 |
| Memory and personalization | 8 | 0.5% | 14 |

The workload is therefore mostly general assistance, with a substantial document/artifact and communications tail. That tail matters for harness design: it combines long context, file writes, image inspection, external-service calls, and user approvals/questions.

Confidence: medium. The volume counts are direct, but semantic buckets are heuristic and content was intentionally not preserved in this report.

## End-to-end task funnel

### Task projection

| Current task state | Count | Share |
|---|---:|---:|
| Completed | 516 | 76.4% |
| Failed | 112 | 16.6% |
| Cancelled | 26 | 3.9% |
| Running | 14 | 2.1% |
| Queued | 6 | 0.9% |
| Waiting for approval | 1 | 0.1% |
| **Total** | **675** | **100%** |

The task projection is a user-facing summary and does not equal the count of turns: several turns may belong to one task.

### Durable run funnel

| Durable run state | Count | Share |
|---|---:|---:|
| Completed | 1,275 | 77.3% |
| Failed | 223 | 13.5% |
| Recovery required | 5 | 0.3% |
| Cancelled | 132 | 8.0% |
| Waiting | 12 | 0.7% |
| Executing tool | 2 | 0.1% |
| Calling model | 1 | 0.1% |
| **Total** | **1,650** | **100%** |

Terminal runs were 1,635/1,650 (99.1%). Grouping failed and recovery-required gives 228/1,650 (13.8%). The 15 active/waiting runs are the immediate operational tail.

### Journey reconstruction

The durable path is visible as:

```text
user message
  -> admission intent / turn.admitted
  -> context.assemble
  -> model.call (possibly repeated)
  -> tool.* / question or approval wait
  -> tool result and next model.call
  -> turn.finalize / terminal assistant projection
  -> turn.end and post-turn outbox work
```

The event journal contained approximately 11,144 `message.start` events, 10,859 `message.end` events, 13,165 `tool.start` events, 13,152 `tool.end` events, 228 `error` events, 105 `question.request` events, 98 `approval.request` events, 97 `approval.resolved` events, and 93 `question.answered` events. The small start/end differences are not treated as a failure rate because streaming/retry/recovery can create multiple message phases per turn.

Admission preparation was fast when it completed: p50 231.9 ms and p95 572.4 ms across 625 admitted intents. The retained `preparing` rows and the lack of a full join to all runs mean admission is not yet a complete funnel stage.

Of the 1,275 completed runs, 1,268 had a completed `turn.finalize` step. The remaining seven completed runs had no corresponding finalization step in the retained journal. This is a small but concrete completeness gap even before considering failed and cancelled paths.

### Latency

| Phase | Sample | p50 | p95 | p99 | Maximum |
|---|---:|---:|---:|---:|---:|
| Run creation to first model start (queue proxy) | 1,640 | 259 ms | 17.0 s | 83.0 s | 203.7 s |
| Sum of model-call durations per run | 1,639 | 30.1 s | 6.0 min | 17.9 min | 53.8 min |
| Sum of tool durations per run | 1,133 | 10.3 s | 5.3 min | 16.8 min | 2.6 h |
| Terminal run duration | 1,635 | 47.3 s | 12.3 min | 29.9 min | 27.9 h |
| Finalization duration | 0 | unavailable | unavailable | unavailable | unavailable |

The 27.9-hour terminal run was cancelled. This does not prove 27.9 hours of active computation, but it does prove that the user-visible journey can remain open far longer than the default two-hour active-turn guard.

## LLM and tool-call analysis

### Model volume and token usage

- Durable `model.call` steps: approximately 11.1k.
- Turn-level `usage_events` with `feature='model.turn'`: 1,630.
- Input tokens recorded for those turn-level usage rows: 616,840,003.
- Output tokens recorded: 7,667,894.
- `turn_events` usage events: approximately 11.2k.
- Usage latency fields were null, so provider latency was calculated from model-step timestamps instead.

The input-to-output ratio is very high. This is consistent with repeated full-context model calls and long tool histories, but the retained aggregates do not prove how much was cacheable context versus billable uncached input.

### Provider/model distribution

| Model route | Total | Completed | Failed | Cancelled | Failed share |
|---|---:|---:|---:|---:|---:|
| DeepSeek v4 Flash | 878 | 642 | 164 | 72 | 18.7% |
| MiniMax M3 | 364 | 317 | 19 | 28 | 5.2% |
| Kimi K2.6 | 346 | 291 | 26 | 29 | 7.5% |
| GLM 5.2 | 27 | 22 | 5 | 0 | 18.5% |
| Kimi K3 | 8 | 0 | 7 | 1 | 87.5% |
| Kimi K2.7 code high-speed | 2 | 0 | 2 | 0 | 100% |
| MiniMax M2.5 | 2 | 2 | 0 | 0 | 0% |
| DeepSeek v4 Pro | 1 | 1 | 0 | 0 | 0% |
| GPT Image 2 | 2 | 0 | 0 | 2 | n/a |

DeepSeek v4 Flash accounts for the largest absolute failure volume: 164 failed turn-level usage records. The low-volume model rates are directional only.

The current source has explicit provider classification: HTTP 408/429 and 5xx are retryable, known other 4xx responses are permanent, and unknown errors remain retryable (`apps/worker/src/provider-retry.ts:41-83`). Model failures capture sanitized status/code/request diagnostics (`apps/worker/src/turn-runner.ts:736-745`, `3098-3145`). The production counts establish provider failures as a material failure class, but do not establish that the current retry classifier is wrong.

### Post-turn outbox

The outbox was healthy for the interactive wakeup path: 28,937 `turn.execute` rows were completed. Memory extraction (1,268), knowledge indexing (1,268), blob verification (1,261), and turn resume (190) were also observed as completed. The exception was cleanup: all 198 observed `file.delete-blob` rows were still pending/stale, with no attempts recorded. This is treated as a cleanup backlog, not as evidence that interactive turns were queued behind it.

### Durable attempts and retries

`turn_runs.attempt` is a durable claim/reclaim counter, not a model retry count. The repository increments it on every successful lease claim (`apps/worker/src/turn-runner.ts:2200-2219`). It reached 193 in the retained data. Step attempts reached 3, consistent with the default `maxModelAttempts` guard (`apps/worker/src/turn-runner.ts:584-588`).

This distinction matters: high run attempts indicate repeated worker ownership/recovery, while high model-call counts indicate agent-loop length. Both should be reported separately in operations dashboards.

### Tool volume and failure concentration

The near-snapshot contained about 13.2k tool calls; 1,513 were failed, or 11.4%. Status rows changed slightly while the live audit ran.

| Tool | Calls | Failed | Failure share |
|---|---:|---:|---:|
| `run_command` | 3,433 | 401 | 11.7% |
| BerryCrawl search | 1,166 | 19 | 1.6% |
| `read_file` | 1,011 | 51 | 5.0% |
| `bash` | 1,008 | 116 | 11.5% |
| BerryCrawl scrape URL | 873 | 5 | 0.6% |
| `activate_skill` | 668 | 11 | 1.6% |
| `read` | 594 | 11 | 1.9% |
| `write_file` | 485 | 198 | 40.8% |
| `inspect_images` | 484 | 213 | 44.0% |
| Gmail get message | 477 | 11 | 2.3% |
| `persist_artifact` | 429 | 15 | 3.5% |
| `list_files` | 323 | 82 | 25.4% |
| `edit_file` | 203 | 20 | 9.9% |
| `append_file` | 183 | 30 | 16.4% |
| Gmail search messages | 151 | 44 | 29.1% |
| `save_personal_skill` | 147 | 100 | 68.0% |

The largest failed-call counts were `run_command` (401), `inspect_images` (213), `write_file` (198), `bash` (116), `save_personal_skill` (100), and `list_files` (82). High failure share is not proof that the tool implementation is the root cause; it identifies where a failed call most often consumes a model turn and where tool-specific validation or fallback will have the largest payoff.

### Repetition and wasted work

Repeated calls were identified by the same tool plus the same argument hash within one run. “Excess” means calls after the first exact match; it is a waste indicator, not a claim that every repeat was wrong.

| Tool | Repeated groups | Excess calls | Groups containing failures |
|---|---:|---:|---:|
| `bash` | 53 | 193 | 12 |
| `read` | 15 | 189 | 0 |
| `run_command` | 100 | 144 | 18 |
| `compose_message` | 1 | 79 | 0 |
| Gmail search threads | 1 | 75 | 0 |
| `read_file` | 33 | 42 | 5 |
| Gmail search messages | 5 | 32 | 3 |
| `write_file` | 15 | 23 | 12 |
| Google Drive get metadata | 18 | 18 | 14 |
| Google Drive read file | 6 | 16 | 5 |

The current guard stops identical failed tool calls after five matching failures (`apps/worker/src/turn-runner.ts:1041-1045`, `3168-3185`). It does not stop a successful call that returns the same observation or a presentation call that makes no durable progress. The model receives the full built-in and extension tool definition set on each model call (`apps/worker/src/turn-runner.ts:606-625`, `708-725`), which makes task-specific tool routing a reasonable improvement hypothesis.

### Representative journeys

These are metadata-only exemplars. No prompt, response, identity, path, URL, or argument was included.

| Journey shape | Observed control flow | Interpretation |
|---|---|---|
| Typical completed file/data task | About 47 s; 2–3 model calls; 1–2 tools | The harness can complete small scoped work quickly. |
| Typical communications task | About 47 s; 3–5 model calls; 3–9 mail tools | External-service workflows add calls but usually terminate cleanly. |
| Longest terminal run | 27.9 h; cancelled; 13 model calls; 17 tools; 2 failed tools | End-to-end stale/active duration is not bounded tightly enough. |
| Long completed document run | 3.4 h; 67 model calls; 71 tools; 15 failed tools; 65 `run_command` calls | The task completed, but after substantial repetition and repair. |
| Longest failed run | 88.6 min; 81 model calls; 85 tools; last phase `model.call:failed` | Consistent with the model-call ceiling boundary and/or provider failure. |
| Most repetitive run | 33.4 min; cancelled; 64 model calls; 204 tools; 179 excess exact repeats, mostly `read` | Successful repeat protection is missing. |

Among the 228 failed/recovery-required runs, the last recorded phase was `model.call:failed` 183 times. Other notable terminal tails were `write_file` failure (10), still-running compaction (7), and `run_command` failure or recovery (6 combined). These tails prioritize model-loop, artifact/file-write, and compaction recovery tests.

## Ranked stuck and failure patterns

### 1. Model-loop ceiling and non-progressing turns — P0

**Fact.** The configured limit is 80 model iterations, but `callModel` rejects only when the existing count is greater than the limit (`apps/worker/src/turn-runner.ts:571-576`). Since a pending model step at count 80 is admitted, the harness can issue the 81st model call. Several failed production exemplars ended at 81 model calls; many had no successful final response.

**Inference.** The comparison is a direct explanation for the repeated 81-call boundary. Repeated successful calls show that the failed-call guard alone is insufficient to identify non-progress.

**Confidence.** High for the off-by-one behavior; medium for the exact share of all failures caused by it.

### 2. Long tool phases without a default operation deadline — P1

**Fact.** Single-tool execution calls `withHeartbeat` without `maxDurationMs` (`apps/worker/src/turn-runner.ts:1273-1279`). `withHeartbeat` enforces idle or maximum duration only when those limits are supplied (`apps/worker/src/turn-runner.ts:1863-1903`). Production tool time reached 2.6 hours at maximum and 5.3 minutes at p95.

**Inference.** Heartbeats preserve the lease but can also keep a stalled or externally slow tool alive. A tool-specific deadline and recovery policy would reduce tail latency and prevent one tool from monopolizing a run.

**Confidence.** High for the missing default deadline; medium for causality in each long tool sample.

### 3. Waiting-for-user state can remain stale indefinitely — P1

**Fact.** `ask_user_question` commits `waiting` and releases the run for a later wakeup (`apps/worker/src/turn-runner.ts:1047-1090`). A `waiting` run is then a no-op on re-execution (`apps/worker/src/turn-runner.ts:478-480`). Twelve retained runs were waiting; the oldest were about 6.1 days old. There were 105 question requests but only 93 answers.

**Inference.** Some waiting runs are likely unanswered rather than broken. The harness lacks a durable expiry, reminder, or automatic cancellation policy, so unanswered interaction can look like an abandoned task indefinitely.

**Confidence.** High for the stale state; medium for the user-abandonment interpretation.

### 4. Artifact finalization is success-only — P0 for artifact correctness

**Fact.** The success path calls `tools.finalize` and records `turn.finalize` (`apps/worker/src/turn-runner.ts:1600-1674`). The cancellation and failure paths write terminal projections and sandbox snapshots but do not call `tools.finalize` (`apps/worker/src/turn-runner.ts:1677-1769`). Production recorded 429 `persist_artifact` calls, 15 failed, and 228 failed/recovery-required runs.

**Inference.** A failed or cancelled run can have staged or partially-created artifacts without the normal finalizer/salvage step. The data does not prove how many user-visible artifacts were lost or recoverable.

**Confidence.** High for the code-path gap; medium for user-visible impact.

### 5. High-failure tools are allowed to feed repeated repair loops — P1

**Fact.** `inspect_images` failed 44.0% of the time, `write_file` 40.8%, `save_personal_skill` 68.0%, `list_files` 25.4%, and Gmail search messages 29.1%. On a tool error, the runner persists a failed tool result and creates another model step (`apps/worker/src/turn-runner.ts:1280-1345`).

**Inference.** This is a useful recovery mechanism for transient errors, but without tool-specific repair budgets or alternate strategies it can turn a deterministic tool problem into repeated model calls. The current production data identifies the concentration; it does not distinguish bad arguments, permissions, missing files, or external-service faults.

**Confidence.** High for failure concentration and fallback behavior; medium for the loop mechanism.

### 6. Provider failure is material, but a retry defect is unconfirmed — P1

**Fact.** There were 223 failed model-turn usage records, and 183 of 228 failed/recovery runs ended on a failed model-call phase. The source records sanitized provider diagnostics and classifies retryable versus permanent failures (`apps/worker/src/turn-runner.ts:736-745`, `apps/worker/src/provider-retry.ts:41-83`).

**Inference.** Provider/model selection, request size, and failure classification deserve better dashboards and controlled fallback. The retained aggregate does not justify claiming that permanent 4xx errors are being retried incorrectly.

**Confidence.** High for volume; low-to-medium for root cause without a safe status/category join for every failed request.

### 7. Post-turn cleanup backlog — P2 unless it blocks artifact lifecycle

**Fact.** `turn.execute`, memory, knowledge, and blob-verification outbox jobs were completing. In contrast, all 198 observed `file.delete-blob` rows were pending/stale, with the oldest pending age about 6.6 days. The outbox claims due work with a lease and exponential retry delay (`apps/worker/src/outbox.ts:55-143`, `147-185`, `255-264`).

**Inference.** This is clear cleanup waste and should have a dead-letter/terminal policy. It is not proven to be the cause of interactive task failures because `turn.execute` delivery itself was healthy.

**Confidence.** High for backlog; low for direct user impact.

## Root-cause map

| Root cause | Production evidence | Source evidence | Confidence |
|---|---|---|---|
| Model-loop guard boundary is one call late | Repeated failed exemplars at 81 model calls | `turn-runner.ts:571-576` uses `>`; `modelIteration` counts model steps at `3164-3166` | High |
| Tool heartbeat is not a tool deadline | Tool p95 5.3 min; max 2.6 h | `turn-runner.ts:1273-1279` passes no duration limits; limits are optional at `1863-1903` | High |
| Waiting state has no expiry | 12 waiting runs; oldest about 6.1 days | `turn-runner.ts:478-480`, `1047-1090` | High for state, medium for abandonment |
| Failure/cancel bypasses finalizer | 15 failed `persist_artifact` calls; 228 failed/recovery runs | `turn-runner.ts:1600-1674` versus `1677-1769` | High for code gap, medium for artifact loss |
| Tool errors fall back to another model step | 1,513 failed tool calls; high concentration in file/image/skill tools | `turn-runner.ts:1280-1345` | High for behavior, medium for causality |
| Broad tool surface and successful repetition | 193 excess `bash`, 189 `read`, 144 `run_command` calls | `turn-runner.ts:619-625`, `708-725`; failed-only guard at `1041-1045` | Medium |
| Cleanup outbox lacks effective terminal handling | 198 stale `file.delete-blob` rows | `outbox.ts:255-264` | High for backlog, low for task impact |

## Harness improvements

Priority definitions: P0 blocks correctness or can strand work; P1 materially reduces recurring failure or tail latency; P2 improves efficiency, diagnostics, or maintainability.

### P0

1. **Enforce a hard model-call budget before provider invocation.** Change the boundary to reject at the configured count, persist a specific terminal reason, and add a separate no-progress budget. Keep the budget durable across leases and recovery; do not use `turn_runs.attempt` as the user-facing retry count.
2. **Make artifact finalization/salvage durable across success, failure, cancellation, and recovery.** Run it exactly once with an idempotency key, record start/end/error timestamps, and expose an explicit artifact state such as `complete`, `partial`, or `unavailable`. A failed model turn should not silently skip artifact lifecycle work.

### P1

3. **Add stale-wait and stale-run supervision.** Give unanswered questions a configurable expiry/reminder path; reconcile `waiting`, `calling_model`, and `executing_tool` runs against leases and task projections; make cancellation after admission/pre-admission converge to one terminal state.
4. **Give every tool a bounded execution policy.** Define idle and maximum durations by tool class, plus a maximum repair count. For non-idempotent tools, preserve the existing recovery-required behavior; for read-only tools, allow bounded retry/fallback; for file/image/skill tools, validate arguments and permissions before spending another model call.
5. **Use task-specific tool manifests and progress checks.** Keep the built-in safety tools, but route only relevant extension tools to each workflow. Detect repeated successful observations, unchanged file state, identical search results, and presentation-only calls; stop or ask the user when the run is not advancing.
6. **Instrument provider decisions, not just provider outcomes.** Persist sanitized HTTP class, model, retry decision, attempt, latency, and terminal classification for each model call. Add controlled fallback metrics by workflow and model. Preserve the current rule that known permanent 4xx errors are not retried unless a product-specific policy explicitly says otherwise.
7. **Make phase timing complete.** Add admission, queue, model, tool, finalization, and post-turn timestamps to one correlation view. Populate `usage_events.latency_ms` or document why it is unavailable. This will remove the current need to infer phase latency from step joins.
8. **Reduce context amplification.** Measure context tokens before each model call, compact before the hard limit, and record the reason for each compaction. The observed 616.8M input tokens across 1,630 turn-level usage rows make context growth a likely efficiency concern even though the aggregate cannot separate cached input.

### P2

9. **Give cleanup outbox jobs a terminal policy.** Add bounded retries, dead-letter state, age alerts, and lower-priority scheduling for `file.delete-blob`; distinguish cleanup backlog from interactive `turn.execute` backlog.
10. **Add privacy-safe workflow instrumentation.** Store a coarse workflow category, tool-family counts, stop reason, and artifact outcome at run level so future audits do not need content classification. Keep the category vocabulary stable and versioned.
11. **Build a sanitized production-failure fixture corpus.** Preserve shapes rather than content: 81-call model loop, repeated successful read, failed image inspection, repeated file write, stale question, failed/cancelled artifact, provider terminal failure, and stale delete outbox.

## Regression tests based on production failures

The current test suite already covers several neighboring behaviors. The following additions should be made without using production content.

| Production shape | Regression assertion | Existing test surface |
|---|---|---|
| 81 model calls at the safety boundary | A pending call at count 80 is rejected before the provider is called; the terminal reason names the configured limit | `apps/worker/src/turn-runner.test.ts:1471-1490` currently starts with 81 steps and does not exercise the boundary call |
| Successful exact repeats | Repeated successful `read`, command, search, or presentation calls stop after a progress budget or require a changed plan | `apps/worker/src/turn-runner.test.ts:1446-1469` covers changed arguments after failed calls; add the successful-repeat case |
| Long-running tool | A tool with no progress hits its class-specific idle/max deadline, releases safely, and records a retryable timeout | `apps/worker/src/turn-runner.test.ts:587-643`, `1743-1750` cover adjacent preparation/heartbeat behavior |
| Failed or cancelled artifact run | Finalization/salvage is invoked once, is idempotent, and records partial/unavailable artifact state | `apps/worker/src/turn-runner.test.ts:876-918` covers cancellation; add finalizer assertions and a failure-path fixture |
| Stale user question | Expiry, reminder, answer, and cancellation each converge to a terminal or explicitly resumable state | `apps/worker/src/turn-runner.test.ts:1608-1655` covers persistence and waiting, not expiry |
| High-failure file/image/skill tool | After a deterministic tool error, the runner tries one bounded repair or alternate tool, then stops with an actionable reason | Add characterization fixtures around the existing tool-step error path at `turn-runner.ts:1280-1345` |
| Provider 4xx/429/5xx | Permanent client errors fail without queue retry; 408/429/5xx and unknown errors follow the intended retry policy and preserve sanitized diagnostics | `apps/worker/src/provider-retry.test.ts:5-83`; `turn-runner.test.ts:392-445`, `2388-2420` |
| Stale `file.delete-blob` outbox | Retry exhaustion enters a visible terminal/dead-letter state and does not compete with interactive turn execution | `apps/worker/src/outbox.test.ts:164-276` |
| Missing phase timing | A successful and failed run both have admission, model, tool, finalization, and terminal timestamps with one correlation key | Add SQL repository/integration coverage beside the existing durable-run tests |

## Final assessment

Berry already has durable runs, leases, idempotency keys, provider diagnostics, failed-tool projection, and a useful event journal. The production problem is that those mechanisms do not yet impose a consistent “stop, preserve the result, and explain the state” contract across every path.

The first reliability milestone should be a bounded, resumable turn: no extra model call at the budget boundary, no unbounded tool phase, no indefinite user wait, and no artifact finalization gap when the model fails. Once those invariants are in place, the existing event and outbox data will be sufficient to measure whether workflow-specific routing and provider selection improve the remaining tail.
