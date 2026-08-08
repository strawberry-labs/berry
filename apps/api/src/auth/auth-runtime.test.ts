import type { Pool } from "pg";
import { SELF_HOST_WORKSPACE_ID } from "@berry/db";
import { sealConnectorSecret } from "@berry/shared";
import { describe, expect, it, vi } from "vitest";
import { createBetterAuthOptions, RealBetterAuthRuntime, type BerryAuthDescription } from "./auth-runtime.ts";

describe("Better Auth runtime config", () => {
  it("authorizes sessions only while the configured organization membership is active", async () => {
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes("SELECT EXISTS") ? [{ active: false }] : [],
    }));
    const release = vi.fn();
    const runtime = new RealBetterAuthRuntime(
      { handler: vi.fn() } as never,
      baseDescription(),
      { connect: vi.fn(async () => ({ query, release })) } as unknown as Pool,
    );

    await expect(runtime.authorizeSession({
      session: { id: "session_1", userId: "00000000-0000-7000-8000-000000000201" },
      user: {
        id: "00000000-0000-7000-8000-000000000201",
        email: "member@example.test",
        name: "Member",
        emailVerified: true,
      },
    })).resolves.toBe(false);
    expect(query).toHaveBeenCalledWith("SELECT berry_set_tenant_id($1::uuid)", [
      "00000000-0000-7000-8000-000000000001",
    ]);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("status = 'active'"),
      [
        "00000000-0000-7000-8000-000000000001",
        "00000000-0000-7000-8000-000000000201",
      ],
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("enables email/password and maps Better Auth storage onto cloud tables", () => {
    const { authOptions, description } = createBetterAuthOptions({ env: { NODE_ENV: "test", BERRY_AUTH_BASE_URL: "https://berry.example.test" } });

    expect(description).toEqual({
      basePath: "/v1/auth",
      emailPassword: { enabled: true, minPasswordLength: 8, maxPasswordLength: 128 },
      signupEnabled: true,
      setup: {
        required: false,
        available: false,
        ownerEmail: null,
        missingConfiguration: [],
      },
      socialProviders: [],
      ssoProviders: [],
      storage: "memory",
    });
    expect(authOptions.basePath).toBe("/v1/auth");
    expect(authOptions.baseURL).toBe("https://berry.example.test");
    expect(authOptions.emailAndPassword).toMatchObject({ enabled: true, minPasswordLength: 8, maxPasswordLength: 128 });
    expect(authOptions.user).toMatchObject({ modelName: "users", fields: { emailVerified: "email_verified", image: "avatar_url" } });
    expect(authOptions.session).toMatchObject({ modelName: "auth_sessions", fields: { userId: "user_id", expiresAt: "expires_at" } });
    expect(authOptions.account).toMatchObject({
      modelName: "auth_accounts",
      encryptOAuthTokens: true,
      accountLinking: {
        enabled: true,
        trustedProviders: ["github", "email-password"],
        requireLocalEmailVerified: true,
      },
    });
    expect(authOptions.verification).toMatchObject({ modelName: "auth_verifications" });
  });

  it("requires verified local email ownership before implicitly linking an OAuth identity", () => {
    const { authOptions } = createBetterAuthOptions({
      env: { NODE_ENV: "test", BERRY_AUTH_BASE_URL: "https://berry.example.test" },
    });

    expect(authOptions.account?.accountLinking?.requireLocalEmailVerified).toBe(true);
  });

  it("adds GitHub OAuth only when the provider credentials are configured", () => {
    const { authOptions, description } = createBetterAuthOptions({
      env: {
        NODE_ENV: "test",
        BERRY_AUTH_GITHUB_CLIENT_ID: "github-client-id",
        BERRY_AUTH_GITHUB_CLIENT_SECRET: "github-client-secret",
        BERRY_AUTH_GITHUB_REDIRECT_URI: "https://berry.example.test/v1/auth/callback/github",
      },
    });

    expect(description.socialProviders).toEqual(["github"]);
    expect(authOptions.socialProviders?.github).toMatchObject({
      clientId: "github-client-id",
      clientSecret: "github-client-secret",
      redirectURI: "https://berry.example.test/v1/auth/callback/github",
    });
  });

  it("publishes an enabled, encrypted Google Workspace provider to the login screen", async () => {
    const connectionId = "00000000-0000-7000-8000-000000000711";
    const rootKey = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
    const nextRootKey = Buffer.from("fedcba9876543210fedcba9876543210").toString("base64");
    const envelope = await sealConnectorSecret(
      "google-client-secret",
      rootKey,
      `00000000-0000-7000-8000-000000000001:sso:${connectionId}:client-secret`,
    );
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM sso_connections")) return { rows: [{
        id: connectionId,
        display_name: "Google Workspace",
        client_id: "berry.apps.googleusercontent.com",
        client_secret_envelope: envelope,
        domains: ["aesg.com"],
        jit_provisioning: true,
        updated_at: "2026-08-08T00:00:00.000Z",
      }] };
      if (sql.includes("SELECT EXISTS")) return { rows: [{ exists: true }] };
      return { rows: [] };
    });
    const pool = { connect: vi.fn(async () => ({ query, release: vi.fn() })) } as unknown as Pool;
    const runtime = new RealBetterAuthRuntime(
      { handler: vi.fn() } as never,
      baseDescription(),
      pool,
      {
        BERRY_CONNECTOR_ENCRYPTION_KEY: nextRootKey,
        BERRY_CONNECTOR_DECRYPTION_KEYS: rootKey,
      },
    );

    await expect(runtime.describe()).resolves.toMatchObject({
      ssoProviders: [{ id: "google", name: "Google Workspace", domain: "aesg.com" }],
    });
  });

  it("does not advertise Google SSO when the configured keys cannot decrypt its secret", async () => {
    const connectionId = "00000000-0000-7000-8000-000000000711";
    const rootKey = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
    const wrongRootKey = Buffer.from("fedcba9876543210fedcba9876543210").toString("base64");
    const envelope = await sealConnectorSecret(
      "google-client-secret",
      rootKey,
      `00000000-0000-7000-8000-000000000001:sso:${connectionId}:client-secret`,
    );
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes("FROM sso_connections") ? [{
        id: connectionId,
        display_name: "Google Workspace",
        client_id: "berry.apps.googleusercontent.com",
        client_secret_envelope: envelope,
        domains: ["aesg.com"],
        jit_provisioning: true,
        updated_at: "2026-08-08T00:00:00.000Z",
      }] : [],
    }));
    const pool = { connect: vi.fn(async () => ({ query, release: vi.fn() })) } as unknown as Pool;
    const runtime = new RealBetterAuthRuntime(
      { handler: vi.fn() } as never,
      baseDescription(),
      pool,
      { BERRY_CONNECTOR_ENCRYPTION_KEY: wrongRootKey },
    );

    await expect(runtime.describe()).resolves.toMatchObject({
      emailPassword: { enabled: true },
      ssoProviders: [],
    });
  });

  it("keeps password login available without advertising unusable SSO when the encryption key is missing", async () => {
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes("FROM sso_connections") ? [{
        id: "00000000-0000-7000-8000-000000000711",
        display_name: "Google Workspace",
        client_id: "berry.apps.googleusercontent.com",
        client_secret_envelope: { version: 1, algorithm: "aes-256-gcm", keyId: "test", iv: "test", tag: "test", ciphertext: "test" },
        domains: ["aesg.com"],
        jit_provisioning: true,
        updated_at: "2026-08-08T00:00:00.000Z",
      }] : [],
    }));
    const pool = { connect: vi.fn(async () => ({ query, release: vi.fn() })) } as unknown as Pool;
    const runtime = new RealBetterAuthRuntime({ handler: vi.fn() } as never, baseDescription(), pool, {});

    await expect(runtime.describe()).resolves.toMatchObject({
      emailPassword: { enabled: true },
      ssoProviders: [],
    });
  });

  it("keeps non-Google social sign-in on the base handler when Google credentials are unusable", async () => {
    const connect = vi.fn();
    const runtime = new RealBetterAuthRuntime(
      { handler: vi.fn() } as never,
      baseDescription(),
      { connect } as unknown as Pool,
      {},
      "00000000-0000-7000-8000-000000000001",
      {},
    );
    const baseHandler = vi.fn(async () => undefined);
    Object.defineProperty(runtime, "nodeHandler", { value: baseHandler });

    await runtime.handleNodeRequest({
      url: "/v1/auth/sign-in/social",
      body: { provider: "github" },
    } as never, {} as never);

    expect(baseHandler).toHaveBeenCalledOnce();
    expect(connect).not.toHaveBeenCalled();
  });

  it("strips caller-controlled scopes and sign-in overrides from Google SSO requests", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const baseHandler = vi.fn(async () => undefined);
    const runtime = new RealBetterAuthRuntime(
      { handler: vi.fn() } as never,
      baseDescription(),
      { connect: vi.fn(async () => ({ query, release: vi.fn() })) } as unknown as Pool,
      {},
      "00000000-0000-7000-8000-000000000001",
      {},
    );
    Object.defineProperty(runtime, "nodeHandler", { value: baseHandler });
    const request = {
      url: "/v1/auth/sign-in/social",
      body: {
        provider: "google",
        callbackURL: "https://berry.example.test/",
        errorCallbackURL: "https://berry.example.test/login",
        disableRedirect: true,
        scopes: ["https://www.googleapis.com/auth/drive"],
        idToken: "caller-controlled-token",
        requestSignUp: true,
        additionalData: { role: "owner" },
      },
    };

    await runtime.handleNodeRequest(request as never, {} as never);

    expect(request.body).toEqual({
      provider: "google",
      callbackURL: "https://berry.example.test/",
      errorCallbackURL: "https://berry.example.test/login",
      disableRedirect: true,
    });
    expect(baseHandler).toHaveBeenCalledOnce();
  });

  it("uses Postgres storage when a database URL is supplied", () => {
    const { description, pool } = createBetterAuthOptions({
      env: {
        NODE_ENV: "test",
        DATABASE_URL: "postgres://berry:berry@localhost:5432/berry",
      },
    });

    expect(description.storage).toBe("postgres");
    expect(pool).toBeDefined();
    void pool?.end();
  });

  it("requires an explicit Better Auth secret in production", () => {
    expect(() => createBetterAuthOptions({ env: { NODE_ENV: "production" } })).toThrow("BETTER_AUTH_SECRET");
  });

  it("rejects unrestricted production signup by default", () => {
    expect(() => createBetterAuthOptions({ env: {
      NODE_ENV: "production",
      BETTER_AUTH_SECRET: "test-secret-with-more-than-thirty-two-characters",
      BERRY_AUTH_SIGNUP_ENABLED: "true",
    } })).toThrow("BERRY_AUTH_ALLOWED_EMAILS");
  });

  it("creates ordinary self-service signups as members after owner setup", async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [] }));
    const pool = {
      connect: vi.fn(async () => ({ query, release: vi.fn() })),
    } as unknown as Pool;
    const { authOptions } = createBetterAuthOptions({
      database: pool,
      env: {
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: "test-secret-with-more-than-thirty-two-characters",
        BERRY_AUTH_SIGNUP_ENABLED: "true",
        BERRY_AUTH_ALLOWED_EMAILS: "owner@example.test",
        BERRY_DEFAULT_ORG_MONTHLY_BUDGET_MICROS: "100000000",
      },
    });
    const after = (authOptions.databaseHooks as {
      user?: { create?: { after?: (user: { id: string }) => Promise<void> } };
    }).user?.create?.after;

    await after?.({ id: "00000000-0000-7000-8000-000000000111" });

    const orgBudgetSql = query.mock.calls
      .map(([sql]) => sql)
      .find((sql) => sql.includes("'org'"));
    const membershipSql = query.mock.calls
      .map(([sql]) => sql)
      .find((sql) => sql.includes("INSERT INTO tenant_memberships"));
    expect(membershipSql).toContain("'member'");
    const membershipCall = query.mock.calls.find(([sql]) => sql.includes("INSERT INTO tenant_memberships"));
    expect(membershipCall?.[1]).toEqual([
      "00000000-0000-7000-8000-000000000001",
      "00000000-0000-7000-8000-000000000111",
      "signup",
    ]);
    expect(query.mock.calls.some(([sql]) => sql.includes("UPDATE workspaces"))).toBe(false);
    expect(orgBudgetSql).toContain("DO NOTHING");
  });

  it("allows Google JIT provisioning while local signup is closed and records an SSO membership", async () => {
    const connectionQuery = vi.fn(async (sql: string, _params?: readonly unknown[]) => {
      if (sql.includes("SELECT EXISTS")) return { rows: [{ exists: true }] };
      return { rows: [] };
    });
    const pool = {
      connect: vi.fn(async () => ({ query: connectionQuery, release: vi.fn() })),
      query: vi.fn(async () => ({ rows: [{ count: "1" }] })),
    } as unknown as Pool;
    const { authOptions } = createBetterAuthOptions({
      database: pool,
      env: {
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: "test-secret-with-more-than-thirty-two-characters",
        BERRY_AUTH_SIGNUP_ENABLED: "false",
      },
    });
    const hooks = (authOptions.databaseHooks as {
      user?: { create?: {
        before?: (user: { email: string }, context: unknown) => Promise<void>;
        after?: (user: { id: string }, context: unknown) => Promise<void>;
      } };
    }).user?.create;
    const googleCallback = { path: "/callback/:id", params: { id: "google" } };

    await expect(hooks?.before?.({ email: "new.user@aesg.com" }, googleCallback)).resolves.toBeUndefined();
    await hooks?.after?.({ id: "00000000-0000-7000-8000-000000000112" }, googleCallback);

    const membershipCall = connectionQuery.mock.calls.find(([sql]) => sql.includes("INSERT INTO tenant_memberships"));
    expect(membershipCall?.[1]).toEqual([
      "00000000-0000-7000-8000-000000000001",
      "00000000-0000-7000-8000-000000000112",
      "sso",
    ]);
  });

  it("creates the first owner, claims the default workspace, and closes setup in one transaction", async () => {
    const query = vi.fn(async (sql: string, _params?: readonly unknown[]) => {
      if (sql.includes("SELECT EXISTS")) return { rows: [{ exists: false }] };
      if (sql.includes("INSERT INTO users")) return { rows: [{ id: "00000000-0000-7000-8000-000000000111" }] };
      if (sql.includes("UPDATE tenants") || sql.includes("UPDATE workspaces")) return { rows: [], rowCount: 1 };
      return { rows: [] };
    });
    const release = vi.fn();
    const pool = {
      connect: vi.fn(async () => ({ query, release })),
    } as unknown as Pool;
    const runtime = new RealBetterAuthRuntime(
      { handler: vi.fn() } as never,
      baseDescription(),
      pool,
      {
        BERRY_SETUP_OWNER_EMAIL: "owner@example.test",
        BERRY_SETUP_TOKEN: "setup-token-with-at-least-thirty-two-characters",
        BERRY_DEFAULT_ORG_MONTHLY_BUDGET_MICROS: "100000000",
        BERRY_DEFAULT_USER_MONTHLY_BUDGET_MICROS: "15000000",
      },
    );

    await expect(runtime.setupOwner({
      organizationName: "Acme",
      name: "Owner",
      email: "OWNER@example.test",
      password: "correct-horse-battery-staple",
      setupToken: "setup-token-with-at-least-thirty-two-characters",
    })).resolves.toMatchObject({
      ok: true,
      user: { id: "00000000-0000-7000-8000-000000000111", email: "owner@example.test" },
      organization: { name: "Acme" },
    });

    expect(query.mock.calls.some(([sql]) => sql.includes("pg_advisory_xact_lock"))).toBe(true);
    expect(query.mock.calls.find(([sql]) => sql.includes("INSERT INTO tenant_memberships"))?.[0]).toContain("'owner', 'setup'");
    expect(query.mock.calls.find(([sql]) => sql.includes("UPDATE workspaces"))?.[1]).toEqual([
      "00000000-0000-7000-8000-000000000001",
      "00000000-0000-7000-8000-000000000111",
      SELF_HOST_WORKSPACE_ID,
    ]);
    expect(query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    expect(release).toHaveBeenCalledOnce();
  });

  it("does not touch Postgres when the setup key is wrong", async () => {
    const pool = { connect: vi.fn() } as unknown as Pool;
    const runtime = new RealBetterAuthRuntime(
      { handler: vi.fn() } as never,
      baseDescription(),
      pool,
      {
        BERRY_SETUP_OWNER_EMAIL: "owner@example.test",
        BERRY_SETUP_TOKEN: "setup-token-with-at-least-thirty-two-characters",
      },
    );

    await expect(runtime.setupOwner({
      organizationName: "Acme",
      name: "Owner",
      email: "owner@example.test",
      password: "correct-horse-battery-staple",
      setupToken: "wrong",
    })).rejects.toMatchObject({ status: 403 });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("rolls back without creating a second owner when setup is replayed", async () => {
    const query = vi.fn(async (sql: string, _params?: readonly unknown[]) => {
      if (sql.includes("SELECT EXISTS")) return { rows: [{ exists: true }] };
      return { rows: [] };
    });
    const release = vi.fn();
    const pool = {
      connect: vi.fn(async () => ({ query, release })),
    } as unknown as Pool;
    const runtime = new RealBetterAuthRuntime(
      { handler: vi.fn() } as never,
      baseDescription(),
      pool,
      {
        BERRY_SETUP_OWNER_EMAIL: "owner@example.test",
        BERRY_SETUP_TOKEN: "setup-token-with-at-least-thirty-two-characters",
      },
    );

    await expect(runtime.setupOwner({
      organizationName: "Acme",
      name: "Second Owner",
      email: "owner@example.test",
      password: "another-correct-horse-battery-staple",
      setupToken: "setup-token-with-at-least-thirty-two-characters",
    })).rejects.toMatchObject({ status: 409 });

    expect(query.mock.calls.some(([sql]) => sql.includes("pg_advisory_xact_lock"))).toBe(true);
    expect(query.mock.calls.some(([sql]) => sql.includes("INSERT INTO users"))).toBe(false);
    expect(query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(release).toHaveBeenCalledOnce();
  });
});

function baseDescription(): BerryAuthDescription {
  return {
    basePath: "/v1/auth",
    emailPassword: { enabled: true, minPasswordLength: 8, maxPasswordLength: 128 },
    signupEnabled: false,
    setup: {
      required: true,
      available: true,
      ownerEmail: "owner@example.test",
      missingConfiguration: [],
    },
    socialProviders: [],
    storage: "postgres",
  };
}
