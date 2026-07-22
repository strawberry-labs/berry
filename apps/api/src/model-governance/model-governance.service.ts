import { randomUUID } from "node:crypto";
import {
  ModelGovernanceDecisionSchema,
  OrgModelDefaultSchema,
  OrgModelPolicySchema,
  type ConversationKind,
  type JsonValue,
  type ModelApiType,
  type ModelCapabilities,
  type ModelGovernanceDecision,
  type OrgModelDefault,
  type OrgModelPolicy,
} from "@berry/shared";
import { SELF_HOST_TENANT_ID } from "@berry/db";
import type { CloudDatabaseService, SqlExecutor } from "../db/cloud-database.service.ts";

export const MODEL_GOVERNANCE_SERVICE = Symbol("MODEL_GOVERNANCE_SERVICE");

export type UpsertModelPolicyInput = {
  tenantId: string;
  providerId: string;
  model: string;
  displayName?: string | null | undefined;
  presetId?: string | null | undefined;
  apiType?: ModelApiType | null | undefined;
  capabilities?: ModelCapabilities | undefined;
  status?: "allowed" | "blocked" | undefined;
  enforce?: boolean | undefined;
  modeAllow?: ConversationKind[] | undefined;
  metadata?: JsonValue | undefined;
};

export type UpsertModelDefaultInput = {
  tenantId: string;
  mode: ConversationKind;
  providerId: string;
  model: string;
  enforce?: boolean | undefined;
};

export interface ModelGovernanceRepository {
  listPolicies(tenantId: string): Promise<OrgModelPolicy[]>;
  upsertPolicy(input: UpsertModelPolicyInput): Promise<OrgModelPolicy>;
  listDefaults(tenantId: string): Promise<OrgModelDefault[]>;
  upsertDefault(input: UpsertModelDefaultInput): Promise<OrgModelDefault>;
}

export class ModelGovernanceService {
  constructor(private readonly repository: ModelGovernanceRepository) {}

  async listModels(tenantId: string, filter: { mode?: ConversationKind | undefined; includeBlocked?: boolean | undefined } = {}): Promise<OrgModelPolicy[]> {
    const policies = await this.repository.listPolicies(tenantId);
    return policies
      .filter((policy) => filter.includeBlocked || policy.status === "allowed")
      .filter((policy) => !filter.mode || policy.modeAllow.includes(filter.mode))
      .sort(comparePolicy);
  }

  async upsertPolicy(input: UpsertModelPolicyInput): Promise<OrgModelPolicy> {
    return this.repository.upsertPolicy(input);
  }

  async listDefaults(tenantId: string): Promise<OrgModelDefault[]> {
    return (await this.repository.listDefaults(tenantId)).sort((left, right) => left.mode.localeCompare(right.mode));
  }

  async upsertDefault(input: UpsertModelDefaultInput): Promise<OrgModelDefault> {
    return this.repository.upsertDefault(input);
  }

  async resolve(input: {
    tenantId: string;
    mode: ConversationKind;
    providerId?: string | null | undefined;
    model?: string | null | undefined;
  }): Promise<ModelGovernanceDecision> {
    const policies = await this.repository.listPolicies(input.tenantId);
    const defaults = await this.repository.listDefaults(input.tenantId);
    const modeDefault = defaults.find((entry) => entry.mode === input.mode) ?? null;
    const requestedProviderId = input.providerId ?? null;
    const requestedModel = input.model ?? null;
    const providerId = requestedProviderId ?? modeDefault?.providerId ?? "";
    const model = requestedModel ?? modeDefault?.model ?? "";
    const policy = policies.find((entry) => entry.providerId === providerId && entry.model === model) ?? null;
    const enforcedAllowList = policies.some((entry) => entry.enforce);
    const enforcedDefaultMismatch = modeDefault?.enforce === true
      && requestedProviderId !== null
      && requestedModel !== null
      && (requestedProviderId !== modeDefault.providerId || requestedModel !== modeDefault.model);

    if (!providerId || !model) return decision(input, providerId, model, false, false, "no_model_selected", policy, modeDefault);
    if (enforcedDefaultMismatch) return decision(input, providerId, model, false, true, "mode_default_enforced", policy, modeDefault);
    if (policy?.status === "blocked") return decision(input, providerId, model, false, policy.enforce, "model_blocked", policy, modeDefault);
    if (policy && !policy.modeAllow.includes(input.mode)) return decision(input, providerId, model, false, policy.enforce, "mode_not_allowed", policy, modeDefault);
    if (!policy && enforcedAllowList) return decision(input, providerId, model, false, true, "not_in_enforced_allowlist", null, modeDefault);
    return decision(input, providerId, model, true, policy?.enforce === true || modeDefault?.enforce === true, policy ? "allowed_by_policy" : "allowed_no_enforced_policy", policy, modeDefault);
  }
}

