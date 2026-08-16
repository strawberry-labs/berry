import { ConflictException, Inject, Injectable, Optional } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  AgentStreamEventSchema,
  latestAssistantStreamDraft,
  messageAttachmentContent,
  PromptManifestSchema,
  TurnStateSchema,
  type AttachmentInput,
  type AgentStreamEvent,
  type JsonValue,
  type TurnState,
} from "@berry/shared";
import { CloudDatabaseService, type SqlExecutor } from "../db/cloud-database.service.js";
import { associateInputFilesInTransaction } from "../files/file-platform.service.js";
import { garbageCollectFileIfUnreferenced } from "../files/file-lifecycle.js";
import { TurnCancellationPublisher } from "./turn-cancellation-publisher.js";
import { apiRuntimeMetrics, type TurnCancellationMetricResult } from "./runtime-metrics.js";

export const DURABLE_TURN_RUNNER_ENABLED = Symbol("DURABLE_TURN_RUNNER_ENABLED");

export interface DurableTurnAdmission {
  tenantId: string;
  userId: string;
  workspaceId: string;
  taskId: string;
  sessionId: string;
  requestId: string;
  operationFingerprint: string;
  budgetReservationRequired: boolean;
  requestMessageId?: string;
  replaceFromMessageId?: string;
  input: string;
  messageInput?: string;
  attachments?: AttachmentInput[];
  continueInterruptedTurn?: boolean;
  runtimeRequest: Record<string, unknown>;
  groundingContext: JsonValue;
  promptManifest?: JsonValue;
}

export interface DurableTurnAdmissionReplay {
  tenantId: string;
  userId: string;
  workspaceId: string;
  taskId: string;
  sessionId: string;
  requestId: string;
  operationFingerprint: string;
}

export interface DurableTurnAdmissionIntent {
  tenantId: string;
  sessionId: string;
  requestId: string;
  operationFingerprint: string;
}

export interface DurableTaskActivity {
  sessionId: string;
  runId: string | null;
  runState: string | null;
  runCreatedAt: string | null;
  admissionState: "preparing" | "admitted" | "retryable" | "rejected" | "expired" | "cancelled" | null;
  admissionCreatedAt: string | null;
  admissionUpdatedAt: string | null;
}

export interface DurableEventEnvelope {
  id: string;
  runId: string;
  sequence: number;
  event: AgentStreamEvent;
  createdAt: string;
}

export interface DurableContextStats {
  usedTokens: number;
  source: "estimated" | "provider-reported";
}

type AdmissionReplayRow = {
  id: string;
  user_id: string;
  workspace_id: string;
  task_id: string;
  session_id: string;
  runtime_request: unknown;
};

type AdmissionIntentRow = {
  session_id: string;
  operation_fingerprint: string | null;
  state: "preparing" | "admitted" | "retryable" | "rejected" | "expired" | "cancelled";
  run_id: string | null;
  preparation_lease_expires_at?: Date | string | null;
};

@Injectable()
export class DurableTurnService {
  constructor(
    @Inject(CloudDatabaseService) private readonly database: CloudDatabaseService,
    @Inject(DURABLE_TURN_RUNNER_ENABLED) readonly enabled: boolean,
    @Optional() @Inject(TurnCancellationPublisher)
    private readonly cancellationPublisher?: TurnCancellationPublisher,
  ) {}

  async replayAdmission(input: DurableTurnAdmissionReplay): Promise<{ runId: string; sessionId: string } | null> {
    if (!this.enabled) return null;
    return this.database.withTenant(input.tenantId, async (executor) => {
      const retried = await loadAdmissionReplay(executor, input.tenantId, input.requestId);
      return retried ? validateAdmissionReplay(retried, input) : null;
    });
  }

  async beginAdmission(input: DurableTurnAdmissionIntent): Promise<{ runId: string; sessionId: string } | null> {
    if (!this.enabled) return null;
    return this.database.withTenant(input.tenantId, async (executor) => {
      await executor.execute(
        `
INSERT INTO turn_admission_intents (
  tenant_id,request_id,session_id,operation_fingerprint,state,
  preparation_started_at,preparation_lease_expires_at,preparation_attempt
) VALUES (
  $1::uuid,$2,$3::uuid,$4,'preparing',now(),now() + interval '5 minutes',1
)
ON CONFLICT (tenant_id,request_id) DO NOTHING
        `.trim(),
        [input.tenantId, input.requestId, input.sessionId, input.operationFingerprint],
      );
      const intent = await lockAdmissionIntent(executor, input.tenantId, input.requestId);
      if (!intent) throw new Error("Unable to persist the durable turn admission intent");
      validateAdmissionIntent(intent, input);
      if (!intent.operation_fingerprint) {
        await executor.execute(
          `
UPDATE turn_admission_intents
SET operation_fingerprint=$3,updated_at=now()
WHERE tenant_id=$1::uuid AND request_id=$2 AND operation_fingerprint IS NULL
          `.trim(),
          [input.tenantId, input.requestId, input.operationFingerprint],
        );
      }
      if (intent.state === "cancelled") throw cancelledAdmissionConflict();
      if (intent.state === "admitted" && intent.run_id) {
        return { runId: intent.run_id, sessionId: input.sessionId };
      }
      const preparationExpired = intent.state === "preparing"
        && intent.preparation_lease_expires_at !== null
        && intent.preparation_lease_expires_at !== undefined
        && new Date(intent.preparation_lease_expires_at).getTime() <= Date.now();
      if (intent.state === "retryable" || intent.state === "rejected" || intent.state === "expired" || preparationExpired) {
        await executor.execute(
          `
UPDATE turn_admission_intents
SET state='preparing',
    preparation_started_at=now(),
    preparation_lease_expires_at=now() + interval '5 minutes',
    preparation_attempt=preparation_attempt+1,
    preparation_ms=NULL,
    terminal_reason_code=NULL,
    terminal_at=NULL,
    cancelled_at=NULL,
    updated_at=now()
WHERE tenant_id=$1::uuid AND request_id=$2
          `.trim(),
          [input.tenantId, input.requestId],
        );
      }
      return null;
    });
  }

  async failAdmission(input: {
    tenantId: string;
    sessionId: string;
    requestId: string;
    reason?: "retryable" | "rejected" | "expired";
    reasonCode?: string;
  }): Promise<void> {
    if (!this.enabled) return;
    const reason = input.reason ?? "retryable";
    await this.database.withTenant(input.tenantId, async (executor) => {
      const intent = await lockAdmissionIntent(executor, input.tenantId, input.requestId);
      if (!intent || intent.session_id !== input.sessionId || intent.state === "cancelled" || intent.state === "admitted") {
        return;
      }
      await executor.execute(
        `
UPDATE turn_admission_intents
SET state=$3,
    preparation_lease_expires_at=NULL,
    preparation_ms=COALESCE(
      preparation_ms,
      GREATEST(0,FLOOR(EXTRACT(EPOCH FROM (now()-COALESCE(preparation_started_at,created_at)))*1000)::integer)
    ),
    terminal_reason_code=COALESCE($4,terminal_reason_code),
    terminal_at=COALESCE(terminal_at,now()),
    updated_at=now()
WHERE tenant_id=$1::uuid AND request_id=$2 AND state='preparing'
        `.trim(),
        [input.tenantId, input.requestId, reason, input.reasonCode ?? "admission_failed"],
      );
      await executor.execute(
        `
UPDATE tasks t
SET status=$3::task_status,
    updated_at=now()
FROM sessions s
WHERE s.tenant_id=$1::uuid AND s.id=$2::uuid
  AND t.tenant_id=s.tenant_id AND t.id=s.task_id
  AND t.status IN ('queued','running')
        `.trim(),
        [input.tenantId, input.sessionId, reason === "retryable" ? "queued" : "failed"],
      );
    });
  }

  async admit(input: DurableTurnAdmission): Promise<{ runId: string; sessionId: string }> {
    if (!this.enabled) throw new Error("Durable turn runner is disabled");
    return this.database.withTenant(input.tenantId, async (executor) => {
      const admissionIntent = await lockAdmissionIntent(executor, input.tenantId, input.requestId);
      if (admissionIntent) {
        validateAdmissionIntent(admissionIntent, input);
        if (admissionIntent.state === "cancelled") throw cancelledAdmissionConflict();
        if (admissionIntent.state === "admitted" && admissionIntent.run_id) {
          return { runId: admissionIntent.run_id, sessionId: input.sessionId };
        }
      }
      const owned = await executor.query<{ session_id: string }>(
        `
SELECT s.id AS session_id
FROM sessions s
JOIN tasks t ON t.tenant_id=s.tenant_id AND t.id=s.task_id
JOIN workspaces w ON w.tenant_id=t.tenant_id AND w.id=t.workspace_id
JOIN tenant_memberships tm ON tm.tenant_id=s.tenant_id AND tm.user_id=$2::uuid AND tm.status='active'
WHERE s.tenant_id=$1::uuid AND s.id=$3::uuid AND s.task_id=$4::uuid
  AND t.workspace_id=$5::uuid AND s.deleted_at IS NULL
  AND t.deleted_at IS NULL AND w.deleted_at IS NULL
FOR UPDATE OF s,t
        `.trim(),
        [input.tenantId, input.userId, input.sessionId, input.taskId, input.workspaceId],
      );
      if (!owned[0]) throw new Error("Session is not authorized for durable execution");
      const retried = await loadAdmissionReplay(executor, input.tenantId, input.requestId);
      if (retried) return validateAdmissionReplay(retried, input);
      const existing = await executor.query<{ id: string; request_message_id: string | null }>(
        `
SELECT id,request_message_id FROM turn_runs
WHERE tenant_id=$1::uuid AND session_id=$2::uuid
  AND state NOT IN ('completed','failed','cancelled','recovery_required')
ORDER BY created_at DESC
LIMIT 1
        `.trim(),
        [input.tenantId, input.sessionId],
      );
      if (existing[0]) {
        if (input.requestMessageId && existing[0].request_message_id === input.requestMessageId) {
          return { runId: existing[0].id, sessionId: input.sessionId };
        }
        throw new ConflictException("This session already has an active turn");
      }

      if (input.budgetReservationRequired) {
        const reservations = await executor.query<{ status: string }>(
          `
SELECT status FROM budget_reservations
WHERE tenant_id=$1::uuid AND request_id=$2
FOR UPDATE
          `.trim(),
          [input.tenantId, input.requestId],
        );
        if (reservations[0]?.status !== "reserved") {
          throw new ConflictException("The budget reservation for this turn is no longer active; submit a new operation key");
        }
      }

      if (!input.continueInterruptedTurn && input.replaceFromMessageId) {
        await rewindProjectionForEdit(executor, input);
      }
      const requestMessageId = input.continueInterruptedTurn
        ? await continuableRequestMessageId(executor, input)
        : await ensureUserMessage(executor, input);
      await syncMessageJournal(executor, input);
      if (!input.continueInterruptedTurn) {
        await ensureInputFileAssociations(executor, input, requestMessageId);
        await ensureUserJournalEntry(executor, input, requestMessageId);
      }
      const runId = randomUUID();
      const admittedStepId = randomUUID();
      await executor.execute(
        `
INSERT INTO turn_runs (
  id,tenant_id,user_id,workspace_id,task_id,session_id,request_id,request_message_id,
  state,next_action,runtime_request,grounding_context,prompt_manifest
) VALUES (
  $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7,$8::uuid,
  'queued','Assemble durable context',$9::jsonb,$10::jsonb,$11::jsonb
)
        `.trim(),
        [
          runId,
          input.tenantId,
          input.userId,
          input.workspaceId,
          input.taskId,
          input.sessionId,
          input.requestId,
          requestMessageId,
          JSON.stringify({
            ...input.runtimeRequest,
            requestId: input.requestId,
            admissionFingerprint: input.operationFingerprint,
            budgetReservationRequired: input.budgetReservationRequired,
            continueInterruptedTurn: input.continueInterruptedTurn === true,
            input: input.input,
          }),
          JSON.stringify(input.groundingContext),
          JSON.stringify(input.promptManifest ?? {}),
        ],
      );
      await executor.execute(
        `
INSERT INTO turn_steps (
  id,tenant_id,run_id,sequence,step_type,state,input,output,
  retry_class,idempotency_key,attempt,started_at,completed_at
) VALUES (
  $1::uuid,$2::uuid,$3::uuid,0,'turn.admitted','completed',
  $4::jsonb,$5::jsonb,'idempotent_with_key',$6,1,now(),now()
)
        `.trim(),
        [
          admittedStepId,
          input.tenantId,
          runId,
          JSON.stringify({ requestMessageId, requestId: input.requestId }),
          JSON.stringify({ accepted: true }),
          `${runId}:admitted`,
        ],
      );
      await executor.execute(
        `
INSERT INTO turn_events (
  tenant_id,run_id,session_id,sequence,event_type,payload
) VALUES ($1::uuid,$2::uuid,$3::uuid,1,'turn.start',$4::jsonb)
        `.trim(),
        [
          input.tenantId,
          runId,
          input.sessionId,
          JSON.stringify({
            kind: "turn.start",
            turnId: runId,
            ...(input.continueInterruptedTurn ? { continuation: true } : {}),
          }),
        ],
      );
      await executor.execute(
        `
INSERT INTO runtime_outbox (
  tenant_id,event_type,aggregate_id,dedupe_key,payload
) VALUES ($1::uuid,'turn.execute',$2,$3,$4::jsonb)
ON CONFLICT (tenant_id,dedupe_key) DO NOTHING
        `.trim(),
        [
          input.tenantId,
          runId,
          `${runId}:wake:admitted`,
          JSON.stringify({ tenantId: input.tenantId, runId, reason: "admitted" }),
        ],
      );
      await executor.execute(
        `
UPDATE tasks SET status='running',updated_at=now()
WHERE tenant_id=$1::uuid AND id=$2::uuid
        `.trim(),
        [input.tenantId, input.taskId],
      );
      await executor.execute(
        `
UPDATE sessions
SET runtime_metadata=runtime_metadata || jsonb_build_object(
      'activeRunId',$2::text,'lastRunState','queued','leafId',$3::text
    ),
    updated_at=now()
WHERE tenant_id=$1::uuid AND id=$4::uuid
        `.trim(),
        [input.tenantId, runId, requestMessageId, input.sessionId],
      );
      if (admissionIntent) {
        await executor.execute(
          `
UPDATE turn_admission_intents
SET state='admitted',run_id=$3::uuid,admitted_at=now(),
    preparation_ms=GREATEST(0,FLOOR(EXTRACT(EPOCH FROM (now()-created_at))*1000)::integer),
    preparation_lease_expires_at=NULL,
    terminal_reason_code=NULL,
    terminal_at=NULL,
    updated_at=now()
WHERE tenant_id=$1::uuid AND request_id=$2 AND state='preparing'
          `.trim(),
          [input.tenantId, input.requestId, runId],
        );
      }
      return { runId, sessionId: input.sessionId };
    });
  }

  async rewindJournalBefore(tenantId: string, sessionId: string, messageId: string): Promise<void> {
    if (!this.enabled) return;
    await this.database.withTenant(tenantId, async (executor) => {
      const operation = async (transaction: SqlExecutor) => {
        await syncMessageJournal(transaction, { tenantId, sessionId });
        await rewindJournalBeforeExecutor(transaction, tenantId, sessionId, messageId);
      };
      if (executor.transaction) await executor.transaction(operation);
      else await operation(executor);
    });
  }

