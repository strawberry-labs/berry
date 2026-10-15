import { describe, expect, it, vi } from "vitest";
import {
  ProviderBalanceChecker,
  assessProviderBalance,
  deepSeekBalanceProbe,
  enqueueProviderBalanceCheck,
  openRouterBalanceProbe,
  parseDeepSeekBalance,
  parseOpenRouterCredits,
  parseOpenRouterKey,
  providerBalanceConfigFromEnv,
  providerBalanceThreshold,
} from "./provider-balance.js";
import type { ProviderCreditAlert } from "./provider-credits.js";
import type { SqlExecutor } from "./sql-repositories.js";

const tenantId = "00000000-0000-7000-8000-000000000001";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("provider balance parsing (H-005)", () => {
  it("reads OpenRouter key limits and account credits", () => {
    expect(parseOpenRouterKey({ data: { label: "berry", usage: 12.5, limit: 50, limit_remaining: 37.5, is_free_tier: false } })).toBe(37.5);
    expect(parseOpenRouterKey({ data: { usage: 12.5, limit: null, limit_remaining: null } })).toBeNull();
    expect(parseOpenRouterKey({})).toBeNull();
    expect(parseOpenRouterCredits({ data: { total_credits: 100, total_usage: 93.25 } })).toBeCloseTo(6.75);
    expect(parseOpenRouterCredits({ data: { total_credits: 100 } })).toBeNull();
    expect(parseOpenRouterCredits("not json")).toBeNull();
  });

  it("reads DeepSeek balances, using the largest when there are several currencies", () => {
    expect(parseDeepSeekBalance({
      is_available: true,
      balance_infos: [
        { currency: "USD", total_balance: "3.10", granted_balance: "0.00", topped_up_balance: "3.10" },
        { currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" },
      ],
    })).toEqual({ remaining: 110, currency: "CNY", available: true });
    expect(parseDeepSeekBalance({ is_available: false, balance_infos: [] })).toEqual({ remaining: null, currency: "USD", available: false });
    expect(parseDeepSeekBalance({ balance_infos: [{ currency: "USD", total_balance: "" }] })).toEqual({ remaining: null, currency: "USD", available: null });
  });

  it("classifies balances against the threshold", () => {
    expect(assessProviderBalance({ remaining: 25, currency: "USD", available: null }, 10)).toBe("ok");
    expect(assessProviderBalance({ remaining: 10, currency: "USD", available: null }, 10)).toBe("ok");
    expect(assessProviderBalance({ remaining: 9.99, currency: "USD", available: null }, 10)).toBe("low");
    expect(assessProviderBalance({ remaining: 0, currency: "USD", available: null }, 10)).toBe("exhausted");
    expect(assessProviderBalance({ remaining: -0.4, currency: "USD", available: null }, 10)).toBe("exhausted");
    expect(assessProviderBalance({ remaining: 50, currency: "CNY", available: false }, 10)).toBe("exhausted");
    expect(assessProviderBalance({ remaining: null, currency: "USD", available: true }, 10)).toBe("unknown");
    expect(assessProviderBalance({ remaining: 5, currency: "USD", available: null }, 0)).toBe("ok");
  });

  it("reads the schedule and thresholds from the environment", () => {
    expect(providerBalanceConfigFromEnv({})).toEqual({ intervalMs: 30 * 60_000, defaultThreshold: 10, thresholds: {} });
    expect(providerBalanceConfigFromEnv({ BERRY_PROVIDER_BALANCE_CHECK_INTERVAL_MINUTES: "60" }).intervalMs).toBe(60 * 60_000);
    expect(providerBalanceConfigFromEnv({ BERRY_PROVIDER_BALANCE_CHECK_INTERVAL_MINUTES: "1" }).intervalMs).toBe(5 * 60_000);
    expect(providerBalanceConfigFromEnv({ BERRY_PROVIDER_BALANCE_CHECK_INTERVAL_MINUTES: "0" }).intervalMs).toBe(0);
    expect(providerBalanceConfigFromEnv({ BERRY_PROVIDER_BALANCE_CHECK_INTERVAL_MINUTES: "9999" }).intervalMs).toBe(1_440 * 60_000);
    expect(providerBalanceConfigFromEnv({ BERRY_PROVIDER_BALANCE_CHECK_INTERVAL_MINUTES: "soon" }).intervalMs).toBe(30 * 60_000);
    const config = providerBalanceConfigFromEnv({
      BERRY_PROVIDER_LOW_BALANCE_THRESHOLD: "25",
      BERRY_PROVIDER_LOW_BALANCE_THRESHOLDS_JSON: '{"router":50,"deepseek":100,"broken":-1,"text":"5"}',
    });
    expect(config).toMatchObject({ defaultThreshold: 25, thresholds: { router: 50, deepseek: 100 } });
    expect(providerBalanceThreshold(config, "router", "openrouter")).toBe(50);
    expect(providerBalanceThreshold(config, "deepseek-main", "deepseek")).toBe(100);
    expect(providerBalanceThreshold(config, "openrouter", "openrouter")).toBe(25);
    expect(providerBalanceConfigFromEnv({ BERRY_PROVIDER_LOW_BALANCE_THRESHOLD: "-3", BERRY_PROVIDER_LOW_BALANCE_THRESHOLDS_JSON: "{" }))
      .toMatchObject({ defaultThreshold: 10, thresholds: {} });
  });
});

describe("provider balance probes (H-005)", () => {
  it("asks OpenRouter's origin for the key limit and account credit and reports the lower", async () => {
    const request = vi.fn(async (url: URL | RequestInfo) => String(url).endsWith("/api/v1/key")
      ? jsonResponse({ data: { limit: 50, limit_remaining: 20 } })
      : jsonResponse({ data: { total_credits: 100, total_usage: 92 } }));
    await expect(openRouterBalanceProbe.read({
      baseUrl: new URL("https://openrouter.ai/api/v1"),
      apiKey: "sk-or-test",
      fetch: request as typeof fetch,
      signal: AbortSignal.timeout(1_000),
    })).resolves.toEqual({ remaining: 8, currency: "USD", available: null });
    expect(request.mock.calls.map(([url]) => String(url))).toEqual([
      "https://openrouter.ai/api/v1/key",
      "https://openrouter.ai/api/v1/credits",
    ]);
    const init = (request.mock.calls[0] as unknown as [URL, RequestInit])[1];
    expect(init).toMatchObject({ method: "GET", redirect: "error", headers: { authorization: "Bearer sk-or-test" } });
  });

  it("uses the key limit alone when the credits endpoint is refused, and fails when the key is rejected", async () => {
    const refusedCredits = vi.fn(async (url: URL | RequestInfo) => String(url).endsWith("/api/v1/key")
      ? jsonResponse({ data: { limit_remaining: 3.5 } })
      : jsonResponse({ error: "forbidden" }, 403));
    await expect(openRouterBalanceProbe.read({ baseUrl: new URL("https://openrouter.ai/api/v1"), apiKey: "k", fetch: refusedCredits as typeof fetch, signal: AbortSignal.timeout(1_000) }))
      .resolves.toEqual({ remaining: 3.5, currency: "USD", available: null });
    const rejected = vi.fn(async () => jsonResponse({ error: "invalid key" }, 401));
    await expect(openRouterBalanceProbe.read({ baseUrl: new URL("https://openrouter.ai/api/v1"), apiKey: "k", fetch: rejected as typeof fetch, signal: AbortSignal.timeout(1_000) }))
      .rejects.toThrow("Balance request to openrouter.ai/api/v1/key returned HTTP 401");
  });

  it("asks DeepSeek's origin for the user balance", async () => {
    const request = vi.fn(async () => jsonResponse({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "4.00" }] }));
    await expect(deepSeekBalanceProbe.read({ baseUrl: new URL("https://api.deepseek.com/v1"), apiKey: "sk-ds", fetch: request as typeof fetch, signal: AbortSignal.timeout(1_000) }))
      .resolves.toEqual({ remaining: 4, currency: "USD", available: true });
    expect(String((request.mock.calls[0] as unknown as [URL])[0])).toBe("https://api.deepseek.com/user/balance");
  });

  it("matches only the providers' own HTTPS hosts", () => {
    expect(openRouterBalanceProbe.matches(new URL("https://openrouter.ai/api/v1"))).toBe(true);
    expect(openRouterBalanceProbe.matches(new URL("http://openrouter.ai/api/v1"))).toBe(false);
    expect(openRouterBalanceProbe.matches(new URL("https://openrouter.ai.example.com/api/v1"))).toBe(false);
    expect(deepSeekBalanceProbe.matches(new URL("https://api.deepseek.com"))).toBe(true);
    expect(deepSeekBalanceProbe.matches(new URL("https://router.example.com/v1"))).toBe(false);
  });
});

