import { describe, expect, it, vi } from "vitest";
import type { EmailMessage, EmailSender } from "./email.js";
import type { ProviderCreditAlertJobPayload } from "./jobs.js";
import {
  ProviderCreditAlertDeliveryError,
  ProviderCreditAlertProcessor,
  SqlProviderCreditAlertSink,
  SqlProviderCreditAlertStore,
  administratorDestinationId,
  providerCreditAlertEmail,
  providerCreditAlertKeys,
  providerCreditRuleId,
  type AlertRecipients,
  type DeliveryClaim,
  type ProviderCreditAlertStore,
} from "./provider-credit-alerts.js";
import { PROVIDER_CREDIT_EXHAUSTED_MESSAGE } from "./provider-credits.js";
import type { SqlExecutor } from "./sql-repositories.js";

const tenantId = "00000000-0000-7000-8000-000000000001";
const HOUR = 3_600_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function alert(overrides: Partial<ProviderCreditAlertJobPayload> = {}): ProviderCreditAlertJobPayload {
  return {
    tenantId,
    event: "exhausted",
    surface: "chat",
    providerId: "openrouter",
    providerName: "OpenRouter",
    providerHost: "openrouter.ai",
    detectedAt: "2026-10-15T09:12:00.000Z",
    status: 402,
    balance: null,
    ...overrides,
  };
}

/** Mirrors the SQL store's rules: one event per prefix per 24 hours, and claim-before-send attempts. */
class MemoryAlertStore implements ProviderCreditAlertStore {
  now = Date.parse("2026-10-15T09:12:00.000Z");
  ruleEnabled = true;
  recipientsResult: AlertRecipients = {
    source: "administrators",
    destinations: [{ id: administratorDestinationId(tenantId), label: "Organization owners and admins (automatic)", emails: ["owner@example.com"] }],
  };
  readonly events: Array<{ id: string; windowKey: string; createdAt: number }> = [];
  readonly attempts: Array<{ id: string; eventId: string; destinationId: string; attempt: number; status: string; providerMessageId: string | null; error: string | null }> = [];
  readonly calls: string[] = [];

  async ensureRule(id: string) {
    this.calls.push("ensureRule");
    return { id: providerCreditRuleId(id), enabled: this.ruleEnabled };
  }

  async openEvent(input: { prefix: string; windowKey: string }) {
    this.calls.push("openEvent");
    const recent = this.events.find((event) => event.windowKey.startsWith(input.prefix) && this.now - event.createdAt < 24 * HOUR);
    if (recent) return { id: recent.id, createdAt: new Date(recent.createdAt).toISOString(), created: false };
    const event = { id: `event-${this.events.length + 1}`, windowKey: input.windowKey, createdAt: this.now };
    this.events.push(event);
    return { id: event.id, createdAt: new Date(event.createdAt).toISOString(), created: true };
  }

  async recipients() {
    this.calls.push("recipients");
    return this.recipientsResult;
  }

  async organizationName() {
    return "Acme";
  }

  async claimDelivery(input: { eventId: string; destinationId: string; maxAttempts: number }): Promise<DeliveryClaim> {
    const previous = this.attempts.filter((row) => row.eventId === input.eventId && row.destinationId === input.destinationId);
    if (previous.some((row) => row.status === "delivered")) return { claimed: false, reason: "already_delivered" };
    if (previous.some((row) => row.status === "pending")) return { claimed: false, reason: "in_flight" };
    if (previous.length >= input.maxAttempts) return { claimed: false, reason: "attempts_exhausted" };
    const row = { id: `attempt-${this.attempts.length + 1}`, eventId: input.eventId, destinationId: input.destinationId, attempt: previous.length + 1, status: "pending", providerMessageId: null, error: null };
    this.attempts.push(row);
    return { claimed: true, attemptId: row.id, attempt: row.attempt };
  }

  async recordDelivery(input: { attemptId: string; status: "delivered" | "failed"; providerMessageId: string | null; error: string | null }) {
    Object.assign(this.attempts.find((row) => row.id === input.attemptId)!, {
      status: input.status,
      providerMessageId: input.providerMessageId,
      error: input.error,
    });
  }
}

