import { ConflictException, Inject, Injectable } from "@nestjs/common";
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

export const DURABLE_TURN_RUNNER_ENABLED = Symbol("DURABLE_TURN_RUNNER_ENABLED");

export interface DurableTurnAdmission {
  tenantId: string;
  userId: string;
  workspaceId: string;
  taskId: string;
  sessionId: string;
  requestId: string;
  requestMessageId?: string;
  input: string;
  attachments?: AttachmentInput[];
  continueInterruptedTurn?: boolean;
  runtimeRequest: Record<string, unknown>;
  groundingContext: JsonValue;
  promptManifest?: JsonValue;
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

@Injectable()
export class DurableTurnService {
  constructor(
    @Inject(CloudDatabaseService) private readonly database: CloudDatabaseService,
    @Inject(DURABLE_TURN_RUNNER_ENABLED) readonly enabled: boolean,
  ) {}

  async admit(input: DurableTurnAdmission): Promise<{ runId: string; sessionId: string }> {
    if (!this.enabled) throw new Error("Durable turn runner is disabled");
    return this.database.withTenant(input.tenantId, async (executor) => {
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

      const requestMessageId = input.continueInterruptedTurn
        ? await continuableRequestMessageId(executor, input)
        : await ensureUserMessage(executor, input);
      if (!input.continueInterruptedTurn) {
        await ensureInputFileAssociations(executor, input, requestMessageId);
        await ensureUserJournalEntry(executor, input, requestMessageId);
      }
      const runId = randomUUID();
      const admittedStepId = randomUUID();
      await executor.execute(
        `
INSERT INTO turn_runs (
  id,tenant_id,user_id,workspace_id,task_id,session_id,request_message_id,
  state,next_action,runtime_request,grounding_context,prompt_manifest
) VALUES (
  $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::uuid,
  'queued','Assemble durable context',$8::jsonb,$9::jsonb,$10::jsonb
)
        `.trim(),
        [
          runId,
          input.tenantId,
          input.userId,
          input.workspaceId,
          input.taskId,
          input.sessionId,
          requestMessageId,
          JSON.stringify({ ...input.runtimeRequest, requestId: input.requestId, input: input.input }),
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
        [input.tenantId, runId, input.sessionId, JSON.stringify({ kind: "turn.start", turnId: runId })],
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
      return { runId, sessionId: input.sessionId };
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
      }>(
        `
SELECT id,state,lease_owner,waiting_reason,next_action,error FROM turn_runs
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
        bufferedEvents,
        lastEventId: maximum === null ? null : `${run.id}:${maximum}`,
        replayOnly: false,
        owner: run.lease_owner,
        runState: run.state,
        waitingReason: run.waiting_reason,
        nextAction: run.next_action,
        error: run.error,
      });
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
WITH latest_checkpoint AS (
  SELECT covered_entry_end
  FROM session_checkpoints
  WHERE tenant_id=$1::uuid AND session_id=$2::uuid AND kind='rolling'
    AND schema_version=2 AND validation_status IN ('valid','repaired','fallback')
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
SELECT checkpoint,covered_entry_end
FROM session_checkpoints
WHERE tenant_id=$1::uuid AND session_id=$2::uuid AND kind='rolling'
  AND schema_version=2 AND validation_status IN ('valid','repaired','fallback')
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
  SELECT id,created_at FROM turn_runs
  WHERE tenant_id=$1::uuid AND id=$3::uuid AND session_id=$2::uuid
)
SELECT e.run_id,e.sequence,e.payload,e.created_at
FROM turn_events e
JOIN turn_runs r ON r.tenant_id=e.tenant_id AND r.id=e.run_id
WHERE e.tenant_id=$1::uuid AND e.session_id=$2::uuid
  AND EXISTS (SELECT 1 FROM cursor_run)
  AND (
    r.created_at > (SELECT created_at FROM cursor_run)
    OR (
      r.created_at = (SELECT created_at FROM cursor_run)
      AND r.id > (SELECT id FROM cursor_run)
    )
    OR (e.run_id=$3::uuid AND e.sequence>$4)
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

  async cancel(tenantId: string, sessionId: string): Promise<boolean> {
    if (!this.enabled) return false;
    return this.database.withTenant(tenantId, async (executor) => {
      const run = async (transaction: SqlExecutor): Promise<boolean> => {
        const rows = await transaction.query<{
          id: string;
          task_id: string;
          request_message_id: string | null;
        }>(
          `
SELECT id,task_id,request_message_id
FROM turn_runs
WHERE tenant_id=$1::uuid AND session_id=$2::uuid
  AND state NOT IN ('completed','failed','cancelled','recovery_required')
ORDER BY created_at DESC
LIMIT 1
FOR UPDATE
          `.trim(),
          [tenantId, sessionId],
        );
        const active = rows[0];
        if (!active) return false;
        await projectInterruptedTools(transaction, tenantId, sessionId, active.task_id, active.id);
        await projectTerminalAssistant(transaction, tenantId, sessionId, active.task_id, active.id, "cancelled");
        await transaction.execute(
          `
UPDATE turn_steps
SET state='cancelled',completed_at=now(),updated_at=now()
WHERE tenant_id=$1::uuid AND run_id=$2::uuid
  AND state IN ('pending','running','waiting')
          `.trim(),
          [tenantId, active.id],
        );
        await transaction.execute(
          `
UPDATE tool_calls
SET status='cancelled',completed_at=now(),updated_at=now()
WHERE tenant_id=$1::uuid AND run_id=$2::uuid
  AND status IN ('pending','waiting-for-approval','running')
          `.trim(),
          [tenantId, active.id],
        );
        await transaction.execute(
          "UPDATE approvals SET status='expired',decided_at=now() WHERE tenant_id=$1::uuid AND run_id=$2::uuid AND status='pending'",
          [tenantId, active.id],
        );
        await transaction.execute(
          "UPDATE turn_questions SET status='cancelled' WHERE tenant_id=$1::uuid AND run_id=$2::uuid AND status='pending'",
          [tenantId, active.id],
        );
        await appendDurableEvents(transaction, tenantId, active.id, sessionId, [
          { kind: "turn.end", turnId: active.id, status: "cancelled" },
        ]);
        await transaction.execute(
          `
UPDATE turn_runs
SET state='cancelled',cancelled_at=now(),completed_at=now(),
    lease_owner=NULL,lease_expires_at=NULL,waiting_reason=NULL,next_action=NULL,
    version=version+1,updated_at=now()
WHERE tenant_id=$1::uuid AND id=$2::uuid
          `.trim(),
          [tenantId, active.id],
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
          "UPDATE tasks SET status='cancelled',updated_at=now() WHERE tenant_id=$1::uuid AND id=$2::uuid",
          [tenantId, active.task_id],
        );
        await transaction.execute(
          `
UPDATE budget_reservations b
SET actual_cost_micros=0,status='reconciled',updated_at=now()
FROM turn_runs r
WHERE r.tenant_id=$1::uuid AND r.id=$2::uuid
  AND b.tenant_id=r.tenant_id
  AND b.request_id=COALESCE(r.runtime_request->>'requestId','turn_' || r.id::text)
  AND b.status='reserved'
          `.trim(),
          [tenantId, active.id],
        );
        await transaction.execute(
          `
UPDATE sessions
SET runtime_metadata=runtime_metadata || jsonb_build_object(
      'activeRunId',$2::text,
      'lastRunState','cancelled',
      'leafId',COALESCE((
        SELECT entry_id FROM session_entries
        WHERE tenant_id=$1::uuid AND session_id=$3::uuid AND is_leaf_marker=true
        ORDER BY sequence DESC LIMIT 1
      ),runtime_metadata->>'leafId')
    ),
    updated_at=now()
WHERE tenant_id=$1::uuid AND id=$3::uuid
          `.trim(),
          [tenantId, active.id, sessionId],
        );
        return true;
      };
      return executor.transaction ? executor.transaction(run) : run(executor);
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
          status: string;
        }>(
          `
SELECT a.id,a.run_id,a.step_id,a.tool_call_id,r.session_id,a.status
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
    lease_owner=NULL,lease_expires_at=NULL,updated_at=now()
WHERE tenant_id=$1::uuid AND id=$2::uuid AND state='waiting'
          `.trim(),
          [tenantId, approval.run_id],
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
          run_state: string;
          task_id: string;
          created_at: Date | string;
        }>(
          `
SELECT q.id,q.run_id,q.session_id,q.step_id,q.tool_call_id,q.question,q.status,
       q.created_at,r.state AS run_state,r.task_id
FROM turn_questions q
JOIN turn_runs r ON r.tenant_id=q.tenant_id AND r.id=q.run_id
JOIN tasks t ON t.tenant_id=r.tenant_id AND t.id=r.task_id
WHERE q.tenant_id=$1::uuid AND q.id=$2::uuid AND t.user_id=$3::uuid
FOR UPDATE OF q,r
          `.trim(),
          [tenantId, questionId, userId],
        );
        const question = rows[0];
        if (!question || question.status !== "pending" || question.run_state !== "waiting" || !question.step_id) {
          return false;
        }
        const normalizedAnswer = {
          answer: answer.answer,
          selectedOptions: [...(answer.selectedOptions ?? [])],
          ...(answer.answers ? {
            answers: answer.answers.map((item) => ({
              question: item.question,
              answer: item.answer,
              selectedOptions: [...(item.selectedOptions ?? [])],
              skipped: item.skipped === true,
            })),
          } : {}),
        };
        const responseText = answer.answers?.length
          ? answer.answers
              .map((item) => `${item.question}: ${item.skipped ? "Skipped" : item.answer}`)
              .join("\n")
          : answer.answer;
        await transaction.execute(
          `
UPDATE turn_questions
SET status='answered',answer=$3::jsonb,answered_at=now()
WHERE tenant_id=$1::uuid AND id=$2::uuid AND status='pending'
          `.trim(),
          [tenantId, questionId, JSON.stringify(normalizedAnswer)],
        );

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
        if (answer.answerMessageId && !messageRows[0]) {
          throw new Error("The submitted question answer message does not belong to this session");
        }
        const answerMessageId = messageRows[0]?.id ?? randomUUID();
        if (!messageRows[0]) {
          await transaction.execute(
            `
INSERT INTO messages (id,tenant_id,session_id,task_id,role,status)
VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'user','complete')
            `.trim(),
            [answerMessageId, tenantId, question.session_id, question.task_id],
          );
          await transaction.execute(
            `
INSERT INTO message_parts (tenant_id,message_id,type,content,ordinal)
VALUES ($1::uuid,$2::uuid,'text',$3::jsonb,0)
            `.trim(),
            [tenantId, answerMessageId, JSON.stringify(responseText)],
          );
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
        const toolResult = {
          questions: answer.answers ?? [{ question: question.question, answer: answer.answer, selectedOptions: answer.selectedOptions ?? [] }],
          ...normalizedAnswer,
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
    lease_owner=NULL,lease_expires_at=NULL,version=version+1,updated_at=now()
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
       tc.input AS tool_call_input,r.version
FROM turn_runs r JOIN tasks t ON t.tenant_id=r.tenant_id AND t.id=r.task_id
LEFT JOIN LATERAL (
  SELECT id,step_id,tool_name,input FROM tool_calls
  WHERE tenant_id=r.tenant_id AND run_id=r.id AND status='failed'
  ORDER BY created_at DESC LIMIT 1
) tc ON true
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
          "UPDATE turn_runs SET state='cancelled',cancelled_at=now(),completed_at=now(),updated_at=now() WHERE tenant_id=$1::uuid AND id=$2::uuid",
          [tenantId, runId],
        );
        await executor.execute(
          "UPDATE tasks SET status='cancelled',updated_at=now() WHERE tenant_id=$1::uuid AND id=$2::uuid",
          [tenantId, recovered.task_id],
        );
        await executor.execute(
          `
UPDATE budget_reservations b
SET actual_cost_micros=0,status='reconciled',updated_at=now()
FROM turn_runs r
WHERE r.tenant_id=$1::uuid AND r.id=$2::uuid
  AND b.tenant_id=r.tenant_id
  AND b.request_id=COALESCE(r.runtime_request->>'requestId','turn_' || r.id::text)
  AND b.status='reserved'
          `.trim(),
          [tenantId, runId],
        );
        await appendDurableEvents(executor, tenantId, runId, recovered.session_id, [
          { kind: "turn.end", turnId: runId, status: "cancelled" },
        ]);
        return true;
      }
      if (action === "mark-complete") {
        if (!recovered.tool_call_id || !recovered.tool_call_step_id || !recovered.tool_call_name) {
          throw new Error("Recovery-required run has no failed tool call to mark complete");
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
    completed_at=NULL,updated_at=now()
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
WHERE tenant_id=$1::uuid AND run_id=$2::uuid AND state='recovery_required'
          `.trim(),
          [tenantId, runId],
        );
        await executor.execute(
          `
UPDATE tool_calls SET status='pending',completed_at=NULL,updated_at=now()
WHERE tenant_id=$1::uuid AND run_id=$2::uuid AND status='failed'
          `.trim(),
          [tenantId, runId],
        );
        await executor.execute(
          `
UPDATE turn_runs
SET state='executing_tool',error=NULL,next_action='Retry tool after explicit operator confirmation',
    completed_at=NULL,version=version+1,updated_at=now()
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
    if (!requested[0]) throw new Error("The submitted user message does not belong to this session");
    return requested[0].id;
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
    [input.tenantId, input.sessionId, input.input],
  );
  if (rows[0]) return rows[0].id;
  const id = randomUUID();
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
    [input.tenantId, id, JSON.stringify(input.input)],
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
          status: "failed",
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
  const authorized = await executor.query<{ id: string }>(
    `
SELECT id
FROM files
WHERE tenant_id=$1::uuid AND owner_user_id=$2::uuid
  AND id=ANY($3::uuid[]) AND deleted_at IS NULL
    `.trim(),
    [input.tenantId, input.userId, fileIds],
  );
  if (authorized.length !== fileIds.length) {
    throw new Error("One or more input files are unavailable or not owned by the authenticated user");
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
      `
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
