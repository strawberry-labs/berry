import type { TaskTitleRepository } from "./title-gen.js";
import type { UsageEventRecord, UsageRollupRecord, UsageRollupRepository } from "./usage-rollups.js";
import { AlertRuleSchema, type AlertRule } from "@berry/shared";
import type { ReportRunJobPayload } from "./jobs.js";
import type { ManagementJobRepository } from "./reporting-alerts.js";

export interface SqlExecutor {
  execute(sql: string, params?: readonly unknown[]): Promise<unknown>;
  query<T>(sql: string, params?: readonly unknown[]): Promise<readonly T[]>;
  transaction?<T>(callback: (executor: SqlExecutor) => Promise<T>): Promise<T>;
}

export class SqlTaskTitleRepository implements TaskTitleRepository {
  constructor(private readonly executor: SqlExecutor) {}

  async updateTaskTitle(input: { tenantId: string; taskId: string; title: string }): Promise<void> {
    await this.executor.execute(
      `
UPDATE tasks
SET title = $3, updated_at = now()
WHERE tenant_id = $1::uuid AND id = $2
      `.trim(),
      [input.tenantId, input.taskId, input.title],
    );
  }
}

export class SqlUsageRollupRepository implements UsageRollupRepository {
  constructor(private readonly executor: SqlExecutor) {}

  async listUsageEvents(input: { tenantId: string; from: Date; to: Date }): Promise<UsageEventRecord[]> {
    const rows = await this.executor.query<UsageEventRow>(
      `
SELECT tenant_id, user_id, department_id, workspace_id, agent_id, sandbox_id,
       feature, provider, model, status, tokens_in, tokens_out, tokens_cached,
       cost_raw_micros, cost_billed_micros, latency_ms, ttft_ms, ts
FROM usage_events
WHERE tenant_id = $1::uuid AND ts >= $2 AND ts < $3
ORDER BY ts ASC
      `.trim(),
      [input.tenantId, input.from.toISOString(), input.to.toISOString()],
    );
    return rows.map((row) => ({
      tenantId: row.tenant_id,
      userId: row.user_id,
      departmentId: row.department_id,
      workspaceId: row.workspace_id,
      agentId: row.agent_id,
      sandboxId: row.sandbox_id,
      feature: row.feature,
      provider: row.provider,
      model: row.model,
      status: row.status,
      tokensIn: row.tokens_in,
      tokensOut: row.tokens_out,
      tokensCached: row.tokens_cached,
      costRawMicros: row.cost_raw_micros,
      costBilledMicros: row.cost_billed_micros,
      latencyMs: row.latency_ms,
      ttftMs: row.ttft_ms,
      ts: row.ts instanceof Date ? row.ts : new Date(row.ts),
    }));
  }