function recordingSender(fail: (message: EmailMessage) => boolean = () => false) {
  const sent: EmailMessage[] = [];
  const sender: EmailSender = {
    provider: "ses",
    send: vi.fn(async (message: EmailMessage) => {
      if (fail(message)) throw Object.assign(new Error("Email address is not verified"), { name: "MessageRejected" });
      sent.push(message);
      return { messageId: `ses-${sent.length}` };
    }),
  };
  return { sender, sent };
}

describe("provider credit alert identity (H-005)", () => {
  it("gives every tenant fixed rule and fallback destination IDs", () => {
    const other = "00000000-0000-7000-8000-000000000099";
    expect(providerCreditRuleId(tenantId)).toMatch(UUID);
    expect(providerCreditRuleId(tenantId)).toBe(providerCreditRuleId(tenantId.toUpperCase()));
    expect(providerCreditRuleId(tenantId)).not.toBe(providerCreditRuleId(other));
    expect(administratorDestinationId(tenantId)).toMatch(UUID);
    expect(administratorDestinationId(tenantId)).not.toBe(providerCreditRuleId(tenantId));
  });

  it("keys alerts by provider, problem and UTC hour, with image generation kept apart", () => {
    const first = providerCreditAlertKeys(alert());
    expect(first).toEqual({
      prefix: "provider-credits/exhausted/openrouter/",
      windowKey: "provider-credits/exhausted/openrouter/2026-10-15T09",
    });
    expect(providerCreditAlertKeys(alert({ detectedAt: "2026-10-15T09:59:59.000Z" })).windowKey).toBe(first.windowKey);
    const later = providerCreditAlertKeys(alert({ detectedAt: "2026-10-15T10:00:00.000Z" }));
    expect(later.prefix).toBe(first.prefix);
    expect(later.windowKey).not.toBe(first.windowKey);
    expect(providerCreditAlertKeys(alert({ surface: "balance" })).prefix).toBe(first.prefix);
    expect(providerCreditAlertKeys(alert({ surface: "image" })).prefix).toBe("provider-credits/exhausted/openrouter%3Aimages/");
    expect(providerCreditAlertKeys(alert({ event: "low" })).prefix).toBe("provider-credits/low/openrouter/");
    // A provider ID that contains the separator cannot collide with another provider's prefix.
    expect(providerCreditAlertKeys(alert({ providerId: "router/images" })).prefix).toBe("provider-credits/exhausted/router%2Fimages/");
  });
});

describe("raising a provider credit alert (H-005)", () => {
  it("adds one outbox row per tenant, provider, problem and hour, in the tenant's context", async () => {
    const statements: Array<{ sql: string; params: readonly unknown[] }> = [];
    const executor: SqlExecutor = {
      execute: async (sql, params = []) => { statements.push({ sql, params }); },
      query: async () => [],
      transaction: async (callback) => callback(executor),
    };
    const sink = new SqlProviderCreditAlertSink(executor, { providerId: "router", providerName: "Berry Router", providerHost: "router.example.com" });

    await sink.raise({ tenantId, event: "exhausted", surface: "chat", detectedAt: "2026-10-15T09:12:00.000Z", status: 402 });

    expect(statements[0]).toEqual({ sql: "SELECT berry_set_tenant_id($1::uuid)", params: [tenantId] });
    expect(statements[1]!.sql).toContain("INSERT INTO runtime_outbox");
    expect(statements[1]!.sql).toContain("'alerts.provider-credits'");
    expect(statements[1]!.sql).toContain("ON CONFLICT (tenant_id,dedupe_key) DO NOTHING");
    const [, aggregateId, dedupeKey, payload] = statements[1]!.params as [string, string, string, string];
    expect(aggregateId).toBe("provider-credits/router");
    expect(dedupeKey).toBe("provider-credits/exhausted/router/2026-10-15T09");
    // A run without a recorded provider is attributed to the deployment's router.
    expect(JSON.parse(payload)).toEqual({
      tenantId,
      event: "exhausted",
      surface: "chat",
      providerId: "router",
      providerName: "Berry Router",
      providerHost: "router.example.com",
      detectedAt: "2026-10-15T09:12:00.000Z",
      status: 402,
      balance: null,
    });
  });
});