describe("periodic provider balance check (H-005)", () => {
  function organizationProviders(rows: unknown[]): { executor: SqlExecutor; statements: string[] } {
    const statements: string[] = [];
    const executor: SqlExecutor = {
      execute: async (sql) => { statements.push(sql); },
      query: async <T>(sql: string) => {
        statements.push(sql);
        return (sql.includes("FROM organization_model_providers") ? rows : []) as T[];
      },
      transaction: async (callback) => callback(executor),
    };
    return { executor, statements };
  }

  it("raises low and exhausted alerts for checked providers and sends each key only to its own provider", async () => {
    const { executor, statements } = organizationProviders([
      { provider_id: "deepseek", display_name: "DeepSeek", base_url: "https://api.deepseek.com/v1", auth_type: "bearer", credential_ref: "env:DEEPSEEK_API_KEY" },
      { provider_id: "openrouter-copy", display_name: "OpenRouter again", base_url: "https://openrouter.ai/api/v1", auth_type: "bearer", credential_ref: "OPENROUTER_API_KEY" },
      { provider_id: "gemini", display_name: "Gemini", base_url: "https://generativelanguage.googleapis.com/v1beta/openai", auth_type: "bearer", credential_ref: "GEMINI_API_KEY" },
      { provider_id: "missing-key", display_name: "Unconfigured", base_url: "https://api.deepseek.com/v1", auth_type: "bearer", credential_ref: "MISSING_KEY" },
    ]);
    const requests: Array<{ url: string; authorization: string }> = [];
    const request = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      requests.push({ url: String(url), authorization: String((init?.headers as Record<string, string>).authorization) });
      if (String(url).startsWith("https://api.deepseek.com/")) return jsonResponse({ is_available: false, balance_infos: [{ currency: "CNY", total_balance: "0.00" }] });
      if (String(url).endsWith("/api/v1/key")) return jsonResponse({ data: { limit_remaining: null } });
      return jsonResponse({ data: { total_credits: 20, total_usage: 15.5 } });
    });
    const raised: ProviderCreditAlert[] = [];
    const checker = new ProviderBalanceChecker({
      executor,
      env: {
        BERRY_ROUTER_INFERENCE_BASE_URL: "https://openrouter.ai/api/v1",
        BERRY_ROUTER_API_KEY: "sk-or-shared",
        OPENROUTER_API_KEY: "sk-or-shared",
        DEEPSEEK_API_KEY: "sk-ds",
        GEMINI_API_KEY: "gemini-key",
      },
      sink: { raise: async (alert) => { raised.push(alert); } },
      config: { intervalMs: 30 * 60_000, defaultThreshold: 10, thresholds: {} },
      defaults: { providerId: "router", providerName: "Berry Router", providerHost: "openrouter.ai" },
      fetch: request as typeof fetch,
      now: () => new Date("2026-10-15T09:30:00.000Z"),
    });

    await expect(checker.check({ tenantId, scheduledFor: "2026-10-15T09:30:00.000Z" }))
      .resolves.toEqual({ checked: 2, low: 1, exhausted: 1, failed: 0 });

    expect(statements.some((sql) => sql.includes("WHERE tenant_id=$1::uuid AND enabled"))).toBe(true);
    // The router and the organization's copy share one OpenRouter key: checked once.
    expect(requests).toEqual([
      { url: "https://openrouter.ai/api/v1/key", authorization: "Bearer sk-or-shared" },
      { url: "https://openrouter.ai/api/v1/credits", authorization: "Bearer sk-or-shared" },
      { url: "https://api.deepseek.com/user/balance", authorization: "Bearer sk-ds" },
    ]);
    expect(raised).toEqual([
      {
        tenantId,
        event: "low",
        surface: "balance",
        providerId: "router",
        providerName: "Berry Router",
        providerHost: "openrouter.ai",
        detectedAt: "2026-10-15T09:30:00.000Z",
        status: null,
        balance: { remaining: 4.5, threshold: 10, currency: "USD" },
      },
      {
        tenantId,
        event: "exhausted",
        surface: "balance",
        providerId: "deepseek",
        providerName: "DeepSeek",
        providerHost: "api.deepseek.com",
        detectedAt: "2026-10-15T09:30:00.000Z",
        status: null,
        balance: { remaining: 0, threshold: 10, currency: "CNY" },
      },
    ]);
  });

  it("raises nothing for a healthy balance and counts a failed check without stopping", async () => {
    const { executor } = organizationProviders([
      { provider_id: "deepseek", display_name: "DeepSeek", base_url: "https://api.deepseek.com/v1", auth_type: "bearer", credential_ref: "DEEPSEEK_API_KEY" },
    ]);
    const request = vi.fn(async (url: URL | RequestInfo) => String(url).startsWith("https://openrouter.ai/")
      ? jsonResponse({ error: "unavailable" }, 503)
      : jsonResponse({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "250.00" }] }));
    const raise = vi.fn(async () => undefined);
    const checker = new ProviderBalanceChecker({
      executor,
      env: { BERRY_ROUTER_INFERENCE_BASE_URL: "https://openrouter.ai/api/v1", BERRY_ROUTER_API_KEY: "sk-or", DEEPSEEK_API_KEY: "sk-ds" },
      sink: { raise },
      config: { intervalMs: 30 * 60_000, defaultThreshold: 10, thresholds: {} },
      defaults: { providerId: "router", providerName: "Berry Router", providerHost: "openrouter.ai" },
      fetch: request as typeof fetch,
    });
    await expect(checker.check({ tenantId, scheduledFor: "2026-10-15T09:30:00.000Z" }))
      .resolves.toEqual({ checked: 1, low: 0, exhausted: 0, failed: 1 });
    expect(raise).not.toHaveBeenCalled();
  });

  it("schedules one check per tenant and interval through the outbox", async () => {
    const execute = vi.fn(async (_sql: string, _params?: readonly unknown[]) => undefined);
    await enqueueProviderBalanceCheck({ execute, query: async () => [] }, tenantId, "2026-10-15T09:30:00.000Z");
    expect(execute.mock.calls[0]![0]).toContain("'alerts.provider-balance'");
    expect(execute.mock.calls[0]![0]).toContain("ON CONFLICT (tenant_id,dedupe_key) DO NOTHING");
    expect(execute.mock.calls[0]![1]).toEqual([
      tenantId,
      "provider-balance/2026-10-15T09:30:00.000Z",
      JSON.stringify({ tenantId, scheduledFor: "2026-10-15T09:30:00.000Z" }),
    ]);
  });
});
