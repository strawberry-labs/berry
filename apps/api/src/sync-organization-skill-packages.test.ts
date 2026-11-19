import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OrganizationCapabilitiesService } from "./http/organization-capabilities.service.js";
import { PersonalCapabilitiesService } from "./http/personal-capabilities.service.js";
import { readOrganizationSkillDirectory } from "./sync-organization-skill-packages.js";
import { googleConnectorScopes, googleToolCatalog } from "./connectors/google-tools.js";

const skillsRoot = fileURLToPath(new URL("../../../deploy/skills/", import.meta.url));
const managedSkills = [
  "aesg-branding", "cv-creator", "docx", "gmail-mcp", "google-calendar-mcp", "google-drive-mcp", "pdf", "pptx", "skill-creator", "xlsx",
] as const;

describe("organization skill package sync source", () => {
  it.each([
    ["gmail-mcp", "gmail", "gmail_reply_to_thread"],
    ["google-calendar-mcp", "google-calendar", "google_calendar_create_event"],
    ["google-drive-mcp", "google-workspace", "drive_move_file"],
  ] as const)("uses Berry's admitted tool names in %s", async (skill, connector, writeTool) => {
    const { content } = await readOrganizationSkillDirectory(`${skillsRoot}${skill}`);
    const toolNames = Array.from(content.matchAll(/`((?:google_calendar|gmail|drive|docs|sheets|slides)_[a-z_]+)`/g), ([, tool]) => tool);
    const scopes = googleConnectorScopes(connector, "full", "search_workspace");
    const catalog = googleToolCatalog(connector, "full", scopes).map((tool) => tool.name);
    expect(toolNames).toContain(writeTool);
    expect(catalog).toEqual(expect.arrayContaining(toolNames));
  });

  it("loads and validates the managed packages", async () => {
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