export class InMemoryModelGovernanceRepository implements ModelGovernanceRepository {
  readonly #policies = new Map<string, OrgModelPolicy>();
  readonly #defaults = new Map<string, OrgModelDefault>();

  constructor(seed = true) {
    if (!seed) return;
    const now = new Date().toISOString();
    const tenantId = SELF_HOST_TENANT_ID;
    this.#policies.set(key(tenantId, "router", "berry/auto"), OrgModelPolicySchema.parse({
      id: "model_policy_self_host_router_auto",
      tenantId,
      providerId: "router",
      model: "berry/auto",
      displayName: "Berry Router Auto",
      presetId: "berry-router",
      apiType: "openai-chat-completions",
      capabilities: { tools: true, vision: true, reasoning: true },
      status: "allowed",
      enforce: false,
      modeAllow: ["chat", "code"],
      metadata: { source: "self-host-seed" },
      createdAt: now,
      updatedAt: now,
    }));
    for (const mode of ["chat", "code"] as const) {
      this.#defaults.set(defaultKey(tenantId, mode), OrgModelDefaultSchema.parse({
        tenantId,
        mode,
        providerId: "router",
        model: "berry/auto",
        enforce: false,
        updatedAt: now,
      }));
    }
  }

  async listPolicies(tenantId: string): Promise<OrgModelPolicy[]> {
    return [...this.#policies.values()].filter((policy) => policy.tenantId === tenantId);
  }

  async upsertPolicy(input: UpsertModelPolicyInput): Promise<OrgModelPolicy> {
    const now = new Date().toISOString();
    const existing = this.#policies.get(key(input.tenantId, input.providerId, input.model));
    const policy = OrgModelPolicySchema.parse({
      id: existing?.id ?? randomUUID(),
      tenantId: input.tenantId,
      providerId: input.providerId,
      model: input.model,
      displayName: input.displayName ?? existing?.displayName ?? null,
      presetId: input.presetId ?? existing?.presetId ?? null,
      apiType: input.apiType ?? existing?.apiType ?? null,
      capabilities: input.capabilities ?? existing?.capabilities ?? {},
      status: input.status ?? existing?.status ?? "allowed",
      enforce: input.enforce ?? existing?.enforce ?? false,
      modeAllow: input.modeAllow ?? existing?.modeAllow ?? ["chat", "code"],
      metadata: input.metadata ?? existing?.metadata ?? {},
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    this.#policies.set(key(input.tenantId, input.providerId, input.model), policy);
    return policy;
  }

  async listDefaults(tenantId: string): Promise<OrgModelDefault[]> {
    return [...this.#defaults.values()].filter((entry) => entry.tenantId === tenantId);
  }

  async upsertDefault(input: UpsertModelDefaultInput): Promise<OrgModelDefault> {
    const now = new Date().toISOString();
    const entry = OrgModelDefaultSchema.parse({
      tenantId: input.tenantId,
      mode: input.mode,
      providerId: input.providerId,
      model: input.model,
      enforce: input.enforce ?? false,
      updatedAt: now,
    });
    this.#defaults.set(defaultKey(input.tenantId, input.mode), entry);
    return entry;
  }
}

export class PostgresModelGovernanceRepository implements ModelGovernanceRepository {
  constructor(private readonly database: CloudDatabaseService) {}

  async listPolicies(tenantId: string): Promise<OrgModelPolicy[]> {
    return this.database.withTenant(tenantId, async (executor) => {
      const rows = await executor.query<ModelPolicyRow>("SELECT * FROM model_governance_policies WHERE tenant_id = $1::uuid ORDER BY provider_id, model", [tenantId]);
      return rows.map(modelPolicyFromRow);
    });
  }

  async upsertPolicy(input: UpsertModelPolicyInput): Promise<OrgModelPolicy> {
    return this.database.withTenant(input.tenantId, async (executor) => {
      const rows = await executor.query<ModelPolicyRow>(
        `
INSERT INTO model_governance_policies (
  tenant_id, provider_id, model, display_name, preset_id, api_type, capabilities, status, enforce, mode_allow, metadata, updated_at
) VALUES (
  $1::uuid, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::jsonb, $11::jsonb, now()
)
ON CONFLICT (tenant_id, provider_id, model)
DO UPDATE SET
  display_name = excluded.display_name,
  preset_id = excluded.preset_id,
  api_type = excluded.api_type,
  capabilities = excluded.capabilities,
  status = excluded.status,
  enforce = excluded.enforce,
  mode_allow = excluded.mode_allow,
  metadata = excluded.metadata,
  updated_at = now()
RETURNING *
        `.trim(),
        [
          input.tenantId,
          input.providerId,
          input.model,
          input.displayName ?? null,
          input.presetId ?? null,
          input.apiType ?? null,
          JSON.stringify(input.capabilities ?? {}),
          input.status ?? "allowed",
          input.enforce ?? false,
          JSON.stringify(input.modeAllow ?? ["chat", "code"]),
          JSON.stringify(input.metadata ?? {}),
        ],
      );
      return modelPolicyFromRow(rows[0]!);
    });
  }

  async listDefaults(tenantId: string): Promise<OrgModelDefault[]> {
    return this.database.withTenant(tenantId, async (executor) => {
      const rows = await executor.query<ModelDefaultRow>("SELECT * FROM model_mode_defaults WHERE tenant_id = $1::uuid ORDER BY mode", [tenantId]);
      return rows.filter((row) => row.mode !== "cowork").map(modelDefaultFromRow);
    });
  }

  async upsertDefault(input: UpsertModelDefaultInput): Promise<OrgModelDefault> {
    return this.database.withTenant(input.tenantId, async (executor) => upsertDefaultRow(executor, input));
  }
}

function decision(input: { tenantId: string; mode: ConversationKind; providerId?: string | null | undefined; model?: string | null | undefined }, providerId: string, model: string, allowed: boolean, enforced: boolean, reason: string, policy: OrgModelPolicy | null, modelDefault: OrgModelDefault | null): ModelGovernanceDecision {
  return ModelGovernanceDecisionSchema.parse({
    tenantId: input.tenantId,
    mode: input.mode,
    requestedProviderId: input.providerId ?? null,
    requestedModel: input.model ?? null,
    providerId,
    model,
    allowed,
    enforced,
    reason,
    policy,
    default: modelDefault,
  });
}

function comparePolicy(left: OrgModelPolicy, right: OrgModelPolicy): number {
  return left.providerId.localeCompare(right.providerId) || left.model.localeCompare(right.model);
}

function key(tenantId: string, providerId: string, model: string): string {
  return `${tenantId}:${providerId}:${model}`;
}

function defaultKey(tenantId: string, mode: ConversationKind): string {
  return `${tenantId}:${mode}`;
}

async function upsertDefaultRow(executor: SqlExecutor, input: UpsertModelDefaultInput): Promise<OrgModelDefault> {
  const rows = await executor.query<ModelDefaultRow>(
    `
INSERT INTO model_mode_defaults (tenant_id, mode, provider_id, model, enforce, updated_at)
VALUES ($1::uuid, $2, $3, $4, $5, now())
ON CONFLICT (tenant_id, mode)
DO UPDATE SET provider_id = excluded.provider_id, model = excluded.model, enforce = excluded.enforce, updated_at = now()
RETURNING *
    `.trim(),
    [input.tenantId, input.mode, input.providerId, input.model, input.enforce ?? false],
  );
  return modelDefaultFromRow(rows[0]!);
}

function modelPolicyFromRow(row: ModelPolicyRow): OrgModelPolicy {
  return OrgModelPolicySchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    providerId: row.provider_id,
    model: row.model,
    displayName: row.display_name,
    presetId: row.preset_id,
    apiType: row.api_type,
    capabilities: row.capabilities ?? {},
    status: row.status,
    enforce: row.enforce,
    modeAllow: row.mode_allow ?? ["chat", "code"],
    metadata: row.metadata ?? {},
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

function modelDefaultFromRow(row: ModelDefaultRow): OrgModelDefault {
  return OrgModelDefaultSchema.parse({
    tenantId: row.tenant_id,
    mode: row.mode,
    providerId: row.provider_id,
    model: row.model,
    enforce: row.enforce,
    updatedAt: iso(row.updated_at),
  });
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

type ModelPolicyRow = {
  id: string;
  tenant_id: string;
  provider_id: string;
  model: string;
  display_name: string | null;
  preset_id: string | null;
  api_type: string | null;
  capabilities: JsonValue;
  status: "allowed" | "blocked";
  enforce: boolean;
  mode_allow: JsonValue;
  metadata: JsonValue;
  created_at: Date | string;
  updated_at: Date | string;
};

type ModelDefaultRow = {
  tenant_id: string;
  mode: string;
  provider_id: string;
  model: string;
  enforce: boolean;
  updated_at: Date | string;
};