  async state(tenantId: string, sessionId: string): Promise<TurnState> {
    if (!this.enabled) return TurnStateSchema.parse({ active: false, turnId: null, bufferedEvents: [], replayOnly: false });
    return this.database.withTenant(tenantId, async (executor) => {
      const runs = await executor.query<{
        id: string;
        state: string;
        lease_owner: string | null;
        waiting_reason: string | null;
        next_action: string | null;
        error: string | null;
        created_at: Date | string;
        continuation: boolean;
      }>(
        `
SELECT id,state,lease_owner,waiting_reason,next_action,error,created_at,
       COALESCE(runtime_request->>'continueInterruptedTurn' = 'true',false) AS continuation
FROM turn_runs
WHERE tenant_id=$1::uuid AND session_id=$2::uuid
ORDER BY created_at DESC
LIMIT 1
        `.trim(),
        [tenantId, sessionId],
      );
      const run = runs[0];
      if (!run) return TurnStateSchema.parse({ active: false, turnId: null, bufferedEvents: [], replayOnly: false });
      const active = !["completed", "failed", "cancelled", "recovery_required"].includes(run.state);
      const positions = await executor.query<{
        message_start: number | string | null;
        message_end: number | string | null;
        tool_start: number | string | null;
        tool_end: number | string | null;
        turn_start: number | string | null;
        maximum: number | string | null;
      }>(
        `
SELECT
  MAX(sequence) FILTER (WHERE event_type='message.start') AS message_start,
  MAX(sequence) FILTER (WHERE event_type='message.end') AS message_end,
  MAX(sequence) FILTER (WHERE event_type='tool.start') AS tool_start,
  MAX(sequence) FILTER (WHERE event_type='tool.end') AS tool_end,
  MAX(sequence) FILTER (WHERE event_type='turn.start') AS turn_start,
  MAX(sequence) AS maximum
FROM turn_events
WHERE tenant_id=$1::uuid AND run_id=$2::uuid
        `.trim(),
        [tenantId, run.id],
      );
      const position = positions[0];
      const maximum = nullableNumber(position?.maximum);
      const replayFrom = active
        ? activeReplayBoundary(run.state, position, maximum)
        : null;
      const events = await executor.query<{ sequence: number; payload: unknown }>(
        active
          ? `
SELECT sequence,payload FROM turn_events
WHERE tenant_id=$1::uuid AND run_id=$2::uuid AND sequence >= $3
ORDER BY sequence ASC
            `.trim()
          : `
SELECT sequence,payload FROM turn_events
WHERE tenant_id=$1::uuid AND run_id=$2::uuid
ORDER BY sequence DESC
LIMIT 256
            `.trim(),
        active ? [tenantId, run.id, replayFrom ?? 0] : [tenantId, run.id],
      );
      const chronological = active ? events : [...events].reverse();
      const bufferedEvents = active
        ? compactReplayEvents(chronological.map((row) => AgentStreamEventSchema.parse(row.payload)))
        : chronological.map((row) => AgentStreamEventSchema.parse(row.payload));
      return TurnStateSchema.parse({
        active,
        turnId: run.id,
        continuation: run.continuation,
        bufferedEvents,
        lastEventId: maximum === null ? null : `${run.id}:${maximum}`,
        startedAt: run.created_at instanceof Date
          ? run.created_at.toISOString()
          : new Date(run.created_at).toISOString(),
        replayOnly: false,
        owner: run.lease_owner,
        runState: run.state,
        waitingReason: run.waiting_reason,
        nextAction: run.next_action,
        error: run.error,
      });
    });
  }

  async taskActivity(tenantId: string, sessionIds: readonly string[]): Promise<Map<string, DurableTaskActivity>> {
    if (!this.enabled || sessionIds.length === 0) return new Map();
    return this.database.withTenant(tenantId, async (executor) => {
      const rows = await executor.query<{
        session_id: string;
        run_id: string | null;
        run_state: string | null;
        run_created_at: Date | string | null;
        admission_state: "preparing" | "admitted" | "cancelled" | null;
        admission_created_at: Date | string | null;
        admission_updated_at: Date | string | null;
      }>(
        `
WITH requested AS (
  SELECT DISTINCT unnest($2::uuid[]) AS session_id
)
SELECT requested.session_id,
       latest_run.id AS run_id,
       latest_run.state AS run_state,
       latest_run.created_at AS run_created_at,
       latest_intent.state AS admission_state,
       latest_intent.created_at AS admission_created_at,
       latest_intent.updated_at AS admission_updated_at
FROM requested
LEFT JOIN LATERAL (
  SELECT id,state,created_at
  FROM turn_runs
  WHERE tenant_id=$1::uuid AND session_id=requested.session_id
  ORDER BY created_at DESC
  LIMIT 1
) latest_run ON true
LEFT JOIN LATERAL (
  SELECT state,created_at,updated_at
  FROM turn_admission_intents
  WHERE tenant_id=$1::uuid AND session_id=requested.session_id
  ORDER BY created_at DESC
  LIMIT 1
) latest_intent ON true
        `.trim(),
        [tenantId, [...new Set(sessionIds)]],
      );
      return new Map(rows.map((row) => [row.session_id, {
        sessionId: row.session_id,
        runId: row.run_id,
        runState: row.run_state,
        runCreatedAt: nullableIso(row.run_created_at),
        admissionState: row.admission_state,
        admissionCreatedAt: nullableIso(row.admission_created_at),
        admissionUpdatedAt: nullableIso(row.admission_updated_at),
      }]));
    });
  }

  /**
   * Estimate the context used by the durable worker from its authoritative
   * Postgres journal. Provider usage wins when it was recorded after the
   * latest rolling checkpoint; newer journal entries and an in-flight draft
   * are then added conservatively.
   */
  async contextStats(
    tenantId: string,
    sessionId: string,
    options: { pendingInput?: string; attachments?: AttachmentInput[] } = {},
  ): Promise<DurableContextStats> {
    if (!this.enabled) return { usedTokens: 0, source: "estimated" };
    return this.database.withTenant(tenantId, async (executor) => {
      const [entries, checkpoints, runs] = await Promise.all([
        executor.query<DurableContextEntryRow>(
          `
WITH RECURSIVE leaf AS (
  SELECT entry_id,parent_entry_id
  FROM session_entries
  WHERE tenant_id=$1::uuid AND session_id=$2::uuid AND is_leaf_marker=true
  ORDER BY sequence DESC LIMIT 1
), ancestry AS (
  SELECT * FROM leaf
  UNION ALL
  SELECT parent.entry_id,parent.parent_entry_id
  FROM session_entries parent
  JOIN ancestry child ON child.parent_entry_id=parent.entry_id
  WHERE parent.tenant_id=$1::uuid AND parent.session_id=$2::uuid
), latest_checkpoint AS (
  SELECT covered_entry_end
  FROM session_checkpoints
  WHERE tenant_id=$1::uuid AND session_id=$2::uuid AND kind='rolling'
    AND schema_version=2
    AND split_part(validation_status, ':', 1) IN ('valid','repaired','fallback')
    AND (source_leaf_id IS NULL OR source_leaf_id IN (SELECT entry_id FROM ancestry))
  ORDER BY created_at DESC,id DESC
  LIMIT 1
),
covered AS (
  SELECT sequence
  FROM session_entries
  WHERE tenant_id=$1::uuid AND session_id=$2::uuid
    AND entry_id=(SELECT covered_entry_end FROM latest_checkpoint)
),
active_entries AS (
  SELECT entry_id,sequence,payload,run_id
  FROM session_entries
  WHERE tenant_id=$1::uuid AND session_id=$2::uuid
    AND entry_id IN (SELECT entry_id FROM ancestry)
    AND entry_type='message'
    AND sequence>COALESCE((SELECT sequence FROM covered),0)
),
current_run AS (
  SELECT id
  FROM turn_runs
  WHERE tenant_id=$1::uuid AND session_id=$2::uuid
  ORDER BY created_at DESC
  LIMIT 1
),
latest_usage AS (
  SELECT MAX(sequence) AS sequence
  FROM active_entries
  WHERE jsonb_typeof(payload->'message'->'usage')='object'
    AND COALESCE(payload->'message'->>'stopReason','') NOT IN ('aborted','error')
    AND run_id=(SELECT id FROM current_run)
)
SELECT entry_id,sequence,payload,run_id
FROM active_entries
WHERE sequence>=COALESCE(
  (SELECT sequence FROM latest_usage),
  (SELECT MIN(sequence) FROM active_entries)
)
ORDER BY sequence ASC
          `.trim(),
          [tenantId, sessionId],
        ),
        executor.query<DurableContextCheckpointRow>(
          `
WITH RECURSIVE leaf AS (
  SELECT entry_id,parent_entry_id FROM session_entries
  WHERE tenant_id=$1::uuid AND session_id=$2::uuid AND is_leaf_marker=true
  ORDER BY sequence DESC LIMIT 1
), ancestry AS (
  SELECT * FROM leaf
  UNION ALL
  SELECT parent.entry_id,parent.parent_entry_id FROM session_entries parent
  JOIN ancestry child ON child.parent_entry_id=parent.entry_id
  WHERE parent.tenant_id=$1::uuid AND parent.session_id=$2::uuid
)
SELECT checkpoint,covered_entry_end
FROM session_checkpoints
WHERE tenant_id=$1::uuid AND session_id=$2::uuid AND kind='rolling'
  AND schema_version=2
  AND split_part(validation_status, ':', 1) IN ('valid','repaired','fallback')
  AND (source_leaf_id IS NULL OR source_leaf_id IN (SELECT entry_id FROM ancestry))
ORDER BY created_at DESC,id DESC
LIMIT 1
          `.trim(),
          [tenantId, sessionId],
        ),
        executor.query<DurableContextRunRow>(
          `
SELECT r.id,r.state,
       COALESCE(
         NULLIF(r.prompt_manifest,'{}'::jsonb),
         (
           SELECT previous.prompt_manifest
           FROM turn_runs previous
           WHERE previous.tenant_id=r.tenant_id
             AND previous.session_id=r.session_id
             AND previous.id<>r.id
             AND previous.prompt_manifest<>'{}'::jsonb
           ORDER BY previous.created_at DESC
           LIMIT 1
         ),
         '{}'::jsonb
       ) AS prompt_manifest,
       r.grounding_context,
       COALESCE((
         WITH boundary AS (
           SELECT
             MAX(sequence) FILTER (WHERE event_type='message.start') AS message_start,
             MAX(sequence) FILTER (WHERE event_type='message.end') AS message_end
           FROM turn_events
           WHERE tenant_id=r.tenant_id AND run_id=r.id
         )
         SELECT SUM(length(e.payload->>'delta'))
         FROM turn_events e
         CROSS JOIN boundary b
         WHERE e.tenant_id=r.tenant_id AND e.run_id=r.id
           AND b.message_start>COALESCE(b.message_end,0)
           AND e.sequence>b.message_start
           AND e.event_type='message.delta'
           AND e.payload->>'channel' IN ('text','reasoning')
       ),0) AS partial_chars
FROM turn_runs r
WHERE r.tenant_id=$1::uuid AND r.session_id=$2::uuid
ORDER BY r.created_at DESC
LIMIT 1
          `.trim(),
          [tenantId, sessionId],
        ),
      ]);

      const checkpoint = checkpoints[0];
      const coveredIndex = checkpoint?.covered_entry_end
        ? entries.findIndex((entry) => entry.entry_id === checkpoint.covered_entry_end)
        : -1;
      const activeEntries = coveredIndex >= 0 ? entries.slice(coveredIndex + 1) : entries;
      const usageIndex = findLatestProviderUsageIndex(activeEntries);
      const providerTokens = usageIndex >= 0
        ? providerContextTokens(activeEntries[usageIndex]?.payload)
        : null;
      const trailingEntries = usageIndex >= 0 ? activeEntries.slice(usageIndex + 1) : activeEntries;
      const run = runs[0];
      const partialTokens = run && !isTerminalRunState(run.state)
        ? estimateCharacterTokens(Number(run.partial_chars))
        : 0;
      const pendingTokens = estimatePendingContextTokens(options.pendingInput, options.attachments);

      if (providerTokens !== null) {
        return {
          usedTokens: Math.max(0, providerTokens + estimateDurableEntriesTokens(trailingEntries) + partialTokens + pendingTokens),
          source: "provider-reported",
        };
      }

      const manifest = PromptManifestSchema.safeParse(run?.prompt_manifest);
      const stablePrefixTokens = manifest.success ? manifest.data.stablePrefixTokens : 0;
      const checkpointTokens = checkpoint ? estimateJsonTokens(checkpoint.checkpoint) : 0;
      const groundingTokens = run ? estimateJsonTokens(run.grounding_context) : 0;
      return {
        usedTokens: Math.max(
          0,
          stablePrefixTokens
            + checkpointTokens
            + groundingTokens
            + estimateDurableEntriesTokens(activeEntries)
            + partialTokens
            + pendingTokens,
        ),
        source: "estimated",
      };
    });
  }

  async eventsAfter(
    tenantId: string,
    sessionId: string,
    cursor?: string | null,
    limit = 500,
    notBefore?: Date,
  ): Promise<DurableEventEnvelope[]> {
    return this.database.withTenant(tenantId, async (executor) => {
      const parsed = parseEventCursor(cursor);
      const rows = await executor.query<EventRow>(
        parsed
          ? `
WITH cursor_run AS (
  SELECT r.id,r.created_at,$4::bigint AS cursor_sequence,
         COALESCE(MAX(e.sequence),0) AS max_sequence
  FROM turn_runs r
  LEFT JOIN turn_events e ON e.tenant_id=r.tenant_id AND e.run_id=r.id
  WHERE r.tenant_id=$1::uuid AND r.id=$3::uuid AND r.session_id=$2::uuid
  GROUP BY r.id,r.created_at
), valid_cursor AS (
  SELECT id,created_at,cursor_sequence
  FROM cursor_run
  WHERE cursor_sequence <= max_sequence
), fallback_run AS (
  SELECT r.id,r.created_at,
         CASE
           WHEN r.state IN ('completed','failed','cancelled','recovery_required')
             THEN COALESCE(MAX(e.sequence),0)
           ELSE 0
         END AS cursor_sequence
  FROM turn_runs r
  LEFT JOIN turn_events e ON e.tenant_id=r.tenant_id AND e.run_id=r.id
  WHERE r.tenant_id=$1::uuid AND r.session_id=$2::uuid
  GROUP BY r.id,r.created_at,r.state
  ORDER BY r.created_at DESC,r.id DESC
  LIMIT 1
), effective_cursor AS (
  SELECT * FROM valid_cursor
  UNION ALL
  SELECT * FROM fallback_run WHERE NOT EXISTS (SELECT 1 FROM valid_cursor)
)
SELECT e.run_id,e.sequence,e.payload,e.created_at
FROM turn_events e
JOIN turn_runs r ON r.tenant_id=e.tenant_id AND r.id=e.run_id
WHERE e.tenant_id=$1::uuid AND e.session_id=$2::uuid
  AND EXISTS (SELECT 1 FROM effective_cursor)
  AND (
    r.created_at > (SELECT created_at FROM effective_cursor)
    OR (
      r.created_at = (SELECT created_at FROM effective_cursor)
      AND r.id > (SELECT id FROM effective_cursor)
    )
    OR (
      e.run_id=(SELECT id FROM effective_cursor)
      AND e.sequence>(SELECT cursor_sequence FROM effective_cursor)
    )
  )
ORDER BY r.created_at ASC,r.id ASC,e.sequence ASC
LIMIT $5
            `.trim()
          : notBefore
            ? `
SELECT e.run_id,e.sequence,e.payload,e.created_at
FROM turn_events e
JOIN turn_runs r ON r.tenant_id=e.tenant_id AND r.id=e.run_id
WHERE e.tenant_id=$1::uuid AND e.session_id=$2::uuid
  AND (
    e.created_at >= $3::timestamptz
    OR r.state NOT IN ('completed','failed','cancelled','recovery_required')
  )
ORDER BY r.created_at ASC,r.id ASC,e.sequence ASC
LIMIT $4
            `.trim()
            : `
SELECT e.run_id,e.sequence,e.payload,e.created_at
FROM turn_events e
JOIN turn_runs r ON r.tenant_id=e.tenant_id AND r.id=e.run_id
WHERE e.tenant_id=$1::uuid AND e.session_id=$2::uuid
  AND r.id=(
    SELECT id FROM turn_runs
    WHERE tenant_id=$1::uuid AND session_id=$2::uuid
      AND state NOT IN ('completed','failed','cancelled','recovery_required')
    ORDER BY created_at DESC
    LIMIT 1
  )
ORDER BY e.sequence ASC
LIMIT $3
            `.trim(),
        parsed
          ? [tenantId, sessionId, parsed.runId, parsed.sequence, limit]
          : notBefore
            ? [tenantId, sessionId, notBefore, limit]
            : [tenantId, sessionId, limit],
      );
      return rows.map((row) => ({
        id: eventCursor(row.run_id, Number(row.sequence)),
        runId: row.run_id,
        sequence: Number(row.sequence),
        event: AgentStreamEventSchema.parse(row.payload),
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      }));
    });
  }

