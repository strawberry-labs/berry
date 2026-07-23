import "reflect-metadata";
import { UnauthorizedException, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { SELF_HOST_TENANT_ID } from "@berry/db";
import type { SessionHost } from "@berry/local-agent";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import type { BerryAuthRuntime } from "../auth/auth-runtime.ts";
import { FilePlatformService } from "../files/file-platform.service.ts";
import { AgentApiModule } from "../http/agent-api.module.ts";
import { InMemoryEnterpriseIdentityRepository } from "../identity/identity.repository.ts";
import { InMemoryUsageRepository } from "./usage.repository.ts";
import { HmacUsageEventVerifier, signCloudUsageEventForTest } from "./usage.signing.ts";

const SIGNED_AT = "2026-07-10T00:00:00.000Z";
const SIGNING_SECRET = "berry-usage-fixture-secret";

describe("Usage API", () => {
  let app: INestApplication | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("rejects unsigned or tampered usage events before they reach the append-only store", async () => {
    app = await createApp();
    const event = usageIngest();

    await request(app.getHttpServer())
      .post(`/v1/orgs/${SELF_HOST_TENANT_ID}/usage/events`)
      .set(authHeader())
      .send({ ...event, signature: { ...event.signature, signature: "tampered" } })
      .expect(401);

    await request(app.getHttpServer())
      .get(`/v1/orgs/${SELF_HOST_TENANT_ID}/usage/events`)
      .set(authHeader())
      .expect(200)
      .expect(({ body }) => {
        expect(body).toHaveLength(0);
      });
  });

  it("ingests signed Router and sandbox usage idempotently and exposes dashboard drill-down plus CSV export", async () => {
    app = await createApp();
    const routerEvent = usageIngest();
    const sandboxEvent = usageIngest({
      source: "sandbox",
      requestId: "usage_sandbox_1",
      feature: "sandbox.exec",
      provider: "berry-box",
      model: null,
      tokensIn: 0,
      tokensOut: 0,
      costRawMicros: "250",
      costBilledMicros: "300",
    });

    const first = await request(app.getHttpServer())
      .post(`/v1/orgs/${SELF_HOST_TENANT_ID}/usage/events`)
      .set(authHeader())
      .send(routerEvent)
      .expect(201);
    const repeat = await request(app.getHttpServer())
      .post(`/v1/orgs/${SELF_HOST_TENANT_ID}/usage/events`)
      .set(authHeader())
      .send(routerEvent)
      .expect(201);
    expect(repeat.body.id).toBe(first.body.id);

    await request(app.getHttpServer())
      .post(`/v1/orgs/${SELF_HOST_TENANT_ID}/usage/events`)
      .set(authHeader())
      .send(sandboxEvent)
      .expect(201);

    await request(app.getHttpServer())
      .get(`/v1/orgs/${SELF_HOST_TENANT_ID}/usage/events?feature=model.turn`)
      .set(authHeader())
      .expect(200)
      .expect(({ body }) => {
        expect(body).toHaveLength(1);
        expect(body[0]).toMatchObject({ source: "router", requestId: "usage_router_1", departmentId: "dept_self_host_default" });
        expect(body[0].metadata).toEqual({});
        expect(body[0].signedPayload).toEqual({});
        expect(body[0].signature).toBeNull();
      });

    await request(app.getHttpServer())
      .get(`/v1/orgs/${SELF_HOST_TENANT_ID}/usage/dashboard`)
      .set(authHeader())
      .expect(200)
      .expect(({ body }) => {
        expect(body.totals).toMatchObject({ requests: 2, tokensIn: 128, tokensOut: 256, costBilledMicros: "1800" });
        expect(body.byFeature.map((entry: { feature: string }) => entry.feature)).toEqual(["model.turn", "sandbox.exec"]);
        expect(body.byModel[0]).toMatchObject({ model: "berry/auto", tokens: 384 });
        expect(body.byDepartment[0]).toMatchObject({ departmentId: "dept_self_host_default" });
        expect(body.burnDown[0]).toMatchObject({ date: "2026-07-10", requests: 2 });
      });

    await request(app.getHttpServer())
      .get(`/v1/orgs/${SELF_HOST_TENANT_ID}/usage/rollups`)
      .set(authHeader())
      .expect(200)
      .expect(({ body }) => {
        expect(body).toHaveLength(2);
      });

    await request(app.getHttpServer())
      .get(`/v1/orgs/${SELF_HOST_TENANT_ID}/usage/export.csv`)
      .set(authHeader())
      .expect(200)
      .expect((response) => {
        expect(response.text).toContain("usage_router_1");
        expect(response.text).toContain("sandbox.exec");
      });
  });

  it("filters analytics, explains anomalies, paginates redacted requests, and keeps /me self-only", async () => {
    app = await createApp();
    const base = Date.parse("2026-07-10T00:00:00.000Z");
    for (let index = 0; index < 6; index += 1) {
      await request(app.getHttpServer())
        .post(`/v1/orgs/${SELF_HOST_TENANT_ID}/usage/events`)
        .set(authHeader())
        .send(usageIngest({
          requestId: `sensitive-request-${index}`,
          agentId: "agent-review",
          workspaceId: "00000000-0000-7000-8000-000000000301",
          costBilledMicros: index === 5 ? "10000" : "100",
          latencyMs: index === 5 ? 2000 : 100,
          ts: new Date(base + index * 3_600_000).toISOString(),
          metadata: { region: "us-east", credential: "must-not-leak", reservationId: "reservation-secret" },
        }))
        .expect(201);
    }
    await request(app.getHttpServer())
      .get(`/v1/orgs/${SELF_HOST_TENANT_ID}/usage/analytics?from=2026-07-10T00%3A00%3A00.000Z&to=2026-07-11T00%3A00%3A00.000Z&agentId=agent-review`)
      .set(authHeader())
      .expect(200)
      .expect(({ body }) => {
        expect(body.totals).toMatchObject({ requests: 6, billedCostMicros: "10500" });
        expect(body.totals.projectedMonthEndMicros).toBeTruthy();
        expect(body.breakdowns.agents[0]).toMatchObject({ id: "agent-review", requests: 6 });
        expect(body.anomalies.some((entry: { explanation: string }) => entry.explanation.includes("baseline"))).toBe(true);
      });

    const firstPage = await request(app.getHttpServer())
      .get(`/v1/orgs/${SELF_HOST_TENANT_ID}/usage/requests?from=2026-07-10T00%3A00%3A00.000Z&to=2026-07-11T00%3A00%3A00.000Z&limit=2`)
      .set(authHeader()).expect(200);
    expect(firstPage.body).toMatchObject({ hasMore: true });
    expect(firstPage.body.items).toHaveLength(2);
    expect(firstPage.body.items[0].requestId).not.toContain("sensitive-request");
    const detail = await request(app.getHttpServer())
      .get(`/v1/orgs/${SELF_HOST_TENANT_ID}/usage/requests/${firstPage.body.items[0].id}`)
      .set(authHeader()).expect(200);
    expect(detail.body.safeMetadata).toEqual({ region: "us-east" });
    expect(JSON.stringify(detail.body)).not.toContain("credential");
    const secondPage = await request(app.getHttpServer())
      .get(`/v1/orgs/${SELF_HOST_TENANT_ID}/usage/requests?from=2026-07-10T00%3A00%3A00.000Z&to=2026-07-11T00%3A00%3A00.000Z&limit=2&cursor=${encodeURIComponent(firstPage.body.nextCursor)}`)
      .set(authHeader()).expect(200);
    expect(secondPage.body.items[0].id).not.toBe(firstPage.body.items[0].id);

    await request(app.getHttpServer())
      .get(`/v1/orgs/${SELF_HOST_TENANT_ID}/usage/me?from=2026-07-10T00%3A00%3A00.000Z&to=2026-07-11T00%3A00%3A00.000Z&memberId=another-user`)
      .set(authHeader()).expect(200)
      .expect(({ body }) => expect(body.totals.requests).toBe(6));

    await request(app.getHttpServer())
      .get(`/v1/orgs/${SELF_HOST_TENANT_ID}/usage/me/export.csv?from=2026-07-10T00%3A00%3A00.000Z&to=2026-07-11T00%3A00%3A00.000Z&userId=another-user`)
      .set(authHeader()).expect(200)
      .expect((response) => {
        expect(response.text).toContain("sensitive-request-0");
        expect(response.text).not.toContain("another-user");
      });
  });

  it("returns an empty analytic window and denies cross-tenant access", async () => {
    app = await createApp();
    await request(app.getHttpServer())
      .get(`/v1/orgs/${SELF_HOST_TENANT_ID}/usage/analytics?from=2026-06-01T00%3A00%3A00.000Z&to=2026-06-02T00%3A00%3A00.000Z`)
      .set(authHeader()).expect(200)
      .expect(({ body }) => expect(body.totals).toMatchObject({ requests: 0, billedCostMicros: "0", projectedMonthEndMicros: null }));
    await request(app.getHttpServer())
      .get("/v1/orgs/00000000-0000-7000-8000-000000009999/usage/analytics")
      .set(authHeader()).expect(403);
  });
});

async function createApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AgentApiModule.register({
      sessionHost: { useValue: fakeSessionHost() },
      auth: { useValue: fakeAuthRuntime() },
      identity: { repository: { useValue: new InMemoryEnterpriseIdentityRepository() } },
      usage: {
        repository: { useValue: new InMemoryUsageRepository() },
        verifier: {
          useValue: new HmacUsageEventVerifier({
            secrets: new Map([["fixture", SIGNING_SECRET]]),
            now: () => new Date(SIGNED_AT),
          }),
        },
      },
    })],
  })
    .overrideProvider(FilePlatformService)
    .useValue({})
    .compile();
  const nestApp = moduleRef.createNestApplication();
  await nestApp.init();
  return nestApp;
}

