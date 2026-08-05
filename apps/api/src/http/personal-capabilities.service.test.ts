import { describe, expect, it } from "vitest";
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
});
