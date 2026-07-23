import type { Pool } from "pg";
import { SELF_HOST_WORKSPACE_ID } from "@berry/db";
import { describe, expect, it, vi } from "vitest";
import { createBetterAuthOptions, RealBetterAuthRuntime, type BerryAuthDescription } from "./auth-runtime.ts";

describe("Better Auth runtime config", () => {
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
      storage: "memory",
    });
    expect(authOptions.basePath).toBe("/v1/auth");
    expect(authOptions.baseURL).toBe("https://berry.example.test");
    expect(authOptions.emailAndPassword).toMatchObject({ enabled: true, minPasswordLength: 8, maxPasswordLength: 128 });
    expect(authOptions.user).toMatchObject({ modelName: "users", fields: { emailVerified: "email_verified", image: "avatar_url" } });
    expect(authOptions.session).toMatchObject({ modelName: "auth_sessions", fields: { userId: "user_id", expiresAt: "expires_at" } });
    expect(authOptions.account).toMatchObject({ modelName: "auth_accounts", encryptOAuthTokens: true });
    expect(authOptions.verification).toMatchObject({ modelName: "auth_verifications" });
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
    expect(membershipSql).toContain("'signup'");
    expect(query.mock.calls.some(([sql]) => sql.includes("UPDATE workspaces"))).toBe(false);
    expect(orgBudgetSql).toContain("DO NOTHING");
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
