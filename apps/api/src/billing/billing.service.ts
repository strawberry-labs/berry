import { randomUUID } from "node:crypto";
import {
  BillingAccountSummarySchema,
  BillingCreditGrantSchema,
  BillingInvoiceSchema,
  BillingMeterEventSchema,
  AutoRefillConfigurationSchema,
  CreditLedgerPageSchema,
  type BillingAccountSummary,
  type BillingCreditGrant,
  type BillingCreditGrantCreate,
  type BillingInvoice,
  type BillingMeterEvent,
  type BillingMeterEventCreate,
  type BillingProviderKind,
  type AutoRefillConfiguration,
  type JsonValue,
} from "@berry/shared";
import type { CloudDatabaseService, SqlExecutor } from "../db/cloud-database.service.ts";
import { publicDeploymentModeFromEnv } from "../deployment-mode.ts";

export const BILLING_SERVICE = Symbol("BILLING_SERVICE");

export type BillingProviderReportInput = {
  tenantId: string;
  requestId: string;
  meter: string;
  quantity: string;
  costBilledMicros: string;
  metadata: JsonValue;
};

export type BillingProviderReportResult = {
  status: "reported" | "skipped" | "failed";
  externalEventId: string | null;
  reportedAt: string | null;
  metadata?: JsonValue | undefined;
};

export interface BillingProvider {
  readonly kind: BillingProviderKind;
  configured(): boolean;
  reportMeterEvent(input: BillingProviderReportInput): Promise<BillingProviderReportResult>;
}

export interface BillingRepository {
  accountSummary(tenantId: string, provider: BillingProviderKind, providerConfigured: boolean, dependencyRequired: boolean): Promise<BillingAccountSummary>;
  createCreditGrant(tenantId: string, actorUserId: string | null, input: BillingCreditGrantCreate): Promise<BillingCreditGrant>;
  recordMeterEvent(tenantId: string, input: BillingMeterEventCreate, provider: BillingProviderKind, result: BillingProviderReportResult): Promise<BillingMeterEvent>;
  listInvoices(tenantId: string): Promise<BillingInvoice[]>;
  ledger(tenantId: string, cursor?: string): Promise<ReturnType<typeof CreditLedgerPageSchema.parse>>;
  autoRefill(tenantId: string, supported: boolean): Promise<AutoRefillConfiguration>;
  setAutoRefill(tenantId: string, actorUserId: string | null, input: Omit<AutoRefillConfiguration, "supported"> & { idempotencyKey: string }): Promise<AutoRefillConfiguration>;
}

export type BillingServiceOptions = {
  repository: BillingRepository;
  provider: BillingProvider;
  dependencyRequired?: boolean | undefined;
};

export class BillingService {
  constructor(private readonly options: BillingServiceOptions) {}

  accountSummary(tenantId: string): Promise<BillingAccountSummary> {
    return this.options.repository.accountSummary(
      tenantId,
      this.options.provider.kind,
      this.options.provider.configured(),
      this.options.dependencyRequired ?? this.options.provider.kind !== "none",
    );
  }

  createCreditGrant(tenantId: string, actorUserId: string | null, input: BillingCreditGrantCreate): Promise<BillingCreditGrant> {
    return this.options.repository.createCreditGrant(tenantId, actorUserId, input);
  }

  async reportMeterEvent(tenantId: string, input: BillingMeterEventCreate): Promise<BillingMeterEvent> {
    const providerResult = await this.options.provider.reportMeterEvent({
      tenantId,
      requestId: input.requestId,
      meter: input.meter,
      quantity: input.quantity,
      costBilledMicros: input.costBilledMicros,
      metadata: input.metadata,
    });
    return this.options.repository.recordMeterEvent(tenantId, input, this.options.provider.kind, providerResult);
  }