function usageIngest(overrides: Partial<{
  source: "router" | "sandbox" | "fixture";
  requestId: string;
  feature: string;
  provider: string | null;
  model: string | null;
  tokensIn: number;
  tokensOut: number;
  costRawMicros: string;
  costBilledMicros: string;
  workspaceId: string;
  agentId: string;
  latencyMs: number;
  ts: string;
  metadata: Record<string, unknown>;
}> = {}) {
  const event = {
    source: overrides.source ?? "router",
    request_id: overrides.requestId ?? "usage_router_1",
    provider: overrides.provider ?? "router",
    model: overrides.model ?? "berry/auto",
    feature: overrides.feature ?? "model.turn",
    cost_billed_micros: overrides.costBilledMicros ?? "1500",
  };
  return {
    source: overrides.source ?? "router",
    event,
    signature: signCloudUsageEventForTest({ event, keyId: "fixture", secret: SIGNING_SECRET, signedAt: SIGNED_AT }),
    normalized: {
      requestId: overrides.requestId ?? "usage_router_1",
      userId: "00000000-0000-7000-8000-000000000201",
      departmentId: "dept_self_host_default",
      workspaceId: overrides.workspaceId ?? null,
      agentId: overrides.agentId ?? null,
      feature: overrides.feature ?? "model.turn",
      provider: overrides.provider ?? "router",
      model: overrides.model ?? "berry/auto",
      tokensIn: overrides.tokensIn ?? 128,
      tokensOut: overrides.tokensOut ?? 256,
      tokensCached: 0,
      sandboxUsage: overrides.source === "sandbox" ? { cpu_ms: 120, network_bytes: 4096 } : {},
      costRawMicros: overrides.costRawMicros ?? "1200",
      costBilledMicros: overrides.costBilledMicros ?? "1500",
      latencyMs: overrides.latencyMs ?? 480,
      ttftMs: 120,
      status: "completed",
      metadata: overrides.metadata ?? { fixture: true },
      ts: overrides.ts ?? SIGNED_AT,
    },
  };
}

