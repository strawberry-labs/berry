import { classifyProviderFailure } from "./provider-retry.js";

/**
 * Typed tool-failure classes (H-003, H-006). The repair message alone told the
 * model that every failure was worth another attempt; these classes say which
 * failures repeat deterministically, which need a person, and which may have
 * taken effect. Transport detection reuses the shared provider classifier.
 */
export type ToolFailureCategory =
  /** The arguments are wrong for this tool: schema, path policy, unsupported operation. */
  | "invalid_input"
  /** The named file, record, page or source does not exist or cannot be reached. */
  | "missing_resource"
  /** Not admitted, not enabled, unreviewed definition, proxy or allowlist settings. */
  | "configuration"
  /** Connector or account credentials are invalid, expired or revoked. */
  | "credentials"
  /** The provider account has run out of credit or quota. */
  | "credit_exhausted"
  /** Timeouts, dropped connections, rate limits, upstream 5xx and sandbox restarts. */
  | "transient"
  /** A change-making call failed mid-flight; it may already have taken effect. */
  | "unknown_outcome"
  | "unknown";

export interface ToolFailure {
  category: ToolFailureCategory;
  /** The same call fails again unless something else changes first. */
  deterministic: boolean;
  outcome: "not_applied" | "unknown";
  status?: number;
  code?: string;
  action: string;
}

const DETERMINISTIC = new Set<ToolFailureCategory>([
  "invalid_input", "missing_resource", "configuration", "credentials", "credit_exhausted",
]);

const ACTIONS: Record<ToolFailureCategory, string> = {
  invalid_input: "The arguments are not valid for this tool. Correct them before calling again; the same call fails the same way.",
  missing_resource: "Check the exact path, ID or URL first (list, search or read what exists). If it is right, the source is unavailable: use another source or tell the user. The same call fails the same way.",
  configuration: "This needs a configuration or administrator change (admission, connector review, proxy or network settings). Tell the user what is blocked; retrying will not help.",
  credentials: "The connection's credentials are invalid or expired. Ask the user to reconnect it in Settings → Connectors; retrying before that will not help.",
  credit_exhausted: "The provider account has no credit or quota left. Tell the user an administrator must add credit or change the provider; retrying will not help.",
  transient: "This looks temporary. One retry of the same call is reasonable; if it fails again, use another approach or tell the user.",
  unknown_outcome: "This call changes something and failed partway, so it may already have taken effect. Check whether the change happened before repeating it; do not repeat it blindly.",
  unknown: "Read the error, change the approach or the arguments, and do not repeat the same call unchanged.",
};

export const CREDIT_EXHAUSTED_PATTERN = /insufficient_quota|billing details|payment required|(?:out of|exhausted|insufficient|no remaining) (?:your )?(?:credits?|quota|balance)|credit (?:balance )?(?:is )?exhausted|quota (?:is )?exceeded/i;
const CREDENTIALS_PATTERN = /invalid_token|invalid_grant|token (?:is )?(?:invalid|expired|revoked)|(?:invalid|expired|revoked) (?:access |refresh )?token|has expired; reconnect|reauthenticat|re-authenticat|reconnect it|unauthori[sz]ed|(?:connector|connection|account|google|microsoft|drive|gmail|calendar|workspace|outlook|teams)\b[^.\n]{0,40}\bnot connected|authentication (?:failed|required)/i;
const CONFIGURATION_PATTERN = /not admitted|not enabled for this turn|is unavailable because its definition changed|definition changed (?:after|since) (?:administrator )?review|re-?approv|administrator must|allowlist|not allowed by (?:the )?(?:network|execution) policy|network policy|no proxy provider configured|proxy is not configured|not configured|capability is disabled|tool is disabled/i;
const MISSING_PATTERN = /\benoent\b|no such file|\[not_found\]|\bnot found\b|does not exist|\b404\b|no longer exists|challenge_detected|has been deleted|no module named|modulenotfounderror/i;
// Checked before missing resources: these name an argument, not an absent target.
const INVALID_SPECIFIC_PATTERN = /oldtext was not found|was not found in the file|must remain under|paths must contain/i;
const INVALID_PATTERN = /\binvalid\b|\bmust\b|\brequired\b|\bexpected\b|\bschema\b|unsupported|not supported|malformed|cannot parse|syntaxerror|was not found in|exceeds|limited to|must remain under|\b(?:400|422)\b/i;
const TRANSIENT_PATTERN = /timed out|timeout|econnreset|connection reset|etimedout|socket hang up|temporar(?:y|ily)|try again later|rate limit|too many requests|proxy_unavailable|tunnel|sandbox is probably not running|sandbox was not found|service unavailable|bad gateway|\b50[234]\b|\b429\b/i;
// Failures raised before a request was sent cannot have changed anything.
const NOT_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]);