describe("delivering a provider credit alert (H-005)", () => {
  it("emails each destination once, records the SES message ID, and a retry sends nothing", async () => {
    const store = new MemoryAlertStore();
    store.recipientsResult = {
      source: "destinations",
      destinations: [
        { id: "dest-ops", label: "Ops", emails: ["ops@example.com"] },
        { id: "dest-finance", label: "Finance", emails: ["finance@example.com", "cfo@example.com"] },
      ],
    };
    const { sender, sent } = recordingSender();
    const processor = new ProviderCreditAlertProcessor({ store, sender });

    await expect(processor.deliver(alert())).resolves.toMatchObject({ outcome: "delivered", eventId: "event-1", sent: 2, failed: 0 });
    expect(sent.map((message) => message.to)).toEqual([["ops@example.com"], ["finance@example.com", "cfo@example.com"]]);
    expect(store.attempts.map((row) => [row.destinationId, row.status, row.providerMessageId])).toEqual([
      ["dest-ops", "delivered", "ses-1"],
      ["dest-finance", "delivered", "ses-2"],
    ]);

    await expect(processor.deliver(alert())).resolves.toMatchObject({ outcome: "duplicate", sent: 0, skipped: 2 });
    expect(sent).toHaveLength(2);
  });

  it("sends at most one email per tenant, provider and problem in 24 hours", async () => {
    const store = new MemoryAlertStore();
    const { sender, sent } = recordingSender();
    const processor = new ProviderCreditAlertProcessor({ store, sender });

    await processor.deliver(alert());
    store.now += 3 * HOUR;
    await processor.deliver(alert({ detectedAt: new Date(store.now).toISOString() }));
    await processor.deliver(alert({ surface: "balance", detectedAt: new Date(store.now).toISOString() }));
    expect(sent).toHaveLength(1);

    // Image generation and another provider are separate problems.
    await processor.deliver(alert({ surface: "image", detectedAt: new Date(store.now).toISOString() }));
    await processor.deliver(alert({ providerId: "deepseek", providerName: "DeepSeek", providerHost: "api.deepseek.com", detectedAt: new Date(store.now).toISOString() }));
    expect(sent).toHaveLength(3);

    store.now += 22 * HOUR;
    await processor.deliver(alert({ detectedAt: new Date(store.now).toISOString() }));
    expect(sent).toHaveLength(4);
    expect(store.events.map((event) => event.windowKey)).toEqual([
      "provider-credits/exhausted/openrouter/2026-10-15T09",
      "provider-credits/exhausted/openrouter%3Aimages/2026-10-15T12",
      "provider-credits/exhausted/deepseek/2026-10-15T12",
      "provider-credits/exhausted/openrouter/2026-10-16T10",
    ]);
  });

  it("records a failed send and fails the job, and the retry resends only that destination", async () => {
    const store = new MemoryAlertStore();
    store.recipientsResult = {
      source: "destinations",
      destinations: [
        { id: "dest-ops", label: "Ops", emails: ["ops@example.com"] },
        { id: "dest-finance", label: "Finance", emails: ["finance@example.com"] },
      ],
    };
    let rejectFinance = true;
    const { sender, sent } = recordingSender((message) => rejectFinance && message.to.includes("finance@example.com"));
    const processor = new ProviderCreditAlertProcessor({ store, sender });

    const failure = await processor.deliver(alert()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderCreditAlertDeliveryError);
    expect((failure as ProviderCreditAlertDeliveryError).result).toMatchObject({ outcome: "failed", sent: 1, failed: 1 });
    expect(store.attempts.find((row) => row.destinationId === "dest-finance")).toMatchObject({
      status: "failed",
      providerMessageId: null,
      error: "MessageRejected: Email address is not verified",
    });

    rejectFinance = false;
    await expect(processor.deliver(alert())).resolves.toMatchObject({ outcome: "delivered", sent: 1, skipped: 1 });
    expect(sent.map((message) => message.to)).toEqual([["ops@example.com"], ["finance@example.com"]]);
    expect(store.attempts.filter((row) => row.destinationId === "dest-finance").map((row) => [row.attempt, row.status]))
      .toEqual([[1, "failed"], [2, "delivered"]]);
  });

  it("stops retrying a destination after its attempts are used", async () => {
    const store = new MemoryAlertStore();
    const { sender } = recordingSender(() => true);
    const processor = new ProviderCreditAlertProcessor({ store, sender, maxAttemptsPerDestination: 2 });
    await expect(processor.deliver(alert())).rejects.toBeInstanceOf(ProviderCreditAlertDeliveryError);
    await expect(processor.deliver(alert())).rejects.toBeInstanceOf(ProviderCreditAlertDeliveryError);
    await expect(processor.deliver(alert())).resolves.toMatchObject({ outcome: "duplicate", skipped: 1 });
    expect(sender.send).toHaveBeenCalledTimes(2);
  });

  it("sends nothing when email is not configured or the organization turned the alert off", async () => {
    const store = new MemoryAlertStore();
    await expect(new ProviderCreditAlertProcessor({ store, sender: null }).deliver(alert()))
      .resolves.toMatchObject({ outcome: "email_disabled", sent: 0 });
    expect(store.calls).toEqual([]);

    store.ruleEnabled = false;
    const { sender, sent } = recordingSender();
    await expect(new ProviderCreditAlertProcessor({ store, sender }).deliver(alert()))
      .resolves.toMatchObject({ outcome: "rule_disabled", sent: 0 });
    expect(sent).toEqual([]);
    expect(store.events).toEqual([]);
  });

  it("records the event but sends nothing when nobody can receive it", async () => {
    const store = new MemoryAlertStore();
    store.recipientsResult = { source: "administrators", destinations: [] };
    const { sender } = recordingSender();
    await expect(new ProviderCreditAlertProcessor({ store, sender }).deliver(alert()))
      .resolves.toMatchObject({ outcome: "no_recipients", eventId: "event-1", sent: 0 });
    expect(sender.send).not.toHaveBeenCalled();
  });
});

