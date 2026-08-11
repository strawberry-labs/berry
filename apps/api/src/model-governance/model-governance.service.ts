import { randomUUID } from "node:crypto";
import {
  ModelGovernanceDecisionSchema,
  OrganizationModelProviderSchema,
  OrgAuxiliaryModelDefaultSchema,
  OrgAiAccessRuleSchema,
  OrgModelDefaultSchema,
  OrgModelPolicySchema,
  type ConversationKind,
  type JsonValue,
  type ModelApiType,
  type ModelCapabilities,
  type ModelGovernanceDecision,
  type OrganizationModelProvider,
  type OrganizationModelProviderUpsert,
  type OrgAuxiliaryModelDefault,
  type OrgAuxiliaryModelPurpose,
  type OrgAiAccessRule,
  type OrgAiAccessRuleUpsert,
  type OrgModelDefault,
  type OrgModelPolicy,
} from "@berry/shared";
import { SELF_HOST_TENANT_ID } from "@berry/db";
import type { BerryModelProviderInfo } from "@berry/local-agent";
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

export type UpsertAuxiliaryModelDefaultInput = {
  tenantId: string;
  purpose: OrgAuxiliaryModelPurpose;
  providerId: string;
  model: string;
};

export interface ModelGovernanceRepository {
  listProviders(tenantId: string): Promise<OrganizationModelProvider[]>;
  upsertProvider(tenantId: string, input: OrganizationModelProviderUpsert): Promise<OrganizationModelProvider>;
  updateProviderHealth(
    tenantId: string,
    providerId: string,
    status: "active" | "error",
    lastTestedAt: string,
  ): Promise<OrganizationModelProvider>;
  listAccessRules(tenantId: string, resource?: { resourceType: OrgAiAccessRule["resourceType"]; resourceId: string } | undefined): Promise<OrgAiAccessRule[]>;
  upsertAccessRule(tenantId: string, input: OrgAiAccessRuleUpsert): Promise<OrgAiAccessRule>;
  listPolicies(tenantId: string): Promise<OrgModelPolicy[]>;
  upsertPolicy(input: UpsertModelPolicyInput): Promise<OrgModelPolicy>;
  listDefaults(tenantId: string): Promise<OrgModelDefault[]>;
  upsertDefault(input: UpsertModelDefaultInput): Promise<OrgModelDefault>;
  listAuxiliaryDefaults(tenantId: string): Promise<OrgAuxiliaryModelDefault[]>;
  upsertAuxiliaryDefault(input: UpsertAuxiliaryModelDefaultInput): Promise<OrgAuxiliaryModelDefault>;
}

export class ModelGovernanceService {
  constructor(private readonly repository: ModelGovernanceRepository) {}

  async synchronizeRuntimeCatalog(tenantId: string, provider: BerryModelProviderInfo): Promise<void> {
    const runtimeModels = provider.models ?? [];
    if (runtimeModels.length === 0) return;
    const [policies, defaults] = await Promise.all([
      this.repository.listPolicies(tenantId),
      this.repository.listDefaults(tenantId),
    ]);
    const policiesByModel = new Map(
      policies
        .filter((policy) => policy.providerId === provider.id)
        .map((policy) => [policy.model, policy]),
    );

    for (const model of runtimeModels) {
      const existing = policiesByModel.get(model.id);
      const metadata = {
        ...jsonObject(existing?.metadata),
        source: "runtime-catalog",
      };
      const desired = {
        tenantId,
        providerId: provider.id,
        model: model.id,
        displayName: model.name ?? model.id,
        presetId: provider.kind === "berry-router" ? "berry-router" : existing?.presetId ?? null,
        apiType: model.apiType ?? provider.apiType ?? existing?.apiType ?? null,
        capabilities: model.capabilities ?? existing?.capabilities ?? {},
        status: existing?.status ?? "allowed" as const,
        enforce: existing?.enforce ?? false,
        modeAllow: existing?.modeAllow ?? ["chat", "code"] as ConversationKind[],
        metadata,
      };
      if (!existing || !runtimePolicyMatches(existing, desired)) {
        await this.repository.upsertPolicy(desired);
      }
    }

    const runtimeModelIds = new Set(runtimeModels.map((model) => model.id));
    const staleAlias = policiesByModel.get("berry/auto");
    if (!runtimeModelIds.has("berry/auto") && staleAlias) {
      const desired = {
        tenantId,
        providerId: provider.id,
        model: staleAlias.model,
        displayName: staleAlias.displayName,
        presetId: staleAlias.presetId,
        apiType: staleAlias.apiType,
        capabilities: staleAlias.capabilities,
        status: "blocked" as const,
        enforce: staleAlias.enforce,
        modeAllow: staleAlias.modeAllow,
        metadata: {
          ...jsonObject(staleAlias.metadata),
          source: "runtime-catalog",
          retiredReason: "not-in-runtime-catalog",
        },
      };
      if (!runtimePolicyMatches(staleAlias, desired)) {
        await this.repository.upsertPolicy(desired);
      }
    }

    if (runtimeModelIds.has("berry/auto")) return;
    const runtimeDefault = runtimeModelIds.has(provider.defaultModel)
      ? provider.defaultModel
      : runtimeModels[0]!.id;
    for (const modelDefault of defaults) {
      if (modelDefault.providerId !== provider.id || modelDefault.model !== "berry/auto") continue;
      await this.repository.upsertDefault({
        tenantId,
        mode: modelDefault.mode,
        providerId: provider.id,
        model: runtimeDefault,
        enforce: modelDefault.enforce,
      });
    }
  }

