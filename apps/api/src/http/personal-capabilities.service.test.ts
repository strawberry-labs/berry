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
});