  listInvoices(tenantId: string): Promise<BillingInvoice[]> {
    return this.options.repository.listInvoices(tenantId);
  }
  ledger(tenantId:string,cursor?:string){return this.options.repository.ledger(tenantId,cursor);}
  autoRefill(tenantId:string){return this.options.repository.autoRefill(tenantId,this.options.provider.kind!=="none"&&this.options.provider.configured());}
  setAutoRefill(tenantId:string,actorUserId:string|null,input:Omit<AutoRefillConfiguration,"supported">&{idempotencyKey:string}){return this.options.repository.setAutoRefill(tenantId,actorUserId,input);}
}

export class NoopBillingProvider implements BillingProvider {
  readonly kind = "none" as const;
  configured(): boolean { return true; }
  async reportMeterEvent(): Promise<BillingProviderReportResult> {
    return { status: "skipped", externalEventId: null, reportedAt: null, metadata: { reason: "billing_provider_none" } };
  }
}

export class StripeBillingProvider implements BillingProvider {
  readonly kind = "stripe" as const;
  constructor(private readonly options: {
    secretKey?: string | undefined;
    meterEventName?: string | undefined;
    apiBaseUrl?: string | undefined;
    fetchImpl?: typeof fetch | undefined;
  }) {}

  configured(): boolean {
    return Boolean(this.options.secretKey && this.options.meterEventName);
  }

  async reportMeterEvent(input: BillingProviderReportInput): Promise<BillingProviderReportResult> {
    if (!this.configured()) {
      return { status: "failed", externalEventId: null, reportedAt: null, metadata: { reason: "stripe_not_configured" } };
    }
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const idempotencyKey = `${input.tenantId}:${input.requestId}:${input.meter}`;
    const body = new URLSearchParams({
      event_name: this.options.meterEventName!,
      identifier: idempotencyKey,
      timestamp: String(Math.floor(Date.now() / 1000)),
      "payload[value]": input.quantity,
      "payload[tenant_id]": input.tenantId,
      "payload[request_id]": input.requestId,
      "payload[meter]": input.meter,
      "payload[cost_billed_micros]": input.costBilledMicros,
    });
    const response = await fetchImpl(`${(this.options.apiBaseUrl ?? "https://api.stripe.com").replace(/\/+$/, "")}/v1/billing/meter_events`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Idempotency-Key": idempotencyKey,
      },
      body,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        status: "failed",
        externalEventId: typeof payload === "object" && payload && "id" in payload ? String(payload.id) : null,
        reportedAt: null,
        metadata: { stripeStatus: response.status, stripeError: payload as JsonValue },
      };
    }
    return {
      status: "reported",
      externalEventId: typeof payload === "object" && payload && "id" in payload ? String(payload.id) : null,
      reportedAt: new Date().toISOString(),
      metadata: { stripeStatus: response.status },
    };
  }
}

export class InMemoryBillingRepository implements BillingRepository {
  readonly #grants = new Map<string, BillingCreditGrant>();
  readonly #grantMutations = new Map<string, BillingCreditGrant>();
  readonly #events = new Map<string, BillingMeterEvent>();
  readonly #invoices = new Map<string, BillingInvoice>();
  readonly #ledger: Array<ReturnType<typeof CreditLedgerPageSchema.parse>["items"][number]> = [];
  readonly #autoRefill = new Map<string, AutoRefillConfiguration>();

