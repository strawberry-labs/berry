import "reflect-metadata";
import { UnauthorizedException, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { SessionHost } from "@berry/local-agent";
import { SELF_HOST_TENANT_ID } from "@berry/db";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import type { BerryAuthRuntime } from "../auth/auth-runtime.ts";
import { FilePlatformService } from "../files/file-platform.service.ts";
import { AgentApiModule } from "../http/agent-api.module.ts";
import { InMemoryEnterpriseIdentityRepository } from "./identity.repository.ts";

describe("Enterprise identity API", () => {
  let app: INestApplication | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("seeds intentional Skill and MCP permissions for every organization role", async () => {
    const repository = new InMemoryEnterpriseIdentityRepository();
    const owner = await repository.getEffectivePermissions(SELF_HOST_TENANT_ID, "00000000-0000-7000-8000-000000000201");
    const adminMembership = await repository.createMembership({ tenantId: SELF_HOST_TENANT_ID, email: "capability-admin@example.test", name: "Capability Admin", password: "Temporary-123!", role: "admin" });
    const memberMembership = await repository.createMembership({ tenantId: SELF_HOST_TENANT_ID, email: "capability-member@example.test", name: "Capability Member", password: "Temporary-123!", role: "member" });
    const admin = await repository.getEffectivePermissions(SELF_HOST_TENANT_ID, adminMembership.userId);
    const member = await repository.getEffectivePermissions(SELF_HOST_TENANT_ID, memberMembership.userId);

    expect(owner.permissions).toEqual(expect.arrayContaining(["skills:read", "skills:write", "mcp:read", "mcp:write"]));
    expect(admin.permissions).toEqual(expect.arrayContaining(["skills:read", "skills:write", "mcp:read", "mcp:write"]));
    expect(member.permissions).toEqual(expect.arrayContaining(["skills:read", "mcp:read"]));
    expect(member.permissions).not.toEqual(expect.arrayContaining(["skills:write", "mcp:write"]));
    expect(owner.permissions).toEqual(expect.arrayContaining(["members:write", "usage:read", "billing:write", "data_policy:write", "service_accounts:write", "org_settings:write"]));
    expect(admin.permissions).toEqual(expect.arrayContaining(["members:write", "usage:read", "reports:write", "alerts:write", "guardrails:write"]));
    expect(member.permissions).not.toEqual(expect.arrayContaining(["members:write", "usage:read", "billing:write", "reports:write", "alerts:write", "data_policy:write", "service_accounts:write", "org_settings:write"]));
  });

  it("lists organizations, resolves host-mapped orgs, and manages nested departments", async () => {
    app = await createApp();

    await request(app.getHttpServer()).get("/v1/orgs").set(authHeader()).expect(200).expect(({ body }) => {
      expect(body[0]).toMatchObject({ id: SELF_HOST_TENANT_ID, slug: "self-host", hostname: "localhost" });
    });
    await request(app.getHttpServer()).get("/v1/orgs/current?host=localhost").set(authHeader()).expect(200).expect(({ body }) => {
      expect(body.id).toBe(SELF_HOST_TENANT_ID);
    });
    const parent = await request(app.getHttpServer())
      .post(`/v1/orgs/${SELF_HOST_TENANT_ID}/departments`)
      .set(authHeader())
      .send({ name: "Engineering" })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/v1/orgs/${SELF_HOST_TENANT_ID}/departments`)
      .set(authHeader())
      .send({ name: "Platform", parentId: parent.body.id })
      .expect(201)
      .expect(({ body }) => {
        expect(body.parentId).toBe(parent.body.id);
      });
  });

  it("lets organization admins create login accounts and list members", async () => {
    app = await createApp();

    const created = await request(app.getHttpServer())
      .post(`/v1/orgs/${SELF_HOST_TENANT_ID}/members`)
      .set(authHeader())
      .send({ email: "NEW.USER@example.test", name: "New User", password: "Temporary-123!", role: "member" })
      .expect(201);
    expect(created.body).toMatchObject({
      email: "new.user@example.test",
      name: "New User",
      role: "member",
      status: "active",
    });
    expect(created.body).not.toHaveProperty("password");

    const department = await request(app.getHttpServer())
      .post(`/v1/orgs/${SELF_HOST_TENANT_ID}/departments`)
      .set(authHeader())
      .send({ name: "Research" })
      .expect(201);
    await request(app.getHttpServer())
      .put(`/v1/orgs/${SELF_HOST_TENANT_ID}/members/${created.body.userId}`)
      .set(authHeader())
      .send({
        role: "admin",
        status: "disabled",
        departmentIds: [department.body.id],
        primaryDepartmentId: department.body.id,
      })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          role: "admin",
          status: "disabled",
          primaryDepartmentId: department.body.id,
          departmentIds: [department.body.id],
        });
      });

    await request(app.getHttpServer())
      .get(`/v1/orgs/${SELF_HOST_TENANT_ID}/members`)
      .set(authHeader())
      .expect(200)
      .expect(({ body }) => {
        expect(body).toHaveLength(3);
        expect(body.map((member: { email: string }) => member.email)).toContain("new.user@example.test");
      });
    await request(app.getHttpServer())
      .get(`/v1/orgs/${SELF_HOST_TENANT_ID}/members/page?search=new&limit=1`)
      .set(authHeader())
      .expect(200)
      .expect(({ body }) => {
        expect(body.items).toHaveLength(1);
        expect(body.items[0].email).toBe("new.user@example.test");
        expect(body.total).toBe(1);
      });
    await request(app.getHttpServer())
      .get(`/v1/orgs/${SELF_HOST_TENANT_ID}/departments/page?search=research&limit=1`)
      .set(authHeader())
      .expect(200)
      .expect(({ body }) => {
        expect(body.items).toHaveLength(1);
        expect(body.items[0].name).toBe("Research");
      });

    await request(app.getHttpServer())
      .post(`/v1/orgs/${SELF_HOST_TENANT_ID}/members`)
      .set(authHeader())
      .send({ email: "new.user@example.test", name: "Duplicate", password: "Temporary-123!", role: "member" })
      .expect(409);

    await request(app.getHttpServer())
      .post(`/v1/orgs/${SELF_HOST_TENANT_ID}/members`)
      .set(memberAuthHeader())
      .send({ email: "denied@example.test", name: "Denied", password: "Temporary-123!", role: "member" })
      .expect(403);
  });

  it("stores an encrypted Google Workspace SSO configuration without exposing the secret", async () => {
    app = await createApp();

    const google = await request(app.getHttpServer())
      .post(`/v1/orgs/${SELF_HOST_TENANT_ID}/sso/connections`)
      .set(authHeader())
      .send({
        kind: "oidc",
        provider: "google",
        slug: "google-workspace",
        displayName: "Google Workspace",
        status: "enabled",
        clientId: "berry.apps.googleusercontent.com",
        clientSecret: "google-client-secret",
        domains: ["AESG.COM"],
        jitProvisioning: true,
      })
      .expect(201);
    expect(google.body).toMatchObject({
      provider: "google",
      status: "enabled",
      issuer: "https://accounts.google.com",
      domains: ["aesg.com"],
      clientSecretConfigured: true,
    });
    expect(google.body).not.toHaveProperty("clientSecret");

    await request(app.getHttpServer())
      .get(`/v1/orgs/${SELF_HOST_TENANT_ID}/sso/connections`)
      .set(authHeader())
      .expect(200)
      .expect(({ body }) => {
        expect(body).toHaveLength(1);
        expect(body[0]).not.toHaveProperty("clientSecret");
      });

    await request(app.getHttpServer())
      .post(`/v1/orgs/${SELF_HOST_TENANT_ID}/sso/connections`)
      .set(authHeader())
      .send({
        kind: "saml",
        slug: "entra-saml",
        displayName: "Entra SAML",
        status: "enabled",
      })
      .expect(400);

    await request(app.getHttpServer())
      .get(`/v1/orgs/${SELF_HOST_TENANT_ID}/sso/start?connection=google-workspace`)
      .set(authHeader())
      .expect(404);
  });

  it("reserves Google administrator access without creating a password account", async () => {
    app = await createApp();
    const department = await request(app.getHttpServer())
      .post(`/v1/orgs/${SELF_HOST_TENANT_ID}/departments`)
      .set(authHeader())
      .send({ name: "Technology" })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/v1/orgs/${SELF_HOST_TENANT_ID}/sso/connections`)
      .set(authHeader())
      .send({
        kind: "oidc",
        provider: "google",
        slug: "google-workspace",
        displayName: "Google Workspace",
        status: "enabled",
        clientId: "berry.apps.googleusercontent.com",
        clientSecret: "google-client-secret",
        domains: ["aesg.com"],
        jitProvisioning: true,
      })
      .expect(201);

    const pendingAdministrator = await request(app.getHttpServer())
      .post(`/v1/orgs/${SELF_HOST_TENANT_ID}/members`)
      .set(authHeader())
      .send({
        email: "it2@aesg.com",
        name: "IT Administrator",
        role: "admin",
        provisioning: "google_sso",
        departmentIds: [department.body.id],
        primaryDepartmentId: department.body.id,
      })
      .expect(201)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          email: "it2@aesg.com",
          role: "admin",
          status: "pending",
          source: "sso",
          departmentIds: [department.body.id],
          primaryDepartmentId: department.body.id,
        });
        expect(body).not.toHaveProperty("password");
      });

    await request(app.getHttpServer())
      .put(`/v1/orgs/${SELF_HOST_TENANT_ID}/members/${pendingAdministrator.body.userId}`)
      .set(authHeader())
      .send({ status: "disabled" })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({ role: "admin", status: "disabled" });
      });

    await request(app.getHttpServer())
      .post(`/v1/orgs/${SELF_HOST_TENANT_ID}/members`)
      .set(memberAuthHeader())
      .send({ email: "peer@aesg.com", role: "admin", provisioning: "google_sso" })
      .expect(403);
  });

  it("allows only the owner to change an administrator role", async () => {
    const repository = new InMemoryEnterpriseIdentityRepository();
    const actor = await repository.createMembership({
      tenantId: SELF_HOST_TENANT_ID,
      email: "actor-admin@example.test",
      name: "Actor Admin",
      password: "Temporary-123!",
      role: "admin",
    });
    const target = await repository.createMembership({
      tenantId: SELF_HOST_TENANT_ID,
      email: "target-admin@example.test",
      name: "Target Admin",
      password: "Temporary-123!",
      role: "admin",
    });
    app = await createApp({ repository, adminUserId: actor.userId });

    await request(app.getHttpServer())
      .put(`/v1/orgs/${SELF_HOST_TENANT_ID}/members/${target.userId}`)
      .set(adminAuthHeader())
      .send({ role: "member" })
      .expect(403);
    expect((await repository.getMembership(SELF_HOST_TENANT_ID, target.userId))?.role).toBe("admin");

    await request(app.getHttpServer())
      .put(`/v1/orgs/${SELF_HOST_TENANT_ID}/members/${target.userId}`)
      .set(adminAuthHeader())
      .send({ status: "disabled" })
      .expect(403);
    expect((await repository.getMembership(SELF_HOST_TENANT_ID, target.userId))?.status).toBe("active");

    await request(app.getHttpServer())
      .put(`/v1/orgs/${SELF_HOST_TENANT_ID}/members/${target.userId}`)
      .set(authHeader())
      .send({ role: "member" })
      .expect(200);
    expect((await repository.getMembership(SELF_HOST_TENANT_ID, target.userId))?.role).toBe("member");
  });

  it("rejects local member provisioning when the deployment is Google-only", async () => {
    app = await createApp({ localMemberProvisioningEnabled: false });

    await request(app.getHttpServer())
      .post(`/v1/orgs/${SELF_HOST_TENANT_ID}/members`)
      .set(authHeader())
      .send({ email: "password-user@aesg.com", name: "Password User", password: "Temporary-123!", role: "member" })
      .expect(400)
      .expect(({ body }) => {
        expect(body.message).toContain("Password accounts are disabled");
      });
  });

  it("enforces RBAC, feature-flag role defaults, and resource ACL administration", async () => {
    app = await createApp();

    await request(app.getHttpServer())
      .get(`/v1/orgs/${SELF_HOST_TENANT_ID}/permissions/me`)
      .set(authHeader())
      .expect(200)
      .expect(({ body }) => {
        expect(body.role).toBe("owner");
        expect(body.permissions).toContain("rbac:write");
        expect(body.permissions).toContain("policy:write");
        expect(body.featureFlags[0]).toMatchObject({ flag: "enterprise-governance", enabled: true });
      });

    await request(app.getHttpServer())
      .post(`/v1/orgs/${SELF_HOST_TENANT_ID}/departments`)
      .set(memberAuthHeader())
      .send({ name: "Denied Department" })
      .expect(403);

    await request(app.getHttpServer())
      .put(`/v1/orgs/${SELF_HOST_TENANT_ID}/roles/member/permissions`)
      .set(authHeader())
      .send({ permissions: ["org:read", "departments:read", "models:read"], source: "fixture" })
      .expect(200)
      .expect(({ body }) => {
        expect(body.role).toBe("member");
        expect(body.permissions).toContain("models:read");
      });

    await request(app.getHttpServer())
      .put(`/v1/orgs/${SELF_HOST_TENANT_ID}/feature-flags/agent-browser`)
      .set(authHeader())
      .send({ enabled: true, roleDefaults: { admin: ["models:write"], member: ["models:read"] } })
      .expect(200)
      .expect(({ body }) => {
        expect(body.flag).toBe("agent-browser");
        expect(body.roleDefaults.member).toContain("models:read");
      });

    const acl = await request(app.getHttpServer())
      .put(`/v1/orgs/${SELF_HOST_TENANT_ID}/acls`)
      .set(authHeader())
      .send({
        resourceType: "workspace",
        resourceId: "default",
        principalType: "role",
        principalId: "member",
        allow: ["departments:read"],
        deny: ["sso:write"],
      })
      .expect(200);
    expect(acl.body).toMatchObject({ resourceType: "workspace", principalType: "role", principalId: "member" });

    await request(app.getHttpServer())
      .get(`/v1/orgs/${SELF_HOST_TENANT_ID}/acls?resourceType=workspace&resourceId=default`)
      .set(authHeader())
      .expect(200)
      .expect(({ body }) => {
        expect(body).toHaveLength(1);
        expect(body[0].deny).toContain("sso:write");
      });

    await request(app.getHttpServer())
      .put(`/v1/orgs/${SELF_HOST_TENANT_ID}/budgets/limits`)
      .set(authHeader())
      .send({
        scopeType: "org",
        scopeId: SELF_HOST_TENANT_ID,
        period: "month",
        softLimitMicros: "8000000000",
        hardLimitMicros: "10000000000",
        status: "active",
      })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({ scopeType: "org", hardLimitMicros: "10000000000", status: "active" });
      });

    await request(app.getHttpServer())
      .get(`/v1/orgs/${SELF_HOST_TENANT_ID}/budgets/limits`)
      .set(authHeader())
      .expect(200)
      .expect(({ body }) => {
        expect(body[0]).toMatchObject({ scopeId: SELF_HOST_TENANT_ID, hardLimitMicros: "10000000000" });
      });
  });

  it("requires SCIM bearer auth and deprovisions users idempotently", async () => {
    app = await createApp();

    await request(app.getHttpServer()).get(`/v1/scim/${SELF_HOST_TENANT_ID}/ServiceProviderConfig`).expect(401);
    await request(app.getHttpServer())
      .get(`/v1/scim/${SELF_HOST_TENANT_ID}/ServiceProviderConfig`)
      .set(scimHeader())
      .expect(200)
      .expect(({ body }) => {
        expect(body.patch.supported).toBe(true);
      });

    const created = await request(app.getHttpServer())
      .post(`/v1/scim/${SELF_HOST_TENANT_ID}/Users`)
      .set(scimHeader())
      .send({
        externalId: "okta-user-1",
        userName: "scim@example.test",
        name: { formatted: "SCIM User" },
        emails: [{ value: "scim@example.test", primary: true }],
        active: true,
      })
      .expect(201);
    expect(created.body).toMatchObject({ externalId: "okta-user-1", active: true });

    await request(app.getHttpServer())
      .delete(`/v1/scim/${SELF_HOST_TENANT_ID}/Users/okta-user-1`)
      .set(scimHeader())
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({ id: created.body.id, active: false, alreadyDeprovisioned: false });
      });
    await request(app.getHttpServer())
      .delete(`/v1/scim/${SELF_HOST_TENANT_ID}/Users/okta-user-1`)
      .set(scimHeader())
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({ id: created.body.id, active: false, alreadyDeprovisioned: true });
      });
  });

  it("maps SCIM groups to departments and deprovisions groups idempotently", async () => {
    app = await createApp();

    const group = await request(app.getHttpServer())
      .post(`/v1/scim/${SELF_HOST_TENANT_ID}/Groups`)
      .set(scimHeader())
      .send({ externalId: "group-platform", displayName: "Platform Team" })
      .expect(201);

    expect(group.body).toMatchObject({ externalId: "group-platform", displayName: "Platform Team" });
    await request(app.getHttpServer()).delete(`/v1/scim/${SELF_HOST_TENANT_ID}/Groups/group-platform`).set(scimHeader()).expect(200).expect(({ body }) => {
      expect(body.alreadyDeprovisioned).toBe(false);
    });
    await request(app.getHttpServer()).delete(`/v1/scim/${SELF_HOST_TENANT_ID}/Groups/group-platform`).set(scimHeader()).expect(200).expect(({ body }) => {
      expect(body.alreadyDeprovisioned).toBe(true);
    });
  });
});