describe("provider credit alert recipients (H-005)", () => {
  function storeWith(rows: { destinations?: unknown[]; rules?: unknown[]; administrators?: unknown[] }) {
    const statements: Array<{ sql: string; params: readonly unknown[] }> = [];
    const executor: SqlExecutor = {
      execute: async (sql, params = []) => { statements.push({ sql, params }); },
      query: async <T>(sql: string, params: readonly unknown[] = []) => {
        statements.push({ sql, params });
        if (sql.includes("FROM alert_destinations")) return (rows.destinations ?? []) as T[];
        if (sql.includes("FROM alert_rules")) return (rows.rules ?? []) as T[];
        if (sql.includes("FROM tenant_memberships")) return (rows.administrators ?? []) as T[];
        return [] as T[];
      },
      transaction: async (callback) => callback(executor),
    };
    return { store: new SqlProviderCreditAlertStore(executor), statements };
  }
  const destinations = [
    { id: "dest-ops", label: "Ops", email_recipients: ["ops@example.com"] },
    { id: "dest-finance", label: "Finance", email_recipients: ["finance@example.com", "bad address"] },
    { id: "dest-empty", label: "Empty", email_recipients: [] },
  ];

  it("prefers the destinations of an enabled credit alert rule", async () => {
    const { store } = storeWith({ destinations, rules: [{ destination_ids: ["dest-finance", "dest-webhook"] }] });
    await expect(store.recipients(tenantId)).resolves.toEqual({
      source: "rule",
      destinations: [{ id: "dest-finance", label: "Finance", emails: ["finance@example.com"] }],
    });
  });

  it("otherwise uses every configured email destination", async () => {
    const { store, statements } = storeWith({ destinations });
    await expect(store.recipients(tenantId)).resolves.toEqual({
      source: "destinations",
      destinations: [
        { id: "dest-ops", label: "Ops", emails: ["ops@example.com"] },
        { id: "dest-finance", label: "Finance", emails: ["finance@example.com"] },
      ],
    });
    const destinationQuery = statements.find(({ sql }) => sql.includes("FROM alert_destinations"))!;
    expect(destinationQuery.sql).toContain("kind='email' AND configured");
    expect(destinationQuery.params).toEqual([tenantId, administratorDestinationId(tenantId)]);
  });

  it("falls back to verified, active owners and admins through the automatic destination", async () => {
    const { store, statements } = storeWith({ administrators: [{ email: "owner@example.com" }, { email: "admin@example.com" }] });
    await expect(store.recipients(tenantId)).resolves.toEqual({
      source: "administrators",
      destinations: [{
        id: administratorDestinationId(tenantId),
        label: "Organization owners and admins (automatic)",
        emails: ["owner@example.com", "admin@example.com"],
      }],
    });
    const administrators = statements.find(({ sql }) => sql.includes("FROM tenant_memberships"))!.sql;
    for (const condition of ["m.role IN ('owner','admin')", "m.status='active'", "m.deprovisioned_at IS NULL", "u.status='active'", "u.deleted_at IS NULL", "u.email_verified"]) {
      expect(administrators).toContain(condition);
    }
    const created = statements.find(({ sql }) => sql.includes("INSERT INTO alert_destinations"))!;
    expect(created.sql).toContain("ON CONFLICT (id) DO NOTHING");
    expect(created.params).toEqual([administratorDestinationId(tenantId), tenantId, "Organization owners and admins (automatic)"]);
  });
});

