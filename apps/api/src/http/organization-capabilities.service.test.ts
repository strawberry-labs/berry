import { SELF_HOST_TENANT_ID } from "@berry/db";
import { describe, expect, it } from "vitest";
import { OrganizationCapabilitiesService } from "./organization-capabilities.service.ts";
import { PersonalCapabilitiesService } from "./personal-capabilities.service.ts";

describe("OrganizationCapabilitiesService", () => {
  it("resolves required, default, available, blocked, and personal precedence on every call", async () => {
    const personal = new PersonalCapabilitiesService();
    const service = new OrganizationCapabilitiesService(personal);
    const tenantId = SELF_HOST_TENANT_ID;
    const userId = "user_1";
    const preview = await personal.previewSkill({ name: "blocked", description: "personal", content: "# blocked" });
    await personal.saveSkill(tenantId, userId, { name: "blocked", description: "personal", content: "# blocked", confirmedHash: preview.review.hash, trusted: true });
    await service.upsert(tenantId, { kind: "skill", capabilityId: "required", name: "Required", assignment: "required", allowUserDisable: true, config: { content: "# required" } });
    await service.upsert(tenantId, { kind: "skill", capabilityId: "default", name: "Default", assignment: "default-on", allowUserDisable: true, config: { content: "# default" } });
    await service.upsert(tenantId, { kind: "skill", capabilityId: "available", name: "Available", assignment: "available", allowUserDisable: true, config: { content: "# available" } });
    await service.upsert(tenantId, { kind: "skill", capabilityId: "blocked", name: "Blocked", assignment: "blocked", config: {} });

    let effective = await service.effective(tenantId, userId);
    expect(effective.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ capabilityId: "required", enabled: true, locked: true, reason: "required" }),
      expect.objectContaining({ capabilityId: "default", enabled: true, reason: "default" }),
      expect.objectContaining({ capabilityId: "available", enabled: false, reason: "available" }),
      expect.objectContaining({ capabilityId: "blocked", enabled: false, reason: "blocked" }),
      expect.objectContaining({ provenance: "personal", enabled: false, reason: "personal-blocked" }),
    ]));
    await service.setOverride(tenantId, userId, "skill", "default", false);
    await service.setOverride(tenantId, userId, "skill", "available", true);
    effective = await service.effective(tenantId, userId);
    expect(effective.skills.map((skill) => skill.name)).toContain("Available");
    expect(effective.skills.map((skill) => skill.name)).not.toContain("Default");
    expect(effective.skills.find((skill) => skill.name === "Available")?.filePath).toBe("/workspace/.berry/managed-skills/available/SKILL.md");
    await service.upsert(tenantId, { kind: "skill", capabilityId: "available", name: "Available", assignment: "blocked", config: {} });
    expect((await service.effective(tenantId, userId)).skills.map((skill) => skill.name)).not.toContain("Available");
  });
});
