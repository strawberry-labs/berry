import { BerryApiError } from "@berry/api-client";
import { describe, expect, it, vi } from "vitest";
import { loadPersonalSkillResource, skillControlHint } from "./personal-capability-screens";

describe("personal capability screens", () => {
  it("keeps personal skills available when organization capability metadata is forbidden", async () => {
    const client = {
      listPersonalSkills: vi.fn(async () => []),
      effectiveCapabilities: vi.fn(async () => {
        throw new BerryApiError("Forbidden", 403, null);
      }),
    };

    await expect(loadPersonalSkillResource(client, "tenant_1")).resolves.toEqual({
      personal: [],
      effective: [],
    });
  });

  it("surfaces non-permission failures", async () => {
    const client = {
      listPersonalSkills: vi.fn(async () => []),
      effectiveCapabilities: vi.fn(async () => {
        throw new BerryApiError("Unavailable", 503, null);
      }),
    };

    await expect(loadPersonalSkillResource(client, "tenant_1")).rejects.toMatchObject({ status: 503 });
  });

  it("explains managed and offline skill controls", () => {
    expect(skillControlHint({ enabled: true, locked: true }, true)).toBe("Required by your organization");
    expect(skillControlHint({ enabled: false, locked: true }, true)).toBe("Disabled by your organization");
    expect(skillControlHint({ enabled: false, locked: false, personal: {} as never }, true)).toBe("Off");
    expect(skillControlHint({ enabled: false, locked: false }, false)).toBe("Connect to Berry to change this setting");
  });
});
