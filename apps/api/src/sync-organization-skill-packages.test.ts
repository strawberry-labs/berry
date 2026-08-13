import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OrganizationCapabilitiesService } from "./http/organization-capabilities.service.js";
import { PersonalCapabilitiesService } from "./http/personal-capabilities.service.js";
import { readOrganizationSkillDirectory } from "./sync-organization-skill-packages.js";

const skillsRoot = fileURLToPath(new URL("../../../deploy/skills/", import.meta.url));
const managedSkills = ["aesg-branding", "cv-creator", "docx", "pdf", "pptx", "skill-creator", "xlsx"] as const;

describe("organization skill package sync source", () => {
  it("loads and validates all seven complete managed packages", async () => {
    const reviewer = new OrganizationCapabilitiesService(new PersonalCapabilitiesService());
    let packagesWithResources = 0;

    for (const name of managedSkills) {
      const skill = await readOrganizationSkillDirectory(`${skillsRoot}${name}`);
      const review = await reviewer.reviewSkill({ ...skill, source: "upload" });
      const expectedBytes = Buffer.byteLength(skill.content)
        + skill.resourceFiles.reduce((total, file) => total + Buffer.from(file.contentBase64, "base64").byteLength, 0);

      expect(review.name).toBe(name);
      expect(review.hash).toMatch(/^[a-f0-9]{64}$/);
      expect(review.bytes).toBe(expectedBytes);
      expect(skill.packageFiles[0]).toBe("SKILL.md");
      expect(skill.packageFiles).toHaveLength(skill.resourceFiles.length + 1);
      if (skill.resourceFiles.length > 0) packagesWithResources += 1;
    }

    expect(packagesWithResources).toBeGreaterThanOrEqual(6);
  });
});