  async upsertUsageRollups(rollups: UsageRollupRecord[]): Promise<void> {
    const run = async (executor: SqlExecutor): Promise<void> => {
      for (const rollup of rollups) {
        await executor.execute(
          `
INSERT INTO usage_rollups (
  tenant_id, bucket_start, bucket_end, granularity, feature, provider, model, status,
  user_id, department_id, workspace_id, agent_id, sandbox_id,
  request_count, tokens_in, tokens_out, tokens_cached, cost_raw_micros, cost_billed_micros,
  latency_ms_total, latency_ms_count, ttft_ms_total, ttft_ms_count,
  source_event_min_ts, source_event_max_ts, metadata, updated_at
) VALUES (
  $1::uuid, $2, $3, $4, $5, $6, $7, $8,
  $9::uuid, $10::uuid, $11::uuid, $12, $13,
  $14, $15, $16, $17, $18, $19,
  $20, $21, $22, $23,
  $24, $25, $26::jsonb, now()
)
ON CONFLICT (tenant_id, bucket_start, granularity, feature, provider, model, status, user_id, department_id, workspace_id, agent_id, sandbox_id)
DO UPDATE SET
  bucket_end = excluded.bucket_end,
  request_count = excluded.request_count,
  tokens_in = excluded.tokens_in,
  tokens_out = excluded.tokens_out,
  tokens_cached = excluded.tokens_cached,
  cost_raw_micros = excluded.cost_raw_micros,
  cost_billed_micros = excluded.cost_billed_micros,
  latency_ms_total = excluded.latency_ms_total,
  latency_ms_count = excluded.latency_ms_count,
  ttft_ms_total = excluded.ttft_ms_total,
  ttft_ms_count = excluded.ttft_ms_count,
  source_event_min_ts = excluded.source_event_min_ts,
  source_event_max_ts = excluded.source_event_max_ts,
  metadata = excluded.metadata,
  updated_at = now()
          `.trim(),
          [
            rollup.tenantId,
            rollup.bucketStart.toISOString(),
            rollup.bucketEnd.toISOString(),
            rollup.granularity,
            rollup.feature,
            rollup.provider,
            rollup.model,
            rollup.status,
            rollup.userId,
            rollup.departmentId,
            rollup.workspaceId,
            rollup.agentId,
            rollup.sandboxId,
            rollup.requestCount,
            rollup.tokensIn,
            rollup.tokensOut,
            rollup.tokensCached,
            rollup.costRawMicros,
            rollup.costBilledMicros,
            rollup.latencyMsTotal,
            rollup.latencyMsCount,
            rollup.ttftMsTotal,
            rollup.ttftMsCount,
            rollup.sourceEventMinTs.toISOString(),
            rollup.sourceEventMaxTs.toISOString(),
            JSON.stringify(rollup.metadata),
          ],
        );
      }
    };
    if (this.executor.transaction) {
      await this.executor.transaction(run);
      return;
    }
    await run(this.executor);
  }
}

