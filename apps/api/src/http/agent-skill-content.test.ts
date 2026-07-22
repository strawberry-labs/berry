import { describe, expect, it } from "vitest";
import { parseAgentSkillMarkdown } from "./agent-skill-content.ts";
import { PersonalCapabilitiesService } from "./personal-capabilities.service.ts";

describe("Agent Skills imports", () => {
  it("reads standard SKILL.md frontmatter and review metadata", async () => {
    const content = [
      "---",
      "name: release-notes",
      "description: Write concise release notes when a user asks for a changelog.",
      "version: 1.2.0",
      "compatibility: Requires git",
      "allowed-tools: Bash(git:*)",
      "metadata:",
      "  owner: platform",
      "---",
      "",
      "Write user-visible notes first.",
    ].join("\n");

    expect(parseAgentSkillMarkdown(content)).toMatchObject({ name: "release-notes", version: "1.2.0", compatibility: "Requires git" });
    const result = await new PersonalCapabilitiesService().previewSkill({ content, source: "upload", packageFiles: ["SKILL.md", "scripts/check.sh", "references/style.md"] });
    expect(result.review).toMatchObject({ name: "release-notes", version: "1.2.0", hasScripts: true, resources: ["references/style.md", "scripts/check.sh"] });
    expect(result.review.warnings).toContain("This skill package includes executable scripts. Review them before trusting the skill.");
  });

  it.each([
    ["missing frontmatter", "# Skill"],
    ["invalid name", "---\nname: Release Notes\ndescription: Notes\n---\nBody"],
    ["missing description", "---\nname: release-notes\n---\nBody"],
  ])("rejects %s", async (_label, content) => {
    await expect(new PersonalCapabilitiesService().previewSkill({ content })).rejects.toThrow();
  });

  it("imports reviewed personal skills disabled and untrusted", async () => {
    const content = "---\nname: safe-skill\ndescription: A reviewed skill\n---\nBody";
    const service = new PersonalCapabilitiesService();
    const preview = await service.previewSkill({ content });
    const saved = await service.saveSkill("00000000-0000-4000-8000-000000000001", "user_1", { content, confirmedHash: preview.review.hash });
    expect(saved).toMatchObject({ enabled: false, trusted: false, name: "safe-skill" });
  });
});