describe("provider credit alert email (H-005)", () => {
  it("says what happened, what users see and what the administrator should do", () => {
    const email = providerCreditAlertEmail({
      alert: alert(),
      firstDetectedAt: "2026-10-15T09:12:30.000Z",
      organizationName: "Acme",
      recipientSource: "administrators",
    });
    expect(email.subject).toBe("Berry: OpenRouter is out of credit");
    for (const part of [
      "Berry can't get responses from OpenRouter",
      "- Provider: OpenRouter (openrouter.ai)",
      "- First detected: 2026-10-15 09:12 UTC",
      "- Provider response: HTTP 402",
      "- Organization: Acme",
      "What users see",
      `"${PROVIDER_CREDIT_EXHAUSTED_MESSAGE}"`,
      "What to do",
      "1. Sign in to the OpenRouter account and add credit",
      "Billing page: https://openrouter.ai/settings/credits",
      "you are an owner or administrator of Acme",
      "at most one email per provider and problem every 24 hours",
    ]) {
      expect(email.text).toContain(part);
    }
    expect(email.html).toContain("<h2 style=\"margin:20px 0 8px;font-size:15px\">What users see</h2>");
    expect(email.html).toContain('<a href="https://openrouter.ai/settings/credits">');
    expect(`${email.text}${email.html}`).not.toMatch(/undefined|null|Bearer|api[_-]?key=/i);
  });

  it("describes a low balance with the remaining amount and threshold", () => {
    const email = providerCreditAlertEmail({
      alert: alert({ event: "low", surface: "balance", status: null, balance: { remaining: 4.2, threshold: 10, currency: "USD" } }),
      firstDetectedAt: "2026-10-15T09:00:00.000Z",
      organizationName: null,
      recipientSource: "rule",
    });
    expect(email.subject).toBe("Berry: OpenRouter credit is running low");
    expect(email.text).toContain("- Remaining: 4.20 USD");
    expect(email.text).toContain("- Alert threshold: 10.00 USD");
    expect(email.text).toContain("Nothing yet.");
    expect(email.text).toContain("this address is an alert email destination for your Berry organization");
  });

  it("describes image generation separately and escapes names in HTML", () => {
    const email = providerCreditAlertEmail({
      alert: alert({ surface: "image", providerName: "<b>Images</b>", providerHost: "images.example.com", status: 429 }),
      firstDetectedAt: "2026-10-15T09:00:00.000Z",
      organizationName: "R&D",
      recipientSource: "destinations",
    });
    expect(email.subject).toBe("Berry: image generation is out of credit (<b>Images</b>)");
    expect(email.text).toContain("- Affected: Image generation; chat can still work");
    expect(email.text).not.toContain("Billing page");
    expect(email.html).toContain("&lt;b&gt;Images&lt;/b&gt; (images.example.com)");
    expect(email.html).toContain("R&amp;D");
    expect(email.html).not.toContain("<b>Images</b>");
  });
});
