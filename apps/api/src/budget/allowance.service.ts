import { randomUUID } from "node:crypto";
import {
  AllowanceDefaultAssignmentSchema,
  AllowanceProfileSchema,
  BlockedRequestPageSchema,
  BulkLimitResultSchema,
  EffectiveLimitSchema,
  type AllowanceDefaultAssignment,
  type AllowanceProfile,
  type BudgetLimit,
  type BulkLimitMutation,
  type BulkLimitResult,
  type EffectiveLimit,
  type QuotaMetric,
} from "@berry/shared";
import type { CloudDatabaseService, SqlExecutor } from "../db/cloud-database.service.ts";
import type { BudgetLimitInput, BudgetService } from "./budget.service.ts";

export const ALLOWANCE_SERVICE = Symbol("ALLOWANCE_SERVICE");

export type AllowanceProfileInput = Omit<AllowanceProfile, "id" | "tenantId" | "createdAt" | "updatedAt">;
export type AllowanceDefaultInput = Omit<AllowanceDefaultAssignment, "id" | "tenantId" | "createdAt" | "updatedAt">;

export interface AllowanceRepository {
  listProfiles(tenantId: string): Promise<AllowanceProfile[]>;
  upsertProfile(tenantId: string, id: string | null, input: AllowanceProfileInput): Promise<AllowanceProfile>;
  listDefaults(tenantId: string): Promise<AllowanceDefaultAssignment[]>;
  upsertDefault(tenantId: string, input: AllowanceDefaultInput): Promise<AllowanceDefaultAssignment>;
  claimBulk(tenantId: string, key: string, result?: BulkLimitResult): Promise<BulkLimitResult | null>;
  usageFor(tenantId: string, userId: string, metric: QuotaMetric, period: "day" | "month"): Promise<{ used: string; reserved: string }>;
  blocked(tenantId: string, cursor: string | undefined, limit: number): Promise<ReturnType<typeof BlockedRequestPageSchema.parse>>;
}

export class AllowanceService {
  constructor(private readonly repository: AllowanceRepository, private readonly budgets: BudgetService) {}

  listProfiles(tenantId: string) { return this.repository.listProfiles(tenantId); }
  upsertProfile(tenantId: string, id: string | null, input: AllowanceProfileInput) { return this.repository.upsertProfile(tenantId, id, input); }
  listDefaults(tenantId: string) { return this.repository.listDefaults(tenantId); }
  upsertDefault(tenantId: string, input: AllowanceDefaultInput) { return this.repository.upsertDefault(tenantId, input); }
  blocked(tenantId: string, cursor: string | undefined, limit: number) { return this.repository.blocked(tenantId, cursor, limit); }

  async bulk(tenantId: string, input: BulkLimitMutation): Promise<BulkLimitResult> {
    const previous = await this.repository.claimBulk(tenantId, input.idempotencyKey);
    if (previous) return previous;
    const profiles = new Map((await this.repository.listProfiles(tenantId)).map((profile) => [profile.id, profile]));
    const results: BulkLimitResult["results"] = [];
    for (const item of input.items) {
      const profile = item.profileId ? profiles.get(item.profileId) : undefined;
      if (item.profileId && !profile) {
        results.push({ scopeType: item.scopeType, scopeId: item.scopeId, status: "error", message: "Allowance profile not found" });
        continue;
      }
      const soft = item.softLimitMicros ?? profile?.softLimitMicros ?? null;
      const hard = item.hardLimitMicros ?? profile?.hardLimitMicros ?? null;
      if (soft !== null && hard !== null && BigInt(soft) > BigInt(hard)) {
        results.push({ scopeType: item.scopeType, scopeId: item.scopeId, status: "error", message: "Soft limit cannot exceed hard limit" });
        continue;
      }
      if (!input.dryRun) {
        await this.budgets.upsertLimit({
          tenantId, scopeType: item.scopeType, scopeId: item.scopeId, period: item.period,
          softLimitMicros: soft ?? hard ?? "0", hardLimitMicros: hard ?? "0",
          requestLimit: item.requestLimit ?? profile?.requestLimit ?? null,
          tokenLimit: item.tokenLimit ?? profile?.tokenLimit ?? null,
          sandboxMinuteLimit: item.sandboxMinuteLimit ?? profile?.sandboxMinuteLimit ?? null,
          thresholdPercentages: profile?.thresholdPercentages ?? [80, 100], status: "active",
        });
      }
      results.push({ scopeType: item.scopeType, scopeId: item.scopeId, status: input.dryRun ? "valid" : "applied", message: null });
    }
    const result = BulkLimitResultSchema.parse({ idempotencyKey: input.idempotencyKey, dryRun: input.dryRun, results });
    await this.repository.claimBulk(tenantId, input.idempotencyKey, result);
    return result;
  }