  listProviders(tenantId: string) {
    return this.repository.listProviders(tenantId);
  }

  upsertProvider(tenantId: string, input: OrganizationModelProviderUpsert) {
    return this.repository.upsertProvider(tenantId, input);
  }

  updateProviderHealth(
    tenantId: string,
    providerId: string,
    status: "active" | "error",
    lastTestedAt = new Date().toISOString(),
  ) {
    return this.repository.updateProviderHealth(tenantId, providerId, status, lastTestedAt);
  }

  listAccessRules(tenantId: string, resource?: { resourceType: OrgAiAccessRule["resourceType"]; resourceId: string } | undefined) {
    return this.repository.listAccessRules(tenantId, resource);
  }

  upsertAccessRule(tenantId: string, input: OrgAiAccessRuleUpsert) {
    if (input.scopeType === "org" && input.scopeId !== tenantId) {
      throw new Error("Organization access rules must target their own organization");
    }
    return this.repository.upsertAccessRule(tenantId, input);
  }

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

  async listAuxiliaryDefaults(tenantId: string): Promise<OrgAuxiliaryModelDefault[]> {
    return this.repository.listAuxiliaryDefaults(tenantId);
  }

  async auxiliaryDefault(
    tenantId: string,
    purpose: OrgAuxiliaryModelPurpose,
  ): Promise<OrgAuxiliaryModelDefault | null> {
    return (await this.repository.listAuxiliaryDefaults(tenantId))
      .find((entry) => entry.purpose === purpose) ?? null;
  }

  async upsertAuxiliaryDefault(input: UpsertAuxiliaryModelDefaultInput): Promise<OrgAuxiliaryModelDefault> {
    const policy = (await this.repository.listPolicies(input.tenantId))
      .find((entry) => entry.providerId === input.providerId && entry.model === input.model);
    if (!policy || policy.status !== "allowed") {
      throw new Error("The selected auxiliary model must be allowed in this organization");
    }
    if (input.purpose === "vision" && policy.capabilities.vision !== true) {
      throw new Error("The selected vision model must declare vision support");
    }
    return this.repository.upsertAuxiliaryDefault(input);
  }

  async resolveAuxiliary(input: {
    tenantId: string;
    purpose: OrgAuxiliaryModelPurpose;
    mode: ConversationKind;
    userId?: string | null | undefined;
    departmentId?: string | null | undefined;
  }): Promise<ModelGovernanceDecision | null> {
    const selected = await this.auxiliaryDefault(input.tenantId, input.purpose);
    if (!selected) return null;
    const request = {
      ...input,
      providerId: selected.providerId,
      model: selected.model,
    };
    const policy = (await this.repository.listPolicies(input.tenantId))
      .find((entry) => entry.providerId === selected.providerId && entry.model === selected.model) ?? null;
    if (!policy || policy.status === "blocked") {
      return decision(request, selected.providerId, selected.model, false, true, policy ? "model_blocked" : "not_in_enforced_allowlist", policy, null, null);
    }
    return this.#resolveAccess(request, selected.providerId, selected.model, policy, null);
  }

