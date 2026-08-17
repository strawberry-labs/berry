# Berry agent harness production reliability audit — final adversarial review

Audit date: 2026-08-16<br>
Mode: second-pass, read-only production and source audit<br>
Production snapshot: live data through approximately 12:51 UTC on the audit date<br>
Result: no production data, runtime, configuration, deployment, source file, schema, or original report was changed

> [!NOTE]
> **Historical baseline.** Source citations in this report are pinned to commit [`dfee9a0f874308d2785308294693340d0e5ab0f0`](https://github.com/strawberry-labs/berry/commit/dfee9a0f874308d2785308294693340d0e5ab0f0), the repository revision used for the source review. Later commits changed the agent harness, so these findings must be revalidated against the deployment candidate before implementation or release decisions. Within this report, “current source” means that pinned revision.

Evidence labels used throughout:

- **Production fact** — directly counted from tenant-scoped durable records or safe log aggregates.
- **Source fact** — directly present in the pinned source revision above.
- **Inference** — a causal or product interpretation of facts; the confidence is stated.
- **Unknown** — the retained data cannot answer it safely or reliably.

Repository paths and line ranges identify evidence in the pinned revision and can be reproduced with `git show dfee9a0f874308d2785308294693340d0e5ab0f0:<path>`. No production/customer paths, URLs, identifiers, request IDs, prompts, responses, log lines, credentials, or raw query output appear in this report.

## 1. Executive summary

Berry's durable core is substantially healthier than the first audit implied, but three convergence failures and several tail-amplification mechanisms remain serious.

At the final snapshot, 1,277 of 1,651 durable runs completed (77.3%), 223 failed (13.5%), 132 were cancelled (8.0%), 5 required recovery (0.3%), and 14 were still waiting or executing (0.8%). The central production reliability problem is not a single provider outage. It is that accepted work, parent/child state, usage settlement, waits, and side effects do not share one universal convergence contract.

The most important confirmed findings are:

1. **Accepted work can strand before durable admission.** Eighty-five admission intents remained `preparing`, all older than ten minutes and the oldest about 3.4 days. Six queued tasks had no active run. The API projects a task as running before expensive preparation finishes, while failure cleanup does not terminalize the intent and task. This is P0.
2. **Terminal parents can retain active children.** Fifteen terminal runs retained pending/running/waiting steps, eight retained unfinished tool calls, nine completed runs lacked `turn.finalize`, and one answered question still had a waiting run. This is a confirmed invariant failure. The multi-tool question path is one high-confidence source mechanism, although retained metadata cannot attribute every row to that mechanism. This is P0.
3. **Recovery-required usage is not settled.** All five recovery-required runs had durable usage events—20 in total—but none had a terminal usage ledger row. The current runner only settles completed, failed, and cancelled states. This is a direct P0 financial/accounting correctness gap.
4. **Long and repetitive work dominates the tail.** The p95 terminal duration was 12.4 minutes and the maximum 27.9 hours. One completed run invoked the model 85 times; one cancelled run made 204 tool calls with 179 excess exact repeats. Across 9,676 adjacent model-call samples, input tokens increased 95.7% of the time. The source only stops identical repeated failures, not successful or semantically unchanged loops.
5. **Execution is heartbeated but incompletely bounded.** An individual tool call reached 40.4 minutes; summed tool time in one run reached 2.63 hours. Single-tool, compaction, and finalization calls do not consistently receive wall-clock and idle deadlines, and non-abortable work can continue after durable cancellation.
6. **Questions and approvals can wait indefinitely.** Eleven unanswered questions were all older than 24 hours; the oldest was about 6.2 days. One unresolved approval was about 3.1 days old. Neither path has a complete expiry/reminder/supervisor contract.
7. **Compaction is uncommon, expensive, mostly fallback, and not usage-accounted.** Of 18 retained checkpoints, none were marked valid: eight pairs were fallback and one pair was repaired. Seven compaction steps remained running inside failed runs for as long as 5.3 days. Five runs made 153 provider calls after a completed compaction. Current compaction model calls bypass the durable usage ledger.
8. **Provider diagnosis is too sparse to assign most failures.** Diagnostics existed on 41.6% of completed model steps but only 9.2% of failed model steps. The 17 diagnosed failures split almost evenly between 4xx and 5xx. Current source also has two inconsistent retry layers, but production frequency and causality cannot be established from this snapshot.
9. **Artifacts are not as broken as the first audit suggested.** Explicit `create_image` and `persist_artifact` tools persist eagerly: all 80 successful image calls and all 414 successful persist calls with references resolved to available files. Failed and cancelled runs can retain artifacts. The real gap is that automatic sandbox-output salvage is success-only, non-atomic, and weakly observable.
10. **The interactive outbox was healthy.** All due interactive and post-turn rows were complete; there were no stale leases, due unfinished rows, high-attempt rows, or duplicate dedupe keys. The 198 unfinished deletion rows were intentionally delayed by a seven-day grace period, not a stale backlog. Current source still contains a stale-dispatcher fencing gap that should be fixed before deployment.

Four headline claims from the original audit are therefore corrected:

- The configured 80-call guard does **not** permit an 81st provider call in the current source. Failed production runs with 81 durable steps had at most 80 started steps. A completed production run with 85 started calls instead demonstrates a production/source-version or historical execution mismatch.
- `turn_runs.attempt` is **not** a reclaim count. It increments on ordinary phase claims and cannot measure worker ownership changes.
- The 198 deletion rows are **not** stale cleanup work; none was due.
- Success-only finalization does **not** mean every failed/cancelled explicit artifact is lost.

The recommended first milestone is a **bounded, convergent turn**: every accepted intent reaches admitted or terminal; every terminal run closes all children; every terminal outcome settles usage; every phase has a deadline; and every output reaches a durable, idempotent finalization state.

## 2. Audit scope and safety controls

The audit covered the requested production service groups, every retained row in the ten requested durable tables, current source, migrations, and relevant unit tests. Production access was exclusively through AWS Systems Manager. Commands were read-only and returned only counts, percentiles, categorical summaries, or anonymized tuples.

Safety controls:

| Control | Applied method |
|---|---|
| Database mutation prevention | Every aggregate ran inside `BEGIN READ ONLY`; transactions were rolled back/closed after use. |
| Row-level security | The sole retained tenant was selected inside the runtime and installed as the transaction-local tenant context. The identifier was never emitted. |
| Secret protection | The existing container connection was consumed in-process. Environment values and connection strings were never printed. |
| Content protection | Prompt, response, message-part, tool-output, file, URL, and external-service content was classified in memory/server-side and never emitted. |
| Identifier protection | No tenant, user, task, run, session, message, file, tool-call, provider-request, host, instance, command, object, or content-derived identifier is included. |
| Log safety | Docker `json-file` logs were reduced to line counts, time windows, structured event names, and bounded error/warning classes. No raw line was returned. |
| Runtime safety | No shell command changed containers, files, services, queues, databases, or configuration. |
| Repository safety | Source and the original report were read-only. This report is the only intended workspace change. |

The investigation did not deploy code, replay production work, invoke customer tools, download artifacts, test provider endpoints, or attempt to repair stale records. Those actions would have crossed the audit's authorization boundary.

## 3. Data coverage and retention limits

### Durable records

All retained rows in the requested tables were aggregated. Counts moved slightly during the live audit; this report consistently uses the closing snapshot.

| Table | Retained rows | Approximate retained window/use |
|---|---:|---|
| `tasks` | 675 | User-facing status projection; earliest task about seven days old |
| `sessions` | 675 | All projected `active`; continuity metadata |
| `messages` | 25,763 | 1,632 complete user messages and 24,131 assistant projections across complete/cancelled/failed states |
| `message_parts` | 42,054 | Stream and attachment shape; content excluded |
| `tool_calls` | 13,224 | Tool outcome, timing, retry class, approvals, and repetition |
| `turn_runs` | 1,651 | Durable state-machine denominator |
| `turn_steps` | 28,915 | Admission, context, model, tool, compaction, and finalization phases |
| `turn_events` | 659,370 | Ordered stream/control journal |
| `usage_events` | 1,737 | Turn-level model and prompt-improvement settlement |
| `runtime_outbox` | 36,841 | Every interactive wakeup and post-turn event type |

The database window was approximately 2026-08-09 10:31 UTC through 2026-08-16 12:51 UTC and contained one retained tenant. This is a seven-day operational sample, not a long-term cohort. The system does not retain a reliable user-satisfaction, abandonment, artifact-consumption, provider-attempt, or external-side-effect outcome signal.

### Docker logs

| Service group | Containers | Lines | Retained window | Safe structured signal |
|---|---:|---:|---|---|
| API | 1 | 754 | about 52.3 h | 214 context-assembly, 214 admission, 15 admission-preparation; 15 timeout-class, 3 warning, 1 error, 1 provider-4xx-class |
| Regular worker | 1 | 133 | about 46.3 h | 123 outbox dispatches and 1 cancellation receipt; 2 warning-class |
| Foreground worker | 5 | 1,116 | about 46.3 h | 723 outbox, 322 tool-manifest, 5 provider failures, 5 cancellations; 10 warning-class |
| Memory service | 1 | 10 | startup-only sample | 2 warning-class; no run-level operational series |

All used Docker's `json-file` driver. No explicit rotation options or revision labels were present in the inspected metadata. The logs covered only about two days versus roughly seven days in the database, so rates and state integrity use the durable journal as denominator.

There were 213 run-level correlations in the retained log sample and 32 appeared across more than one service group. Request, task, and session correlation keys were not consistently available, and the foreground/regular worker identity was not persisted on runs or steps. Consequently:

- queue and failure rates cannot be compared reliably by worker group;
- logs cannot reconstruct the full seven-day journey set;
- sparse log keyword counts must not be interpreted as incident rates.

## 4. Production-versus-source version confidence

Production had 50 applied migration records with a highest migration identifier of 52. The checkout defines migrations through 57. Runtime image metadata did not expose a revision label. Production is therefore behind the current schema path, but the exact deployed commit is unknown.

| Evidence | Consequence | Confidence |
|---|---|---|
| Production schema stops at migration 52; checkout continues through 57 | Findings dependent on migrations 53–57 are current-source/pre-deploy risks, not production causes | High |
| One completed production run had 85 started model steps; current source rejects a step count above 80 before invocation | Current source cannot fully explain that historical run; deployment/version or historical concurrency differed | High for mismatch, low for exact cause |
| Production uses `file.delete-blob`; current source contains evolved deletion/delivery code | Outbox semantics must be interpreted from both data and versioned source, not name matching alone | Medium |
| No image revision label | Exact source applicability cannot be proven from container metadata | High |

Source findings are classified as follows:

- **Production-confirmed mechanism** when both a production invariant and the matching current code path exist.
- **Plausible production mechanism** when production shows the symptom but version equivalence or causal join is missing.
- **Current-source-only risk** when the code is direct but the required production schema/version is absent.

The current queued-follow-up contract is synchronized: the producer emits `reason: "queued-follow-up"`, and both the producer and worker parser use the shared `TurnExecuteReasonSchema`, which includes that value (`packages/shared/src/durable-job-contracts.ts:8-15`; `apps/worker/src/jobs.ts:3-48`). This is not a current-source release blocker and is not evidence for any retained production failure.

## 5. User workflow categories

An independent, redacted classifier assigned each of the 1,632 retained user messages to one category. It did not preserve text or identifiers.

| Workflow category | User messages | Share |
|---|---:|---:|
| General assistance and planning | 869 | 53.2% |
| Documents and artifacts | 185 | 11.3% |
| Email and communications | 150 | 9.2% |
| File and data operations | 134 | 8.2% |
| Image and visual work | 106 | 6.5% |
| Calendar and scheduling | 81 | 5.0% |
| Code and repository work | 66 | 4.0% |
| Web research and extraction | 28 | 1.7% |
| Memory and personalization | 13 | 0.8% |
| **Total** | **1,632** | **100%** |

**Production fact:** general work dominates, while document, communications, file, image, and calendar workflows together form a large side-effect/tool-heavy tail.

**Adversarial qualification:** the original report assigned only 42.2% to general work and 18.8% to documents. Its rules were not documented, and this classifier produced materially different counts. Exact category rates—and therefore exact model-call or provider-failure rates by category—are not reproducible at high confidence without a versioned classifier. Category-level outcome patterns are directional only. The next implementation should persist a low-cardinality, versioned workflow label at admission rather than repeatedly classifying protected content offline.

## 6. End-to-end funnel

### Task projection

| Task state | Count | Share |
|---|---:|---:|
| Completed | 517 | 76.6% |
| Failed | 112 | 16.6% |
| Cancelled | 26 | 3.9% |
| Running | 13 | 1.9% |
| Queued | 6 | 0.9% |
| Waiting for approval | 1 | 0.1% |
| **Total** | **675** | **100%** |

### Durable run projection

| Run state | Count | Share |
|---|---:|---:|
| Completed | 1,277 | 77.3% |
| Failed | 223 | 13.5% |
| Cancelled | 132 | 8.0% |
| Recovery required | 5 | 0.3% |
| Waiting | 12 | 0.7% |
| Executing tool | 2 | 0.1% |
| **Total** | **1,651** | **100%** |

Terminal runs were 1,637/1,651 (99.2%). Failed plus recovery-required was 228/1,651 (13.8%). Task and run counts are not expected to match because a task can have multiple turns.

### Reconstructed durable path

```text
user message
  -> admission intent (preparing)
  -> durable run + turn.admitted
  -> runtime_outbox turn.execute
  -> worker claim + context.assemble
  -> model.call
  -> zero or more tool calls / model calls
  -> optional approval, question, compaction, retry, or recovery
  -> turn.finalize and assistant projection
  -> turn.end
  -> memory, knowledge, blob, snapshot, and cleanup outbox work
```

The event journal contained 1,651 `turn.start`, 1,637 `turn.end`, 11,151 `message.start`, 10,867 `message.end`, 13,173 `tool.start`, 13,160 `tool.end`, 11,213 usage events, 228 errors, 105 question requests, 93 question answers, 98 approval requests, and 97 approval resolutions. Start/end differences are integrity indicators, not direct failure rates, because retries and partial projections can create multiple event sequences per run.

### Latency funnel

| Measure | Sample | p50 | p95 | p99 | Maximum |
|---|---:|---:|---:|---:|---:|
| Admission preparation, admitted intents | 626 | 231 ms | 570 ms | 1.53 s | 1.55 s |
| Run creation to first model start | 1,641 | 259 ms | 17.0 s | 83.0 s | 203.7 s |
| Summed model time per run | 1,640 | 30.1 s | 359.2 s | 1,094.4 s | 53.8 min |
| Summed tool time per run | 1,133 | 10.3 s | 318.5 s | 1,007.4 s | 2.63 h |
| Terminal run duration | 1,637 | 47.3 s | 741.4 s | 1,794.3 s | 27.9 h |

The shortest completed exemplar lasted 1.28 seconds with one invoked model step and no tools. The maximum terminal duration was a cancelled journey; elapsed duration is not proof of continuous compute. `turn.finalize` steps lack phase timestamps, so finalization duration is unavailable.

## 7. State-machine integrity findings

| Invariant | Production result | Interpretation |
|---|---:|---|
| Multiple active runs for one task | 0 | Healthy at snapshot |
| Terminal task with active run | 0 | Healthy at snapshot |
| Non-terminal task without active run | 6 | Confirmed projection/admission gap; all require convergence review |
| Latest task/run status mismatch | 0 | Current labels agreed, despite timing separation |
| Orphan run task/session/request message | 0 | Referential integrity healthy |
| Terminal run without `turn.end` | 0 | Terminal event closure healthy |
| Non-terminal run with `turn.end` | 0 | No impossible terminal event order found |
| Terminal run with unfinished step(s) | 15 runs | Confirmed parent/child closure failure |
| Terminal run with unfinished tool call(s) | 8 runs | Confirmed parent/child closure failure |
| Completed run without `turn.finalize` | 9 | Confirmed finalization coverage gap |
| Finalized run not completed | 0 | Healthy |
| Finalization without a completed assistant projection | 16 | Medium-confidence projection gap; matching heuristic is imperfect |
| Durable tool call without matching tool step | 0 | Healthy |
| Tool step without matching durable tool call | 0 | Healthy |
| Tool step/call status mismatch | 0 | Healthy for matched terminal rows |
| Unmatched message starts / ends | 284 / 0 | Stream/projection cleanup signal; not all are necessarily defects |
| Unmatched tool starts / ends | 34 / 23 | Retry/recovery cleanup signal; causal classification unavailable |
| Impossible ordering or multiple terminal events | 0 | Event ordering healthy |

The strongest current-source mechanism for unfinished children is the question branch. `apps/worker/src/turn-runner.ts:1013-1090` selects the first runnable tool. If it is `ask_user_question`, only that step becomes waiting; sibling tool steps can remain pending. On answer, `apps/api/src/runtime/durable-turn.service.ts:1291-1387` completes the question step/call, inserts a new model step, and resumes the run without closing siblings. Existing tests exercise a lone question but not a question with sibling tool calls (`apps/worker/src/turn-runner.test.ts:1608-1658`; `apps/api/src/runtime/durable-turn.service.test.ts:917-1058`).

**Fact:** terminal rows with active children exist.<br>
**Inference:** the question-sibling path explains some or all of them.<br>
**Confidence:** high for the source defect, medium for production attribution because child lineage does not retain a closure reason.

Two runs remained `executing_tool` with no current lease owner and signals about 4.1 days old. Claiming occurs before the runner's main `try` block (`apps/worker/src/turn-runner.ts:453-456`). The repository commits a lease update before reading the full snapshot in separate queries (`apps/worker/src/turn-runner.ts:2200-2301`), and the queue processor records delivery before runner execution (`apps/worker/src/processor.ts:34-70`). This creates recoverable crash windows, but the retained records do not prove which window produced these two runs.

The state machine needs one invariant enforcer: for every terminal run, all non-terminal steps, tool calls, questions, approvals, projections, usage settlement, and finalization work must be closed or moved to an explicit recovery state in one idempotent reconciliation transaction.

## 8. Admission and queue analysis

### Admission

| Admission state | Count | Age/latency |
|---|---:|---|
| Admitted | 626 | preparation p50 231 ms, p95 570 ms, max 1.55 s |
| Preparing | 85 | all older than 10 min; oldest about 3.4 days |
| **Total intents** | **711** | live snapshot |

The admitted latency distribution is good. The failure is convergence: 12.0% of retained intents remained preparing, and those rows are not simply slow members of the admitted distribution.

`apps/api/src/http/agent-api.controller.ts:1494-1545` creates the preparing intent and projects the task as running before context/tool/budget preparation. The controller then performs substantial work and calls durable admission only near `apps/api/src/http/agent-api.controller.ts:1911-1934`. Its failure path reconciles budget but does not terminalize the admission intent and task. `apps/api/src/runtime/durable-turn.service.ts:115-145` creates the intent, while `apps/api/src/runtime/durable-turn.service.ts:319-330` marks it admitted only after the later transaction.

This directly supports the P0 mechanism: a crash or thrown preparation error can leave accepted work looking active without a run. Six queued tasks with no active run are the user-visible current tail, while the 85 historical preparing intents show the broader missing terminal state.

### Queue, claims, and worker groups

The durable schema has no separate `claimed_at`, queue delivery receipt timestamp on the run, worker service-group field, or ownership epoch history. Exact run-creation-to-first-claim, outbox-available-to-claim, lease-loss count, reclaim count, and foreground-versus-regular latency therefore cannot be measured.

Run creation to first model start is the nearest safe proxy: p50 259 ms, p95 17.0 s, p99 83.0 s, maximum 203.7 s. It includes queue delivery, claim, hydration, and model preparation; it is not pure queue latency.

The original report treated `turn_runs.attempt` as a claim/reclaim counter. Current source increments it on each successful phase claim. Production values reached 193 for completed runs, with p50 7 and p95 about 60. Those values reflect normal multi-phase execution plus any recovery—not 193 worker crashes or reclaims. Model step attempts reached 3; these are separate from model iterations, provider fallback attempts, outbox attempts, and run-phase claims.

Foreground workers produced most tool-manifest and provider-failure log events, while the regular worker log was dominated by outbox dispatch. That supports role separation, but no durable field permits a fair per-run latency comparison.

### Projection timing

No current task/run state label mismatched at the closing snapshot. An absolute timestamp-separation proxy was p50 0.1 seconds, p95 about 3.8 hours, p99 about 41.2 hours, maximum about 47.5 hours; 36 rows exceeded 30 seconds. This is not a direct propagation-lag measure because tasks can receive later turns and unrelated updates. It does show that projection timestamps are too ambiguous for an SLO.

## 9. Model-call and token analysis

### Calls per run

| Run state | Runs | Avg model steps | p50 | p95 | Maximum steps | Maximum started |
|---|---:|---:|---:|---:|---:|---:|
| Completed | 1,277 | 6.44 | 3 | 26.2 | 85 | 85 |
| Failed | 223 | 8.39 | 3 | 32.9 | 81 | 80 |
| Cancelled | 132 | 7.06 | 3 | 27.0 | 69 | 69 |
| Recovery required | 5 | 2.8 | — | — | 4 | 4 |
| Waiting | 12 | 4.5 | — | — | 18 | 18 |
| Executing tool | 2 | 7.5 | — | — | 9 | 9 |

There were 11,084 model steps with `attempt > 0`, representing actual invocation attempts across 1,641 runs. Positional analysis found:

- 1,660 invoked calls occurred before any prior tool step, spanning all 1,641 invoked runs;
- 5,561 occurred after at least one prior failed tool, spanning 442 runs;
- 153 occurred after a completed compaction, spanning 5 runs.

These are sequence facts, not waste counts: a call after a tool failure can be a valid repair. The journal has no durable “consumed result” or “strategy changed” marker, so calls after an ignored or semantically unchanged result cannot be counted exactly.

### The 80-call boundary

The first audit's off-by-one conclusion is wrong for current source. `modelIteration` counts every durable model step (`apps/worker/src/turn-runner.ts:3164-3166`). The runner rejects when the count is greater than 80 before invoking the provider (`apps/worker/src/turn-runner.ts:560-588`). Thus:

- the 80th model step is allowed and can call the provider;
- an already-created 81st step is rejected before the provider call;
- six failed production runs had 81 durable model steps but at most 80 started steps, matching that behavior;
- one completed production run had 85 started steps, contradicting current-source enforcement and demonstrating a version/historical execution mismatch.

The existing test begins with 81 steps and confirms zero further provider calls (`apps/worker/src/turn-runner.test.ts:1471-1490`). It should be supplemented with a 79/80/81 boundary sequence and a concurrency/recovery test, but the source is not off by one.

### Token and cost distribution

For 1,632 `model.turn` usage rows:

| Metric | Value |
|---|---:|
| Input tokens | 619,638,947 |
| Output tokens | 7,674,585 |
| Cache-read tokens | 245,537,327 |
| Cache-write tokens | 0 |
| Recorded cost | 159,559,608 cost-micros |
| Input p50 | 55,447 |
| Input p95 | 1,861,957 |
| Input p99 | 6,026,722 |
| Maximum input | 14,952,002 |
| Maximum output | 202,172 |
| Missing latency / time-to-first-token | 1,632 / 1,632 |

Prompt improvement added 105 usage rows, 35,230 input tokens, and 67,195 output tokens. Its latency field was populated, but time-to-first-token was not.

The input-to-output ratio is about 80.7:1. Cache-read tokens equal 39.6% of input tokens, but the ledger does not expose whether those tokens reduced billed cost consistently. The dominant efficiency problem is repeated large-context invocation, not output volume.

### Model outcomes

| Served model label | Completed | Failed | Cancelled |
|---|---:|---:|---:|
| DeepSeek Flash | 642 | 164 | 72 |
| MiniMax M3 | 317 | 19 | 28 |
| Kimi K2.6 | 293 | 26 | 29 |
| GLM | 22 | 5 | 0 |
| Kimi K3 | 0 | 7 | 1 |
| Kimi K2.7 | 0 | 2 | 0 |
| MiniMax M2.5 | 2 | 0 | 0 |
| DeepSeek Pro | 1 | 0 | 0 |
| GPT Image | 0 | 0 | 2 |

These are turn outcomes, not controlled model comparisons. Workflow mix, context size, routing, and tool usage differ, so failure-rate ranking would be confounded.

### Usage reconciliation and stop reasons

| Terminal state | Runs | No durable per-call usage events | Missing terminal ledger | Event/ledger total mismatch |
|---|---:|---:|---:|---:|
| Completed | 1,277 | 1 | 0 | 0 |
| Failed | 223 | 80 | 0 | 0 |
| Cancelled | 132 | 33 | 0 | 0 |
| Recovery required | 5 | 0 (20 events total) | 5 | n/a |

The terminal ledger reconciles exactly where it exists. Recovery-required is excluded by `apps/worker/src/turn-runner.ts:2451-2457`, creating the confirmed gap.

Only 17 of 184 failed model steps carried provider diagnostics. Five diagnosed failed steps had a `length` finish reason. No durable model-step error matched duplicate tool-call IDs in this snapshot. Empty output, duplicate provider tool-call IDs that were repaired before persistence, and provider fallback attempt counts are not reliably measurable from the retained fields.

## 10. Tool-call analysis

There were 13,224 durable tool calls. Of these, 1,513 failed, a raw failure share of 11.4%. Failure share is not implementation-defect rate: validation errors, missing resources, sandbox state, permission policy, external services, and model-selected arguments all contribute.

### Significant tools, outcomes, and latency

`Other/open` combines cancelled, pending, running, and waiting rows. Latency percentiles use only rows with both start and completion timestamps; the timed sample can therefore be smaller than total calls.

| Tool | Calls | Completed | Failed | Other/open | p50 | p95 | p99 | Max |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `run_command` | 3,433 | 3,016 | 401 | 16 | 0.68 s | 11.72 s | 77.34 s | 40.4 min |
| Web search | 1,166 | 1,141 | 19 | 6 | 0.58 s | 0.92 s | 1.24 s | 5.07 s |
| `read_file` | 1,011 | 958 | 51 | 2 | 0.48 s | 30.86 s | 182.32 s | 20.0 min |
| `bash` | 1,008 | 891 | 116 | 1 | 1.50 s | 49.08 s | 162.29 s | 9.38 min |
| Web scrape | 873 | 867 | 5 | 1 | 0.55 s | 5.14 s | 11.99 s | 31.21 s |
| `activate_skill` | 668 | 656 | 11 | 1 | 0.01 s | 49.30 s | 153.11 s | 18.7 min |
| `read` | 597 | 581 | 11 | 5 | 0.53 s | 33.42 s | 385.80 s | 24.8 min |
| `write_file` | 485 | 285 | 198 | 2 | 0.54 s | 3.59 s | 85.95 s | 19.9 min |
| `inspect_images` | 484 | 265 | 213 | 6 | 17.07 s | 59.43 s | 95.73 s | 154.53 s |
| Mail get-message | 477 | 466 | 11 | 0 | 0.20 s | 0.57 s | 1.16 s | 1.19 s |
| `persist_artifact` | 429 | 414 | 15 | 0 | 1.07 s | 3.70 s | 61.12 s | 133.83 s |
| `list_files` | 323 | 237 | 82 | 4 | 0.39 s | 55.30 s | 336.88 s | 21.4 min |
| `edit_file` | 203 | 183 | 20 | 0 | 0.91 s | 2.43 s | 3.78 s | 25.06 s |
| `append_file` | 183 | 153 | 30 | 0 | 0.93 s | 6.34 s | 67.56 s | 84.86 s |
| Mail search-messages | 151 | 107 | 44 | 0 | 0.27 s | 0.69 s | 0.78 s | 0.81 s |
| `save_personal_skill` | 147 | 47 | 100 | 0 | 0.01 s | 1.12 s | 2.23 s | 4.56 s |
| `ask_user_question` | 107 | 93 answered | 0 | 14 cancelled/open | 48.1 s | 310.7 s | 740.5 s | 23.4 min |
| `create_image` | 98 | 80 | 17 | 1 | 53.08 s | 126.67 s | 311.35 s | 320.88 s |
| Drive metadata | 62 | 31 | 31 | 0 | 0.29 s | 0.74 s | 0.78 s | 0.79 s |
| Drive read | 60 | 27 | 27 | 6 | 3.76 s | 104.35 s | 117.92 s | 126.28 s |

Other timed tools with at least 50 calls included `compose_message` (p99 0.02 s), mail thread lookup/search (p99 below 1.0 s), Drive search/list (p99 1.25–2.08 s), calendar list (p99 2.15 s), `write` (p95 92.04 s; max 9.30 min), `edit` (p99 20.71 s), and `tool_search` (p99 0.02 s). The `ask_user_question` timing is human request-to-answer latency rather than active tool execution.

The first report's “2.6-hour tool phase” was a per-run **sum** across many tools. The longest single observed call was 40.4 minutes. Both are problematic, but they require different controls: an individual-call deadline and a cumulative turn/tool budget.

### Failure ownership

A bounded, redacted keyword classifier over failure metadata produced the following high-volume patterns:

| Tool/group | Dominant classes | Most likely owner | Confidence |
|---|---|---|---|
| `run_command` | 186 command/sandbox, 156 missing resource, 38 invalid input, 9 timeout, 8 permission | Mixed model arguments and environment state; smaller policy/runtime tail | Medium |
| `write_file` | 131 unclassified, 42 sandbox, 25 invalid input | Model/tool contract and sandbox path/state; unclassified share blocks stronger attribution | Medium-low |
| `inspect_images` | 208 unclassified of 213 failures | Tool/provider/input diagnostics are insufficient | Low |
| `save_personal_skill` | 100 invalid-input-class failures | Model/tool schema contract | Medium-high |
| `bash` | 50 sandbox, 29 missing resource, 21 timeout, 16 invalid input | Mixed environment, model arguments, and execution deadline | Medium |
| Mail search | 44 invalid-input-class failures | Tool schema/argument generation | Medium-high |
| `list_files` | 43 missing resource, 35 sandbox, small timeout/other tail | Model-selected path plus sandbox state | Medium |
| Drive metadata/read | 58 combined failures | Permission, unsupported content, or connector behavior cannot be separated | Low |

This taxonomy is heuristic. It does not justify blaming providers or tool implementations without a stable error code. The highest-value tool improvements are typed validation errors with repair hints, explicit environment preconditions, and durable sanitized error ownership.

### Idempotency, approvals, and deadlines

- Read and discovery operations are generally retry-safe, but external search/read calls can still consume quota and expose changing results.
- File writes and commands can partially mutate the sandbox. Exact idempotency depends on path, command, and tool contract; the journal does not persist a postcondition fingerprint.
- Mail/calendar/Drive and other connector calls have tool-specific approval and idempotency policy. Ninety-eight durable approvals were observed: 37 associated with web search, 60 with web scrape, and 1 with Drive read in this snapshot.
- Image creation and artifact persistence have object-storage plus database side effects and need stable operation keys.
- Single-tool execution calls `withHeartbeat` without a duration/idle policy at `apps/worker/src/turn-runner.ts:1238-1279`. Parallel read calls are marked abortable but do not pass an abort signal into `tools.execute` at `apps/worker/src/turn-runner.ts:1431-1464`. `withHeartbeat` only races cancellation for work declared abortable; non-abortable work is awaited at `apps/worker/src/turn-runner.ts:1847-1965`.

## 11. Repetition and wasted-work analysis

### Exact repeated inputs

An exact repeat is the same run, tool name, and canonical input JSON. It is a conservative signal: some repeats are deliberate polls or rechecks.

| Tool | Duplicate groups | Excess calls | Groups containing failures | Largest group |
|---|---:|---:|---:|---:|
| `bash` | 53 | 193 | 23 | 67 |
| `read` | 15 | 189 | 4 | 45 |
| `run_command` | 100 | 144 | 51 | 8 |
| `compose_message` | 1 | 79 | 0 | 80 |
| Mail search-threads | 1 | 75 | 0 | 76 |
| `read_file` | 33 | 42 | — | — |
| Mail search-messages | 5 | 32 | — | — |
| `write_file` | 15 | 23 | — | — |
| Drive metadata | 18 | 18 | 17 | — |
| Drive read | 6 | 16 | — | — |
| `inspect_images` | 10 | 11 | — | — |

Overall, 154 runs (9.3%) contained at least one exact repeated input. Twenty-six runs had at least 5 excess calls, 7 had at least 20, and 4 had at least 50. The maximum was 179 excess calls; among repeat-bearing runs, p95 excess was 17.1.

Successful outputs also repeated under changed inputs: exact same-output/different-input groups appeared for `apply_patch` (4 groups, 8 excess), `bash` (2/8), mail search (4/8), `edit` (5/5), and Drive search (3/4). These are stronger no-new-observation candidates, but volatile metadata and output normalization prevent treating every equality as semantic stasis.

### Behavior after failures

| Tool | Later calls after any prior failure | Same-tool later calls | Exact-input later calls | Failure after failure |
|---|---:|---:|---:|---:|
| `run_command` | 509 | 306 | 7 | 108 |
| `write_file` | 150 | 126 | 16 | 85 |
| `bash` | 96 | 71 | 3 | 20 |
| `save_personal_skill` | 93 | 92 | 1 | 88 |
| `inspect_images` | 82 | 82 | 0 | 55 |
| Mail search-messages | 45 | 40 | 15 | 40 |

The current guard only stops repeated identical **failures** (`apps/worker/src/turn-runner.ts:1041-1045`, `3168-3195`). A successful repeat resets or bypasses it. It also cannot see alternating tools, slight argument mutations, unchanged file state, or a reformulated plan that produces no new external state.

### Safe progress definition

A production-safe progress signal should be a per-step, non-reversible fingerprint over metadata—not content:

```text
progress = any of:
  new durable artifact/file version
  changed sandbox tree/version fingerprint
  new connector cursor or distinct result-set fingerprint
  resolved question/approval
  reduced outstanding plan items
  new verified external mutation receipt
  materially smaller context after compaction
  transition into finalization/terminal state
```

Store only salted, run-local fingerprints and categorical deltas; never persist customer content or globally linkable hashes. Track `consecutive_no_progress`, cumulative no-progress model calls, and cumulative tool time. The exact-repeat population gives a conservative 9.3% upper-level screening cohort, not a 9.3% defect rate. Semantic no-progress incidence remains unknown until those fingerprints exist.

## 12. Compaction and context-growth analysis

### Context growth

| Comparison | Sample | Result |
|---|---:|---|
| Adjacent model calls | 9,676 | 9,262 increased (95.7%), 40 unchanged, 374 decreased |
| Adjacent input-token delta | 9,676 | p50 +957; p95 +12,033; p99 +69,386; max +394,912 |
| First-to-last, multi-call runs | 1,126 | 1,116 increased (99.1%) |
| First-to-last input growth | 1,126 | p50 +7,080; p95 +89,431; p99 +216,993; max +394,912 |
| Last/first input ratio | 1,126 | p50 1.37× |

Context usually grows with every loop. This alone is not a bug—new tool results and assistant reasoning add tokens—but it explains why repetition translates directly into cost and latency.

### Compaction steps and checkpoints

| Durable compaction state | Count | Run outcomes / timing |
|---|---:|---|
| Completed | 7 | 5 in failed runs, 1 completed, 1 cancelled; duration about 86–182 s |
| Cancelled | 2 | both in cancelled runs; up to about 116 s |
| Running | 7 | all inside failed runs; oldest open about 5.3 days |

The seven completed rows reported `tokensBefore` from about 120,000 to 1.73 million and `tokensAfter` from 612 to 1.55 million. At least one reduced context by only about 10.3%. Five runs made 153 invoked model calls after a completed compaction.

There were 18 checkpoints: 9 segment and 9 rolling. Eight segment/rolling pairs were fallback and one pair was repaired; none was marked valid. Rolling fallback checkpoints had p50 size 3.1 KB, p95 6.9 KB, and represented as many as 144 tool calls. Segment fallback checkpoints represented as many as 102 calls.

Current source calls the compaction model directly at `apps/worker/src/compaction.ts:462-519`; a repair can make two calls. Those calls do not flow through durable usage settlement. The previous rolling checkpoint is included in every merge prompt (`apps/worker/src/compaction.ts:773-800`), while rolling state accumulates arrays and provenance across segments (`packages/shared/src/checkpoint.ts:108-180`). This can reintroduce old tool history and amplify the very context compaction is meant to control.

**Production fact:** compaction validity was 0/9 pairs, seven rows remained running in terminal failed runs, and post-compaction calling was substantial.<br>
**Inference:** fallback quality and recursive rolling growth contribute to long-context failures.<br>
**Confidence:** high for the mechanics and accounting gap; medium-low for provider-failure causality because only 17 failed steps have diagnostics and compacted runs are a tiny, selected sample.

## 13. Questions, approvals, cancellation, and abandonment analysis

### Questions and approvals

| Wait type | Resolved | Pending | Resolution latency | Pending age |
|---|---:|---:|---|---|
| Question | 93 answered; 1 cancelled | 11 | p50 48.1 s; p95 310.7 s; max 23.4 min | p50 4.36 d; p95 6.14 d; max 6.2 d; all >24 h |
| Approval | 97 approved/resolved | 1 | p50 1.0 s; p95 7.3 s; max 26.8 s | about 3.1 d; no effective due expiry |

All pending question rows belonged to waiting runs. One answered question still belonged to a waiting run, a direct convergence mismatch. The pending approval belonged to a waiting-compatible run state, so its state label was internally consistent but stale.

Question insertion has no expiry contract (`apps/worker/src/turn-runner.ts:4468-4530`), and waiting runs are excluded from ordinary lease recovery. A later answer is accepted and creates a new model step at `apps/api/src/runtime/durable-turn.service.ts:1039-1111`, `1336-1362`. The runner's two-hour duration check is measured from the original run creation (`apps/worker/src/turn-runner.ts:577-582`), so a sufficiently late accepted answer can resume directly into a deterministic duration failure. Production answers were all under about 24 minutes, so this latter failure is source-only in this snapshot.

Approval resolution moves the run back toward execution but does not consistently project the task status in the same transaction (`apps/api/src/runtime/durable-turn.service.ts:917-1008`).

### Cancellation

There were 132 cancelled runs, 96 cancelled model steps, 2 cancelled compaction steps, and cancelled tool rows across command, read, image, search, and connector tools. The longest terminal journey was cancelled after 27.9 hours.

API cancellation durably settles the run and partial assistant projection (`apps/api/src/runtime/durable-turn.service.ts:780-846`, `1710-1768`). That is good for user responsiveness, but a non-abortable external tool can keep running after the database says cancelled because `tools.execute` does not universally receive and honor an abort signal. The journal cannot show whether such work later changed external state.

“Stale” is confirmed; “abandoned by the user” is not. A six-day question could be intentionally deferred. Product policy should explicitly choose among TTL expiry, reminder, archival, or indefinite wait, and expose that choice to the user.

## 14. Artifact and finalization analysis

### Production artifact state

| Origin/status | Production result |
|---|---|
| User upload | 620 available, 29 processing, 1 uploading, 15 deleted |
| Sandbox output | 500 available |
| Image generation | 80 available |
| Connector import | 27 available |
| Blob verification | 1,049 verified/available blobs backing 1,227 logical files; 28 verified blobs backing 29 processing files; 1 unverified uploading file |
| Pending deletion | 15 blobs linked to deleted files; 183 blobs with no live logical file; all inside grace period |

Explicit artifact tools performed better than the original report suggested:

- 80/80 successful `create_image` calls with an artifact/file reference resolved to an available file.
- 414/414 successful `persist_artifact` calls with a reference resolved to an available file.
- Cancelled runs included 4 output files across 3 runs.
- Failed runs included 15 output files across 11 runs.
- One stale executing run retained 4 output files.

Thus, failed/cancelled does not imply lost explicit artifacts. `create_image` and `persist_artifact` upload and register eagerly (`apps/worker/src/sandbox-continuity.ts:900-1013`).

### Actual finalization gap

Automatic sandbox-output salvage remains success-only. The runner calls finalization on the success path at `apps/worker/src/turn-runner.ts:1600-1674`; failure and cancellation terminalize without it at `apps/worker/src/turn-runner.ts:1677-1769`. Nine completed runs lacked a finalization step, and finalization latency/failure is unmeasurable because the step is inserted already completed without start/end timestamps.

The finalizer is not an exactly-once state machine:

- sandbox listing failures are swallowed and returned as an empty list (`apps/worker/src/sandbox-continuity.ts:1060-1069`), so a “successful” run can hide salvage failure;
- each object is written before its database row is persisted (`apps/worker/src/sandbox-continuity.ts:1088-1117`), creating partial/orphan windows;
- explicit image/artifact tools also write object storage before database registration (`apps/worker/src/sandbox-continuity.ts:900-1013`);
- logical files are registered available while blob verification is deferred (`apps/worker/src/sandbox-continuity.ts:1646-1790`).

Blob verification failure updates the blob but does not project the logical file failure (`apps/worker/src/file-blobs.ts:77-105`), while later input selection can accept logical `available`/`failed` rows without requiring a verified blob (`apps/worker/src/sandbox-continuity.ts:1646-1675`). No failed blob existed at snapshot, so this is a current-source risk, not a measured incident.

The correct fix is not simply “call the finalizer in catch.” It is a durable, idempotent finalization/salvage workflow with an operation key, per-artifact states, observable failure, and safe retry across success, failure, cancellation, and recovery.

## 15. Outbox and recovery analysis

Every retained outbox event type is included below.

| Event type | Total | Completed | Unfinished/due | Max attempts | p95 creation→completion | Max open age |
|---|---:|---:|---:|---:|---:|---:|
| `file.delete-blob` | 198 | 0 | 198 / 0 | 0 | — | 6.73 d |
| `file.verify-blob` | 1,261 | 1,261 | 0 / 0 | 1 | 19.3 s | — |
| `knowledge.chunk` | 231 | 231 | 0 / 0 | 1 | 0.2 s | — |
| `knowledge.embed` | 1,424 | 1,424 | 0 / 0 | 1 | 0.2 s | — |
| `knowledge.extract` | 260 | 260 | 0 / 0 | 1 | 0.2 s | — |
| `knowledge.index-task` | 1,268 | 1,268 | 0 / 0 | 1 | 0.2 s | — |
| `memory.extract` | 1,268 | 1,268 | 0 / 0 | 1 | 0.2 s | — |
| `sandbox.snapshot` | 1,796 | 1,796 | 0 / 0 | 1 | 805.5 s | — |
| `turn.execute` | 28,945 | 28,945 | 0 / 0 | 1 | 0.2 s | — |
| `turn.resume` | 190 | 190 | 0 / 0 | 1 | 0.1 s | — |

There were no stale leases, duplicate dedupe keys, unfinished rows with ten or more attempts, due retries older than 24 hours, or orphan turn events. Seven hundred twenty-two completed snapshot rows retained a “superseded interval” last-error marker; that is deliberate completion, not active failure.

The 198 deletion rows were scheduled by a seven-day grace policy (`apps/worker/src/file-blobs.ts:260-283`). At snapshot none was due; the soonest was about 7.1 hours away. The original “stale cleanup backlog” claim is contradicted.

`available_at` is repurposed after dispatch as a delivery-receipt deadline. Consequently, completed-at minus current available-at can be negative and is not claim latency. Exact dispatch/claim latency requires separate immutable timestamps.

### Current-source risks despite healthy production aggregates

1. The dispatcher claims globally/tenant-serially in database order, then applies BullMQ priority (`apps/worker/src/outbox.ts:55-179`). A full low-priority batch can be selected before interactive work in a later tenant. Separate lanes or priority-aware claims are safer.
2. Completion and defer updates are fenced by `lease_owner`/`completed_at`, but `fail()` is not (`apps/worker/src/outbox.ts:220-264`). A stale dispatcher can reschedule a row another worker already completed or deferred.
3. Recognized but malformed payloads flow through retry/fail rather than an explicit dead-letter state. Unsupported event names terminalize, but malformed recognized events can retry indefinitely.
4. Blob deletion performs remote object-store work while holding database locks in a transaction (`apps/worker/src/file-blobs.ts:116-209`), increasing lock duration and ambiguity if the remote call succeeds but the transaction fails.

Recovery-required classification correctly avoids automatically replaying ambiguous non-idempotent tools (`apps/worker/src/turn-runner.ts:1092-1134`). However, operator recovery selects the latest failed tool by broad timestamp rather than a dedicated recovery incident link (`apps/api/src/runtime/durable-turn.service.ts:1418-1448`), which can target the wrong call when several failures exist.

## 16. Provider failure analysis

### Diagnostic coverage and taxonomy

| Model-step state | Steps | With diagnostics | Coverage |
|---|---:|---:|---:|
| Completed | 10,825 | 4,507 | 41.6% |
| Failed | 184 | 17 | 9.2% |
| Cancelled | 96 | 0 | 0% |
| Pending/running | 7 | — | — |

All 4,507 diagnosed completed steps recorded success. The 17 diagnosed failed steps classified as:

| Redacted class | Count | Detail |
|---|---:|---|
| HTTP 4xx | 8 | 6 other client codes; 2 request/context-class |
| HTTP 5xx | 8 | 6 with code; 2 without code |
| No status/no code | 1 | unknown |

Five failed steps reported a length stop. Failed-step diagnostic coverage is too low to estimate production timeout, rate-limit, malformed request, connection, schema/tool-choice, or fallback rates. Provider failure by workflow is likewise not reproducible. The apparent model outcome differences in section 9 are confounded and must not be read as model quality rankings.

### Current retry paths

The durable classifier treats known 4xx responses, including 409, as permanent; 408, 429, 5xx, timeout, connection, and unknown failures have explicit policies (`apps/worker/src/provider-retry.ts:41-83`; tests at `apps/worker/src/provider-retry.test.ts:5-78`). The runner catch only recognizes durable/compaction errors and `RouterClientError` status (`apps/worker/src/turn-runner.ts:492-519`).

The local content fallback layer independently retries unknown failures and 409 once (`packages/local-agent/src/model.ts:254-293`). A raw fetch `TypeError` can escape the router client (`packages/router-client/src/index.ts:714-747`) and be treated differently by the fallback versus durable classifier. Once the runner terminalizes it, BullMQ's classifier at `apps/worker/src/bullmq.ts:190-224` does not receive the original failure.

**Source fact:** retry policy is split and 409 handling is inconsistent.<br>
**Production fact:** only 17 failed steps expose enough diagnostics to inspect.<br>
**Conclusion:** there is a current-source retry-policy defect, but its production frequency and contribution to 223 failed runs are unknown. This report does not claim that permanent provider errors were repeatedly retried in production.

Compaction is also a selected-risk marker: five failed runs had completed compaction, and five runs made 153 calls afterward. The sample is too small and biased to infer that compaction causes provider failure.

Required telemetry is one sanitized decision record per physical provider attempt: logical model-step key, attempt ordinal, model label, HTTP class, stable error category, retry/fallback decision, latency, input/output/cache tokens, and terminal disposition. Provider request IDs must remain excluded from analytics output.

## 17. Representative successful and failed journeys

The following are anonymized metadata-only exemplars. Durations are rounded; no content, identity, path, URL, or durable identifier is included.

| Exemplar | Durable journey |
|---|---|
| Shortest success | Completed in 1.28 s; 1 model call; 0 tools; finalized |
| Typical scheduling success | Under 3 min; 2 model calls; 1 calendar tool; about 48k input and 1k output tokens; finalized |
| Longest completed | Document/artifact workflow; 3.4 h; 67 model calls; 71 tools; 15 failed tools; about 1.83m input/14k output tokens; finalized |
| Longest terminal | Cancelled document/artifact workflow; 27.9 h elapsed; 13 model calls; 17 tools; 2 failed; about 626k input/36k output; final edit cancelled |
| Long failed model-boundary run | Code/file workflow; about 1.5 h; 81 durable model steps, 80 started; 85 tools; 67 exact excess calls; about 9.11m input/27k output; final model step failed |
| Highest input usage | Failed document/artifact workflow; about 0.5 h; 81/80 durable/started model steps; 80 tools, 14 failed; 14.95m input/102k output tokens |
| Most model calls | Completed image/visual workflow; about 0.5 h; 85 started model calls; 90 tools, 10 failed; 2.42m input/36k output; no output file association; finalized |
| Most exact repetition | Cancelled code/file workflow; about 0.6 h; 64 model calls; 204 tools, 3 failed; 179 exact excess calls; 6.46m input/105k output |
| Most tool failures | Failed after 57.3 min; 59 model calls; 60 tools, 51 failed |
| Recovery required | Image workflow; about 0.1 h; 4 model calls; 4 tools, 3 failed; last image call had ambiguous outcome; usage not terminally settled |
| Stale executing | Image workflow; about 98.7 h old; 6 model calls; 16 tools, 5 failed; 4 available output files; final image call pending; no active lease owner |
| Stale waiting | About 149.2 h old; 4 model calls; 4 tools, 2 failed; 1 unanswered question; still waiting |
| Compaction-heavy failure | Communications workflow; about 0.3 h; 81/80 durable/started model steps; 86 tools; 75 exact excess calls; 2 completed compactions; 11.28m input/44k output |
| Artifact despite failures | Completed document/artifact workflow; about 0.2 h; 45 model calls; 54 tools, 17 failed; 1 available output file; finalized |

These examples show distinct mechanisms. The 27.9-hour run is mostly elapsed openness; the 2.63-hour tool figure is cumulative work; the 40.4-minute maximum is one call; the 85-call success is a version anomaly; and the 179-repeat run is direct wasted-work evidence.

## 18. Ranked findings with P0/P1/P2 severity

P0 means correctness/release blocking; P1 means high user or operational impact requiring the next reliability milestone; P2 means important hardening/observability.

| Priority | Finding | Production frequency/evidence | User/cost impact | Confidence |
|---|---|---|---|---|
| P0 | Admission intents do not converge | 85 preparing >10 min; oldest 3.4 d; 6 queued tasks without active run | Accepted work can appear active but never execute | High |
| P0 | Terminal parent/child closure is not universal | 15 terminal runs with unfinished steps; 8 with unfinished tools; answered question still waiting | Incorrect UI, stuck work, unsafe retry/recovery | High for invariant; medium for mechanism attribution |
| P0 | Recovery-required usage is not settled | 5/5 recovery runs; 20 usage events; 0 terminal ledgers | Spend/accounting under-reporting and budget drift | High |
| P0 release blocker | Queued-follow-up job reason is rejected by worker schema | Current source producer/schema mismatch; later migration path not in production | New feature will enqueue undeliverable work | High source-only |
| P1 | Tool/compaction/finalizer phases lack consistent deadlines and abort | Individual max 40.4 min; cumulative tool max 2.63 h; stale executing rows | Long waits, capacity loss, post-cancel side effects | High source; medium causal production |
| P1 | No general successful/semantic no-progress budget | 154 runs with exact repeats; 26 with ≥5 excess; max 179 | Token/cost amplification and long tails | High |
| P1 | Waits have no expiry/reminder contract | 11 questions >24 h; max 6.2 d; one approval 3.1 d | Indefinite active tasks and confusing late resume | High |
| P1 | Automatic artifact salvage/finalization is success-only and non-atomic | 9 completed runs without finalize; explicit artifacts survive, automatic loss incidence unknown | Partial/lost outputs or hidden salvage failure | High source; medium production incidence |
| P1 | Compaction is fallback-heavy, stale, and unaccounted | 0/9 valid pairs; 7 running in failed runs; 153 post-compaction calls; missing usage | Cost amplification and weak recovery quality | High facts; medium causality |
| P1 | Provider retry policy is split; diagnostics are sparse | 9.2% failed-step coverage; current 409/unknown inconsistency | Wrong retry/fallback and unassignable failures | High source, low production frequency |
| P1 | Outbox stale failure writes are not fenced | Production outbox healthy; direct source race | Completed/deferred jobs can be resurrected | High source-only frequency unknown |
| P2 | Queue/claim/worker identity telemetry is insufficient | Exact claim/reclaim and worker-group latency unavailable | Slow incidents remain hard to localize | High |
| P2 | Task/session projection semantics are weakly timestamped | 36 large timestamp separations; session runtime metadata updates conditionally | Stale UI/ambiguous SLOs | Medium |
| P2 | Blob failure projection and deletion transaction boundaries are unsafe | No current failed blobs; direct source paths | Logical availability can diverge; locks span remote I/O | High source-only |
| P2 | Base tool surface and workflow routing remain broad | Tool-manifest log volume high; extension visibility is task-specific | Prompt size and tool-choice confusion | Medium |

## 19. Root-cause map with file/line evidence

| Symptom or risk | Current source evidence | Mechanism | Production linkage |
|---|---|---|---|
| Preparing admission never converges | `apps/api/src/http/agent-api.controller.ts:1494-1545`, `1911-1934`; `apps/api/src/runtime/durable-turn.service.ts:115-145`, `319-330` | Task is projected running before fallible preparation; catch does not close intent/task | Directly consistent with 85 stale preparing intents and 6 queued/no-active-run tasks; high confidence |
| Terminal run retains pending siblings after question | `apps/worker/src/turn-runner.ts:1013-1090`; `apps/api/src/runtime/durable-turn.service.ts:1291-1387` | First question step waits; siblings are not closed; answer inserts a model step without reconciling siblings | 15/8 terminal runs with unfinished step/tool rows; mechanism attribution medium |
| Claim/hydration crash window | `apps/worker/src/turn-runner.ts:453-456`, `2200-2301`; `apps/worker/src/processor.ts:34-70` | Lease mutation, snapshot reads, delivery acknowledgement, and execution are separate boundaries | Two stale executing runs without owner; causal attribution medium-low |
| Model safety limit misread | `apps/worker/src/turn-runner.ts:560-588`, `3164-3166`; test `apps/worker/src/turn-runner.test.ts:1471-1490` | 81st durable step is rejected before physical call; attempt/iteration are separate | Six failed 81-step runs had max 80 started; high confidence correction |
| Unbounded/late-cancelling tools | `apps/worker/src/turn-runner.ts:1238-1279`, `1431-1464`, `1847-1965` | Heartbeats renew ownership but do not impose universal duration/idle caps or propagate abort | 40.4-min call, 2.63-h cumulative tool time, stale executing rows; medium-high linkage |
| Successful/semantic repetition not stopped | `apps/worker/src/turn-runner.ts:1041-1045`, `3168-3195` | Guard recognizes only identical failed calls and errors | 154 repeat-bearing runs, max 179 excess; high linkage |
| Indefinite waits and doomed late resume | `apps/worker/src/turn-runner.ts:577-582`, `4468-4530`; `apps/api/src/runtime/durable-turn.service.ts:1039-1111`, `1336-1362` | No question TTL/supervisor; total-duration clock includes human wait | 11 questions >24 h and one answered/waiting mismatch; late-resume failure source-only |
| Recovery usage missing | `apps/worker/src/turn-runner.ts:2451-2457`, usage aggregation at `5046-5181` | Settlement terminal-state allowlist omits `recovery_required` | 5/5 recovery runs have 20 events and no ledger; direct/high |
| Automatic artifacts only finalized on success | `apps/worker/src/turn-runner.ts:1600-1769`; `apps/worker/src/sandbox-continuity.ts:1060-1117` | Failure/cancel skips auto salvage; listing errors hidden; object/DB operations are non-atomic | Nine completed runs lack finalize; explicit artifacts disprove universal loss; incidence of auto-output loss unknown |
| Blob/file state can diverge | `apps/worker/src/file-blobs.ts:77-105`; `apps/worker/src/sandbox-continuity.ts:1646-1675` | Verification failure does not project logical file; input eligibility does not require verified blob | No failed blob at snapshot; source-only |
| Compaction recursively grows and bypasses usage | `apps/worker/src/compaction.ts:462-519`, `773-800`; `packages/shared/src/checkpoint.ts:108-180` | Direct model calls outside usage path; rolling checkpoint re-fed and re-merged | 0 valid checkpoint pairs, stale compaction steps, 153 post-compaction calls; high mechanics, medium causality |
| Retry policy splits across layers | `apps/worker/src/provider-retry.ts:41-83`; `apps/worker/src/turn-runner.ts:492-519`; `packages/local-agent/src/model.ts:254-293`; `packages/router-client/src/index.ts:714-747`; `apps/worker/src/bullmq.ts:190-224` | Raw fetch errors and 409 can receive different fallback/durable treatment | Failed diagnostics only 9.2%; production frequency unknown |
| Outbox stale dispatcher can resurrect work | `apps/worker/src/outbox.ts:220-264` | `fail()` lacks the owner/completion fence used by defer/complete | No observed stale outbox row; source-only race |
| Queue priority applied too late | `apps/worker/src/outbox.ts:55-179` | DB selection fills a tenant/batch before queue priority is applied | No current due backlog; future multi-tenant/catch-up risk |
| Deletion holds locks across remote I/O | `apps/worker/src/file-blobs.ts:116-209` | Object deletion occurs inside database transaction/locks | No observed due deletion failures; source-only |
| Session runtime metadata can stay stale | `apps/worker/src/turn-runner.ts:2470-2481` | Metadata updates only when new session entries are appended | Production incidence not safely measurable |

The map deliberately separates a directly evidenced code defect from proof that it caused a particular production row. The only high-confidence one-to-one production/source matches are stale admission, recovery usage settlement, the model-boundary correction, successful repetition coverage, and the absence of wait expiry.

## 20. Detailed implementation-ready fix plans

### Plan A — P0 admission convergence

| Field | Implementation plan |
|---|---|
| Evidence/source | 85 `preparing` intents, all >10 min; 6 queued tasks without active runs. Admission split across `agent-api.controller.ts:1494-1545`, `1911-1934` and `durable-turn.service.ts:115-145`, `319-330`. |
| Mechanism/status | **Fact:** stale intents exist. **Fact:** failure cleanup omits terminal projection. **Confidence:** high. |
| Frequency/impact/cost | 12.0% of retained admission intents were stale rows; current user-facing tail is at least six tasks. Work can be accepted, budget reserved, and UI projected without a run. |
| Code change | Keep task `queued/preparing` until durable admission commits. Wrap “create intent + reservation reference” in one transaction. Give preparation a lease and retryable idempotency key. On every catch, transactionally mark `rejected`, `cancelled`, or `retry_pending`, reconcile the reservation, and project the task. Add a supervisor that claims expired preparation leases with `FOR UPDATE SKIP LOCKED`. |
| Data/events | Add `preparation_started_at`, `preparation_lease_expires_at`, `preparation_attempt`, `terminal_reason_code`, and `terminal_at`; emit `admission.preparation_started`, `admission.admitted`, and `admission.terminal`. Preserve one intent per request id. |
| Idempotency/retry | Admission transaction must upsert by request/idempotency key. Supervisor repeats are no-ops if a run exists or the intent is terminal. Budget reversal uses the reservation id and an exactly-once ledger constraint. |
| Tests | Crash after intent insert; after task projection; after reservation; after context/tool preparation; immediately before/after `admit`; two supervisors racing; request replay; cancellation during preparation. |
| Rollout/rollback | Shadow supervisor reports candidates first; then enable repair for newly created intents; then backfill stale rows with a separately reviewed operator tool. Rollback disables supervisor and restores old UI projection, without dropping new columns/events. |
| Acceptance | Zero preparing intents older than 10 min; 100% of accepted requests reach admitted or explicit terminal state; no task `running` without a run; admission p95 remains <1 s and p99 <2 s. |

### Plan B — P0 universal terminal closure

| Field | Implementation plan |
|---|---|
| Evidence/source | 15 terminal runs with unfinished steps, 8 with unfinished tools, 9 completed without finalization, one answered question still waiting. Question/sibling mechanism at `turn-runner.ts:1013-1090` and `durable-turn.service.ts:1291-1387`. |
| Mechanism/status | **Fact:** parent/child invariant is violated. **Inference:** question sibling handling is a principal cause. **Confidence:** high/medium respectively. |
| Frequency/impact/cost | At least 15/1,637 terminal runs (0.9%) violate step closure; can confuse UI, block retry, or create ambiguous external-state recovery. |
| Code change | Centralize `closeRun(runId, outcome, reason)` in one serializable/idempotent transaction. Lock run; close all pending/running/waiting steps, tool calls, questions, and approvals according to outcome; write one terminal projection and one `turn.end`; enqueue usage settlement and finalization. For a question in a multi-tool batch, explicitly choose one policy: cancel siblings as superseded, or persist the batch and resume siblings before the model. Never leave them implicit. |
| Data/events | Add child `closure_reason` and `closed_at`; add unique terminal event constraint or terminal sequence field; add `run.reconciled` with counts only. Store a direct `recovery_tool_call_id` for ambiguous tools. |
| Idempotency/retry | Repeated close calls return the stored outcome. Each child transition uses current non-terminal state predicates. Terminal event, settlement, and finalization outbox rows use stable run-scoped dedupe keys. |
| Tests | Question plus two sibling tools; answer replay; cancellation while question waits; failure after one sibling completes; terminalization with running model/tool/compaction; concurrent close and worker commit; recovery-specific child handling. |
| Rollout/rollback | Add invariant metrics, then shadow reconciliation, then make all terminal paths call the central function. Keep legacy paths behind a flag for one release. Rollback switches callers back; reconciler remains read-only. |
| Acceptance | Zero terminal runs with non-terminal children after 60 s; zero answered questions in waiting runs; exactly one terminal event; 100% of completed runs have an explicit finalization outcome. |

### Plan C — P0 usage settlement for every terminal state

| Field | Implementation plan |
|---|---|
| Evidence/source | 5 recovery-required runs, 20 durable usage events, no terminal ledger; allowlist at `turn-runner.ts:2451-2457`. |
| Mechanism/status | Direct fact and source match; confidence high. |
| Frequency/impact/cost | 100% of recovery-required runs in the sample. Understates cost and can weaken spend-limit enforcement. |
| Code change | Replace state allowlist with a universal terminal settlement hook invoked by Plan B. Sum through an immutable event high-watermark and record outcome separately from billability. Include compaction and fallback physical attempts. |
| Data/events | Add `settled_through_event_sequence`, `settlement_state`, `settled_at`, and `outcome`; create per-physical-attempt usage events with logical-step key. Unique key: tenant + feature + run + settlement version. |
| Idempotency/retry | Upsert monotonic totals by event sequence; retries cannot double charge. Late-arriving usage reopens settlement through a versioned adjustment row rather than overwriting history. |
| Tests | Recovery before/after usage, duplicate settlement, late event, concurrent close, zero-usage run, compaction repair, provider fallback with two physical attempts. |
| Rollout/rollback | Dual-calculate v1/v2 totals without billing impact; compare; enable v2 ledger; backfill only from immutable events after finance review. Rollback uses v1 reads but retains v2 rows. |
| Acceptance | 100% terminal runs have settled or explicit zero usage within 60 s; event/ledger mismatch zero; no duplicate cost under replay. |

### Plan D — P1 bounded execution and truthful cancellation

| Field | Implementation plan |
|---|---|
| Evidence/source | Single-call max 40.4 min; per-run tool sum 2.63 h; stale executing runs; missing universal deadlines at `turn-runner.ts:1238-1279`, `1431-1464`, `1847-1965`. |
| Mechanism/status | Source fact; production tail consistent. Causal confidence medium-high. |
| Frequency/impact/cost | p95 tool sum 5.3 min; p99 16.8 min. Long calls consume worker capacity and can mutate after UI cancellation. |
| Code change | Define tool-class idle and wall-clock budgets above observed normal p99: e.g. reads/connectors, commands, image, compaction, finalization as separate policies. Pass one `AbortSignal` through every tool adapter. Track cumulative tool/model/active-compute budgets. On timeout, persist `timed_out`; for possibly mutating tools without a verified receipt, transition to `recovery_required`, not blind retry. |
| Data/events | Add `deadline_at`, `idle_deadline_at`, `timed_out_at`, `abort_acknowledged_at`, `external_operation_key`, and sanitized `outcome_certainty`; emit `phase.deadline_exceeded`. |
| Idempotency/retry | Read-only work may auto-retry within budget. Mutating work requires operation key and receipt; ambiguous timeout never automatically replays. Cancellation waits a bounded cleanup interval, then reports “cancelled; external outcome unknown” if necessary. |
| Tests | Hung promise; heartbeat without progress; stream idle; adapter ignoring abort; cancellation during confirmed/unconfirmed mutation; deadline/lease race; late completion after terminalization. |
| Rollout/rollback | Observe-only deadline warnings for one week; enforce at 2× proposed limit; tighten by tool class. Feature flags per tool. Rollback disables enforcement while retaining telemetry. |
| Acceptance | No individual phase exceeds configured cap + cleanup grace; no active run with heartbeat older than 2× lease; p99 tool sum decreases without >1 percentage-point completion-rate regression; every post-cancel mutation has a receipt or recovery state. |

### Plan E — P1 progress budgets and model-loop semantics

| Field | Implementation plan |
|---|---|
| Evidence/source | 154 exact-repeat runs; 26 with ≥5 excess; max 179; context grew in 95.7% of adjacent calls. Failed-only guard at `turn-runner.ts:1041-1045`, `3168-3195`. |
| Mechanism/status | Exact repetition is fact; semantic waste beyond it is inference. Confidence high/medium. |
| Frequency/impact/cost | 9.3% screening cohort; one run used 6.46m input tokens and 204 tools. |
| Code change | Keep the hard physical-call ceiling. Add durable counters for consecutive no-progress calls, exact repeats, same-output repeats, failed repairs, cumulative active time, and tokens. Compute run-local progress fingerprints described in section 11. After a warning threshold, require an explicit changed plan; after a hard threshold, ask the user or stop with a structured reason. Route only workflow-relevant extension tools. |
| Data/events | Add `progress_epoch`, `progress_kind`, `consecutive_no_progress`, `physical_model_attempt`, `logical_model_iteration`, and `budget_reason`; emit `turn.progress` without content hashes. |
| Idempotency/retry | Counters advance in the same commit as step completion. Lease replays read existing epochs and cannot increment twice. Provider retries do not count as new logical strategy iterations but do count physical cost. |
| Tests | Successful identical read loop; same output with mutated arguments; alternating read/search; polling with declared progress policy; changed file version; 79/80/81 model boundary; lease replay; compaction preserving counters. |
| Rollout/rollback | Shadow-score production; review false positives by safe categories; warn-only; enforce for exact repeats; then semantic fingerprints. Per-workflow disable flag. |
| Acceptance | ≥75% reduction in runs with ≥20 exact excess; p95 input tokens/run down ≥25%; no material completion-rate loss; all safety stops carry a user-actionable reason. |

### Plan F — P1 wait lifecycle and active-time accounting

| Field | Implementation plan |
|---|---|
| Evidence/source | 11 pending questions all >24 h, max 6.2 d; approval 3.1 d; no expiry at `turn-runner.ts:4468-4530`; late answer reuses original duration clock. |
| Mechanism/status | Direct fact/source match; confidence high. |
| Frequency/impact/cost | 12 waiting runs at snapshot; indefinite UI clutter and deterministic late-resume failures. |
| Code change | Store explicit `expires_at`, reminder policy, and terminal policy per wait. Suggested defaults: reminders at 24/72 h, question expiry at 7 d, shorter policy-defined approval expiry. Separate `active_compute_ms` from wall elapsed time; resume gets a fresh active-compute lease without erasing audit history. Late answers return an explicit expired result and can create a new follow-up turn. |
| Data/events | Add `reminded_at`, `expires_at`, `expired_at`, `expiry_policy`, `resume_count`; emit `question.reminded/expired` and `approval.expired`. |
| Idempotency/retry | Reminder/expiry outbox keys include wait id + policy version. Answer and expiry race under one row lock; exactly one wins. |
| Tests | Answer before/at/after expiry; reminder replay; cancel vs answer; approval expiry; six-day resume; task projection; sandbox snapshot cleanup. |
| Rollout/rollback | First expose ages and reminders; then expiry only for new waits; grandfather existing waits or migrate with explicit policy. Rollback stops expiry jobs, not stored metadata. |
| Acceptance | Zero waits beyond TTL + 5 min; zero answered questions in waiting runs; reminders exactly once; late answers never resume a run already over active-compute budget. |

### Plan G — P1 durable artifact finalization and salvage

| Field | Implementation plan |
|---|---|
| Evidence/source | 9 completed runs lack finalize; auto salvage success-only; object/DB split at `turn-runner.ts:1600-1769`, `sandbox-continuity.ts:900-1117`. Explicit artifacts generally survive. |
| Mechanism/status | Source gap high confidence; actual lost-output frequency unknown. |
| Frequency/impact/cost | 0.7% of completed runs lack step marker; failure/cancel auto-output incidence unmeasured. Potential user-visible data loss or orphan storage. |
| Code change | Introduce `turn_finalizations` with `pending/running/complete/partial/failed/skipped`, lease, attempt, and timestamps. Enqueue one finalization event for every terminal outcome. Discover outputs into a manifest; stage object; upsert logical file by stable run + relative-output key; verify; then publish association. Preserve partial results and surface their state. |
| Data/events | `artifact_operations` records operation key, logical relative-key fingerprint, storage receipt, file reference, verification state, and sanitized error class. Add `finalization.start/end/error`. |
| Idempotency/retry | Stable object key/version and database uniqueness prevent duplicates. A retry resumes each manifest item. Failure/cancel salvage is read-only over sandbox outputs; external uploads never blindly repeat. |
| Tests | Listing failure; object succeeds/DB fails; DB succeeds/association fails; duplicate replay; two outputs same name; failed/cancelled/recovery run; verifier failure; sandbox unavailable. |
| Rollout/rollback | Shadow-manifest current successful runs; dual-write finalization records; enable failed/cancelled salvage without publishing; then publish partial artifacts. Rollback disables new worker; records remain resumable. |
| Acceptance | 100% terminal runs have finalization outcome; ≥99.9% successful explicit artifacts resolve available; zero duplicate logical files under replay; orphan-object rate measurable and <0.1%; hidden listing failures zero. |

### Plan H — P1 bounded, validated, usage-accounted compaction

| Field | Implementation plan |
|---|---|
| Evidence/source | 0/9 valid pairs, 7 stale running steps, 153 post-compaction calls, direct unaccounted model calls at `compaction.ts:462-519`. |
| Mechanism/status | Mechanics/facts high confidence; failure causality medium-low. |
| Frequency/impact/cost | Small selected set, but includes several highest-token failures and two physical calls on repair. |
| Code change | Route compaction through the same provider-attempt and usage pipeline. Enforce deadline and max two physical attempts. Validate schema, bounded bytes/items, tool-call coverage, and token reduction before commit. Merge incrementally from the new segment rather than recursively re-feeding the entire rolling checkpoint. Keep large tool outputs as references, not repeated payloads. Trigger before provider limits using token/growth thresholds. |
| Data/events | Store `algorithm_version`, `validation_state`, `tokens_before/after`, `covered_sequence`, `physical_attempts`, `fallback_reason`, and usage link. |
| Idempotency/retry | Checkpoint unique by session + covered sequence + algorithm version. A failed attempt never advances coverage; repair overwrites only an uncommitted candidate. |
| Tests | Valid/fallback/repaired output; recursive-growth guard; huge tool result; stale running recovery; timeout; double invocation; usage settlement; ≥40% and pathological <10% reduction. |
| Rollout/rollback | Shadow-generate and compare size/coverage; enable for high-token canary runs; retain old checkpoint reader for rollback. Do not rewrite historical checkpoints in place. |
| Acceptance | ≥95% valid checkpoints; zero stale compaction rows; 100% physical calls in usage; median token reduction ≥40%; post-compaction p95 input decreases and failure rate does not rise. |

### Plan I — P1 one provider attempt policy and complete diagnostics

| Field | Implementation plan |
|---|---|
| Evidence/source | Failed diagnostics 9.2%; retry split across `provider-retry.ts`, local fallback, router client, runner, and BullMQ. |
| Mechanism/status | Source inconsistency high confidence; production frequency unknown. |
| Frequency/impact/cost | At least 184 failed model steps; cause assignable for only 17. Potential duplicate permanent requests or missed transient retry. |
| Code change | Create one typed `ProviderAttemptError` and classifier used by router, fallback, runner, and queue. Decide 409 once. Preserve status class/category through wrappers. Make fallback an explicit classifier decision with a physical attempt ordinal, not an independent catch-all. |
| Data/events | One sanitized `provider.attempt` event: logical step, ordinal, model label, status class, stable code category, latency, token counters, retry/fallback decision, finish reason. Exclude request IDs and bodies. |
| Idempotency/retry | Logical model step keeps one idempotency key; physical attempts are append-only. Permanent failures never queue-retry; retryable failures obey total physical-attempt and time budgets. |
| Tests | Raw/nested fetch timeout, connection reset, 400/409/422, 408/429/5xx, cancellation, malformed stream, length stop, tool-schema error, fallback success/failure, wrapper preservation. |
| Rollout/rollback | Emit classifier decisions in shadow alongside current behavior; compare; enable by model/provider cohort; kill switch restores old decisions. |
| Acceptance | ≥99% failed attempts classified; permanent 4xx physical retry rate 0; transient retry/fallback success measurable; no duplicate usage; provider attribution covers ≥99% of model steps. |

### Plan J — P1 outbox fencing, lanes, and dead letters

| Field | Implementation plan |
|---|---|
| Evidence/source | Production due backlog zero, but unfenced `fail()` at `outbox.ts:255-264` and priority after claim at `55-179`. |
| Mechanism/status | High-confidence source risks; no current production incidence. |
| Frequency/impact/cost | Could resurrect completed work or starve interactive events during catch-up. |
| Code change | Fence every mutation by row id + lease owner + lease epoch + `completed_at IS NULL`. Claim by priority class and availability across tenants, or use separate interactive/post-turn/cleanup tables/queues. Add terminal `dead_lettered_at`, error category, and max-attempt policy. |
| Data/events | Immutable `first_available_at`, `claimed_at`, `delivered_at`, `receipt_at`, `lease_epoch`, `priority_class`, `dead_lettered_at`; stop repurposing `available_at`. |
| Idempotency/retry | Stable dedupe plus delivery ordinal; stale completion/failure updates affect zero rows and log a metric. Dead-letter replay creates an explicit new delivery generation. |
| Tests | Two dispatchers where stale one fails after completion; tenant fairness; low-priority full batch plus interactive row; malformed known payload; delivery receipt loss; producer→queue→worker queued-follow-up integration. |
| Rollout/rollback | Add fields and dual metrics; fence writes; then priority claim/lanes. Rollback keeps the old scheduler but retains the fences. |
| Acceptance | Zero stale-write successes; p95 interactive claim <1 s under cleanup saturation; no due row older than retry SLO; 100% malformed terminal payloads dead-letter within policy. |

### Plan K — P2 blob and projection hardening

| Field | Implementation plan |
|---|---|
| Evidence/source | Blob failure projection and lock-spanning remote delete are direct source risks; session/task timing is ambiguous. |
| Mechanism/status | Source high confidence; production incident frequency unknown. |
| Code change | Project blob verification outcome to logical files and require verified blob for model input. Split deletion into transactional “claim/mark” and remote delete, followed by transactional receipt; use storage version preconditions. Update task/session projection on every run transition or derive it from runs. Persist deployment revision and worker group on each claim. |
| Data/events | `file.verification_failed`, `delete.receipt`, projection source sequence, worker role, source revision, claim epoch. |
| Idempotency/retry | Deletion receipt keyed by blob/version; repeat delete treats not-found with matching version as success. Projections are monotonic by run event sequence. |
| Tests/rollout | Blob failure/read eligibility; remote success/DB failure; projection out-of-order; session update with no new entry. Ship behind read-path compatibility flags. |
| Acceptance | No logical available file backed by non-verified blob; no remote I/O under DB lock; projection lag p99 <5 s with zero sequence regressions. |

## 21. Regression tests based on production-shaped fixtures

Tests must preserve production **shapes**, never production content or identifiers.

| Fixture | Required assertion | Existing gap |
|---|---|---|
| Preparing admission crash at five boundaries | Intent/task/reservation converge exactly once; supervisor safely resumes or terminalizes | No end-to-end crash matrix |
| Question plus two sibling tools | Answer closes or intentionally resumes every sibling; no terminal active child | Current question tests use a lone step |
| Concurrent terminalization and worker commit | One terminal event/outcome; late commit rejected; children closed | No universal close transaction |
| Claim then hydration crash | Expired lease reclaims once; attempt/claim epoch distinct; no stale executing run | Existing recovery test starts from a snapshot, not the split DB boundary |
| Model calls 79→80→81 | 80th physical call allowed; 81st durable step denied before provider; recovery/concurrency cannot bypass | Existing test begins at 81 only |
| 80-step production-version anomaly | With two workers and lease loss, physical attempts never exceed budget | Missing concurrency boundary test |
| Exact successful read repeated 20 times | Progress warning and stop/ask behavior; counters survive lease replay | Guard covers repeated failures only |
| Same output with mutated search/read inputs | Run-local result fingerprint detects no progress without storing content | No semantic progress fixture |
| Tool hangs while heartbeating | Deadline wins; abort propagated; terminal/recovery outcome deterministic | Heartbeat tests do not enforce phase cap |
| Cancel during external mutation | Receipt yields completed/cancelled-known; no receipt yields recovery-required; never blind replay | Cancellation cannot prove external outcome |
| Six-day question then answer | Expiry wins or a new turn is created; original active-time budget is not instantly exceeded | No TTL/late-resume coverage |
| Approval expiry vs resolution race | Exactly one outcome and one wakeup | No expiry model |
| Recovery-required with four usage events | Terminal settlement exactly once; replay produces no extra cost | State omitted today |
| Compaction fallback then repair | Two physical attempts accounted; only valid bounded checkpoint advances coverage | Direct compactor calls bypass usage |
| Recursive rolling checkpoint | Size/provenance remain bounded across 100 segments | Current merge reuses rolling state |
| Object upload succeeds, DB insert fails | Finalizer retry reuses object receipt and creates one logical artifact | Current object/DB split can orphan |
| Failed/cancelled run with sandbox outputs | Finalization outcome is partial/complete and artifacts are safely recoverable | Auto salvage success-only |
| Blob verification fails | Logical file becomes unusable with explicit state; later input selection rejects it | Current projection gap |
| Provider raw fetch 409/429/5xx/timeout | One shared classifier decides physical retries/fallback and preserves category | Layers currently disagree |
| Stale outbox dispatcher writes failure after completion | Update affects zero rows; completed row stays completed | `fail()` lacks fence |
| Cleanup saturation plus interactive work | Interactive claim SLO holds across tenants | DB claim precedes priority |
| Queued follow-up producer→consumer | Shared schema parses and executes once | Shared enum is present; retain an end-to-end regression across the outbox boundary |
| 51-of-60 tool-failure run | Validation repairs are bounded; error ownership and no-progress stop are visible | No production-shaped failure-density test |

Add a property-based invariant suite: from any legal non-terminal snapshot and any injected crash point, replaying workers and reconcilers must eventually produce either a valid non-terminal lease/wait or a terminal run with no active children, one terminal event, one usage settlement, and one finalization outcome.

## 22. Observability and dashboard recommendations

### Required low-cardinality events

1. `admission.transition`: previous/new state, preparation duration, attempt, terminal reason.
2. `run.claim`: claim epoch, worker role, source revision, queue wait, hydration duration; omit owner identifiers from analytics.
3. `phase.transition`: phase type, attempt, idle/wall deadlines, duration, outcome.
4. `turn.progress`: progress kind, run-local epoch, consecutive no-progress count, budget remaining.
5. `provider.attempt`: model label, physical ordinal, status class/category, retry/fallback decision, duration, tokens.
6. `tool.attempt`: stable tool family, retry class, approval class, outcome owner, duration, operation certainty.
7. `wait.transition`: question/approval age, reminder, expiry, resume.
8. `finalization.transition`: manifest count, completed/partial/failed count, duration, retry.
9. `usage.settlement`: terminal outcome, event high-watermark, adjustment count, reconciled flag.
10. `outbox.transition`: priority, immutable availability, claim/delivery/receipt latency, lease epoch, dead-letter reason.

All dimensions must be allowlisted. Do not log arguments, outputs, paths, URLs, request IDs, tenant/user IDs, or content-derived global hashes.

### Dashboards and alerts

| Dashboard | Core panels | Alert |
|---|---|---|
| Admission funnel | preparing→admitted/terminal, age buckets, reservation reconciliation | any preparing >10 min; admitted ratio drop |
| State invariants | terminal active children, waiting answered, active no lease, duplicate terminal | any non-zero for >5 min |
| Queue/claims | immutable queue wait, hydration, claim epochs, worker role/revision | p95 >30 s; reclaim spike by revision |
| Run latency | active compute vs human wait; model/tool/finalizer sums | p99 active compute >30 min; max phase >cap |
| Progress/loops | exact/semantic repeats, no-progress epochs, calls/tokens per run | ≥20 excess or no-progress hard stop spike |
| Tool reliability | calls, outcome, owner category, p50/p95/p99, timeout, approval | tool-specific failure/timeout SLO breach |
| Provider | attempt status class, fallback, model, finish reason, diagnostic coverage | diagnostic coverage <99%; permanent retry >0 |
| Compaction | trigger, validation, reduction, physical calls, post-compaction growth | valid rate <95%; running >deadline |
| Waits | age, reminders, expiry, answer/resolution latency | wait beyond TTL; answered+waiting >0 |
| Artifacts | finalization coverage, partial/error, verification, orphan receipts | any terminal without outcome; orphan rate breach |
| Usage | events vs settlement, adjustments, state coverage | terminal missing settlement >60 s |
| Outbox | due age, claim/receipt latency, attempts, stale fence misses, dead letter | any stale lease/due >SLO; interactive starvation |

Define attempt counters in the dashboard glossary:

- `logical_model_iteration` — a model decision point in the agent loop;
- `physical_provider_attempt` — an HTTP/stream attempt, including fallback;
- `step_attempt` — retry of the same durable step;
- `run_claim_epoch` — change in durable ownership;
- `phase_claim_count` — ordinary phase claims, if retained;
- `outbox_delivery_attempt` — one queue delivery generation.

Never use the current `turn_runs.attempt` as a reclaim metric.

## 23. Rollout, rollback, and success criteria

### Sequenced rollout

| Phase | Scope | Gate to proceed | Rollback |
|---|---|---|---|
| 0. Instrument | Add immutable timestamps, claim epochs, progress/provider/finalization/settlement events; no behavior change | ≥99% event coverage; cardinality/privacy review passes | Disable emission flags |
| 1. P0 convergence | Admission supervisor, universal close transaction, recovery usage settlement | Shadow comparison clean for 7 days; invariant queries zero on canary | Route calls to legacy path; supervisor read-only |
| 2. Bounded execution | Warn-only deadlines and progress scoring, then exact-repeat enforcement | False-positive review; completion rate within 1 point | Per-tool/per-workflow kill switches |
| 3. Wait/finalization | New waits get TTL; dual-write finalization; partial artifact publishing later | No duplicate artifacts; reminder/expiry races pass | Stop expiry/finalizer workers; records remain resumable |
| 4. Compaction/provider | Shadow new compactor/classifier; canary by run cohort/model | Valid checkpoints ≥95%; diagnostic coverage ≥99% | Old reader/classifier flags |
| 5. Outbox/blob | Fences, shared schemas, dead letters, then priority lanes/two-phase deletion | Stale-write test and saturation test pass | Keep fences; revert scheduler/delete coordinator |

Do not backfill or auto-repair historical production rows as part of code rollout. Historical repair needs a separately reviewed, dry-run-first operator procedure with counts and reversible decisions.

### Global acceptance criteria

- Admission: zero preparing intents older than 10 minutes; 100% accepted requests admitted or explicitly terminal.
- State: zero terminal runs with active children after 60 seconds; zero active runs with expired/no lease outside intentional waiting.
- Usage: 100% terminal runs settled within 60 seconds; event/ledger mismatch zero.
- Latency: first-model p95 ≤20 seconds and p99 ≤90 seconds; no phase exceeds its cap plus cleanup grace.
- Progress: runs with ≥20 exact excess calls reduced at least 75%; p95 input tokens/run reduced at least 25% without >1-point completion-rate loss.
- Waits: zero waits beyond configured TTL + 5 minutes; exactly-once reminder/expiry.
- Artifacts: every terminal run has finalization outcome; duplicate logical artifacts under replay zero; orphan rate measured and <0.1%.
- Compaction: ≥95% valid checkpoints; zero stale running rows; median reduction ≥40%; all physical attempts usage-accounted.
- Provider: ≥99% attempt diagnostic coverage; known permanent 4xx retry rate zero; fallback and retry success measurable.
- Outbox: zero stale mutation successes, stale leases, or due rows beyond SLO; interactive p95 claim <1 second during synthetic cleanup saturation.

Rollback must preserve newly written evidence. Never drop events, settlement rows, finalization manifests, or operation receipts merely because a feature flag reverts behavior.

## 24. Explicit facts versus inference

| Conclusion | Explicit facts | Inference/qualification | What is not claimed |
|---|---|---|---|
| Admission can strand | 85 intents remain preparing >10 min; source omits terminal cleanup after fallible preparation | A crash/exception in that interval caused many of them; high confidence | The exact exception for each row or that all 85 represent distinct user-visible failures |
| Parent/child closure is broken | 15 terminal runs have unfinished steps; 8 have unfinished tools; one answered question still waits | Multi-tool question handling explains some/all; medium causal confidence | That every unfinished child executed externally |
| Two executing runs are stale | No lease owner and last signals about 4.1 d old | Claim/hydration or non-abortable execution window caused them; medium-low | Which worker or crash produced them |
| The 80-call limit is not off by one | Current source rejects an 81st durable step before invocation; six failed 81-step runs have max 80 started | 85-call completion used different/historical code or concurrency; high mismatch confidence | Exact deployed commit or precise historical race |
| Repetition wastes work | 154 runs have exact repeats; max 179; repeated successful outputs exist | A subset reflects no strategic progress; medium | Every repeat is wrong or 9.3% is a defect rate |
| Long phases need bounds | Single tool max 40.4 min; cumulative run tool max 2.63 h; universal limits absent | Enforced deadlines would reduce tail/capacity use; high | That the 2.63 h came from one hung call |
| Waits can persist indefinitely | 11 questions >24 h, max 6.2 d; no TTL/supervisor | Some represent user abandonment; medium | That all stale waits are abandoned |
| Recovery usage is under-settled | 5 recovery runs have 20 usage events and no terminal ledger; source excludes state | Ledger/cost is understated for those runs; high | Currency value or invoice impact |
| Compaction is weakly convergent | 0/9 valid checkpoint pairs, 7 stale running steps, 153 post-compaction calls | Recursive rolling/fallback contributes to token failures; medium-low | That compaction caused all five associated failures |
| Explicit artifacts usually persist | All successful referenced image/persist calls resolve available; failed/cancelled runs have files | Automatic sandbox outputs can still be lost or hidden; medium | Universal artifact correctness |
| Deletion backlog is healthy delayed work | 198 rows unfinished, none due, zero attempts; source has seven-day grace | They should complete when due; medium | Future deletion success |
| Interactive outbox is healthy now | Every due row completed, max attempt one, no stale lease/dedupe duplicate | Current source races may appear under concurrency/catch-up; medium | Outbox is race-free |
| Provider retry is inconsistent in current source | Classifier/fallback layers disagree; only 17 failed steps diagnosed | Some production requests may be mishandled; low frequency confidence | A measured production permanent-error retry rate |
| Workflow mix is mostly general | Independent classifier gives 53.2% general | Exact shares are classifier-version dependent; medium | Original or new categories are ground truth |

## 25. Confidence rating for every major conclusion

| Major conclusion | Rating | Basis |
|---|---|---|
| Retained row/log coverage and one-tenant scope | High | Direct counts under read-only RLS; all requested tables/event types covered |
| Production/source mismatch exists | High | Migration gap plus 85 started calls contradict current guard; exact commit remains unknown |
| Admission convergence defect | High | Direct stale rows and direct missing cleanup path |
| Universal terminal child closure defect | High | Direct invariant query |
| Question sibling path as production cause | Medium | Direct source mechanism; production rows lack closure lineage |
| Stale executing recovery defect | Medium | Direct stale state and plausible source windows; precise cause absent |
| Current model guard is not off by one | High | Source control flow, test, and started-step evidence agree |
| `turn_runs.attempt` is not reclaim count | High | Source increment semantics and phase-shaped production distribution |
| Long execution needs phase/cumulative budgets | High | Direct latency and missing source policies |
| Cancellation can outpace external execution | Medium-high | Direct source semantics; external outcome not retained |
| Exact repetition is material | High | Canonical input grouping and representative journeys |
| Semantic no-progress prevalence | Low | No durable progress/result-consumption fingerprint |
| Context amplification is material | High | 9,676 adjacent token comparisons and total usage |
| Compaction implementation/accounting defects | High | Direct source plus checkpoint/step aggregates |
| Compaction causes provider failures | Low | Tiny selected sample and sparse provider diagnostics |
| Wait lifecycle is incomplete | High | Direct ages plus no expiry/supervisor source |
| Stale waits equal abandonment | Low | No user-intent/satisfaction signal |
| Recovery usage settlement gap | High | 5/5 direct event/ledger mismatch plus allowlist source |
| Explicit artifact persistence is healthy | High for observed calls | Every successful referenced call resolved; unreferenced/consumption unknown |
| Automatic finalization can lose/hide outputs | High source, medium incidence | Success-only/non-atomic source; no complete production manifest |
| Blob verification/deletion transaction risk | High source, low incidence | Direct source; no current failed/due rows |
| Production outbox was healthy | High for snapshot | All 36,841 rows classified; no due/stale/high-attempt row |
| Outbox stale-writer/priority risk | High source, unknown frequency | Direct predicates/order; no observed race |
| Queued-follow-up incompatibility | High source-only | Producer/consumer enum mismatch; feature schema not deployed |
| Provider diagnostics are inadequate | High | 9.2% failed-step coverage |
| Current provider retry layers are inconsistent | High source | Direct 409/raw-error handling differences |
| Provider retry defect caused a material production share | Low | Physical attempts and most failure categories absent |
| Workflow category shares | Medium | Counts direct under an independent heuristic; classifier not versioned |
| Foreground worker is slower/faster than regular worker | Unknown | Worker role not durably joinable |

## 26. Discrepancies from the original audit

| Original claim or framing | Adversarial result | Disposition |
|---|---|---|
| `>` at an 80 limit permits an 81st model call | `modelIteration` already includes the pending step. The 81st durable step is rejected before invocation; failed 81-step runs had max 80 started | **Wrong; corrected** |
| Several failures ended at 81 model calls | They ended with 81 durable steps, not 81 confirmed provider calls | **Wrong unit; corrected** |
| `turn_runs.attempt` is a claim/reclaim counter | It increments on normal phase claims; it cannot identify ownership changes | **Wrong; corrected** |
| Maximum tool phase about 2.6 h | 2.63 h is summed tool time in one run; maximum individual call was 40.4 min | **Overstated/mislabeled; corrected** |
| 198 `file.delete-blob` rows are stale cleanup backlog | All were deliberately scheduled inside a seven-day grace period; none was due or attempted | **Wrong; contradicted** |
| Cleanup lacks effective terminal handling, inferred from those rows | Production deletion had not become eligible. Source still lacks a general dead-letter contract, but the rows do not prove failure | **Evidence invalid; source concern retained** |
| Failure/cancellation bypassing finalizer implies possible broad artifact loss | Code gap is real, but explicit artifact tools persist eagerly; failed/cancelled runs retained files, and every successful referenced explicit call resolved | **Overstated impact; narrowed** |
| Artifact correctness should be P0 based on success-only path alone | Automatic salvage/finalization is P1 until loss incidence is measured; explicit artifacts are materially healthier | **Severity downgraded; convergence plan strengthened** |
| Broad/full extension tool surface is presented to the model | Base built-ins remain broad, but admitted built-ins are conditional and MCP visibility is task-specific/deferred (`agent-api.controller.ts:1858-1864`; `turn-runner.ts:606-625`; `mcp-tools.ts:47-52`, `289-317`) | **Overstated; corrected** |
| Workflow split: 42.2% general, 18.8% documents, 9.4% image | Independent classifier: 53.2%, 11.3%, 6.5%. Original rules were not documented | **Not reproducible; directional only** |
| Completed runs without finalization: 7 | Closing live snapshot had 9 | **Snapshot drift, not analytical contradiction** |
| 1,650 runs / 1,275 completed | Closing snapshot had 1,651 / 1,277 | **Expected live-data drift** |
| Log keyword counts covered “same retention window” | Docker logs retained about two days, database about seven; no explicit rotation policy | **Overstated coverage; corrected** |
| Provider retry defect unconfirmed | Production defect remains unconfirmed, but second-pass source review found a direct policy split around raw errors and 409 | **Original caution upheld; source risk extended** |
| Outbox `available_at` can measure claim/completion latency | Dispatch repurposes it as a future receipt deadline; current value is not immutable claim latency | **Not reproducible; metric invalid** |
| Production and checkout applicability treated mostly as one | Migration max 52 vs checkout through 57 and the 85-call anomaly require explicit version-scoped findings | **Confidence reduced and scoped** |
| Main P0 was model boundary/artifact path | Stronger P0s are stale admission, terminal child closure, and recovery usage settlement | **Priority reordered** |
| Successful repetition was qualitatively present | Second pass quantifies 154 affected runs, thresholds, exact groups, same-output variants, and 5,561 calls after a prior failed tool | **Confirmed and extended** |
| Context growth was inferred from total input | Second pass measures adjacent and first-to-last growth directly | **Confirmed and strengthened** |
| Provider/model failures could be grouped from turn outcomes | Only 9.2% of failed model steps carry diagnostics, so causal rates by model/workflow are not defensible | **Confidence reduced** |

The original report remains valuable as a hypothesis generator. Its strongest confirmed observations were stale waits, concentrated tool failures, successful repetition, missing universal tool deadlines, and success-only automatic finalization. Its main analytical errors came from conflating durable rows with physical attempts, interpreting mutable scheduling timestamps as latency, and not testing lifecycle policy before labeling backlog.

## 27. Remaining unknowns and the next safest measurements

| Unknown | Why it matters | Next safest measurement |
|---|---|---|
| Exact deployed source revision for each retained run | Explains the 85-call completion and schema/source differences | Stamp signed build revision and behavior/config version into `turn.start` and claim events; no deployment inspection needed later |
| True log retention/rotation guarantee | Two-day logs cannot support seven-day incident joins | Configure explicit size/file policy and export structured low-cardinality events; verify by aggregate oldest/newest timestamps |
| Exact queue wait, claim, lease loss, and reclaim count | Current proxy includes hydration/preparation; attempt is misleading | Add immutable `first_available_at`, `claimed_at`, `claim_epoch`, `worker_role`, `delivery_receipt_at`; aggregate only |
| Foreground versus regular worker performance | Capacity and routing decisions cannot be evaluated | Persist low-cardinality worker role/revision on claim and compare p50/p95/p99 by role |
| Physical provider retry/fallback behavior | Cannot prove permanent retries or missed transient recovery | Emit one sanitized provider-attempt decision event per physical attempt, with status class/category but no request ID/body |
| Causes of 167 failed model steps without diagnostics | Dominates provider unknowns | Make typed error preservation mandatory; alert when terminal model failure lacks category |
| Empty-output and repaired duplicate-call incidence | Current terminal rows may hide repaired provider behavior | Persist categorical finish/repair reason on every logical model step |
| Semantic no-progress rate | Exact equality misses mutated/alternating loops | Shadow run-local progress fingerprints and counters; report only low-cardinality distributions |
| Tool result actually used by the next model call | Needed to distinguish valid observation from ignored work | Add a model-input manifest containing prior step sequence references, not tool content |
| Artifact loss, partial visibility, and user consumption | Existing files prove persistence, not discoverability/value | Add finalization manifests and aggregate `available/partial/failed`; optional privacy-reviewed download/open counters |
| External side effects after cancellation/timeout | Durable cancellation can precede remote completion | Require idempotency/operation keys and sanitized receipts from mutating adapters |
| Why waits remain open | Stale does not equal abandoned | Versioned wait policy plus aggregate reminder/expiry/resume outcomes; no content inspection |
| Compaction semantic quality | Size/token reduction does not prove fidelity | Validate structured coverage and run synthetic, content-free production-shape evaluations by checkpoint version |
| Exact workflow-specific model/provider rates | Offline classifiers disagree | Persist a versioned, low-cardinality admission workflow label and allow `unknown`; audit drift |
| User satisfaction and recovery success | Completion does not mean task success | Add explicit, optional outcome feedback and track re-open/follow-up within task using aggregate counts |
| Historical impact of stale preparing intents | Current rows do not reveal whether users retried elsewhere | Dry-run reconciler that reports counts by age/state only; any repair requires separate authorization |
| Source-only race incidence (outbox/blob) | Direct code defects had no observed snapshot manifestation | Add fence-miss, dead-letter, delete-receipt, and lock-duration metrics before behavior changes |

The safest follow-up is not another content scan. It is to deploy the low-cardinality lifecycle telemetry in Phase 0, wait for a complete retention window, and repeat the same read-only invariant aggregates. That will turn the remaining low-confidence causal questions into measurable engineering decisions without exposing customer data.