  async cancel(tenantId: string, sessionId: string, requestId?: string): Promise<boolean> {
    if (!this.enabled) {
      apiRuntimeMetrics.turnCancellation("no_active_run");
      return true;
    }
    const cancellation = await this.database.withTenant(tenantId, async (executor) => {
      const run = async (transaction: SqlExecutor): Promise<{
        runId: string | null;
        result: TurnCancellationMetricResult;
      }> => {
        if (requestId) {
          await transaction.execute(
            `
INSERT INTO turn_admission_intents (
  tenant_id,request_id,session_id,state,cancelled_at,terminal_at,terminal_reason_code,
  preparation_lease_expires_at
) VALUES ($1::uuid,$2,$3::uuid,'cancelled',now(),now(),'cancelled_by_user',NULL)
ON CONFLICT (tenant_id,request_id) DO UPDATE
SET state=CASE
      WHEN turn_admission_intents.state='admitted' THEN 'admitted'
      ELSE 'cancelled'
    END,
    cancelled_at=COALESCE(turn_admission_intents.cancelled_at,now()),
    terminal_at=CASE
      WHEN turn_admission_intents.state='admitted' THEN turn_admission_intents.terminal_at
      ELSE COALESCE(turn_admission_intents.terminal_at,now())
    END,
    terminal_reason_code=CASE
      WHEN turn_admission_intents.state='admitted' THEN turn_admission_intents.terminal_reason_code
      ELSE COALESCE(turn_admission_intents.terminal_reason_code,'cancelled_by_user')
    END,
    preparation_lease_expires_at=NULL,
    preparation_ms=COALESCE(
      turn_admission_intents.preparation_ms,
      GREATEST(0,FLOOR(EXTRACT(EPOCH FROM (now()-turn_admission_intents.created_at))*1000)::integer)
    ),
    updated_at=now()
            `.trim(),
            [tenantId, requestId, sessionId],
          );
          const intent = await lockAdmissionIntent(transaction, tenantId, requestId);
          if (intent && intent.session_id !== sessionId) {
            throw new ConflictException("This operation key belongs to another session");
          }
        }
        const rows = await transaction.query<{
          id: string;
          task_id: string;
          session_id: string;
          request_message_id: string | null;
          sandbox_id: string | null;
        }>(
          `
SELECT id,task_id,session_id,request_message_id,sandbox_id
FROM turn_runs
WHERE tenant_id=$1::uuid AND session_id=$2::uuid
  AND ($3::text IS NULL OR request_id=$3)
  AND state NOT IN ('completed','failed','cancelled','recovery_required')
ORDER BY created_at DESC
LIMIT 1
FOR UPDATE
          `.trim(),
          [tenantId, sessionId, requestId ?? null],
        );
        const active = rows[0];
        if (!active) {
          if (requestId) {
            await transaction.execute(
              `
UPDATE tasks t
SET status='cancelled',updated_at=now()
FROM sessions s
WHERE s.tenant_id=$1::uuid AND s.id=$2::uuid
  AND t.tenant_id=s.tenant_id AND t.id=s.task_id
  AND t.status IN ('queued','running')
              `.trim(),
              [tenantId, sessionId],
            );
          }
          return {
            runId: null,
            result: requestId ? "pending_or_terminal" : "no_active_run",
          };
        }
        await cancelActiveDurableRun(transaction, tenantId, active);
        return { runId: active.id, result: "active_run" };
      };
      // CloudDatabaseService.withTenant already owns the transaction boundary.
      return run(executor);
    });
    apiRuntimeMetrics.turnCancellation(cancellation.result);
    if (cancellation.runId) await this.cancellationPublisher?.publish(tenantId, cancellation.runId);
    return true;
  }

  async deleteTask(tenantId: string, userId: string, taskId: string): Promise<boolean> {
    if (!this.enabled) return false;
    return this.database.withTenant(tenantId, async (executor) => {
      const run = async (transaction: SqlExecutor): Promise<boolean> => {
        const tasks = await transaction.query<{ id: string }>(
          `
SELECT id FROM tasks
WHERE tenant_id=$1::uuid AND id=$2::uuid AND user_id=$3::uuid
FOR UPDATE
          `.trim(),
          [tenantId, taskId, userId],
        );
        if (!tasks[0]) return false;
        const activeRuns = await transaction.query<{
          id: string;
          task_id: string;
          session_id: string;
          request_message_id: string | null;
          sandbox_id: string | null;
        }>(
          `
SELECT id,task_id,session_id,request_message_id,sandbox_id
FROM turn_runs
WHERE tenant_id=$1::uuid AND task_id=$2::uuid
  AND state NOT IN ('completed','failed','cancelled','recovery_required')
ORDER BY created_at ASC
FOR UPDATE
          `.trim(),
          [tenantId, taskId],
        );
        for (const active of activeRuns) {
          await cancelActiveDurableRun(transaction, tenantId, active);
        }
        await transaction.execute(
          "UPDATE tasks SET deleted_at=COALESCE(deleted_at,now()),updated_at=now() WHERE tenant_id=$1::uuid AND id=$2::uuid",
          [tenantId, taskId],
        );
        return true;
      };
      return run(executor);
    });
  }

  async listApprovals(tenantId: string, userId: string): Promise<Array<Record<string, unknown>>> {
    if (!this.enabled) return [];
    return this.database.withTenant(tenantId, async (executor) => {
      const rows = await executor.query<ApprovalRow>(
        `
SELECT a.id,a.task_id,a.tool_call_id,a.kind,a.status,a.request,a.created_at,a.decided_at
FROM approvals a
JOIN tasks t ON t.tenant_id=a.tenant_id AND t.id=a.task_id
WHERE a.tenant_id=$1::uuid AND t.user_id=$2::uuid AND a.status='pending'
ORDER BY a.created_at ASC
        `.trim(),
        [tenantId, userId],
      );
      return rows.map((row) => ({
        id: row.id,
        taskId: row.task_id,
        toolCallId: row.tool_call_id,
        kind: row.kind,
        status: row.status,
        request: row.request,
        createdAt: iso(row.created_at),
        decidedAt: row.decided_at ? iso(row.decided_at) : null,
      }));
    });
  }

  async decideApproval(
    tenantId: string,
    userId: string,
    approvalId: string,
    decision: {
      decision: "approved_once" | "approved_for_session" | "approved_rule" | "denied" | "abort" | "approve" | "deny";
      remember?: boolean;
      reason?: string;
    },
  ): Promise<boolean> {
    if (!this.enabled) return false;
    return this.database.withTenant(tenantId, async (executor) => {
      const run = async (transaction: SqlExecutor): Promise<boolean> => {
        const rows = await transaction.query<{
          id: string;
          run_id: string;
          step_id: string | null;
          tool_call_id: string | null;
          session_id: string;
          task_id: string;
          status: string;
          expires_at: Date | string | null;
        }>(
          `
SELECT a.id,a.run_id,a.step_id,a.tool_call_id,r.session_id,a.task_id,a.status,a.expires_at
FROM approvals a
JOIN tasks t ON t.tenant_id=a.tenant_id AND t.id=a.task_id
JOIN turn_runs r ON r.tenant_id=a.tenant_id AND r.id=a.run_id
WHERE a.tenant_id=$1::uuid AND a.id=$2::uuid AND t.user_id=$3::uuid
FOR UPDATE OF a,r
          `.trim(),
          [tenantId, approvalId, userId],
        );
        const approval = rows[0];
        if (!approval || approval.status !== "pending") return false;
        if (approval.expires_at && Date.parse(iso(approval.expires_at)) <= Date.now()) {
          await transaction.execute(
            `
UPDATE approvals
SET status='expired',expired_at=COALESCE(expired_at,now()),decided_at=COALESCE(decided_at,now()),
    closure_reason=COALESCE(closure_reason,'approval_expired'),closed_at=COALESCE(closed_at,now()),updated_at=now()
WHERE tenant_id=$1::uuid AND id=$2::uuid AND status='pending'
            `.trim(),
            [tenantId, approvalId],
          );
          await appendDurableEvents(transaction, tenantId, approval.run_id, approval.session_id, [
            { kind: "approval.expired", approvalId },
          ]);
          return false;
        }
        const approved = !["denied", "deny", "abort"].includes(decision.decision);
        await transaction.execute(
          `
UPDATE approvals
SET status=$3,decision=$4::jsonb,decided_at=now()
WHERE tenant_id=$1::uuid AND id=$2::uuid
          `.trim(),
          [tenantId, approvalId, approved ? "approved" : "denied", JSON.stringify(decision)],
        );
        if (approval.step_id) {
          await transaction.execute(
            `
UPDATE turn_steps
SET state='pending',error=NULL,updated_at=now()
WHERE tenant_id=$1::uuid AND id=$2::uuid AND run_id=$3::uuid
            `.trim(),
            [tenantId, approval.step_id, approval.run_id],
          );
        }
        await transaction.execute(
          `
UPDATE turn_runs
SET state='executing_tool',waiting_reason=NULL,next_action='Resume after approval',
    human_wait_ms=human_wait_ms+CASE WHEN waiting_started_at IS NULL THEN 0 ELSE GREATEST(0,FLOOR(EXTRACT(EPOCH FROM (now()-waiting_started_at))*1000)::bigint) END,
    waiting_started_at=NULL,lease_owner=NULL,lease_expires_at=NULL,version=version+1,updated_at=now()
WHERE tenant_id=$1::uuid AND id=$2::uuid AND state='waiting'
          `.trim(),
          [tenantId, approval.run_id],
        );
        await transaction.execute(
          `
UPDATE tasks
SET status='running',updated_at=now()
WHERE tenant_id=$1::uuid AND id=$2::uuid
          `.trim(),
          [tenantId, approval.task_id],
        );
        await appendDurableEvents(transaction, tenantId, approval.run_id, approval.session_id, [
          {
            kind: "approval.resolved",
            approvalId,
            decision: approved ? "approved" : "denied",
          },
          approved
            ? {
                kind: "tool.update" as const,
                toolCallId: approval.tool_call_id ?? approval.step_id ?? approval.id,
                detail: "Approval granted; the durable turn will resume.",
              }
            : {
                kind: "tool.update" as const,
                toolCallId: approval.tool_call_id ?? approval.step_id ?? approval.id,
                detail: decision.reason ?? "Approval denied; the model will be informed.",
              },
        ]);
        await transaction.execute(
          `
INSERT INTO runtime_outbox (tenant_id,event_type,aggregate_id,dedupe_key,payload)
VALUES ($1::uuid,'turn.resume',$2,$3,$4::jsonb)
ON CONFLICT (tenant_id,dedupe_key) DO NOTHING
          `.trim(),
          [
            tenantId,
            approval.run_id,
            `${approval.run_id}:approval:${approvalId}`,
            JSON.stringify({ tenantId, runId: approval.run_id, reason: "approval-resolved" }),
          ],
        );
        return true;
      };
      return executor.transaction ? executor.transaction(run) : run(executor);
    });
  }

  async questionContext(tenantId: string, userId: string, questionId: string): Promise<{
    runId: string;
    taskId: string;
    sessionId: string;
  } | null> {
    if (!this.enabled) return null;
    return this.database.withTenant(tenantId, async (executor) => {
      const rows = await executor.query<{ run_id: string; task_id: string; session_id: string }>(
        `
SELECT q.run_id,r.task_id,q.session_id
FROM turn_questions q
JOIN turn_runs r ON r.tenant_id=q.tenant_id AND r.id=q.run_id
JOIN tasks t ON t.tenant_id=r.tenant_id AND t.id=r.task_id
WHERE q.tenant_id=$1::uuid AND q.id=$2::uuid AND t.user_id=$3::uuid
  AND q.status IN ('pending','answered')
LIMIT 1
        `.trim(),
        [tenantId, questionId, userId],
      );
      const row = rows[0];
      return row ? { runId: row.run_id, taskId: row.task_id, sessionId: row.session_id } : null;
    });
  }

