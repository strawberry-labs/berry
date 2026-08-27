import { describe, expect, it } from "vitest";
import { PersonalMcpServerSchema } from "@berry/shared";
import { PersonalCapabilitiesService } from "./personal-capabilities.service.ts";

describe("PersonalCapabilitiesService personalization", () => {
  it("stores profile context per authenticated tenant and user", async () => {
    const service = new PersonalCapabilitiesService();
    const profile = await service.updatePersonalization("tenant-1", "user-1", {
      nickname: "CJ",
      occupation: "Product builder",
      about: "Runs a self-hosted workspace.",
      customInstructions: "Keep answers compact.",
    });

    expect(await service.personalization("tenant-1", "user-1")).toEqual(profile);
    expect(await service.personalization("tenant-1", "user-2")).toMatchObject({
      nickname: "",
      occupation: "",
      about: "",
      customInstructions: "",
      updatedAt: null,
    });
  });

  it("does not cache a profile when persistence fails", async () => {
    let failWrites = true;
    const database = {
      withTenant: async (_tenantId: string, operation: (executor: unknown) => Promise<unknown>) => operation({
        execute: async () => {
          if (failWrites) throw new Error("database unavailable");
        },
        query: async () => [],
      }),
    };
    const service = new PersonalCapabilitiesService(database as never);

    await expect(service.updatePersonalization("tenant-1", "user-1", {
      nickname: "CJ",
      occupation: "Product builder",
      about: "Runs a self-hosted workspace.",
      customInstructions: "Keep answers compact.",
    })).rejects.toThrow("database unavailable");

    failWrites = false;
    await expect(service.personalization("tenant-1", "user-1")).resolves.toMatchObject({
      nickname: "",
      occupation: "",
      about: "",
      customInstructions: "",
    });
  });

  it("clears persisted and cached MCP credentials when authentication is disabled", async () => {
    const writes: Array<{ sql: string; params: readonly unknown[] }> = [];
    const database = {
      withTenant: async (_tenantId: string, operation: (executor: unknown) => Promise<unknown>) => operation({
        execute: async (sql: string, params: readonly unknown[] = []) => { writes.push({ sql, params }); },
        query: async () => [],
      }),
    };
    const service = new PersonalCapabilitiesService(database as never, {
      BERRY_DURABLE_CAPABILITY_KEY: Buffer.alloc(32, 7).toString("base64"),
    });
    const authenticated = await service.saveMcp("tenant-1", "user-1", {
      name: "Research",
      url: "https://mcp.example.test/events",
      transport: "http-sse",
      auth: "bearer",
      credential: "secret-token",
      enabled: true,
      trusted: true,
    });

    const disabled = await service.saveMcp("tenant-1", "user-1", {
      id: authenticated.id,
      name: authenticated.name,
      url: authenticated.url,
      transport: authenticated.transport,
      auth: "none",
      enabled: true,
      trusted: true,
    });

    expect(disabled).toMatchObject({
      auth: "none",
      credentialRef: null,
      credentialConfigured: false,
    });
    expect(writes.at(-1)?.sql).toContain("credential_envelope=EXCLUDED.credential_envelope");
    expect(writes.at(-1)?.sql).not.toContain("COALESCE(EXCLUDED.credential_envelope");
    expect(writes.at(-1)?.params[7]).toBeNull();
    expect(writes.at(-1)?.params[8]).toBeNull();
    await expect(service.runtime("tenant-1", "user-1")).resolves.toMatchObject({
      mcpServers: [expect.not.objectContaining({ credential: expect.anything() })],
    });
  });

  it("serializes persisted MCP check timestamps as ISO datetimes", async () => {
    const tenantId = "00000000-0000-7000-8000-000000000001";
    const lastCheckedAt = new Date("2026-08-27T00:15:30.000Z");
    const database = {
      withTenant: async (_tenantId: string, operation: (executor: unknown) => Promise<unknown>) => operation({
        execute: async () => undefined,
        query: async (sql: string) => sql.includes("FROM personal_mcp_servers") ? [{
          id: "mcp_remote",
          tenant_id: tenantId,
          user_id: "user-1",
          name: "Remote tools",
          url: "https://mcp.example.test/rpc",
          transport: "streamable-http",
          auth: "oauth",
          credential_ref: "secret_mcp_remote",
          credential_envelope: null,
          enabled: true,
          trusted: false,
          health: "unknown",
          tool_count: 0,
          last_checked_at: lastCheckedAt,
          diagnostics: [],
          created_at: new Date("2026-08-26T23:00:00.000Z"),
          updated_at: new Date("2026-08-27T00:15:30.000Z"),
        }] : [],
      }),
    };
    const service = new PersonalCapabilitiesService(database as never);

    const servers = await service.listMcp(tenantId, "user-1");

    expect(servers[0]?.lastCheckedAt).toBe(lastCheckedAt.toISOString());
    expect(() => PersonalMcpServerSchema.array().parse(servers)).not.toThrow();
  });

  it("refreshes skills written by durable workers after the user was loaded", async () => {
    const tenantId = "00000000-0000-7000-8000-000000000001";
    const userId = "user-1";
    let skillRows: Record<string, unknown>[] = [];
    const database = {
      withTenant: async (_tenantId: string, operation: (executor: unknown) => Promise<unknown>) => operation({
        execute: async () => undefined,
        query: async (sql: string) => sql.includes("FROM personal_skills") ? skillRows : [],
      }),
    };
    const service = new PersonalCapabilitiesService(database as never);

    await expect(service.listSkills(tenantId, userId)).resolves.toEqual([]);
    skillRows = [{
      id: "skill_external",
      tenant_id: tenantId,
      user_id: userId,
      name: "decision-brief",
      description: "Create decision briefs",
      content: "---\nname: decision-brief\ndescription: Create decision briefs\n---\n\nWrite the brief.",
      enabled: true,
      trusted: true,
      source: "text",
      source_url: null,
      version: null,
      hash: "hash",
      diagnostics: [],
      created_at: "2026-08-11T00:00:00.000Z",
      updated_at: "2026-08-11T00:00:00.000Z",
    }];

    await expect(service.listSkills(tenantId, userId)).resolves.toEqual([
      expect.objectContaining({ id: "skill_external", name: "decision-brief", enabled: true }),
    ]);
  });

  it("persists a multi-file skill package with one bulk resource insert", async () => {
    const writes: Array<{ sql: string; params: readonly unknown[] }> = [];
    const database = {
      withTenant: async (_tenantId: string, operation: (executor: unknown) => Promise<unknown>) => operation({
        execute: async (sql: string, params: readonly unknown[] = []) => { writes.push({ sql, params }); },
        query: async () => [],
      }),
    };
    const service = new PersonalCapabilitiesService(database as never);

    await service.saveSkill("00000000-0000-7000-8000-000000000001", "user-1", {
      content: "---\nname: package-test\ndescription: Test a complete package\n---\n\nUse the bundled files.",
      source: "upload",
      resourceFiles: [
        { path: "scripts/render.py", contentBase64: Buffer.from("print('ok')").toString("base64"), mode: 0o755 },
        { path: "assets/template.txt", contentBase64: Buffer.from("template").toString("base64") },
      ],
    });

    const inserts = writes.filter(({ sql }) => sql.includes("INSERT INTO personal_skill_files"));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.sql).toContain("unnest($3::text[],$4::bytea[]");
    expect(inserts[0]?.params[2]).toEqual(["assets/template.txt", "scripts/render.py"]);
    expect(inserts[0]?.params[6]).toEqual([0o644, 0o755]);
  });
});
