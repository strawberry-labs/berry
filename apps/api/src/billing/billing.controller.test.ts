import "reflect-metadata";
import { UnauthorizedException, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { SELF_HOST_TENANT_ID } from "@berry/db";
import type { SessionHost } from "@berry/local-agent";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BerryAuthRuntime } from "../auth/auth-runtime.ts";
import { FilePlatformService } from "../files/file-platform.service.ts";
import { AgentApiModule } from "../http/agent-api.module.ts";
import { InMemoryEnterpriseIdentityRepository } from "../identity/identity.repository.ts";
import { BillingService, InMemoryBillingRepository, NoopBillingProvider, StripeBillingProvider } from "./billing.service.ts";

describe("Billing API", () => {
  let app: INestApplication | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("keeps self-host billing optional while still recording prepaid grants and skipped meter events", async () => {
    app = await createApp(new BillingService({
      repository: new InMemoryBillingRepository(),
      provider: new NoopBillingProvider(),
      dependencyRequired: false,
    }));

    await request(app.getHttpServer())
      .get(`/v1/orgs/${SELF_HOST_TENANT_ID}/billing`)
      .set(authHeader())
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({ provider: "none", providerConfigured: true, billingDependencyRequired: false, prepaidBalanceMicros: "0" });
      });

    await request(app.getHttpServer())
      .post(`/v1/orgs/${SELF_HOST_TENANT_ID}/billing/credits`)
      .set(authHeader())
      .send({ source: "manual", amountMicros: "5000000000", externalRef: "manual-credit-1", reason: "Approved fixture credit", confirmation: true, idempotencyKey: "manual-credit-1", metadata: { note: "fixture credit pack" } })
      .expect(201)
      .expect(({ body }) => {
        expect(body).toMatchObject({ amountMicros: "5000000000", remainingMicros: "5000000000", source: "manual" });
      });
    await request(app.getHttpServer()).post(`/v1/orgs/${SELF_HOST_TENANT_ID}/billing/credits`).set(authHeader()).send({source:"manual",amountMicros:"100",reason:"Missing confirmation",idempotencyKey:"unsafe-key"}).expect(400);
    const repeated=await request(app.getHttpServer()).post(`/v1/orgs/${SELF_HOST_TENANT_ID}/billing/credits`).set(authHeader()).send({source:"manual",amountMicros:"999999",externalRef:"different",reason:"Repeated fixture credit",confirmation:true,idempotencyKey:"manual-credit-1",metadata:{}}).expect(201);
    expect(repeated.body.amountMicros).toBe("5000000000");
    await request(app.getHttpServer()).get(`/v1/orgs/${SELF_HOST_TENANT_ID}/billing/ledger`).set(authHeader()).expect(200).expect(({body})=>expect(body.items[0]).toMatchObject({kind:"grant",amountMicros:"5000000000"}));

    await request(app.getHttpServer())
      .post(`/v1/orgs/${SELF_HOST_TENANT_ID}/billing/meter-events`)
      .set(authHeader())
      .send({ requestId: "usage_req_self_host", meter: "model_tokens", quantity: "384", costBilledMicros: "1200000" })
      .expect(201)
      .expect(({ body }) => {
        expect(body).toMatchObject({ provider: "none", status: "skipped", requestId: "usage_req_self_host" });
      });

    await request(app.getHttpServer())
      .get(`/v1/orgs/${SELF_HOST_TENANT_ID}/billing`)
      .set(authHeader())
      .expect(200)
      .expect(({ body }) => {
        expect(body.prepaidBalanceMicros).toBe("5000000000");
        expect(body.recentMeterEvents[0]).toMatchObject({ status: "skipped" });
      });
  });

  it("reports managed-cloud meter events through a configured Stripe provider using idempotency", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ id: "mtr_evt_test_1" }), {
      headers: { "content-type": "application/json" },
    }));
    app = await createApp(new BillingService({
      repository: new InMemoryBillingRepository(),
      provider: new StripeBillingProvider({
        secretKey: "sk_test_fixture",
        meterEventName: "berry_model_tokens",
        apiBaseUrl: "https://stripe.example.test",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
      dependencyRequired: true,
    }));

    await request(app.getHttpServer())
      .post(`/v1/orgs/${SELF_HOST_TENANT_ID}/billing/meter-events`)
      .set(authHeader())
      .send({ requestId: "usage_req_stripe", meter: "model_tokens", quantity: "512", costBilledMicros: "1800000", metadata: { feature: "model.turn" } })
      .expect(201)
      .expect(({ body }) => {
        expect(body).toMatchObject({ provider: "stripe", status: "reported", externalEventId: "mtr_evt_test_1" });
      });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://stripe.example.test/v1/billing/meter_events",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer sk_test_fixture",
          "Idempotency-Key": `${SELF_HOST_TENANT_ID}:usage_req_stripe:model_tokens`,
        }),
      }),
    );
    const requestBody = fetchImpl.mock.calls[0]?.[1]?.body as URLSearchParams;
    expect(requestBody.get("event_name")).toBe("berry_model_tokens");
    expect(requestBody.get("payload[value]")).toBe("512");
  });
});

async function createApp(service: BillingService): Promise<INestApplication> {
  const identity = new InMemoryEnterpriseIdentityRepository();
  const moduleRef = await Test.createTestingModule({
    imports: [AgentApiModule.register({
      sessionHost: { useValue: fakeSessionHost() },
      auth: { useValue: fakeAuthRuntime() },
      identity: { repository: { useValue: identity } },
      billing: { service: { useValue: service } },
    })],
  })
    .overrideProvider(FilePlatformService)
    .useValue({})
    .compile();
  const nestApp = moduleRef.createNestApplication();
  await nestApp.init();
  return nestApp;
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
