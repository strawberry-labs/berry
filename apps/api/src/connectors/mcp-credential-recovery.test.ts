import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorSecretEnvelopeSchema, openConnectorSecret, sealConnectorSecret, sealDurableSecret, type McpCredentialRequest } from "@berry/shared";
import type { McpOAuthState } from "@berry/local-agent";
import type { SqlExecutor } from "../db/cloud-database.service.ts";

const provider = vi.hoisted(() => ({ refresh: vi.fn(), start: vi.fn(), complete: vi.fn(), discover: vi.fn() }));
vi.mock("@berry/local-agent", async (original) => ({
  ...await original<typeof import("@berry/local-agent")>(),
  refreshRemoteMcpOAuth: provider.refresh,
  startRemoteMcpOAuth: provider.start,
  completeRemoteMcpOAuth: provider.complete,
  discoverRemoteMcpTools: provider.discover,
}));

import { McpOAuthRefreshError } from "@berry/local-agent";
import { ConnectorsService } from "./connectors.service.ts";

const tenantId = "00000000-0000-7000-8000-000000000001";
const userId = "00000000-0000-7000-8000-000000000201";
const otherId = "00000000-0000-7000-8000-000000000202";
const taskId = "00000000-0000-7000-8000-000000000301";
const runId = "00000000-0000-7000-8000-000000000401";
const connectorId = "connector_mcp_test";
const key = Buffer.alloc(32, 7).toString("base64");
const capabilityKey = Buffer.alloc(32, 8).toString("base64");
const token = (name: string) => ({ access_token: name, token_type: "Bearer", refresh_token: `${name}-refresh` });
const tool = { name: "remove_record", description: null, inputSchema: { type: "object" } };
const grant = { tokens: token("old"), clientInformation: { client_id: "berry" }, discoveryState: { authorizationServerUrl: "https://auth.example.test/" } } satisfies McpOAuthState;

