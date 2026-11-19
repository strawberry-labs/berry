import { readFileSync } from "node:fs";
import { HttpException } from "@nestjs/common";
import { compareMobileVersions, parseMobilePairingUri, type MobilePairingDevice } from "@berry/shared";
import { describe, expect, it, vi } from "vitest";
import type { BerryAuthSession } from "../auth/auth-runtime.ts";
import { InMemoryMobileDeviceRegistry } from "../http/mobile-devices.ts";
import { MobilePairingService, mobilePairingConfigFromEnv, type MobilePairingConfig } from "./mobile-pairing.service.ts";
import { InMemoryMobilePairingStore } from "./mobile-pairing.store.ts";
import { InMemoryMobileRateLimiter } from "./mobile-rate-limiter.ts";

const TENANT_ID = "00000000-0000-7000-8000-000000000001";
const USER_ID = "00000000-0000-7000-8000-000000000201";
const device: MobilePairingDevice = { model: "iPhone 17 Pro", platform: "ios", osVersion: "26.1", appVersion: "1.0.0" };

function webSession(sessionId = "00000000-0000-7000-8000-00000000a001", userId = USER_ID): BerryAuthSession {
  return { session: { id: sessionId, userId, clientKind: "web" }, user: { id: userId, email: "member@example.test", name: "Member" } };
}

function setup(options: { mobileEnabled?: boolean; createMobileSession?: () => Promise<unknown>; apiUrl?: string } = {}) {
  let now = new Date("2026-10-09T10:00:00.000Z");
  const revoked: string[] = [];
  const store = new InMemoryMobilePairingStore();
  const devices = new InMemoryMobileDeviceRegistry(async (sessionId) => { revoked.push(sessionId); });
  const audit = { append: vi.fn(async () => ({})) };
  const policy = { mobileAppEnabled: options.mobileEnabled ?? true };
  const auth = {
    createMobileSession: vi.fn(options.createMobileSession ?? (async () => ({
      sessionId: "00000000-0000-7000-8000-00000000b001",
      token: "mobileSessionToken0123456789abcd",
      expiresAt: "2026-10-16T10:00:00.000Z",
      user: { id: USER_ID, email: "member@example.test", name: "Member", image: null },
    }))),
  };
  const config: MobilePairingConfig = {
    tenantId: TENANT_ID,
    serverUrl: "https://berry.acme.com",
    apiUrl: options.apiUrl ?? "https://berry.acme.com",
    serverVersion: "1.4.0",
    minimumAppVersion: "1.0.0",
    capabilities: ["mobile-pairing", "tasks"],
    ipHeaders: ["x-berry-client-ip"],
    loadBrand: async () => ({ applicationName: "Acme AI", logoUrl: "/v1/branding/logo?v=1", accentColor: "#7c6df2" }),
    now: () => now,
    sleep: async () => undefined,
    pollTimeoutMs: 0,
  };
  const service = new MobilePairingService(
    store,
    devices,
    new InMemoryMobileRateLimiter(() => now.getTime()),
    config,
    auth as never,
    { getAuthentication: async () => policy } as never,
    audit as never,
  );
  return {
    service,
    store,
    devices,
    auth,
    audit,
    policy,
    revoked,
    advance: (seconds: number) => { now = new Date(now.getTime() + seconds * 1000); },
  };
}

async function createAndClaim(ctx: ReturnType<typeof setup>, session = webSession()) {
  const created = await ctx.service.createPairing(session);
  const uri = parseMobilePairingUri(created.qrPayload)!;
  const claim = await ctx.service.claim({ pairingId: uri.pairingId, secret: uri.secret, device }, "203.0.113.4");
  return { created, uri, claim };
}