  async effective(tenantId: string, userId: string, departmentIds: string[], metric: QuotaMetric, period: "day" | "month"): Promise<EffectiveLimit> {
    const limits = (await this.budgets.listLimits(tenantId)).filter((limit) => limit.period === period && limit.status === "active" && (
      limit.scopeType === "org" || (limit.scopeType === "user" && limit.scopeId === userId) || (limit.scopeType === "department" && departmentIds.includes(limit.scopeId))
    ));
    const candidates = limits.flatMap((limit) => {
      const value = metricValue(limit, metric);
      return value === null ? [] : [{ limit, value }];
    }).sort((a, b) => decimalCompare(a.value, b.value));
    const winner = candidates[0];
    const usage = await this.repository.usageFor(tenantId, userId, metric, period);
    const consumed = decimalAdd(usage.used, usage.reserved);
    const available = winner ? decimalMaxZero(decimalSubtract(winner.value, consumed)) : null;
    const status = !winner ? "unlimited" : decimalCompare(available!, "0") <= 0 ? "blocked" : decimalCompare(consumed, decimalMultiply(winner.value, 0.8)) >= 0 ? "warning" : "healthy";
    return EffectiveLimitSchema.parse({
      tenantId, userId, metric, period, effectiveValue: winner?.value ?? null, used: usage.used, reserved: usage.reserved,
      available, projected: usage.used, status,
      trace: candidates.map(({ limit, value }) => ({ limitId: limit.id, scopeType: limit.scopeType, scopeId: limit.scopeId, metric, value, active: true, winning: limit.id === winner?.limit.id, reason: limit.id === winner?.limit.id ? "Most restrictive applicable limit" : "A more restrictive applicable limit wins" })),
    });
  }
}

