import { BerryApiError } from "@berry/api-client";

/**
 * The web's actionErrorMessage, adapted for the phone: API errors keep the
 * server's message when it is safe to show, validation errors show their
 * first issue instead of a JSON dump, and network failures say so plainly.
 */
export function actionErrorMessage(cause: unknown, fallback: string): string {
  if (cause instanceof BerryApiError) {
    const body = cause.body && typeof cause.body === "object" ? cause.body as Record<string, unknown> : {};
    if (cause.status === 401) return "You've been signed out of this server.";
    if (cause.status === 403) return "You do not have permission to perform this action.";
    if (cause.status === 429) return "Too many requests. Wait a moment and try again.";
    if (cause.status < 500 && typeof body.message === "string" && body.message.trim()) return body.message;
    if (cause.status === 400 && Array.isArray(body.message) && body.message.every((item) => typeof item === "string")) return body.message.join(". ") || fallback;
    return fallback;
  }
  const issue = firstValidationIssue(cause);
  if (issue) return issue;
  if (isAbort(cause)) return fallback;
  if (cause instanceof TypeError && /fetch|network/i.test(cause.message)) return "Couldn't reach the server. Check your connection and try again.";
  return cause instanceof Error && cause.message.trim() ? cause.message : fallback;
}

export function isAbort(cause: unknown): boolean {
  return cause instanceof Error && (cause.name === "AbortError" || /\babort/i.test(cause.message));
}

/** Zod errors are duck-typed: workspace packages may resolve their own zod copy. */
function firstValidationIssue(cause: unknown): string | null {
  if (!cause || typeof cause !== "object" || (cause as { name?: unknown }).name !== "ZodError") return null;
  const issues = (cause as { issues?: unknown }).issues;
  if (!Array.isArray(issues) || issues.length === 0) return null;
  const issue = issues[0] as { message?: unknown; path?: unknown };
  const message = typeof issue.message === "string" ? issue.message : null;
  if (!message) return null;
  const field = Array.isArray(issue.path) && typeof issue.path[0] === "string" ? issue.path[0] : null;
  return field && !message.toLowerCase().includes(field.toLowerCase()) ? `${fieldLabel(field)}: ${message}` : message;
}

function fieldLabel(field: string): string {
  const known: Record<string, string> = { prompt: "Instructions", name: "Name", schedule: "Schedule", timezone: "Timezone" };
  return known[field] ?? field.charAt(0).toUpperCase() + field.slice(1);
}