function pendingExchange() {
  let resolve!: (state: McpOAuthState) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<McpOAuthState>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function harness({ shared = false, expiresIn, legacy = false }: { shared?: boolean; expiresIn?: number; legacy?: boolean } = {}) {
  const scope = shared ? "shared-credential" : `user:${userId}:credential`;
  const context = `${tenantId}:connector:${connectorId}:${scope}`;
  const envelope = await sealConnectorSecret(JSON.stringify({ state: { ...grant, tokens: { ...grant.tokens, expires_in: expiresIn } }, obtainedAt: new Date().toISOString() }), key, context);
  const row = {
    id: connectorId, connector_key: "custom-mcp-test", kind: "custom_mcp", provider: "mcp", name: "Connect", description: "", enabled: true,
    max_access_level: "full", workspace_access_mode: null, auth_strategy: shared ? "shared" : "personal", auth_type: "oauth",
    transport: "streamable-http", endpoint_url: "https://8.8.8.8/mcp", publication_status: "published", approval_status: "approved",
    shared_credential_envelope: shared ? envelope : null as typeof envelope | null,
    config: { discoveredTools: [tool], allowedTools: [tool.name] },
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  let connection: Record<string, unknown> | null = shared ? null : {
    id: "connection", connector_id: connectorId, user_id: userId, credential_envelope: envelope, access_level: "full", status: "connected", granted_scopes: [],
  };
  let snapshot: Record<string, unknown> | undefined;
  let failureGrant: string | undefined;
  let cancelled = false;
  const states = new Map<string, { state_digest: string; connector_id: unknown; user_id: unknown; code_verifier_envelope: unknown; requested_scopes: unknown; redirect_after: unknown; expires_at: unknown; consumed: boolean }>();
  const executor: SqlExecutor = {
    execute: async (sql, params = []) => {
      if (sql.includes("SET shared_credential_envelope=$1")) row.shared_credential_envelope = JSON.parse(String(params[0]));
      else if (sql.includes("UPDATE connector_connections SET credential_envelope")) {
        if (!connection) throw new Error("Credential update unexpectedly followed disconnect");
        connection = { ...connection, credential_envelope: JSON.parse(String(params[0])), status: params[1], expires_at: params[2], last_error_code: params[3] };
      } else if (sql.includes("INSERT INTO connector_connections")) {
        connection = { id: params[0], connector_id: params[2], user_id: params[3], credential_envelope: JSON.parse(String(params[5])), status: "connected", expires_at: params[9] };
      } else if (sql.includes("DELETE FROM connector_connections")) connection = null;
      else if (sql.includes("INSERT INTO connector_oauth_states")) {
        states.set(String(params[0]), { state_digest: String(params[0]), connector_id: params[2], user_id: params[3], code_verifier_envelope: JSON.parse(String(params[6])), requested_scopes: params[5], redirect_after: params[7], expires_at: params[8], consumed: false });
      } else if (sql.includes("DELETE FROM connector_oauth_states WHERE state_digest")) states.delete(String(params[0]));
    },
    query: async <T>(sql: string, params: readonly unknown[] = []) => {
      let results: unknown[] = [];
      if (sql.includes("SELECT server.spec AS server")) {
        if (!cancelled && snapshot && params[1] === runId && params[2] === userId && params[3] === "worker-lease" && params[4] === 2 && params[5] === connectorId) {
          results = [{ server: snapshot, created_at: row.created_at }];
        }
      } else if (sql.includes("SELECT t.id FROM tasks t")) {
        if (params[1] === userId && params[2] === taskId) results = [{ id: taskId }];
      } else if (sql.includes("JOIN turn_steps s")) {
        if (failureGrant) results = [{ connector_id: connectorId, grant_id: failureGrant, run_id: runId }];
      } else if (sql.includes("FROM organization_connectors")) {
        if (params[0] === connectorId || sql.includes("ORDER BY") || sql.includes("ANY(")) results = [structuredClone(row)];
      } else if (sql.includes("SELECT * FROM connector_connections")) {
        if (connection && (params[0] === userId || params[1] === userId)) results = [structuredClone(connection)];
      } else if (sql.includes("UPDATE connector_oauth_states SET consumed_at")) {
        const state = states.get(String(params[0]));
        if (state?.user_id === params[1] && !state?.consumed) {
          state!.consumed = true;
          results = [state];
        }
      } else if (sql.includes("SELECT state_digest FROM connector_oauth_states")) {
        if (states.has(String(params[0]))) results = [{ state_digest: params[0] }];
      }
      return results as T[];
    },
  };
  // Both service instances transact on the same credential rows. The mock
  // serializes transactions, leaving provider requests free to overlap.
  let tail: Promise<unknown> = Promise.resolve();
  const database = { withTenant<T>(tenant: string, work: (db: SqlExecutor) => Promise<T>): Promise<T> {
    const next = tail.then(() => work(tenant === tenantId ? executor : { execute: async () => {}, query: async () => [] }));
    tail = next.catch(() => undefined);
    return next;
  } };
  const service = () => new ConnectorsService(database as never, { BERRY_CONNECTOR_ENCRYPTION_KEY: key, BERRY_DURABLE_CAPABILITY_KEY: capabilityKey });
  const [admitted] = await service().runtime(tenantId, userId, { resolveDuringExecution: true });
  if (!admitted) throw new Error("Mock connector was not admitted");
  const { credentialKey, ...server } = admitted;
  snapshot = { ...server, credentialRef: legacy ? `connector:${connectorId}:${shared ? "shared" : userId}` : credentialKey,
    ...(legacy ? { credential: await sealDurableSecret("old", capabilityKey) } : {}) };
  const proof = async (override: Partial<McpCredentialRequest> = {}) => sealDurableSecret(JSON.stringify({
    purpose: "resolve-run-mcp-credential", expiresAt: Date.now() + 30_000,
    tenantId, userId, runId, leaseOwner: "worker-lease", ownershipGeneration: 2, connectorId, ...override,
  }), capabilityKey);
  return {
    client: service(), other: service(), snapshot, proof, row,
    cancel: () => { cancelled = true; },
    recordFailure: (grantId: string) => { failureGrant = grantId; },
    readSaved: async () => JSON.parse(await openConnectorSecret(ConnectorSecretEnvelopeSchema.parse(shared ? row.shared_credential_envelope : connection?.credential_envelope), [key], context)),
  };
}

describe("stored MCP grants and task reconnect", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    provider.refresh.mockImplementation(async ({ state }: { state: McpOAuthState }) => ({ ...state, tokens: { ...token("new"), expires_in: 3600 } }));
    provider.start.mockResolvedValue({ state: grant, authorizationUrl: "https://auth.example.test/authorize" });
    provider.complete.mockResolvedValue({ ...grant, tokens: token("reconnected") });
    provider.discover.mockImplementation(async ({ resolveCredential }) => {
      await resolveCredential({});
      return [tool];
    });
  });
  afterEach(() => vi.useRealTimers());

  it.each([false, true])("renews when an admitted or legacy snapshot is used after expiry (%s)", async (legacy) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const store = await harness({ expiresIn: 3, legacy });
    const proof = await store.proof();
    expect(provider.refresh).not.toHaveBeenCalled();
    expect(store.snapshot).toMatchObject({ credentialRef: expect.any(String) });
    expect(store.snapshot).not.toHaveProperty("credential", "old");
    if (!legacy) expect(store.snapshot).not.toHaveProperty("credential");
    await expect(store.client.resolveRunMcpCredential(proof)).resolves.toMatchObject({ status: "available", accessToken: "old" });
    vi.setSystemTime(Date.now() + 4_000);
    await expect(store.other.resolveRunMcpCredential(proof)).resolves.toMatchObject({ status: "available", accessToken: "new" });
    expect(provider.refresh).toHaveBeenCalledTimes(1);
    expect((await store.readSaved()).state.tokens).toMatchObject({ access_token: "new", refresh_token: "new-refresh", expires_in: 3600 });
    await expect(store.client.taskMcpReconnects(tenantId, userId, taskId, false)).resolves.toEqual([]);
  });

  it("shares one forced rotation across twelve requests from different API processes", async () => {
    const store = await harness({ shared: true });
    const first = await store.client.resolveRunMcpCredential(await store.proof());
    if (first.status !== "available") throw new Error("missing original access token");
    const request = await store.proof({ rejectedVersion: first.version });
    const callers = Array.from({ length: 12 }, (_, index) => (index % 2 ? store.client : store.other).resolveRunMcpCredential(request));
    const results = await Promise.all(callers);
    expect(results).toHaveLength(12);
    expect(results.every((result) => result.status === "available" && result.accessToken === "new")).toBe(true);
    expect(provider.refresh).toHaveBeenCalledTimes(1);
    expect((await store.readSaved()).state.tokens.refresh_token).toBe("new-refresh");
  });

  it("persists a discovery refresh and reuses it during execution", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const store = await harness({ expiresIn: 1 });
    vi.setSystemTime(Date.now() + 2_000);
    await store.client.discoverCustom(tenantId, userId, connectorId);
    expect((await store.readSaved()).state.tokens.refresh_token).toBe("new-refresh");
    await expect(store.other.resolveRunMcpCredential(await store.proof())).resolves.toMatchObject({ status: "available", accessToken: "new" });
    expect(provider.refresh).toHaveBeenCalledTimes(1);
  });

  it.each(["reconnect", "disconnect"])("ignores a delayed invalid_grant after %s", async (change) => {
    const store = await harness();
    const first = await store.client.resolveRunMcpCredential(await store.proof());
    if (first.status !== "available") throw new Error("missing original access token");
    const exchange = pendingExchange();
    provider.refresh.mockReturnValue(exchange.promise);
    const pending = store.client.resolveRunMcpCredential(await store.proof({ rejectedVersion: first.version }));
    await vi.waitFor(() => expect(provider.refresh).toHaveBeenCalledTimes(1));
    if (change === "disconnect") await store.other.disconnect(tenantId, userId, connectorId);
    else {
      const flow = await store.other.startCustomOAuth(tenantId, userId, connectorId);
      await store.other.completeCustomOAuth(tenantId, userId, { state: flow.state, code: "fresh-code" });
    }
    exchange.reject(new McpOAuthRefreshError("invalid_grant"));
    await expect(pending).resolves.toEqual({ status: "configuration" });
    if (change === "reconnect") expect((await store.readSaved()).state.tokens.refresh_token).toBe("reconnected-refresh");
    else await expect(store.readSaved()).rejects.toThrow();
  });

  it("preserves an uncertain rotation and requires a second definitive rejection of the latest grant", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const store = await harness();
    const first = await store.client.resolveRunMcpCredential(await store.proof());
    if (first.status !== "available") throw new Error("missing original access token");
    provider.refresh.mockRejectedValueOnce(new McpOAuthRefreshError("uncertain")).mockRejectedValueOnce(new McpOAuthRefreshError("invalid_grant"));
    const request = await store.proof({ rejectedVersion: first.version });
    await expect(store.client.resolveRunMcpCredential(request)).resolves.toEqual({ status: "temporary", uncertain: true });
    await expect(store.other.resolveRunMcpCredential(request)).resolves.toEqual({ status: "temporary", uncertain: true });
    expect(provider.refresh).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 31_000);
    await expect(store.other.resolveRunMcpCredential(await store.proof({ rejectedVersion: first.version }))).resolves.toEqual({ status: "temporary", uncertain: true });
    expect((await store.readSaved()).state.tokens).toEqual(token("old"));
    await expect(store.client.taskMcpReconnects(tenantId, userId, taskId, false)).resolves.toEqual([]);
    vi.setSystemTime(Date.now() + 31_000);
    provider.refresh.mockRejectedValueOnce(new McpOAuthRefreshError("invalid_grant"));
    await expect(store.other.resolveRunMcpCredential(await store.proof({ rejectedVersion: first.version }))).resolves.toMatchObject({ status: "reauth_required" });
  });

  it.each([false, true])("binds task sign-in, its return, and the blocked grant to the eligible owner (%s shared)", async (shared) => {
    const store = await harness({ shared });
    const first = await store.client.resolveRunMcpCredential(await store.proof());
    if (first.status !== "available") throw new Error("missing original access token");
    provider.refresh.mockRejectedValueOnce(new McpOAuthRefreshError("invalid_grant"));
    const failed = await store.client.resolveRunMcpCredential(await store.proof({ rejectedVersion: first.version }));
    if (failed.status !== "reauth_required") throw new Error("missing sign-in requirement");
    store.recordFailure(failed.grantId);
    const action = { connectorId, name: "Connect", taskId, runId, canReconnect: true };
    await expect(store.client.taskMcpReconnects(tenantId, userId, taskId, shared)).resolves.toEqual([action]);
    await expect(store.other.taskMcpReconnects(tenantId, userId, taskId, shared)).resolves.toEqual([action]);
    await expect(store.client.taskMcpReconnects(otherId, userId, taskId, true)).rejects.toMatchObject({ status: 404 });
    await expect(store.client.taskMcpReconnects(tenantId, otherId, taskId, true)).rejects.toMatchObject({ status: 404 });
    if (shared) {
      await expect(store.client.taskMcpReconnects(tenantId, userId, taskId, false)).resolves.toEqual([{ ...action, canReconnect: false }]);
      await expect(store.client.startCustomOAuth(tenantId, userId, connectorId, false, "/settings/mcp", taskId)).rejects.toThrow("administrator");
    }
    const start = () => store.client.startCustomOAuth(tenantId, userId, connectorId, shared, "/settings/mcp", taskId);
    const interrupted = await start();
    await expect(store.client.completeCustomOAuth(tenantId, userId, { state: interrupted.state, error: "access_denied" }, shared))
      .resolves.toMatchObject({ redirectAfter: `/tasks/${taskId}`, error: expect.stringContaining("cancelled") });
    await expect(store.client.taskMcpReconnects(tenantId, userId, taskId, shared)).resolves.toEqual([action]);
    const flow = await start();
    await expect(store.client.completeCustomOAuth(tenantId, userId, { state: flow.state, code: "fresh-code" }, shared))
      .resolves.toEqual({ redirectAfter: `/tasks/${taskId}`, connectorId });
    await expect(store.client.taskMcpReconnects(tenantId, userId, taskId, shared)).resolves.toEqual([]);
    await expect(store.client.resolveRunMcpCredential(await store.proof())).resolves.toEqual({ status: "configuration" });
    await expect(store.client.completeCustomOAuth(tenantId, userId, { state: flow.state, code: "replay" }, shared)).rejects.toThrow("state is invalid");
  });

  it("rejects other tenants, actors, connectors, stale leases and cancelled runs at the credential boundary", async () => {
    const store = await harness();
    for (const fields of [{ tenantId: otherId }, { userId: otherId }, { connectorId: "connector_mcp_other" }, { ownershipGeneration: 1 }, { expiresAt: Date.now() - 1000 }]) {
      await expect(store.client.resolveRunMcpCredential(await store.proof(fields))).rejects.toMatchObject({ status: 403 });
    }
    store.cancel();
    await expect(store.client.resolveRunMcpCredential(await store.proof())).rejects.toMatchObject({ status: 403 });
    expect(provider.refresh).not.toHaveBeenCalled();
  });

  it("saves a rotation that finishes after cancellation and refuses to release it to the cancelled run", async () => {
    const store = await harness();
    const first = await store.client.resolveRunMcpCredential(await store.proof());
    if (first.status !== "available") throw new Error("missing original access token");
    const exchange = pendingExchange();
    provider.refresh.mockReturnValue(exchange.promise);
    const pending = store.client.resolveRunMcpCredential(await store.proof({ rejectedVersion: first.version }));
    const rejected = expect(pending).rejects.toMatchObject({ status: 403 });
    await vi.waitFor(() => expect(provider.refresh).toHaveBeenCalledTimes(1));
    store.cancel();
    exchange.resolve({ ...grant, tokens: token("new") });
    await rejected;
    expect((await store.readSaved()).state.tokens.refresh_token).toBe("new-refresh");
  });
});
