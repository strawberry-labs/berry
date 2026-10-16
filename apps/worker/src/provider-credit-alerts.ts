import { createHash } from "node:crypto";
import type { OperationalWorkerRole } from "@berry/shared";
import { ProviderCreditAlertJobPayloadSchema, type ProviderCreditAlertJobPayload } from "./jobs.js";
import type { SqlExecutor } from "./sql-repositories.js";
import { EmailNotSentError, emailErrorMessage, emailSendRejected, isEmailAddress, type EmailMessage, type EmailSender } from "./email.js";
import { emitWorkerOperationalEvent } from "./operational-telemetry.js";
import {
  PROVIDER_CREDIT_EXHAUSTED_MESSAGE,
  urlHost,
  type ProviderCreditAlert,
  type ProviderCreditAlertSink,
} from "./provider-credits.js";

/**
 * Administrator email about AI provider credit (H-005).
 *
 * A run that hits a credit or quota failure, or the periodic balance check,
 * raises an alert by writing one `runtime_outbox` row. The background worker
 * delivers it: one `alert_events` row per tenant, provider and problem in any
 * 24 hours, and one `delivery_attempts` row per send, so retries never resend
 * a delivered email. A send whose result is unknown (SES may have accepted it)
 * stays `pending` with the reason in `error`, and is never sent again
 * automatically. No schema change is needed: the event's rule and the
 * administrators' fallback destination are per-tenant rows with fixed IDs.
 */

export const PROVIDER_CREDIT_ALERT_DEDUPE_HOURS = 24;
const MAX_ATTEMPTS_PER_DESTINATION = 5;
const MAX_ADMINISTRATOR_RECIPIENTS = 50;
const PROVIDER_CREDIT_RULE_NAME = "Provider credit alerts (automatic)";
const ADMINISTRATOR_DESTINATION_LABEL = "Organization owners and admins (automatic)";
// Fixed namespace for the name-based IDs below. Changing it would orphan existing rows.
const BERRY_ALERT_NAMESPACE = Buffer.from("6f1c2a9e4b7d4c1e9a3f5d2b8c0e7a14", "hex");

export function providerCreditRuleId(tenantId: string): string {
  return nameBasedUuid(`provider-credit-rule:${tenantId.toLowerCase()}`);
}

export function administratorDestinationId(tenantId: string): string {
  return nameBasedUuid(`administrator-alert-destination:${tenantId.toLowerCase()}`);
}

