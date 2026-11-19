import { setTimeout as delay } from "node:timers/promises";

export type McpConnectionFailure = "token_rejected" | "session_expired" | "temporary" | "permission" | "configuration" | "reauth_required";

const messages: Record<McpConnectionFailure, string> = {
  token_rejected: "The MCP service rejected the access token.",
  session_expired: "The MCP session expired.",
  temporary: "The MCP service is temporarily unavailable.",
  permission: "The MCP service denied access. Check the connector's permissions and scopes.",
  configuration: "The MCP connector is unavailable under its current configuration. Check with your administrator.",
  reauth_required: "The connection owner needs to reconnect this MCP connector.",
};

export class McpConnectionError extends Error {
  constructor(
    readonly kind: McpConnectionFailure,
    readonly beforeDispatch: boolean,
    readonly details: { status?: number; retryAfterMs?: number; grantId?: string; connectorId?: string; exhausted?: boolean } = {},
    message = messages[kind],
  ) {
    super(message);
    this.name = "McpConnectionError";
  }
}

export function retryAfterMs(headers: Headers): number | undefined {
  const value = headers.get("retry-after")?.trim();
  if (!value) return undefined;
  const timestamp = /^\d+$/.test(value) ? Date.now() + Number(value) * 1000 : Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : undefined;
}

// Leave room for the retry in the original tool step's deadline. An upstream
// request to wait longer ends recovery for this step.
export async function waitForMcpRetry(milliseconds = 250, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  if (milliseconds > 2_000) return false;
  await delay(milliseconds, undefined, { signal });
  return true;
}

export type McpResolvedCredential = { accessToken: string; version: string };

export function observeMcpTransport(
  fetchRemote: typeof fetch,
  streamable: boolean,
  signalForCall: () => AbortSignal | undefined,
  onFailure?: (failure: McpConnectionError) => void,
): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const signal = signalForCall();
    signal?.throwIfAborted();
    const method = request.method === "POST" ? await rpcMethod(request) : null;
    const beforeDispatch = request.method === "GET" || (method !== null && method !== "tools/call");
    let response: Response;
    try {
      response = await fetchRemote(request, signal ? { signal: AbortSignal.any([request.signal, signal]) } : undefined);
    } catch {
      signal?.throwIfAborted();
      const failure = new McpConnectionError("temporary", beforeDispatch);
      onFailure?.(failure);
      throw failure;
    }
    if (response.ok || request.method === "DELETE") return response;

    const status = response.status;
    const retryAfter = retryAfterMs(response.headers);
    const details = { status, ...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}) };
    let failure: McpConnectionError | undefined;
    if (status === 401 || status === 403) {
      const challenge = response.headers.get("www-authenticate") ?? "";
      const bearer = /(?:^|,)\s*Bearer\b/i.test(challenge);
      const code = /\berror\s*=\s*"?([a-z_]+)/i.exec(challenge)?.[1] ?? await oauthErrorCode(response);
      if (status === 403 || code === "insufficient_scope") failure = new McpConnectionError("permission", true, details);
      else if (bearer || code === "invalid_token") failure = new McpConnectionError("token_rejected", true, details);
      else failure = new McpConnectionError("configuration", beforeDispatch, details);
    } else if (status === 404 && streamable && request.headers.has("mcp-session-id")) {
      failure = new McpConnectionError("session_expired", true, details);
    } else if (status === 408 || status === 429 || status >= 500) {
      failure = new McpConnectionError("temporary", beforeDispatch, details);
    } else if (status >= 300 && status < 400) {
      failure = new McpConnectionError("configuration", beforeDispatch, details, "The MCP endpoint redirects. Ask an administrator to save its final HTTPS URL.");
    } else if (status >= 400 && beforeDispatch && request.method === "POST") {
      failure = new McpConnectionError("configuration", beforeDispatch, details);
    }
    if (!failure) return response;
    await response.body?.cancel().catch(() => undefined);
    onFailure?.(failure);
    throw failure;
  };
}

async function rpcMethod(request: Request): Promise<string | null> {
  try {
    const body = await request.clone().json() as { method?: unknown };
    return typeof body?.method === "string" ? body.method : null;
  } catch { return null; }
}

async function oauthErrorCode(response: Response): Promise<string | undefined> {
  // The HTTP status and standardized code are evidence. Tool content and
  // provider error descriptions never participate in authentication recovery.
  const body = await response.json().catch(() => null) as { error?: string | { code?: string }; code?: string } | null;
  return typeof body?.error === "string" ? body.error : body?.error?.code ?? body?.code;
}
