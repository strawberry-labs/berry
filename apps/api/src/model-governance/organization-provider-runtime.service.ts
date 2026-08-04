import { Injectable } from "@nestjs/common";
import type { BerryModelProviderInfo } from "@berry/local-agent";
import type {
  OrganizationModelProvider,
  OrgModelPolicy,
  RemoteModel,
} from "@berry/shared";
import type { ModelGovernanceService } from "./model-governance.service.ts";

export const ORGANIZATION_PROVIDER_RUNTIME = Symbol("ORGANIZATION_PROVIDER_RUNTIME");

export type ResolvedOrganizationProvider = {
  provider: BerryModelProviderInfo;
  apiKey: string | undefined;
};

export interface OrganizationProviderRuntime {
  resolve(
    tenantId: string,
    input?: { providerId?: string | undefined; model?: string | undefined },
  ): Promise<ResolvedOrganizationProvider | null>;
  testAndActivate(tenantId: string, providerId: string): Promise<OrganizationModelProvider>;
}

export class OrganizationProviderHealthCheckError extends Error {
  constructor(
    message: string,
    readonly provider: OrganizationModelProvider | null,
  ) {
    super(message);
    this.name = "OrganizationProviderHealthCheckError";
  }
}

@Injectable()
export class DefaultOrganizationProviderRuntime implements OrganizationProviderRuntime {
  constructor(
    private readonly models: ModelGovernanceService,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly request: typeof fetch = fetch,
  ) {}

  async resolve(
    tenantId: string,
    input: { providerId?: string | undefined; model?: string | undefined } = {},
  ): Promise<ResolvedOrganizationProvider | null> {
    const providers = await this.models.listProviders(tenantId);
    const requested = input.providerId
      ? providers.find((provider) => provider.providerId === input.providerId)
      : undefined;
    if (requested && (!requested.enabled || requested.status !== "active")) {
      throw new Error(`Organization provider ${requested.providerId} is not active`);
    }
    const selected = requested
      ?? providers.find((provider) => provider.enabled && provider.status === "active");
    if (!selected) return null;

    assertAllowedDestination(selected, this.env);
    const policies = (await this.models.listModels(tenantId))
      .filter((policy) => policy.providerId === selected.providerId);
    return {
      provider: providerInfo(selected, policies, input.model),
      apiKey: resolveCredential(selected, this.env),
    };
  }