/** RFC 4122 version 5: the same tenant always maps to the same row, on every worker. */
function nameBasedUuid(name: string): string {
  const hash = createHash("sha1").update(BERRY_ALERT_NAMESPACE).update(name).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * `prefix` identifies the tenant's provider and problem; `windowKey` adds the
 * UTC hour. Image generation is keyed apart from chat because it may use a
 * different upstream account and users see a different failure.
 */
export function providerCreditAlertKeys(
  alert: Pick<ProviderCreditAlertJobPayload, "event" | "surface" | "providerId" | "detectedAt">,
): { prefix: string; windowKey: string } {
  const provider = alert.surface === "image" ? `${alert.providerId}:images` : alert.providerId;
  const prefix = `provider-credits/${alert.event}/${encodeURIComponent(provider)}/`;
  return { prefix, windowKey: `${prefix}${new Date(alert.detectedAt).toISOString().slice(0, 13)}` };
}

export type ProviderCreditAlertDefaults = {
  providerId: string;
  providerName: string;
  providerHost: string | null;
};

/** The deployment's router provider, used when a run did not record its provider. */
export function providerCreditAlertDefaultsFromEnv(env: NodeJS.ProcessEnv): ProviderCreditAlertDefaults {
  return {
    providerId: env.BERRY_ROUTER_PROVIDER_ID?.trim() || "router",
    providerName: env.BERRY_ROUTER_PROVIDER_NAME?.trim() || "Berry Router",
    providerHost: urlHost(env.BERRY_ROUTER_INFERENCE_BASE_URL?.trim()),
  };
}

export function normalizeProviderCreditAlert(
  alert: ProviderCreditAlert,
  defaults: ProviderCreditAlertDefaults,
): ProviderCreditAlertJobPayload {
  const providerId = alert.providerId?.trim() || defaults.providerId;
  const isDefault = providerId === defaults.providerId;
  return ProviderCreditAlertJobPayloadSchema.parse({
    ...alert,
    providerId,
    providerName: alert.providerName?.trim() || (isDefault ? defaults.providerName : providerId),
    providerHost: alert.providerHost ?? (isDefault ? defaults.providerHost : null),
  });
}

/**
 * Records an alert for the background worker. The outbox dedupe key holds at
 * most one pending delivery per tenant, provider, problem and hour, so a burst
 * of failing runs adds one row, not one per run.
 */
export class SqlProviderCreditAlertSink implements ProviderCreditAlertSink {
  constructor(
    private readonly executor: SqlExecutor,
    private readonly defaults: ProviderCreditAlertDefaults,
  ) {}

  async raise(alert: ProviderCreditAlert): Promise<void> {
    const payload = normalizeProviderCreditAlert(alert, this.defaults);
    const { windowKey } = providerCreditAlertKeys(payload);
    await withTenantTransaction(this.executor, payload.tenantId, (executor) => executor.execute(
      `
INSERT INTO runtime_outbox (tenant_id,event_type,aggregate_id,dedupe_key,payload)
VALUES ($1::uuid,'alerts.provider-credits',$2,$3,$4::jsonb)
ON CONFLICT (tenant_id,dedupe_key) DO NOTHING
      `.trim(),
      [payload.tenantId, `provider-credits/${encodeURIComponent(payload.providerId)}`, windowKey, JSON.stringify(payload)],
    ));
  }
}

export type AlertRecipients = {
  /** Destinations named by a credit alert rule, every email destination, or the owners and admins. */
  source: "rule" | "destinations" | "administrators";
  destinations: Array<{ id: string; label: string; emails: string[] }>;
};

export type DeliveryClaim =
  | { claimed: true; attemptId: string; attempt: number }
  | { claimed: false; reason: "already_delivered" | "in_flight" | "unresolved" | "attempts_exhausted" };

/** Kept on a pending attempt whose email may have been sent. */
const UNKNOWN_OUTCOME = "The email may have been sent; Berry did not receive the result and will not send it again automatically";

export interface ProviderCreditAlertStore {
  ensureRule(tenantId: string): Promise<{ id: string; enabled: boolean }>;
  openEvent(input: {
    tenantId: string;
    ruleId: string;
    prefix: string;
    windowKey: string;
    observed: number;
    baseline: number | null;
  }): Promise<{ id: string; createdAt: string; created: boolean }>;
  recipients(tenantId: string): Promise<AlertRecipients>;
  organizationName(tenantId: string): Promise<string | null>;
  claimDelivery(input: { tenantId: string; eventId: string; destinationId: string; maxAttempts: number }): Promise<DeliveryClaim>;
  recordDelivery(input: {
    tenantId: string;
    attemptId: string;
    status: "delivered" | "failed" | "pending";
    providerMessageId: string | null;
    error: string | null;
  }): Promise<void>;
}

export class SqlProviderCreditAlertStore implements ProviderCreditAlertStore {
  constructor(private readonly executor: SqlExecutor) {}

  async ensureRule(tenantId: string): Promise<{ id: string; enabled: boolean }> {
    const id = providerCreditRuleId(tenantId);
    return withTenantTransaction(this.executor, tenantId, async (executor) => {
      await executor.execute(
        `
INSERT INTO alert_rules (id,tenant_id,name,signal,enabled,threshold,window_minutes,destination_ids)
VALUES ($1::uuid,$2::uuid,$3,'credits',true,0,$4,'[]'::jsonb)
ON CONFLICT (id) DO NOTHING
        `.trim(),
        [id, tenantId, PROVIDER_CREDIT_RULE_NAME, PROVIDER_CREDIT_ALERT_DEDUPE_HOURS * 60],
      );
      const rows = await executor.query<{ enabled: boolean }>(
        "SELECT enabled FROM alert_rules WHERE tenant_id=$1::uuid AND id=$2::uuid",
        [tenantId, id],
      );
      // An administrator may switch the rule off to stop these emails for the organization.
      return { id, enabled: rows[0]?.enabled !== false };
    });
  }

  /**
   * Returns the tenant's event for this provider and problem from the last 24
   * hours, or creates one. The advisory lock serialises concurrent workers, so
   * two of them cannot both decide that no recent event exists.
   */
  async openEvent(input: {
    tenantId: string;
    ruleId: string;
    prefix: string;
    windowKey: string;
    observed: number;
    baseline: number | null;
  }): Promise<{ id: string; createdAt: string; created: boolean }> {
    return withTenantTransaction(this.executor, input.tenantId, async (executor) => {
      await executor.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`berry:provider-credit-alert:${input.tenantId}:${input.prefix}`],
      );
      const recent = await executor.query<{ id: string; created_at: Date | string }>(
        `
SELECT id,created_at FROM alert_events
WHERE tenant_id=$1::uuid AND rule_id=$2::uuid AND starts_with(window_key,$3)
  AND created_at > now() - ($4::integer * interval '1 hour')
ORDER BY created_at DESC
LIMIT 1
        `.trim(),
        [input.tenantId, input.ruleId, input.prefix, PROVIDER_CREDIT_ALERT_DEDUPE_HOURS],
      );
      if (recent[0]) return { id: recent[0].id, createdAt: iso(recent[0].created_at), created: false };
      const inserted = await executor.query<{ id: string; created_at: Date | string }>(
        `
INSERT INTO alert_events (tenant_id,rule_id,window_key,observed,baseline)
VALUES ($1::uuid,$2::uuid,$3,$4,$5)
ON CONFLICT (tenant_id,rule_id,window_key) DO NOTHING
RETURNING id,created_at
        `.trim(),
        [input.tenantId, input.ruleId, input.windowKey, input.observed, input.baseline],
      );
      if (inserted[0]) return { id: inserted[0].id, createdAt: iso(inserted[0].created_at), created: true };
      const existing = await executor.query<{ id: string; created_at: Date | string }>(
        "SELECT id,created_at FROM alert_events WHERE tenant_id=$1::uuid AND rule_id=$2::uuid AND window_key=$3",
        [input.tenantId, input.ruleId, input.windowKey],
      );
      if (!existing[0]) throw new Error("Provider credit alert event could not be recorded");
      return { id: existing[0].id, createdAt: iso(existing[0].created_at), created: false };
    });
  }

  async recipients(tenantId: string): Promise<AlertRecipients> {
    const ruleId = providerCreditRuleId(tenantId);
    const fallbackId = administratorDestinationId(tenantId);
    const { destinations, ruleDestinationIds } = await withTenantTransaction(this.executor, tenantId, async (executor) => {
      const destinationRows = await executor.query<{ id: string; label: string; email_recipients: unknown }>(
        `
SELECT id,label,email_recipients FROM alert_destinations
WHERE tenant_id=$1::uuid AND kind='email' AND configured AND id<>$2::uuid
ORDER BY label,id
        `.trim(),
        [tenantId, fallbackId],
      );
      const ruleRows = await executor.query<{ destination_ids: unknown }>(
        "SELECT destination_ids FROM alert_rules WHERE tenant_id=$1::uuid AND signal='credits' AND enabled AND id<>$2::uuid",
        [tenantId, ruleId],
      );
      return {
        destinations: destinationRows
          .map((row) => ({ id: row.id, label: row.label, emails: emailList(row.email_recipients) }))
          .filter((destination) => destination.emails.length > 0),
        ruleDestinationIds: new Set(ruleRows.flatMap((row) =>
          Array.isArray(row.destination_ids) ? row.destination_ids.filter((value): value is string => typeof value === "string") : []
        )),
      };
    });
    const routed = destinations.filter((destination) => ruleDestinationIds.has(destination.id));
    if (routed.length > 0) return { source: "rule", destinations: routed };
    if (destinations.length > 0) return { source: "destinations", destinations };
    const administrators = await this.administratorEmails(tenantId);
    if (administrators.length === 0) return { source: "administrators", destinations: [] };
    await withTenantTransaction(this.executor, tenantId, (executor) => executor.execute(
      `
INSERT INTO alert_destinations (id,tenant_id,kind,label,email_recipients,configured)
VALUES ($1::uuid,$2::uuid,'email',$3,'[]'::jsonb,true)
ON CONFLICT (id) DO NOTHING
      `.trim(),
      [fallbackId, tenantId, ADMINISTRATOR_DESTINATION_LABEL],
    ));
    return {
      source: "administrators",
      destinations: [{ id: fallbackId, label: ADMINISTRATOR_DESTINATION_LABEL, emails: administrators }],
    };
  }

  /** Active owners and admins with a verified email address, read when each alert is sent. */
  async administratorEmails(tenantId: string): Promise<string[]> {
    const rows = await withTenantTransaction(this.executor, tenantId, (executor) => executor.query<{ email: string }>(
      `
SELECT DISTINCT ON (lower(u.email)) u.email
FROM tenant_memberships m
JOIN users u ON u.id=m.user_id
WHERE m.tenant_id=$1::uuid AND m.role IN ('owner','admin') AND m.status='active'
  AND m.deprovisioned_at IS NULL
  AND u.status='active' AND u.deleted_at IS NULL AND u.email_verified
ORDER BY lower(u.email)
LIMIT $2
      `.trim(),
      [tenantId, MAX_ADMINISTRATOR_RECIPIENTS],
    ));
    return emailList(rows.map((row) => row.email));
  }

  async organizationName(tenantId: string): Promise<string | null> {
    const rows = await this.executor.query<{ name: string }>("SELECT name FROM tenants WHERE id=$1::uuid", [tenantId]);
    return rows[0]?.name?.trim() || null;
  }

  /**
   * Reserves the next attempt for one destination unless it was delivered, is
   * unresolved, or has used its attempts. The unique attempt number makes two
   * concurrent claims resolve to one sender. A pending attempt is never
   * claimed past: it is being sent now, or its email may have been sent (a
   * lost SES response, or a worker that stopped before recording the result).
   */
  async claimDelivery(input: { tenantId: string; eventId: string; destinationId: string; maxAttempts: number }): Promise<DeliveryClaim> {
    const rows = await withTenantTransaction(this.executor, input.tenantId, (executor) => executor.query<{
      id: string | null;
      attempt: number | null;
      attempts: number | string;
      delivered: boolean;
      unresolved: boolean;
    }>(
      `
WITH previous AS (
  SELECT COALESCE(max(attempt),0) AS last_attempt,
         count(*) AS attempts,
         COALESCE(bool_or(status='delivered'),false) AS delivered,
         COALESCE(bool_or(status='pending'),false) AS pending,
         COALESCE(bool_or(status='pending' AND (error IS NOT NULL OR created_at <= now() - interval '10 minutes')),false) AS unresolved
  FROM delivery_attempts
  WHERE tenant_id=$1::uuid AND alert_event_id=$2::uuid AND destination_id=$3::uuid
), interrupted AS (
  UPDATE delivery_attempts
  SET error=$5
  WHERE tenant_id=$1::uuid AND alert_event_id=$2::uuid AND destination_id=$3::uuid
    AND status='pending' AND error IS NULL AND created_at <= now() - interval '10 minutes'
  RETURNING id
), claimed AS (
  INSERT INTO delivery_attempts (tenant_id,alert_event_id,destination_id,attempt,status)
  SELECT $1::uuid,$2::uuid,$3::uuid,previous.last_attempt+1,'pending'
  FROM previous
  WHERE NOT previous.delivered AND NOT previous.pending AND previous.attempts < $4
  ON CONFLICT DO NOTHING
  RETURNING id,attempt
)
SELECT claimed.id,claimed.attempt,previous.attempts,previous.delivered,previous.unresolved
FROM previous LEFT JOIN claimed ON true
      `.trim(),
      [input.tenantId, input.eventId, input.destinationId, input.maxAttempts, `${UNKNOWN_OUTCOME} (the worker stopped before recording it)`],
    ));
    const row = rows[0];
    if (row?.id) return { claimed: true, attemptId: row.id, attempt: Number(row.attempt) };
    if (row?.delivered) return { claimed: false, reason: "already_delivered" };
    if (row?.unresolved) return { claimed: false, reason: "unresolved" };
    if (row && Number(row.attempts) >= input.maxAttempts) return { claimed: false, reason: "attempts_exhausted" };
    // A recent pending attempt, or a concurrent claim that won the same attempt number.
    return { claimed: false, reason: "in_flight" };
  }

  async recordDelivery(input: {
    tenantId: string;
    attemptId: string;
    status: "delivered" | "failed" | "pending";
    providerMessageId: string | null;
    error: string | null;
  }): Promise<void> {
    await withTenantTransaction(this.executor, input.tenantId, (executor) => executor.execute(
      "UPDATE delivery_attempts SET status=$3,provider_message_id=$4,error=$5 WHERE tenant_id=$1::uuid AND id=$2::uuid",
      [input.tenantId, input.attemptId, input.status, input.providerMessageId, input.error],
    ));
  }
}

