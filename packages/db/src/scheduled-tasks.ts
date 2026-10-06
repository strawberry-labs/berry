import { createHash, randomUUID } from "node:crypto";
import {
  ScheduledTaskCreateSchema, ScheduledTaskSchema, ScheduledTaskUpdateSchema, ScheduledTaskRunSchema,
  type ScheduledTask, type ScheduledTaskCreate, type ScheduledTaskUpdate, type ScheduledTaskRun,
} from "@berry/shared";
import { normalizeTaskSchedule, nextTaskScheduleRun } from "./task-schedule.ts";

export interface ScheduledTaskSqlExecutor {
  execute(sql: string, params?: readonly unknown[]): Promise<unknown>;
  query<T>(sql: string, params?: readonly unknown[]): Promise<readonly T[]>;
  transaction?<T>(callback: (executor: ScheduledTaskSqlExecutor) => Promise<T>): Promise<T>;
}
export type ScheduledTaskScope = { tenantId: string; userId: string };
export type ScheduledRunClaim = {
  id: string; userId: string; sessionId: string; workspaceId: string; email: string; name: string;
  input: { prompt: string; timezone: string; reasoning: ScheduledTask["reasoning"] };
};
type ScheduleRow = {
  id: string; tenant_id: string; user_id: string; workspace_id: string; source_task_id: string | null;
  name: string; prompt: string; schedule: ScheduledTask["schedule"]; state: ScheduledTask["state"];
  next_run_at: Date | string | null; last_run_at: Date | string | null; last_error: string | null;
  model_provider_id: string | null; model: string | null; reasoning: ScheduledTask["reasoning"];
  created_at: Date | string; updated_at: Date | string;
};
type RunRow = {
  id: string; schedule_id: string; scheduled_at: Date | string; trigger: ScheduledTaskRun["trigger"];
  state: ScheduledTaskRun["state"]; task_id: string | null; session_id: string | null; turn_id: string | null;
  turn_state: string | null; error: string | null; created_at: Date | string; finished_at: Date | string | null;
};
const TERMINAL_STATES = "'completed','failed','cancelled','recovery_required'";

/** All claims, run creation, and schedule changes are serialized in tenant-scoped transactions. */
export class SqlScheduledTaskRepository {
  constructor(private readonly executor: ScheduledTaskSqlExecutor) {}

  private async scoped<T>(tenantId: string, callback: (sql: ScheduledTaskSqlExecutor) => Promise<T>): Promise<T> {
    if (!this.executor.transaction) throw new Error("Scheduled tasks require a transactional database");
    return this.executor.transaction(async (sql) => {
      await sql.execute("SELECT berry_set_tenant_id($1::uuid)", [tenantId]);
      return callback(sql);
    });
  }

  private async clock(sql: ScheduledTaskSqlExecutor): Promise<Date> {
    const [row] = await sql.query<{ now: Date | string }>("SELECT clock_timestamp() AS now");
    if (!row) throw new Error("Database clock is unavailable");
    return new Date(row.now);
  }

  private async operation<T>(sql: ScheduledTaskSqlExecutor, scope: ScheduledTaskScope, key: string | undefined, action: string, input: unknown, callback: () => Promise<T>): Promise<T> {
    if (!key) return callback();
    const fingerprint = createHash("sha256").update(JSON.stringify({ action, input })).digest("hex");
    await sql.execute("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`schedule-op:${scope.tenantId}:${scope.userId}:${key}`]);
    const [prior] = await sql.query<{ fingerprint: string; result: T }>(
      "SELECT fingerprint,result FROM scheduled_task_operations WHERE tenant_id=$1::uuid AND user_id=$2::uuid AND operation_id=$3::uuid",
      [scope.tenantId, scope.userId, key],
    );
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new Error("This operation ID was already used for a different schedule change");
      return prior.result;
    }
    const result = await callback();
    await sql.execute("INSERT INTO scheduled_task_operations (tenant_id,user_id,operation_id,fingerprint,result) VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5::jsonb)",
      [scope.tenantId, scope.userId, key, fingerprint, JSON.stringify(result)]);
    return result;
  }

