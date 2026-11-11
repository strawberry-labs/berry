import "reflect-metadata";
import { Module, UnauthorizedException, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { parseMobilePairingUri } from "@berry/shared";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { BerryAuthModule } from "../auth/auth.module.ts";
import type { BerryAuthRuntime, BerryAuthSession } from "../auth/auth-runtime.ts";
import { InMemoryMobileDeviceRegistry, MOBILE_DEVICE_REGISTRY } from "../http/mobile-devices.ts";
import { ENTERPRISE_IDENTITY_REPOSITORY } from "../identity/identity.repository.ts";
import { MobileController, MobileDeviceAdminController } from "./mobile.controller.ts";
import { MOBILE_PAIRING_CONFIG, MobilePairingService, type MobilePairingConfig } from "./mobile-pairing.service.ts";
import { InMemoryMobilePairingStore, MOBILE_PAIRING_STORE } from "./mobile-pairing.store.ts";
import { InMemoryMobileRateLimiter, MOBILE_RATE_LIMITER } from "./mobile-rate-limiter.ts";

const TENANT_ID = "00000000-0000-7000-8000-000000000001";
const USER_ID = "00000000-0000-7000-8000-000000000201";
const device = { model: "Pixel 8a", platform: "android", osVersion: "16", appVersion: "1.0.0" };

/** Stands in for Better Auth: one browser cookie, and bearer tokens it minted. */
function fakeRuntime(): BerryAuthRuntime {
  const mobileTokens = new Map<string, string>();
  const user = { id: USER_ID, email: "member@example.test", name: "Member" };
  return {
    describe: () => ({ basePath: "/v1/auth", emailPassword: { enabled: true, minPasswordLength: 8, maxPasswordLength: 128 }, socialProviders: [], storage: "memory" }),
    async getSession(headers): Promise<BerryAuthSession | null> {
      const bearer = /^Bearer (.+)$/.exec(headers.authorization ?? "")?.[1];
      if (bearer) {
        const sessionId = mobileTokens.get(bearer);
        return sessionId ? { session: { id: sessionId, userId: USER_ID, clientKind: "mobile" }, user } : null;
      }
      return headers.cookie === "session=web" ? { session: { id: "00000000-0000-7000-8000-00000000a001", userId: USER_ID, clientKind: "web" }, user } : null;
    },
    async requireSession(headers) {
      const session = await this.getSession(headers);
      if (!session) throw new UnauthorizedException("Authentication required");
      return session;
    },
    async createMobileSession() {
      const token = `mobileToken${mobileTokens.size}abcdefghijklmnop`;
      const sessionId = `00000000-0000-7000-8000-00000000b00${mobileTokens.size}`;
      mobileTokens.set(token, sessionId);
      return { sessionId, token, expiresAt: "2026-10-16T10:00:00.000Z", user: { ...user, image: null } };
    },
    handleNodeRequest: async () => undefined,
  };
}

let app: INestApplication | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

async function createApp(): Promise<INestApplication> {
  const config: MobilePairingConfig = {
    tenantId: TENANT_ID,
    serverUrl: "https://berry.acme.com",
    apiUrl: "https://berry.acme.com",
    serverVersion: "1.4.0",
    minimumAppVersion: "1.0.0",
    capabilities: ["mobile-pairing"],
    ipHeaders: ["x-berry-client-ip"],
    loadBrand: async () => ({ applicationName: "Acme AI", logoUrl: null, accentColor: null }),
    pollTimeoutMs: 0,
  };
  @Module({
    imports: [BerryAuthModule.register({ runtime: { useValue: fakeRuntime() } })],
    controllers: [MobileController, MobileDeviceAdminController],
    providers: [
      MobilePairingService,
      { provide: MOBILE_PAIRING_STORE, useValue: new InMemoryMobilePairingStore() },
      { provide: MOBILE_DEVICE_REGISTRY, useValue: new InMemoryMobileDeviceRegistry() },
      { provide: MOBILE_RATE_LIMITER, useValue: new InMemoryMobileRateLimiter() },
      { provide: MOBILE_PAIRING_CONFIG, useValue: config },
      { provide: ENTERPRISE_IDENTITY_REPOSITORY, useValue: { authorize: async (_user: string, _tenant: string, permission: string) => permission === "members:read" } },
    ],
  })
  class TestModule {}
  const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile();
  const nest = moduleRef.createNestApplication();
  await nest.init();
  return nest;
}

describe("mobile pairing HTTP API", () => {
  it("exposes server info without a session", async () => {
    app = await createApp();
    const response = await request(app.getHttpServer()).get("/v1/mobile/server-info").expect(200);
    expect(response.body).toMatchObject({ protocolVersion: 1, mobileEnabled: true, serverUrl: "https://berry.acme.com", brand: { applicationName: "Acme AI" } });
  });

  it("requires a signed-in browser to create a code", async () => {
    app = await createApp();
    await request(app.getHttpServer()).post("/v1/mobile/pairings").expect(401);
  });

  it("pairs a phone end to end and lets it call the API with its bearer token", async () => {
    app = await createApp();
    const server = app.getHttpServer();
    const created = await request(server).post("/v1/mobile/pairings").set("cookie", "session=web").expect(201);
    const uri = parseMobilePairingUri(created.body.qrPayload)!;

    const claim = await request(server).post("/v1/mobile/pairings/claim").set("x-berry-client-ip", "203.0.113.4")
      .send({ pairingId: uri.pairingId, secret: uri.secret, device }).expect(200);
    await request(server).post("/v1/mobile/pairings/poll").send({ pairingId: uri.pairingId, claimToken: claim.body.claimToken })
      .expect(200, { status: "awaiting" });

    const status = await request(server).get(`/v1/mobile/pairings/${uri.pairingId}`).set("cookie", "session=web").expect(200);
    expect(status.body).toMatchObject({ status: "claimed", device, claimedIp: "203.0.113.4" });
    await request(server).post(`/v1/mobile/pairings/${uri.pairingId}/approve`).set("cookie", "session=web").expect(200);

    const approved = await request(server).post("/v1/mobile/pairings/poll").send({ pairingId: uri.pairingId, claimToken: claim.body.claimToken }).expect(200);
    expect(approved.body).toMatchObject({ status: "approved", user: { id: USER_ID } });

    const devices = await request(server).get("/v1/mobile/devices").set("authorization", `Bearer ${approved.body.sessionToken}`).expect(200);
    expect(devices.body).toEqual([expect.objectContaining({ model: "Pixel 8a", current: true })]);
    const fromBrowser = await request(server).get("/v1/mobile/devices").set("cookie", "session=web").expect(200);
    expect(fromBrowser.body[0].current).toBe(false);

    // A phone cannot mint codes for more phones.
    await request(server).post("/v1/mobile/pairings").set("authorization", `Bearer ${approved.body.sessionToken}`).expect(403);
    await request(server).delete("/v1/mobile/session").set("authorization", `Bearer ${approved.body.sessionToken}`).expect(200);
    await request(server).get("/v1/mobile/devices").set("cookie", "session=web").expect(200, []);
  });

  it("validates identifiers and bodies before touching storage", async () => {
    app = await createApp();
    const server = app.getHttpServer();
    await request(server).get("/v1/mobile/pairings/not-a-uuid").set("cookie", "session=web").expect(400);
    await request(server).post("/v1/mobile/pairings/claim").send({ pairingId: "x" }).expect(400);
    await request(server).post("/v1/mobile/pairings/claim").send({ manualCode: "ZZZZ-ZZZZ", device }).expect(404);
  });

  it("checks organization permissions on member device routes", async () => {
    app = await createApp();
    const server = app.getHttpServer();
    await request(server).get(`/v1/orgs/${TENANT_ID}/members/${USER_ID}/mobile-devices`).set("cookie", "session=web").expect(200, []);
    await request(server).delete(`/v1/orgs/${TENANT_ID}/members/${USER_ID}/mobile-devices/device`).set("cookie", "session=web").expect(403);
    await request(server).get(`/v1/orgs/00000000-0000-7000-8000-000000000999/members/${USER_ID}/mobile-devices`).set("cookie", "session=web").expect(404);
  });
});