export type DeliveryOutcome = "sent" | "failed" | "unknown" | "already_delivered" | "in_flight" | "unresolved" | "attempts_exhausted";

/** Sends one alert email to one destination and records the attempt. */
export async function deliverAlertEmail(
  store: Pick<ProviderCreditAlertStore, "claimDelivery" | "recordDelivery">,
  sender: EmailSender,
  input: {
    tenantId: string;
    eventId: string;
    destinationId: string;
    recipients: readonly string[];
    message: Omit<EmailMessage, "to">;
    maxAttempts?: number;
  },
): Promise<DeliveryOutcome> {
  const claim = await store.claimDelivery({
    tenantId: input.tenantId,
    eventId: input.eventId,
    destinationId: input.destinationId,
    maxAttempts: input.maxAttempts ?? MAX_ATTEMPTS_PER_DESTINATION,
  });
  if (!claim.claimed) return claim.reason;
  let outcome: { status: "delivered" | "failed" | "pending"; providerMessageId: string | null; error: string | null };
  try {
    if (input.recipients.length === 0) throw new EmailNotSentError("The destination has no email recipients");
    const sent = await sender.send({ ...input.message, to: input.recipients });
    outcome = { status: "delivered", providerMessageId: sent.messageId, error: null };
  } catch (error) {
    outcome = emailSendRejected(error)
      ? { status: "failed", providerMessageId: null, error: emailErrorMessage(error) }
      // Not "failed": that would allow another send. The attempt stays
      // unresolved until an administrator checks it.
      : { status: "pending", providerMessageId: null, error: `${UNKNOWN_OUTCOME}: ${emailErrorMessage(error)}` };
  }
  await store.recordDelivery({ tenantId: input.tenantId, attemptId: claim.attemptId, ...outcome });
  return outcome.status === "delivered" ? "sent" : outcome.status === "failed" ? "failed" : "unknown";
}

