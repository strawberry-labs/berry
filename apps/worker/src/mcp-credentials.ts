import { McpConnectionError, type McpResolvedCredential } from "@berry/local-agent/mcp";
import { McpCredentialResultSchema, sealDurableSecret, type McpCredentialRequest } from "@berry/shared";
import type { DurableTurnSnapshot } from "./turn-runner.js";

export async function resolveMcpCredential(
  snapshot: DurableTurnSnapshot, connectorId: string, env: NodeJS.ProcessEnv,
  signal?: AbortSignal, rejectedVersion?: string,
): Promise<McpResolvedCredential | undefined> {
  signal?.throwIfAborted();
  const key = env.BERRY_DURABLE_CAPABILITY_KEY?.trim();
  if (!key) throw new McpConnectionError("configuration", true, { connectorId });
  const request: McpCredentialRequest = {
    purpose: "resolve-run-mcp-credential",
    expiresAt: Date.now() + 30_000,
    tenantId: snapshot.tenantId,
    userId: snapshot.userId,
    runId: snapshot.id,
    leaseOwner: snapshot.leaseOwner,
    ownershipGeneration: snapshot.ownershipGeneration ?? 0,
    connectorId,
    ...(rejectedVersion ? { rejectedVersion } : {}),
  };
  const proof = await sealDurableSecret(JSON.stringify(request), key).catch(() => { throw new McpConnectionError("configuration", true, { connectorId }); });
  const timeout = AbortSignal.timeout(40_000);
  const endpoint = new URL("/v1/connectors/mcp/runtime-credential", env.BERRY_WEB_API_INTERNAL_URL?.trim() || "http://localhost:3001");
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      body: JSON.stringify(proof),
      headers: { "content-type": "application/json" },
      redirect: "error",
      cache: "no-store",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 403 || response.status === 404) throw new McpConnectionError("configuration", true, { connectorId });
      throw new McpConnectionError("temporary", true, { connectorId, exhausted: true });
    }
    const result = McpCredentialResultSchema.parse(await response.json());
    if (result.status === "available") return result;
    if (result.status === "static") return undefined;
    if (result.status === "reauth_required") throw new McpConnectionError("reauth_required", true, { connectorId, grantId: result.grantId });
    if (result.status === "configuration") throw new McpConnectionError("configuration", true, { connectorId });
    throw new McpConnectionError("temporary", true, { connectorId, exhausted: true }, result.uncertain
      ? "The MCP token service did not confirm the refresh. Berry kept the saved grant. Try again once the service recovers."
      : undefined);
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof McpConnectionError) throw cause;
    throw new McpConnectionError("temporary", true, { connectorId, exhausted: true });
  }
}