  async resolve(input: {
    tenantId: string;
    mode: ConversationKind;
    providerId?: string | null | undefined;
    model?: string | null | undefined;
    userId?: string | null | undefined;
    departmentId?: string | null | undefined;
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

    if (!providerId || !model) return decision(input, providerId, model, false, false, "no_model_selected", policy, modeDefault, null);
    if (enforcedDefaultMismatch) return decision(input, providerId, model, false, true, "mode_default_enforced", policy, modeDefault, null);
    if (policy?.status === "blocked") return decision(input, providerId, model, false, policy.enforce, "model_blocked", policy, modeDefault, null);
    if (policy && !policy.modeAllow.includes(input.mode)) return decision(input, providerId, model, false, policy.enforce, "mode_not_allowed", policy, modeDefault, null);
    if (!policy && enforcedAllowList) return decision(input, providerId, model, false, true, "not_in_enforced_allowlist", null, modeDefault, null);

    return this.#resolveAccess(input, providerId, model, policy, modeDefault);
  }

  async #resolveAccess(
    input: {
      tenantId: string;
      mode: ConversationKind;
      providerId?: string | null | undefined;
      model?: string | null | undefined;
      userId?: string | null | undefined;
      departmentId?: string | null | undefined;
    },
    providerId: string,
    model: string,
    policy: OrgModelPolicy | null,
    modeDefault: OrgModelDefault | null,
  ): Promise<ModelGovernanceDecision> {
    const rules = await this.repository.listAccessRules(input.tenantId, {
      resourceType: "model",
      resourceId: modelResourceId(providerId, model),
    });
    const organizationBlock = rules.find((rule) => rule.scopeType === "org" && rule.scopeId === input.tenantId && rule.effect === "blocked") ?? null;
    if (organizationBlock) return decision(input, providerId, model, false, true, "blocked_by_organization_rule", policy, modeDefault, organizationBlock);
    const userRule = input.userId ? rules.find((rule) => rule.scopeType === "user" && rule.scopeId === input.userId) ?? null : null;
    const departmentRule = input.departmentId ? rules.find((rule) => rule.scopeType === "department" && rule.scopeId === input.departmentId) ?? null : null;
    const organizationRule = rules.find((rule) => rule.scopeType === "org" && rule.scopeId === input.tenantId) ?? null;
    const accessRule = userRule ?? departmentRule ?? organizationRule;
    if (accessRule?.effect === "blocked") {
      return decision(input, providerId, model, false, true, `blocked_by_${accessRule.scopeType}_rule`, policy, modeDefault, accessRule);
    }
    return decision(
      input,
      providerId,
      model,
      true,
      policy?.enforce === true || modeDefault?.enforce === true || accessRule !== null,
      accessRule ? `allowed_by_${accessRule.scopeType}_rule` : policy ? "allowed_by_policy" : "allowed_no_enforced_policy",
      policy,
      modeDefault,
      accessRule,
    );
  }
}

export class InMemoryModelGovernanceRepository implements ModelGovernanceRepository {
  readonly #providers = new Map<string, OrganizationModelProvider>();
  readonly #accessRules = new Map<string, OrgAiAccessRule>();
  readonly #policies = new Map<string, OrgModelPolicy>();
  readonly #defaults = new Map<string, OrgModelDefault>();
  readonly #auxiliaryDefaults = new Map<string, OrgAuxiliaryModelDefault>();

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