export type ProviderCreditAlertResult = {
  outcome: "email_disabled" | "rule_disabled" | "no_recipients" | "delivered" | "duplicate" | "failed" | "unknown";
  eventId: string | null;
  sent: number;
  failed: number;
  /** Sends whose result is unknown; retrying cannot resolve them. */
  unknown: number;
  skipped: number;
};

export class ProviderCreditAlertDeliveryError extends Error {
  constructor(readonly result: ProviderCreditAlertResult) {
    super(`Provider credit alert email failed for ${result.failed} destination(s)`);
    this.name = "ProviderCreditAlertDeliveryError";
  }
}

export class ProviderCreditAlertProcessor {
  constructor(private readonly options: {
    store: ProviderCreditAlertStore;
    sender: EmailSender | null;
    maxAttemptsPerDestination?: number;
    workerRole?: OperationalWorkerRole;
    sourceRevision?: string;
  }) {}

  /** Delivers one raised alert. Throws when a send failed, so the job is retried; an unknown result is not retried. */
  async deliver(payload: ProviderCreditAlertJobPayload): Promise<ProviderCreditAlertResult> {
    const result = await this.#deliver(ProviderCreditAlertJobPayloadSchema.parse(payload));
    emitWorkerOperationalEvent(
      "phase.transition",
      this.options.workerRole ?? "unknown",
      this.options.sourceRevision ?? "unknown",
      {
        phase: "provider_credit_alert",
        outcome: result.outcome,
        completedCount: result.sent,
        failedCount: result.failed,
        itemCount: result.sent + result.failed + result.unknown + result.skipped,
      },
    );
    if (result.failed > 0) throw new ProviderCreditAlertDeliveryError(result);
    return result;
  }