export function toolFailureAction(category: ToolFailureCategory): string {
  return ACTIONS[category];
}

/**
 * Classifies one tool failure. `changesState` is false for read-only tools:
 * a failed read never needs an outcome check, while a failed change-making call
 * that may have reached its target has an unknown outcome.
 */
export function classifyToolFailure(error: unknown, options: { changesState: boolean; timedOut?: boolean }): ToolFailure {
  const transport = classifyProviderFailure(error);
  const details = structuredFailureDetails(error);
  const status = details.status ?? transport.status;
  const code = details.code ?? transport.code;
  // Codes such as invalid_token or SCRAPE_PROXY_UNAVAILABLE carry the class on their own.
  const message = [errorText(error), details.text, code].filter(Boolean).join(" ");
  const category = ((): ToolFailureCategory => {
    if (status === 402 || CREDIT_EXHAUSTED_PATTERN.test(message)) return "credit_exhausted";
    if (status === 401 || CREDENTIALS_PATTERN.test(message)) return "credentials";
    if (status === 403 || CONFIGURATION_PATTERN.test(message)) return "configuration";
    const transient = options.timedOut === true
      || transport.category === "timeout"
      || transport.category === "connection"
      || transport.category === "rate_limit"
      || transport.category === "server"
      || TRANSIENT_PATTERN.test(message)
      || /PROXY_UNAVAILABLE|TIMEOUT|RATE_LIMIT/i.test(code ?? "");
    if (transient) {
      // Errors raised before anything reached the target say so (H-009).
      const notSent = NOT_SENT_CODES.has(code ?? "") || /\bNothing was run\b/.test(message);
      return options.changesState && !notSent ? "unknown_outcome" : "transient";
    }
    if (INVALID_SPECIFIC_PATTERN.test(message)) return "invalid_input";
    if (status === 404 || MISSING_PATTERN.test(message) || /NOT_FOUND|CHALLENGE/i.test(code ?? "")) return "missing_resource";
    if (status === 400 || status === 409 || status === 422 || INVALID_PATTERN.test(message)) return "invalid_input";
    return "unknown";
  })();
  return {
    category,
    deterministic: DETERMINISTIC.has(category),
    outcome: category === "unknown_outcome" ? "unknown" : "not_applied",
    ...(status !== undefined ? { status } : {}),
    ...(code ? { code } : {}),
    action: ACTIONS[category],
  };
}

/** Reads a stored failure classification back from a failed step's output. */
export function storedToolFailure(output: unknown): ToolFailure | null {
  const failure = record(record(output)?.failure);
  const category = failure?.category;
  if (typeof category !== "string" || !(category in ACTIONS)) return null;
  return {
    category: category as ToolFailureCategory,
    deterministic: failure?.deterministic === true,
    outcome: failure?.outcome === "unknown" ? "unknown" : "not_applied",
    ...(typeof failure?.status === "number" ? { status: failure.status } : {}),
    ...(typeof failure?.code === "string" ? { code: failure.code } : {}),
    action: typeof failure?.action === "string" ? failure.action : ACTIONS[category as ToolFailureCategory],
  };
}

function structuredFailureDetails(error: unknown): { status?: number; code?: string; text?: string } {
  for (let current = error, depth = 0; current && depth < 5; depth += 1) {
    const structured = record(record(current)?.structuredContent);
    if (structured) {
      const nested = record(structured.error) ?? structured;
      const status = numberValue(nested.status) ?? numberValue(nested.statusCode) ?? numberValue(structured.status);
      const code = stringValue(nested.code) ?? stringValue(structured.code) ?? stringValue(structured.error);
      const text = [stringValue(nested.message), stringValue(nested.description), stringValue(structured.error_description)]
        .filter(Boolean)
        .join(" ");
      return { ...(status !== undefined ? { status } : {}), ...(code ? { code } : {}), ...(text ? { text } : {}) };
    }
    current = record(current)?.cause;
  }
  return {};
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}
