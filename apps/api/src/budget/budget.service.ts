import { HttpException, Injectable } from "@nestjs/common";
import { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import {
  BudgetCheckSchema,
  BudgetLimitSchema,
  BudgetReservationSchema,
  type AgentStreamEvent,
  type BudgetCheck,
  type BudgetLimit,
  type BudgetReservation,
  type JsonValue,
} from "@berry/shared";
import { SELF_HOST_TENANT_ID } from "@berry/db";
import type { CloudDatabaseService, SqlExecutor } from "../db/cloud-database.service.ts";

export const BUDGET_SERVICE = Symbol("BUDGET_SERVICE");

export type BudgetScope = {
  scopeType: "org" | "department" | "user";
  scopeId: string;
};

export type BudgetLimitInput = Omit<BudgetLimit, "id" | "updatedAt" | "requestLimit" | "tokenLimit" | "sandboxMinuteLimit" | "thresholdPercentages"> & {
  requestLimit?: number | null | undefined;
  tokenLimit?: number | null | undefined;
  sandboxMinuteLimit?: number | null | undefined;
  thresholdPercentages?: number[] | undefined;
};

export type ReserveBudgetInput = {
  tenantId?: string | undefined;
  requestId: string;
  userId: string | null;
  departmentId?: string | null | undefined;
  taskId: string | null;
  sessionId: string | null;
  feature: string;
  provider?: string | null | undefined;
  model?: string | null | undefined;
  estimatedCostMicros: string | number | bigint;
  requestUnits?: number | undefined;
  estimatedTokens?: number | undefined;
  estimatedSandboxMinutes?: number | undefined;
  metadata?: JsonValue | undefined;
};

export type ReconcileBudgetInput = {
  tenantId?: string | undefined;
  requestId: string;
  actualCostMicros: string | number | bigint;
  usage?: {
    inputTokens?: number | undefined;
    outputTokens?: number | undefined;
    provider?: string | null | undefined;
    model?: string | null | undefined;
  } | undefined;
};

export interface BudgetRepository {
  reserve(input: ReserveBudgetInput, scopes: BudgetScope[]): Promise<BudgetCheck>;
  reconcile(input: ReconcileBudgetInput): Promise<BudgetReservation | null>;
  listLimits(tenantId: string): Promise<BudgetLimit[]>;
  upsertLimit(input: BudgetLimitInput): Promise<BudgetLimit>;
}

export interface BudgetHotCounters {
  healthy(): Promise<boolean>;
  reserve(scopes: BudgetScope[], amountMicros: bigint): Promise<void>;
  reconcile(scopes: BudgetScope[], reservedMicros: bigint, actualMicros: bigint): Promise<void>;
}

export type BudgetServiceOptions = {
  repository: BudgetRepository;
  hotCounters: BudgetHotCounters;
  failClosed?: boolean | undefined;
  enabled?: boolean | undefined;
};

@Injectable()
export class BudgetService {
  constructor(private readonly options: BudgetServiceOptions) {}

  async reserve(input: ReserveBudgetInput): Promise<BudgetCheck> {
    if (this.options.enabled === false) {
      return BudgetCheckSchema.parse({ allowed: true, reason: null, reservation: null, limit: null, retryAfterSeconds: null });
    }
    if (this.options.failClosed !== false && !(await this.options.hotCounters.healthy())) {
      throw budgetExceeded("Budget counters are unavailable; spending is fail-closed until billing health recovers.", BudgetCheckSchema.parse({
        allowed: false,
        reason: "billing_unhealthy",
        reservation: null,
        limit: null,
        retryAfterSeconds: 60,
      }));
    }
    const scopes = budgetScopes(input.tenantId ?? SELF_HOST_TENANT_ID, input.userId, input.departmentId ?? null);
    const check = await this.options.repository.reserve(input, scopes);
    if (!check.allowed) throw budgetExceeded(check.reason ?? "Budget hard limit exceeded.", check);
    if (check.reservation) await this.options.hotCounters.reserve(scopes, toMicros(check.reservation.reservedMicros));
    return check;
  }

  async reconcile(input: ReconcileBudgetInput): Promise<BudgetReservation | null> {
    const reservation = await this.options.repository.reconcile(input);
    if (!reservation) return null;
    const scopes = budgetScopes(reservation.tenantId, reservation.userId, reservation.departmentId);
    await this.options.hotCounters.reconcile(scopes, toMicros(reservation.reservedMicros), toMicros(reservation.actualCostMicros ?? reservation.reservedMicros));
    return reservation;
  }

  listLimits(tenantId = SELF_HOST_TENANT_ID): Promise<BudgetLimit[]> {
    return this.options.repository.listLimits(tenantId);
  }

  upsertLimit(input: BudgetLimitInput): Promise<BudgetLimit> {
    return this.options.repository.upsertLimit(input);
  }
}

export class InMemoryBudgetRepository implements BudgetRepository {
  readonly #limits = new Map<string, BudgetLimit>();
  readonly #reservations = new Map<string, BudgetReservation>();
  readonly #spent = new Map<string, bigint>();
  readonly #quotaSpent = new Map<string, number>();

  constructor(limits: BudgetLimitInput[] = []) {
    for (const limit of limits) void this.upsertLimit(limit);
  }

  async reserve(input: ReserveBudgetInput, scopes: BudgetScope[]): Promise<BudgetCheck> {
    const tenantId = input.tenantId ?? SELF_HOST_TENANT_ID;
    const estimated = toMicros(input.estimatedCostMicros);
    const activeLimits = [...this.#limits.values()].filter((limit) => limit.tenantId === tenantId && limit.status === "active");
    const quotaExceeded = firstExceededQuota(activeLimits, scopes, this.#quotaSpent, input);
    if (quotaExceeded) {
      const blocked = this.#reservation(input, tenantId, "blocked", estimated, quotaExceeded.reason);
      this.#reservations.set(`${tenantId}:${input.requestId}`, blocked);
      return BudgetCheckSchema.parse({ allowed: false, reason: quotaExceeded.reason, reservation: blocked, limit: quotaExceeded.limit, retryAfterSeconds: null });
    }
    const exceeded = firstExceededLimit(activeLimits, scopes, this.#spent, estimated);
    if (exceeded) {
      const blocked = this.#reservation(input, tenantId, "blocked", estimated, exceeded.reason);
      this.#reservations.set(`${tenantId}:${input.requestId}`, blocked);
      return BudgetCheckSchema.parse({ allowed: false, reason: exceeded.reason, reservation: blocked, limit: exceeded.limit, retryAfterSeconds: null });
    }
    const softExceeded = firstSoftLimit(activeLimits, scopes, this.#spent, estimated);
    const reservation = this.#reservation(input, tenantId, "reserved", estimated, null);
    this.#reservations.set(`${tenantId}:${input.requestId}`, reservation);
    for (const scope of scopes) this.#spent.set(scopeKey(tenantId, scope), (this.#spent.get(scopeKey(tenantId, scope)) ?? 0n) + estimated);
    for (const scope of scopes) reserveQuotas(this.#quotaSpent, tenantId, scope, input);
    return BudgetCheckSchema.parse({
      allowed: true,
      reason: softExceeded?.reason ?? null,
      reservation,
      limit: softExceeded?.limit ?? null,
      retryAfterSeconds: null,
    });
  }

  async reconcile(input: ReconcileBudgetInput): Promise<BudgetReservation | null> {
    const tenantId = input.tenantId ?? SELF_HOST_TENANT_ID;
    const existing = this.#reservations.get(`${tenantId}:${input.requestId}`);
    if (!existing || existing.status !== "reserved") return existing ?? null;
    const actual = toMicros(input.actualCostMicros);
    const next = BudgetReservationSchema.parse({ ...existing, actualCostMicros: actual.toString(), status: "reconciled", updatedAt: new Date().toISOString() });
    this.#reservations.set(`${tenantId}:${input.requestId}`, next);
    for (const scope of budgetScopes(existing.tenantId, existing.userId, existing.departmentId)) {
      const key = scopeKey(tenantId, scope);
      this.#spent.set(key, (this.#spent.get(key) ?? 0n) - toMicros(existing.reservedMicros) + actual);
    }
    return next;
  }

  async listLimits(tenantId: string): Promise<BudgetLimit[]> {
    return [...this.#limits.values()].filter((limit) => limit.tenantId === tenantId);
  }

  async upsertLimit(input: BudgetLimitInput): Promise<BudgetLimit> {
    const now = new Date().toISOString();
    const key = `${input.tenantId}:${input.scopeType}:${input.scopeId}:${input.period}`;
    const current = this.#limits.get(key);
    const limit = BudgetLimitSchema.parse({ ...input, id: current?.id ?? randomUUID(), updatedAt: now });
    this.#limits.set(key, limit);
    return limit;
  }

  #reservation(input: ReserveBudgetInput, tenantId: string, status: BudgetReservation["status"], amount: bigint, blockReason: string | null): BudgetReservation {
    const now = new Date().toISOString();
    return BudgetReservationSchema.parse({
      id: randomUUID(),
      tenantId,
      requestId: input.requestId,
      userId: input.userId,
      departmentId: input.departmentId ?? null,
      taskId: input.taskId,
      sessionId: input.sessionId,
      feature: input.feature,
      provider: input.provider ?? null,
      model: input.model ?? null,
      estimatedCostMicros: amount.toString(),
      reservedMicros: status === "blocked" ? "0" : amount.toString(),
      actualCostMicros: null,
      status,
      blockReason,
      createdAt: now,
      updatedAt: now,
    });
  }
}

export class PostgresBudgetRepository implements BudgetRepository {
  constructor(private readonly database: CloudDatabaseService) {}

  async reserve(input: ReserveBudgetInput, scopes: BudgetScope[]): Promise<BudgetCheck> {
    const tenantId = input.tenantId ?? this.database.selfHostTenantId;
    return this.database.withTenant(tenantId, async (executor) => {
      const limits = await this.listLimitsInTenant(executor, tenantId);
      const spent = await ledgerSpentByScope(executor, tenantId, scopes);
      const estimated = toMicros(input.estimatedCostMicros);
      const quotaExceeded = await firstExceededQuotaInDatabase(executor, tenantId, limits.filter((limit) => limit.status === "active"), scopes, input);
      if (quotaExceeded) {
        const blocked = await this.insertReservation(executor, input, tenantId, "blocked", estimated, 0n, null, quotaExceeded.reason);
        return BudgetCheckSchema.parse({ allowed: false, reason: quotaExceeded.reason, reservation: blocked, limit: quotaExceeded.limit, retryAfterSeconds: null });
      }
      const exceeded = firstExceededLimit(limits.filter((limit) => limit.status === "active"), scopes, spent, estimated);
      if (exceeded) {
        const blocked = await this.insertReservation(executor, input, tenantId, "blocked", estimated, 0n, null, exceeded.reason);
        return BudgetCheckSchema.parse({ allowed: false, reason: exceeded.reason, reservation: blocked, limit: exceeded.limit, retryAfterSeconds: null });
      }
      const softExceeded = firstSoftLimit(limits.filter((limit) => limit.status === "active"), scopes, spent, estimated);
      const reservation = await this.insertReservation(executor, input, tenantId, "reserved", estimated, estimated, null, null);
      for (const scope of scopes) {
        await executor.execute(
          `INSERT INTO credit_ledger_entries (tenant_id, scope_type, scope_id, reservation_id, request_id, kind, amount_micros, balance_after_micros, metadata)
           VALUES ($1::uuid, $2, $3, $4::uuid, $5, 'reserve', $6, $7, $8::jsonb)
           ON CONFLICT (tenant_id, request_id, scope_type, scope_id, kind) DO NOTHING`,
          [tenantId, scope.scopeType, scope.scopeId, reservation.id, input.requestId, estimated.toString(), ((spent.get(scopeKey(tenantId, scope)) ?? 0n) + estimated).toString(), JSON.stringify(input.metadata ?? {})],
        );
      }
      return BudgetCheckSchema.parse({
        allowed: true,
        reason: softExceeded?.reason ?? null,
        reservation,
        limit: softExceeded?.limit ?? null,
        retryAfterSeconds: null,
      });
    });
  }

  async reconcile(input: ReconcileBudgetInput): Promise<BudgetReservation | null> {
    const tenantId = input.tenantId ?? this.database.selfHostTenantId;
    return this.database.withTenant(tenantId, async (executor) => {
      const rows = await executor.query<BudgetReservationRow>("SELECT * FROM budget_reservations WHERE tenant_id = $1::uuid AND request_id = $2 LIMIT 1", [tenantId, input.requestId]);
      const existing = rows[0] ? budgetReservationFromRow(rows[0]) : null;
      if (!existing || existing.status !== "reserved") return existing;
      const actual = toMicros(input.actualCostMicros);
      const updatedRows = await executor.query<BudgetReservationRow>(
        `UPDATE budget_reservations
         SET actual_cost_micros = $3, status = 'reconciled', provider = COALESCE($4, provider), model = COALESCE($5, model), updated_at = now()
         WHERE tenant_id = $1::uuid AND request_id = $2
         RETURNING *`,
        [tenantId, input.requestId, actual.toString(), input.usage?.provider ?? null, input.usage?.model ?? null],
      );
      const updated = budgetReservationFromRow(updatedRows[0]!);
      const scopes = budgetScopes(updated.tenantId, updated.userId, updated.departmentId);
      const spent = await ledgerSpentByScope(executor, tenantId, scopes);
      const adjustment = actual - toMicros(existing.reservedMicros);
      for (const scope of scopes) {
        await executor.execute(
          `INSERT INTO credit_ledger_entries (tenant_id, scope_type, scope_id, reservation_id, request_id, kind, amount_micros, balance_after_micros, metadata)
           VALUES ($1::uuid, $2, $3, $4::uuid, $5, 'reconcile', $6, $7, $8::jsonb)
           ON CONFLICT (tenant_id, request_id, scope_type, scope_id, kind) DO NOTHING`,
          [tenantId, scope.scopeType, scope.scopeId, updated.id, input.requestId, adjustment.toString(), ((spent.get(scopeKey(tenantId, scope)) ?? 0n) + adjustment).toString(), JSON.stringify(input.usage ?? {})],
        );
      }
      return updated;
    });
  }

  async listLimits(tenantId: string): Promise<BudgetLimit[]> {
    return this.database.withTenant(tenantId, (executor) => this.listLimitsInTenant(executor, tenantId));
  }

  async upsertLimit(input: BudgetLimitInput): Promise<BudgetLimit> {
    const rows = await this.database.withTenant(input.tenantId, (executor) => executor.query<BudgetLimitRow>(
      `INSERT INTO budget_limits (tenant_id, scope_type, scope_id, period, soft_limit_micros, hard_limit_micros, request_limit, token_limit, sandbox_minute_limit, threshold_percentages, status)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
       ON CONFLICT (tenant_id, scope_type, scope_id, period) DO UPDATE
       SET soft_limit_micros = excluded.soft_limit_micros, hard_limit_micros = excluded.hard_limit_micros,
           request_limit = excluded.request_limit, token_limit = excluded.token_limit,
           sandbox_minute_limit = excluded.sandbox_minute_limit, threshold_percentages = excluded.threshold_percentages,
           status = excluded.status, updated_at = now()
       RETURNING *`,
      [input.tenantId, input.scopeType, input.scopeId, input.period, input.softLimitMicros, input.hardLimitMicros, input.requestLimit ?? null, input.tokenLimit ?? null, input.sandboxMinuteLimit ?? null, JSON.stringify(input.thresholdPercentages ?? [80, 100]), input.status],
    ));
    return budgetLimitFromRow(rows[0]!);
  }

  private async listLimitsInTenant(executor: SqlExecutor, tenantId: string): Promise<BudgetLimit[]> {
    const rows = await executor.query<BudgetLimitRow>("SELECT * FROM budget_limits WHERE tenant_id = $1::uuid ORDER BY scope_type, scope_id", [tenantId]);
    return rows.map(budgetLimitFromRow);
  }

  private async insertReservation(executor: SqlExecutor, input: ReserveBudgetInput, tenantId: string, status: BudgetReservation["status"], estimated: bigint, reserved: bigint, actual: bigint | null, blockReason: string | null): Promise<BudgetReservation> {
    const rows = await executor.query<BudgetReservationRow>(
      `INSERT INTO budget_reservations (
         tenant_id, request_id, user_id, department_id, task_id, session_id, feature, provider, model,
         estimated_cost_micros, reserved_micros, actual_cost_micros, status, block_reason, metadata
       ) VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb)
       ON CONFLICT (tenant_id, request_id) DO UPDATE
       SET updated_at = now()
       RETURNING *`,
      [
        tenantId,
        input.requestId,
        uuidOrNull(input.userId),
        uuidOrNull(input.departmentId ?? null),
        uuidOrNull(input.taskId),
        uuidOrNull(input.sessionId),
        input.feature,
        input.provider ?? null,
        input.model ?? null,
        estimated.toString(),
        reserved.toString(),
        actual?.toString() ?? null,
        status,
        blockReason,
        JSON.stringify({ ...(input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata) ? input.metadata : {}), requestUnits: input.requestUnits ?? 1, estimatedTokens: input.estimatedTokens ?? 0, estimatedSandboxMinutes: input.estimatedSandboxMinutes ?? 0 }),
      ],
    );
    return budgetReservationFromRow(rows[0]!);
  }
}

export class InMemoryBudgetHotCounters implements BudgetHotCounters {
  readonly #healthy: () => boolean;
  constructor(healthy: () => boolean = () => true) {
    this.#healthy = healthy;
  }
  async healthy() { return this.#healthy(); }
  async reserve() {}
  async reconcile() {}
}

export class RedisBudgetHotCounters implements BudgetHotCounters {
  readonly #redis: Redis;
  constructor(redisUrl: string) {
    this.#redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false });
  }
  async healthy(): Promise<boolean> {
    try {
      if (this.#redis.status === "wait") await this.#redis.connect();
      return (await this.#redis.ping()) === "PONG";
    } catch {
      return false;
    }
  }
  async reserve(scopes: BudgetScope[], amountMicros: bigint): Promise<void> {
    const pipeline = this.#redis.pipeline();
    for (const scope of scopes) pipeline.incrby(redisCounterKey(scope, "reserved"), amountMicros.toString());
    await pipeline.exec();
  }
  async reconcile(scopes: BudgetScope[], reservedMicros: bigint, actualMicros: bigint): Promise<void> {
    const pipeline = this.#redis.pipeline();
    for (const scope of scopes) {
      pipeline.decrby(redisCounterKey(scope, "reserved"), reservedMicros.toString());
      pipeline.incrby(redisCounterKey(scope, "spent"), actualMicros.toString());
    }
    await pipeline.exec();
  }
}

export function createBudgetServiceFromEnv(env: NodeJS.ProcessEnv, repository: BudgetRepository): BudgetService {
  const redisUrl = env.BERRY_REDIS_URL ?? env.REDIS_URL;
  const enabled = env.BERRY_BUDGETS_ENABLED === "true" || Boolean(redisUrl && env.BERRY_BUDGETS_ENABLED !== "false");
  const failClosed = env.BERRY_BUDGET_FAIL_CLOSED === "false" ? false : true;
  const hotCounters = redisUrl ? new RedisBudgetHotCounters(redisUrl) : new InMemoryBudgetHotCounters(() => !failClosed || !enabled);
  return new BudgetService({ repository, hotCounters, enabled, failClosed });
}

export function budgetEstimateFromRequest(input: { provider?: unknown; model?: string | undefined }): bigint {
  const cost = costHints(input.provider, input.model);
  const inputCost = typeof cost.input === "number" ? cost.input : 0;
  const outputCost = typeof cost.output === "number" ? cost.output : 0;
  const estimatedTokens = 4000;
  return BigInt(Math.max(1, Math.ceil(((inputCost + outputCost) * estimatedTokens) || 1)));
}

export function usageCostMicros(event: AgentStreamEvent, fallback: bigint, provider?: unknown): bigint {
  if (event.kind !== "usage") return fallback;
  const cost = costHints(provider, event.requestedModel ?? event.model);
  const inputCost = typeof cost.input === "number" ? cost.input : 0;
  const outputCost = typeof cost.output === "number" ? cost.output : 0;
  const calculated = Math.ceil(event.inputTokens * inputCost + event.outputTokens * outputCost);
  return calculated > 0 ? BigInt(calculated) : fallback;
}

function costHints(providerInput: unknown, model: string | undefined): { input?: number | undefined; output?: number | undefined } {
  type Cost = { input?: number | undefined; output?: number | undefined };
  type Provider = { capabilities?: { cost?: Cost }; cost?: Cost; models?: Array<{ id?: string; capabilities?: { cost?: Cost } }> };
  const provider = providerInput && typeof providerInput === "object" ? providerInput as Provider : {};
  return provider.models?.find((candidate) => candidate.id === model)?.capabilities?.cost
    ?? provider.capabilities?.cost
    ?? provider.cost
    ?? {};
}

function budgetScopes(tenantId: string, userId: string | null, departmentId: string | null): BudgetScope[] {
  return [
    { scopeType: "org", scopeId: tenantId },
    ...(departmentId ? [{ scopeType: "department" as const, scopeId: departmentId }] : []),
    ...(userId ? [{ scopeType: "user" as const, scopeId: userId }] : []),
  ];
}

function quotaEntries(input: ReserveBudgetInput): Array<{ metric: "requests" | "tokens" | "sandbox_minutes"; amount: number }> {
  return [
    { metric: "requests", amount: input.requestUnits ?? 1 },
    { metric: "tokens", amount: input.estimatedTokens ?? 0 },
    { metric: "sandbox_minutes", amount: input.estimatedSandboxMinutes ?? 0 },
  ];
}

function quotaLimit(limit: BudgetLimit, metric: "requests" | "tokens" | "sandbox_minutes"): number | null {
  return metric === "requests" ? limit.requestLimit : metric === "tokens" ? limit.tokenLimit : limit.sandboxMinuteLimit;
}

function quotaKey(tenantId: string, scope: BudgetScope, metric: string): string { return `${scopeKey(tenantId, scope)}:${metric}`; }

function firstExceededQuota(limits: BudgetLimit[], scopes: BudgetScope[], used: Map<string, number>, input: ReserveBudgetInput): { limit: BudgetLimit; reason: string } | null {
  const applicable = limits.filter((limit) => scopes.some((scope) => scope.scopeType === limit.scopeType && scope.scopeId === limit.scopeId));
  for (const entry of quotaEntries(input)) {
    if (entry.amount <= 0) continue;
    for (const limit of applicable) {
      const maximum = quotaLimit(limit, entry.metric);
      if (maximum === null) continue;
      const scope = { scopeType: limit.scopeType, scopeId: limit.scopeId };
      if ((used.get(quotaKey(limit.tenantId, scope, entry.metric)) ?? 0) + entry.amount > maximum) return { limit, reason: `${limit.scopeType} ${entry.metric.replace("_", " ")} quota exceeded` };
    }
  }
  return null;
}

function reserveQuotas(used: Map<string, number>, tenantId: string, scope: BudgetScope, input: ReserveBudgetInput): void {
  for (const entry of quotaEntries(input)) if (entry.amount > 0) used.set(quotaKey(tenantId, scope, entry.metric), (used.get(quotaKey(tenantId, scope, entry.metric)) ?? 0) + entry.amount);
}

async function firstExceededQuotaInDatabase(executor: SqlExecutor, tenantId: string, limits: BudgetLimit[], scopes: BudgetScope[], input: ReserveBudgetInput): Promise<{ limit: BudgetLimit; reason: string } | null> {
  const applicable = limits.filter((limit) => scopes.some((scope) => scope.scopeType === limit.scopeType && scope.scopeId === limit.scopeId));
  for (const entry of quotaEntries(input)) {
    if (entry.amount <= 0) continue;
    for (const limit of applicable) {
      const maximum = quotaLimit(limit, entry.metric); if (maximum === null) continue;
      const column = limit.scopeType === "user" ? "user_id" : limit.scopeType === "department" ? "department_id" : "tenant_id";
      const cast = limit.scopeType === "org" ? "$1::uuid" : "$2::uuid";
      const value = limit.scopeType === "org" ? tenantId : limit.scopeId;
      const period = limit.period === "day" ? "day" : "month";
      const rows = await executor.query<{ used: string }>(`SELECT COALESCE(sum(CASE $3 WHEN 'requests' THEN COALESCE((metadata->>'requestUnits')::numeric,1) WHEN 'tokens' THEN COALESCE((metadata->>'estimatedTokens')::numeric,0) ELSE COALESCE((metadata->>'estimatedSandboxMinutes')::numeric,0) END),0)::text used FROM budget_reservations WHERE tenant_id=$1::uuid AND ${column}=${cast} AND status IN ('reserved','reconciled') AND created_at>=date_trunc('${period}',now())`, [tenantId, value, entry.metric]);
      if (Number(rows[0]?.used ?? 0) + entry.amount > maximum) return { limit, reason: `${limit.scopeType} ${entry.metric.replace("_", " ")} quota exceeded` };
    }
  }
  return null;
}

function firstExceededLimit(limits: BudgetLimit[], scopes: BudgetScope[], spent: Map<string, bigint>, estimate: bigint): { limit: BudgetLimit; reason: string } | null {
  for (const limit of limits) {
    if (!scopes.some((scope) => scope.scopeType === limit.scopeType && scope.scopeId === limit.scopeId)) continue;
    const hard = toMicros(limit.hardLimitMicros);
    if (hard === 0n) continue;
    const next = (spent.get(scopeKey(limit.tenantId, { scopeType: limit.scopeType, scopeId: limit.scopeId })) ?? 0n) + estimate;
    if (next > hard) return { limit, reason: `${limit.scopeType} budget hard limit exceeded` };
  }
  return null;
}

function firstSoftLimit(limits: BudgetLimit[], scopes: BudgetScope[], spent: Map<string, bigint>, estimate: bigint): { limit: BudgetLimit; reason: string } | null {
  for (const limit of limits) {
    if (!scopes.some((scope) => scope.scopeType === limit.scopeType && scope.scopeId === limit.scopeId)) continue;
    const soft = toMicros(limit.softLimitMicros);
    if (soft === 0n) continue;
    const next = (spent.get(scopeKey(limit.tenantId, { scopeType: limit.scopeType, scopeId: limit.scopeId })) ?? 0n) + estimate;
    if (next > soft) return { limit, reason: `${limit.scopeType} budget soft limit exceeded` };
  }
  return null;
}

async function ledgerSpentByScope(executor: SqlExecutor, tenantId: string, scopes: BudgetScope[]): Promise<Map<string, bigint>> {
  const result = new Map<string, bigint>();
  for (const scope of scopes) {
    const rows = await executor.query<{ total: string | null }>(
      "SELECT COALESCE(SUM(amount_micros), 0)::text AS total FROM credit_ledger_entries WHERE tenant_id = $1::uuid AND scope_type = $2 AND scope_id = $3",
      [tenantId, scope.scopeType, scope.scopeId],
    );
    result.set(scopeKey(tenantId, scope), BigInt(rows[0]?.total ?? "0"));
  }
  return result;
}

function budgetExceeded(message: string, check: BudgetCheck): HttpException {
  return new HttpException({ code: "budget_exceeded", message, check }, 402);
}

function budgetLimitFromRow(row: BudgetLimitRow): BudgetLimit {
  return BudgetLimitSchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    period: row.period,
    softLimitMicros: String(row.soft_limit_micros),
    hardLimitMicros: String(row.hard_limit_micros),
    requestLimit: row.request_limit,
    tokenLimit: row.token_limit,
    sandboxMinuteLimit: row.sandbox_minute_limit === null ? null : Number(row.sandbox_minute_limit),
    thresholdPercentages: row.threshold_percentages ?? [80, 100],
    status: row.status,
    updatedAt: iso(row.updated_at),
  });
}

function budgetReservationFromRow(row: BudgetReservationRow): BudgetReservation {
  return BudgetReservationSchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    requestId: row.request_id,
    userId: row.user_id,
    departmentId: row.department_id,
    taskId: row.task_id,
    sessionId: row.session_id,
    feature: row.feature,
    provider: row.provider,
    model: row.model,
    estimatedCostMicros: String(row.estimated_cost_micros),
    reservedMicros: String(row.reserved_micros),
    actualCostMicros: row.actual_cost_micros === null ? null : String(row.actual_cost_micros),
    status: row.status,
    blockReason: row.block_reason,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

function scopeKey(tenantId: string, scope: BudgetScope): string {
  return `${tenantId}:${scope.scopeType}:${scope.scopeId}`;
}

function redisCounterKey(scope: BudgetScope, kind: "reserved" | "spent"): string {
  return `berry:budget:${scope.scopeType}:${scope.scopeId}:${kind}`;
}

function toMicros(value: string | number | bigint): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.max(0, Math.trunc(value)));
  return BigInt(value);
}

function uuidOrNull(value: string | null | undefined): string | null {
  return value && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

type BudgetLimitRow = {
  id: string;
  tenant_id: string;
  scope_type: "org" | "department" | "user";
  scope_id: string;
  period: "day" | "month";
  soft_limit_micros: string;
  hard_limit_micros: string;
  request_limit: number | null;
  token_limit: number | null;
  sandbox_minute_limit: string | number | null;
  threshold_percentages: number[] | null;
  status: "active" | "disabled";
  updated_at: Date | string;
};

type BudgetReservationRow = {
  id: string;
  tenant_id: string;
  request_id: string;
  user_id: string | null;
  department_id: string | null;
  task_id: string | null;
  session_id: string | null;
  feature: string;
  provider: string | null;
  model: string | null;
  estimated_cost_micros: string;
  reserved_micros: string;
  actual_cost_micros: string | null;
  status: "reserved" | "reconciled" | "released" | "blocked";
  block_reason: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};
