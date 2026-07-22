import type { JsonValue } from "@berry/shared";
import type { UsageRollupJobPayload } from "./jobs.js";

export interface UsageEventRecord {
  tenantId: string;
  userId: string | null;
  departmentId: string | null;
  workspaceId: string | null;
  agentId: string | null;
  sandboxId: string | null;
  feature: string;
  provider: string | null;
  model: string | null;
  status: string;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  costRawMicros: string | number | bigint;
  costBilledMicros: string | number | bigint;
  latencyMs: number | null;
  ttftMs: number | null;
  ts: Date;
}

export interface UsageRollupRecord {
  tenantId: string;
  userId: string | null;
  departmentId: string | null;
  workspaceId: string | null;
  agentId: string | null;
  sandboxId: string | null;
  bucketStart: Date;
  bucketEnd: Date;
  granularity: "day";
  feature: string;
  provider: string | null;
  model: string | null;
  status: string;
  requestCount: number;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  costRawMicros: string;
  costBilledMicros: string;
  latencyMsTotal: number;
  latencyMsCount: number;
  ttftMsTotal: number;
  ttftMsCount: number;
  sourceEventMinTs: Date;
  sourceEventMaxTs: Date;
  metadata: JsonValue;
}

export interface UsageRollupRepository {
  listUsageEvents(input: { tenantId: string; from: Date; to: Date }): Promise<UsageEventRecord[]>;
  upsertUsageRollups(rollups: UsageRollupRecord[]): Promise<void>;
}

export async function processUsageRollupJob(
  payload: UsageRollupJobPayload,
  dependencies: { usage: UsageRollupRepository },
): Promise<{ rollups: number; events: number }> {
  const from = new Date(payload.from);
  const to = new Date(payload.to);
  if (!(from < to)) throw new Error("Usage rollup window must have from < to");
  const events = await dependencies.usage.listUsageEvents({ tenantId: payload.tenantId, from, to });
  const rollups = aggregateDailyUsage(events);
  await dependencies.usage.upsertUsageRollups(rollups);
  return { rollups: rollups.length, events: events.length };
}

export function aggregateDailyUsage(events: UsageEventRecord[]): UsageRollupRecord[] {
  const groups = new Map<string, UsageRollupRecord>();
  for (const event of events) {
    const bucketStart = utcDayStart(event.ts);
    const bucketEnd = new Date(bucketStart.getTime() + 24 * 60 * 60 * 1000);
    const key = [
      event.tenantId,
      bucketStart.toISOString(),
      event.feature,
      event.provider ?? "",
      event.model ?? "",
      event.status,
      event.userId ?? "",
      event.departmentId ?? "",
      event.workspaceId ?? "",
      event.agentId ?? "",
      event.sandboxId ?? "",
    ].join("\u0000");
    const current = groups.get(key);
    if (!current) {
      groups.set(key, {
        tenantId: event.tenantId,
        userId: event.userId,
        departmentId: event.departmentId,
        workspaceId: event.workspaceId,
        agentId: event.agentId,
        sandboxId: event.sandboxId,
        bucketStart,
        bucketEnd,
        granularity: "day",
        feature: event.feature,
        provider: event.provider,
        model: event.model,
        status: event.status,
        requestCount: 1,
        tokensIn: event.tokensIn,
        tokensOut: event.tokensOut,
        tokensCached: event.tokensCached,
        costRawMicros: microsToString(event.costRawMicros),
        costBilledMicros: microsToString(event.costBilledMicros),
        latencyMsTotal: event.latencyMs ?? 0,
        latencyMsCount: event.latencyMs === null ? 0 : 1,
        ttftMsTotal: event.ttftMs ?? 0,
        ttftMsCount: event.ttftMs === null ? 0 : 1,
        sourceEventMinTs: event.ts,
        sourceEventMaxTs: event.ts,
        metadata: {},
      });
      continue;
    }
    current.requestCount += 1;
    current.tokensIn += event.tokensIn;
    current.tokensOut += event.tokensOut;
    current.tokensCached += event.tokensCached;
    current.costRawMicros = (BigInt(current.costRawMicros) + toBigIntMicros(event.costRawMicros)).toString();
    current.costBilledMicros = (BigInt(current.costBilledMicros) + toBigIntMicros(event.costBilledMicros)).toString();
    if (event.latencyMs !== null) {
      current.latencyMsTotal += event.latencyMs;
      current.latencyMsCount += 1;
    }
    if (event.ttftMs !== null) {
      current.ttftMsTotal += event.ttftMs;
      current.ttftMsCount += 1;
    }
    if (event.ts < current.sourceEventMinTs) current.sourceEventMinTs = event.ts;
    if (event.ts > current.sourceEventMaxTs) current.sourceEventMaxTs = event.ts;
  }
  return [...groups.values()].sort((a, b) => a.bucketStart.getTime() - b.bucketStart.getTime()
    || a.feature.localeCompare(b.feature)
    || (a.provider ?? "").localeCompare(b.provider ?? "")
    || (a.model ?? "").localeCompare(b.model ?? "")
    || a.status.localeCompare(b.status));
}

function utcDayStart(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function microsToString(value: string | number | bigint): string {
  return toBigIntMicros(value).toString();
}

function toBigIntMicros(value: string | number | bigint): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  return BigInt(value);
}