  async answerQuestion(
    tenantId: string,
    userId: string,
    questionId: string,
    answer: {
      answer: string;
      answerMessageId?: string | undefined;
      selectedOptions?: readonly string[] | undefined;
      answers?: ReadonlyArray<{
        question: string;
        answer: string;
        selectedOptions?: readonly string[] | undefined;
        attachments?: ReadonlyArray<{
          fileId: string;
          name: string;
          mediaType: string;
          size: number;
          sourceKind?: string | null | undefined;
        }> | undefined;
        skipped?: boolean | undefined;
      }> | undefined;
    },
  ): Promise<boolean> {
    if (!this.enabled) return false;
    return this.database.withTenant(tenantId, async (executor) => {
      const run = async (transaction: SqlExecutor): Promise<boolean> => {
        const rows = await transaction.query<{
          id: string;
          run_id: string;
          session_id: string;
          step_id: string | null;
          tool_call_id: string | null;
          question: string;
          status: string;
          answer: unknown;
          run_state: string;
          task_id: string;
          created_at: Date | string;
          expires_at: Date | string | null;
        }>(
          `
SELECT q.id,q.run_id,q.session_id,q.step_id,q.tool_call_id,q.question,q.status,q.answer,
       q.created_at,q.expires_at,r.state AS run_state,r.task_id
FROM turn_questions q
JOIN turn_runs r ON r.tenant_id=q.tenant_id AND r.id=q.run_id
JOIN tasks t ON t.tenant_id=r.tenant_id AND t.id=r.task_id
WHERE q.tenant_id=$1::uuid AND q.id=$2::uuid AND t.user_id=$3::uuid
FOR UPDATE OF q,r
          `.trim(),
          [tenantId, questionId, userId],
        );
        const question = rows[0];
        if (!question) return false;
        const submittedAnswer = {
          answer: answer.answer,
          answerMessageId: answer.answerMessageId ?? null,
          selectedOptions: [...(answer.selectedOptions ?? [])],
          ...(answer.answers ? {
            answers: answer.answers.map((item) => ({
              question: item.question,
              answer: item.answer,
              selectedOptions: [...(item.selectedOptions ?? [])],
              ...(item.attachments?.length ? { attachments: [...item.attachments] } : {}),
              skipped: item.skipped === true,
            })),
          } : {}),
        };
        if (question.status === "answered") {
          const priorAnswer = recordValue(question.answer);
          return questionAnswersEquivalent(priorAnswer, submittedAnswer);
        }
        if (question.status !== "pending" || question.run_state !== "waiting" || !question.step_id) {
          return false;
        }
        if (question.expires_at && Date.parse(iso(question.expires_at)) <= Date.now()) {
          await expireQuestionTransaction(transaction, tenantId, {
            id: question.id,
            run_id: question.run_id,
            session_id: question.session_id,
            task_id: question.task_id,
            step_id: question.step_id!,
            tool_call_id: question.tool_call_id,
          });
          return false;
        }
        const messageRows = await transaction.query<{ id: string }>(
          answer.answerMessageId
            ? `
SELECT m.id
FROM messages m
WHERE m.tenant_id=$1::uuid AND m.session_id=$2::uuid AND m.task_id=$3::uuid
  AND m.id=$4::uuid AND m.role='user'
LIMIT 1
              `.trim()
            : `
SELECT m.id
FROM messages m
WHERE m.tenant_id=$1::uuid AND m.session_id=$2::uuid AND m.role='user'
  AND m.created_at >= $3::timestamptz
ORDER BY m.created_at DESC
LIMIT 1
              `.trim(),
          answer.answerMessageId
            ? [tenantId, question.session_id, question.task_id, answer.answerMessageId]
            : [tenantId, question.session_id, iso(question.created_at)],
        );
        const answerMessageId = messageRows[0]?.id ?? answer.answerMessageId ?? randomUUID();
        if (!messageRows[0]) {
          await transaction.execute(
            `
INSERT INTO messages (id,tenant_id,session_id,task_id,role,status)
VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'user','complete')
            `.trim(),
            [answerMessageId, tenantId, question.session_id, question.task_id],
          );
        }

        const requestedFileIds = (answer.answers ?? []).flatMap((item) =>
          (item.attachments ?? []).map((attachment) => attachment.fileId));
        const resolvedFiles = await associateInputFilesInTransaction(
          transaction,
          tenantId,
          userId,
          {
            fileIds: requestedFileIds,
            taskId: question.task_id,
            sessionId: question.session_id,
            messageId: answerMessageId,
            turnId: question.run_id,
          },
        );
        const filesById = new Map(resolvedFiles.map((file) => [file.fileId, file]));
        const governedAnswers = answer.answers?.map((item) => ({
          ...item,
          ...(item.attachments?.length
            ? { attachments: item.attachments.map((attachment) => filesById.get(attachment.fileId) ?? attachment) }
            : {}),
        }));
        const normalizedAnswer = {
          answer: answer.answer,
          answerMessageId,
          selectedOptions: [...(answer.selectedOptions ?? [])],
          ...(governedAnswers ? {
            answers: governedAnswers.map((item) => ({
              question: item.question,
              answer: item.answer,
              selectedOptions: [...(item.selectedOptions ?? [])],
              ...(item.attachments?.length ? { attachments: [...item.attachments] } : {}),
              skipped: item.skipped === true,
            })),
          } : {}),
        };
        const workspacePath = configuredSandboxWorkspacePath();
        const responseText = governedAnswers?.length
          ? governedAnswers
              .map((item) => {
                const response = item.skipped ? "Skipped" : item.answer.trim();
                const files = item.attachments?.length
                  ? `Attached files:\n${item.attachments.map((attachment) => `- ${workspacePath}/inputs/${attachment.fileId}/${safeQuestionAttachmentName(attachment.name)}`).join("\n")}`
                  : "";
                return `${item.question}: ${[response, files].filter(Boolean).join("\n")}`;
              })
              .join("\n")
          : answer.answer;
        await transaction.execute(
          `
UPDATE turn_questions
SET status='answered',answer=$3::jsonb,answered_at=now(),closed_at=COALESCE(closed_at,now()),
    resume_count=resume_count+1
WHERE tenant_id=$1::uuid AND id=$2::uuid AND status='pending'
          `.trim(),
          [tenantId, questionId, JSON.stringify(normalizedAnswer)],
        );

        if (!messageRows[0]) {
          await transaction.execute(
            `
INSERT INTO message_parts (tenant_id,message_id,type,content,ordinal)
VALUES ($1::uuid,$2::uuid,'text',$3::jsonb,0)
            `.trim(),
            [tenantId, answerMessageId, JSON.stringify(responseText)],
          );
          for (const [index, attachment] of resolvedFiles.entries()) {
            await transaction.execute(
              `
INSERT INTO message_parts (tenant_id,message_id,type,content,ordinal)
VALUES ($1::uuid,$2::uuid,'attachment',$3::jsonb,$4)
              `.trim(),
              [tenantId, answerMessageId, JSON.stringify(messageAttachmentContent(attachment)), index + 1],
            );
          }
        }

        const entryId = randomUUID();
        const leaf = await transaction.query<{ entry_id: string; entry_type: string; payload: unknown }>(
          `
SELECT entry_id,entry_type,payload
FROM session_entries
WHERE tenant_id=$1::uuid AND session_id=$2::uuid AND is_leaf_marker=true
ORDER BY sequence DESC
LIMIT 1
FOR UPDATE
          `.trim(),
          [tenantId, question.session_id],
        );
        const parentId = activeLeafId(leaf[0]);
        const sequence = await transaction.query<{ value: number | string }>(
          `
SELECT COALESCE(MAX(sequence),0)+1 AS value
FROM session_entries
WHERE tenant_id=$1::uuid AND session_id=$2::uuid
          `.trim(),
          [tenantId, question.session_id],
        );
        await transaction.execute(
          "UPDATE session_entries SET is_leaf_marker=false WHERE tenant_id=$1::uuid AND session_id=$2::uuid AND is_leaf_marker=true",
          [tenantId, question.session_id],
        );
        const artifacts = (governedAnswers ?? []).flatMap((item) => (item.attachments ?? []).map((attachment) => ({
          fileId: attachment.fileId,
          name: attachment.name,
          mediaType: attachment.mediaType,
          size: attachment.size,
          path: `${workspacePath}/inputs/${attachment.fileId}/${safeQuestionAttachmentName(attachment.name)}`,
          source: "question-answer",
        })));
        const toolResult = {
          questions: governedAnswers ?? [{ question: question.question, answer: answer.answer, selectedOptions: answer.selectedOptions ?? [] }],
          ...normalizedAnswer,
          ...(artifacts.length > 0 ? { artifacts } : {}),
        };
        const payload = {
          type: "message",
          id: entryId,
          parentId,
          timestamp: new Date().toISOString(),
          message: {
            role: "toolResult",
            toolCallId: question.tool_call_id ?? question.step_id,
            toolName: "ask_user_question",
            content: [{ type: "text", text: `User responses:\n${responseText}` }],
            isError: false,
            timestamp: Date.now(),
            details: toolResult,
          },
          answerMessageId,
        };
        await transaction.execute(
          `
INSERT INTO session_entries (
  tenant_id,session_id,entry_id,parent_entry_id,entry_type,sequence,payload,
  is_leaf_marker,run_id,step_id
) VALUES ($1::uuid,$2::uuid,$3,$4,'message',$5,$6::jsonb,true,$7::uuid,$8::uuid)
          `.trim(),
          [
            tenantId,
            question.session_id,
            entryId,
            parentId,
            Number(sequence[0]?.value ?? 1),
            JSON.stringify(payload),
            question.run_id,
            question.step_id,
          ],
        );
        await transaction.execute(
          `
UPDATE turn_steps
SET state='completed',output=$4::jsonb,session_entry_id=$5,
    completed_at=now(),error=NULL,updated_at=now()
WHERE tenant_id=$1::uuid AND id=$2::uuid AND run_id=$3::uuid
          `.trim(),
          [tenantId, question.step_id, question.run_id, JSON.stringify(toolResult), entryId],
        );
        if (question.tool_call_id) {
          await transaction.execute(
            `
UPDATE tool_calls
SET status='completed',output=$4::jsonb,completed_at=now(),updated_at=now()
WHERE tenant_id=$1::uuid AND id=$2::uuid AND run_id=$3::uuid
            `.trim(),
            [tenantId, question.tool_call_id, question.run_id, JSON.stringify(toolResult)],
          );
        }
        const toolProjectionId = randomUUID();
        await transaction.execute(
          `
INSERT INTO messages (id,tenant_id,session_id,task_id,role,status)
VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'assistant','complete')
          `.trim(),
          [toolProjectionId, tenantId, question.session_id, question.task_id],
        );
        await transaction.execute(
          `
INSERT INTO message_parts (tenant_id,message_id,type,content,ordinal)
VALUES ($1::uuid,$2::uuid,'tool-result',$3::jsonb,0)
          `.trim(),
          [
            tenantId,
            toolProjectionId,
            JSON.stringify({
              toolCallId: question.tool_call_id ?? question.step_id,
              name: "ask_user_question",
              arguments: { question: question.question },
              status: "completed",
              output: toolResult,
              summary: "User answered the question.",
            }),
          ],
        );
        const nextStep = await transaction.query<{ sequence: number | string; iteration: number | string }>(
          `
SELECT COALESCE(MAX(sequence),0)+1 AS sequence,
       COUNT(*) FILTER (WHERE step_type='model.call')+1 AS iteration
FROM turn_steps
WHERE tenant_id=$1::uuid AND run_id=$2::uuid
          `.trim(),
          [tenantId, question.run_id],
        );
        const iteration = Number(nextStep[0]?.iteration ?? 1);
        await transaction.execute(
          `
INSERT INTO turn_steps (
  tenant_id,run_id,sequence,step_type,state,input,retry_class,idempotency_key
) VALUES (
  $1::uuid,$2::uuid,$3,'model.call','pending',$4::jsonb,
  'idempotent_with_key',$5
)
          `.trim(),
          [
            tenantId,
            question.run_id,
            Number(nextStep[0]?.sequence ?? 1),
            JSON.stringify({ iteration, resumedFromQuestionId: questionId }),
            `${question.run_id}:model:${iteration}`,
          ],
        );
        await appendDurableEvents(transaction, tenantId, question.run_id, question.session_id, [
          { kind: "question.answered", questionId },
          {
            kind: "tool.end",
            toolCallId: question.tool_call_id ?? question.step_id,
            status: "completed",
            summary: "User answered the question.",
          },
        ]);
        await transaction.execute(
          `
UPDATE turn_runs
SET state='calling_model',waiting_reason=NULL,next_action='Continue after user input',
    human_wait_ms=human_wait_ms+CASE WHEN waiting_started_at IS NULL THEN 0 ELSE GREATEST(0,FLOOR(EXTRACT(EPOCH FROM (now()-waiting_started_at))*1000)::bigint) END,
    waiting_started_at=NULL,lease_owner=NULL,lease_expires_at=NULL,version=version+1,updated_at=now()
WHERE tenant_id=$1::uuid AND id=$2::uuid AND state='waiting'
          `.trim(),
          [tenantId, question.run_id],
        );
        await transaction.execute(
          `
UPDATE tasks SET status='running',updated_at=now()
WHERE tenant_id=$1::uuid AND id=$2::uuid
          `.trim(),
          [tenantId, question.task_id],
        );
        await transaction.execute(
          `
UPDATE sessions
SET runtime_metadata=runtime_metadata || jsonb_build_object(
      'leafId',$3::text,'activeRunId',$4::text,'lastRunState','calling_model'
    ),
    updated_at=now()
WHERE tenant_id=$1::uuid AND id=$2::uuid
          `.trim(),
          [tenantId, question.session_id, entryId, question.run_id],
        );
        await transaction.execute(
          `
INSERT INTO runtime_outbox (tenant_id,event_type,aggregate_id,dedupe_key,payload)
VALUES ($1::uuid,'turn.resume',$2,$3,$4::jsonb)
ON CONFLICT (tenant_id,dedupe_key) DO NOTHING
          `.trim(),
          [
            tenantId,
            question.run_id,
            `${question.run_id}:question:${questionId}`,
            JSON.stringify({ tenantId, runId: question.run_id, reason: "user-input" }),
          ],
        );
        return true;
      };
      return executor.transaction ? executor.transaction(run) : run(executor);
    });
  }