describe("mobile pairing", () => {
  it("pairs a phone after the browser approves it, issuing the session exactly once", async () => {
    const ctx = setup();
    const { created, uri, claim } = await createAndClaim(ctx);
    expect(uri).toMatchObject({ serverUrl: "https://berry.acme.com", pairingId: created.id });
    expect(created.manualCode).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(created).not.toHaveProperty("apiUrl");
    expect(claim.brand).toEqual({ applicationName: "Acme AI", logoUrl: "https://berry.acme.com/v1/branding/logo?v=1", accentColor: "#7c6df2" });

    await expect(ctx.service.poll({ pairingId: created.id, claimToken: claim.claimToken }, { ip: null, userAgent: null })).resolves.toEqual({ status: "awaiting" });
    const status = await ctx.service.getPairing(webSession(), created.id);
    expect(status).toMatchObject({ status: "claimed", device, claimedIp: "203.0.113.4" });

    await ctx.service.decide(webSession(), created.id, "approved");
    const approved = await ctx.service.poll({ pairingId: created.id, claimToken: claim.claimToken }, { ip: "203.0.113.4", userAgent: "BerryMobile/1.0" });
    expect(approved).toMatchObject({ status: "approved", sessionToken: "mobileSessionToken0123456789abcd", user: { id: USER_ID } });
    expect(ctx.auth.createMobileSession).toHaveBeenCalledWith({ userId: USER_ID, ipAddress: "203.0.113.4", userAgent: "BerryMobile/1.0" });

    // The token is never handed out twice.
    await expect(ctx.service.poll({ pairingId: created.id, claimToken: claim.claimToken }, { ip: null, userAgent: null })).resolves.toEqual({ status: "expired" });
    expect(ctx.auth.createMobileSession).toHaveBeenCalledTimes(1);

    const devices = await ctx.service.listDevices(webSession());
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ endpointMode: "paired", model: "iPhone 17 Pro", current: false });
    const actions = ctx.audit.append.mock.calls.map((call) => (call as unknown as [{ action: string }])[0].action);
    expect(actions).toEqual(["mobile.pairing.created", "mobile.pairing.approved", "mobile.device.paired"]);
  });

  it("names the API origin for typed codes when it differs from the web origin", async () => {
    const ctx = setup({ apiUrl: "https://api.berry.acme.com" });
    const created = await ctx.service.createPairing(webSession());
    expect(created).toMatchObject({ serverUrl: "https://berry.acme.com", apiUrl: "https://api.berry.acme.com" });
    expect(parseMobilePairingUri(created.qrPayload)).toMatchObject({ serverUrl: "https://berry.acme.com", apiUrl: "https://api.berry.acme.com" });
  });

  it("accepts the typed manual code in place of the QR secret", async () => {
    const ctx = setup();
    const created = await ctx.service.createPairing(webSession());
    const claim = await ctx.service.claim({ manualCode: created.manualCode.toLowerCase(), device }, null);
    expect(claim.pairingId).toBe(created.id);
  });

  it("rejects a reused secret, a wrong secret, and an expired code", async () => {
    const ctx = setup();
    const { uri } = await createAndClaim(ctx);
    await expect(ctx.service.claim({ pairingId: uri.pairingId, secret: uri.secret, device }, null)).rejects.toMatchObject({ status: 404 });

    const second = parseMobilePairingUri((await ctx.service.createPairing(webSession())).qrPayload)!;
    await expect(ctx.service.claim({ pairingId: second.pairingId, secret: `${second.secret.slice(0, -1)}${second.secret.endsWith("A") ? "B" : "A"}`, device }, null)).rejects.toMatchObject({ status: 404 });

    ctx.advance(121);
    await expect(ctx.service.claim({ pairingId: second.pairingId, secret: second.secret, device }, null)).rejects.toMatchObject({ status: 404 });
  });

  it("keeps only one live code per browser session", async () => {
    const ctx = setup();
    const first = parseMobilePairingUri((await ctx.service.createPairing(webSession())).qrPayload)!;
    await ctx.service.createPairing(webSession());
    await expect(ctx.service.claim({ pairingId: first.pairingId, secret: first.secret, device }, null)).rejects.toMatchObject({ status: 404 });
  });

  it("lets only the browser session that showed the code approve it", async () => {
    const ctx = setup();
    const { created } = await createAndClaim(ctx);
    const otherSession = webSession("00000000-0000-7000-8000-00000000a002");
    await expect(ctx.service.decide(otherSession, created.id, "approved")).rejects.toMatchObject({ status: 404 });
    await expect(ctx.service.getPairing(otherSession, created.id)).rejects.toMatchObject({ status: 404 });
  });

  it("tells the phone when the browser denies it", async () => {
    const ctx = setup();
    const { created, claim } = await createAndClaim(ctx);
    await ctx.service.decide(webSession(), created.id, "denied");
    await expect(ctx.service.poll({ pairingId: created.id, claimToken: claim.claimToken }, { ip: null, userAgent: null })).resolves.toEqual({ status: "denied" });
    expect(ctx.auth.createMobileSession).not.toHaveBeenCalled();
  });

  it("refuses polls with someone else's claim token", async () => {
    const ctx = setup();
    const { created } = await createAndClaim(ctx);
    await expect(ctx.service.poll({ pairingId: created.id, claimToken: "x".repeat(43) }, { ip: null, userAgent: null })).rejects.toMatchObject({ status: 404 });
  });

  it("does not let a phone pair further phones", async () => {
    const ctx = setup();
    const mobile = webSession();
    mobile.session.clientKind = "mobile";
    await expect(ctx.service.createPairing(mobile)).rejects.toMatchObject({ status: 403 });
  });

  it("honours the organization switch for the mobile app", async () => {
    const ctx = setup({ mobileEnabled: false });
    await expect(ctx.service.createPairing(webSession())).rejects.toMatchObject({ status: 403 });
    await expect(ctx.service.claim({ manualCode: "ABCD-EFGH", device }, null)).rejects.toMatchObject({ status: 403 });
    await expect(ctx.service.serverInfo()).resolves.toMatchObject({ mobileEnabled: false, brand: { applicationName: "Acme AI" } });
  });

  it("denies the phone when the member was deactivated before collecting", async () => {
    const ctx = setup({ createMobileSession: async () => { throw Object.assign(new Error("inactive"), { status: "FORBIDDEN" }); } });
    const { created, claim } = await createAndClaim(ctx);
    await ctx.service.decide(webSession(), created.id, "approved");
    await expect(ctx.service.poll({ pairingId: created.id, claimToken: claim.claimToken }, { ip: null, userAgent: null })).resolves.toEqual({ status: "denied" });
    expect(await ctx.service.listDevices(webSession())).toHaveLength(0);
  });

  it("rate-limits claim attempts per client address", async () => {
    const ctx = setup();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await expect(ctx.service.claim({ manualCode: "ZZZZ-ZZZZ", device }, "198.51.100.7")).rejects.toMatchObject({ status: 404 });
    }
    const limited = await ctx.service.claim({ manualCode: "ZZZZ-ZZZZ", device }, "198.51.100.7").catch((error: unknown) => error);
    expect(limited).toBeInstanceOf(HttpException);
    expect((limited as HttpException).getStatus()).toBe(429);
    ctx.advance(61);
    await expect(ctx.service.claim({ manualCode: "ZZZZ-ZZZZ", device }, "198.51.100.7")).rejects.toMatchObject({ status: 404 });
  });

  it("revokes a paired phone by deleting its session", async () => {
    const ctx = setup();
    const { created, claim } = await createAndClaim(ctx);
    await ctx.service.decide(webSession(), created.id, "approved");
    const approved = await ctx.service.poll({ pairingId: created.id, claimToken: claim.claimToken }, { ip: null, userAgent: null });
    expect(approved.status).toBe("approved");
    const deviceId = approved.status === "approved" ? approved.deviceId : "";
    await expect(ctx.service.revokeOwnDevice(webSession(), deviceId)).resolves.toBe(true);
    expect(ctx.revoked).toEqual(["00000000-0000-7000-8000-00000000b001"]);
    expect(await ctx.service.listDevices(webSession())).toHaveLength(0);
    await expect(ctx.service.revokeOwnDevice(webSession(), deviceId)).resolves.toBe(false);
  });

  it("lets the phone sign itself out", async () => {
    const ctx = setup();
    const { created, claim } = await createAndClaim(ctx);
    await ctx.service.decide(webSession(), created.id, "approved");
    await ctx.service.poll({ pairingId: created.id, claimToken: claim.claimToken }, { ip: null, userAgent: null });
    const mobile: BerryAuthSession = { session: { id: "00000000-0000-7000-8000-00000000b001", userId: USER_ID, clientKind: "mobile" }, user: { id: USER_ID, email: "member@example.test" } };
    await ctx.service.signOutCurrentDevice(mobile);
    expect(ctx.revoked).toEqual(["00000000-0000-7000-8000-00000000b001"]);
    await expect(ctx.service.signOutCurrentDevice(webSession())).rejects.toMatchObject({ status: 403 });
  });

  it("accepts the first app release unless the operator raises the minimum", () => {
    const appPackage = JSON.parse(readFileSync(new URL("../../../mobile/package.json", import.meta.url), "utf8")) as { version: string };
    expect(compareMobileVersions(appPackage.version, mobilePairingConfigFromEnv({}).minimumAppVersion)).toBeGreaterThanOrEqual(0);
    expect(mobilePairingConfigFromEnv({ BERRY_MOBILE_MINIMUM_APP_VERSION: "2.0.0" }).minimumAppVersion).toBe("2.0.0");
  });
});
