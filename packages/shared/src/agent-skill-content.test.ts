import { describe, expect, it } from "vitest";
import { parseAgentSkillMarkdown } from "./agent-skill-content.js";

describe("parseAgentSkillMarkdown (H-018)", () => {
  it("shows a complete header when the frontmatter is missing", () => {
    // Task 042494ca needed four saves: no YAML, then no name, then an invalid name.
    expect(() => parseAgentSkillMarkdown("# Tender summariser\nSummarise tenders.")).toThrow(
      /must begin with YAML frontmatter\. Start SKILL\.md with:\n---\nname: my-skill\ndescription: /,
    );
  });

  it("reports every field problem in one error", () => {
    expect(() => parseAgentSkillMarkdown("---\nname: Tender Summariser\n---\nBody")).toThrow(
      "SKILL.md has 2 problems: SKILL.md frontmatter requires description; Skill name must use lowercase letters, numbers, and single hyphens only",
    );
  });

  it("keeps single problems and valid files unchanged", () => {
    expect(() => parseAgentSkillMarkdown("---\nname: tender-summariser\n---\nBody")).toThrow(/^SKILL\.md frontmatter requires description$/);
    expect(parseAgentSkillMarkdown("---\nname: tender-summariser\ndescription: Summarise tender packages.\nversion: 1.0.0\n---\nBody")).toEqual({
      name: "tender-summariser",
      description: "Summarise tender packages.",
      version: "1.0.0",
      license: null,
      compatibility: null,
      allowedTools: null,
    });
  });
});
