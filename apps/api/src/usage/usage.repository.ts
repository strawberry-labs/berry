import { randomUUID } from "node:crypto";
import {
  CloudUsageDashboardSchema,
  CloudUsageEventRecordSchema,
  CloudUsageRollupSchema,
  UsageAnalyticsSchema,
  UsageRequestDetailSchema,
  UsageRequestPageSchema,
  type CloudUsageDashboard,
  type CloudUsageEventRecord,
  type CloudUsageIngestRequest,
  type CloudUsageRollup,
  type UsageAnalyticsQuery,
  type JsonValue,
} from "@berry/shared";
import type { CloudDatabaseService, SqlExecutor } from "../db/cloud-database.service.ts";

export const USAGE_REPOSITORY = Symbol("USAGE_REPOSITORY");

export type UsageEventFilter = {
  from?: Date | undefined;
  to?: Date | undefined;
  feature?: string | undefined;
  userId?: string | undefined;
  departmentId?: string | undefined;
  model?: string | undefined;
  provider?: string | undefined;
  status?: string | undefined;
  workspaceId?: string | undefined;
  agentId?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
};

export type UsageAnalytics = ReturnType<typeof UsageAnalyticsSchema.parse>;
export type UsageRequestPage = ReturnType<typeof UsageRequestPageSchema.parse>;
export type UsageRequestDetail = ReturnType<typeof UsageRequestDetailSchema.parse>;

export interface UsageRepository {
  ingest(tenantId: string, input: CloudUsageIngestRequest): Promise<CloudUsageEventRecord>;
  ingestInternal(tenantId: string, normalized: CloudUsageIngestRequest["normalized"]): Promise<CloudUsageEventRecord>;
  listEvents(tenantId: string, filter?: UsageEventFilter | undefined): Promise<CloudUsageEventRecord[]>;
  listRollups(tenantId: string, filter?: UsageEventFilter | undefined): Promise<CloudUsageRollup[]>;
  dashboard(tenantId: string, filter?: UsageEventFilter | undefined): Promise<CloudUsageDashboard>;
  analytics(tenantId: string, query: UsageAnalyticsQuery): Promise<UsageAnalytics>;
  requestPage(tenantId: string, query: UsageAnalyticsQuery, forceUserId?: string | undefined): Promise<UsageRequestPage>;
  requestDetail(tenantId: string, id: string, forceUserId?: string | undefined): Promise<UsageRequestDetail | null>;
}

export class InMemoryUsageRepository implements UsageRepository {
  readonly #events = new Map<string, CloudUsageEventRecord>();

  async ingest(tenantId: string, input: CloudUsageIngestRequest): Promise<CloudUsageEventRecord> {
    return this.store(tenantId, input);
  }

  async ingestInternal(tenantId: string, normalized: CloudUsageIngestRequest["normalized"]): Promise<CloudUsageEventRecord> {
    return this.store(tenantId, { source: "api", event: { internal: true }, signature: null, normalized });
  }

  private async store(tenantId: string, input: UsageWriteInput): Promise<CloudUsageEventRecord> {
    const key = `${tenantId}:${input.normalized.requestId}`;
    const existing = this.#events.get(key);
    if (existing) return existing;
    const now = new Date().toISOString();
    const event = CloudUsageEventRecordSchema.parse({
      id: randomUUID(),
      tenantId,
      requestId: input.normalized.requestId,
      source: input.source,
      userId: input.normalized.userId ?? null,
      departmentId: input.normalized.departmentId ?? null,
      workspaceId: input.normalized.workspaceId ?? null,
      taskId: input.normalized.taskId ?? null,
      sessionId: input.normalized.sessionId ?? null,
      toolCallId: input.normalized.toolCallId ?? null,
      agentId: input.normalized.agentId ?? null,
      sandboxId: input.normalized.sandboxId ?? null,
      feature: input.normalized.feature,
      provider: input.normalized.provider ?? null,
      model: input.normalized.model ?? null,
      tokensIn: input.normalized.tokensIn,
      tokensOut: input.normalized.tokensOut,
      tokensCached: input.normalized.tokensCached,
      cacheReadTokens: Math.max(input.normalized.cacheReadTokens, input.normalized.tokensCached),
      cacheWriteTokens: input.normalized.cacheWriteTokens,
      cacheCreationTokens1h: input.normalized.cacheCreationTokens1h,
      cacheCreationTokens5m: input.normalized.cacheCreationTokens5m,
      cacheEligible: input.normalized.cacheEligible,
      cacheProvider: input.normalized.cacheProvider ?? null,
      cacheKeyHash: input.normalized.cacheKeyHash ?? null,
      promptManifestHash: input.normalized.promptManifestHash ?? null,
      cacheMissReason: input.normalized.cacheMissReason ?? null,
      sandboxUsage: input.normalized.sandboxUsage,
      costRawMicros: input.normalized.costRawMicros,
      costBilledMicros: input.normalized.costBilledMicros,
      latencyMs: input.normalized.latencyMs ?? null,
      ttftMs: input.normalized.ttftMs ?? null,
      status: input.normalized.status,
      metadata: input.normalized.metadata,
      signedPayload: input.event,
      signature: input.signature,
      ts: input.normalized.ts ?? now,
      createdAt: now,
    });
    this.#events.set(key, event);
    return event;
  }