  async listProviders(tenantId: string): Promise<OrganizationModelProvider[]> {
    return [...this.#providers.values()]
      .filter((provider) => provider.tenantId === tenantId)
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
  }

  async listAccessRules(tenantId: string, resource?: { resourceType: OrgAiAccessRule["resourceType"]; resourceId: string } | undefined): Promise<OrgAiAccessRule[]> {
    return [...this.#accessRules.values()]
      .filter((rule) => rule.tenantId === tenantId)
      .filter((rule) => !resource || rule.resourceType === resource.resourceType && rule.resourceId === resource.resourceId)
      .sort(compareAccessRule);
  }

  async upsertAccessRule(tenantId: string, input: OrgAiAccessRuleUpsert): Promise<OrgAiAccessRule> {
    const ruleKey = accessRuleKey(tenantId, input);
    const current = this.#accessRules.get(ruleKey);
    const now = new Date().toISOString();
    const rule = OrgAiAccessRuleSchema.parse({
      ...input,
      id: current?.id ?? randomUUID(),
      tenantId,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    });
    this.#accessRules.set(ruleKey, rule);
    return rule;
  }

  async upsertProvider(
    tenantId: string,
    input: OrganizationModelProviderUpsert,
  ): Promise<OrganizationModelProvider> {
    const key = `${tenantId}:${input.providerId}`;
    const current = this.#providers.get(key);
    const now = new Date().toISOString();
    const provider = OrganizationModelProviderSchema.parse({
      ...input,
      id: current?.id ?? randomUUID(),
      tenantId,
      status: input.enabled ? "configured" : "disabled",
      lastTestedAt: null,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    });
    this.#providers.set(key, provider);
    return provider;
  }

  async updateProviderHealth(
    tenantId: string,
    providerId: string,
    status: "active" | "error",
    lastTestedAt: string,
  ): Promise<OrganizationModelProvider> {
    const providerKey = `${tenantId}:${providerId}`;
    const current = this.#providers.get(providerKey);
    if (!current || !current.enabled) throw new Error("Enabled organization model provider not found");
    const provider = OrganizationModelProviderSchema.parse({
      ...current,
      status,
      lastTestedAt,
      updatedAt: lastTestedAt,
    });
    this.#providers.set(providerKey, provider);
    return provider;
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

  async listAuxiliaryDefaults(tenantId: string): Promise<OrgAuxiliaryModelDefault[]> {
    return [...this.#auxiliaryDefaults.values()].filter((entry) => entry.tenantId === tenantId);
  }

  async upsertAuxiliaryDefault(input: UpsertAuxiliaryModelDefaultInput): Promise<OrgAuxiliaryModelDefault> {
    const entry = OrgAuxiliaryModelDefaultSchema.parse({
      ...input,
      updatedAt: new Date().toISOString(),
    });
    this.#auxiliaryDefaults.set(auxiliaryDefaultKey(input.tenantId, input.purpose), entry);
    return entry;
  }
}

export class PostgresModelGovernanceRepository implements ModelGovernanceRepository {
  constructor(private readonly database: CloudDatabaseService) {}

  async listProviders(tenantId: string): Promise<OrganizationModelProvider[]> {
    return this.database.withTenant(tenantId, async (executor) => {
      const rows = await executor.query<OrganizationProviderRow>(
        "SELECT * FROM organization_model_providers WHERE tenant_id = $1::uuid ORDER BY display_name",
        [tenantId],
      );
      return rows.map(organizationProviderFromRow);
    });
  }

  async upsertProvider(
    tenantId: string,
    input: OrganizationModelProviderUpsert,
  ): Promise<OrganizationModelProvider> {
    return this.database.withTenant(tenantId, async (executor) => {
      const rows = await executor.query<OrganizationProviderRow>(
        `INSERT INTO organization_model_providers (
           tenant_id, provider_id, display_name, kind, api_type, base_url,
           endpoint_path, models_path, auth_type, credential_ref, default_model,
           enabled, status
         ) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (tenant_id, provider_id) DO UPDATE SET
           display_name=excluded.display_name,kind=excluded.kind,api_type=excluded.api_type,
           base_url=excluded.base_url,endpoint_path=excluded.endpoint_path,
           models_path=excluded.models_path,auth_type=excluded.auth_type,
           credential_ref=excluded.credential_ref,default_model=excluded.default_model,
           enabled=excluded.enabled,status=excluded.status,last_tested_at=NULL,updated_at=now()
         RETURNING *`,
        [
          tenantId,
          input.providerId,
          input.displayName,
          input.kind,
          input.apiType,
          input.baseUrl,
          input.endpointPath,
          input.modelsPath,
          input.authType,
          input.credentialRef,
          input.defaultModel,
          input.enabled,
          input.enabled ? "configured" : "disabled",
        ],
      );
      return organizationProviderFromRow(rows[0]!);
    });
  }

  async updateProviderHealth(
    tenantId: string,
    providerId: string,
    status: "active" | "error",
    lastTestedAt: string,
  ): Promise<OrganizationModelProvider> {
    return this.database.withTenant(tenantId, async (executor) => {
      const rows = await executor.query<OrganizationProviderRow>(
        `UPDATE organization_model_providers
         SET status=$3,last_tested_at=$4::timestamptz,updated_at=now()
         WHERE tenant_id=$1::uuid AND provider_id=$2 AND enabled=true
         RETURNING *`,
        [tenantId, providerId, status, lastTestedAt],
      );
      if (!rows[0]) throw new Error("Enabled organization model provider not found");
      return organizationProviderFromRow(rows[0]);
    });
  }


  async listAccessRules(tenantId: string, resource?: { resourceType: OrgAiAccessRule["resourceType"]; resourceId: string } | undefined): Promise<OrgAiAccessRule[]> {
    return this.database.withTenant(tenantId, async (executor) => {
      const rows = await executor.query<AiAccessRuleRow>(
        `SELECT * FROM organization_ai_access_rules
         WHERE tenant_id=$1::uuid
           AND ($2::text IS NULL OR resource_type=$2)
           AND ($3::text IS NULL OR resource_id=$3)
         ORDER BY resource_type,resource_id,scope_type,scope_id`,
        [tenantId, resource?.resourceType ?? null, resource?.resourceId ?? null],
      );
      return rows.map(aiAccessRuleFromRow);
    });
  }

  async upsertAccessRule(tenantId: string, input: OrgAiAccessRuleUpsert): Promise<OrgAiAccessRule> {
    return this.database.withTenant(tenantId, async (executor) => {
      const rows = await executor.query<AiAccessRuleRow>(
        `INSERT INTO organization_ai_access_rules
           (tenant_id,scope_type,scope_id,resource_type,resource_id,effect)
         VALUES ($1::uuid,$2,$3,$4,$5,$6)
         ON CONFLICT (tenant_id,scope_type,scope_id,resource_type,resource_id)
         DO UPDATE SET effect=excluded.effect,updated_at=now()
         RETURNING *`,
        [tenantId, input.scopeType, input.scopeId, input.resourceType, input.resourceId, input.effect],
      );
      return aiAccessRuleFromRow(rows[0]!);
    });
  }

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

  async listAuxiliaryDefaults(tenantId: string): Promise<OrgAuxiliaryModelDefault[]> {
    return this.database.withTenant(tenantId, async (executor) => {
      const rows = await executor.query<AuxiliaryModelDefaultRow>(
        "SELECT * FROM model_auxiliary_defaults WHERE tenant_id = $1::uuid ORDER BY purpose",
        [tenantId],
      );
      return rows.map(auxiliaryModelDefaultFromRow);
    });
  }

  async upsertAuxiliaryDefault(input: UpsertAuxiliaryModelDefaultInput): Promise<OrgAuxiliaryModelDefault> {
    return this.database.withTenant(input.tenantId, async (executor) => {
      const rows = await executor.query<AuxiliaryModelDefaultRow>(`
INSERT INTO model_auxiliary_defaults (tenant_id,purpose,provider_id,model,updated_at)
VALUES ($1::uuid,$2,$3,$4,now())
ON CONFLICT (tenant_id,purpose)
DO UPDATE SET provider_id=excluded.provider_id,model=excluded.model,updated_at=now()
RETURNING *
      `.trim(), [input.tenantId, input.purpose, input.providerId, input.model]);
      return auxiliaryModelDefaultFromRow(rows[0]!);
    });
  }
}

function decision(input: { tenantId: string; mode: ConversationKind; providerId?: string | null | undefined; model?: string | null | undefined }, providerId: string, model: string, allowed: boolean, enforced: boolean, reason: string, policy: OrgModelPolicy | null, modelDefault: OrgModelDefault | null, accessRule: OrgAiAccessRule | null): ModelGovernanceDecision {
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
    accessRule,
  });
}

function comparePolicy(left: OrgModelPolicy, right: OrgModelPolicy): number {
  return left.providerId.localeCompare(right.providerId) || left.model.localeCompare(right.model);
}

function jsonObject(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : {};
}

function runtimePolicyMatches(
  existing: OrgModelPolicy,
  desired: Omit<UpsertModelPolicyInput, "tenantId"> & { tenantId: string },
): boolean {
  return existing.displayName === (desired.displayName ?? null)
    && existing.presetId === (desired.presetId ?? null)
    && existing.apiType === (desired.apiType ?? null)
    && existing.status === desired.status
    && existing.enforce === desired.enforce
    && canonicalJson(existing.capabilities) === canonicalJson(desired.capabilities)
    && canonicalJson(existing.modeAllow) === canonicalJson(desired.modeAllow)
    && canonicalJson(existing.metadata) === canonicalJson(desired.metadata);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function compareAccessRule(left: OrgAiAccessRule, right: OrgAiAccessRule): number {
  return left.resourceType.localeCompare(right.resourceType)
    || left.resourceId.localeCompare(right.resourceId)
    || left.scopeType.localeCompare(right.scopeType)
    || left.scopeId.localeCompare(right.scopeId);
}

function modelResourceId(providerId: string, model: string): string {
  return `${providerId}:${model}`;
}

function accessRuleKey(tenantId: string, input: Pick<OrgAiAccessRule, "scopeType" | "scopeId" | "resourceType" | "resourceId">): string {
  return `${tenantId}:${input.scopeType}:${input.scopeId}:${input.resourceType}:${input.resourceId}`;
}

function key(tenantId: string, providerId: string, model: string): string {
  return `${tenantId}:${providerId}:${model}`;
}

function defaultKey(tenantId: string, mode: ConversationKind): string {
  return `${tenantId}:${mode}`;
}

function auxiliaryDefaultKey(tenantId: string, purpose: OrgAuxiliaryModelPurpose): string {
  return `${tenantId}:${purpose}`;
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

function organizationProviderFromRow(row: OrganizationProviderRow): OrganizationModelProvider {
  return OrganizationModelProviderSchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    providerId: row.provider_id,
    displayName: row.display_name,
    kind: row.kind,
    apiType: row.api_type,
    baseUrl: row.base_url,
    endpointPath: row.endpoint_path,
    modelsPath: row.models_path,
    authType: row.auth_type,
    credentialRef: row.credential_ref,
    defaultModel: row.default_model,
    enabled: row.enabled,
    status: row.status,
    lastTestedAt: row.last_tested_at ? iso(row.last_tested_at) : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

function aiAccessRuleFromRow(row: AiAccessRuleRow): OrgAiAccessRule {
  return OrgAiAccessRuleSchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    effect: row.effect,
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

function auxiliaryModelDefaultFromRow(row: AuxiliaryModelDefaultRow): OrgAuxiliaryModelDefault {
  return OrgAuxiliaryModelDefaultSchema.parse({
    tenantId: row.tenant_id,
    purpose: row.purpose,
    providerId: row.provider_id,
    model: row.model,
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

type OrganizationProviderRow = {
  id: string;
  tenant_id: string;
  provider_id: string;
  display_name: string;
  kind: string;
  api_type: string;
  base_url: string;
  endpoint_path: string | null;
  models_path: string | null;
  auth_type: string;
  credential_ref: string | null;
  default_model: string | null;
  enabled: boolean;
  status: "configured" | "active" | "error" | "disabled";
  last_tested_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type AiAccessRuleRow = {
  id: string;
  tenant_id: string;
  scope_type: "org" | "department" | "user";
  scope_id: string;
  resource_type: "model" | "feature" | "skill" | "mcp" | "execution";
  resource_id: string;
  effect: "allowed" | "blocked";
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

type AuxiliaryModelDefaultRow = {
  tenant_id: string;
  purpose: string;
  provider_id: string;
  model: string;
  updated_at: Date | string;
};
