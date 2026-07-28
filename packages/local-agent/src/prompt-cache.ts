import { createHash } from "node:crypto";
import {
  PromptManifestSchema,
  type PromptCacheMissReason,
  type PromptCachingCapabilities,
  type PromptManifest,
} from "@berry/shared";
import type { Context, SimpleStreamOptions } from "@earendil-works/pi-ai";

export const DYNAMIC_CONTEXT_BOUNDARY = "\n\n<!-- berry:dynamic-context:v1 -->\n\n";

export type PromptCacheRequest = {
  manifest: PromptManifest;
  cacheKeyHash: string | null;
  cacheKey: string | null;
  eligible: boolean;
  provider: string;
  retention: "none" | "short" | "long";
  missReason: PromptCacheMissReason | null;
  missComponentId: string | null;
};

type CacheObservation = {
  manifest: PromptManifest;
  eligible: boolean;
  observedAt: number;
};

export function canonicalJson(value: unknown): string {
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

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function splitStablePrompt(prompt: string | undefined): { stable: string; dynamic: string } {
  if (!prompt) return { stable: "", dynamic: "" };
  const boundary = prompt.indexOf(DYNAMIC_CONTEXT_BOUNDARY);
  if (boundary < 0) return { stable: prompt, dynamic: "" };
  return {
    stable: prompt.slice(0, boundary),
    dynamic: prompt.slice(boundary + DYNAMIC_CONTEXT_BOUNDARY.length),
  };
}

export function joinStableAndDynamicPrompt(stable: string, dynamic: string): string {
  if (!dynamic.trim()) return stable;
  return `${stable}${DYNAMIC_CONTEXT_BOUNDARY}${dynamic}`;
}

export function providerPromptText(prompt: string | undefined): string {
  const { stable, dynamic } = splitStablePrompt(prompt);
  return dynamic ? `${stable}\n\n${dynamic}` : stable;
}

export function resolvePromptCachingCapabilities(
  providerCapability: PromptCachingCapabilities | undefined,
  modelCapability: PromptCachingCapabilities | undefined,
): PromptCachingCapabilities {
  if (!providerCapability && !modelCapability) {
    return { supported: false, cacheKey: false, cacheControl: false, retention: [], minimumTokens: 1_024 };
  }
  return {
    supported: modelCapability?.supported ?? providerCapability?.supported ?? false,
    cacheKey: modelCapability?.cacheKey ?? providerCapability?.cacheKey ?? false,
    cacheControl: modelCapability?.cacheControl ?? providerCapability?.cacheControl ?? false,
    retention: modelCapability?.retention ?? providerCapability?.retention ?? [],
    minimumTokens: modelCapability?.minimumTokens ?? providerCapability?.minimumTokens ?? 1_024,
  };
}

export function buildPromptManifest(input: {
  provider: string;
  model: string;
  route: string;
  context: Context;
  retention: "none" | "short" | "long";
  capability?: PromptCachingCapabilities | undefined;
}): PromptManifest {
  const { stable } = splitStablePrompt(input.context.systemPrompt);
  const components: PromptManifest["components"] = [];
  components.push(...stableSystemComponents(stable));
  for (const [index, tool] of (input.context.tools ?? []).entries()) {
    const schema = canonicalJson({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    });
    components.push({
      id: `tool:${index}:${tool.name}`,
      kind: "tool_schema",
      hash: sha256(schema),
      tokenEstimate: estimateTokens(schema),
    });
  }
  if (input.capability) {
    const capability = canonicalJson(input.capability);
    components.push({
      id: "capability:prompt-cache",
      kind: "capability",
      hash: sha256(capability),
      tokenEstimate: estimateTokens(capability),
    });
  }
  const stablePrefixTokens = components.reduce((total, component) => total + component.tokenEstimate, 0);
  const stablePrefixHash = sha256(canonicalJson(components.map(({ id, kind, hash }) => ({ id, kind, hash }))));
  const withoutManifestHash = {
    version: 1 as const,
    provider: input.provider,
    model: input.model,
    route: input.route,
    components,
    cacheRetention: input.retention,
    stablePrefixTokens,
    dynamicContextBoundary: stable.length,
    stablePrefixHash,
  };
  return PromptManifestSchema.parse({
    ...withoutManifestHash,
    manifestHash: sha256(canonicalJson(withoutManifestHash)),
  });
}

export function cacheKeyFor(namespace: string, sessionId: string, manifestHash: string): { value: string; hash: string } {
  const hash = sha256(canonicalJson({ namespace, sessionId, manifestHash }));
  return { value: `berry_${hash}`, hash };
}

export class PromptCacheTracker {
  readonly #previous = new Map<string, CacheObservation>();

  prepare(input: {
    namespace: string;
    sessionId: string;
    provider: string;
    model: string;
    route: string;
    context: Context;
    requestedRetention?: SimpleStreamOptions["cacheRetention"];
    capability: PromptCachingCapabilities;
    now?: number;
  }): PromptCacheRequest {
    const requested = input.requestedRetention ?? "short";
    const retention = input.capability.supported && requested !== "none" ? requested : "none";
    const manifest = buildPromptManifest({
      provider: input.provider,
      model: input.model,
      route: input.route,
      context: input.context,
      retention,
      capability: input.capability,
    });
    const previous = this.#previous.get(input.sessionId);
    const now = input.now ?? Date.now();
    const retentionSupported = retention !== "none" && input.capability.retention.includes(retention);
    const eligible = input.capability.supported
      && retentionSupported
      && manifest.stablePrefixTokens >= input.capability.minimumTokens;
    const difference = previous ? compareManifests(previous.manifest, manifest) : null;
    let missReason: PromptCacheMissReason | null = null;
    const missComponentId: string | null = difference?.componentId ?? null;
    if (!input.capability.supported) missReason = "provider_unsupported";
    else if (!retentionSupported) missReason = "retention_unsupported";
    else if (manifest.stablePrefixTokens < input.capability.minimumTokens) missReason = "below_minimum_tokens";
    else if (!previous?.eligible) missReason = "first_request";
    else if (difference?.reason) missReason = difference.reason;
    else if (now - previous.observedAt > retentionMillis(retention)) missReason = "cache_expired";
    else missReason = "unknown";
    const key = input.capability.supported && retentionSupported && input.capability.cacheKey
      ? cacheKeyFor(input.namespace, input.sessionId, manifest.manifestHash)
      : null;
    this.#previous.set(input.sessionId, { manifest, eligible, observedAt: now });
    return {
      manifest,
      cacheKeyHash: key?.hash ?? null,
      cacheKey: key?.value ?? null,
      eligible,
      provider: input.provider,
      retention,
      missReason,
      missComponentId,
    };
  }
}

export function compareManifests(
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

function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

function stableSystemComponents(stable: string): PromptManifest["components"] {
  if (!stable) return [];
  const sections = stable.split(/(?=^#\s+)/m).filter(Boolean);
  if (sections.length === 1 && !sections[0]!.startsWith("# ")) {
    return [{
      id: "system:stable",
      kind: "system",
      hash: sha256(stable),
      tokenEstimate: estimateTokens(stable),
    }];
  }
  return sections.map((section, index) => {
    const heading = /^#\s+(.+)$/m.exec(section)?.[1]?.trim() ?? `preamble-${index}`;
    const normalized = heading.toLowerCase();
    const kind = /(policy|security|tool|working style|instruction)/.test(normalized)
      ? "policy" as const
      : /(workspace|project)/.test(normalized)
        ? "project_instruction" as const
        : "system" as const;
    return {
      id: `${kind}:${index}:${slug(heading)}`,
      kind,
      hash: sha256(section),
      tokenEstimate: estimateTokens(section),
    };
  });
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "section";
}

function retentionMillis(retention: "none" | "short" | "long"): number {
  if (retention === "long") return 60 * 60 * 1_000;
  if (retention === "short") return 5 * 60 * 1_000;
  return 0;
}