  async listEvents(tenantId: string, filter: UsageEventFilter = {}): Promise<CloudUsageEventRecord[]> {
    const cursor = parseRequestCursor(filter.cursor);
    const events = [...this.#events.values()]
      .filter((event) => event.tenantId === tenantId && matchesUsageFilter(event, filter))
      .sort((a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id))
      .filter((event) => !cursor || event.ts > cursor.ts || (event.ts === cursor.ts && event.id > cursor.id));
    return filter.limit ? events.slice(0, filter.limit) : events;
  }

  async listRollups(tenantId: string, filter: UsageEventFilter = {}): Promise<CloudUsageRollup[]> {
    return rollupsFromEvents(await this.listEvents(tenantId, filter));
  }

  async dashboard(tenantId: string, filter: UsageEventFilter = {}): Promise<CloudUsageDashboard> {
    return dashboardFromEvents(tenantId, filter, await this.listEvents(tenantId, filter));
  }

  async analytics(tenantId: string, query: UsageAnalyticsQuery): Promise<UsageAnalytics> {
    return analyticsFromEvents(tenantId, query, await this.listEvents(tenantId, queryFilter(query)));
  }

  async requestPage(tenantId: string, query: UsageAnalyticsQuery, forceUserId?: string): Promise<UsageRequestPage> {
    return requestPageFromEvents(await this.listEvents(tenantId, { ...queryFilter(query), userId: forceUserId ?? query.memberId }), query);
  }

  async requestDetail(tenantId: string, id: string, forceUserId?: string): Promise<UsageRequestDetail | null> {
    const event = [...this.#events.values()].find((candidate) => candidate.tenantId === tenantId && candidate.id === id && (!forceUserId || candidate.userId === forceUserId));
    return event ? requestDetailFromEvent(event) : null;
  }
}

export class PostgresUsageRepository implements UsageRepository {
  constructor(private readonly database: CloudDatabaseService) {}

  async ingest(tenantId: string, input: CloudUsageIngestRequest): Promise<CloudUsageEventRecord> {
    return this.database.withTenant(tenantId, async (executor) => {
      const row = await this.insertEvent(executor, tenantId, input);
      return usageEventFromRow(row);
    });
  }

  async ingestInternal(tenantId: string, normalized: CloudUsageIngestRequest["normalized"]): Promise<CloudUsageEventRecord> {
    return this.database.withTenant(tenantId, async (executor) => {
      const row = await this.insertEvent(executor, tenantId, { source: "api", event: { internal: true }, signature: null, normalized });
      return usageEventFromRow(row);
    });
  }

  async listEvents(tenantId: string, filter: UsageEventFilter = {}): Promise<CloudUsageEventRecord[]> {
    return this.database.withTenant(tenantId, async (executor) => {
      const query = usageEventQuery(tenantId, filter, "asc");
      const rows = await executor.query<UsageEventRow>(
        `SELECT * FROM usage_events ${query.where} ORDER BY ts ASC,id ASC${query.limitClause}`,
        query.params,
      );
      return rows.map(usageEventFromRow);
    });
  }

  async listRollups(tenantId: string, filter: UsageEventFilter = {}): Promise<CloudUsageRollup[]> {
    return this.database.withTenant(tenantId, async (executor) => {
      const clauses = ["tenant_id = $1::uuid"];
      const params: unknown[] = [tenantId];
      if (filter.from) {
        params.push(filter.from.toISOString());
        clauses.push(`bucket_start >= $${params.length}`);
      }
      if (filter.to) {
        params.push(filter.to.toISOString());
        clauses.push(`bucket_start < $${params.length}`);
      }
      if (filter.feature) {
        params.push(filter.feature);
        clauses.push(`feature = $${params.length}`);
      }
      if (filter.model) {
        params.push(filter.model);
        clauses.push(`model = $${params.length}`);
      }
      const rows = await executor.query<UsageRollupRow>(
        `SELECT * FROM usage_rollups WHERE ${clauses.join(" AND ")} ORDER BY bucket_start ASC, feature ASC, provider ASC, model ASC LIMIT 1000`,
        params,
      );
      return rows.map(usageRollupFromRow);
    });
  }

  async dashboard(tenantId: string, filter: UsageEventFilter = {}): Promise<CloudUsageDashboard> {
    return dashboardFromEvents(tenantId, filter, await this.listEvents(tenantId, filter));
  }

  async analytics(tenantId: string, query: UsageAnalyticsQuery): Promise<UsageAnalytics> {
    return this.database.withTenant(tenantId, (executor) => postgresAnalytics(executor, tenantId, query));
  }

  async requestPage(tenantId: string, query: UsageAnalyticsQuery, forceUserId?: string): Promise<UsageRequestPage> {
    return this.database.withTenant(tenantId, async (executor) => {
      const eventQuery = usageEventQuery(tenantId, {
        ...queryFilter(query),
        userId: forceUserId ?? query.memberId,
        cursor: query.cursor,
        limit: query.limit + 1,
      }, "desc");
      const rows = await executor.query<UsageEventRow>(
        `SELECT * FROM usage_events ${eventQuery.where} ORDER BY ts DESC,id DESC${eventQuery.limitClause}`,
        eventQuery.params,
      );
      return requestPageFromOrderedEvents(rows.map(usageEventFromRow), query.limit);
    });
  }

  async requestDetail(tenantId: string, id: string, forceUserId?: string): Promise<UsageRequestDetail | null> {
    return this.database.withTenant(tenantId, async (executor) => {
      const rows = await executor.query<UsageEventRow>(`SELECT * FROM usage_events WHERE tenant_id = $1::uuid AND id = $2::uuid${forceUserId ? " AND user_id = $3::uuid" : ""} LIMIT 1`, forceUserId ? [tenantId, id, forceUserId] : [tenantId, id]);
      return rows[0] ? requestDetailFromEvent(usageEventFromRow(rows[0])) : null;
    });
  }

  private async insertEvent(executor: SqlExecutor, tenantId: string, input: UsageWriteInput): Promise<UsageEventRow> {
    const normalized = input.normalized;
    const rows = await executor.query<UsageEventRow>(
      `INSERT INTO usage_events (
        tenant_id, request_id, idempotency_key, source, user_id, department_id, workspace_id, task_id, session_id, tool_call_id, agent_id, sandbox_id,
        feature, provider, model, tokens_in, tokens_out, tokens_cached,
        cache_read_tokens, cache_write_tokens, cache_creation_tokens_1h, cache_creation_tokens_5m,
        cache_eligible, cache_provider, cache_key_hash, prompt_manifest_hash, cache_miss_reason, sandbox_usage,
        cost_raw_micros, cost_billed_micros, latency_ms, ttft_ms, status, metadata, signed_payload, signature, ts
      ) VALUES (
        $1::uuid, $2, $2, $3, $4::uuid, $5::uuid, $6::uuid, $7::uuid, $8::uuid, $9::uuid,
        $10, $11, $12, $13, $14, $15, $16, $17,
        $18, $19, $20, $21, $22, $23, $24, $25, $26, $27::jsonb,
        $28, $29, $30, $31, $32, $33::jsonb, $34::jsonb, $35::jsonb, $36
      )
      ON CONFLICT (tenant_id, request_id) DO NOTHING
      RETURNING *`,
      [
        tenantId,
        normalized.requestId,
        input.source,
        uuidOrNull(normalized.userId ?? null),
        uuidOrNull(normalized.departmentId ?? null),
        uuidOrNull(normalized.workspaceId ?? null),
        uuidOrNull(normalized.taskId ?? null),
        uuidOrNull(normalized.sessionId ?? null),
        uuidOrNull(normalized.toolCallId ?? null),
        normalized.agentId ?? null,
        normalized.sandboxId ?? null,
        normalized.feature,
        normalized.provider ?? null,
        normalized.model ?? null,
        normalized.tokensIn,
        normalized.tokensOut,
        normalized.tokensCached,
        Math.max(normalized.cacheReadTokens, normalized.tokensCached),
        normalized.cacheWriteTokens,
        normalized.cacheCreationTokens1h,
        normalized.cacheCreationTokens5m,
        normalized.cacheEligible,
        normalized.cacheProvider ?? null,
        normalized.cacheKeyHash ?? null,
        normalized.promptManifestHash ?? null,
        normalized.cacheMissReason ?? null,
        JSON.stringify(normalized.sandboxUsage),
        normalized.costRawMicros,
        normalized.costBilledMicros,
        normalized.latencyMs ?? null,
        normalized.ttftMs ?? null,
        normalized.status,
        JSON.stringify(normalized.metadata),
        JSON.stringify(input.event),
        JSON.stringify(input.signature),
        normalized.ts ?? new Date().toISOString(),
      ],
    );
    if (rows[0]) return rows[0];
    const existing = await executor.query<UsageEventRow>("SELECT * FROM usage_events WHERE tenant_id = $1::uuid AND request_id = $2 LIMIT 1", [tenantId, normalized.requestId]);
    return existing[0]!;
  }
}

type UsageWriteInput = Omit<CloudUsageIngestRequest, "source" | "signature"> & {
  source: CloudUsageEventRecord["source"];
  signature: CloudUsageEventRecord["signature"];
};

export function usageEventsCsv(events: CloudUsageEventRecord[]): string {
  const headers = [
    "ts", "source", "request_id", "feature", "provider", "model", "user_id", "department_id", "status",
    "tokens_in", "tokens_out", "cache_read_tokens", "cache_write_tokens", "cache_eligible",
    "cache_miss_reason", "cost_billed_micros",
  ];
  const rows = events.map((event) => [
    event.ts,
    event.source,
    event.requestId,
    event.feature,
    event.provider ?? "",
    event.model ?? "",
    event.userId ?? "",
    event.departmentId ?? "",
    event.status,
    String(event.tokensIn),
    String(event.tokensOut),
    String(event.cacheReadTokens),
    String(event.cacheWriteTokens),
    String(event.cacheEligible),
    event.cacheMissReason ?? "",
    event.costBilledMicros,
  ]);
  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
}

function matchesUsageFilter(event: CloudUsageEventRecord, filter: UsageEventFilter): boolean {
  const ts = new Date(event.ts);
  return (!filter.from || ts >= filter.from)
    && (!filter.to || ts < filter.to)
    && (!filter.feature || event.feature === filter.feature)
    && (!filter.userId || event.userId === filter.userId)
    && (!filter.departmentId || event.departmentId === filter.departmentId)
    && (!filter.model || event.model === filter.model)
    && (!filter.provider || event.provider === filter.provider)
    && (!filter.status || event.status === filter.status)
    && (!filter.workspaceId || event.workspaceId === filter.workspaceId)
    && (!filter.agentId || event.agentId === filter.agentId);
}

function rollupsFromEvents(events: CloudUsageEventRecord[]): CloudUsageRollup[] {
  const groups = new Map<string, CloudUsageRollup>();
  for (const event of events) {
    const bucketStart = utcDayStart(new Date(event.ts));
    const bucketEnd = new Date(bucketStart.getTime() + 86_400_000);
    const key = [bucketStart.toISOString(), event.feature, event.provider ?? "", event.model ?? "", event.status,
      event.userId ?? "", event.departmentId ?? "", event.workspaceId ?? "", event.agentId ?? "", event.sandboxId ?? ""].join("\u0000");
    const current = groups.get(key);
    if (!current) {
      groups.set(key, CloudUsageRollupSchema.parse({
        tenantId: event.tenantId,
        bucketStart: bucketStart.toISOString(),
        bucketEnd: bucketEnd.toISOString(),
        granularity: "day",
        feature: event.feature,
        provider: event.provider,
        model: event.model,
        userId: event.userId,
        departmentId: event.departmentId,
        workspaceId: event.workspaceId,
        agentId: event.agentId,
        sandboxId: event.sandboxId,
        status: event.status,
        requestCount: 1,
        tokensIn: event.tokensIn,
        tokensOut: event.tokensOut,
        tokensCached: event.tokensCached,
        cacheReadTokens: event.cacheReadTokens,
        cacheWriteTokens: event.cacheWriteTokens,
        costRawMicros: event.costRawMicros,
        costBilledMicros: event.costBilledMicros,
      }));
      continue;
    }
    current.requestCount += 1;
    current.tokensIn += event.tokensIn;
    current.tokensOut += event.tokensOut;
    current.tokensCached += event.tokensCached;
    current.cacheReadTokens += event.cacheReadTokens;
    current.cacheWriteTokens += event.cacheWriteTokens;
    current.costRawMicros = (BigInt(current.costRawMicros) + BigInt(event.costRawMicros)).toString();
    current.costBilledMicros = (BigInt(current.costBilledMicros) + BigInt(event.costBilledMicros)).toString();
  }
  return [...groups.values()];
}

function dashboardFromEvents(tenantId: string, filter: UsageEventFilter, events: CloudUsageEventRecord[]): CloudUsageDashboard {
  const from = filter.from ?? new Date(Date.now() - 30 * 86_400_000);
  const to = filter.to ?? new Date();
  const totals = events.reduce((acc, event) => ({
    requests: acc.requests + 1,
    tokensIn: acc.tokensIn + event.tokensIn,
    tokensOut: acc.tokensOut + event.tokensOut,
    costBilledMicros: (BigInt(acc.costBilledMicros) + BigInt(event.costBilledMicros)).toString(),
  }), { requests: 0, tokensIn: 0, tokensOut: 0, costBilledMicros: "0" });
  return CloudUsageDashboardSchema.parse({
    tenantId,
    from: from.toISOString(),
    to: to.toISOString(),
    totals,
    byFeature: groupUsage(events, (event) => event.feature, "feature"),
    byModel: groupUsage(events, (event) => event.model ?? "unknown", "model"),
    byUser: groupUsage(events, (event) => event.userId, "userId"),
    byDepartment: groupUsage(events, (event) => event.departmentId, "departmentId"),
    burnDown: groupBurnDown(events),
  });
}

function groupUsage<TKey extends "feature" | "model" | "userId" | "departmentId">(events: CloudUsageEventRecord[], keyFn: (event: CloudUsageEventRecord) => string | null, keyName: TKey): Array<Record<TKey, string | null> & { requests: number; costBilledMicros: string; tokens: number }> {
  const groups = new Map<string, { key: string | null; requests: number; costBilledMicros: string; tokens: number }>();
  for (const event of events) {
    const key = keyFn(event);
    const id = key ?? "null";
    const current = groups.get(id) ?? { key, requests: 0, costBilledMicros: "0", tokens: 0 };
    current.requests += 1;
    current.costBilledMicros = (BigInt(current.costBilledMicros) + BigInt(event.costBilledMicros)).toString();
    current.tokens += event.tokensIn + event.tokensOut;
    groups.set(id, current);
  }
  return [...groups.values()]
    .sort((a, b) => BigInt(b.costBilledMicros) > BigInt(a.costBilledMicros) ? 1 : -1)
    .map((entry) => ({ [keyName]: entry.key, requests: entry.requests, costBilledMicros: entry.costBilledMicros, tokens: entry.tokens }) as Record<TKey, string | null> & { requests: number; costBilledMicros: string; tokens: number });
}

function groupBurnDown(events: CloudUsageEventRecord[]): Array<{ date: string; costBilledMicros: string; requests: number }> {
  const groups = new Map<string, { date: string; costBilledMicros: string; requests: number }>();
  for (const event of events) {
    const date = event.ts.slice(0, 10);
    const current = groups.get(date) ?? { date, costBilledMicros: "0", requests: 0 };
    current.requests += 1;
    current.costBilledMicros = (BigInt(current.costBilledMicros) + BigInt(event.costBilledMicros)).toString();
    groups.set(date, current);
  }
  return [...groups.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function queryFilter(query: UsageAnalyticsQuery): UsageEventFilter {
  return {
    from: new Date(query.from), to: new Date(query.to), feature: query.feature, userId: query.memberId,
    departmentId: query.departmentId, model: query.model, provider: query.provider, status: query.status,
    workspaceId: query.workspaceId, agentId: query.agentId,
  };
}

function analyticsFromEvents(tenantId: string, query: UsageAnalyticsQuery, events: CloudUsageEventRecord[]): UsageAnalytics {
  const totalCost = events.reduce((sum, event) => sum + BigInt(event.costBilledMicros), 0n);
  const successes = events.filter((event) => isSuccess(event.status)).length;
  const tokens = events.reduce((sum, event) => sum + event.tokensIn + event.tokensOut, 0);
  const elapsedDays = Math.max(1, (new Date(query.to).getTime() - new Date(query.from).getTime()) / 86_400_000);
  const monthDays = new Date(new Date(query.to).getUTCFullYear(), new Date(query.to).getUTCMonth() + 1, 0).getUTCDate();
  const projection = totalCost * BigInt(Math.max(1, Math.round(monthDays / elapsedDays)));
  const latencies = events.flatMap((event) => event.latencyMs === null ? [] : [event.latencyMs]).sort((a, b) => a - b);
  const ttfts = events.flatMap((event) => event.ttftMs === null ? [] : [event.ttftMs]).sort((a, b) => a - b);
  const sandboxMinutes = events.reduce((sum, event) => sum + sandboxMinutesFor(event.sandboxUsage), 0);
  return UsageAnalyticsSchema.parse({
    tenantId, from: query.from, to: query.to,
    totals: {
      billedCostMicros: totalCost.toString(), requests: events.length, tokens,
      inputTokens: events.reduce((sum, event) => sum + event.tokensIn, 0),
      outputTokens: events.reduce((sum, event) => sum + event.tokensOut, 0),
      successRate: events.length ? successes / events.length : null,
      projectedMonthEndMicros: events.length ? projection.toString() : null,
    },
    series: usageSeries(events, query),
    breakdowns: {
      departments: breakdown(events, "department", (event) => event.departmentId),
      members: breakdown(events, "member", (event) => event.userId),
      models: breakdown(events, "model", (event) => event.model),
      providers: breakdown(events, "provider", (event) => event.provider),
      features: breakdown(events, "feature", (event) => event.feature),
      workspaces: breakdown(events, "workspace", (event) => event.workspaceId),
      agents: breakdown(events, "agent", (event) => event.agentId),
      statuses: breakdown(events, "status", (event) => event.status),
    },
    performance: {
      latencyP50Ms: percentile(latencies, 0.5), latencyP95Ms: percentile(latencies, 0.95),
      ttftP50Ms: percentile(ttfts, 0.5), ttftP95Ms: percentile(ttfts, 0.95),
      cachedTokens: events.reduce((sum, event) => sum + event.tokensCached, 0),
      cacheReadTokens: events.reduce((sum, event) => sum + event.cacheReadTokens, 0),
      cacheWriteTokens: events.reduce((sum, event) => sum + event.cacheWriteTokens, 0),
      cacheEligibleRequests: events.filter((event) => event.cacheEligible).length,
      cacheHitRequests: events.filter((event) => event.cacheEligible && event.cacheReadTokens > 0).length,
      sandboxMinutes,
    },
    anomalies: explainAnomalies(events, query),
    unavailableDimensions: events.some((event) => event.agentId) ? [] : ["agent"],
  });
}

async function postgresAnalytics(
  executor: SqlExecutor,
  tenantId: string,
  query: UsageAnalyticsQuery,
): Promise<UsageAnalytics> {
  const filter = usageWhere(tenantId, queryFilter(query));
  const totalsRows = await executor.query<UsageAnalyticsTotalsRow>(`
    SELECT
      COUNT(*)::bigint AS requests,
      COALESCE(SUM(cost_billed_micros), 0)::text AS billed_cost_micros,
      COALESCE(SUM(tokens_in), 0)::bigint AS input_tokens,
      COALESCE(SUM(tokens_out), 0)::bigint AS output_tokens,
      COUNT(*) FILTER (WHERE status IN ('completed','success','succeeded'))::bigint AS successes,
      percentile_disc(0.5) WITHIN GROUP (ORDER BY latency_ms)
        FILTER (WHERE latency_ms IS NOT NULL) AS latency_p50_ms,
      percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms)
        FILTER (WHERE latency_ms IS NOT NULL) AS latency_p95_ms,
      percentile_disc(0.5) WITHIN GROUP (ORDER BY ttft_ms)
        FILTER (WHERE ttft_ms IS NOT NULL) AS ttft_p50_ms,
      percentile_disc(0.95) WITHIN GROUP (ORDER BY ttft_ms)
        FILTER (WHERE ttft_ms IS NOT NULL) AS ttft_p95_ms,
      COALESCE(SUM(tokens_cached), 0)::bigint AS cached_tokens,
      COALESCE(SUM(cache_read_tokens), 0)::bigint AS cache_read_tokens,
      COALESCE(SUM(cache_write_tokens), 0)::bigint AS cache_write_tokens,
      COUNT(*) FILTER (WHERE cache_eligible)::bigint AS cache_eligible_requests,
      COUNT(*) FILTER (WHERE cache_eligible AND cache_read_tokens > 0)::bigint AS cache_hit_requests,
      COALESCE(SUM(
        CASE
          WHEN jsonb_typeof(sandbox_usage->'minutes') = 'number'
            THEN GREATEST(0, (sandbox_usage->>'minutes')::numeric)
          WHEN jsonb_typeof(sandbox_usage->'duration_ms') = 'number'
            THEN GREATEST(0, (sandbox_usage->>'duration_ms')::numeric) / 60000
          WHEN jsonb_typeof(sandbox_usage->'cpu_ms') = 'number'
            THEN GREATEST(0, (sandbox_usage->>'cpu_ms')::numeric) / 60000
          ELSE 0
        END
      ), 0)::text AS sandbox_minutes,
      COUNT(agent_id)::bigint AS attributed_agents
    FROM usage_events
    ${filter.where}
  `, filter.params);

  const bucketMs = usageBucketMs(new Date(query.from), new Date(query.to));
  const seriesParams = [...filter.params, bucketMs];
  const bucketParam = `$${seriesParams.length}`;
  const seriesRows = await executor.query<UsageAnalyticsSeriesRow>(`
    SELECT
      to_timestamp(
        floor(extract(epoch FROM ts) * 1000 / ${bucketParam}::double precision)
        * ${bucketParam}::double precision / 1000
      ) AS bucket,
      COALESCE(SUM(cost_billed_micros), 0)::text AS billed_cost_micros,
      COUNT(*)::bigint AS requests,
      COALESCE(SUM(tokens_in + tokens_out), 0)::bigint AS tokens,
      COUNT(*) FILTER (WHERE status IN ('completed','success','succeeded'))::bigint AS successes,
      COUNT(*) FILTER (WHERE status NOT IN ('completed','success','succeeded'))::bigint AS failures
    FROM usage_events
    ${filter.where}
    GROUP BY 1
    ORDER BY 1
  `, seriesParams);

  const breakdownRows = await executor.query<UsageAnalyticsBreakdownRow>(`
    WITH aggregated AS (
      SELECT
        dimension,
        dimension_id,
        COUNT(*)::bigint AS requests,
        COALESCE(SUM(cost_billed_micros), 0)::text AS billed_cost_micros,
        COALESCE(SUM(tokens_in + tokens_out), 0)::bigint AS tokens,
        COALESCE(SUM(tokens_in), 0)::bigint AS input_tokens,
        COALESCE(SUM(tokens_out), 0)::bigint AS output_tokens,
        COALESCE(SUM(cache_read_tokens), 0)::bigint AS cache_read_tokens,
        COALESCE(SUM(cache_write_tokens), 0)::bigint AS cache_write_tokens,
        COUNT(*) FILTER (WHERE status NOT IN ('completed','success','succeeded'))::bigint AS failures,
        percentile_disc(0.5) WITHIN GROUP (ORDER BY latency_ms)
          FILTER (WHERE latency_ms IS NOT NULL) AS latency_p50_ms,
        percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms)
          FILTER (WHERE latency_ms IS NOT NULL) AS latency_p95_ms
      FROM usage_events
      CROSS JOIN LATERAL (VALUES
        ('department', department_id::text),
        ('member', user_id::text),
        ('model', model),
        ('provider', provider),
        ('feature', feature),
        ('workspace', workspace_id::text),
        ('agent', agent_id),
        ('status', status)
      ) AS dimensions(dimension, dimension_id)
      ${filter.where}
      GROUP BY dimension, dimension_id
    ), ranked AS (
      SELECT aggregated.*,
        ROW_NUMBER() OVER (
          PARTITION BY dimension
          ORDER BY billed_cost_micros::numeric DESC, requests DESC, dimension_id NULLS LAST
        ) AS dimension_rank
      FROM aggregated
    )
    SELECT * FROM ranked
    WHERE dimension_rank <= 100
    ORDER BY dimension, dimension_rank
  `, filter.params);

  const totals = totalsRows[0];
  const requestCount = numberFromDb(totals?.requests);
  const inputTokens = numberFromDb(totals?.input_tokens);
  const outputTokens = numberFromDb(totals?.output_tokens);
  const elapsedDays = Math.max(
    1,
    (new Date(query.to).getTime() - new Date(query.from).getTime()) / 86_400_000,
  );
  const to = new Date(query.to);
  const monthDays = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() + 1, 0)).getUTCDate();
  const totalCost = BigInt(totals?.billed_cost_micros ?? "0");
  const projection = totalCost * BigInt(Math.max(1, Math.round(monthDays / elapsedDays)));
  const series = seriesRows.map((row) => ({
    ts: iso(row.bucket),
    billedCostMicros: String(row.billed_cost_micros),
    requests: numberFromDb(row.requests),
    tokens: numberFromDb(row.tokens),
    successes: numberFromDb(row.successes),
    failures: numberFromDb(row.failures),
  }));
  const breakdowns: Record<string, Array<{
    dimension: string;
    id: string | null;
    label: string;
    requests: number;
    billedCostMicros: string;
    tokens: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    errorRate: number | null;
    latencyP50Ms: number | null;
    latencyP95Ms: number | null;
  }>> = {
    departments: [], members: [], models: [], providers: [], features: [], workspaces: [], agents: [], statuses: [],
  };
  const breakdownKey: Record<string, keyof typeof breakdowns> = {
    department: "departments",
    member: "members",
    model: "models",
    provider: "providers",
    feature: "features",
    workspace: "workspaces",
    agent: "agents",
    status: "statuses",
  };
  for (const row of breakdownRows) {
    const key = breakdownKey[row.dimension];
    if (!key) continue;
    const requests = numberFromDb(row.requests);
    const failures = numberFromDb(row.failures);
    breakdowns[key]!.push({
      dimension: row.dimension,
      id: row.dimension_id,
      label: row.dimension_id ?? "unattributed",
      requests,
      billedCostMicros: String(row.billed_cost_micros),
      tokens: numberFromDb(row.tokens),
      inputTokens: numberFromDb(row.input_tokens),
      outputTokens: numberFromDb(row.output_tokens),
      cacheReadTokens: numberFromDb(row.cache_read_tokens),
      cacheWriteTokens: numberFromDb(row.cache_write_tokens),
      errorRate: requests ? failures / requests : null,
      latencyP50Ms: nullableNumberFromDb(row.latency_p50_ms),
      latencyP95Ms: nullableNumberFromDb(row.latency_p95_ms),
    });
  }

  return UsageAnalyticsSchema.parse({
    tenantId,
    from: query.from,
    to: query.to,
    totals: {
      billedCostMicros: totalCost.toString(),
      requests: requestCount,
      tokens: inputTokens + outputTokens,
      inputTokens,
      outputTokens,
      successRate: requestCount ? numberFromDb(totals?.successes) / requestCount : null,
      projectedMonthEndMicros: requestCount ? projection.toString() : null,
    },
    series,
    breakdowns,
    performance: {
      latencyP50Ms: nullableNumberFromDb(totals?.latency_p50_ms),
      latencyP95Ms: nullableNumberFromDb(totals?.latency_p95_ms),
      ttftP50Ms: nullableNumberFromDb(totals?.ttft_p50_ms),
      ttftP95Ms: nullableNumberFromDb(totals?.ttft_p95_ms),
      cachedTokens: numberFromDb(totals?.cached_tokens),
      cacheReadTokens: numberFromDb(totals?.cache_read_tokens),
      cacheWriteTokens: numberFromDb(totals?.cache_write_tokens),
      cacheEligibleRequests: numberFromDb(totals?.cache_eligible_requests),
      cacheHitRequests: numberFromDb(totals?.cache_hit_requests),
      sandboxMinutes: numberFromDb(totals?.sandbox_minutes),
    },
    anomalies: explainSeriesAnomalies(series, query),
    unavailableDimensions: numberFromDb(totals?.attributed_agents) > 0 ? [] : ["agent"],
  });
}

function explainSeriesAnomalies(
  series: Array<{ ts: string; billedCostMicros: string; requests: number; successes: number; failures: number }>,
  query: UsageAnalyticsQuery,
) {
  if (series.length < 4) return [];
  const split = Math.max(1, Math.floor(series.length * 0.75));
  const baseline = series.slice(0, split);
  const observed = series.slice(split);
  const definitions = [
    {
      kind: "spend" as const,
      label: "Unusual spend",
      base: average(baseline.map((point) => Number(point.billedCostMicros))),
      value: average(observed.map((point) => Number(point.billedCostMicros))),
      unit: "micros per period",
    },
    {
      kind: "failures" as const,
      label: "Elevated failure rate",
      base: ratio(
        baseline.reduce((sum, point) => sum + point.failures, 0),
        baseline.reduce((sum, point) => sum + point.requests, 0),
      ),
      value: ratio(
        observed.reduce((sum, point) => sum + point.failures, 0),
        observed.reduce((sum, point) => sum + point.requests, 0),
      ),
      unit: "ratio",
    },
  ];
  const windowStart = observed[0]?.ts ?? query.from;
  return definitions
    .filter((entry) => entry.base > 0 && entry.value >= entry.base * 1.5)
    .map((entry) => ({
      id: `${entry.kind}:${windowStart}`,
      kind: entry.kind,
      severity: entry.value >= entry.base * 2 ? "error" as const : "warning" as const,
      label: entry.label,
      baseline: entry.base,
      observed: entry.value,
      unit: entry.unit,
      windowStart,
      windowEnd: query.to,
      dimension: { kind: "organization", id: null, label: "Organization" },
      explanation: `${entry.label}: observed ${formatNumber(entry.value)} ${entry.unit}, compared with a baseline of ${formatNumber(entry.base)} during the earlier part of this window.`,
    }));
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function numberFromDb(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function nullableNumberFromDb(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function usageSeries(events: CloudUsageEventRecord[], query: UsageAnalyticsQuery) {
  const bucketMs = usageBucketMs(new Date(query.from), new Date(query.to));
  const points = new Map<string, { ts: string; billedCostMicros: string; requests: number; tokens: number; successes: number; failures: number }>();
  for (const event of events) {
    const ts = new Date(Math.floor(new Date(event.ts).getTime() / bucketMs) * bucketMs).toISOString();
    const point = points.get(ts) ?? { ts, billedCostMicros: "0", requests: 0, tokens: 0, successes: 0, failures: 0 };
    point.billedCostMicros = (BigInt(point.billedCostMicros) + BigInt(event.costBilledMicros)).toString();
    point.requests += 1;
    point.tokens += event.tokensIn + event.tokensOut;
    if (isSuccess(event.status)) point.successes += 1;
    else point.failures += 1;
    points.set(ts, point);
  }
  return [...points.values()].sort((a, b) => a.ts.localeCompare(b.ts));
}

function breakdown(events: CloudUsageEventRecord[], dimension: string, key: (event: CloudUsageEventRecord) => string | null) {
  const rows = new Map<string, CloudUsageEventRecord[]>();
  for (const event of events) {
    const id = key(event) ?? "unattributed";
    rows.set(id, [...(rows.get(id) ?? []), event]);
  }
  return [...rows.entries()].map(([id, group]) => {
    const latency = group.flatMap((event) => event.latencyMs === null ? [] : [event.latencyMs]).sort((a, b) => a - b);
    const failures = group.filter((event) => !isSuccess(event.status)).length;
    return {
      dimension, id: id === "unattributed" ? null : id, label: id, requests: group.length,
      billedCostMicros: group.reduce((sum, event) => sum + BigInt(event.costBilledMicros), 0n).toString(),
      tokens: group.reduce((sum, event) => sum + event.tokensIn + event.tokensOut, 0),
      inputTokens: group.reduce((sum, event) => sum + event.tokensIn, 0),
      outputTokens: group.reduce((sum, event) => sum + event.tokensOut, 0),
      cacheReadTokens: group.reduce((sum, event) => sum + event.cacheReadTokens, 0),
      cacheWriteTokens: group.reduce((sum, event) => sum + event.cacheWriteTokens, 0),
      errorRate: group.length ? failures / group.length : null, latencyP50Ms: percentile(latency, 0.5), latencyP95Ms: percentile(latency, 0.95),
    };
  }).sort((a, b) => BigInt(a.billedCostMicros) > BigInt(b.billedCostMicros) ? -1 : 1);
}

function explainAnomalies(events: CloudUsageEventRecord[], query: UsageAnalyticsQuery) {
  if (events.length < 4) return [];
  const sorted = [...events].sort((a, b) => a.ts.localeCompare(b.ts));
  const split = Math.max(1, Math.floor(sorted.length * 0.75));
  const baseline = sorted.slice(0, split);
  const observed = sorted.slice(split);
  const windowStart = observed[0]?.ts ?? query.from;
  const windowEnd = query.to;
  const definitions = [
    { kind: "spend" as const, label: "Unusual spend", base: Number(baseline.reduce((sum, event) => sum + BigInt(event.costBilledMicros), 0n)) / baseline.length, value: Number(observed.reduce((sum, event) => sum + BigInt(event.costBilledMicros), 0n)) / observed.length, unit: "micros per request" },
    { kind: "failures" as const, label: "Elevated failure rate", base: baseline.filter((event) => !isSuccess(event.status)).length / baseline.length, value: observed.filter((event) => !isSuccess(event.status)).length / observed.length, unit: "ratio" },
    { kind: "latency" as const, label: "Latency regression", base: average(baseline.flatMap((event) => event.latencyMs === null ? [] : [event.latencyMs])), value: average(observed.flatMap((event) => event.latencyMs === null ? [] : [event.latencyMs])), unit: "ms" },
  ];
  return definitions.filter((entry) => entry.base > 0 && entry.value >= entry.base * 1.5).map((entry) => ({
    id: `${entry.kind}:${windowStart}`, kind: entry.kind, severity: entry.value >= entry.base * 2 ? "error" : "warning",
    label: entry.label, baseline: entry.base, observed: entry.value, unit: entry.unit, windowStart, windowEnd,
    dimension: { kind: "organization", id: null, label: "Organization" },
    explanation: `${entry.label}: observed ${formatNumber(entry.value)} ${entry.unit}, compared with a baseline of ${formatNumber(entry.base)} during the earlier part of this window.`,
  }));
}

function requestPageFromEvents(events: CloudUsageEventRecord[], query: UsageAnalyticsQuery): UsageRequestPage {
  const sorted = [...events].sort((a, b) => b.ts.localeCompare(a.ts) || b.id.localeCompare(a.id));
  const cursorIndex = query.cursor ? sorted.findIndex((event) => requestCursor(event) === query.cursor) : -1;
  const start = cursorIndex >= 0 ? cursorIndex + 1 : 0;
  return requestPageFromOrderedEvents(sorted.slice(start, start + query.limit + 1), query.limit);
}

function requestPageFromOrderedEvents(events: CloudUsageEventRecord[], limit: number): UsageRequestPage {
  const hasMore = events.length > limit;
  const pageEvents = events.slice(0, limit);
  const last = pageEvents.at(-1);
  return UsageRequestPageSchema.parse({
    items: pageEvents.map(requestSummaryFromEvent),
    hasMore,
    nextCursor: hasMore && last ? requestCursor(last) : null,
  });
}

function requestSummaryFromEvent(event: CloudUsageEventRecord) {
  const status = reservationStatus(event.metadata);
  return {
    id: event.id, requestId: redactRequestId(event.requestId), ts: event.ts, userId: event.userId,
    departmentId: event.departmentId, workspaceId: event.workspaceId, agentId: event.agentId,
    feature: event.feature, provider: event.provider, model: event.model, status: event.status,
    tokensIn: event.tokensIn, tokensOut: event.tokensOut, tokensCached: event.tokensCached,
    cacheReadTokens: event.cacheReadTokens, cacheWriteTokens: event.cacheWriteTokens,
    cacheEligible: event.cacheEligible, cacheMissReason: event.cacheMissReason,
    finishReason: metadataString(event.metadata, "finishReason"),
    billedCostMicros: event.costBilledMicros, latencyMs: event.latencyMs, ttftMs: event.ttftMs,
    reservationStatus: status,
  };
}

function usageBucketMs(from: Date, to: Date): number {
  const duration = Math.max(60_000, to.getTime() - from.getTime());
  if (duration <= 30 * 60_000) return 60_000;
  if (duration <= 3 * 3_600_000) return 5 * 60_000;
  if (duration <= 24 * 3_600_000) return 30 * 60_000;
  if (duration <= 7 * 86_400_000) return 6 * 3_600_000;
  if (duration <= 35 * 86_400_000) return 86_400_000;
  if (duration <= 100 * 86_400_000) return 3 * 86_400_000;
  if (duration <= 370 * 86_400_000) return 30 * 86_400_000;
  return 90 * 86_400_000;
}

function metadataString(value: JsonValue, key: string): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value[key];
  return typeof candidate === "string" ? candidate : null;
}

function requestDetailFromEvent(event: CloudUsageEventRecord): UsageRequestDetail {
  const metadata = event.metadata && typeof event.metadata === "object" && !Array.isArray(event.metadata) ? event.metadata : {};
  const safeMetadata = Object.fromEntries(["region", "attempt", "cacheHit", "finishReason"].flatMap((key) => {
    const value = metadata[key];
    return value === null || ["string", "number", "boolean"].includes(typeof value) ? [[key, value]] : [];
  }));
  return UsageRequestDetailSchema.parse({ ...requestSummaryFromEvent(event), taskId: event.taskId, sessionId: event.sessionId, sandboxId: event.sandboxId, reservationId: typeof metadata.reservationId === "string" ? metadata.reservationId : null, safeMetadata });
}

function requestCursor(event: CloudUsageEventRecord): string { return `${event.ts}|${event.id}`; }
function parseRequestCursor(cursor: string | undefined): { ts: string; id: string } | null {
  if (!cursor) return null;
  const separator = cursor.lastIndexOf("|");
  if (separator <= 0) return null;
  const ts = cursor.slice(0, separator);
  const id = cursor.slice(separator + 1);
  if (Number.isNaN(new Date(ts).getTime()) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return null;
  return { ts: new Date(ts).toISOString(), id };
}
function redactRequestId(value: string): string { return value.length <= 12 ? value : `${value.slice(0, 6)}…${value.slice(-4)}`; }
function isSuccess(status: string): boolean { return ["completed", "success", "succeeded"].includes(status); }
function percentile(values: number[], ratio: number): number | null { return values.length ? values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * ratio) - 1))]! : null; }
function average(values: number[]): number { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function formatNumber(value: number): string { return Number.isInteger(value) ? String(value) : value.toFixed(2); }
function sandboxMinutesFor(value: JsonValue): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  const minutes = value.minutes;
  if (typeof minutes === "number") return Math.max(0, minutes);
  const milliseconds = value.duration_ms ?? value.cpu_ms;
  return typeof milliseconds === "number" ? Math.max(0, milliseconds / 60_000) : 0;
}
function reservationStatus(value: JsonValue): "reserved" | "reconciled" | "released" | "blocked" | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const status = value.reservationStatus;
  return status === "reserved" || status === "reconciled" || status === "released" || status === "blocked" ? status : null;
}

