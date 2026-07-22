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
    const personalContent = "---\nname: blocked\ndescription: personal\n---\n# blocked";
    const preview = await personal.previewSkill({ content: personalContent });
    await personal.saveSkill(tenantId, userId, { content: personalContent, confirmedHash: preview.review.hash, enabled: true, trusted: true });
    await service.upsert(tenantId, { kind: "skill", capabilityId: "required", name: "Required", assignment: "required", allowUserDisable: true, config: { content: "---\nname: required\ndescription: Required\n---\n# required" } });
    await service.upsert(tenantId, { kind: "skill", capabilityId: "default", name: "Default", assignment: "default-on", allowUserDisable: true, config: { content: "---\nname: default\ndescription: Default\n---\n# default" } });
    await service.upsert(tenantId, { kind: "skill", capabilityId: "available", name: "Available", assignment: "available", allowUserDisable: false, config: { content: "---\nname: available\ndescription: Available\n---\n# available" } });
    await service.upsert(tenantId, { kind: "skill", capabilityId: "blocked", name: "Blocked", assignment: "blocked", config: {} });

    let effective = await service.effective(tenantId, userId);
    expect(effective.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ capabilityId: "required", enabled: true, locked: true, reason: "required" }),
      expect.objectContaining({ capabilityId: "default", enabled: true, reason: "default" }),
      expect.objectContaining({ capabilityId: "available", enabled: false, locked: false, reason: "available" }),
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

  it("preserves managed skill content when an admin changes only assignment controls", async () => {
    const service = new OrganizationCapabilitiesService(new PersonalCapabilitiesService());
    const tenantId = SELF_HOST_TENANT_ID;
    const content = "---\nname: release-notes\ndescription: Write release notes\n---\n# Release notes\n\nWrite concise notes.";
    const created = await service.upsert(tenantId, {
      kind: "skill",
      capabilityId: "release-notes",
      name: "Release notes",
      description: "Write release notes",
      assignment: "default-on",
      allowUserDisable: true,
      config: { content },
    });

    const updated = await service.upsert(tenantId, {
      kind: "skill",
      capabilityId: "release-notes",
      name: "Release notes",
      assignment: "required",
      allowUserDisable: false,
    });

    expect(updated.config).toEqual(created.config);
    expect(updated.contentHash).toBe(created.contentHash);
    expect(updated.description).toBe(created.description);
    expect((await service.effective(tenantId, "user_1")).skills[0]?.content).toContain("Write concise notes");
  });
});