async function createApp(options: {
  repository?: InMemoryEnterpriseIdentityRepository;
  adminUserId?: string;
  localMemberProvisioningEnabled?: boolean;
} = {}): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AgentApiModule.register({
      sessionHost: { useValue: fakeSessionHost() },
      auth: { useValue: fakeAuthRuntime(options.adminUserId) },
      identity: {
        repository: { useValue: options.repository ?? new InMemoryEnterpriseIdentityRepository() },
        scimBearerToken: "berry-scim-test",
        localMemberProvisioningEnabled: options.localMemberProvisioningEnabled,
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

function authHeader() {
  return { Authorization: "Bearer berry-test-session" };
}

function memberAuthHeader() {
  return { Authorization: "Bearer berry-member-session" };
}

function adminAuthHeader() {
  return { Authorization: "Bearer berry-admin-session" };
}

function scimHeader() {
  return { Authorization: "Bearer berry-scim-test" };
}

function fakeAuthRuntime(adminUserId?: string): BerryAuthRuntime {
  const getSession: BerryAuthRuntime["getSession"] = async (headers) => {
    if (headers.authorization === "Bearer berry-admin-session" && adminUserId) {
      return {
        session: { id: "auth_session_admin", userId: adminUserId },
        user: { id: adminUserId, email: "actor-admin@example.test", name: "Actor Admin", emailVerified: true },
      };
    }
    if (headers.authorization === "Bearer berry-member-session") {
      return {
        session: { id: "auth_session_2", userId: "00000000-0000-7000-8000-000000000202" },
        user: { id: "00000000-0000-7000-8000-000000000202", email: "member@example.test", name: "Member User", emailVerified: true },
      };
    }
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
      socialProviders: ["github"],
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
