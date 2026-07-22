import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createBetterAuthOptions } from "./auth-runtime.ts";

describe("Better Auth runtime config", () => {
  it("enables email/password and maps Better Auth storage onto cloud tables", () => {
    const { authOptions, description } = createBetterAuthOptions({ env: { NODE_ENV: "test", BERRY_AUTH_BASE_URL: "https://berry.example.test" } });

    expect(description).toEqual({
      basePath: "/v1/auth",
      emailPassword: { enabled: true, minPasswordLength: 8, maxPasswordLength: 128 },
      signupEnabled: true,
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

  it("replaces the zero-value seed budget for the first owner", async () => {
    const query = vi.fn(async (sql: string) => sql.includes("role = 'owner'")
      ? { rows: [{ count: "0" }] }
      : { rows: [] });
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
    expect(membershipSql).toContain("'manual'");
    expect(membershipSql).not.toContain("'signup'");
    expect(orgBudgetSql).toContain("DO UPDATE SET");
    expect(orgBudgetSql).toContain("hard_limit_micros = EXCLUDED.hard_limit_micros");
  });
});
