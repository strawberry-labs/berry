import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { sealConnectorSecret } from "@berry/shared";
import type { SqlExecutor } from "../db/cloud-database.service.ts";
import { ConnectorsService } from "./connectors.service.ts";

const TENANT_ID = "00000000-0000-7000-8000-000000000001";
const USER_ID = "00000000-0000-7000-8000-000000000201";
const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

type TestRow = Record<string, unknown>;

function customRow(overrides: TestRow = {}): TestRow {
  return {
    id: "connector_mcp_test",
    connector_key: "custom-mcp-test",
    kind: "custom_mcp",
    provider: "mcp",
    name: "Test MCP",
    description: "Test connector",
    enabled: true,
    max_access_level: "full",
    workspace_access_mode: null,
    auth_strategy: "shared",
    transport: "streamable-http",
    endpoint_url: "http://localhost:4000/mcp",
    auth_type: "bearer",
    publication_status: "published",
    shared_credential_envelope: { version: 1, algorithm: "aes-256-gcm", iv: "old", ciphertext: "old", tag: "old" },
    config: {
      discoveredTools: [{ name: "old_tool", description: null, inputSchema: { type: "object" } }],
      allowedTools: ["old_tool"],
      lastDiscoveredAt: "2026-01-01T00:00:00.000Z",
    },
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function googleRow(overrides: TestRow = {}): TestRow {
  return {
    id: "connector_google_workspace",
    connector_key: "google-workspace",
    kind: "app",
    provider: "google",
    name: "Google Workspace",
    description: "Google Workspace connector",
    enabled: true,
    max_access_level: "read",
    workspace_access_mode: "search_workspace",
    auth_strategy: "personal",
    transport: null,
    endpoint_url: null,
    auth_type: "oauth",
    publication_status: "published",
    shared_credential_envelope: null,
    config: {},
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function serviceHarness(initialRow: TestRow | null) {
  let row = initialRow;
  let connection: TestRow | null = null;
  const executions: Array<{ sql: string; params: readonly unknown[] }> = [];
  const executor: SqlExecutor = {
    execute: async (sql, params = []) => {
      executions.push({ sql, params });
      if (sql.includes("INSERT INTO organization_connectors")) {
        row = customRow({
          ...(row ?? {}),
          id: params[0],
          connector_key: params[2],
          name: params[3],
          description: params[4],
          enabled: false,
          max_access_level: params[5],
          auth_strategy: params[6],
          transport: params[7],
          endpoint_url: params[8],
          auth_type: params[9],
          shared_credential_envelope: params[10] ? JSON.parse(String(params[10])) : null,
          publication_status: "draft",
          config: JSON.parse(String(params[11])),
        });
      }
      if (sql.includes("DELETE FROM connector_connections")) connection = null;
      if (sql.includes("INSERT INTO connector_connections")) {
        connection = {
          id: params[0],
          connector_id: params[2],
          user_id: params[3],
          access_level: params[4],
          credential_envelope: JSON.parse(String(params[5])),
          account_email: params[6],
          account_subject: params[7],
          granted_scopes: params[8],
          status: "connected",
          expires_at: params[9],
          last_error_code: null,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        };
      }
    },
    query: async <T>(sql: string) => {
      if (sql.includes("SELECT * FROM organization_connectors WHERE id=")) return (row ? [row] : []) as T[];
      if (sql.includes("SELECT * FROM organization_connectors ORDER BY")) return (row ? [row] : []) as T[];
      if (sql.includes("SELECT * FROM connector_connections")) return (connection ? [connection] : []) as T[];
      if (sql.includes("SELECT * FROM connector_provider_credentials")) return [] as T[];
      return [] as T[];
    },
  };
  const database = {
    withTenant: async <T>(_tenantId: string, callback: (db: SqlExecutor) => Promise<T>) => callback(executor),
  };
  return {
    executions,
    service: new ConnectorsService(database as never, {
      NODE_ENV: "development",
      BERRY_CONNECTOR_ENCRYPTION_KEY: ENCRYPTION_KEY,
    }),
  };
}

describe("ConnectorsService custom MCP credential lifecycle", () => {
  it("invalidates credentials and reviewed tools when the MCP authority changes", async () => {
    const { service, executions } = serviceHarness(customRow());

    const result = await service.saveCustom(TENANT_ID, USER_ID, {
      id: "connector_mcp_test",
      name: "Test MCP",
      description: "Moved server",
      url: "http://localhost:5000/mcp",
      transport: "streamable-http",
      authType: "bearer",
      authStrategy: "shared",
      maxAccessLevel: "full",
      sharedCredential: "replacement-token",
    });

    expect(executions.some(({ sql }) => sql.includes("DELETE FROM connector_oauth_states"))).toBe(true);
    expect(executions.some(({ sql }) => sql.includes("DELETE FROM connector_connections"))).toBe(true);
    expect(result.tools).toEqual([]);
    expect(result.publicationStatus).toBe("draft");
  });

  it("requires a replacement shared token when the authority changes", async () => {
    const { service, executions } = serviceHarness(customRow());

    await expect(service.saveCustom(TENANT_ID, USER_ID, {
      id: "connector_mcp_test",
      name: "Test MCP",
      url: "http://localhost:5000/mcp",
      transport: "streamable-http",
      authType: "bearer",
      authStrategy: "shared",
      maxAccessLevel: "full",
    })).rejects.toThrow("shared bearer token is required");

    expect(executions).toEqual([]);
  });

  it("stores the administrator's personal bearer token for draft discovery", async () => {
    const { service, executions } = serviceHarness(null);

    const result = await service.saveCustom(TENANT_ID, USER_ID, {
      name: "Personal MCP",
      url: "http://localhost:5000/mcp",
      transport: "streamable-http",
      authType: "bearer",
      authStrategy: "personal",
      maxAccessLevel: "full",
      personalCredential: "admin-discovery-token",
    });

    expect(executions.some(({ sql }) => sql.includes("INSERT INTO connector_connections"))).toBe(true);
    expect(result.credentialConfigured).toBe(true);
    expect(result.connectionStatus).toBe("connected");
  });

  it("skips a connector with an unreadable shared credential instead of failing the whole runtime", async () => {
    const invalidEnvelope = await sealConnectorSecret("shared-token", ENCRYPTION_KEY, "wrong-context");
    const row = customRow({ shared_credential_envelope: invalidEnvelope });
    const executions: Array<{ sql: string; params: readonly unknown[] }> = [];
    const executor: SqlExecutor = {
      execute: async (sql, params = []) => { executions.push({ sql, params }); },
      query: async <T>(sql: string) => sql.includes("enabled=true") ? [row] as T[] : [],
    };
    const database = { withTenant: async <T>(_tenantId: string, callback: (db: SqlExecutor) => Promise<T>) => callback(executor) };
    const service = new ConnectorsService(database as never, {
      NODE_ENV: "development",
      BERRY_CONNECTOR_ENCRYPTION_KEY: ENCRYPTION_KEY,
    });

    await expect(service.runtime(TENANT_ID, USER_ID)).resolves.toEqual([]);
    expect(executions.some(({ sql, params }) =>
      sql.includes("shared_credential_envelope=NULL") && params[1] === row.id
    )).toBe(true);
  });
});

describe("ConnectorsService Google authorization policy", () => {
  it("uses selected files as the default Workspace access boundary", async () => {
    const { service } = serviceHarness(null);

    const connectors = await service.list(TENANT_ID, USER_ID);

    expect(connectors.find((connector) => connector.key === "google-workspace")?.workspaceAccessMode)
      .toBe("selected_files");
  });

  it("invalidates existing tokens when Workspace access mode changes", async () => {
    let row = googleRow();
    const pickerEnvelope = await sealConnectorSecret(
      "picker-api-key",
      ENCRYPTION_KEY,
      `${TENANT_ID}:provider:google:picker-api-key`,
    );
    const executions: Array<{ sql: string; params: readonly unknown[] }> = [];
    const executor: SqlExecutor = {
      execute: async (sql, params = []) => {
        executions.push({ sql, params });
        if (sql.includes("UPDATE organization_connectors SET enabled=")) {
          row = { ...row, enabled: params[0], max_access_level: params[1], workspace_access_mode: params[2] };
        }
      },
      query: async <T>(sql: string) => {
        if (sql.includes("WHERE connector_key=$1 FOR UPDATE")) return [row] as T[];
        if (sql.includes("SELECT picker_api_key_envelope")) return [{ picker_api_key_envelope: pickerEnvelope, picker_project_number: "123456789" }] as T[];
        if (sql.includes("ORDER BY kind, name")) return [row] as T[];
        return [] as T[];
      },
    };
    const database = { withTenant: async <T>(_tenantId: string, callback: (db: SqlExecutor) => Promise<T>) => callback(executor) };
    const service = new ConnectorsService(database as never, { BERRY_CONNECTOR_ENCRYPTION_KEY: ENCRYPTION_KEY });

    await service.updateBuiltIn(TENANT_ID, USER_ID, "google-workspace", {
      enabled: true,
      maxAccessLevel: "read",
      workspaceAccessMode: "selected_files",
    });

    expect(executions.some(({ sql }) => sql.includes("DELETE FROM connector_oauth_states WHERE tenant_id=$1::uuid AND connector_id=$2"))).toBe(true);
    const invalidation = executions.find(({ sql }) => sql.includes("last_error_code=$3"));
    expect(invalidation?.sql).toContain("credential_envelope=NULL");
    expect(invalidation?.params).toEqual([TENANT_ID, "connector_google_workspace", "workspace_access_mode_changed"]);
  });

  it("requires Google Picker before Selected files can be enabled", async () => {
    const row = googleRow({ enabled: false, workspace_access_mode: "selected_files" });
    const executor: SqlExecutor = {
      execute: async () => undefined,
      query: async <T>(sql: string) => {
        if (sql.includes("WHERE connector_key=$1 FOR UPDATE")) return [row] as T[];
        return [] as T[];
      },
    };
    const database = { withTenant: async <T>(_tenantId: string, callback: (db: SqlExecutor) => Promise<T>) => callback(executor) };
    const service = new ConnectorsService(database as never, { BERRY_CONNECTOR_ENCRYPTION_KEY: ENCRYPTION_KEY });

    await expect(service.updateBuiltIn(TENANT_ID, USER_ID, "google-workspace", {
      enabled: true,
      maxAccessLevel: "read",
      workspaceAccessMode: "selected_files",
    })).rejects.toThrow("Configure a Google Picker API key and project number");
  });

  it("requires reauthorization when an administrator downgrades full access to read", async () => {
    let row = googleRow({ max_access_level: "full" });
    const executions: Array<{ sql: string; params: readonly unknown[] }> = [];
    const executor: SqlExecutor = {
      execute: async (sql, params = []) => {
        executions.push({ sql, params });
        if (sql.includes("UPDATE organization_connectors SET enabled=")) {
          row = { ...row, enabled: params[0], max_access_level: params[1], workspace_access_mode: params[2] };
        }
      },
      query: async <T>(sql: string) => {
        if (sql.includes("WHERE connector_key=$1 FOR UPDATE")) return [row] as T[];
        if (sql.includes("ORDER BY kind, name")) return [row] as T[];
        return [] as T[];
      },
    };
    const database = { withTenant: async <T>(_tenantId: string, callback: (db: SqlExecutor) => Promise<T>) => callback(executor) };
    const service = new ConnectorsService(database as never, { BERRY_CONNECTOR_ENCRYPTION_KEY: ENCRYPTION_KEY });

    await service.updateBuiltIn(TENANT_ID, USER_ID, "google-workspace", {
      enabled: true,
      maxAccessLevel: "read",
      workspaceAccessMode: "search_workspace",
    });

    const invalidation = executions.find(({ sql }) => sql.includes("admin_access_level_downgraded") || sql.includes("last_error_code=$3"));
    expect(invalidation?.sql).toContain("credential_envelope=NULL");
    expect(invalidation?.sql).toContain("granted_scopes=ARRAY[]::text[]");
    expect(invalidation?.params).toEqual([TENANT_ID, "connector_google_workspace", "admin_access_level_downgraded"]);
  });

  it("disconnects accounts outside a newly restricted hosted domain", async () => {
    const priorEnvelope = await sealConnectorSecret(
      "client-secret",
      ENCRYPTION_KEY,
      `${TENANT_ID}:provider:google:client-secret`,
    );
    const provider = {
      client_id: "client-id",
      client_secret_envelope: priorEnvelope,
      hosted_domain: null,
      picker_api_key_envelope: null,
      picker_project_number: null,
      status: "configured",
      last_tested_at: null,
    };
    const executions: Array<{ sql: string; params: readonly unknown[] }> = [];
    const executor: SqlExecutor = {
      execute: async (sql, params = []) => { executions.push({ sql, params }); },
      query: async <T>(sql: string) => sql.includes("connector_provider_credentials") ? [provider] as T[] : [],
    };
    const database = { withTenant: async <T>(_tenantId: string, callback: (db: SqlExecutor) => Promise<T>) => callback(executor) };
    const service = new ConnectorsService(database as never, { BERRY_CONNECTOR_ENCRYPTION_KEY: ENCRYPTION_KEY });

    await service.configureGoogle(TENANT_ID, USER_ID, {
      clientId: "client-id",
      hostedDomain: "aesg.com",
    });

    const invalidation = executions.find(({ sql }) => sql.includes("google_hosted_domain_changed"));
    expect(invalidation?.sql).toContain("credential_envelope=NULL");
    expect(invalidation?.sql).toContain("split_part");
    expect(invalidation?.params).toEqual([TENANT_ID, "aesg.com"]);
  });

  it("does not request incremental authorization in selected-files mode", async () => {
    const providerEnvelope = await sealConnectorSecret(
      "client-secret",
      ENCRYPTION_KEY,
      `${TENANT_ID}:provider:google:client-secret`,
    );
    const row = googleRow({ workspace_access_mode: "selected_files" });
    const provider = {
      client_id: "client-id",
      client_secret_envelope: providerEnvelope,
      hosted_domain: "aesg.com",
      picker_api_key_envelope: null,
      picker_project_number: null,
      status: "configured",
      last_tested_at: null,
    };
    const executor: SqlExecutor = {
      execute: async () => undefined,
      query: async <T>(sql: string) => {
        if (sql.includes("organization_connectors WHERE id=")) return [row] as T[];
        if (sql.includes("connector_provider_credentials")) return [provider] as T[];
        return [] as T[];
      },
    };
    const database = { withTenant: async <T>(_tenantId: string, callback: (db: SqlExecutor) => Promise<T>) => callback(executor) };
    const service = new ConnectorsService(database as never, {
      BERRY_CONNECTOR_ENCRYPTION_KEY: ENCRYPTION_KEY,
      BERRY_AUTH_BASE_URL: "https://ai.aesg.com",
    });

    const started = await service.startGoogleOAuth(TENANT_ID, USER_ID, row.id as string, "read");
    const authorizationUrl = new URL(started.authorizationUrl);
    expect(authorizationUrl.searchParams.get("include_granted_scopes")).toBeNull();
    expect(authorizationUrl.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/drive.file");
  });

  it("does not store a Google connection when consent omits a required scope", async () => {
    const state = "oauth-state";
    const stateDigest = createHash("sha256").update(state).digest("hex");
    const verifierEnvelope = await sealConnectorSecret(
      JSON.stringify({ type: "google", verifier: "pkce-verifier" }),
      ENCRYPTION_KEY,
      `${TENANT_ID}:oauth-state:${stateDigest}`,
    );
    const providerEnvelope = await sealConnectorSecret(
      "client-secret",
      ENCRYPTION_KEY,
      `${TENANT_ID}:provider:google:client-secret`,
    );
    const executions: string[] = [];
    const executor: SqlExecutor = {
      execute: async (sql) => { executions.push(sql); },
      query: async <T>(sql: string) => {
        if (sql.includes("UPDATE connector_oauth_states SET consumed_at")) return [{
          state_digest: stateDigest,
          connector_id: "connector_google_workspace",
          user_id: USER_ID,
          access_level: "read",
          code_verifier_envelope: verifierEnvelope,
          requested_scopes: ["https://www.googleapis.com/auth/drive.file"],
          redirect_after: "/settings/connectors",
          expires_at: new Date(Date.now() + 60_000),
        }] as T[];
        if (sql.includes("organization_connectors WHERE id=")) {
          return [googleRow({ workspace_access_mode: "selected_files" })] as T[];
        }
        if (sql.includes("connector_provider_credentials")) return [{
          client_id: "client-id.apps.googleusercontent.com",
          client_secret_envelope: providerEnvelope,
          hosted_domain: null,
          picker_api_key_envelope: null,
          picker_project_number: null,
          status: "configured",
          last_tested_at: null,
        }] as T[];
        return [] as T[];
      },
    };
    const database = { withTenant: async <T>(_tenantId: string, callback: (db: SqlExecutor) => Promise<T>) => callback(executor) };
    const service = new ConnectorsService(database as never, {
      BERRY_CONNECTOR_ENCRYPTION_KEY: ENCRYPTION_KEY,
      BERRY_AUTH_BASE_URL: "https://ai.aesg.com",
    });
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      if (String(url).includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_in: 3600,
          scope: "openid email profile",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ email: "user@aesg.com", sub: "google-user" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    try {
      await expect(service.completeGoogleOAuth(TENANT_ID, USER_ID, { state, code: "authorization-code" }))
        .rejects.toThrow("did not grant every required permission");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(executions.some((sql) => sql.includes("INSERT INTO connector_connections"))).toBe(false);
    expect(executions.some((sql) => sql.includes("DELETE FROM connector_oauth_states"))).toBe(true);
  });
});
