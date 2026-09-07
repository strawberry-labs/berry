import { BerryApiError } from "@berry/api-client";

export function actionErrorMessage(cause: unknown, fallback: string): string {
  if (cause instanceof BerryApiError) {
    const body = cause.body && typeof cause.body === "object" ? cause.body as Record<string, unknown> : {};
    const known = body.code === "mcp_endpoint_mismatch" || body.code === "mcp_oauth_unavailable";
    if (cause.status === 401) return "Your session has expired. Sign in again and retry.";
    if (cause.status === 403) return "You do not have permission to perform this action.";
    if (cause.status === 429) return "Too many requests. Wait a moment and try again.";
    if ((cause.status < 500 || known) && typeof body.message === "string" && body.message.trim()) return body.message;
    if (cause.status === 400 && Array.isArray(body.message) && body.message.every((item) => typeof item === "string")) return body.message.join(". ") || fallback;
    return fallback;
  }
  if (cause instanceof TypeError && /fetch|network/i.test(cause.message)) return "Could not reach Berry. Check your connection and try again.";
  return cause instanceof Error ? cause.message : fallback;
}