  async testAndActivate(tenantId: string, providerId: string): Promise<OrganizationModelProvider> {
    const provider = (await this.models.listProviders(tenantId))
      .find((candidate) => candidate.providerId === providerId);
    if (!provider) {
      throw new OrganizationProviderHealthCheckError("Organization model provider not found", null);
    }
    const testedAt = new Date().toISOString();
    try {
      if (!provider.enabled) throw new Error("Enable the provider before testing it");
      assertAllowedDestination(provider, this.env);
      const apiKey = resolveCredential(provider, this.env);
      const response = await this.request(healthUrl(provider), {
        method: "GET",
        headers: providerAuthHeaders(provider, apiKey),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      await response.body?.cancel().catch(() => undefined);
      if (!response.ok) throw new Error(`Provider health check returned HTTP ${response.status}`);
      return this.models.updateProviderHealth(tenantId, providerId, "active", testedAt);
    } catch (cause) {
      const failed = provider.enabled
        ? await this.models.updateProviderHealth(tenantId, providerId, "error", testedAt)
          .catch(() => null)
        : provider;
      throw new OrganizationProviderHealthCheckError(
        cause instanceof Error ? cause.message : "Provider health check failed",
        failed,
      );
    }
  }
}

function providerInfo(
  provider: OrganizationModelProvider,
  policies: OrgModelPolicy[],
  requestedModel?: string,
): BerryModelProviderInfo {
  const models: RemoteModel[] = policies.map((policy) => ({
    id: policy.model,
    ...(policy.displayName ? { name: policy.displayName } : {}),
    ...(policy.apiType ? { apiType: policy.apiType } : {}),
    capabilities: policy.capabilities,
  }));
  const defaultModel = provider.defaultModel ?? requestedModel ?? models[0]?.id;
  if (!defaultModel) throw new Error(`Organization provider ${provider.providerId} has no configured model`);
  if (!models.some((model) => model.id === defaultModel)) {
    models.unshift({ id: defaultModel, name: defaultModel });
  }
  return {
    id: provider.providerId,
    name: provider.displayName,
    kind: provider.kind,
    baseUrl: stripTrailingSlash(provider.baseUrl),
    defaultModel,
    apiType: provider.apiType,
    endpointPath: provider.endpointPath,
    modelsPath: provider.modelsPath,
    authType: provider.authType,
    capabilities: {
      reasoning: policies.some((policy) => policy.capabilities.reasoning === true),
      toolCalling: policies.some((policy) => policy.capabilities.tools === true),
      imageInput: policies.some((policy) => policy.capabilities.vision === true),
    },
    models,
  };
}

function resolveCredential(
  provider: OrganizationModelProvider,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (provider.authType === "none") return undefined;
  if (!provider.credentialRef) {
    if (provider.authType === "optional-bearer") return undefined;
    throw new Error(`Organization provider ${provider.providerId} has no credential reference`);
  }
  const envName = provider.credentialRef.startsWith("env:")
    ? provider.credentialRef.slice("env:".length)
    : provider.credentialRef;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) {
    throw new Error(`Organization provider ${provider.providerId} uses an unsupported credential reference`);
  }
  const credential = env[envName]?.trim() ?? providerCredentials(env)[envName];
  if (!credential) {
    if (provider.authType === "optional-bearer") return undefined;
    throw new Error(`Credential reference ${provider.credentialRef} is not available`);
  }
  return credential;
}

function providerCredentials(env: NodeJS.ProcessEnv): Record<string, string> {
  const raw = env.BERRY_ORGANIZATION_PROVIDER_CREDENTIALS_JSON?.trim();
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("BERRY_ORGANIZATION_PROVIDER_CREDENTIALS_JSON must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("BERRY_ORGANIZATION_PROVIDER_CREDENTIALS_JSON must be a JSON object");
  }
  const credentials: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && typeof value === "string" && value.trim()) {
      credentials[name] = value.trim();
    }
  }
  return credentials;
}

function assertAllowedDestination(
  provider: OrganizationModelProvider,
  env: NodeJS.ProcessEnv,
): void {
  const url = new URL(provider.baseUrl);
  if (url.username || url.password) throw new Error("Provider URLs cannot contain credentials");
  const allowedHosts = new Set(
    (env.BERRY_ORGANIZATION_PROVIDER_ALLOWED_HOSTS ?? "")
      .split(",")
      .map(normalizeAllowedHost)
      .filter((host): host is string => Boolean(host)),
  );
  if (!allowedHosts.has(url.host.toLowerCase()) && !allowedHosts.has(url.hostname.toLowerCase())) {
    throw new Error(
      `Provider host ${url.host} is not in BERRY_ORGANIZATION_PROVIDER_ALLOWED_HOSTS`,
    );
  }
  if (url.protocol !== "https:" && !(
    url.protocol === "http:"
    && env.BERRY_ORGANIZATION_PROVIDER_ALLOW_INSECURE_HTTP === "true"
  )) {
    throw new Error("Organization providers must use HTTPS unless insecure HTTP is explicitly enabled");
  }
}

function normalizeAllowedHost(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (!normalized.includes("://")) return normalized.replace(/\/+$/, "");
  try {
    return new URL(normalized).host.toLowerCase();
  } catch {
    return null;
  }
}

function providerAuthHeaders(
  provider: OrganizationModelProvider,
  apiKey: string | undefined,
): Record<string, string> {
  if (!apiKey) return {};
  return provider.authType === "x-api-key"
    ? { "x-api-key": apiKey }
    : { authorization: `Bearer ${apiKey}` };
}

function healthUrl(provider: OrganizationModelProvider): string {
  return provider.modelsPath
    ? joinUrl(provider.baseUrl, provider.modelsPath)
    : stripTrailingSlash(provider.baseUrl);
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function joinUrl(baseUrl: string, path: string): string {
  return `${stripTrailingSlash(baseUrl)}/${path.replace(/^\/+/, "")}`;
}
