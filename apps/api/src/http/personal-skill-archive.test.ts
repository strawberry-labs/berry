import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersonalCapabilitiesService } from "./personal-capabilities.service.ts";
import { extractOrganizationSkillArchive } from "./skill-package-archive.ts";
import { PERSONAL_SKILL_PACKAGE_MAX_BYTES, ORGANIZATION_SKILL_PACKAGE_MAX_BYTES } from "@berry/shared";
describe("staged personal skill installation", () => {
  it("installs resources above the old limit and keeps access scoped to their owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "berry-personal-skill-test-"));
    try {
      const archive = new JSZip();
      archive.file("large/SKILL.md", "---\nname: large\ndescription: Large skill\n---\nUse the template.");
      archive.file("large/assets/template.bin", Buffer.alloc(6 * 1024 * 1024, 1));
      const path = join(root, "large.skill"); await writeFile(path, await archive.generateAsync({ type: "nodebuffer" }));
      const staged = await extractOrganizationSkillArchive(path, join(root, "extracted"));
      const service = new PersonalCapabilitiesService();
      const skill = await service.saveStagedSkill("tenant", "member", staged);
      expect(skill.packageBytes).toBeGreaterThan(5 * 1024 * 1024);
      expect((await service.skillPackage("tenant", "member", skill.id)).resourceFiles).toHaveLength(1);
      await expect(service.deleteSkill("tenant", "other-member", skill.id)).rejects.toThrow();
      await expect(service.saveStagedSkill("tenant", "member", { ...staged, bytes: PERSONAL_SKILL_PACKAGE_MAX_BYTES + 1 })).rejects.toThrow("500 MB");
      expect(PERSONAL_SKILL_PACKAGE_MAX_BYTES).toBe(500 * 1024 * 1024);
      expect(ORGANIZATION_SKILL_PACKAGE_MAX_BYTES).toBe(PERSONAL_SKILL_PACKAGE_MAX_BYTES);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