  async #deliver(alert: ProviderCreditAlertJobPayload): Promise<ProviderCreditAlertResult> {
    const empty = { eventId: null, sent: 0, failed: 0, unknown: 0, skipped: 0 };
    const sender = this.options.sender;
    if (!sender) return { outcome: "email_disabled", ...empty };
    const { store } = this.options;
    const rule = await store.ensureRule(alert.tenantId);
    if (!rule.enabled) return { outcome: "rule_disabled", ...empty };
    const { prefix, windowKey } = providerCreditAlertKeys(alert);
    const event = await store.openEvent({
      tenantId: alert.tenantId,
      ruleId: rule.id,
      prefix,
      windowKey,
      observed: alert.balance?.remaining ?? 0,
      baseline: alert.balance?.threshold ?? null,
    });
    const recipients = await store.recipients(alert.tenantId);
    if (recipients.destinations.length === 0) return { outcome: "no_recipients", ...empty, eventId: event.id };
    const message = providerCreditAlertEmail({
      alert,
      firstDetectedAt: event.createdAt,
      organizationName: await store.organizationName(alert.tenantId),
      recipientSource: recipients.source,
    });
    let sent = 0;
    let failed = 0;
    let unknown = 0;
    let skipped = 0;
    for (const destination of recipients.destinations) {
      const outcome = await deliverAlertEmail(store, sender, {
        tenantId: alert.tenantId,
        eventId: event.id,
        destinationId: destination.id,
        recipients: destination.emails,
        message,
        ...(this.options.maxAttemptsPerDestination ? { maxAttempts: this.options.maxAttemptsPerDestination } : {}),
      });
      if (outcome === "sent") sent += 1;
      else if (outcome === "failed") failed += 1;
      else if (outcome === "unknown") unknown += 1;
      else skipped += 1;
    }
    return {
      outcome: failed > 0 ? "failed" : unknown > 0 ? "unknown" : sent > 0 ? "delivered" : "duplicate",
      eventId: event.id,
      sent,
      failed,
      unknown,
      skipped,
    };
  }
}