function authHeader() {
  return { Authorization: "Bearer berry-test-session" };
}

function fakeAuthRuntime(): BerryAuthRuntime {
  const getSession: BerryAuthRuntime["getSession"] = async (headers) => {
    if (headers.authorization !== "Bearer berry-test-session") return null;
    return {
      session: { id: "auth_session_1", userId: "00000000-0000-7000-8000-000000000201" },
      user: { id: "00000000-0000-7000-8000-000000000201", email: "test@example.test", name: "Test User", emailVerified: true },
    };
  };
  return {
    describe: () => ({
      basePath: "/v1/auth",
      emailPassword: { enabled: true, minPasswordLength: 8, maxPasswordLength: 128 },
      socialProviders: [],
      storage: "memory",
    }),
    getSession,
    requireSession: async (headers) => {
      const session = await getSession(headers);
      if (!session) throw new UnauthorizedException("Authentication required");
      return session;
    },
    handleNodeRequest: async (_req, res) => {
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true }));
    },
  };
}

function fakeSessionHost(): SessionHost {
  return {
    startTurn: () => ({ turnId: "turn_default" }),
    resolveQuestion: () => true,
    resolveApproval: () => true,
    recordApprovalGrant: () => {},
    pendingApprovalIds: () => [],
    pendingQuestionIds: () => [],
    cancel: async () => true,
    turnState: () => ({ active: false, turnId: null, bufferedEvents: [] }),
    contextStats: async () => ({ usedTokens: 0, source: "unknown" }),
    steer: async () => ({ queued: true }),
    followUp: async () => ({ queued: true }),
    fork: async () => ({ sessionId: "session_fork" }),
    rewind: async () => {},
    rewindForEdit: async () => {},
    compact: async () => ({ summary: "summary", tokensBefore: 1 }),
    listLoadedSkills: () => [],
    dispose: async () => {},
  } as SessionHost;
}