function usageEventFromRow(row: UsageEventRow): CloudUsageEventRecord {
  return CloudUsageEventRecordSchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    requestId: row.request_id,
    source: row.source ?? "api",
    taskId: row.task_id,
    sessionId: row.session_id,
    toolCallId: row.tool_call_id,
    feature: row.feature,
    provider: row.provider,
    model: row.model,
    userId: row.user_id ?? null,
    departmentId: row.department_id ?? null,
    workspaceId: row.workspace_id ?? null,
    agentId: row.agent_id ?? null,
    sandboxId: row.sandbox_id ?? null,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    tokensCached: row.tokens_cached,
    cacheReadTokens: row.cache_read_tokens ?? row.tokens_cached,
    cacheWriteTokens: row.cache_write_tokens ?? 0,
    cacheCreationTokens1h: row.cache_creation_tokens_1h ?? 0,
    cacheCreationTokens5m: row.cache_creation_tokens_5m ?? 0,
    cacheEligible: row.cache_eligible ?? false,
    cacheProvider: row.cache_provider ?? null,
    cacheKeyHash: row.cache_key_hash ?? null,
    promptManifestHash: row.prompt_manifest_hash ?? null,
    cacheMissReason: row.cache_miss_reason ?? null,
    sandboxUsage: row.sandbox_usage ?? {},
    costRawMicros: String(row.cost_raw_micros),
    costBilledMicros: String(row.cost_billed_micros),
    latencyMs: row.latency_ms,
    ttftMs: row.ttft_ms,
    status: row.status,
    metadata: row.metadata ?? {},
    signedPayload: row.signed_payload ?? {},
    signature: signatureOrNull(row.signature),
    ts: iso(row.ts),
    createdAt: iso(row.created_at),
  });
}