/** Plain text and simple HTML. It names the provider, never a credential. */
export function providerCreditAlertEmail(input: {
  alert: ProviderCreditAlertJobPayload;
  firstDetectedAt: string;
  organizationName: string | null;
  recipientSource: AlertRecipients["source"];
}): Omit<EmailMessage, "to"> {
  const { alert } = input;
  const provider = alert.providerName;
  const providerLabel = alert.providerHost && alert.providerHost !== provider.toLowerCase()
    ? `${provider} (${alert.providerHost})`
    : provider;
  const organization = input.organizationName ?? "your Berry organization";
  const when = formatUtc(input.firstDetectedAt);
  const amount = (value: number) => `${value.toFixed(2)} ${alert.balance?.currency ?? ""}`.trim();
  const billingUrl = providerBillingUrl(alert.providerHost);
  const responseFact: Array<[string, string]> = alert.status ? [["Provider response", `HTTP ${alert.status}`]] : [];
  let subject: string;
  let summary: string;
  let facts: Array<[string, string]>;
  let usersSee: { text: string; quote?: string };
  let steps: string[];
  if (alert.event === "low") {
    subject = `Berry: ${provider} credit is running low`;
    summary = `The ${provider} account that Berry uses is running low on credit.`;
    facts = [
      ["Provider", providerLabel],
      ...(alert.balance
        ? [["Remaining", amount(alert.balance.remaining)], ["Alert threshold", amount(alert.balance.threshold)]] as Array<[string, string]>
        : []),
      ["Checked", when],
      ["Organization", organization],
    ];
    usersSee = {
      text: "Nothing yet. If the credit runs out, requests that use this provider will fail with this message:",
      quote: PROVIDER_CREDIT_EXHAUSTED_MESSAGE,
    };
    steps = [
      `Add credit to the ${provider} account, or raise the spending limit on the API key Berry uses.`,
      "Consider turning on automatic top-up in the provider's billing settings.",
    ];
  } else if (alert.surface === "image") {
    subject = `Berry: image generation is out of credit (${provider})`;
    summary = "Berry can't create images because the image provider reports that its account is out of credit or quota.";
    facts = [
      ["Provider", providerLabel],
      ["Affected", "Image generation; chat can still work"],
      ["First detected", when],
      ...responseFact,
      ["Organization", organization],
    ];
    usersSee = {
      text: "When someone asks for an image, Berry tells them that image generation is unavailable because the AI provider is out of credit, and asks them to contact support or their administrator.",
    };
    steps = [
      "Add credit to the account used for image generation, or raise the spending limit on its API key.",
      "Check that account's billing settings, such as the payment method and automatic top-up.",
      "Nothing needs to change in Berry. Image requests work again once the provider accepts them.",
    ];
  } else {
    subject = `Berry: ${provider} is out of credit`;
    summary = alert.surface === "balance"
      ? `The ${provider} account that Berry uses has no credit left.`
      : `Berry can't get responses from ${provider} because the provider reports that its account is out of credit or quota.`;
    facts = [
      ["Provider", providerLabel],
      ["Affected", "Chat and agent responses that use this provider"],
      [alert.surface === "balance" ? "Checked" : "First detected", when],
      ...responseFact,
      ...(alert.balance ? [["Remaining", amount(alert.balance.remaining)]] as Array<[string, string]> : []),
      ["Organization", organization],
    ];
    usersSee = { text: "Requests that use this provider fail with this message:", quote: PROVIDER_CREDIT_EXHAUSTED_MESSAGE };
    steps = [
      `Sign in to the ${provider} account and add credit, or raise the spending limit on the API key Berry uses.`,
      "Check the account's billing settings, such as the payment method and automatic top-up.",
      "Nothing needs to change in Berry. Requests work again as soon as the provider accepts them.",
    ];
  }
  const reason = input.recipientSource === "administrators"
    ? `You are receiving this because you are an owner or administrator of ${organization} and no alert email destination is set up. To send these alerts to a shared mailbox instead, add an email destination under Reports & alerts in Berry's admin settings.`
    : `You are receiving this because this address is an alert email destination for ${organization}.`;
  const cadence = `Berry sends at most one email per provider and problem every ${PROVIDER_CREDIT_ALERT_DEDUPE_HOURS} hours.`;

  const text = [
    summary,
    "",
    "What happened",
    ...facts.map(([label, value]) => `- ${label}: ${value}`),
    "",
    "What users see",
    usersSee.text,
    ...(usersSee.quote ? [`"${usersSee.quote}"`] : []),
    "",
    "What to do",
    ...steps.map((step, index) => `${index + 1}. ${step}`),
    ...(billingUrl ? ["", `Billing page: ${billingUrl}`] : []),
    "",
    `${reason} ${cadence}`,
  ].join("\n");

  const muted = "color:#57606a";
  const html = [
    "<!doctype html>",
    '<html><body style="margin:0;padding:24px;background:#ffffff;color:#1f2328;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5">',
    '<div style="max-width:560px">',
    `<p style="margin:0 0 16px">${escapeHtml(summary)}</p>`,
    '<h2 style="margin:20px 0 8px;font-size:15px">What happened</h2>',
    '<table role="presentation" style="border-collapse:collapse">',
    ...facts.map(([label, value]) =>
      `<tr><td style="padding:2px 16px 2px 0;${muted};vertical-align:top">${escapeHtml(label)}</td><td style="padding:2px 0">${escapeHtml(value)}</td></tr>`
    ),
    "</table>",
    '<h2 style="margin:20px 0 8px;font-size:15px">What users see</h2>',
    `<p style="margin:0">${escapeHtml(usersSee.text)}</p>`,
    ...(usersSee.quote
      ? [`<blockquote style="margin:8px 0;padding:8px 12px;border-left:3px solid #d0d7de;${muted}">${escapeHtml(usersSee.quote)}</blockquote>`]
      : []),
    '<h2 style="margin:20px 0 8px;font-size:15px">What to do</h2>',
    '<ol style="margin:0;padding-left:20px">',
    ...steps.map((step) => `<li>${escapeHtml(step)}</li>`),
    "</ol>",
    ...(billingUrl
      ? [`<p style="margin:12px 0 0">Billing page: <a href="${escapeHtml(billingUrl)}">${escapeHtml(billingUrl)}</a></p>`]
      : []),
    `<p style="margin:24px 0 0;font-size:12px;${muted}">${escapeHtml(reason)} ${escapeHtml(cadence)}</p>`,
    "</div></body></html>",
  ].join("\n");
  return { subject, text, html };
}

