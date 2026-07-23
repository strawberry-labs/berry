import "reflect-metadata";
import { UnauthorizedException, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { SELF_HOST_TENANT_ID } from "@berry/db";
import type { SessionHost } from "@berry/local-agent";
import type { CloudAuditExportConfig, CloudAuditEvent } from "@berry/shared";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BerryAuthRuntime } from "../auth/auth-runtime.ts";
import { FilePlatformService } from "../files/file-platform.service.ts";
import { AgentApiModule } from "../http/agent-api.module.ts";
import { InMemoryEnterpriseIdentityRepository } from "../identity/identity.repository.ts";
import { AuditService, InMemoryAuditRepository, type AuditExportDispatcher } from "./audit.service.ts";

describe("Audit API", () => {
  let app: INestApplication | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("keeps client audit ingestion disabled until policy enables it", async () => {
    app = await createApp();

    await request(app.getHttpServer())
      .post(`/v1/orgs/${SELF_HOST_TENANT_ID}/audit/events`)
      .set(authHeader())
      .send(clientAuditIngest())
      .expect(403)
      .expect(({ body }) => {
        expect(body.message).toBe("Client audit ingestion is disabled by organization policy");
      });

    await request(app.getHttpServer())
      .get(`/v1/orgs/${SELF_HOST_TENANT_ID}/audit/events`)
      .set(authHeader())
      .expect(200)
      .expect(({ body }) => {
        expect(body).toHaveLength(0);
      });
  });

  it("ingests client audit events with retention and secret scrubbing, then exports to a fixture SIEM dispatcher", async () => {
    const dispatcher: AuditExportDispatcher = {
      dispatch: vi.fn(async (input: { config: CloudAuditExportConfig; events: CloudAuditEvent[]; payload: string }) => {
        expect(input.events.map((event) => event.action)).toEqual(expect.arrayContaining(["approval-denied", "settings-updated", "export-config-upserted"]));
        expect(input.payload).not.toContain("sk-live-secret");
        return { destination: input.config.destination, delivered: true };
      }),
    };
    app = await createApp(new AuditService(new InMemoryAuditRepository(), dispatcher));

    await request(app.getHttpServer())
      .put(`/v1/orgs/${SELF_HOST_TENANT_ID}/audit/settings`)
      .set(authHeader())
      .send({ retentionDays: 180, clientIngestEnabled: true })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({ retentionDays: 180, clientIngestEnabled: true });
      });

    await request(app.getHttpServer())
      .post(`/v1/orgs/${SELF_HOST_TENANT_ID}/audit/events`)
      .set(authHeader())
      .send(clientAuditIngest())
      .expect(201)
      .expect(({ body }) => {
        expect(body[0]).toMatchObject({ category: "approval", action: "approval-denied" });
        expect(body[0].metadata.apiKey).toBe("[redacted]");
        expect(new Date(body[0].expiresAt).getUTCFullYear()).toBe(2027);
      });

    const config = await request(app.getHttpServer())
      .put(`/v1/orgs/${SELF_HOST_TENANT_ID}/audit/exports`)
      .set(authHeader())
      .send({ kind: "webhook", destination: "https://siem.example.test/berry/audit", format: "json", config: { authorization: "Bearer super-secret" } })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({ kind: "webhook", status: "enabled", destination: "https://siem.example.test/berry/audit" });
        expect(body.config.authorization).toBe("[redacted]");
      });

    await request(app.getHttpServer())
      .post(`/v1/orgs/${SELF_HOST_TENANT_ID}/audit/exports/${config.body.id}/run`)
      .set(authHeader())
      .expect(201)
      .expect(({ body }) => {
        expect(body).toMatchObject({ kind: "webhook", delivered: true, chainValid: true });
        expect(body.count).toBeGreaterThanOrEqual(3);
      });
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
  });

  it("records admin mutations in the platform audit log", async () => {
    app = await createApp();

    await request(app.getHttpServer())
      .put(`/v1/orgs/${SELF_HOST_TENANT_ID}/models/policies`)
      .set(authHeader())
      .send({ providerId: "router", model: "gpt-5", status: "allowed", enforce: true, modeAllow: ["code"] })
      .expect(200);

    await request(app.getHttpServer())
      .get(`/v1/orgs/${SELF_HOST_TENANT_ID}/audit/events?category=models`)
      .set(authHeader())
      .expect(200)
      .expect(({ body }) => {
        expect(body).toHaveLength(1);
        expect(body[0]).toMatchObject({ category: "models", action: "policy-upserted", targetType: "model_policy", targetId: "router:gpt-5" });
      });
  });
});

function clientAuditIngest() {
  return {
    source: "desktop",
    events: [{
      category: "approval",
      action: "approval-denied",
      targetType: "tool_call",
      targetId: "tool_1",
      sessionId: "00000000-0000-7000-8000-000000000301",
      metadata: { apiKey: "sk-live-secret", reason: "fixture denial" },
      ts: "2026-07-10T00:00:00.000Z",
    }],
  };
}

async function createApp(service = new AuditService(new InMemoryAuditRepository())): Promise<INestApplication> {
  const identity = new InMemoryEnterpriseIdentityRepository();
  const moduleRef = await Test.createTestingModule({
    imports: [AgentApiModule.register({
      sessionHost: { useValue: fakeSessionHost() },
      auth: { useValue: fakeAuthRuntime() },
      identity: { repository: { useValue: identity } },
      audit: { service: { useValue: service } },
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
