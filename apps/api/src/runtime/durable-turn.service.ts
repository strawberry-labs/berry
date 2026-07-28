import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  AgentStreamEventSchema,
  messageAttachmentContent,
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
  input: string;
  attachments?: AttachmentInput[];
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
      const existing = await executor.query<{ id: string }>(
        `
SELECT id FROM turn_runs
WHERE tenant_id=$1::uuid AND session_id=$2::uuid
  AND state NOT IN ('completed','failed','cancelled','recovery_required')
ORDER BY created_at DESC
LIMIT 1
        `.trim(),
        [input.tenantId, input.sessionId],
      );
      if (existing[0]) return { runId: existing[0].id, sessionId: input.sessionId };

      const requestMessageId = await ensureUserMessage(executor, input);
      await ensureInputFileAssociations(executor, input, requestMessageId);
      await ensureUserJournalEntry(executor, input, requestMessageId);
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
WHERE tenant_id=$1::uuid AND id=$2::uuid;
UPDATE sessions
SET runtime_metadata=runtime_metadata || jsonb_build_object(
      'activeRunId',$3::text,'lastRunState','queued','leafId',$4::text
    ),
    updated_at=now()
WHERE tenant_id=$1::uuid AND id=$5::uuid
        `.trim(),
        [input.tenantId, input.taskId, runId, requestMessageId, input.sessionId],
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
      const events = await executor.query<{ sequence: number; payload: unknown }>(
        `
SELECT sequence,payload FROM turn_events
WHERE tenant_id=$1::uuid AND run_id=$2::uuid
ORDER BY sequence DESC
LIMIT 256
        `.trim(),
        [tenantId, run.id],
      );
      return TurnStateSchema.parse({
        active: !["completed", "failed", "cancelled", "recovery_required"].includes(run.state),
        turnId: run.id,
        bufferedEvents: [...events].reverse().map((row) => AgentStreamEventSchema.parse(row.payload)),
        lastEventId: events[0] ? `${run.id}:${events[0].sequence}` : null,
        replayOnly: false,
        owner: run.lease_owner,
        runState: run.state,
        waitingReason: run.waiting_reason,
        nextAction: run.next_action,
        error: run.error,
      });
    });
  }

  async eventsAfter(
    tenantId: string,
    sessionId: string,
    cursor?: string | null,
    limit = 500,
  ): Promise<DurableEventEnvelope[]> {
    return this.database.withTenant(tenantId, async (executor) => {
      const parsed = parseEventCursor(cursor);
      const rows = await executor.query<EventRow>(
        parsed
          ? `
WITH cursor_event AS (
  SELECT created_at FROM turn_events
  WHERE tenant_id=$1::uuid AND run_id=$3::uuid AND sequence=$4
)
SELECT e.run_id,e.sequence,e.payload,e.created_at
FROM turn_events e
WHERE e.tenant_id=$1::uuid AND e.session_id=$2::uuid
  AND (
    e.created_at > COALESCE((SELECT created_at FROM cursor_event),'-infinity'::timestamptz)
    OR (e.run_id=$3::uuid AND e.sequence>$4)
  )
ORDER BY e.created_at ASC,e.run_id ASC,e.sequence ASC
LIMIT $5
            `.trim()
          : `
SELECT run_id,sequence,payload,created_at
FROM turn_events
WHERE tenant_id=$1::uuid AND session_id=$2::uuid
ORDER BY created_at ASC,run_id ASC,sequence ASC
LIMIT $5
            `.trim(),
        parsed
          ? [tenantId, sessionId, parsed.runId, parsed.sequence, limit]
          : [tenantId, sessionId, null, 0, limit],
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
      const rows = await executor.query<{ id: string }>(
        `
UPDATE turn_runs
SET cancelled_at=now(),lease_expires_at=now(),updated_at=now()
WHERE tenant_id=$1::uuid AND session_id=$2::uuid
  AND state NOT IN ('completed','failed','cancelled','recovery_required')
RETURNING id
        `.trim(),
        [tenantId, sessionId],
      );
      const run = rows[0];
      if (!run) return false;
      await executor.execute(
        `
INSERT INTO runtime_outbox (tenant_id,event_type,aggregate_id,dedupe_key,payload)
VALUES ($1::uuid,'turn.execute',$2,$3,$4::jsonb)
ON CONFLICT (tenant_id,dedupe_key) DO NOTHING
        `.trim(),
        [tenantId, run.id, `${run.id}:wake:cancel`, JSON.stringify({ tenantId, runId: run.id, reason: "continue" })],
      );
      return true;
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
SET state=$4,error=CASE WHEN $4='failed' THEN 'Approval denied' ELSE NULL END,updated_at=now()
WHERE tenant_id=$1::uuid AND id=$2::uuid AND run_id=$3::uuid
            `.trim(),
            [tenantId, approval.step_id, approval.run_id, approved ? "pending" : "failed"],
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
                kind: "tool.end" as const,
                toolCallId: approval.tool_call_id ?? approval.step_id ?? approval.id,
                status: "denied" as const,
                summary: decision.reason ?? "Approval denied",
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
          `
SELECT m.id
FROM messages m
WHERE m.tenant_id=$1::uuid AND m.session_id=$2::uuid AND m.role='user'
  AND m.created_at >= $3::timestamptz
ORDER BY m.created_at DESC
LIMIT 1
          `.trim(),
          [tenantId, question.session_id, iso(question.created_at)],
        );
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
      }>(
        `
SELECT r.id,r.session_id,r.task_id,tc.id AS tool_call_id
FROM turn_runs r JOIN tasks t ON t.tenant_id=r.tenant_id AND t.id=r.task_id
LEFT JOIN LATERAL (
  SELECT id FROM tool_calls
  WHERE tenant_id=r.tenant_id AND run_id=r.id AND status='failed'
  ORDER BY created_at DESC LIMIT 1
) tc ON true
WHERE r.tenant_id=$1::uuid AND r.id=$2::uuid AND t.user_id=$3::uuid
  AND r.state='recovery_required'
FOR UPDATE
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
        await executor.execute(
          `
UPDATE turn_steps SET state='completed',completed_at=now(),error=NULL,updated_at=now()
WHERE tenant_id=$1::uuid AND run_id=$2::uuid AND state='recovery_required';
UPDATE tool_calls SET status='completed',completed_at=now(),updated_at=now()
WHERE tenant_id=$1::uuid AND run_id=$2::uuid AND status='failed';
UPDATE turn_runs
SET state='calling_model',error=NULL,next_action='Continue after operator-confirmed tool completion',
    completed_at=NULL,updated_at=now()
WHERE tenant_id=$1::uuid AND id=$2::uuid
          `.trim(),
          [tenantId, runId],
        );
      } else {
        await executor.execute(
          `
UPDATE turn_steps SET state='pending',error=NULL,updated_at=now()
WHERE tenant_id=$1::uuid AND run_id=$2::uuid AND state='recovery_required';
UPDATE tool_calls SET status='pending',completed_at=NULL,updated_at=now()
WHERE tenant_id=$1::uuid AND run_id=$2::uuid AND status='failed';
UPDATE turn_runs
SET state='executing_tool',error=NULL,next_action='Retry tool after explicit operator confirmation',
    completed_at=NULL,updated_at=now()
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
          `${runId}:operator:${action}`,
          JSON.stringify({ tenantId, runId, reason: "operator-recovery" }),
        ],
      );
      return true;
    });
  }
}

async function ensureUserMessage(
  executor: SqlExecutor,
  input: DurableTurnAdmission,
): Promise<string> {
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