/** A short email for an alert rule raised by `alerts.evaluate`. */
export function ruleAlertEmail(input: {
  ruleName: string;
  signal: string;
  observed: number;
  threshold: number;
  windowKey: string;
  raisedAt: string;
  organizationName: string | null;
}): Omit<EmailMessage, "to"> {
  const organization = input.organizationName ?? "your Berry organization";
  const facts: Array<[string, string]> = [
    ["Signal", input.signal.replaceAll("_", " ")],
    ["Observed", String(input.observed)],
    ["Threshold", String(input.threshold)],
    ["Window", input.windowKey],
    ["Raised", formatUtc(input.raisedAt)],
    ["Organization", organization],
  ];
  const summary = `The alert rule "${input.ruleName}" was triggered.`;
  const footer = `You are receiving this because this address is an alert email destination for ${organization}. Review the rule under Reports & alerts in Berry's admin settings.`;
  return {
    subject: `Berry alert: ${input.ruleName}`,
    text: [summary, "", ...facts.map(([label, value]) => `- ${label}: ${value}`), "", footer].join("\n"),
    html: [
      "<!doctype html>",
      '<html><body style="margin:0;padding:24px;background:#ffffff;color:#1f2328;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5">',
      `<p style="margin:0 0 16px">${escapeHtml(summary)}</p>`,
      '<table role="presentation" style="border-collapse:collapse">',
      ...facts.map(([label, value]) =>
        `<tr><td style="padding:2px 16px 2px 0;color:#57606a">${escapeHtml(label)}</td><td style="padding:2px 0">${escapeHtml(value)}</td></tr>`
      ),
      "</table>",
      `<p style="margin:24px 0 0;font-size:12px;color:#57606a">${escapeHtml(footer)}</p>`,
      "</body></html>",
    ].join("\n"),
  };
}

/** Known billing pages; other providers get the generic steps only. */
export function providerBillingUrl(host: string | null): string | null {
  if (host === "openrouter.ai" || host?.endsWith(".openrouter.ai")) return "https://openrouter.ai/settings/credits";
  if (host === "api.deepseek.com" || host === "platform.deepseek.com") return "https://platform.deepseek.com/top_up";
  return null;
}

/** Runs statements on one connection with the tenant's row-level-security context set. */
export async function withTenantTransaction<T>(
  executor: SqlExecutor,
  tenantId: string,
  callback: (executor: SqlExecutor) => Promise<T>,
): Promise<T> {
  const run = async (scoped: SqlExecutor): Promise<T> => {
    await scoped.execute("SELECT berry_set_tenant_id($1::uuid)", [tenantId]);
    return callback(scoped);
  };
  return executor.transaction ? executor.transaction(run) : run(executor);
}

export function emailList(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [];
  const unique = new Map<string, string>();
  for (const candidate of values) {
    if (typeof candidate !== "string") continue;
    const address = candidate.trim();
    if (isEmailAddress(address) && !unique.has(address.toLowerCase())) unique.set(address.toLowerCase(), address);
  }
  return [...unique.values()];
}

function formatUtc(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
