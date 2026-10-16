import { createHash } from "node:crypto";
import type { DurableProviderTransport, OperationalWorkerRole } from "@berry/shared";
import type { ProviderBalanceCheckJobPayload } from "./jobs.js";
import type { SqlExecutor } from "./sql-repositories.js";
import { emitWorkerOperationalEvent } from "./operational-telemetry.js";
import { withTenantTransaction, type ProviderCreditAlertDefaults } from "./provider-credit-alerts.js";
import type { ProviderCreditAlertSink } from "./provider-credits.js";
import { resolveDurableCredential } from "./turn-runner.js";

/**
 * Periodic low-balance check (H-005). Only providers with a documented balance
 * API are checked: OpenRouter and DeepSeek. A key is sent only to the HTTPS
 * origin of the provider it belongs to.
 */
export type ProviderBalance = {
  /** Spendable amount in `currency`, or null when the provider does not report one. */
  remaining: number | null;
  currency: string;
  /** The provider's own "can this key make requests" flag, when it has one. */
  available: boolean | null;
};

export interface ProviderBalanceProbe {
  readonly kind: "openrouter" | "deepseek";
  matches(url: URL): boolean;
  read(input: { baseUrl: URL; apiKey: string; fetch: typeof fetch; signal: AbortSignal }): Promise<ProviderBalance>;
}

export class ProviderBalanceRequestError extends Error {
  constructor(readonly host: string, readonly path: string, readonly status: number) {
    super(`Balance request to ${host}${path} returned HTTP ${status}`);
    this.name = "ProviderBalanceRequestError";
  }
}

/**
 * OpenRouter: `GET /api/v1/key` reports `limit_remaining` when the key has a
 * spending limit, and `GET /api/v1/credits` the account's purchased and used
 * credit. The lower of the two is what the key can still spend.
 */
export const openRouterBalanceProbe: ProviderBalanceProbe = {
  kind: "openrouter",
  matches: (url) => url.protocol === "https:" && url.hostname === "openrouter.ai",
  async read({ baseUrl, apiKey, fetch: request, signal }) {
    const keyRemaining = parseOpenRouterKey(await getJson(request, new URL("/api/v1/key", baseUrl.origin), apiKey, signal));
    const accountRemaining = await getJson(request, new URL("/api/v1/credits", baseUrl.origin), apiKey, signal)
      .then(parseOpenRouterCredits, () => null);
    const known = [keyRemaining, accountRemaining].filter((value): value is number => value !== null);
    return { remaining: known.length > 0 ? Math.min(...known) : null, currency: "USD", available: null };
  },
};

/** DeepSeek: `GET /user/balance` returns `is_available` and `balance_infos[].total_balance`. */
export const deepSeekBalanceProbe: ProviderBalanceProbe = {
  kind: "deepseek",
  matches: (url) => url.protocol === "https:" && url.hostname === "api.deepseek.com",
  async read({ baseUrl, apiKey, fetch: request, signal }) {
    return parseDeepSeekBalance(await getJson(request, new URL("/user/balance", baseUrl.origin), apiKey, signal));
  },
};

export const PROVIDER_BALANCE_PROBES: readonly ProviderBalanceProbe[] = [openRouterBalanceProbe, deepSeekBalanceProbe];

export function parseOpenRouterKey(body: unknown): number | null {
  return finiteNumber(record(record(body)?.data)?.limit_remaining);
}

export function parseOpenRouterCredits(body: unknown): number | null {
  const data = record(record(body)?.data);
  const total = finiteNumber(data?.total_credits);
  const used = finiteNumber(data?.total_usage);
  return total === null || used === null ? null : total - used;
}

/** Uses the largest balance when the account reports more than one currency. */
export function parseDeepSeekBalance(body: unknown): ProviderBalance {
  const data = record(body);
  const available = typeof data?.is_available === "boolean" ? data.is_available : null;
  let best: { remaining: number; currency: string } | null = null;
  for (const candidate of Array.isArray(data?.balance_infos) ? data.balance_infos : []) {
    const entry = record(candidate);
    const remaining = finiteNumber(entry?.total_balance);
    const currency = typeof entry?.currency === "string" ? entry.currency.trim().toUpperCase().slice(0, 16) : "";
    if (remaining === null || !currency) continue;
    if (!best || remaining > best.remaining) best = { remaining, currency };
  }
  return { remaining: best?.remaining ?? null, currency: best?.currency ?? "USD", available };
}