  async accountSummary(tenantId: string, provider: BillingProviderKind, providerConfigured: boolean, dependencyRequired: boolean): Promise<BillingAccountSummary> {
    const activeGrants = [...this.#grants.values()].filter((grant) => grant.tenantId === tenantId && grant.status === "active");
    const recentMeterEvents = [...this.#events.values()].filter((event) => event.tenantId === tenantId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 50);
    const invoices = await this.listInvoices(tenantId);
    return BillingAccountSummarySchema.parse({
      tenantId,
      provider,
      providerConfigured,
      billingDependencyRequired: dependencyRequired,
      prepaidBalanceMicros: sumMicros(activeGrants.map((grant) => grant.remainingMicros)),
      currency: activeGrants[0]?.currency ?? invoices[0]?.currency ?? "usd",
      activeGrants,
      recentMeterEvents,
      invoices,
      updatedAt: new Date().toISOString(),
    });
  }

  async createCreditGrant(tenantId: string, actorUserId: string | null, input: BillingCreditGrantCreate): Promise<BillingCreditGrant> {
    const key = `${tenantId}:${input.idempotencyKey}`;
    const prior = this.#grantMutations.get(key);
    if (prior) return prior;
    const now = new Date().toISOString();
    const grant = BillingCreditGrantSchema.parse({
      id: randomUUID(),
      tenantId,
      source: input.source,
      amountMicros: input.amountMicros,
      remainingMicros: input.amountMicros,
      currency: input.currency,
      externalRef: input.externalRef ?? `idempotency:${input.idempotencyKey}`,
      status: "active",
      metadata: input.metadata,
      createdBy: actorUserId,
      createdAt: now,
      updatedAt: now,
    });
    this.#grants.set(`${tenantId}:${grant.id}`, grant);
    this.#grantMutations.set(key, grant);
    this.#ledger.push({id:randomUUID(),tenantId,kind:"grant",amountMicros:input.amountMicros,balanceAfterMicros:sumMicros([...this.#grants.values()].filter((row)=>row.tenantId===tenantId).map((row)=>row.remainingMicros)),source:input.source,externalRef:grant.externalRef,actorUserId,status:"completed",createdAt:now});
    return grant;
  }

  async recordMeterEvent(tenantId: string, input: BillingMeterEventCreate, provider: BillingProviderKind, result: BillingProviderReportResult): Promise<BillingMeterEvent> {
    const key = `${tenantId}:${input.requestId}:${input.meter}`;
    const existing = this.#events.get(key);
    if (existing) return existing;
    const event = BillingMeterEventSchema.parse({
      id: randomUUID(),
      tenantId,
      usageEventId: input.usageEventId ?? null,
      requestId: input.requestId,
      meter: input.meter,
      quantity: input.quantity,
      costBilledMicros: input.costBilledMicros,
      provider,
      externalEventId: result.externalEventId,
      status: result.status,
      reportedAt: result.reportedAt,
      metadata: mergeMetadata(input.metadata, result.metadata),
      createdAt: new Date().toISOString(),
    });
    this.#events.set(key, event);
    return event;
  }

  async listInvoices(tenantId: string): Promise<BillingInvoice[]> {
    return [...this.#invoices.values()].filter((invoice) => invoice.tenantId === tenantId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async ledger(tenantId:string){return CreditLedgerPageSchema.parse({items:this.#ledger.filter((r)=>r.tenantId===tenantId).slice().reverse(),nextCursor:null,hasMore:false});}
  async autoRefill(tenantId:string,supported:boolean){return AutoRefillConfigurationSchema.parse(this.#autoRefill.get(tenantId)??{supported,enabled:false,triggerBalanceMicros:null,purchaseAmountMicros:null,currency:"usd"});}
  async setAutoRefill(tenantId:string,_actor:string|null,input:Omit<AutoRefillConfiguration,"supported">&{idempotencyKey:string}){const row=AutoRefillConfigurationSchema.parse({supported:true,...input});this.#autoRefill.set(tenantId,row);return row;}
}

export class PostgresBillingRepository implements BillingRepository {
  constructor(private readonly database: CloudDatabaseService) {}

  async accountSummary(tenantId: string, provider: BillingProviderKind, providerConfigured: boolean, dependencyRequired: boolean): Promise<BillingAccountSummary> {
    return this.database.withTenant(tenantId, async (executor) => {
      const grants = (await executor.query<BillingCreditGrantRow>(
        "SELECT * FROM billing_credit_grants WHERE tenant_id = $1::uuid AND status = 'active' ORDER BY created_at DESC LIMIT 100",
        [tenantId],
      )).map(billingCreditGrantFromRow);
      const meterEvents = (await executor.query<BillingMeterEventRow>(
        "SELECT * FROM billing_meter_events WHERE tenant_id = $1::uuid ORDER BY created_at DESC LIMIT 50",
        [tenantId],
      )).map(billingMeterEventFromRow);
      const invoices = (await executor.query<BillingInvoiceRow>(
        "SELECT * FROM billing_invoices WHERE tenant_id = $1::uuid ORDER BY created_at DESC LIMIT 50",
        [tenantId],
      )).map(billingInvoiceFromRow);
      return BillingAccountSummarySchema.parse({
        tenantId,
        provider,
        providerConfigured,
        billingDependencyRequired: dependencyRequired,
        prepaidBalanceMicros: sumMicros(grants.map((grant) => grant.remainingMicros)),
        currency: grants[0]?.currency ?? invoices[0]?.currency ?? "usd",
        activeGrants: grants,
        recentMeterEvents: meterEvents,
        invoices,
        updatedAt: new Date().toISOString(),
      });
    });
  }

  async createCreditGrant(tenantId: string, actorUserId: string | null, input: BillingCreditGrantCreate): Promise<BillingCreditGrant> {
    return this.database.withTenant(tenantId, async (executor) => {
      const rows = await executor.query<BillingCreditGrantRow>(
        `INSERT INTO billing_credit_grants (tenant_id, source, amount_micros, remaining_micros, currency, external_ref, status, metadata, created_by)
         VALUES ($1::uuid, $2, $3, $3, $4, $5, 'active', $6::jsonb, $7::uuid)
         ON CONFLICT (tenant_id, external_ref) DO UPDATE
         SET updated_at = billing_credit_grants.updated_at
         RETURNING *`,
        [tenantId, input.source, input.amountMicros, input.currency, input.externalRef ?? `idempotency:${input.idempotencyKey}`, JSON.stringify({ ...(input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata) ? input.metadata : {}), reason: input.reason, idempotencyKey: input.idempotencyKey }), uuidOrNull(actorUserId)],
      );
      await executor.execute(`INSERT INTO credit_ledger_entries(tenant_id,scope_type,scope_id,request_id,kind,amount_micros,balance_after_micros,metadata) VALUES($1::uuid,'org',$1,$2,'grant',$3,(SELECT COALESCE(sum(remaining_micros),0) FROM billing_credit_grants WHERE tenant_id=$1::uuid),$4::jsonb) ON CONFLICT(tenant_id,request_id,scope_type,scope_id,kind) DO NOTHING`,[tenantId,input.idempotencyKey,input.amountMicros,JSON.stringify({source:input.source,externalRef:input.externalRef??null,actorUserId,reason:input.reason})]);
      return billingCreditGrantFromRow(rows[0]!);
    });
  }

  async recordMeterEvent(tenantId: string, input: BillingMeterEventCreate, provider: BillingProviderKind, result: BillingProviderReportResult): Promise<BillingMeterEvent> {
    return this.database.withTenant(tenantId, async (executor) => {
      const rows = await executor.query<BillingMeterEventRow>(
        `INSERT INTO billing_meter_events (
          tenant_id, usage_event_id, request_id, meter, quantity, cost_billed_micros, provider,
          external_event_id, status, reported_at, metadata
        ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
        ON CONFLICT (tenant_id, request_id, meter) DO NOTHING
        RETURNING *`,
        [
          tenantId,
          uuidOrNull(input.usageEventId ?? null),
          input.requestId,
          input.meter,
          input.quantity,
          input.costBilledMicros,
          provider,
          result.externalEventId,
          result.status,
          result.reportedAt,
          JSON.stringify(mergeMetadata(input.metadata, result.metadata)),
        ],
      );
      if (rows[0]) return billingMeterEventFromRow(rows[0]);
      const existing = await executor.query<BillingMeterEventRow>(
        "SELECT * FROM billing_meter_events WHERE tenant_id = $1::uuid AND request_id = $2 AND meter = $3 LIMIT 1",
        [tenantId, input.requestId, input.meter],
      );
      return billingMeterEventFromRow(existing[0]!);
    });
  }

  async listInvoices(tenantId: string): Promise<BillingInvoice[]> {
    return this.database.withTenant(tenantId, async (executor) => {
      const rows = await executor.query<BillingInvoiceRow>(
        "SELECT * FROM billing_invoices WHERE tenant_id = $1::uuid ORDER BY created_at DESC LIMIT 100",
        [tenantId],
      );
      return rows.map(billingInvoiceFromRow);
    });
  }
  async ledger(tenantId:string,cursor?:string){return this.database.withTenant(tenantId,async executor=>{const rows=await executor.query<any>(`SELECT * FROM credit_ledger_entries WHERE tenant_id=$1::uuid AND ($2::timestamptz IS NULL OR created_at<$2::timestamptz) ORDER BY created_at DESC LIMIT 51`,[tenantId,cursor??null]);const items=rows.slice(0,50).map((r:any)=>({id:r.id,tenantId:r.tenant_id,kind:r.kind==="reserve"?"reservation":r.kind==="reconcile"?"reconciliation":r.kind,amountMicros:String(r.amount_micros),balanceAfterMicros:String(r.balance_after_micros),source:String(r.metadata?.source??r.scope_type),externalRef:r.request_id,actorUserId:null,status:"completed",createdAt:iso(r.created_at)}));return CreditLedgerPageSchema.parse({items,hasMore:rows.length>50,nextCursor:rows.length>50?iso(rows[49].created_at):null});});}
  async autoRefill(tenantId:string,supported:boolean){return this.database.withTenant(tenantId,async executor=>{const r=(await executor.query<any>("SELECT * FROM billing_auto_refill_configs WHERE tenant_id=$1::uuid",[tenantId]))[0];return AutoRefillConfigurationSchema.parse(r?{supported,enabled:r.enabled,triggerBalanceMicros:r.trigger_balance_micros===null?null:String(r.trigger_balance_micros),purchaseAmountMicros:r.purchase_amount_micros===null?null:String(r.purchase_amount_micros),currency:r.currency}:{supported,enabled:false,triggerBalanceMicros:null,purchaseAmountMicros:null,currency:"usd"});});}
  async setAutoRefill(tenantId:string,actor:string|null,input:Omit<AutoRefillConfiguration,"supported">&{idempotencyKey:string}){return this.database.withTenant(tenantId,async executor=>{await executor.execute(`INSERT INTO billing_auto_refill_configs(tenant_id,enabled,trigger_balance_micros,purchase_amount_micros,currency,idempotency_key,updated_by) VALUES($1::uuid,$2,$3,$4,$5,$6,$7::uuid) ON CONFLICT(tenant_id) DO UPDATE SET enabled=excluded.enabled,trigger_balance_micros=excluded.trigger_balance_micros,purchase_amount_micros=excluded.purchase_amount_micros,currency=excluded.currency,idempotency_key=excluded.idempotency_key,updated_by=excluded.updated_by,updated_at=now()`,[tenantId,input.enabled,input.triggerBalanceMicros,input.purchaseAmountMicros,input.currency,input.idempotencyKey,uuidOrNull(actor)]);return AutoRefillConfigurationSchema.parse({supported:true,...input});});}
}

export function createBillingProviderFromEnv(env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch | undefined): BillingProvider {
  const mode = publicDeploymentModeFromEnv(env);
  const provider = (env.BERRY_BILLING_PROVIDER ?? (mode === "self-hosted" ? "none" : "stripe")).trim().toLowerCase();
  if (provider === "stripe") {
    return new StripeBillingProvider({
      secretKey: env.STRIPE_SECRET_KEY,
      meterEventName: env.STRIPE_BILLING_METER_EVENT_NAME ?? env.STRIPE_BILLING_METER_ID,
      apiBaseUrl: env.BERRY_BILLING_STRIPE_API_BASE_URL,
      fetchImpl,
    });
  }
  return new NoopBillingProvider();
}

export function billingDependencyRequiredFromEnv(env: NodeJS.ProcessEnv): boolean {
  const mode = publicDeploymentModeFromEnv(env);
  return mode !== "self-hosted" && (env.BERRY_BILLING_PROVIDER ?? "stripe") !== "none";
}

function billingCreditGrantFromRow(row: BillingCreditGrantRow): BillingCreditGrant {
  return BillingCreditGrantSchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    source: row.source,
    amountMicros: String(row.amount_micros),
    remainingMicros: String(row.remaining_micros),
    currency: row.currency,
    externalRef: row.external_ref,
    status: row.status,
    metadata: row.metadata,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

function billingMeterEventFromRow(row: BillingMeterEventRow): BillingMeterEvent {
  return BillingMeterEventSchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    usageEventId: row.usage_event_id,
    requestId: row.request_id,
    meter: row.meter,
    quantity: String(row.quantity),
    costBilledMicros: String(row.cost_billed_micros),
    provider: row.provider,
    externalEventId: row.external_event_id,
    status: row.status,
    reportedAt: row.reported_at ? iso(row.reported_at) : null,
    metadata: row.metadata,
    createdAt: iso(row.created_at),
  });
}

function billingInvoiceFromRow(row: BillingInvoiceRow): BillingInvoice {
  return BillingInvoiceSchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    provider: row.provider,
    externalInvoiceId: row.external_invoice_id,
    status: row.status,
    totalMicros: String(row.total_micros),
    currency: row.currency,
    hostedInvoiceUrl: row.hosted_invoice_url,
    periodStart: row.period_start ? iso(row.period_start) : null,
    periodEnd: row.period_end ? iso(row.period_end) : null,
    metadata: row.metadata,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

function mergeMetadata(left: JsonValue, right: JsonValue | undefined): JsonValue {
  const leftObject = left && typeof left === "object" && !Array.isArray(left) ? left as Record<string, unknown> : {};
  const rightObject = right && typeof right === "object" && !Array.isArray(right) ? right as Record<string, unknown> : {};
  return { ...leftObject, ...rightObject } as JsonValue;
}

function sumMicros(values: string[]): string {
  return values.reduce((sum, value) => sum + BigInt(value), 0n).toString();
}

function uuidOrNull(value: string | null | undefined): string | null {
  return value && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

type BillingCreditGrantRow = {
  id: string;
  tenant_id: string;
  source: "stripe" | "manual" | "support" | "fixture";
  amount_micros: string;
  remaining_micros: string;
  currency: string;
  external_ref: string | null;
  status: "active" | "voided" | "exhausted";
  metadata: JsonValue;
  created_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type BillingMeterEventRow = {
  id: string;
  tenant_id: string;
  usage_event_id: string | null;
  request_id: string;
  meter: string;
  quantity: string;
  cost_billed_micros: string;
  provider: BillingProviderKind;
  external_event_id: string | null;
  status: "pending" | "reported" | "skipped" | "failed";
  reported_at: Date | string | null;
  metadata: JsonValue;
  created_at: Date | string;
};

type BillingInvoiceRow = {
  id: string;
  tenant_id: string;
  provider: BillingProviderKind;
  external_invoice_id: string | null;
  status: "draft" | "open" | "paid" | "void" | "uncollectible";
  total_micros: string;
  currency: string;
  hosted_invoice_url: string | null;
  period_start: Date | string | null;
  period_end: Date | string | null;
  metadata: JsonValue;
  created_at: Date | string;
  updated_at: Date | string;
};