export class SqlManagementJobRepository implements ManagementJobRepository {
  constructor(private readonly executor:SqlExecutor){}
  async runReport(input:ReportRunJobPayload){const existing=await this.executor.query<{id:string;status:string}>("SELECT id,status FROM report_runs WHERE tenant_id=$1::uuid AND schedule_id=$2::uuid AND window_key=$3",[input.tenantId,input.scheduleId,input.windowKey]);if(existing[0])return{...existing[0],duplicate:true};const rows=await this.executor.query<{id:string;status:string}>(`INSERT INTO report_runs(tenant_id,schedule_id,window_key,status,started_at) VALUES($1::uuid,$2::uuid,$3,'running',now()) ON CONFLICT(tenant_id,schedule_id,window_key) DO UPDATE SET window_key=excluded.window_key RETURNING id,status`,[input.tenantId,input.scheduleId,input.windowKey]);const id=rows[0]!.id;await this.executor.execute("UPDATE report_runs SET status='delivered',artifact_ref=$3,completed_at=now() WHERE tenant_id=$1::uuid AND id=$2::uuid",[input.tenantId,id,`report://${input.tenantId}/${id}.html`]);await this.executor.execute("UPDATE report_schedules SET last_run_at=now(),next_run_at=CASE cadence WHEN 'daily' THEN now()+interval '1 day' WHEN 'weekly' THEN now()+interval '1 week' ELSE now()+interval '1 month' END,updated_at=now() WHERE tenant_id=$1::uuid AND id=$2::uuid",[input.tenantId,input.scheduleId]);return{id,status:"delivered",duplicate:false};}
  async listAlertRules(t:string){const rows=await this.executor.query<any>("SELECT * FROM alert_rules WHERE tenant_id=$1::uuid AND enabled=true",[t]);return rows.map((r:any)=>AlertRuleSchema.parse({id:r.id,tenantId:r.tenant_id,name:r.name,signal:r.signal,enabled:r.enabled,scopeType:r.scope_type??undefined,scopeId:r.scope_id??undefined,threshold:Number(r.threshold),windowMinutes:r.window_minutes,destinationIds:r.destination_ids,createdAt:isoDate(r.created_at),updatedAt:isoDate(r.updated_at)}));}
  async observedValue(t:string,rule:AlertRule,from:Date,to:Date){const expression=rule.signal==="error_rate"?"count(*) FILTER(WHERE status NOT IN ('completed','success','succeeded'))::float/NULLIF(count(*),0)":rule.signal==="latency"?"avg(latency_ms)":rule.signal==="request_volume"||rule.signal==="blocked_requests"?"count(*)":"COALESCE(sum(cost_billed_micros),0)::float";const table=rule.signal==="blocked_requests"?"budget_reservations":"usage_events";const timestamp=table==="usage_events"?"ts":"created_at";const rows=await this.executor.query<{observed:number|null}>(`SELECT ${expression} observed FROM ${table} WHERE tenant_id=$1::uuid AND ${timestamp}>=$2 AND ${timestamp}<$3`,[t,from.toISOString(),to.toISOString()]);return{observed:Number(rows[0]?.observed??0),baseline:null};}
  async createAlertEvent(i:{tenantId:string;ruleId:string;windowKey:string;observed:number;baseline:number|null}){const existing=await this.executor.query<{id:string}>("SELECT id FROM alert_events WHERE tenant_id=$1::uuid AND rule_id=$2::uuid AND window_key=$3",[i.tenantId,i.ruleId,i.windowKey]);if(existing[0])return{id:existing[0].id,duplicate:true};const rows=await this.executor.query<{id:string}>("INSERT INTO alert_events(tenant_id,rule_id,window_key,observed,baseline) VALUES($1::uuid,$2::uuid,$3,$4,$5) ON CONFLICT(tenant_id,rule_id,window_key) DO UPDATE SET observed=excluded.observed RETURNING id",[i.tenantId,i.ruleId,i.windowKey,i.observed,i.baseline]);return{id:rows[0]!.id,duplicate:false};}
  async deliverAlert(i:{tenantId:string;eventId:string;destinationId:string}){const existing=await this.executor.query<{status:"delivered"|"failed"}>("SELECT status FROM delivery_attempts WHERE tenant_id=$1::uuid AND alert_event_id=$2::uuid AND destination_id=$3::uuid ORDER BY attempt DESC LIMIT 1",[i.tenantId,i.eventId,i.destinationId]);if(existing[0]?.status==="delivered")return{status:"delivered" as const,duplicate:true};const destinations=await this.executor.query<{configured:boolean}>("SELECT configured FROM alert_destinations WHERE tenant_id=$1::uuid AND id=$2::uuid",[i.tenantId,i.destinationId]);const status=destinations[0]?.configured?"delivered" as const:"failed" as const;await this.executor.execute("INSERT INTO delivery_attempts(tenant_id,alert_event_id,destination_id,attempt,status,error) VALUES($1::uuid,$2::uuid,$3::uuid,COALESCE((SELECT max(attempt)+1 FROM delivery_attempts WHERE tenant_id=$1::uuid AND alert_event_id=$2::uuid AND destination_id=$3::uuid),1),$4,$5)",[i.tenantId,i.eventId,i.destinationId,status,status==="failed"?"Destination is not configured":null]);return{status,duplicate:false};}
}
function isoDate(value:Date|string){return value instanceof Date?value.toISOString():new Date(value).toISOString();}

interface UsageEventRow {
  tenant_id: string;
  user_id: string | null;
  department_id: string | null;
  workspace_id: string | null;
  agent_id: string | null;
  sandbox_id: string | null;
  feature: string;
  provider: string | null;
  model: string | null;
  status: string;
  tokens_in: number;
  tokens_out: number;
  tokens_cached: number;
  cost_raw_micros: string;
  cost_billed_micros: string;
  latency_ms: number | null;
  ttft_ms: number | null;
  ts: Date | string;
}
