import { useQuery } from "@tanstack/react-query";
import type { ModelCapabilities, ModelProvider, RemoteModel } from "@berry/shared";

/**
 * models.dev integration (https://models.dev): the open catalog supplies model
 * metadata (display name, context window, pricing) and brand logo SVGs at
 * `/logos/{provider}.svg` and `/logos/labs/{lab}.svg`.
 *
 * The marks are monochrome `fill="currentColor"` SVGs, so they must be fetched
 * as text and inlined — an <img> would ignore currentColor and render black on
 * the dark theme. CORS is open (`access-control-allow-origin: *`) and the
 * Tauri CSP allow-lists https://models.dev in connect-src/img-src.
 */
const MODELS_DEV_BASE = "https://models.dev";

export interface ModelsDevModel {
  id: string;
  name?: string;
  family?: string;
  attachment?: boolean;
  reasoning?: boolean;
  tool_call?: boolean;
  structured_output?: boolean;
  modalities?: { input?: string[]; output?: string[] };
  limit?: { context?: number; output?: number };
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
}

export interface ModelsDevProvider {
  id: string;
  name: string;
  models: Record<string, ModelsDevModel>;
}

export type ModelsDevCatalog = Record<string, ModelsDevProvider>;

let catalogPromise: Promise<ModelsDevCatalog | null> | null = null;
export function fetchModelsDevCatalog(): Promise<ModelsDevCatalog | null> {
  catalogPromise ??= fetch(`${MODELS_DEV_BASE}/api.json`)
    .then((response) => (response.ok ? (response.json() as Promise<ModelsDevCatalog>) : null))
    .catch(() => null)
    .then((catalog) => {
      // Don't pin a failure (offline start) for the rest of the app run.
      if (!catalog) catalogPromise = null;
      return catalog;
    });
  return catalogPromise;
}