function usageRollupFromRow(row: UsageRollupRow): CloudUsageRollup {
  return CloudUsageRollupSchema.parse({
    tenantId: row.tenant_id,
    bucketStart: iso(row.bucket_start),
    bucketEnd: iso(row.bucket_end),
    granularity: row.granularity,
    feature: row.feature,
    provider: row.provider,
    model: row.model,
    userId: row.user_id ?? null,
    departmentId: row.department_id ?? null,
    workspaceId: row.workspace_id ?? null,
    agentId: row.agent_id ?? null,
    sandboxId: row.sandbox_id ?? null,
    status: row.status,
    requestCount: row.request_count,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    tokensCached: row.tokens_cached,
    cacheReadTokens: row.cache_read_tokens ?? row.tokens_cached,
    cacheWriteTokens: row.cache_write_tokens ?? 0,
    costRawMicros: String(row.cost_raw_micros),
    costBilledMicros: String(row.cost_billed_micros),
  });
}

function usageWhere(tenantId: string, filter: UsageEventFilter): { where: string; params: unknown[] } {
  const clauses = ["tenant_id = $1::uuid"];
  const params: unknown[] = [tenantId];
  for (const [column, value] of [
    ["ts >=", filter.from?.toISOString()],
    ["ts <", filter.to?.toISOString()],
    ["feature =", filter.feature],
    ["user_id =", filter.userId],
    ["department_id =", filter.departmentId],
    ["model =", filter.model],
    ["provider =", filter.provider],
    ["status =", filter.status],
    ["workspace_id =", filter.workspaceId],
    ["agent_id =", filter.agentId],
  ] as const) {
    if (!value) continue;
    params.push(value);
    clauses.push(`${column} $${params.length}${column.endsWith("=") && (column.startsWith("user_id") || column.startsWith("department_id") || column.startsWith("workspace_id")) ? "::uuid" : ""}`);
  }
  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

function usageEventQuery(
  tenantId: string,
  filter: UsageEventFilter,
  direction: "asc" | "desc",
): { where: string; params: unknown[]; limitClause: string } {
  const query = usageWhere(tenantId, filter);
  const cursor = parseRequestCursor(filter.cursor);
  if (cursor) {
    query.params.push(cursor.ts, cursor.id);
    const timestampParam = `$${query.params.length - 1}::timestamptz`;
    const idParam = `$${query.params.length}::uuid`;
    const operator = direction === "asc" ? ">" : "<";
    query.where += ` AND (ts ${operator} ${timestampParam} OR (ts = ${timestampParam} AND id ${operator} ${idParam}))`;
  }
  let limitClause = "";
  if (filter.limit !== undefined) {
    query.params.push(filter.limit);
    limitClause = ` LIMIT $${query.params.length}`;
  }
  return { ...query, limitClause };
}

function utcDayStart(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll("\"", "\"\"")}"` : value;
}

