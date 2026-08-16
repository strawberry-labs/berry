import { z } from "zod";

/**
 * Low-cardinality provider failure categories shared by transports, fallbacks,
 * durable runners, and background queues. Request identifiers are intentionally
 * not part of the telemetry shape; they remain available only on in-process
 * errors for support tooling.
 */
export const ProviderFailureCategorySchema = z.enum([
  "success",
  "aborted",
  "connection",
  "permanent_client",
  "rate_limit",
  "server",
  "timeout",
  "unknown",
]);
export type ProviderFailureCategory = z.infer<typeof ProviderFailureCategorySchema>;

export const ProviderAttemptDecisionSchema = z.enum([
  "none",
  "retry",
  "fallback",
  "terminal",
  "cancelled",
]);
export type ProviderAttemptDecision = z.infer<typeof ProviderAttemptDecisionSchema>;

export const ProviderAttemptStatusClassSchema = z.enum([
  "2xx",
  "3xx",
  "4xx",
  "5xx",
  "network",
  "unknown",
]);
export type ProviderAttemptStatusClass = z.infer<typeof ProviderAttemptStatusClassSchema>;

export const ProviderAttemptEventSchema = z.object({
  kind: z.literal("provider.attempt"),
  logicalStepId: z.string().min(1).max(128),
  physicalAttempt: z.number().int().positive(),
  model: z.string().min(1).max(256),
  statusClass: ProviderAttemptStatusClassSchema,
  category: ProviderFailureCategorySchema,
  retryDecision: ProviderAttemptDecisionSchema,
  latencyMs: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  finishReason: z.string().max(128).nullable(),
});
export type ProviderAttemptEvent = z.infer<typeof ProviderAttemptEventSchema>;

export interface ProviderAttemptErrorDetails {
  status?: number | undefined;
  code?: string | undefined;
  requestId?: string | undefined;
}

/** A transport-independent, typed provider failure that survives wrappers. */
export class ProviderAttemptError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly requestId: string | undefined;

  constructor(
    message: string,
    details: ProviderAttemptErrorDetails = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProviderAttemptError";
    this.status = validStatus(details.status);
    this.code = safeDiagnosticValue(details.code, 128);
    this.requestId = safeDiagnosticValue(details.requestId, 240);
  }
}

export interface ProviderRetryClassification {
  retryable: boolean;
  category: Exclude<ProviderFailureCategory, "success">;
  status: number | undefined;
  code: string | undefined;
  requestId: string | undefined;
}

const TIMEOUT_CODES = new Set([
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);
const CONNECTION_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTDOWN",
  "EHOSTUNREACH",
  "EPIPE",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
]);

/**
 * The one retry policy for all provider lanes. 409 and other ordinary 4xx
 * responses are permanent; 408/425/429 and 5xx are transient.
 */
export function isRetryableProviderStatus(status: number | undefined): boolean {
  if (status === undefined) return true;
  if (status === 408 || status === 425 || status === 429) return true;
  if (status >= 500) return true;
  return status < 400;
}

export function classifyProviderFailure(error: unknown): ProviderRetryClassification {
  const chain = errorChain(error);
  const status = firstStatus(chain);
  const code = firstCode(chain);
  const requestId = firstRequestId(chain);
  const names = chain.map((candidate) => stringProperty(candidate, "name")?.toLowerCase());
  const messages = chain.map((candidate) => stringProperty(candidate, "message")?.toLowerCase());
  const isTimeout = names.includes("timeouterror")
    || TIMEOUT_CODES.has(code ?? "")
    || messages.some(isTimeoutMessage);
  const isAbort = names.includes("aborterror") || code === "ABORT_ERR" || code === "UND_ERR_ABORTED";

  if (isAbort && !isTimeout) {
    return { retryable: false, category: "aborted", status, code, requestId };
  }
  if (status === 408 || status === 425) return { retryable: true, category: "timeout", status, code, requestId };
  if (status === 429) return { retryable: true, category: "rate_limit", status, code, requestId };
  if (status !== undefined && status >= 500) {
    return { retryable: true, category: "server", status, code, requestId };
  }
  if (status !== undefined && !isRetryableProviderStatus(status)) {
    return { retryable: false, category: "permanent_client", status, code, requestId };
  }
  if (isTimeout) return { retryable: true, category: "timeout", status, code, requestId };
  if (CONNECTION_CODES.has(code ?? "") || messages.some(isConnectionMessage)) {
    return { retryable: true, category: "connection", status, code, requestId };
  }
  if (code?.includes("RATE_LIMIT")) {
    return { retryable: true, category: "rate_limit", status, code, requestId };
  }
  return { retryable: true, category: "unknown", status, code, requestId };
}

export function isRetryableProviderFailure(error: unknown): boolean {
  return classifyProviderFailure(error).retryable;
}

export function providerAttemptStatusClass(status: number | undefined, error?: unknown): ProviderAttemptStatusClass {
  if (status !== undefined) {
    if (status >= 200 && status < 300) return "2xx";
    if (status >= 300 && status < 400) return "3xx";
    if (status >= 400 && status < 500) return "4xx";
    if (status >= 500 && status < 600) return "5xx";
  }
  if (error !== undefined) {
    const classification = classifyProviderFailure(error);
    if (classification.category === "connection" || classification.category === "timeout") return "network";
  }
  return "unknown";
}

export interface ProviderAttemptReport {
  physicalAttempt?: number;
  model?: string;
  status?: number;
  statusClass?: ProviderAttemptStatusClass;
  category: ProviderFailureCategory;
  retryDecision: ProviderAttemptDecision;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  finishReason?: string | null;
}

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current) && chain.length < 8) {
    seen.add(current);
    chain.push(current);
    current = objectProperty(current, "cause");
  }
  return chain;
}

function firstStatus(chain: readonly unknown[]): number | undefined {
  for (const candidate of chain) {
    const status = numberProperty(candidate, "status") ?? numberProperty(candidate, "statusCode");
    if (validStatus(status) !== undefined) return status;
  }
  return undefined;
}

function firstCode(chain: readonly unknown[]): string | undefined {
  for (const candidate of chain) {
    const value = stringProperty(candidate, "code");
    if (value) return value.trim().toUpperCase().slice(0, 128);
  }
  return undefined;
}

function firstRequestId(chain: readonly unknown[]): string | undefined {
  for (const candidate of chain) {
    const value = stringProperty(candidate, "requestId") ?? stringProperty(candidate, "request_id");
    if (value) return value.trim().slice(0, 240);
  }
  return undefined;
}

function isTimeoutMessage(value: string | undefined): boolean {
  return Boolean(value && /\b(?:timed? out|timeout)\b/.test(value));
}

function isConnectionMessage(value: string | undefined): boolean {
  return Boolean(value && /(?:fetch failed|socket hang up|connection (?:closed|refused|reset)|network error)/.test(value));
}

function objectProperty(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

function stringProperty(value: unknown, key: string): string | undefined {
  const property = objectProperty(value, key);
  return typeof property === "string" && property.trim() ? property : undefined;
}

function numberProperty(value: unknown, key: string): number | undefined {
  const property = objectProperty(value, key);
  return typeof property === "number" && Number.isFinite(property) ? property : undefined;
}

function validStatus(value: number | undefined): number | undefined {
  return value !== undefined && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}

function safeDiagnosticValue(value: string | undefined, maxLength: number): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}