export type ProviderBalanceState = "ok" | "low" | "exhausted" | "unknown";

export function assessProviderBalance(balance: ProviderBalance, threshold: number): ProviderBalanceState {
  if (balance.available === false) return "exhausted";
  if (balance.remaining === null) return "unknown";
  if (balance.remaining <= 0) return "exhausted";
  return balance.remaining < threshold ? "low" : "ok";
}

export type ProviderBalanceConfig = {
  /** 0 turns the periodic check off. */
  intervalMs: number;
  defaultThreshold: number;
  /** Per provider ID or probe kind (`openrouter`, `deepseek`), in the account's currency. */
  thresholds: Record<string, number>;
};

export const DEFAULT_PROVIDER_BALANCE_CHECK_MINUTES = 30;
export const DEFAULT_PROVIDER_LOW_BALANCE_THRESHOLD = 10;

export function providerBalanceConfigFromEnv(env: NodeJS.ProcessEnv): ProviderBalanceConfig {
  const rawInterval = env.BERRY_PROVIDER_BALANCE_CHECK_INTERVAL_MINUTES?.trim();
  const minutes = rawInterval ? Number(rawInterval) : DEFAULT_PROVIDER_BALANCE_CHECK_MINUTES;
  const intervalMinutes = !Number.isFinite(minutes)
    ? DEFAULT_PROVIDER_BALANCE_CHECK_MINUTES
    : minutes <= 0 ? 0 : Math.min(Math.max(Math.round(minutes), 5), 1_440);
  const rawThreshold = env.BERRY_PROVIDER_LOW_BALANCE_THRESHOLD?.trim();
  const threshold = rawThreshold ? Number(rawThreshold) : DEFAULT_PROVIDER_LOW_BALANCE_THRESHOLD;
  return {
    intervalMs: intervalMinutes * 60_000,
    defaultThreshold: Number.isFinite(threshold) && threshold >= 0 ? threshold : DEFAULT_PROVIDER_LOW_BALANCE_THRESHOLD,
    thresholds: thresholdMap(env.BERRY_PROVIDER_LOW_BALANCE_THRESHOLDS_JSON),
  };
}

export function providerBalanceThreshold(config: ProviderBalanceConfig, providerId: string, kind: ProviderBalanceProbe["kind"]): number {
  return config.thresholds[providerId] ?? config.thresholds[kind] ?? config.defaultThreshold;
}

/** Schedules one check per tenant and interval; the dedupe key makes every worker agree. */
export async function enqueueProviderBalanceCheck(executor: SqlExecutor, tenantId: string, scheduledFor: string): Promise<void> {
  await executor.execute(
    `
INSERT INTO runtime_outbox (tenant_id,event_type,aggregate_id,dedupe_key,payload)
VALUES ($1::uuid,'alerts.provider-balance','provider-balance',$2,$3::jsonb)
ON CONFLICT (tenant_id,dedupe_key) DO NOTHING
    `.trim(),
    [tenantId, `provider-balance/${scheduledFor}`, JSON.stringify({ tenantId, scheduledFor })],
  );
}

type BalanceTarget = {
  providerId: string;
  providerName: string;
  baseUrl: string;
  apiKey: () => Promise<string | undefined>;
};

export type ProviderBalanceCheckResult = { checked: number; low: number; exhausted: number; failed: number };

export class ProviderBalanceChecker {
  constructor(private readonly options: {
    executor: SqlExecutor;
    env: NodeJS.ProcessEnv;
    sink: ProviderCreditAlertSink;
    config: ProviderBalanceConfig;
    defaults: ProviderCreditAlertDefaults;
    fetch?: typeof fetch;
    probes?: readonly ProviderBalanceProbe[];
    timeoutMs?: number;
    now?: () => Date;
    workerRole?: OperationalWorkerRole;
    sourceRevision?: string;
  }) {}

