import { SELF_HOST_TENANT_ID } from "@berry/db";
import { describe, expect, it } from "vitest";
import { OrganizationCapabilitiesService } from "./organization-capabilities.service.ts";
import { PersonalCapabilitiesService } from "./personal-capabilities.service.ts";

describe("OrganizationCapabilitiesService", () => {
  it("enforces the Agent Skills rule that a wrapper directory matches the frontmatter name", () => {
    const service = new OrganizationCapabilitiesService(new PersonalCapabilitiesService());
    expect(() => service.reviewStagedSkill({
      content: "---\nname: actual-name\ndescription: Validate the package name\n---\n",
      rootDirectory: "different-directory",
      packageFiles: ["SKILL.md"],
      resourceFiles: [],
      hash: "a".repeat(64),
      bytes: 80,
    })).toThrow("must match its package directory");
  });

  it("keeps personal skills available while resolving managed capability assignments", async () => {
    const personal = new PersonalCapabilitiesService();
    const service = new OrganizationCapabilitiesService(personal);
    const tenantId = SELF_HOST_TENANT_ID;
    const userId = "user_1";
    const personalContent = "---\nname: blocked\ndescription: personal\n---\n# blocked";
    await personal.saveSkill(tenantId, userId, { content: personalContent, enabled: true });
    await service.upsert(tenantId, { kind: "skill", capabilityId: "required", name: "Required", assignment: "required", allowUserDisable: true, config: { content: "---\nname: required\ndescription: Required\n---\n# required" } });
    await service.upsert(tenantId, { kind: "skill", capabilityId: "default", name: "Default", assignment: "default-on", allowUserDisable: true, config: { content: "---\nname: default\ndescription: Default\n---\n# default" } });
    await service.upsert(tenantId, { kind: "skill", capabilityId: "available", name: "Available", assignment: "available", allowUserDisable: false, config: { content: "---\nname: available\ndescription: Available\n---\n# available" } });
    await service.upsert(tenantId, { kind: "skill", capabilityId: "blocked", name: "Blocked", assignment: "blocked", config: {} });

    let effective = await service.effective(tenantId, userId);
    expect(effective.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ capabilityId: "required", enabled: true, locked: true, reason: "required", description: "", content: expect.stringContaining("# required") }),
      expect.objectContaining({ capabilityId: "default", enabled: true, reason: "default" }),
      expect.objectContaining({ capabilityId: "available", enabled: false, locked: false, reason: "available" }),
      expect.objectContaining({ capabilityId: "blocked", enabled: false, reason: "blocked" }),
      expect.objectContaining({ provenance: "personal", enabled: true, reason: "personal", description: "personal", content: personalContent }),
    ]));
    expect(effective.rows.find((item) => item.capabilityId === "blocked")).not.toHaveProperty("content");
    await service.setOverride(tenantId, userId, "skill", "default", false);
    await service.setOverride(tenantId, userId, "skill", "available", true);
    effective = await service.effective(tenantId, userId);
    expect(effective.skills.map((skill) => skill.name)).toContain("available");
    expect(effective.skills.map((skill) => skill.name)).toContain("blocked");
    expect(effective.skills.map((skill) => skill.name)).not.toContain("default");
    expect(effective.skills.find((skill) => skill.name === "available")?.filePath).toMatch(/^\/organization-skills\/orgcap_.*\/SKILL\.md$/);
    await service.upsert(tenantId, { kind: "skill", capabilityId: "available", name: "Available", assignment: "blocked", config: {} });
    expect((await service.effective(tenantId, userId)).skills.map((skill) => skill.name)).not.toContain("available");
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

  it("keeps uploaded organization resources in a materializable package", async () => {
    const service = new OrganizationCapabilitiesService(new PersonalCapabilitiesService());
    const tenantId = SELF_HOST_TENANT_ID;
    const content = "---\nname: branded-memo\ndescription: Create a memo from the retained template\n---\nUse assets/templates/memo.docx.";
    const resourceFiles = [{ path: "assets/templates/memo.docx", contentBase64: Buffer.from("docx-bytes").toString("base64") }];
    const saved = await service.upsert(tenantId, {
      kind: "skill",
      capabilityId: "branded-memo",
      name: "Branded memo",
      assignment: "default-on",
      config: { content },
      resourceFiles,
    });

    expect(saved).toMatchObject({ resources: ["assets/templates/memo.docx"], packageBytes: expect.any(Number) });
    await expect(service.skillPackage(tenantId, saved.id)).resolves.toEqual({ content, resourceFiles });
    await expect(service.skillPackage(tenantId, saved.capabilityId)).resolves.toEqual({ content, resourceFiles });
    await expect(service.skillPackageFile(tenantId, saved.capabilityId, "assets/templates/memo.docx")).resolves.toEqual(resourceFiles[0]);
    await expect(service.effective(tenantId, "user_1")).resolves.toMatchObject({
      rows: [expect.objectContaining({
        capabilityId: "branded-memo",
        packageStorage: "stored",
      })],
      skills: [{
        filePath: `/organization-skills/${saved.id}/SKILL.md`,
        resources: [`/organization-skills/${saved.id}/assets/templates/memo.docx`],
      }],
    });
  });

  it("uses the server-reviewed package hash instead of a supplied stale hash", async () => {
    const service = new OrganizationCapabilitiesService(new PersonalCapabilitiesService());
    const content = "---\nname: reviewed-package\ndescription: Verified by the server\n---\n# Reviewed";
    const saved = await service.upsert(SELF_HOST_TENANT_ID, {
      kind: "skill",
      capabilityId: "reviewed-package",
      name: "Reviewed package",
      assignment: "required",
      contentHash: "stale-client-hash",
      config: { content },
    });

    expect(saved.contentHash).not.toBe("stale-client-hash");
    await expect(service.effective(SELF_HOST_TENANT_ID, "user_1")).resolves.toMatchObject({
      rows: [expect.objectContaining({ packageStorage: "stored" })],
    });
  });

  it("accepts organization packages larger than the personal five-megabyte limit", async () => {
    const service = new OrganizationCapabilitiesService(new PersonalCapabilitiesService());
    const content = "---\nname: large-template\ndescription: Use a retained template\n---\nUse assets/template.bin.";
    const resourceFiles = [{ path: "assets/template.bin", contentBase64: Buffer.alloc(6 * 1024 * 1024, 0x2a).toString("base64") }];

    const saved = await service.upsert(SELF_HOST_TENANT_ID, {
      kind: "skill",
      capabilityId: "large-template",
      name: "Large template",
      assignment: "available",
      config: { content },
      resourceFiles,
    });

    expect(saved.packageBytes).toBeGreaterThan(5 * 1024 * 1024);
    expect(saved.resources).toEqual(["assets/template.bin"]);
  });

  it("preserves organization resources when a content update omits resourceFiles", async () => {
    const service = new OrganizationCapabilitiesService(new PersonalCapabilitiesService());
    const tenantId = SELF_HOST_TENANT_ID;
    const resourceFiles = [{ path: "scripts/render.js", contentBase64: Buffer.from("render()").toString("base64"), mode: 0o755 }];
    await service.upsert(tenantId, {
      kind: "skill",
      capabilityId: "memo-renderer",
      name: "Memo renderer",
      assignment: "default-on",
      config: { content: "---\nname: memo-renderer\ndescription: Render memos\n---\nRun scripts/render.js." },
      resourceFiles,
    });

    const updatedContent = "---\nname: memo-renderer\ndescription: Render concise memos\n---\nRun scripts/render.js with the new format.";
    const updated = await service.upsert(tenantId, {
      kind: "skill",
      capabilityId: "memo-renderer",
      name: "Memo renderer",
      assignment: "required",
      config: { content: updatedContent },
    });

    await expect(service.skillPackage(tenantId, updated.id)).resolves.toEqual({
      content: updatedContent,
      resourceFiles,
    });
    expect(updated.resources).toEqual(["scripts/render.js"]);
  });
});