  async recover(
    tenantId: string,
    userId: string,
    runId: string,
    action: "retry" | "mark-complete" | "cancel",
  ): Promise<boolean> {
    if (!this.enabled) return false;
    return this.database.withTenant(tenantId, async (executor) => {
      const rows = await executor.query<{
        id: string;
        session_id: string;
        task_id: string;
        tool_call_id: string | null;
        tool_call_step_id: string | null;
        tool_call_name: string | null;
        tool_call_input: unknown;
        version: number | string;
      }>(
        `
SELECT r.id,r.session_id,r.task_id,tc.id AS tool_call_id,
       tc.step_id AS tool_call_step_id,tc.tool_name AS tool_call_name,
       tc.input AS tool_call_input,r.version,
       r.recovery_step_id,r.recovery_tool_call_id
FROM turn_runs r JOIN tasks t ON t.tenant_id=r.tenant_id AND t.id=r.task_id
LEFT JOIN tool_calls tc
  ON tc.tenant_id=r.tenant_id AND tc.run_id=r.id
 AND tc.id=r.recovery_tool_call_id
 AND tc.step_id=r.recovery_step_id
 AND tc.status='failed'
WHERE r.tenant_id=$1::uuid AND r.id=$2::uuid AND t.user_id=$3::uuid
  AND r.state='recovery_required'
FOR UPDATE OF r
        `.trim(),
        [tenantId, runId, userId],
      );
      const recovered = rows[0];
      if (!recovered) return false;
      if (action === "cancel") {
        await executor.execute(
          "UPDATE turn_runs SET state='cancelled',recovery_step_id=NULL,recovery_tool_call_id=NULL,cancelled_at=now(),completed_at=now(),updated_at=now() WHERE tenant_id=$1::uuid AND id=$2::uuid",
          [tenantId, runId],
        );
        await executor.execute(
          "UPDATE tasks SET status='cancelled',updated_at=now() WHERE tenant_id=$1::uuid AND id=$2::uuid",
          [tenantId, recovered.task_id],
        );
        await reconcileTerminalUsage(executor, tenantId, runId, "cancelled");
        await appendDurableEvents(executor, tenantId, runId, recovered.session_id, [
          { kind: "turn.end", turnId: runId, status: "cancelled" },
        ]);
        return true;
      }
      if (!recovered.tool_call_id || !recovered.tool_call_step_id) {
        throw new Error("Recovery-required run has no exact failed tool reference; operator confirmation cannot guess a tool");
      }
      if (action === "mark-complete") {
        if (!recovered.tool_call_name) {
          throw new Error("Recovery-required run has no exact failed tool reference to mark complete");
        }
        const entryId = randomUUID();
        const confirmation = {
          confirmedByOperator: true,
          summary: "Operator confirmed that the external tool completed.",
        };
        const leaf = await executor.query<{ entry_id: string; entry_type: string; payload: unknown }>(
          `
SELECT entry_id,entry_type,payload FROM session_entries
WHERE tenant_id=$1::uuid AND session_id=$2::uuid AND is_leaf_marker=true
ORDER BY sequence DESC LIMIT 1
FOR UPDATE
          `.trim(),
          [tenantId, recovered.session_id],
        );
        const parentId = activeLeafId(leaf[0]);
        const entrySequence = await executor.query<{ value: number | string }>(
          "SELECT COALESCE(MAX(sequence),0)+1 AS value FROM session_entries WHERE tenant_id=$1::uuid AND session_id=$2::uuid",
          [tenantId, recovered.session_id],
        );
        await executor.execute(
          "UPDATE session_entries SET is_leaf_marker=false WHERE tenant_id=$1::uuid AND session_id=$2::uuid AND is_leaf_marker=true",
          [tenantId, recovered.session_id],
        );
        await executor.execute(
          `
INSERT INTO session_entries (
  tenant_id,session_id,entry_id,parent_entry_id,entry_type,sequence,payload,
  is_leaf_marker,run_id,step_id
) VALUES ($1::uuid,$2::uuid,$3,$4,'message',$5,$6::jsonb,true,$7::uuid,$8::uuid)
          `.trim(),
          [
            tenantId,
            recovered.session_id,
            entryId,
            parentId,
            Number(entrySequence[0]?.value ?? 1),
            JSON.stringify({
              type: "message",
              id: entryId,
              parentId,
              timestamp: new Date().toISOString(),
              message: {
                role: "toolResult",
                toolCallId: recovered.tool_call_id,
                toolName: recovered.tool_call_name,
                content: [{ type: "text", text: confirmation.summary }],
                isError: false,
                timestamp: Date.now(),
                details: confirmation,
              },
            }),
            runId,
            recovered.tool_call_step_id,
          ],
        );
        await executor.execute(
          `
UPDATE turn_steps
SET state='completed',output=$4::jsonb,session_entry_id=$5,
    completed_at=now(),error=NULL,updated_at=now()
WHERE tenant_id=$1::uuid AND run_id=$2::uuid AND id=$3::uuid
          `.trim(),
          [tenantId, runId, recovered.tool_call_step_id, JSON.stringify(confirmation), entryId],
        );
        await executor.execute(
          `
UPDATE tool_calls
SET status='completed',output=$4::jsonb,completed_at=now(),updated_at=now()
WHERE tenant_id=$1::uuid AND run_id=$2::uuid AND id=$3::uuid
          `.trim(),
          [tenantId, runId, recovered.tool_call_id, JSON.stringify(confirmation)],
        );
        await executor.execute(
          `
UPDATE message_parts
SET content=content || jsonb_build_object(
      'status','completed',
      'output',$3::jsonb,
      'summary','Operator confirmed that the tool completed.'
    )
WHERE tenant_id=$1::uuid AND type='tool-result'
  AND content->>'toolCallId'=$2
          `.trim(),
          [tenantId, recovered.tool_call_id, JSON.stringify(confirmation)],
        );
        const nextStep = await executor.query<{ sequence: number | string; iteration: number | string }>(
          `
SELECT COALESCE(MAX(sequence),0)+1 AS sequence,
       COUNT(*) FILTER (WHERE step_type='model.call')+1 AS iteration
FROM turn_steps
WHERE tenant_id=$1::uuid AND run_id=$2::uuid
          `.trim(),
          [tenantId, runId],
        );
        const iteration = Number(nextStep[0]?.iteration ?? 1);
        await executor.execute(
          `
INSERT INTO turn_steps (
  tenant_id,run_id,sequence,step_type,state,input,retry_class,idempotency_key
) VALUES (
  $1::uuid,$2::uuid,$3,'model.call','pending',$4::jsonb,
  'idempotent_with_key',$5
)
          `.trim(),
          [
            tenantId,
            runId,
            Number(nextStep[0]?.sequence ?? 1),
            JSON.stringify({ iteration, operatorRecovery: "mark-complete" }),
            `${runId}:model:${iteration}`,
          ],
        );
        await executor.execute(
          `
UPDATE turn_runs
SET state='calling_model',error=NULL,next_action='Continue after operator-confirmed tool completion',
    completed_at=NULL,recovery_step_id=NULL,recovery_tool_call_id=NULL,updated_at=now()
WHERE tenant_id=$1::uuid AND id=$2::uuid
          `.trim(),
          [tenantId, runId],
        );
        await executor.execute(
          `
UPDATE sessions
SET runtime_metadata=runtime_metadata || jsonb_build_object(
      'leafId',$3::text,'activeRunId',$4::text,'lastRunState','calling_model'
    ),
    updated_at=now()
WHERE tenant_id=$1::uuid AND id=$2::uuid
          `.trim(),
          [tenantId, recovered.session_id, entryId, runId],
        );
      } else {
        await executor.execute(
          `
UPDATE turn_steps SET state='pending',error=NULL,updated_at=now()
WHERE tenant_id=$1::uuid AND run_id=$2::uuid AND id=$3::uuid AND state='recovery_required'
          `.trim(),
          [tenantId, runId, recovered.tool_call_step_id],
        );
        await executor.execute(
          `
UPDATE tool_calls SET status='pending',completed_at=NULL,updated_at=now()
WHERE tenant_id=$1::uuid AND run_id=$2::uuid AND id=$3::uuid AND step_id=$4::uuid AND status='failed'
          `.trim(),
          [tenantId, runId, recovered.tool_call_id, recovered.tool_call_step_id],
        );
        await executor.execute(
          `
UPDATE turn_runs
SET state='executing_tool',error=NULL,next_action='Retry tool after explicit operator confirmation',
    completed_at=NULL,recovery_step_id=NULL,recovery_tool_call_id=NULL,version=version+1,updated_at=now()
WHERE tenant_id=$1::uuid AND id=$2::uuid
          `.trim(),
          [tenantId, runId],
        );
      }
      await executor.execute(
        "UPDATE tasks SET status='running',updated_at=now() WHERE tenant_id=$1::uuid AND id=$2::uuid",
        [tenantId, recovered.task_id],
      );
      await appendDurableEvents(executor, tenantId, runId, recovered.session_id, [
        { kind: "turn.start", turnId: runId, continuation: true },
        ...(action === "mark-complete" && recovered.tool_call_id && recovered.tool_call_name ? [
          {
            kind: "tool.start" as const,
            toolCallId: recovered.tool_call_id,
            name: recovered.tool_call_name,
            args: (recovered.tool_call_input ?? {}) as JsonValue,
          },
          {
            kind: "tool.end" as const,
            toolCallId: recovered.tool_call_id,
            status: "completed" as const,
            summary: "Operator confirmed that the tool completed.",
          },
        ] : []),
        {
          kind: "tool.update",
          toolCallId: recovered.tool_call_id ?? runId,
          detail: action === "mark-complete"
            ? "An operator confirmed the tool completed; the durable turn will continue."
            : "An operator explicitly requested a tool retry.",
        },
      ]);
      await executor.execute(
        `
INSERT INTO runtime_outbox (tenant_id,event_type,aggregate_id,dedupe_key,payload)
VALUES ($1::uuid,'turn.resume',$2,$3,$4::jsonb)
ON CONFLICT (tenant_id,dedupe_key) DO NOTHING
        `.trim(),
        [
          tenantId,
          runId,
          `${runId}:operator:${action}:${Number(recovered.version) + 1}`,
          JSON.stringify({ tenantId, runId, reason: "operator-recovery" }),
        ],
      );
      return true;
    });
  }
}

async function loadAdmissionReplay(
  executor: SqlExecutor,
  tenantId: string,
  requestId: string,
): Promise<AdmissionReplayRow | null> {
  const rows = await executor.query<AdmissionReplayRow>(
    `
SELECT id,user_id,workspace_id,task_id,session_id,runtime_request
FROM turn_runs
WHERE tenant_id=$1::uuid AND request_id=$2
LIMIT 1
    `.trim(),
    [tenantId, requestId],
  );
  return rows[0] ?? null;
}

function validateAdmissionReplay(
  replayed: AdmissionReplayRow,
  input: DurableTurnAdmissionReplay,
): { runId: string; sessionId: string } {
  const runtimeRequest = recordValue(replayed.runtime_request);
  if (
    replayed.user_id !== input.userId
    || replayed.workspace_id !== input.workspaceId
    || replayed.task_id !== input.taskId
    || replayed.session_id !== input.sessionId
    || stringValue(runtimeRequest?.admissionFingerprint) !== input.operationFingerprint
  ) {
    throw new ConflictException("This turn operation key belongs to a different request");
  }
  return { runId: replayed.id, sessionId: input.sessionId };
}

async function cancelActiveDurableRun(
  transaction: SqlExecutor,
  tenantId: string,
  active: { id: string; task_id: string; session_id: string; request_message_id: string | null; sandbox_id: string | null },
): Promise<void> {
  const ambiguousRows = await transaction.query<{ step_id: string; tool_call_id: string }>(
    `
SELECT s.id AS step_id,tc.id AS tool_call_id
FROM turn_steps s
LEFT JOIN tool_calls tc ON tc.tenant_id=s.tenant_id AND tc.step_id=s.id
WHERE s.tenant_id=$1::uuid AND s.run_id=$2::uuid
  AND s.state='running' AND s.retry_class='non_idempotent_manual'
ORDER BY s.sequence DESC
LIMIT 1
FOR UPDATE OF s
    `.trim(),
    [tenantId, active.id],
  );
  const ambiguous = ambiguousRows[0] ?? null;
  if (!ambiguous) {
    await projectInterruptedTools(transaction, tenantId, active.session_id, active.task_id, active.id);
  }
  await projectTerminalAssistant(
    transaction,
    tenantId,
    active.session_id,
    active.task_id,
    active.id,
    ambiguous ? "failed" : "cancelled",
    ambiguous ? "The external mutation outcome is uncertain. Operator review is required before retry." : undefined,
  );
  await transaction.execute(
    `
UPDATE turn_steps
SET state=CASE WHEN $3::uuid IS NOT NULL AND id=$3::uuid THEN 'recovery_required' ELSE 'cancelled' END,
    completed_at=COALESCE(completed_at,now()),
    closure_reason=COALESCE(closure_reason,CASE WHEN $3::uuid IS NOT NULL AND id=$3::uuid THEN 'ambiguous_external_operation' ELSE 'turn_cancelled' END),
    closed_at=COALESCE(closed_at,now()),updated_at=now()
WHERE tenant_id=$1::uuid AND run_id=$2::uuid
  AND state IN ('pending','running','waiting')
    `.trim(),
    [tenantId, active.id, ambiguous?.step_id ?? null],
  );
  await transaction.execute(
    `
UPDATE tool_calls
SET status=CASE WHEN $3::uuid IS NOT NULL AND id=$3::uuid THEN 'failed'::tool_call_status ELSE 'cancelled'::tool_call_status END,
    completed_at=COALESCE(completed_at,now()),
    closure_reason=COALESCE(closure_reason,CASE WHEN $3::uuid IS NOT NULL AND id=$3::uuid THEN 'ambiguous_external_operation' ELSE 'turn_cancelled' END),
    closed_at=COALESCE(closed_at,now()),updated_at=now()
WHERE tenant_id=$1::uuid AND run_id=$2::uuid
  AND status IN ('pending','waiting-for-approval','running')
    `.trim(),
    [tenantId, active.id, ambiguous?.tool_call_id ?? null],
  );
  await transaction.execute(
    "UPDATE approvals SET status='expired',decided_at=now(),closure_reason=COALESCE(closure_reason,'turn_cancelled'),closed_at=COALESCE(closed_at,now()) WHERE tenant_id=$1::uuid AND run_id=$2::uuid AND status='pending'",
    [tenantId, active.id],
  );
  await transaction.execute(
    "UPDATE turn_questions SET status='cancelled',closure_reason=COALESCE(closure_reason,'turn_cancelled'),closed_at=COALESCE(closed_at,now()) WHERE tenant_id=$1::uuid AND run_id=$2::uuid AND status='pending'",
    [tenantId, active.id],
  );
  await appendDurableEvents(transaction, tenantId, active.id, active.session_id, [
    { kind: "turn.end", turnId: active.id, status: ambiguous ? "failed" : "cancelled" },
  ]);
  await transaction.execute(
    `
UPDATE turn_runs
SET state=CASE WHEN $3::boolean THEN 'recovery_required' ELSE 'cancelled' END,
    cancelled_at=now(),completed_at=now(),
    recovery_step_id=CASE WHEN $3::boolean THEN $4::uuid ELSE NULL END,
    recovery_tool_call_id=CASE WHEN $3::boolean THEN $5::uuid ELSE NULL END,
    human_wait_ms=human_wait_ms+CASE WHEN waiting_started_at IS NULL THEN 0 ELSE GREATEST(0,FLOOR(EXTRACT(EPOCH FROM (now()-waiting_started_at))*1000)::bigint) END,
    waiting_started_at=NULL,lease_owner=NULL,lease_expires_at=NULL,waiting_reason=NULL,next_action=NULL,
    version=version+1,updated_at=now()
WHERE tenant_id=$1::uuid AND id=$2::uuid
    `.trim(),
    [tenantId, active.id, Boolean(ambiguous), ambiguous?.step_id ?? null, ambiguous?.tool_call_id ?? null],
  );
  await transaction.execute(
    `
UPDATE runtime_outbox
SET completed_at=COALESCE(completed_at,now()),lease_owner=NULL,lease_expires_at=NULL,updated_at=now()
WHERE tenant_id=$1::uuid AND aggregate_id=$2 AND completed_at IS NULL
    `.trim(),
    [tenantId, active.id],
  );
  await transaction.execute(
    "UPDATE tasks SET status=$3::task_status,updated_at=now() WHERE tenant_id=$1::uuid AND id=$2::uuid",
    [tenantId, active.task_id, ambiguous ? "failed" : "cancelled"],
  );
  await transaction.execute(
    `
INSERT INTO turn_finalizations (tenant_id,run_id,operation_key,terminal_state,status,completed_at)
VALUES ($1::uuid,$2::uuid,$2::text || ':finalization',$3,
        CASE WHEN $4::boolean THEN 'pending' ELSE 'skipped' END,
        CASE WHEN $4::boolean THEN NULL ELSE now() END)
ON CONFLICT (tenant_id,run_id) DO NOTHING
    `.trim(),
    [tenantId, active.id, ambiguous ? "recovery_required" : "cancelled", Boolean(active.sandbox_id)],
  );
  if (active.sandbox_id) {
    await transaction.execute(
      `
INSERT INTO runtime_outbox (tenant_id,event_type,aggregate_id,dedupe_key,payload)
VALUES ($1::uuid,'sandbox.snapshot',$2,$3,$4::jsonb)
ON CONFLICT (tenant_id,dedupe_key) DO NOTHING
      `.trim(),
      [
        tenantId,
        active.id,
        `${active.id}:snapshot:finalization`,
        JSON.stringify({ tenantId, runId: active.id, reason: "before-finalize" }),
      ],
    );
  }
  await appendDurableEvents(transaction, tenantId, active.id, active.session_id, [
    { kind: "finalization.start", runId: active.id, operationKey: `${active.id}:finalization` },
    ...(!active.sandbox_id
      ? [{
          kind: "finalization.end" as const,
          runId: active.id,
          operationKey: `${active.id}:finalization`,
          status: "skipped" as const,
          itemCount: 0,
          completedCount: 0,
          failedCount: 0,
        }]
      : []),
  ]);
  await reconcileTerminalUsage(transaction, tenantId, active.id, ambiguous ? "recovery_required" : "cancelled");
  await transaction.execute(
    `
UPDATE sessions
SET runtime_metadata=runtime_metadata || jsonb_build_object(
      'activeRunId',$2::text,
      'lastRunState',CASE WHEN $4::boolean THEN 'recovery_required' ELSE 'cancelled' END,
      'leafId',COALESCE((
        SELECT entry_id FROM session_entries
        WHERE tenant_id=$1::uuid AND session_id=$3::uuid AND is_leaf_marker=true
        ORDER BY sequence DESC LIMIT 1
      ),runtime_metadata->>'leafId')
    ),
    updated_at=now()
WHERE tenant_id=$1::uuid AND id=$3::uuid
    `.trim(),
    [tenantId, active.id, active.session_id, Boolean(ambiguous)],
  );
}

