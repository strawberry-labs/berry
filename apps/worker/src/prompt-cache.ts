import { createHash } from "node:crypto";
import {
  PromptManifestSchema,
  RemoteModelSchema,
  resolveModelCapabilities,
  type PromptCacheMissReason,
  type PromptCachingCapabilities,
  type PromptManifest,
} from "@berry/shared";

const UNSUPPORTED_CAPABILITY: PromptCachingCapabilities = {
  supported: false,
  cacheKey: false,
  cacheControl: false,
  retention: [],
  minimumTokens: 1_024,
};

export interface DurablePromptCachePlan {
  manifest: PromptManifest;
  cacheKey: string | null;
  cacheKeyHash: string | null;
  eligible: boolean;
  provider: string;
  retention: "none" | "short" | "long";
  missReason: PromptCacheMissReason | null;
  missComponentId: string | null;
}

export function promptCacheCapabilityFromEnv(
  env: NodeJS.ProcessEnv,
  model: string,
): PromptCachingCapabilities {
  if (!envBoolean(env.BERRY_PROMPT_CACHE_ENABLED, true)) return UNSUPPORTED_CAPABILITY;
  const rawModels = env.BERRY_ROUTER_MODELS_JSON?.trim();
  if (!rawModels) return UNSUPPORTED_CAPABILITY;
  let decoded: unknown;
  try {
    decoded = JSON.parse(rawModels);
  } catch {
    throw new Error("BERRY_ROUTER_MODELS_JSON must be valid JSON");
  }
  const models = RemoteModelSchema.array().parse(decoded);
  return resolveModelCapabilities(models.find((candidate) => candidate.id === model)).promptCaching
    ?? UNSUPPORTED_CAPABILITY;
}

export function planDurablePromptCache(input: {
  tenantId: string;
  sessionId: string;
  provider: string;
  model: string;
  route: string;
  stableSystemPrompt: string;
  tools: readonly unknown[];
  capability: PromptCachingCapabilities;
  previousManifest?: unknown;
  previousObservedAt?: string | null | undefined;
  now?: number;
}): DurablePromptCachePlan {
  const retention = requestedRetention(input.capability);
  const manifest = buildDurablePromptManifest({
    provider: input.provider,
    model: input.model,
    route: input.route,
    stableSystemPrompt: input.stableSystemPrompt,
    tools: input.tools,
    capability: input.capability,
    retention,
  });
  const retentionSupported = retention !== "none" && input.capability.retention.includes(retention);
  const eligible = input.capability.supported
    && retentionSupported
    && manifest.stablePrefixTokens >= input.capability.minimumTokens;
  const previous = PromptManifestSchema.safeParse(input.previousManifest);
  const prior = previous.success ? previous.data : null;
  const difference = prior ? compareDurablePromptManifests(prior, manifest) : null;
  const previousEligible = prior !== null
    && input.capability.supported
    && prior.cacheRetention !== "none"
    && input.capability.retention.includes(prior.cacheRetention)
    && prior.stablePrefixTokens >= input.capability.minimumTokens;
  const observedAt = input.previousObservedAt ? Date.parse(input.previousObservedAt) : Number.NaN;
  const now = input.now ?? Date.now();
  let missReason: PromptCacheMissReason | null;
  if (!input.capability.supported) missReason = "provider_unsupported";
  else if (!retentionSupported) missReason = "retention_unsupported";
  else if (manifest.stablePrefixTokens < input.capability.minimumTokens) missReason = "below_minimum_tokens";
  else if (!prior || !previousEligible) missReason = "first_request";
  else if (difference) missReason = difference.reason;
  else if (Number.isFinite(observedAt) && now - observedAt > retentionMillis(retention)) missReason = "cache_expired";
  else missReason = "unknown";

  const cacheKey = input.capability.supported && retentionSupported && input.capability.cacheKey
    ? durableCacheKey(input.tenantId, input.sessionId, manifest.manifestHash)
    : null;
  return {
    manifest,
    cacheKey: cacheKey?.value ?? null,
    cacheKeyHash: cacheKey?.hash ?? null,
    eligible,
    provider: input.provider,
    retention,
    missReason,
    missComponentId: difference?.componentId ?? null,
  };
}

export function buildDurablePromptManifest(input: {
  provider: string;
  model: string;
  route: string;
  stableSystemPrompt: string;
  tools: readonly unknown[];
  capability: PromptCachingCapabilities;
  retention: "none" | "short" | "long";
}): PromptManifest {
  const components: PromptManifest["components"] = [{
    id: "system:durable-v1",
    kind: "system",
    hash: sha256(input.stableSystemPrompt),
    tokenEstimate: estimateTokens(input.stableSystemPrompt),
  }];
  input.tools.forEach((tool, index) => {
    const canonical = canonicalJson(tool);
    components.push({
      id: `tool:${index}`,
      kind: "tool_schema",
      hash: sha256(canonical),
      tokenEstimate: estimateTokens(canonical),
    });
  });
  const capability = canonicalJson(input.capability);
  components.push({
    id: "capability:prompt-cache",
    kind: "capability",
    hash: sha256(capability),
    tokenEstimate: estimateTokens(capability),
  });
  const stablePrefixTokens = components.reduce((total, component) => total + component.tokenEstimate, 0);
  const stablePrefixHash = sha256(canonicalJson(components.map(({ id, kind, hash }) => ({ id, kind, hash }))));
  const unsigned = {
    version: 1 as const,
    provider: input.provider,
    model: input.model,
    route: input.route,
    components,
    cacheRetention: input.retention,
    stablePrefixTokens,
    dynamicContextBoundary: input.stableSystemPrompt.length,
    stablePrefixHash,
  };
  return PromptManifestSchema.parse({
    ...unsigned,
    manifestHash: sha256(canonicalJson(unsigned)),
  });
}

export function compareDurablePromptManifests(
  previous: PromptManifest,
  current: PromptManifest,
): { reason: Extract<PromptCacheMissReason, "routing_changed" | "prefix_changed">; componentId: string | null } | null {
  if (previous.provider !== current.provider || previous.model !== current.model || previous.route !== current.route) {
    return { reason: "routing_changed", componentId: null };
  }
  const length = Math.max(previous.components.length, current.components.length);
  for (let index = 0; index < length; index += 1) {
    const before = previous.components[index];
    const after = current.components[index];
    if (!before || !after || before.id !== after.id || before.hash !== after.hash) {
      return { reason: "prefix_changed", componentId: after?.id ?? before?.id ?? null };
    }
  }
  return previous.stablePrefixHash === current.stablePrefixHash
    ? null
    : { reason: "prefix_changed", componentId: null };
}

function requestedRetention(capability: PromptCachingCapabilities): "none" | "short" | "long" {
  if (!capability.supported) return "none";
  if (capability.retention.includes("long")) return "long";
  if (capability.retention.includes("short")) return "short";
  return "none";
}

function durableCacheKey(
  tenantId: string,
  sessionId: string,
  manifestHash: string,
): { value: string; hash: string } {
  const hash = sha256(canonicalJson({ namespace: tenantId, sessionId, manifestHash }));
  return { value: `berry_${hash}`, hash };
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalValue(entry)]),
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

function retentionMillis(retention: "none" | "short" | "long"): number {
  if (retention === "long") return 60 * 60 * 1_000;
  if (retention === "short") return 5 * 60 * 1_000;
  return 0;
}

function envBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || !value.trim()) return fallback;
  return value.trim().toLowerCase() === "true";
}