function uuidOrNull(value: string | null | undefined): string | null {
  return value && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
}

function signatureOrNull(value: JsonValue | null | undefined): JsonValue | null {
  return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0 ? value : null;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

type UsageEventRow = {
  id: string;
  tenant_id: string;
  request_id: string;
  source: "api" | "router" | "sandbox" | "fixture";
  user_id: string | null;
  department_id: string | null;
  workspace_id: string | null;
  task_id: string | null;
  session_id: string | null;
  tool_call_id: string | null;
  feature: string;
  provider: string | null;
  model: string | null;
  agent_id: string | null;
  sandbox_id: string | null;
  tokens_in: number;
  tokens_out: number;
  tokens_cached: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cache_creation_tokens_1h: number;
  cache_creation_tokens_5m: number;
  cache_eligible: boolean;
  cache_provider: string | null;
  cache_key_hash: string | null;
  prompt_manifest_hash: string | null;
  cache_miss_reason: string | null;
  sandbox_usage: JsonValue;
  cost_raw_micros: string;
  cost_billed_micros: string;
  latency_ms: number | null;
  ttft_ms: number | null;
  status: string;
  metadata: JsonValue;
  signed_payload: JsonValue;
  signature: JsonValue;
  ts: Date | string;
  created_at: Date | string;
};

type UsageRollupRow = {
  tenant_id: string;
  bucket_start: Date | string;
  bucket_end: Date | string;
  granularity: "day";
  feature: string;
  provider: string | null;
  model: string | null;
  user_id: string | null;
  department_id: string | null;
  workspace_id: string | null;
  agent_id: string | null;
  sandbox_id: string | null;
  status: string;
  request_count: number;
  tokens_in: number;
  tokens_out: number;
  tokens_cached: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_raw_micros: string;
  cost_billed_micros: string;
};

type UsageAnalyticsTotalsRow = {
  requests: number | string;
  billed_cost_micros: string;
  input_tokens: number | string;
  output_tokens: number | string;
  successes: number | string;
  latency_p50_ms: number | string | null;
  latency_p95_ms: number | string | null;
  ttft_p50_ms: number | string | null;
  ttft_p95_ms: number | string | null;
  cached_tokens: number | string;
  cache_read_tokens: number | string;
  cache_write_tokens: number | string;
  cache_eligible_requests: number | string;
  cache_hit_requests: number | string;
  sandbox_minutes: number | string;
  attributed_agents: number | string;
};

type UsageAnalyticsSeriesRow = {
  bucket: Date | string;
  billed_cost_micros: string;
  requests: number | string;
  tokens: number | string;
  successes: number | string;
  failures: number | string;
};

type UsageAnalyticsBreakdownRow = {
  dimension: string;
  dimension_id: string | null;
  requests: number | string;
  billed_cost_micros: string;
  tokens: number | string;
  input_tokens: number | string;
  output_tokens: number | string;
  cache_read_tokens: number | string;
  cache_write_tokens: number | string;
  failures: number | string;
  latency_p50_ms: number | string | null;
  latency_p95_ms: number | string | null;
};
