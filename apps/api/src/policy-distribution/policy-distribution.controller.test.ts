import "reflect-metadata";
import { generateKeyPairSync } from "node:crypto";
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
import { Ed25519PolicySigner, InMemoryPolicyDistributionRepository, PolicyDistributionService } from "./policy-distribution.service.ts";

describe("Policy distribution API", () => {
  let app: INestApplication | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("publishes signed berry-policy.json versions and replaces the active version", async () => {
    const signer = testSigner();
    app = await createApp(new PolicyDistributionService(new InMemoryPolicyDistributionRepository(), signer, {
      managedPolicy: async () => ({ personalAdditions: { skills: false, mcp: true }, capabilityCatalog: [{ kind: "skill", id: "release-guard", name: "Release guard", hash: "a".repeat(64), assignment: "required", content: "# Release guard" }] }),
    }));

    await request(app.getHttpServer())
      .put(`/v1/orgs/${SELF_HOST_TENANT_ID}/policy`)
      .set(authHeader())
      .send(policyRequest({ modelAllowlist: ["router:gpt-5"], telemetry: "optional" }))
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({ tenantId: SELF_HOST_TENANT_ID, version: 1, status: "active", keyId: "test-policy-key" });
        expect(body.bundle.signature).toMatchObject({ algorithm: "ed25519", keyId: "test-policy-key" });
        expect(body.bundle.policy.execpolicy[0]).toMatchObject({ id: "block-kubectl-delete", decision: "forbid" });
        expect(body.bundle.policy).toMatchObject({ personalAdditions: { skills: false, mcp: true }, capabilityCatalog: [expect.objectContaining({ id: "release-guard", assignment: "required" })] });
        expect(body.auditEventId).toMatch(/^audit_/);
      });

    await request(app.getHttpServer())
      .put(`/v1/orgs/${SELF_HOST_TENANT_ID}/policy`)
      .set(authHeader())
      .send(policyRequest({ modelAllowlist: ["router:berry/auto"], telemetry: "required" }))
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({ version: 2, status: "active" });
      });

    await request(app.getHttpServer())
      .get(`/v1/orgs/${SELF_HOST_TENANT_ID}/policy/versions`)
      .set(authHeader())
      .expect(200)
      .expect(({ body }) => {
        expect(body.map((entry: { version: number; status: string }) => [entry.version, entry.status])).toEqual([[2, "active"], [1, "revoked"]]);
      });

    await request(app.getHttpServer())
      .get(`/v1/orgs/${SELF_HOST_TENANT_ID}/policy/berry-policy.json`)
      .set(authHeader())
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({ version: 2, organization: { id: SELF_HOST_TENANT_ID, name: "Berry Self-Host" } });
        expect(body.policy.telemetry).toBe("required");
      });
  });

  it("fails closed when an admin publishes without a configured signing key", async () => {
    app = await createApp(new PolicyDistributionService(new InMemoryPolicyDistributionRepository(), null));

    await request(app.getHttpServer())
      .put(`/v1/orgs/${SELF_HOST_TENANT_ID}/policy`)
      .set(authHeader())
      .send(policyRequest({ modelAllowlist: ["router:gpt-5"] }))
      .expect(503)
      .expect(({ body }) => {
        expect(body.message).toBe("Policy signing is not configured");
      });
  });
});

function policyRequest(overrides: { modelAllowlist: string[]; telemetry?: "disabled" | "optional" | "required" }) {
  return {
    organization: { id: SELF_HOST_TENANT_ID, name: "Berry Self-Host" },
    policy: {
      execpolicy: [
        { id: "block-kubectl-delete", kind: "regex-lite", decision: "forbid", pattern: String.raw`kubectl\s+delete`, description: "Production deletion needs a human" },
      ],
      modelAllowlist: overrides.modelAllowlist,
      mcpAllowlist: ["github", "docs"],
      pluginAllowlist: ["openai-bundled/browser"],
      sandboxFloor: "workspace-write",
      telemetry: overrides.telemetry ?? "optional",
    },
    note: "Fixture policy publish",
  };
}

function testSigner(): Ed25519PolicySigner {
  const { privateKey } = generateKeyPairSync("ed25519");
  return new Ed25519PolicySigner(privateKey.export({ format: "pem", type: "pkcs8" }), "test-policy-key");
}

async function createApp(service: PolicyDistributionService): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AgentApiModule.register({
      sessionHost: { useValue: fakeSessionHost() },
      auth: { useValue: fakeAuthRuntime() },
      identity: { repository: { useValue: new InMemoryEnterpriseIdentityRepository() } },
      policyDistribution: { service: { useValue: service } },
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