/** The catalog is ~3 MB and effectively static; fetched at most once per run. */
export function useModelsDevCatalog() {
  return useQuery({
    queryKey: ["models.dev", "catalog"],
    queryFn: fetchModelsDevCatalog,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
}

/**
 * Berry provider hints (preset id, name, base URL) → models.dev provider id.
 * Ordered like provider-logos' LOGO_RULES: several OpenAI-compatible base URLs
 * contain "openai", so that rule stays last.
 */
const PROVIDER_ID_RULES: Array<{ match: RegExp; id: string }> = [
  { match: /openrouter/i, id: "openrouter" },
  { match: /fireworks/i, id: "fireworks-ai" },
  { match: /lm ?studio|localhost:1234/i, id: "lmstudio" },
  { match: /groq/i, id: "groq" },
  { match: /gemini|generativelanguage|google/i, id: "google" },
  { match: /deepseek/i, id: "deepseek" },
  { match: /mistral/i, id: "mistral" },
  { match: /grok|api\.x\.ai|xai/i, id: "xai" },
  { match: /moonshot|kimi/i, id: "moonshotai" },
  { match: /together/i, id: "togetherai" },
  { match: /anthropic|claude/i, id: "anthropic" },
  { match: /openai|gpt/i, id: "openai" },
];

export function modelsDevProviderId(...hints: Array<string | null | undefined>): string | null {
  const haystack = hints.filter(Boolean).join(" ");
  for (const rule of PROVIDER_ID_RULES) {
    if (rule.match.test(haystack)) return rule.id;
  }
  return null;
}

function modelInfo(provider: ModelsDevProvider | undefined, modelId: string): ModelsDevModel | undefined {
  if (!provider) return undefined;
  const direct = provider.models[modelId];
  if (direct) return direct;
  const providerPrefix = `${provider.id}/`;
  return provider.models[modelId.startsWith(providerPrefix) ? modelId.slice(providerPrefix.length) : `${providerPrefix}${modelId}`];
}

function capabilitiesFromModelsDev(info: ModelsDevModel): ModelCapabilities {
  const imageInput = info.modalities?.input?.includes("image");
  return {
    ...(typeof info.tool_call === "boolean" ? { tools: info.tool_call } : {}),
    ...(typeof imageInput === "boolean"
      ? { vision: imageInput }
      : typeof info.attachment === "boolean"
        ? { vision: info.attachment }
        : {}),
    ...(typeof info.reasoning === "boolean" ? { reasoning: info.reasoning } : {}),
    ...(typeof info.structured_output === "boolean" ? { json: info.structured_output } : {}),
    ...(info.limit?.context || info.limit?.output
      ? {
          context: {
            ...(info.limit.context ? { windowTokens: info.limit.context } : {}),
            ...(info.limit.output ? { maxOutputTokens: info.limit.output } : {}),
          },
        }
      : {}),
    ...(info.cost
      ? {
          cost: {
            ...(typeof info.cost.input === "number" ? { input: info.cost.input } : {}),
            ...(typeof info.cost.output === "number" ? { output: info.cost.output } : {}),
            ...(typeof info.cost.cache_read === "number" ? { cacheRead: info.cost.cache_read } : {}),
            ...(typeof info.cost.cache_write === "number" ? { cacheWrite: info.cost.cache_write } : {}),
          },
        }
      : {}),
  };
}

/** Fills gaps in provider-native metadata without replacing native or manual values. */
export function enrichModelsWithModelsDev(
  provider: Pick<ModelProvider, "id" | "name" | "baseUrl">,
  models: RemoteModel[],
  catalog: ModelsDevCatalog | null,
): RemoteModel[] {
  const catalogProvider = catalog?.[modelsDevProviderId(provider.id, provider.name, provider.baseUrl) ?? ""];
  if (!catalogProvider) return models;
  return models.map((model) => {
    const info = modelInfo(catalogProvider, model.id);
    if (!info) return model;
    const catalogCapabilities = capabilitiesFromModelsDev(info);
    return {
      ...model,
      ...(info.name && (!model.name || model.name === model.id) ? { name: info.name } : {}),
      ...(info.family && !model.family ? { family: info.family } : {}),
      ...(!model.contextWindow && info.limit?.context ? { contextWindow: info.limit.context } : {}),
      ...(!model.maxOutputTokens && info.limit?.output ? { maxOutputTokens: info.limit.output } : {}),
      ...(!model.inputModalities && info.modalities?.input ? { inputModalities: info.modalities.input } : {}),
      ...(!model.outputModalities && info.modalities?.output ? { outputModalities: info.modalities.output } : {}),
      capabilities: {
        ...catalogCapabilities,
        ...(model.capabilities ?? {}),
        context: { ...(catalogCapabilities.context ?? {}), ...(model.capabilities?.context ?? {}) },
        cost: { ...(catalogCapabilities.cost ?? {}), ...(model.capabilities?.cost ?? {}) },
      },
    };
  });
}

/** "anthropic/claude-…" → "anthropic"; path-style ids ("accounts/…") have no author. */
const NON_AUTHOR_PREFIXES = new Set(["accounts", "models", "model", "ft"]);
export function modelAuthorId(modelId: string): string | null {
  const slash = modelId.indexOf("/");
  if (slash <= 0) return null;
  const prefix = modelId.slice(0, slash).toLowerCase();
  if (NON_AUTHOR_PREFIXES.has(prefix) || !/^[a-z0-9._-]+$/.test(prefix)) return null;
  return prefix;
}

/**
 * Logo ids to try for a model row, best first: the model's author (provider
 * mark, then lab mark), then the serving provider's own mark. Ids map to
 * `/logos/{id}.svg`; the `labs/` prefix is part of the id.
 */
export function modelsDevLogoCandidates(
  modelId: string,
  ...providerHints: Array<string | null | undefined>
): string[] {
  const author = modelAuthorId(modelId);
  const providerId = modelsDevProviderId(...providerHints);
  const candidates = author ? [author, `labs/${author}`] : [];
  if (providerId) candidates.push(providerId);
  return candidates;
}

const logoCache = new Map<string, Promise<string | null>>();
function loadLogo(id: string): Promise<string | null> {
  let promise = logoCache.get(id);
  if (!promise) {
    promise = fetch(`${MODELS_DEV_BASE}/logos/${id}.svg`)
      .then(async (response) => {
        if (!response.ok) return null;
        const text = await response.text();
        return text.trimStart().startsWith("<svg") ? text : null;
      })
      .catch(() => null);
    logoCache.set(id, promise);
  }
  return promise;
}

/** Resolve the first candidate id that has a logo on models.dev, if any. */
export async function loadModelsDevLogo(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    const svg = await loadLogo(candidate);
    if (svg) return svg;
  }
  return null;
}

/** One-line tooltip: display name, context window, and per-1M-token pricing. */
export function describeModelsDevModel(info: ModelsDevModel): string {
  const parts: string[] = [info.name ?? info.id];
  const context = info.limit?.context;
  if (context) parts.push(`${Math.round(context / 1000)}k context`);
  const input = info.cost?.input;
  const output = info.cost?.output;
  if (input != null && output != null) parts.push(`$${input} in / $${output} out per 1M tokens`);
  return parts.join(" · ");
}
