import { createHash } from "node:crypto";
import { serializeMessage, type ChatMessage, type ChatToolDefinition } from "@berry/router-client";
import {
  PromptManifestSchema,
  PromptCachingCapabilitiesSchema,
  RemoteModelSchema,
  resolveModelCapabilities,
  type PromptCacheMissReason,
  type PromptCachingCapabilities,
  type PromptManifest,
  type DurableProviderTransport,
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
  provider?: Pick<DurableProviderTransport, "models" | "capabilities">,
): PromptCachingCapabilities {
  if (!envBoolean(env.BERRY_PROMPT_CACHE_ENABLED, true)) return UNSUPPORTED_CAPABILITY;
  const admittedModel = RemoteModelSchema.safeParse(provider?.models.find((candidate) => candidate.id === model));
  const modelCapability = admittedModel.success ? resolveModelCapabilities(admittedModel.data).promptCaching : undefined;
  if (modelCapability) return modelCapability;
  const providerCapability = PromptCachingCapabilitiesSchema.safeParse(provider?.capabilities?.promptCaching);
  if (providerCapability.success) return providerCapability.data;
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
  messages?: readonly ChatMessage[];
  tools: readonly unknown[];
  capability: PromptCachingCapabilities;
  previousManifest?: unknown;
  previousObservedAt?: string | null | undefined;
  now?: number;
}): DurablePromptCachePlan {
  const retention = requestedRetention(input.capability);
  const baseManifest = buildDurablePromptManifest({
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
    && baseManifest.stablePrefixTokens >= input.capability.minimumTokens;
  const previous = PromptManifestSchema.safeParse(input.previousManifest);
  const prior = previous.success ? previous.data : null;
  const manifest = input.messages ? {
    ...baseManifest,
    requestPrefix: describeRequestPrefix(input.messages, input.tools, prior),
  } : baseManifest;
  const difference = prior ? compareDurablePromptManifests(prior, manifest) : null;
  const previousEligible = prior !== null
    && input.capability.supported
    && prior.cacheRetention !== "none"
    && input.capability.retention.includes(prior.cacheRetention)
    && prior.stablePrefixTokens >= input.capability.minimumTokens;
  const observedAt = input.previousObservedAt ? Date.parse(input.previousObservedAt) : Number.NaN;
  const now = input.now ?? Date.now();
  let missReason: PromptCacheMissReason | null;
  // Lack of explicit cache controls does not disable implicit provider caching.
  // We cannot infer a provider-side miss reason from this configuration.
  if (!input.capability.supported) missReason = "unknown";
  else if (!retentionSupported) missReason = "retention_unsupported";
  else if (manifest.stablePrefixTokens < input.capability.minimumTokens) missReason = "below_minimum_tokens";
  else if (!prior || !previousEligible) missReason = "first_request";
  else if (difference) missReason = difference.reason;
  else if (Number.isFinite(observedAt) && now - observedAt > retentionMillis(retention)) missReason = "cache_expired";
  else missReason = "unknown";

  const cacheKey = input.capability.supported && retentionSupported && input.capability.cacheKey
    ? durableCacheKey(input.tenantId, input.sessionId, input.provider, input.model, input.route)
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
  provider: string,
  model: string,
  route: string,
): { value: string; hash: string } {
  // Routing affinity belongs to the session, not to a changing tool manifest.
  // The full hex digest also fits OpenAI's 64-character key limit.
  const hash = sha256(canonicalJson({ namespace: tenantId, sessionId, provider, model, route }));
  return { value: hash, hash };
}

export function canonicalToolDefinitions(tools: readonly ChatToolDefinition[]): ChatToolDefinition[] {
  return [...tools].sort((a, b) => a.function.name < b.function.name ? -1 : a.function.name > b.function.name ? 1 : 0)
    .map((tool) => JSON.parse(canonicalJson(tool)) as ChatToolDefinition);
}

function describeRequestPrefix(
  messages: readonly ChatMessage[],
  tools: readonly unknown[],
  prior: PromptManifest | null,
): NonNullable<PromptManifest["requestPrefix"]> {
  const current = messages.map((message) => {
    const serialized = JSON.stringify(serializeMessage(message));
    return { hash: sha256(serialized), characters: serialized.length };
  });
  const toolsHash = sha256(JSON.stringify(tools));
  const previous = prior?.requestPrefix;
  let reusedMessages = 0;
  while (previous && reusedMessages < previous.messages.length
    && previous.messages[reusedMessages]?.hash === current[reusedMessages]?.hash) reusedMessages++;
  return {
    toolsHash,
    messages: current,
    comparedToPrevious: Boolean(previous),
    reusedMessages,
    reusedCharacters: current.slice(0, reusedMessages).reduce((sum, message) => sum + message.characters, 0),
    previousCharacters: previous?.messages.reduce((sum, message) => sum + message.characters, 0) ?? 0,
    firstChangedMessage: previous && reusedMessages < previous.messages.length ? reusedMessages : null,
    toolsChanged: Boolean(previous && previous.toolsHash !== toolsHash),
  };
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
