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
import { InMemoryModelGovernanceRepository, ModelGovernanceService } from "./model-governance.service.ts";

describe("Model governance API", () => {
  let app: INestApplication | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("filters allowed models through /models and resolves enforced per-mode defaults", async () => {
    app = await createApp();

    await request(app.getHttpServer())
      .put(`/v1/orgs/${SELF_HOST_TENANT_ID}/models/policies`)
      .set(authHeader())
      .send({
        providerId: "router",
        model: "gpt-5",
        displayName: "GPT-5",
        presetId: "berry-router",
        apiType: "openai-responses",
        capabilities: { tools: true, reasoning: true },
        status: "allowed",
        enforce: true,
        modeAllow: ["code"],
        metadata: { tier: "enterprise" },
      })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({ model: "gpt-5", enforce: true, modeAllow: ["code"] });
      });

    await request(app.getHttpServer())
      .put(`/v1/orgs/${SELF_HOST_TENANT_ID}/models/defaults/code`)
      .set(authHeader())
      .send({ providerId: "router", model: "gpt-5", enforce: true })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({ mode: "code", providerId: "router", model: "gpt-5", enforce: true });
      });

    await request(app.getHttpServer())
      .get(`/v1/orgs/${SELF_HOST_TENANT_ID}/models?mode=code`)
      .set(authHeader())
      .expect(200)
      .expect(({ body }) => {
        expect(body.map((entry: { model: string }) => entry.model)).toContain("gpt-5");
      });

    await request(app.getHttpServer())
      .post(`/v1/orgs/${SELF_HOST_TENANT_ID}/models/resolve`)
      .set(authHeader())
      .send({ mode: "code", providerId: "router", model: "gpt-5" })
      .expect(201)
      .expect(({ body }) => {
        expect(body).toMatchObject({ allowed: true, enforced: true, reason: "allowed_by_policy" });
      });

    await request(app.getHttpServer())
      .post(`/v1/orgs/${SELF_HOST_TENANT_ID}/models/resolve`)
      .set(authHeader())
      .send({ mode: "code", providerId: "router", model: "claude-opus" })
      .expect(201)
      .expect(({ body }) => {
        expect(body).toMatchObject({ allowed: false, reason: "mode_default_enforced" });
      });
  });

  it("rejects legacy Co-work values on active model-governance routes", async () => {
    app = await createApp();

    await request(app.getHttpServer())
      .put(`/v1/orgs/${SELF_HOST_TENANT_ID}/models/policies`)
      .set(authHeader())
      .send({ providerId: "router", model: "legacy", modeAllow: ["cowork"] })
      .expect(400);

    await request(app.getHttpServer())
      .put(`/v1/orgs/${SELF_HOST_TENANT_ID}/models/defaults/cowork`)
      .set(authHeader())
      .send({ providerId: "router", model: "legacy" })
      .expect(400);
  });

  it("keeps blocked models out of the default list unless requested by an admin", async () => {
    app = await createApp();

    await request(app.getHttpServer())
      .put(`/v1/orgs/${SELF_HOST_TENANT_ID}/models/policies`)
      .set(authHeader())
      .send({ providerId: "router", model: "legacy-risky", status: "blocked", enforce: true, modeAllow: ["chat"] })
      .expect(200);

    await request(app.getHttpServer())
      .get(`/v1/orgs/${SELF_HOST_TENANT_ID}/models`)
      .set(authHeader())
      .expect(200)
      .expect(({ body }) => {
        expect(body.some((entry: { model: string }) => entry.model === "legacy-risky")).toBe(false);
      });
    await request(app.getHttpServer())
      .get(`/v1/orgs/${SELF_HOST_TENANT_ID}/models?includeBlocked=true`)
      .set(authHeader())
      .expect(200)
      .expect(({ body }) => {
        expect(body.some((entry: { model: string }) => entry.model === "legacy-risky")).toBe(true);
      });
  });
});

async function createApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AgentApiModule.register({
      sessionHost: { useValue: fakeSessionHost() },
      auth: { useValue: fakeAuthRuntime() },
      identity: { repository: { useValue: new InMemoryEnterpriseIdentityRepository() } },
      modelGovernance: { service: { useValue: new ModelGovernanceService(new InMemoryModelGovernanceRepository()) } },
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