  async list(scope: ScheduledTaskScope): Promise<ScheduledTask[]> {
    return this.scoped(scope.tenantId, async (sql) => (await sql.query<ScheduleRow>(
      "SELECT * FROM scheduled_tasks WHERE tenant_id=$1::uuid AND user_id=$2::uuid AND deleted_at IS NULL ORDER BY created_at DESC,id DESC LIMIT 100",
      [scope.tenantId, scope.userId],
    )).map(scheduleFromRow));
  }

  private async owned(sql: ScheduledTaskSqlExecutor, scope: ScheduledTaskScope, id: string): Promise<ScheduleRow> {
    const [row] = await sql.query<ScheduleRow>("SELECT * FROM scheduled_tasks WHERE tenant_id=$1::uuid AND user_id=$2::uuid AND id=$3::uuid AND deleted_at IS NULL FOR UPDATE",
      [scope.tenantId, scope.userId, id]);
    if (!row) throw new Error("Scheduled task not found");
    return row;
  }

  private async activeOwner(sql: ScheduledTaskSqlExecutor, scope: ScheduledTaskScope, workspaceId: string): Promise<boolean> {
    const [row] = await sql.query<{ allowed: boolean }>(`SELECT EXISTS (
      SELECT 1 FROM workspaces w JOIN tenant_memberships m ON m.tenant_id=w.tenant_id AND m.user_id=w.owner_id
      JOIN users u ON u.id=m.user_id JOIN tenants t ON t.id=w.tenant_id
      WHERE w.tenant_id=$1::uuid AND w.id=$3::uuid AND w.owner_id=$2::uuid AND w.deleted_at IS NULL
        AND m.status='active' AND u.status='active' AND u.deleted_at IS NULL AND t.status='active' AND t.deleted_at IS NULL
    ) AS allowed`, [scope.tenantId, scope.userId, workspaceId]);
    return row?.allowed === true;
  }