async function expireQuestionTransaction(
  transaction: SqlExecutor,
  tenantId: string,
  question: {
    id: string;
    run_id: string;
    session_id: string;
    task_id: string;
    step_id: string;
    tool_call_id: string | null;
  },
): Promise<void> {
  const summary = "This question expired before it was answered. Start a follow-up turn if you still want to continue.";
  const activeSiblings = await transaction.query<{ id: string }>(
    `
SELECT id
FROM turn_steps
WHERE tenant_id=$1::uuid AND run_id=$2::uuid AND id<>$3::uuid
  AND state IN ('pending','running','waiting')
LIMIT 1
    `.trim(),
    [tenantId, question.run_id, question.step_id],
  );
  await transaction.execute(
    `
UPDATE turn_questions
SET status='expired',expired_at=COALESCE(expired_at,now()),closed_at=COALESCE(closed_at,now()),
    closure_reason=COALESCE(closure_reason,'question_expired')
WHERE tenant_id=$1::uuid AND id=$2::uuid AND status='pending'
    `.trim(),
    [tenantId, question.id],
  );
  await transaction.execute(
    `
UPDATE turn_steps
SET state='failed',error=COALESCE(error,$4),completed_at=COALESCE(completed_at,now()),
    closure_reason=COALESCE(closure_reason,'question_expired'),closed_at=COALESCE(closed_at,now()),updated_at=now()
WHERE tenant_id=$1::uuid AND run_id=$2::uuid AND id=$3::uuid
    `.trim(),
    [tenantId, question.run_id, question.step_id, summary],
  );
  if (question.tool_call_id) {
    await transaction.execute(
      `
UPDATE tool_calls
SET status='failed',completed_at=COALESCE(completed_at,now()),closure_reason=COALESCE(closure_reason,'question_expired'),
    closed_at=COALESCE(closed_at,now()),updated_at=now()
WHERE tenant_id=$1::uuid AND run_id=$2::uuid AND id=$3::uuid
      `.trim(),
      [tenantId, question.run_id, question.tool_call_id],
    );
  }
  const nextState = activeSiblings.length > 0 ? "recovery_required" : "failed";
  await projectTerminalAssistant(
    transaction,
    tenantId,
    question.session_id,
    question.task_id,
    question.run_id,
    "failed",
    activeSiblings.length > 0
      ? "The question expired while another durable operation was still active. Operator recovery is required."
      : summary,
  );
  await appendDurableEvents(transaction, tenantId, question.run_id, question.session_id, [
    { kind: "question.expired", questionId: question.id },
    { kind: "error", message: summary },
    { kind: "turn.end", turnId: question.run_id, status: "failed" },
  ]);
  await transaction.execute(
    `
UPDATE turn_runs
SET state=$3,error=$4,next_action=NULL,waiting_reason=NULL,completed_at=COALESCE(completed_at,now()),
    human_wait_ms=human_wait_ms+CASE WHEN waiting_started_at IS NULL THEN 0 ELSE GREATEST(0,FLOOR(EXTRACT(EPOCH FROM (now()-waiting_started_at))*1000)::bigint) END,
    waiting_started_at=NULL,lease_owner=NULL,lease_expires_at=NULL,version=version+1,updated_at=now()
WHERE tenant_id=$1::uuid AND id=$2::uuid AND state='waiting'
    `.trim(),
    [tenantId, question.run_id, nextState, summary],
  );
  await transaction.execute(
    "UPDATE tasks SET status='failed',updated_at=now() WHERE tenant_id=$1::uuid AND id=$2::uuid",
    [tenantId, question.task_id],
  );
  await reconcileTerminalUsage(transaction, tenantId, question.run_id, nextState);
}

export function compactReplayEvents(events: readonly AgentStreamEvent[]): AgentStreamEvent[] {
  const merged: AgentStreamEvent[] = [];
  for (const event of events) {
    const previous = merged.at(-1);
    if (
      event.kind === "message.delta"
      && previous?.kind === "message.delta"
      && previous.messageId === event.messageId
      && previous.channel === event.channel
    ) {
      merged[merged.length - 1] = { ...previous, delta: previous.delta + event.delta };
      continue;
    }
    if (
      event.kind === "tool.update"
      && previous?.kind === "tool.update"
      && previous.toolCallId === event.toolCallId
    ) {
      merged[merged.length - 1] = event;
      continue;
    }
    merged.push(event);
  }

  const keep = new Array<boolean>(merged.length).fill(true);
  const latestPartial = new Set<string>();
  let keptUsage = false;
  for (let index = merged.length - 1; index >= 0; index -= 1) {
    const event = merged[index]!;
    if (event.kind === "image.partial") {
      const key = `${event.toolCallId}:${event.requestIndex}`;
      if (latestPartial.has(key)) keep[index] = false;
      else latestPartial.add(key);
    } else if (event.kind === "usage") {
      if (keptUsage) keep[index] = false;
      else keptUsage = true;
    }
  }
  return merged.filter((_event, index) => keep[index]);
}

function activeReplayBoundary(
  state: string,
  positions: {
    message_start: number | string | null;
    message_end: number | string | null;
    tool_start: number | string | null;
    tool_end: number | string | null;
    turn_start: number | string | null;
  } | undefined,
  maximum: number | null,
): number {
  const afterEverything = (maximum ?? 0) + 1;
  if (state === "queued" || state === "assembling_context") {
    return nullableNumber(positions?.turn_start) ?? afterEverything;
  }
  if (state === "calling_model") {
    const start = nullableNumber(positions?.message_start);
    const end = nullableNumber(positions?.message_end);
    return start !== null && start > (end ?? 0) ? start : afterEverything;
  }
  if (state === "executing_tool" || state === "waiting") {
    const start = nullableNumber(positions?.tool_start);
    const end = nullableNumber(positions?.tool_end);
    return start !== null && start > (end ?? 0) ? start : afterEverything;
  }
  return afterEverything;
}

function nullableNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function nullableIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function continuableRequestMessageId(
  executor: SqlExecutor,
  input: DurableTurnAdmission,
): Promise<string> {
  const rows = await executor.query<{ request_message_id: string | null }>(
    `
SELECT request_message_id
FROM turn_runs
WHERE tenant_id=$1::uuid AND session_id=$2::uuid
  AND state IN ('failed','cancelled')
ORDER BY created_at DESC
LIMIT 1
    `.trim(),
    [input.tenantId, input.sessionId],
  );
  const requestMessageId = rows[0]?.request_message_id;
  if (!requestMessageId) throw new Error("No failed or cancelled durable turn can be continued");
  return requestMessageId;
}

async function ensureUserMessage(
  executor: SqlExecutor,
  input: DurableTurnAdmission,
): Promise<string> {
  if (input.requestMessageId) {
    const requested = await executor.query<{ id: string }>(
      `
SELECT id
FROM messages
WHERE tenant_id=$1::uuid AND session_id=$2::uuid AND task_id=$3::uuid
  AND id=$4::uuid AND role='user'
LIMIT 1
      `.trim(),
      [input.tenantId, input.sessionId, input.taskId, input.requestMessageId],
    );
    if (requested[0]) return requested[0].id;
    return insertUserMessage(executor, input, input.requestMessageId);
  }
  const rows = await executor.query<{ id: string }>(
    `
SELECT m.id
FROM messages m
JOIN message_parts part
  ON part.tenant_id=m.tenant_id AND part.message_id=m.id
 AND part.type='text' AND part.content=to_jsonb($3::text)
LEFT JOIN session_entries entry
  ON entry.tenant_id=m.tenant_id AND entry.session_id=m.session_id
 AND entry.entry_id=m.id::text
WHERE m.tenant_id=$1::uuid AND m.session_id=$2::uuid AND m.role='user'
  AND entry.entry_id IS NULL
ORDER BY m.sequence_id DESC
LIMIT 1
    `.trim(),
    [input.tenantId, input.sessionId, input.messageInput ?? input.input],
  );
  if (rows[0]) return rows[0].id;
  return insertUserMessage(executor, input, randomUUID());
}

async function insertUserMessage(
  executor: SqlExecutor,
  input: DurableTurnAdmission,
  id: string,
): Promise<string> {
  await executor.execute(
    `
INSERT INTO messages (id,tenant_id,session_id,task_id,role,status)
VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'user','complete')
    `.trim(),
    [id, input.tenantId, input.sessionId, input.taskId],
  );
  await executor.execute(
    `
INSERT INTO message_parts (tenant_id,message_id,type,content,ordinal)
VALUES ($1::uuid,$2::uuid,'text',$3::jsonb,0)
    `.trim(),
    [input.tenantId, id, JSON.stringify(input.messageInput ?? input.input)],
  );
  for (const [index, attachment] of (input.attachments ?? []).entries()) {
    await executor.execute(
      `
INSERT INTO message_parts (tenant_id,message_id,type,content,ordinal)
VALUES ($1::uuid,$2::uuid,'attachment',$3::jsonb,$4)
      `.trim(),
      [input.tenantId, id, JSON.stringify(messageAttachmentContent(attachment)), index + 1],
    );
  }
  return id;
}

async function rewindProjectionForEdit(
  executor: SqlExecutor,
  input: DurableTurnAdmission,
): Promise<void> {
  const messageId = input.replaceFromMessageId!;
  const target = await executor.query<{ sequence_id: number | string }>(
    `
SELECT sequence_id
FROM messages
WHERE tenant_id=$1::uuid AND session_id=$2::uuid AND task_id=$3::uuid
  AND id=$4::uuid AND role='user'
LIMIT 1
FOR UPDATE
    `.trim(),
    [input.tenantId, input.sessionId, input.taskId, messageId],
  );
  if (!target[0]) {
    throw new ConflictException("The message being edited is stale or no longer exists");
  }
  await syncMessageJournal(executor, input);
  if (!await rewindJournalBeforeExecutor(executor, input.tenantId, input.sessionId, messageId)) {
    throw new ConflictException("The message being edited has no durable history entry");
  }
  const affectedFiles = await executor.query<{ file_id: string }>(`
    SELECT DISTINCT association.file_id
    FROM file_associations association
    JOIN messages message
      ON message.tenant_id = association.tenant_id
     AND message.id = association.message_id
    WHERE message.tenant_id = $1::uuid AND message.session_id = $2::uuid
      AND message.sequence_id >= $3
    ORDER BY association.file_id
  `, [input.tenantId, input.sessionId, target[0].sequence_id]);
  await executor.execute(
    `
DELETE FROM messages
WHERE tenant_id=$1::uuid AND session_id=$2::uuid AND sequence_id >= $3
    `.trim(),
    [input.tenantId, input.sessionId, target[0].sequence_id],
  );
  for (const { file_id: fileId } of affectedFiles) {
    await garbageCollectFileIfUnreferenced(executor, input.tenantId, fileId);
  }
}

async function rewindJournalBeforeExecutor(
  executor: SqlExecutor,
  tenantId: string,
  sessionId: string,
  messageId: string,
): Promise<boolean> {
  const target = await executor.query<{ parent_entry_id: string | null }>(
    `SELECT parent_entry_id FROM session_entries
     WHERE tenant_id=$1::uuid AND session_id=$2::uuid AND entry_id=$3
     LIMIT 1 FOR UPDATE`,
    [tenantId, sessionId, messageId],
  );
  if (!target[0]) return false;
  const leafId = target[0].parent_entry_id;
  await executor.execute(
    "UPDATE session_entries SET is_leaf_marker=COALESCE(entry_id=$3,false) WHERE tenant_id=$1::uuid AND session_id=$2::uuid AND (is_leaf_marker=true OR entry_id=$3)",
    [tenantId, sessionId, leafId],
  );
  await executor.execute(
    `UPDATE sessions SET runtime_metadata=runtime_metadata || jsonb_build_object('leafId',$3::text),updated_at=now()
     WHERE tenant_id=$1::uuid AND id=$2::uuid`,
    [tenantId, sessionId, leafId],
  );
  return true;
}

async function projectTerminalAssistant(
  executor: SqlExecutor,
  tenantId: string,
  sessionId: string,
  taskId: string,
  runId: string,
  status: "failed" | "cancelled",
  error?: string,
): Promise<void> {
  const eventRows = await executor.query<{ payload: unknown }>(
    `
SELECT payload
FROM turn_events
WHERE tenant_id=$1::uuid AND run_id=$2::uuid
  AND sequence >= COALESCE((
    SELECT MAX(sequence) FROM turn_events
    WHERE tenant_id=$1::uuid AND run_id=$2::uuid AND event_type='message.start'
  ),0)
ORDER BY sequence ASC
    `.trim(),
    [tenantId, runId],
  );
  const events = eventRows.map((row) => AgentStreamEventSchema.parse(row.payload));
  const latest = latestAssistantStreamDraft(events);
  const usePartial = latest?.open === true;
  const messageId = usePartial ? latest.messageId : randomUUID();
  const reasoning = usePartial && latest.reasoning.trim()
    ? latest.reasoning
    : !usePartial && !error
      ? "Response interrupted."
      : "";
  const text = usePartial ? latest.text : "";

  await executor.execute(
    `
INSERT INTO messages (id,tenant_id,session_id,task_id,role,status)
VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'assistant',$5::message_status)
ON CONFLICT (id) DO UPDATE
SET status=EXCLUDED.status,updated_at=now()
    `.trim(),
    [messageId, tenantId, sessionId, taskId, status],
  );
  let ordinal = 0;
  for (const part of [
    ...(reasoning ? [{ type: "reasoning", content: reasoning }] : []),
    ...(text ? [{ type: "text", content: text }] : []),
    ...(error ? [{ type: "error", content: error.slice(0, 4_000) }] : []),
  ]) {
    await executor.execute(
      `
INSERT INTO message_parts (tenant_id,message_id,type,content,ordinal)
VALUES ($1::uuid,$2::uuid,$3::message_part_kind,$4::jsonb,$5)
ON CONFLICT (message_id,ordinal) DO NOTHING
      `.trim(),
      [tenantId, messageId, part.type, JSON.stringify(part.content), ordinal],
    );
    ordinal += 1;
  }

  if (!text.trim()) return;
  const existing = await executor.query<{ entry_id: string }>(
    "SELECT entry_id FROM session_entries WHERE tenant_id=$1::uuid AND session_id=$2::uuid AND entry_id=$3",
    [tenantId, sessionId, messageId],
  );
  if (existing[0]) return;
  const leaf = await executor.query<{ entry_id: string; entry_type: string; payload: unknown }>(
    `
SELECT entry_id,entry_type,payload FROM session_entries
WHERE tenant_id=$1::uuid AND session_id=$2::uuid AND is_leaf_marker=true
ORDER BY sequence DESC LIMIT 1
FOR UPDATE
    `.trim(),
    [tenantId, sessionId],
  );
  const parentId = activeLeafId(leaf[0]);
  const sequence = await executor.query<{ value: number | string }>(
    "SELECT COALESCE(MAX(sequence),0)+1 AS value FROM session_entries WHERE tenant_id=$1::uuid AND session_id=$2::uuid",
    [tenantId, sessionId],
  );
  await executor.execute(
    "UPDATE session_entries SET is_leaf_marker=false WHERE tenant_id=$1::uuid AND session_id=$2::uuid AND is_leaf_marker=true",
    [tenantId, sessionId],
  );
  const payload = {
    type: "message",
    id: messageId,
    parentId,
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason: status,
      timestamp: Date.now(),
    },
  };
  await executor.execute(
    `
INSERT INTO session_entries (
  tenant_id,session_id,entry_id,parent_entry_id,entry_type,sequence,payload,is_leaf_marker,run_id
) VALUES ($1::uuid,$2::uuid,$3,$4,'message',$5,$6::jsonb,true,$7::uuid)
ON CONFLICT (tenant_id,session_id,entry_id) DO NOTHING
    `.trim(),
    [tenantId, sessionId, messageId, parentId, Number(sequence[0]?.value ?? 1), JSON.stringify(payload), runId],
  );
}

async function projectInterruptedTools(
  executor: SqlExecutor,
  tenantId: string,
  sessionId: string,
  taskId: string,
  runId: string,
): Promise<void> {
  const tools = await executor.query<{ id: string; tool_name: string; input: unknown }>(
    `
SELECT id,tool_name,input
FROM tool_calls
WHERE tenant_id=$1::uuid AND run_id=$2::uuid
  AND status IN ('pending','waiting-for-approval','running')
ORDER BY created_at ASC
    `.trim(),
    [tenantId, runId],
  );
  for (const tool of tools) {
    const messageId = randomUUID();
    await executor.execute(
      `
INSERT INTO messages (id,tenant_id,session_id,task_id,role,status)
VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'assistant','complete')
      `.trim(),
      [messageId, tenantId, sessionId, taskId],
    );
    await executor.execute(
      `
INSERT INTO message_parts (tenant_id,message_id,type,content,ordinal)
VALUES ($1::uuid,$2::uuid,'tool-result',$3::jsonb,0)
      `.trim(),
      [
        tenantId,
        messageId,
        JSON.stringify({
          toolCallId: tool.id,
          name: tool.tool_name,
          arguments: tool.input,
          status: "cancelled",
          summary: "Interrupted by the user.",
        }),
      ],
    );
  }
}