export class InMemoryAllowanceRepository implements AllowanceRepository {
  readonly #profiles = new Map<string, AllowanceProfile>();
  readonly #defaults = new Map<string, AllowanceDefaultAssignment>();
  readonly #bulk = new Map<string, BulkLimitResult>();
  async listProfiles(tenantId: string) { return [...this.#profiles.values()].filter((row) => row.tenantId === tenantId); }
  async upsertProfile(tenantId: string, id: string | null, input: AllowanceProfileInput) {
    const now = new Date().toISOString();
    const current = id ? this.#profiles.get(`${tenantId}:${id}`) : undefined;
    const row = AllowanceProfileSchema.parse({ ...input, id: current?.id ?? id ?? randomUUID(), tenantId, createdAt: current?.createdAt ?? now, updatedAt: now });
    this.#profiles.set(`${tenantId}:${row.id}`, row); return row;
  }
  async listDefaults(tenantId: string) { return [...this.#defaults.values()].filter((row) => row.tenantId === tenantId); }
  async upsertDefault(tenantId: string, input: AllowanceDefaultInput) {
    const key = `${tenantId}:${input.role ?? "*"}:${input.departmentId ?? "*"}`; const now = new Date().toISOString(); const current = this.#defaults.get(key);
    const row = AllowanceDefaultAssignmentSchema.parse({ ...input, id: current?.id ?? randomUUID(), tenantId, createdAt: current?.createdAt ?? now, updatedAt: now });
    this.#defaults.set(key, row); return row;
  }
  async claimBulk(tenantId: string, key: string, result?: BulkLimitResult) { const id = `${tenantId}:${key}`; if (result) this.#bulk.set(id, result); return this.#bulk.get(id) ?? null; }
  async usageFor() { return { used: "0", reserved: "0" }; }
  async blocked() { return BlockedRequestPageSchema.parse({ items: [], nextCursor: null, hasMore: false }); }
}

export class PostgresAllowanceRepository implements AllowanceRepository {
  constructor(private readonly database: CloudDatabaseService) {}
  listProfiles(tenantId: string) { return this.database.withTenant(tenantId, async (db) => (await db.query<ProfileRow>("SELECT * FROM allowance_profiles WHERE tenant_id=$1::uuid ORDER BY name", [tenantId])).map(profileFromRow)); }
  upsertProfile(tenantId: string, id: string | null, input: AllowanceProfileInput) { return this.database.withTenant(tenantId, async (db) => {
    const rows = await db.query<ProfileRow>(`INSERT INTO allowance_profiles (id,tenant_id,name,description,period,soft_limit_micros,hard_limit_micros,request_limit,token_limit,sandbox_minute_limit,threshold_percentages,status)
      VALUES (COALESCE($2::uuid,gen_random_uuid()),$1::uuid,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
      ON CONFLICT (tenant_id,name) DO UPDATE SET description=excluded.description,period=excluded.period,soft_limit_micros=excluded.soft_limit_micros,hard_limit_micros=excluded.hard_limit_micros,request_limit=excluded.request_limit,token_limit=excluded.token_limit,sandbox_minute_limit=excluded.sandbox_minute_limit,threshold_percentages=excluded.threshold_percentages,status=excluded.status,updated_at=now() RETURNING *`,
      [tenantId,id,input.name,input.description,input.period,input.softLimitMicros,input.hardLimitMicros,input.requestLimit,input.tokenLimit,input.sandboxMinuteLimit,JSON.stringify(input.thresholdPercentages),input.status]); return profileFromRow(rows[0]!);
  }); }
  listDefaults(tenantId: string) { return this.database.withTenant(tenantId, async (db) => (await db.query<DefaultRow>("SELECT * FROM allowance_default_assignments WHERE tenant_id=$1::uuid ORDER BY priority DESC", [tenantId])).map(defaultFromRow)); }
  upsertDefault(tenantId: string, input: AllowanceDefaultInput) { return this.database.withTenant(tenantId, async (db) => { const rows = await db.query<DefaultRow>(`INSERT INTO allowance_default_assignments (tenant_id,profile_id,role,department_id,priority) VALUES ($1::uuid,$2::uuid,$3,$4::uuid,$5)
    ON CONFLICT (tenant_id,role,department_id) DO UPDATE SET profile_id=excluded.profile_id,priority=excluded.priority,updated_at=now() RETURNING *`, [tenantId,input.profileId,input.role,input.departmentId,input.priority]); return defaultFromRow(rows[0]!); }); }
  claimBulk(tenantId: string, key: string, result?: BulkLimitResult) { return this.database.withTenant(tenantId, async (db) => {
    if (result) await db.execute("INSERT INTO allowance_bulk_operations (tenant_id,idempotency_key,result) VALUES ($1::uuid,$2,$3::jsonb) ON CONFLICT (tenant_id,idempotency_key) DO NOTHING", [tenantId,key,JSON.stringify(result)]);
    const rows = await db.query<{ result: unknown }>("SELECT result FROM allowance_bulk_operations WHERE tenant_id=$1::uuid AND idempotency_key=$2", [tenantId,key]); return rows[0] ? BulkLimitResultSchema.parse(rows[0].result) : null;
  }); }
  usageFor(tenantId: string, userId: string, metric: QuotaMetric, period: "day" | "month") { return this.database.withTenant(tenantId, async (db) => usageFromDatabase(db,tenantId,userId,metric,period)); }
  blocked(tenantId: string, cursor: string | undefined, limit: number) { return this.database.withTenant(tenantId, async (db) => {
    const rows = await db.query<BlockedRow>(`SELECT id,request_id,user_id,department_id,feature,block_reason,estimated_cost_micros,created_at FROM budget_reservations WHERE tenant_id=$1::uuid AND status='blocked' AND ($2::timestamptz IS NULL OR created_at < $2::timestamptz) ORDER BY created_at DESC LIMIT $3`, [tenantId,cursor ?? null,limit+1]);
    return BlockedRequestPageSchema.parse({ items: rows.slice(0,limit).map((row) => ({ id:row.id,requestId:row.request_id,userId:row.user_id,departmentId:row.department_id,feature:row.feature,reason:row.block_reason ?? "Blocked by allowance",limitId:null,estimatedCostMicros:String(row.estimated_cost_micros),ts:iso(row.created_at) })), hasMore:rows.length>limit, nextCursor:rows.length>limit?iso(rows[limit-1]!.created_at):null });
  }); }
}

function metricValue(limit: BudgetLimit, metric: QuotaMetric): string | null { return metric === "cost" ? limit.hardLimitMicros : metric === "requests" ? numberString(limit.requestLimit) : metric === "tokens" ? numberString(limit.tokenLimit) : numberString(limit.sandboxMinuteLimit); }
function numberString(value: number | null) { return value === null ? null : String(value); }
function decimalCompare(a:string,b:string){ return Number(a)-Number(b); }
function decimalAdd(a:string,b:string){ return String(Number(a)+Number(b)); }
function decimalSubtract(a:string,b:string){ return String(Number(a)-Number(b)); }
function decimalMultiply(a:string,b:number){ return String(Number(a)*b); }
function decimalMaxZero(a:string){ return String(Math.max(0,Number(a))); }
async function usageFromDatabase(db:SqlExecutor,tenantId:string,userId:string,metric:QuotaMetric,period:"day"|"month") { const since=period==="day"?"date_trunc('day',now())":"date_trunc('month',now())"; if(metric==="cost"){ const rows=await db.query<{used:string;reserved:string}>(`SELECT COALESCE(sum(CASE WHEN status='reconciled' THEN actual_cost_micros ELSE 0 END),0)::text used,COALESCE(sum(CASE WHEN status='reserved' THEN reserved_micros ELSE 0 END),0)::text reserved FROM budget_reservations WHERE tenant_id=$1::uuid AND user_id=$2::uuid AND created_at>=${since}`,[tenantId,userId]); return rows[0]??{used:"0",reserved:"0"}; } const column=metric==="tokens"?"tokens_in + tokens_out":metric==="sandbox_minutes"?"COALESCE((sandbox_usage->>'minutes')::numeric,0)":"1"; const rows=await db.query<{used:string}>(`SELECT COALESCE(sum(${column}),0)::text used FROM usage_events WHERE tenant_id=$1::uuid AND user_id=$2::uuid AND ts>=${since}`,[tenantId,userId]); return {used:rows[0]?.used??"0",reserved:"0"}; }
function profileFromRow(row:ProfileRow){return AllowanceProfileSchema.parse({id:row.id,tenantId:row.tenant_id,name:row.name,description:row.description,period:row.period,softLimitMicros:row.soft_limit_micros===null?null:String(row.soft_limit_micros),hardLimitMicros:row.hard_limit_micros===null?null:String(row.hard_limit_micros),requestLimit:row.request_limit,tokenLimit:row.token_limit,sandboxMinuteLimit:row.sandbox_minute_limit===null?null:Number(row.sandbox_minute_limit),thresholdPercentages:row.threshold_percentages,status:row.status,createdAt:iso(row.created_at),updatedAt:iso(row.updated_at)});}
function defaultFromRow(row:DefaultRow){return AllowanceDefaultAssignmentSchema.parse({id:row.id,tenantId:row.tenant_id,profileId:row.profile_id,role:row.role,departmentId:row.department_id,priority:row.priority,createdAt:iso(row.created_at),updatedAt:iso(row.updated_at)});}
function iso(value:Date|string){return value instanceof Date?value.toISOString():new Date(value).toISOString();}
type ProfileRow={id:string;tenant_id:string;name:string;description:string;period:"day"|"month";soft_limit_micros:string|null;hard_limit_micros:string|null;request_limit:number|null;token_limit:number|null;sandbox_minute_limit:string|null;threshold_percentages:number[];status:"active"|"archived";created_at:Date|string;updated_at:Date|string};
type DefaultRow={id:string;tenant_id:string;profile_id:string|null;role:string|null;department_id:string|null;priority:number;created_at:Date|string;updated_at:Date|string};
type BlockedRow={id:string;request_id:string;user_id:string|null;department_id:string|null;feature:string;block_reason:string|null;estimated_cost_micros:string;created_at:Date|string};
