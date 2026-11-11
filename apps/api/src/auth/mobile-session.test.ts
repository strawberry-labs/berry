import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { makeSignature } from "better-auth/crypto";
import { describe, expect, it } from "vitest";
import { createBetterAuthOptions, RealBetterAuthRuntime } from "./auth-runtime.ts";

async function createRuntime() {
  const { authOptions, description } = createBetterAuthOptions({
    env: { NODE_ENV: "test", BERRY_AUTH_BASE_URL: "http://localhost:3000" },
  });
  const auth = betterAuth({
    ...authOptions,
    database: memoryAdapter({ users: [], auth_sessions: [], auth_accounts: [], auth_verifications: [] }),
  });
  const runtime = new RealBetterAuthRuntime(auth as never, description);
  const signUp = await auth.api.signUpEmail({
    body: { email: "member@example.test", password: "correct-horse-battery", name: "Member" },
    returnHeaders: true,
  });
  const cookie = signUp.headers.get("set-cookie")?.split(";")[0] ?? "";
  return { auth, runtime, userId: signUp.response.user.id, webToken: signUp.response.token ?? "", webCookie: cookie };
}

describe("mobile companion sessions", () => {
  it("accepts a minted mobile session as a bearer token", async () => {
    const { runtime, userId } = await createRuntime();
    const grant = await runtime.createMobileSession({ userId, ipAddress: "203.0.113.4", userAgent: "BerryMobile/1.0" });
    expect(grant.token).toMatch(/^[A-Za-z0-9]{16,}$/);
    expect(grant.user).toMatchObject({ id: userId, email: "member@example.test" });

    const session = await runtime.getSession({ authorization: `Bearer ${grant.token}` });
    expect(session?.user.id).toBe(userId);
    expect(session?.session).toMatchObject({ id: grant.sessionId, clientKind: "mobile" });
  });

  it("keeps browser sessions on cookies only", async () => {
    const { runtime, webToken, webCookie } = await createRuntime();
    const viaCookie = await runtime.getSession({ cookie: webCookie });
    expect(viaCookie?.session.clientKind).toBe("web");
    expect(await runtime.getSession({ authorization: `Bearer ${webToken}` })).toBeNull();
  });

  it("refuses a mobile token presented as a signed cookie", async () => {
    const { auth, runtime, userId } = await createRuntime();
    const grant = await runtime.createMobileSession({ userId, ipAddress: null, userAgent: null });
    const context = await auth.$context;
    const signature = await makeSignature(grant.token, context.secret);
    const cookie = `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${grant.token}.${signature}`)}`;
    expect(await runtime.getSession({ cookie })).toBeNull();
  });

  it("ignores browser cookies sent alongside a bearer token", async () => {
    const { runtime, webCookie } = await createRuntime();
    expect(await runtime.getSession({ authorization: "Bearer not-a-real-session-token-value", cookie: webCookie })).toBeNull();
  });

  it("rejects malformed authorization headers instead of falling back to cookies", async () => {
    const { runtime, webCookie } = await createRuntime();
    for (const authorization of ["Bearer", "Basic abc", "Bearer a.b", "Bearer short", `Bearer ${"x".repeat(200)}`]) {
      expect(await runtime.getSession({ authorization, cookie: webCookie })).toBeNull();
    }
  });

  it("stops accepting a mobile token once its session is revoked", async () => {
    const { auth, runtime, userId } = await createRuntime();
    const grant = await runtime.createMobileSession({ userId, ipAddress: null, userAgent: null });
    await (await auth.$context).internalAdapter.deleteSession(grant.token);
    expect(await runtime.getSession({ authorization: `Bearer ${grant.token}` })).toBeNull();
  });
});
