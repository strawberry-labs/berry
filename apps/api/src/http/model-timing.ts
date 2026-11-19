import type { Message } from "@berry/shared";

/** Read only the timing fields from durable model diagnostics, never prompts. */
export function modelTimingFromDiagnostics(value: unknown): Message["modelTiming"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const data = value as Record<string, unknown>;
  const requestMs = nonnegative(data.latencyMs);
  if (requestMs === undefined) return undefined;
  const first = nonnegative(data.firstTokenMs);
  const firstTokenMs = first !== undefined && first <= requestMs ? first : undefined;
  const duration = nonnegative(data.decodeMs);
  const tokens = nonnegative(data.decodeTokens);
  const hasDecode = firstTokenMs !== undefined && duration !== undefined && duration > 0
    && duration <= requestMs - firstTokenMs + 1 && tokens !== undefined && tokens > 0;
  return {
    requestMs,
    ...(firstTokenMs !== undefined ? { firstTokenMs } : {}),
    ...(hasDecode ? { decodeMs: duration, decodeTokens: tokens } : {}),
  };
}

function nonnegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