  async check(payload: ProviderBalanceCheckJobPayload): Promise<ProviderBalanceCheckResult> {
    const result: ProviderBalanceCheckResult = { checked: 0, low: 0, exhausted: 0, failed: 0 };
    const probes = this.options.probes ?? PROVIDER_BALANCE_PROBES;
    const seen = new Set<string>();
    for (const target of await this.targets(payload.tenantId)) {
      let url: URL;
      try {
        url = new URL(target.baseUrl);
      } catch {
        continue;
      }
      const probe = probes.find((candidate) => candidate.matches(url));
      if (!probe) continue;
      const apiKey = await target.apiKey().catch(() => undefined);
      if (!apiKey) continue;
      // The same account configured twice (for example as the router and as an
      // organization provider) is checked and reported once.
      const identity = `${probe.kind}|${url.origin}|${createHash("sha256").update(apiKey).digest("hex")}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      let balance: ProviderBalance;
      try {
        balance = await probe.read({
          baseUrl: url,
          apiKey,
          fetch: this.options.fetch ?? fetch,
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
        });
      } catch {
        result.failed += 1;
        continue;
      }
      result.checked += 1;
      const threshold = providerBalanceThreshold(this.options.config, target.providerId, probe.kind);
      const state = assessProviderBalance(balance, threshold);
      if (state !== "low" && state !== "exhausted") continue;
      result[state] += 1;
      await this.options.sink.raise({
        tenantId: payload.tenantId,
        event: state,
        surface: "balance",
        providerId: target.providerId,
        providerName: target.providerName,
        providerHost: url.hostname,
        detectedAt: (this.options.now?.() ?? new Date()).toISOString(),
        status: null,
        balance: balance.remaining === null ? null : { remaining: balance.remaining, threshold, currency: balance.currency },
      });
    }
    emitWorkerOperationalEvent(
      "phase.transition",
      this.options.workerRole ?? "unknown",
      this.options.sourceRevision ?? "unknown",
      {
        phase: "provider_balance_check",
        outcome: result.failed > 0 ? "partial" : "completed",
        completedCount: result.checked,
        failedCount: result.failed,
        itemCount: result.low + result.exhausted,
      },
    );
    return result;
  }

  /** The deployment's router and the tenant's enabled organization providers. */
  private async targets(tenantId: string): Promise<BalanceTarget[]> {
    const { env, defaults } = this.options;
    const targets: BalanceTarget[] = [];
    const routerUrl = env.BERRY_ROUTER_INFERENCE_BASE_URL?.trim();
    const routerKey = env.BERRY_ROUTER_API_KEY?.trim();
    if (routerUrl && routerKey) {
      targets.push({
        providerId: defaults.providerId,
        providerName: defaults.providerName,
        baseUrl: routerUrl,
        apiKey: async () => routerKey,
      });
    }
    const rows = await withTenantTransaction(this.options.executor, tenantId, (executor) => executor.query<{
      provider_id: string;
      display_name: string;
      base_url: string;
      auth_type: string;
      credential_ref: string | null;
    }>(
      `
SELECT provider_id,display_name,base_url,auth_type,credential_ref
FROM organization_model_providers
WHERE tenant_id=$1::uuid AND enabled
ORDER BY provider_id
      `.trim(),
      [tenantId],
    ));
    for (const row of rows) {
      targets.push({
        providerId: row.provider_id,
        providerName: row.display_name,
        baseUrl: row.base_url,
        apiKey: () => resolveDurableCredential({
          id: row.provider_id,
          authType: row.auth_type,
          ...(row.credential_ref ? { credentialRef: row.credential_ref } : {}),
        } as DurableProviderTransport, env),
      });
    }
    return targets;
  }
}

async function getJson(request: typeof fetch, url: URL, apiKey: string, signal: AbortSignal): Promise<unknown> {
  const response = await request(url, {
    method: "GET",
    headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
    redirect: "error",
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProviderBalanceRequestError(url.host, url.pathname, response.status);
  }
  return response.json();
}

function thresholdMap(raw: string | undefined): Record<string, number> {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    const entries = Object.entries(record(parsed) ?? {});
    return Object.fromEntries(entries.filter((entry): entry is [string, number] =>
      typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] >= 0
    ));
  } catch {
    return {};
  }
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