async function ensureInputFileAssociations(
  executor: SqlExecutor,
  input: DurableTurnAdmission,
  messageId: string,
): Promise<void> {
  const fileIds = [...new Set((input.attachments ?? []).flatMap((attachment) =>
    attachment.fileId ? [attachment.fileId] : [],
  ))];
  if (fileIds.length === 0) return;
  const locked = await executor.query<{ id: string; blob_id: string | null }>(`
    SELECT f.id,f.blob_id
    FROM files f
    LEFT JOIN file_blobs blob
      ON blob.tenant_id=f.tenant_id AND blob.id=f.blob_id
    WHERE f.tenant_id=$1::uuid AND f.id=ANY($2::uuid[]) AND f.deleted_at IS NULL
      AND (
        f.blob_id IS NULL OR (
          blob.id IS NOT NULL AND blob.deleted_at IS NULL
          AND blob.verification_status<>'deleted'
        )
      )
    ORDER BY f.id
    FOR UPDATE OF f
  `, [input.tenantId, fileIds]);
  if (locked.length !== fileIds.length) {
    throw new Error("One or more input files became unavailable");
  }
  const authorized = await executor.query<{ id: string }>(
    `
SELECT f.id
FROM files f
WHERE f.tenant_id=$1::uuid
  AND f.id=ANY($3::uuid[]) AND f.deleted_at IS NULL
  AND (
    EXISTS (
      SELECT 1 FROM file_library_entries library
      WHERE library.tenant_id=f.tenant_id AND library.file_id=f.id
        AND library.user_id=$2::uuid AND library.deleted_at IS NULL
    ) OR EXISTS (
      SELECT 1
      FROM file_associations access_link
      LEFT JOIN sessions access_session
        ON access_session.tenant_id=access_link.tenant_id
       AND access_session.id=access_link.session_id
      LEFT JOIN tasks access_task
        ON access_task.tenant_id=access_link.tenant_id
       AND access_task.id=COALESCE(access_link.task_id,access_session.task_id)
      WHERE access_link.tenant_id=f.tenant_id AND access_link.file_id=f.id
        AND access_task.id IS NOT NULL
        AND access_task.deleted_at IS NULL
        AND (access_task.user_id=$2::uuid OR access_task.user_id IS NULL)
    ) OR EXISTS (
      SELECT 1
      FROM workspace_files wf
      JOIN workspaces workspace
        ON workspace.tenant_id=wf.tenant_id AND workspace.id=wf.workspace_id
      WHERE wf.tenant_id=f.tenant_id AND wf.file_id=f.id
        AND wf.deleted_at IS NULL AND workspace.deleted_at IS NULL
        AND (
          workspace.owner_id=$2::uuid OR workspace.owner_id IS NULL OR
          EXISTS (
            SELECT 1 FROM tasks workspace_access_task
            WHERE workspace_access_task.tenant_id=workspace.tenant_id
              AND workspace_access_task.workspace_id=workspace.id
              AND workspace_access_task.user_id=$2::uuid
              AND workspace_access_task.deleted_at IS NULL
          )
        )
        AND (
          wf.visibility='project' OR
          EXISTS (
            SELECT 1 FROM tasks originating_task
            WHERE originating_task.tenant_id=wf.tenant_id
              AND originating_task.id=wf.originating_task_id
              AND (originating_task.user_id=$2::uuid OR originating_task.user_id IS NULL)
              AND originating_task.deleted_at IS NULL
          )
        )
    )
  )
    `.trim(),
    [input.tenantId, input.userId, fileIds],
  );
  if (authorized.length !== fileIds.length) {
    throw new Error("One or more input files are unavailable to the authenticated user");
  }
  for (const file of locked) {
    if (!file.blob_id) continue;
    await executor.execute(`
      UPDATE file_blobs
      SET verification_status=CASE
            WHEN sha256 IS NULL THEN 'unverified'::file_blob_verification_status
            ELSE 'verified'::file_blob_verification_status
          END,
          delete_after=NULL,updated_at=now()
      WHERE tenant_id=$1::uuid AND id=$2::uuid
        AND verification_status='pending_delete' AND deleted_at IS NULL
    `, [input.tenantId, file.blob_id]);
    await executor.execute(`
      UPDATE runtime_outbox
      SET completed_at=COALESCE(completed_at,now()),
          last_error='Cancelled because a file reference was added',updated_at=now()
      WHERE tenant_id=$1::uuid AND aggregate_id=$2
        AND event_type='file.delete-blob' AND completed_at IS NULL
    `, [input.tenantId, file.blob_id]);
  }
  for (const fileId of fileIds) {
    await executor.execute(
      `
INSERT INTO file_associations (
  tenant_id,file_id,task_id,session_id,message_id,role,created_by_user_id
) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,'input',$6::uuid)
ON CONFLICT DO NOTHING
      `.trim(),
      [input.tenantId, fileId, input.taskId, input.sessionId, messageId, input.userId],
    );
  }
}

async function ensureUserJournalEntry(
  executor: SqlExecutor,
  input: DurableTurnAdmission,
  messageId: string,
): Promise<void> {
  const existing = await executor.query<{ entry_id: string }>(
    "SELECT entry_id FROM session_entries WHERE tenant_id=$1::uuid AND session_id=$2::uuid AND entry_id=$3",
    [input.tenantId, input.sessionId, messageId],
  );
  if (existing[0]) return;
  const leaf = await executor.query<{ entry_id: string; entry_type: string; payload: unknown }>(
    `
SELECT entry_id,entry_type,payload FROM session_entries
WHERE tenant_id=$1::uuid AND session_id=$2::uuid AND is_leaf_marker=true
ORDER BY sequence DESC LIMIT 1
FOR UPDATE
    `.trim(),
    [input.tenantId, input.sessionId],
  );
  const parentId = activeLeafId(leaf[0]);
  const sequence = await executor.query<{ value: number | string }>(
    "SELECT COALESCE(MAX(sequence),0)+1 AS value FROM session_entries WHERE tenant_id=$1::uuid AND session_id=$2::uuid",
    [input.tenantId, input.sessionId],
  );
  const payload = {
    type: "message",
    id: messageId,
    parentId,
    timestamp: new Date().toISOString(),
    message: {
      role: "user",
      content: [
        { type: "text", text: input.input },
        ...(input.attachments ?? []).map((attachment) => ({
          type: "attachment",
          content: messageAttachmentContent(attachment),
        })),
      ],
      timestamp: Date.now(),
    },
    requestMessageId: messageId,
    projectionSource: "messages",
  };
  await executor.execute(
    "UPDATE session_entries SET is_leaf_marker=false WHERE tenant_id=$1::uuid AND session_id=$2::uuid AND is_leaf_marker=true",
    [input.tenantId, input.sessionId],
  );
  await executor.execute(
    `
INSERT INTO session_entries (
  tenant_id,session_id,entry_id,parent_entry_id,entry_type,sequence,payload,is_leaf_marker
) VALUES ($1::uuid,$2::uuid,$3,$4,'message',$5,$6::jsonb,true)
    `.trim(),
    [input.tenantId, input.sessionId, messageId, parentId, Number(sequence[0]?.value ?? 1), JSON.stringify(payload)],
  );
}

interface ProjectedMessagePartRow {
  message_id: string;
  sequence_id: number | string;
  role: "system" | "user" | "assistant" | "tool";
  status: string;
  created_at: Date | string;
  type: string | null;
  content: unknown;
  ordinal: number | string | null;
}

/** Reconciles ordinary message writes into the durable journal before every admitted turn. */
async function syncMessageJournal(
  executor: SqlExecutor,
  input: Pick<DurableTurnAdmission, "tenantId" | "sessionId">,
): Promise<void> {
  const rows = await executor.query<ProjectedMessagePartRow>(
    `
SELECT m.id::text AS message_id,m.sequence_id,m.role::text,m.status::text,m.created_at,
       p.type::text,p.content,p.ordinal
FROM messages m
LEFT JOIN message_parts p ON p.tenant_id=m.tenant_id AND p.message_id=m.id
LEFT JOIN message_parts tool_result_projection
  ON tool_result_projection.tenant_id=m.tenant_id
  AND tool_result_projection.message_id=m.id
  AND tool_result_projection.type='tool-result'
LEFT JOIN session_entries e
  ON e.tenant_id=m.tenant_id AND e.session_id=m.session_id
  AND (
    e.entry_id=m.id::text
    OR (
      tool_result_projection.content->>'toolCallId' IS NOT NULL
      AND e.payload->'message'->>'role'='toolResult'
      AND e.payload->'message'->>'toolCallId'=tool_result_projection.content->>'toolCallId'
    )
  )
WHERE m.tenant_id=$1::uuid AND m.session_id=$2::uuid AND e.entry_id IS NULL
ORDER BY m.sequence_id ASC,p.ordinal ASC NULLS LAST
    `.trim(),
    [input.tenantId, input.sessionId],
  );
  if (rows.length === 0) return;
  const messages = new Map<string, { row: ProjectedMessagePartRow; parts: Array<{ type: string; content: unknown }> }>();
  for (const row of rows) {
    const message = messages.get(row.message_id) ?? { row, parts: [] };
    if (row.type) message.parts.push({ type: row.type, content: row.content });
    messages.set(row.message_id, message);
  }
  const bounds = await executor.query<{
    minimum: number | string;
    maximum: number | string;
    first_created_at: Date | string | null;
    leaf_id: string | null;
    root_id: string | null;
  }>(
    `
SELECT COALESCE(MIN(sequence),0) AS minimum,COALESCE(MAX(sequence),0) AS maximum,MIN(created_at) AS first_created_at,
       (SELECT entry_id FROM session_entries leaf
        WHERE leaf.tenant_id=$1::uuid AND leaf.session_id=$2::uuid AND leaf.is_leaf_marker=true
        ORDER BY leaf.sequence DESC LIMIT 1) AS leaf_id,
       (SELECT entry_id FROM session_entries root
        WHERE root.tenant_id=$1::uuid AND root.session_id=$2::uuid AND root.parent_entry_id IS NULL
        ORDER BY root.sequence ASC LIMIT 1) AS root_id
FROM session_entries WHERE tenant_id=$1::uuid AND session_id=$2::uuid
    `.trim(),
    [input.tenantId, input.sessionId],
  );
  const firstCreatedAt = bounds[0]?.first_created_at ? new Date(bounds[0].first_created_at).getTime() : null;
  const before = [...messages.values()].filter((item) => firstCreatedAt !== null && new Date(item.row.created_at).getTime() < firstCreatedAt);
  const after = [...messages.values()].filter((item) => !before.includes(item));
  let beforeSequence = Number(bounds[0]?.minimum ?? 0) - before.length;
  let afterSequence = Number(bounds[0]?.maximum ?? 0) + 1;
  const insert = async (item: { row: ProjectedMessagePartRow; parts: Array<{ type: string; content: unknown }> }, sequence: number, parentId: string | null) => {
    const content = projectMessageParts(item.parts);
    const toolResult = item.parts.find((part) => part.type === "tool-result");
    const role = toolResult || item.row.role === "tool" ? "toolResult" : item.row.role;
    const toolResultContent = recordValue(toolResult?.content);
    const payload = {
      type: "message",
      id: item.row.message_id,
      parentId,
      timestamp: new Date(item.row.created_at).toISOString(),
      projectionSource: "messages",
      message: {
        role,
        content,
        ...(role === "toolResult" ? {
          toolCallId: stringValue(toolResultContent?.toolCallId) ?? item.row.message_id,
          toolName: stringValue(toolResultContent?.name) ?? "tool",
        } : {}),
        ...(item.row.status === "failed" ? { stopReason: "error" } : {}),
        ...(item.row.status === "cancelled" ? { stopReason: "aborted" } : {}),
        timestamp: new Date(item.row.created_at).getTime(),
      },
    };
    await executor.execute(
      `
INSERT INTO session_entries (
  tenant_id,session_id,entry_id,parent_entry_id,entry_type,sequence,payload,is_leaf_marker
) VALUES ($1::uuid,$2::uuid,$3,$4,'message',$5,$6::jsonb,false)
ON CONFLICT (tenant_id,session_id,entry_id) DO NOTHING
      `.trim(),
      [input.tenantId, input.sessionId, item.row.message_id, parentId, sequence, JSON.stringify(payload)],
    );
  };
  let beforeParent: string | null = null;
  for (const item of before) {
    await insert(item, beforeSequence++, beforeParent);
    beforeParent = item.row.message_id;
  }
  if (beforeParent && bounds[0]?.root_id) {
    await executor.execute(
      `UPDATE session_entries
       SET parent_entry_id=$4,payload=jsonb_set(payload,'{parentId}',to_jsonb($4::text),true)
       WHERE tenant_id=$1::uuid AND session_id=$2::uuid AND entry_id=$3 AND parent_entry_id IS NULL`,
      [input.tenantId, input.sessionId, bounds[0].root_id, beforeParent],
    );
  }
  let afterParent = bounds[0]?.leaf_id ?? null;
  for (const item of after) {
    await insert(item, afterSequence++, afterParent);
    afterParent = item.row.message_id;
  }
  const leaf = after.at(-1)?.row.message_id;
  if (leaf) {
    await executor.execute(
      "UPDATE session_entries SET is_leaf_marker=(entry_id=$3) WHERE tenant_id=$1::uuid AND session_id=$2::uuid AND (is_leaf_marker=true OR entry_id=$3)",
      [input.tenantId, input.sessionId, leaf],
    );
  }
}

function projectMessageParts(parts: Array<{ type: string; content: unknown }>): Array<Record<string, unknown>> {
  return parts.flatMap((part): Array<Record<string, unknown>> => {
    const value = recordValue(part.content);
    if (part.type === "tool-call") {
      return [{ type: "toolCall", id: stringValue(value?.toolCallId) ?? stringValue(value?.id) ?? randomUUID(), name: stringValue(value?.name) ?? "tool", arguments: value?.arguments ?? {} }];
    }
    if (part.type === "tool-result") {
      return [{ type: "text", text: durableProjectionText(value?.output ?? part.content) }];
    }
    if (part.type === "attachment") return [{ type: "attachment", content: part.content }];
    if (part.type === "image" || part.type === "browser-screenshot") {
      return [{ type: "text", text: `[Image artifact: ${stringValue(value?.title) ?? stringValue(value?.name) ?? stringValue(value?.fileId) ?? "image"}]` }];
    }
    if (part.type === "reasoning") return [{ type: "thinking", thinking: durableProjectionText(part.content) }];
    return [{ type: "text", text: durableProjectionText(part.content) }];
  });
}

function durableProjectionText(value: unknown): string {
  if (typeof value === "string") return value;
  const object = recordValue(value);
  for (const field of ["text", "content", "code", "message", "summary"]) {
    if (typeof object?.[field] === "string") return object[field] as string;
  }
  return JSON.stringify(value ?? "");
}

function findLatestProviderUsageIndex(entries: readonly DurableContextEntryRow[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (providerContextTokens(entries[index]?.payload) !== null) return index;
  }
  return -1;
}

function providerContextTokens(payload: unknown): number | null {
  const message = recordValue(recordValue(payload)?.message);
  const stopReason = stringValue(message?.stopReason);
  if (!message || stopReason === "aborted" || stopReason === "error") return null;
  const usage = recordValue(message.usage);
  if (!usage) return null;
  const total = nonnegativeNumber(usage.totalTokens);
  if (total !== null && total > 0) return Math.round(total);
  const input = nonnegativeNumber(usage.input) ?? 0;
  const output = nonnegativeNumber(usage.output) ?? 0;
  return input + output > 0 ? Math.round(input + output) : null;
}

function estimateDurableEntriesTokens(entries: readonly DurableContextEntryRow[]): number {
  return entries.reduce((total, entry) => total + estimateDurableEntryTokens(entry.payload), 0);
}