  async create(scope: ScheduledTaskScope, value: ScheduledTaskCreate & { workspaceId: string }, sourceTaskId: string | null = null): Promise<ScheduledTask> {
    const input = ScheduledTaskCreateSchema.parse(value);
    return this.scoped(scope.tenantId, (sql) => this.operation(sql, scope, input.operationId, "create", { ...input, sourceTaskId }, async () => {
      if (!await this.activeOwner(sql, scope, value.workspaceId)) throw new Error("Workspace or active membership not found");
      if (sourceTaskId) {
        const [source] = await sql.query<{ id: string }>("SELECT id FROM tasks WHERE tenant_id=$1::uuid AND user_id=$2::uuid AND workspace_id=$3::uuid AND id=$4::uuid AND deleted_at IS NULL",
          [scope.tenantId, scope.userId, value.workspaceId, sourceTaskId]);
        if (!source) throw new Error("Source task not found");
      }
      await sql.execute("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`schedule-limit:${scope.tenantId}:${scope.userId}`]);
      const [count] = await sql.query<{ count: string }>("SELECT count(*)::text AS count FROM scheduled_tasks WHERE tenant_id=$1::uuid AND user_id=$2::uuid AND deleted_at IS NULL", [scope.tenantId, scope.userId]);
      if (Number(count?.count ?? 0) >= 100) throw new Error("You can keep up to 100 scheduled tasks. Delete one before creating another.");
      const now = await this.clock(sql);
      const schedule = normalizeTaskSchedule(input.schedule, now);
      const [row] = await sql.query<ScheduleRow>(`INSERT INTO scheduled_tasks
        (id,tenant_id,user_id,workspace_id,source_task_id,name,prompt,schedule,next_run_at,model_provider_id,model,reasoning,creation_key)
        VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8::jsonb,$9,$10,$11,$12,$13) RETURNING *`,
        [randomUUID(), scope.tenantId, scope.userId, value.workspaceId, sourceTaskId, input.name, input.prompt, JSON.stringify(schedule), nextTaskScheduleRun(schedule, now), input.modelProviderId ?? null, input.model ?? null, input.reasoning ?? "off", input.operationId ?? randomUUID()]);
      if (!row) throw new Error("Failed to create scheduled task");
      return scheduleFromRow(row);
    }));
  }

  async update(scope: ScheduledTaskScope, id: string, value: ScheduledTaskUpdate, operationId?: string): Promise<ScheduledTask> {
    const input = ScheduledTaskUpdateSchema.parse(value);
    return this.scoped(scope.tenantId, (sql) => this.operation(sql, scope, operationId, "update", { id, input }, async () => {
      const prior = await this.owned(sql, scope, id);
      const now = await this.clock(sql);
      const schedule = input.schedule ? normalizeTaskSchedule(input.schedule, now) : prior.schedule;
      const state = input.state ?? (input.schedule ? "active" : prior.state);
      if (state === "active" && !await this.activeOwner(sql, scope, prior.workspace_id)) throw new Error("Workspace or active membership not found");
      const rescheduled = input.schedule !== undefined || (state === "active" && prior.state !== "active");
      if (rescheduled && schedule.kind === "once" && new Date(schedule.runAt) <= now) throw new Error("Choose a future time before restarting a one-time task");
      const next = state === "active" ? (rescheduled ? nextTaskScheduleRun(schedule, now) : prior.next_run_at) : null;
      const [row] = await sql.query<ScheduleRow>(`UPDATE scheduled_tasks SET name=$4,prompt=$5,schedule=$6::jsonb,state=$7,next_run_at=$8,
        model_provider_id=$9,model=$10,reasoning=$11,last_error=NULL,updated_at=now()
        WHERE tenant_id=$1::uuid AND user_id=$2::uuid AND id=$3::uuid RETURNING *`,
        [scope.tenantId, scope.userId, id, input.name ?? prior.name, input.prompt ?? prior.prompt, JSON.stringify(schedule), state, next,
          input.modelProviderId === undefined ? prior.model_provider_id : input.modelProviderId,
          input.model === undefined ? prior.model : input.model, input.reasoning ?? prior.reasoning]);
      if (state !== "active" || rescheduled) await this.cancelPending(sql, scope.tenantId, id, "Schedule changed before dispatch");
      if (!row) throw new Error("Scheduled task not found");
      return scheduleFromRow(row);
    }));
  }

  async remove(scope: ScheduledTaskScope, id: string, operationId?: string): Promise<{ removed: boolean }> {
    return this.scoped(scope.tenantId, (sql) => this.operation(sql, scope, operationId, "delete", { id }, async () => {
      await this.owned(sql, scope, id);
      await sql.execute("UPDATE scheduled_tasks SET state='paused',next_run_at=NULL,deleted_at=now(),updated_at=now() WHERE tenant_id=$1::uuid AND id=$2::uuid", [scope.tenantId, id]);
      await this.cancelPending(sql, scope.tenantId, id, "Schedule deleted before dispatch");
      return { removed: true };
    }));
  }

  private async cancelPending(sql: ScheduledTaskSqlExecutor, tenantId: string, id: string, reason: string): Promise<void> {
    await sql.execute(`WITH cancelled AS (
      UPDATE scheduled_task_runs SET state='skipped',error=$3,finished_at=now() WHERE tenant_id=$1::uuid AND schedule_id=$2::uuid AND state='pending' RETURNING task_id
    ) UPDATE tasks SET status='cancelled',updated_at=now() WHERE tenant_id=$1::uuid AND id IN (SELECT task_id FROM cancelled)`, [tenantId, id, reason]);
  }

  async history(scope: ScheduledTaskScope, id: string, limit = 30): Promise<ScheduledTaskRun[]> {
    return this.scoped(scope.tenantId, async (sql) => {
      await this.owned(sql, scope, id);
      return (await sql.query<RunRow>(`SELECT r.*,t.state AS turn_state,
        COALESCE(r.finished_at,t.completed_at) AS finished_at
        FROM scheduled_task_runs r LEFT JOIN turn_runs t ON t.tenant_id=r.tenant_id AND t.id=r.turn_id
        WHERE r.tenant_id=$1::uuid AND r.schedule_id=$2::uuid ORDER BY r.created_at DESC,r.id DESC LIMIT $3`, [scope.tenantId, id, Math.min(Math.max(limit, 1), 100)])).map(runFromRow);
    });
  }

  private async busy(sql: ScheduledTaskSqlExecutor, tenantId: string, id: string): Promise<boolean> {
    const [row] = await sql.query<{ busy: boolean }>(`SELECT EXISTS (
      SELECT 1 FROM scheduled_task_runs r LEFT JOIN turn_runs t ON t.tenant_id=r.tenant_id AND t.id=r.turn_id
      WHERE r.tenant_id=$1::uuid AND r.schedule_id=$2::uuid
        AND (r.state IN ('pending','dispatching') OR (r.state='admitted' AND t.state NOT IN (${TERMINAL_STATES})))
    ) AS busy`, [tenantId, id]);
    return row?.busy === true;
  }

  private async enqueue(sql: ScheduledTaskSqlExecutor, row: ScheduleRow, at: Date, trigger: "scheduled" | "manual", key: string, skipReason: string | null = null): Promise<ScheduledTaskRun> {
    const input = { prompt: row.prompt, timezone: row.schedule.timezone, reasoning: row.reasoning };
    const id = randomUUID();
    const [run] = await sql.query<RunRow>(`INSERT INTO scheduled_task_runs (id,tenant_id,schedule_id,scheduled_at,trigger,occurrence_key,state,input,error,finished_at)
      VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8::jsonb,$9,CASE WHEN $9::text IS NULL THEN NULL ELSE now() END)
      ON CONFLICT (tenant_id,schedule_id,occurrence_key) DO NOTHING RETURNING *,NULL::text AS turn_state`,
      [id, row.tenant_id, row.id, at, trigger, key, skipReason ? "skipped" : "pending", JSON.stringify(input), skipReason]);
    if (!run) throw new Error("This schedule occurrence has already been queued");
    if (!skipReason) {
      const taskId = randomUUID(), sessionId = randomUUID();
      await sql.execute(`INSERT INTO tasks (id,tenant_id,workspace_id,user_id,title,status,conversation_kind,unread_at)
        VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,'queued','chat',now())`,
        [taskId, row.tenant_id, row.workspace_id, row.user_id, row.name]);
      await sql.execute(`INSERT INTO sessions (id,tenant_id,task_id,user_id,status,model_provider_id,model,permission_mode)
        VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'active',$5,$6,'full-access')`,
        [sessionId, row.tenant_id, taskId, row.user_id, row.model_provider_id, row.model]);
      await sql.execute("UPDATE tasks SET active_session_id=$3::uuid WHERE tenant_id=$1::uuid AND id=$2::uuid", [row.tenant_id, taskId, sessionId]);
      await sql.execute("UPDATE scheduled_task_runs SET task_id=$3::uuid,session_id=$4::uuid WHERE tenant_id=$1::uuid AND id=$2::uuid", [row.tenant_id, id, taskId, sessionId]);
      run.task_id = taskId; run.session_id = sessionId;
      await sql.execute("UPDATE scheduled_tasks SET last_run_at=now(),last_error=NULL,updated_at=now() WHERE tenant_id=$1::uuid AND id=$2::uuid", [row.tenant_id, row.id]);
    }
    return runFromRow(run);
  }

  async runNow(scope: ScheduledTaskScope, id: string, operationId: string): Promise<ScheduledTaskRun> {
    return this.scoped(scope.tenantId, (sql) => this.operation(sql, scope, operationId, "run", { id }, async () => {
      const row = await this.owned(sql, scope, id);
      if (!await this.activeOwner(sql, scope, row.workspace_id)) throw new Error("Workspace or active membership not found");
      if (await this.busy(sql, scope.tenantId, id)) throw new Error("This scheduled task already has a run in progress");
      return this.enqueue(sql, row, await this.clock(sql), "manual", `manual:${operationId}`);
    }));
  }

  async enqueueDue(tenantId: string): Promise<number> {
    return this.scoped(tenantId, async (sql) => {
      const now = await this.clock(sql);
      const rows = await sql.query<ScheduleRow>(`SELECT * FROM scheduled_tasks
        WHERE tenant_id=$1::uuid AND state='active' AND deleted_at IS NULL AND next_run_at <= $2
        ORDER BY next_run_at,id LIMIT 20 FOR UPDATE SKIP LOCKED`, [tenantId, now]);
      for (const row of rows) {
        if (!await this.activeOwner(sql, { tenantId, userId: row.user_id }, row.workspace_id)) {
          await sql.execute("UPDATE scheduled_tasks SET state='paused',next_run_at=NULL,last_error='Workspace or active membership is unavailable',updated_at=now() WHERE tenant_id=$1::uuid AND id=$2::uuid", [tenantId, row.id]);
          continue;
        }
        const next = row.schedule.kind === "once" ? null : nextTaskScheduleRun(row.schedule, now);
        const at = new Date(row.next_run_at!);
        const skip = await this.busy(sql, tenantId, row.id) ? "Previous run is still in progress" : null;
        await this.enqueue(sql, row, at, "scheduled", `scheduled:${at.toISOString()}`, skip);
        // Coalesce downtime to one due run; never replay an unbounded backlog.
        await sql.execute("UPDATE scheduled_tasks SET next_run_at=$3,state=$4,updated_at=now() WHERE tenant_id=$1::uuid AND id=$2::uuid", [tenantId, row.id, next, next ? "active" : "completed"]);
      }
      return rows.length;
    });
  }

  async claimPending(tenantId: string, owner: string): Promise<ScheduledRunClaim[]> {
    return this.scoped(tenantId, async (sql) => {
      // Repair a crash between successful admission and ledger settlement first.
      await sql.execute(`UPDATE scheduled_task_runs r SET state='admitted',turn_id=t.id,lease_owner=NULL,lease_expires_at=NULL,error=NULL
        FROM turn_runs t WHERE r.tenant_id=$1::uuid AND t.tenant_id=r.tenant_id AND t.request_id='model_' || r.id::text
          AND r.state IN ('pending','dispatching') AND t.session_id=r.session_id
          AND t.task_id=r.task_id AND t.user_id=(SELECT user_id FROM scheduled_tasks s WHERE s.tenant_id=r.tenant_id AND s.id=r.schedule_id)`, [tenantId]);
      const rows = await sql.query<{ id: string; user_id: string; session_id: string; workspace_id: string; email: string; name: string; input: ScheduledRunClaim["input"] }>(`WITH claims AS (
        SELECT r.id FROM scheduled_task_runs r JOIN scheduled_tasks s ON s.tenant_id=r.tenant_id AND s.id=r.schedule_id
        WHERE r.tenant_id=$1::uuid AND r.state IN ('pending','dispatching') AND r.retry_at<=now()
          AND (r.lease_expires_at IS NULL OR r.lease_expires_at<=now())
        ORDER BY r.created_at LIMIT 10 FOR UPDATE OF r SKIP LOCKED
      ), claimed AS (
        UPDATE scheduled_task_runs r SET state='dispatching',attempts=attempts+1,lease_owner=$2,lease_expires_at=now()+interval '5 minutes'
        FROM claims WHERE r.id=claims.id AND r.tenant_id=$1::uuid RETURNING r.*
      ) SELECT r.id,s.user_id,r.session_id,s.workspace_id,u.email,u.name,r.input FROM claimed r
        JOIN scheduled_tasks s ON s.tenant_id=r.tenant_id AND s.id=r.schedule_id JOIN users u ON u.id=s.user_id`, [tenantId, owner]);
      return rows.map((row) => ({ id: row.id, userId: row.user_id, sessionId: row.session_id, workspaceId: row.workspace_id, email: row.email, name: row.name, input: row.input }));
    });
  }

  async authorizeClaim(tenantId: string, id: string, owner: string): Promise<boolean> {
    return this.scoped(tenantId, async (sql) => {
      const [row] = await sql.query<{ user_id: string; workspace_id: string }>(`SELECT s.user_id,s.workspace_id FROM scheduled_task_runs r
        JOIN scheduled_tasks s ON s.tenant_id=r.tenant_id AND s.id=r.schedule_id
        WHERE r.tenant_id=$1::uuid AND r.id=$2::uuid AND r.state='dispatching' AND r.lease_owner=$3 AND r.lease_expires_at>now()`, [tenantId, id, owner]);
      return Boolean(row && await this.activeOwner(sql, { tenantId, userId: row.user_id }, row.workspace_id));
    });
  }

  async admitted(tenantId: string, id: string, owner: string, turnId: string): Promise<void> {
    return this.scoped(tenantId, async (sql) => {
      await sql.execute("UPDATE scheduled_task_runs SET state='admitted',turn_id=$4::uuid,error=NULL,lease_owner=NULL,lease_expires_at=NULL WHERE tenant_id=$1::uuid AND id=$2::uuid AND lease_owner=$3 AND state='dispatching'", [tenantId, id, owner, turnId]);
    });
  }

  async failed(tenantId: string, id: string, owner: string, message: string, retryable: boolean): Promise<void> {
    return this.scoped(tenantId, async (sql) => {
      // Use the same schedule-before-run lock order as pause/delete/reschedule.
      // Concurrent user changes must not deadlock admission failure settlement.
      const [schedule] = await sql.query<{ schedule_id: string }>("SELECT schedule_id FROM scheduled_task_runs WHERE tenant_id=$1::uuid AND id=$2::uuid", [tenantId, id]);
      if (!schedule) return;
      await sql.query("SELECT id FROM scheduled_tasks WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE", [tenantId, schedule.schedule_id]);
      const [row] = await sql.query<{ schedule_id: string; task_id: string; attempts: number; state: string; deleted_at: Date | null }>(`SELECT r.schedule_id,r.task_id,r.attempts,s.state,s.deleted_at FROM scheduled_task_runs r
        JOIN scheduled_tasks s ON s.tenant_id=r.tenant_id AND s.id=r.schedule_id
        WHERE r.tenant_id=$1::uuid AND r.id=$2::uuid AND r.lease_owner=$3 AND r.state='dispatching' FOR UPDATE OF r`, [tenantId, id, owner]);
      if (!row) return;
      // Admission can succeed even if its response or ledger settlement fails.
      // Recover that durable turn before deciding to retry or fail its chat.
      const recovered = await sql.query<{ id: string }>(`UPDATE scheduled_task_runs r SET state='admitted',turn_id=t.id,
        lease_owner=NULL,lease_expires_at=NULL,error=NULL FROM turn_runs t
        WHERE r.tenant_id=$1::uuid AND r.id=$2::uuid AND r.lease_owner=$3 AND r.state='dispatching'
          AND t.tenant_id=r.tenant_id AND t.request_id='model_' || r.id::text AND t.session_id=r.session_id
          AND t.task_id=r.task_id AND t.user_id=(SELECT user_id FROM scheduled_tasks s WHERE s.tenant_id=r.tenant_id AND s.id=r.schedule_id)
        RETURNING r.id`, [tenantId, id, owner]);
      if (recovered.length) return;
      const retry = retryable && row.attempts < 3 && !row.deleted_at && row.state !== "paused";
      const error = message.slice(0, 1000);
      await sql.execute(`UPDATE scheduled_task_runs SET state=$4,error=$5,lease_owner=NULL,lease_expires_at=NULL,
        retry_at=now()+interval '30 seconds',finished_at=CASE WHEN $4='failed' THEN now() ELSE NULL END
        WHERE tenant_id=$1::uuid AND id=$2::uuid AND lease_owner=$3`, [tenantId, id, owner, retry ? "pending" : "failed", error]);
      await sql.execute("UPDATE scheduled_tasks SET last_error=$3,updated_at=now() WHERE tenant_id=$1::uuid AND id=$2::uuid", [tenantId, row.schedule_id, error]);
      if (!retry) await sql.execute("UPDATE tasks SET status='failed',updated_at=now() WHERE tenant_id=$1::uuid AND id=$2::uuid", [tenantId, row.task_id]);
    });
  }
}

function iso(value: Date | string): string { return new Date(value).toISOString(); }
function nullableIso(value: Date | string | null): string | null { return value === null ? null : iso(value); }
function scheduleFromRow(row: ScheduleRow): ScheduledTask {
  return ScheduledTaskSchema.parse({ id: row.id, tenantId: row.tenant_id, userId: row.user_id, workspaceId: row.workspace_id, sourceTaskId: row.source_task_id,
    name: row.name, prompt: row.prompt, schedule: row.schedule, state: row.state, nextRunAt: nullableIso(row.next_run_at), lastRunAt: nullableIso(row.last_run_at), lastError: row.last_error,
    modelProviderId: row.model_provider_id, model: row.model, reasoning: row.reasoning, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) });
}
function runFromRow(row: RunRow): ScheduledTaskRun {
  return ScheduledTaskRunSchema.parse({ id: row.id, scheduleId: row.schedule_id, scheduledAt: iso(row.scheduled_at), trigger: row.trigger, state: row.state,
    taskId: row.task_id, sessionId: row.session_id, turnId: row.turn_id, turnState: row.turn_state ?? null, error: row.error,
    createdAt: iso(row.created_at), finishedAt: nullableIso(row.finished_at) });
}
