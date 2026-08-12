import { RouterClientError } from "@berry/router-client";

export type ProviderFailureCategory =
  | "aborted"
  | "connection"
  | "permanent_client"
  | "rate_limit"
  | "server"
  | "timeout"
  | "unknown";

export interface ProviderRetryClassification {
  retryable: boolean;
  category: ProviderFailureCategory;
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
 * Classify provider failures before handing them back to a durable queue.
 * Unknown failures remain retryable to preserve the existing recovery policy;
 * known permanent HTTP client errors are the exception.
 */
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
  if (status === 408) return { retryable: true, category: "timeout", status, code, requestId };
  if (status === 429) return { retryable: true, category: "rate_limit", status, code, requestId };
  if (status !== undefined && status >= 500) {
    return { retryable: true, category: "server", status, code, requestId };
  }
  if (status !== undefined && status >= 400 && status < 500) {
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
    const status = candidate instanceof RouterClientError
      ? candidate.status
      : numberProperty(candidate, "status") ?? numberProperty(candidate, "statusCode");
    if (status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599) return status;
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