function estimateDurableEntryTokens(payload: unknown): number {
  const message = recordValue(recordValue(payload)?.message);
  const role = stringValue(message?.role);
  if (!message || !role) return 0;
  if (role !== "user" && role !== "assistant" && role !== "toolResult") return 0;
  const content = message.content;
  if (typeof content === "string") return estimateCharacterTokens(content.length);
  if (!Array.isArray(content)) return 0;
  let characters = 0;
  let imageTokens = 0;
  for (const rawPart of content) {
    const part = recordValue(rawPart);
    if (!part) continue;
    const text = typeof part.text === "string"
      ? part.text
      : typeof part.thinking === "string"
        ? part.thinking
        : "";
    characters += text.length;
    if (part.type === "toolCall") {
      characters += (stringValue(part.name)?.length ?? 0) + jsonLength(part.arguments);
    } else if (part.type === "image") {
      imageTokens += 1_200;
    }
  }
  return estimateCharacterTokens(characters) + imageTokens;
}

function estimatePendingContextTokens(
  input: string | undefined,
  attachments: readonly AttachmentInput[] = [],
): number {
  let tokens = estimateCharacterTokens(input?.length ?? 0);
  for (const attachment of attachments) {
    tokens += estimateCharacterTokens(
      attachment.name.length
        + attachment.mediaType.length
        + (attachment.textContent?.length ?? 0),
    );
    if (attachment.mediaType.startsWith("image/")) tokens += 1_200;
  }
  return tokens;
}

function estimateJsonTokens(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (Array.isArray(value) && value.length === 0) return 0;
  if (typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 0) return 0;
  return estimateCharacterTokens(jsonLength(value));
}

function estimateCharacterTokens(characters: number): number {
  return Number.isFinite(characters) && characters > 0 ? Math.ceil(characters / 4) : 0;
}

function jsonLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return String(value).length;
  }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => jsonValuesEqual(value, right[index]));
  }
  const leftRecord = recordValue(left);
  const rightRecord = recordValue(right);
  if (!leftRecord || !rightRecord) return false;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) =>
      key === rightKeys[index]
      && jsonValuesEqual(leftRecord[key], rightRecord[key])
    );
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nonnegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function isTerminalRunState(state: string): boolean {
  return state === "completed" || state === "failed" || state === "cancelled" || state === "recovery_required";
}

function activeLeafId(row: { entry_id: string; entry_type: string; payload: unknown } | undefined): string | null {
  if (!row) return null;
  if (row.entry_type !== "leaf") return row.entry_id;
  const payload = row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
    ? row.payload as Record<string, unknown>
    : {};
  return typeof payload.targetId === "string" ? payload.targetId : null;
}

export function eventCursor(runId: string, sequence: number): string {
  return `${runId}:${sequence}`;
}

export function parseEventCursor(value: string | null | undefined): { runId: string; sequence: number } | null {
  if (!value) return null;
  const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):(\d+)$/i.exec(value.trim());
  if (!match) return null;
  return { runId: match[1]!, sequence: Number(match[2]) };
}

async function reconcileTerminalUsage(
  executor: SqlExecutor,
  tenantId: string,
  runId: string,
  status: "completed" | "failed" | "cancelled" | "recovery_required",
): Promise<void> {
  const runs = await executor.query<{
    user_id: string;
    workspace_id: string;
    task_id: string;
    session_id: string;
    runtime_request: unknown;
  }>(
    `SELECT user_id,workspace_id,task_id,session_id,runtime_request
     FROM turn_runs WHERE tenant_id=$1::uuid AND id=$2::uuid`,
    [tenantId, runId],
  );
  const run = runs[0];
  if (!run) return;
  const runtimeRequest = recordValue(run.runtime_request) ?? {};
  const requestId = stringValue(runtimeRequest.requestId) ?? `turn_${runId}`;
  const usage = await executor.query<{
    input_tokens: number | string;
    output_tokens: number | string;
    cache_read_tokens: number | string;
    cache_write_tokens: number | string;
    cache_creation_tokens_1h: number | string;
    cache_creation_tokens_5m: number | string;
    usage_event_count: number | string;
    priced_event_count: number | string;
    exact_cost_micros: string;
  }>(
    `
SELECT
  COALESCE(SUM(CASE WHEN event_type='usage' THEN (payload->>'inputTokens')::bigint ELSE 0 END),0) AS input_tokens,
  COALESCE(SUM(CASE WHEN event_type='usage' THEN (payload->>'outputTokens')::bigint ELSE 0 END),0) AS output_tokens,
  COALESCE(SUM(CASE WHEN event_type='usage' THEN COALESCE((payload->>'cacheReadTokens')::bigint,0) ELSE 0 END),0) AS cache_read_tokens,
  COALESCE(SUM(CASE WHEN event_type='usage' THEN COALESCE((payload->>'cacheWriteTokens')::bigint,0) ELSE 0 END),0) AS cache_write_tokens,
  COALESCE(SUM(CASE WHEN event_type='usage' THEN COALESCE((payload->>'cacheCreationTokens1h')::bigint,0) ELSE 0 END),0) AS cache_creation_tokens_1h,
  COALESCE(SUM(CASE WHEN event_type='usage' THEN COALESCE((payload->>'cacheCreationTokens5m')::bigint,0) ELSE 0 END),0) AS cache_creation_tokens_5m,
  COUNT(*) FILTER (WHERE event_type='usage') AS usage_event_count,
  COUNT(*) FILTER (WHERE event_type='usage' AND payload ? 'costRawMicros') AS priced_event_count,
  COALESCE(SUM(CASE WHEN event_type='usage' THEN COALESCE((payload->>'costRawMicros')::bigint,0) ELSE 0 END),0)::text AS exact_cost_micros
FROM turn_events
WHERE tenant_id=$1::uuid AND run_id=$2::uuid
    `.trim(),
    [tenantId, runId],
  );
  const totals = usage[0] ?? {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cache_creation_tokens_1h: 0,
    cache_creation_tokens_5m: 0,
    usage_event_count: 0,
    priced_event_count: 0,
    exact_cost_micros: "0",
  };
  const lastUsageRows = await executor.query<{ payload: unknown }>(
    `SELECT payload FROM turn_events
     WHERE tenant_id=$1::uuid AND run_id=$2::uuid AND event_type='usage'
     ORDER BY sequence DESC LIMIT 1`,
    [tenantId, runId],
  );
  const lastUsage = recordValue(lastUsageRows[0]?.payload) ?? {};
  const reservations = await executor.query<{
    id: string;
    user_id: string | null;
    department_id: string | null;
    reserved_micros: string;
  }>(
    `SELECT id,user_id,department_id,reserved_micros::text
     FROM budget_reservations
     WHERE tenant_id=$1::uuid AND request_id=$2 LIMIT 1`,
    [tenantId, requestId],
  );
  const hasUsage = Number(totals.usage_event_count) > 0;
  const exactPricing = hasUsage
    && Number(totals.priced_event_count) === Number(totals.usage_event_count);
  const actualMicros = exactPricing
    ? totals.exact_cost_micros
    : hasUsage
      ? reservations[0]?.reserved_micros ?? "0"
      : "0";
  const provider = stringValue(lastUsage.servedProvider)
    ?? stringValue(runtimeRequest.providerId);
  const model = stringValue(lastUsage.servedModel)
    ?? stringValue(lastUsage.model)
    ?? stringValue(runtimeRequest.model);
  await executor.execute(
    `
INSERT INTO usage_events (
  tenant_id,request_id,idempotency_key,source,user_id,workspace_id,task_id,
  session_id,feature,provider,model,tokens_in,tokens_out,tokens_cached,
  cache_read_tokens,cache_write_tokens,cache_creation_tokens_1h,cache_creation_tokens_5m,
  cache_eligible,cache_provider,cache_key_hash,prompt_manifest_hash,cache_miss_reason,
  cost_raw_micros,cost_billed_micros,status,metadata
) VALUES (
  $1::uuid,$2,$3,'router',$4::uuid,$5::uuid,$6::uuid,$7::uuid,
  'model.turn',$8,$9,$10,$11,$12,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
  $21,$22,$23::jsonb
)
ON CONFLICT (tenant_id,request_id) DO NOTHING
    `.trim(),
    [
      tenantId,
      requestId,
      `${runId}:usage`,
      run.user_id,
      run.workspace_id,
      run.task_id,
      run.session_id,
      provider,
      model,
      Number(totals.input_tokens),
      Number(totals.output_tokens),
      Number(totals.cache_read_tokens),
      Number(totals.cache_write_tokens),
      Number(totals.cache_creation_tokens_1h),
      Number(totals.cache_creation_tokens_5m),
      lastUsage.cacheEligible === true,
      stringValue(lastUsage.cacheProvider),
      stringValue(lastUsage.cacheKeyHash),
      stringValue(lastUsage.promptManifestHash),
      stringValue(lastUsage.cacheMissReason),
      actualMicros,
      status,
      JSON.stringify({ runId, durable: true, terminalStatus: status, exactPricing }),
    ],
  );
  const settled = await executor.query<{
    id: string;
    user_id: string | null;
    department_id: string | null;
    reserved_micros: string;
  }>(
    `
UPDATE budget_reservations
SET actual_cost_micros=$5::bigint,status='reconciled',
    provider=COALESCE($3,provider),model=COALESCE($4,model),updated_at=now()
WHERE tenant_id=$1::uuid AND request_id=$2 AND status='reserved'
RETURNING id,user_id,department_id,reserved_micros::text
    `.trim(),
    [tenantId, requestId, provider, model, actualMicros],
  );
  if (!settled[0]) return;
  const adjustment = safeBigInt(actualMicros) - safeBigInt(settled[0].reserved_micros);
  const scopes = [
    { type: "org", id: tenantId },
    ...(settled[0].department_id ? [{ type: "department", id: settled[0].department_id }] : []),
    ...(settled[0].user_id ? [{ type: "user", id: settled[0].user_id }] : []),
  ];
  for (const scope of scopes) {
    const prior = await executor.query<{ total: string }>(
      `SELECT COALESCE(SUM(amount_micros),0)::text AS total
       FROM credit_ledger_entries
       WHERE tenant_id=$1::uuid AND scope_type=$2 AND scope_id=$3`,
      [tenantId, scope.type, scope.id],
    );
    const balanceAfter = safeBigInt(prior[0]?.total) + adjustment;
    await executor.execute(
      `
INSERT INTO credit_ledger_entries (
  tenant_id,scope_type,scope_id,reservation_id,request_id,kind,
  amount_micros,balance_after_micros,metadata
) VALUES ($1::uuid,$2,$3,$4::uuid,$5,'reconcile',$6,$7,$8::jsonb)
ON CONFLICT (tenant_id,request_id,scope_type,scope_id,kind) DO NOTHING
      `.trim(),
      [
        tenantId,
        scope.type,
        scope.id,
        settled[0].id,
        requestId,
        adjustment.toString(),
        balanceAfter.toString(),
        JSON.stringify({ runId, terminalStatus: status, exactPricing }),
      ],
    );
  }
}

function safeBigInt(value: unknown): bigint {
  try {
    return BigInt(typeof value === "string" || typeof value === "number" ? value : 0);
  } catch {
    return 0n;
  }
}

async function lockAdmissionIntent(
  executor: SqlExecutor,
  tenantId: string,
  requestId: string,
): Promise<AdmissionIntentRow | null> {
  const rows = await executor.query<AdmissionIntentRow>(
    `
SELECT session_id,operation_fingerprint,state,run_id,preparation_lease_expires_at
FROM turn_admission_intents
WHERE tenant_id=$1::uuid AND request_id=$2
FOR UPDATE
    `.trim(),
    [tenantId, requestId],
  );
  return rows[0] ?? null;
}

function validateAdmissionIntent(
  intent: AdmissionIntentRow,
  input: { sessionId: string; operationFingerprint: string },
): void {
  if (intent.session_id !== input.sessionId) {
    throw new ConflictException("This operation key belongs to another session");
  }
  if (intent.operation_fingerprint && intent.operation_fingerprint !== input.operationFingerprint) {
    throw new ConflictException("This operation key was already used with a different turn request");
  }
}

function cancelledAdmissionConflict(): ConflictException {
  return new ConflictException({
    code: "turn_submission_cancelled",
    message: "This turn submission was cancelled before admission.",
  });
}

async function appendDurableEvents(
  executor: SqlExecutor,
  tenantId: string,
  runId: string,
  sessionId: string,
  events: readonly AgentStreamEvent[],
): Promise<void> {
  if (events.length === 0) return;
  const rows = await executor.query<{ sequence: number | string }>(
    "SELECT COALESCE(MAX(sequence),0) AS sequence FROM turn_events WHERE tenant_id=$1::uuid AND run_id=$2::uuid",
    [tenantId, runId],
  );
  let sequence = Number(rows[0]?.sequence ?? 0);
  for (const event of events) {
    const parsed = AgentStreamEventSchema.parse(event);
    sequence += 1;
    await executor.execute(
      parsed.kind === "turn.end"
        ? `
INSERT INTO turn_events (tenant_id,run_id,session_id,sequence,event_type,payload)
SELECT $1::uuid,$2::uuid,$3::uuid,$4,$5,$6::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM turn_events
  WHERE tenant_id=$1::uuid AND run_id=$2::uuid AND event_type='turn.end'
)
        `.trim()
        : `
INSERT INTO turn_events (tenant_id,run_id,session_id,sequence,event_type,payload)
VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::jsonb)
        `.trim(),
      [tenantId, runId, sessionId, sequence, parsed.kind, JSON.stringify(parsed)],
    );
  }
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function configuredSandboxWorkspacePath(): string {
  const normalized = (process.env.BERRY_SANDBOX_CWD?.trim() || "/workspace")
    .replaceAll("\\", "/")
    .replace(/\/+$/, "");
  return normalized || "/workspace";
}

function safeQuestionAttachmentName(value: string): string {
  const basename = value.trim().replaceAll("\\", "/").split("/").at(-1) ?? "";
  const normalized = basename
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^\p{L}\p{N}._() -]+/gu, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  return normalized && normalized !== "." && normalized !== ".." ? normalized : "attachment";
}

function questionAnswersEquivalent(
  prior: Record<string, unknown> | null,
  submitted: Record<string, unknown>,
): boolean {
  const identity = (value: Record<string, unknown> | null, includeMessageId: boolean) => {
    const root = value ?? {};
    return {
    answer: typeof root.answer === "string" ? root.answer : "",
    ...(includeMessageId ? { answerMessageId: root.answerMessageId ?? null } : {}),
    selectedOptions: stringArray(root.selectedOptions),
    answers: Array.isArray(root.answers)
      ? root.answers.map((candidate) => {
          const item = recordValue(candidate) ?? {};
          return {
            question: typeof item.question === "string" ? item.question : "",
            answer: typeof item.answer === "string" ? item.answer : "",
            selectedOptions: stringArray(item.selectedOptions),
            skipped: item.skipped === true,
            attachments: Array.isArray(item.attachments)
              ? item.attachments.map((attachment) => {
                  const file = recordValue(attachment) ?? {};
                  return typeof file.fileId === "string" ? file.fileId : "";
                })
              : [],
          };
        })
      : [],
    };
  };
  const includeMessageId = submitted.answerMessageId !== null
    && submitted.answerMessageId !== undefined;
  return jsonValuesEqual(identity(prior, includeMessageId), identity(submitted, includeMessageId));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

interface EventRow {
  run_id: string;
  sequence: number | string;
  payload: unknown;
  created_at: Date | string;
}

interface ApprovalRow {
  id: string;
  task_id: string | null;
  tool_call_id: string | null;
  kind: string;
  status: string;
  request: unknown;
  created_at: Date | string;
  decided_at: Date | string | null;
}

interface DurableContextEntryRow {
  entry_id: string;
  sequence: number | string;
  payload: unknown;
  run_id: string | null;
}

interface DurableContextCheckpointRow {
  checkpoint: unknown;
  covered_entry_end: string | null;
}

interface DurableContextRunRow {
  id: string;
  state: string;
  prompt_manifest: unknown;
  grounding_context: unknown;
  partial_chars: number | string;
}
