/** Shared estimates, never billing counters or a claim of exact tokenization. */
export const MODEL_IMAGE_LIMITS = {
  maxCount: 5, maxSourceBytes: 20 * 1024 * 1024, maxDimension: 2_000,
  maxBase64Bytes: 600 * 1024, maxTotalBase64Bytes: 3 * 1024 * 1024,
  maxInputPixels: 40_000_000,
} as const;
export const MODEL_REQUEST_MAX_BYTES = 4 * 1024 * 1024;
export const ESTIMATED_IMAGE_TOKENS = 1_200;
export const CONTEXT_SAFETY_TOKENS = 1_024;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
export function estimateContextCharacterTokens(characters: number): number {
  return Number.isFinite(characters) && characters > 0 ? Math.ceil(characters / 4) : 0;
}

/** Replace image encodings with one visual estimate; encoded bytes are not text tokens. */
export function estimateContextValueTokens(value: unknown): number {
  if (value === null || value === undefined) return 0;
  let images = 0;
  const json = JSON.stringify(value, (_key, part: unknown) => {
    const item = object(part);
    if (item?.type === "image_url" || item?.type === "image") {
      images += 1;
      return { type: "image" };
    }
    return part;
  });
  return estimateContextCharacterTokens(json?.length ?? 0) + images * ESTIMATED_IMAGE_TOKENS;
}

export function estimateContextMessageTokens(value: unknown): number {
  const message = object(value);
  if (!message) return 0;
  const content = message.content;
  if (typeof content === "string") return estimateContextCharacterTokens(content.length + (typeof message.reasoningContent === "string" ? message.reasoningContent.length : 0));
  if (!Array.isArray(content)) return 0;
  let characters = 0;
  let images = 0;
  for (const raw of content) {
    const part = object(raw);
    if (!part) continue;
    if (typeof part.text === "string") characters += part.text.length;
    else if (typeof part.thinking === "string") characters += part.thinking.length;
    if (part.type === "toolCall") characters += String(part.name ?? "").length + JSON.stringify(part.arguments ?? {}).length;
    if (part.type === "image" || part.type === "image_url") images += 1;
  }
  // Tool-continuation reasoning is replayed separately from content.
  if (typeof message.reasoningContent === "string") characters += message.reasoningContent.length;
  return estimateContextCharacterTokens(characters) + images * ESTIMATED_IMAGE_TOKENS;
}

export function estimateContextEntryTokens(payload: unknown): number {
  const entry = object(payload);
  if (!entry) return 0;
  if (entry.type === "context" && typeof entry.text === "string") return estimateContextCharacterTokens(entry.text.length);
  return estimateContextMessageTokens(entry.message ?? entry);
}

/** Stable configuration only. Never include credentials or changing history here. */
export function contextEnvelopeKey(runtime: unknown, manifest: unknown): string {
  const request = object(runtime) ?? {};
  const provider = object(request.provider) ?? {};
  const prompt = object(manifest) ?? {};
  return JSON.stringify({
    version: 1,
    provider: provider.id ?? request.providerId ?? null,
    endpoint: provider.baseUrl ?? null,
    apiType: provider.apiType ?? null,
    model: request.model ?? provider.defaultModel ?? null,
    reasoning: request.reasoning ?? null,
    stablePrefixHash: prompt.stablePrefixHash ?? null,
    toolsHash: object(prompt.requestPrefix)?.toolsHash ?? null,
  });
}

export interface ContextUsageAnchor {
  version: 1;
  envelopeKey: string;
  projectedTokens: number;
  requestMessageCount: number;
  requestHash: string;
}

export function readContextUsageAnchor(payload: unknown, envelopeKey: string): ContextUsageAnchor | null {
  const message = object(object(payload)?.message);
  if (!message || message.stopReason === "error" || message.stopReason === "aborted") return null;
  const anchor = object(message.contextBudget);
  if (anchor?.version !== 1 || anchor.envelopeKey !== envelopeKey
    || typeof anchor.projectedTokens !== "number" || !Number.isFinite(anchor.projectedTokens) || anchor.projectedTokens <= 0
    || typeof anchor.requestMessageCount !== "number" || !Number.isSafeInteger(anchor.requestMessageCount) || anchor.requestMessageCount < 1
    || typeof anchor.requestHash !== "string" || !/^[a-f0-9]{64}$/.test(anchor.requestHash)) return null;
  return anchor as unknown as ContextUsageAnchor;
}

export function measureContextEntries(
  entries: readonly { payload: unknown }[],
  options: { envelopeKey: string; baseTokens?: number; minimumTokens?: number; acceptsAnchor?: (anchor: ContextUsageAnchor) => boolean },
): { usedTokens: number; source: "estimated" | "provider-reported" } {
  let trailing = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const anchor = readContextUsageAnchor(entries[index]?.payload, options.envelopeKey);
    if (anchor && (options.acceptsAnchor?.(anchor) ?? true)) {
      return { usedTokens: Math.max(options.minimumTokens ?? 0, Math.ceil(anchor.projectedTokens + trailing)), source: "provider-reported" };
    }
    trailing += estimateContextEntryTokens(entries[index]?.payload);
  }
  return { usedTokens: Math.max(options.minimumTokens ?? 0, Math.ceil((options.baseTokens ?? 0) + trailing)), source: "estimated" };
}

export function resolveContextBudget(contextWindow: number, inputTokens: number, requestedOutputTokens: number): {
  maxOutputTokens: number; triggerTokens: number; safetyTokens: number;
} {
  const window = Math.max(1, Math.floor(Number.isFinite(contextWindow) ? contextWindow : 128_000));
  const requested = Math.max(1, Math.floor(Number.isFinite(requestedOutputTokens) ? requestedOutputTokens : 8_000));
  const safetyTokens = Math.min(CONTEXT_SAFETY_TOKENS, Math.max(1, Math.floor(window * 0.01)));
  return {
    safetyTokens,
    maxOutputTokens: Math.min(requested, Math.max(0, Math.floor(window - inputTokens - safetyTokens))),
    triggerTokens: Math.max(1, Math.min(Math.floor(window * 0.85), window - Math.min(requested, Math.floor(window / 2)) - safetyTokens)),
  };
}
