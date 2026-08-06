import { describe, expect, it } from "vitest";
import { formatSkillsForSystemPrompt } from "../src/harness/system-prompt.ts";
import type { Skill } from "../src/harness/types.ts";

function skill(name: string, disableModelInvocation = false): Skill {
	return {
		name,
		description: `${name} description`,
		content: `${name} instructions`,
		filePath: `/managed-skills/${name}/SKILL.md`,
		disableModelInvocation,
	};
}

describe("formatSkillsForSystemPrompt", () => {
	it("adds mandatory format routing when the complete AESG artifact set is visible", () => {
		const prompt = formatSkillsForSystemPrompt([
			skill("aesg-branding"),
			skill("docx"),
			skill("pdf"),
			skill("pptx"),
			skill("xlsx"),
		]);

		expect(prompt).toContain("# AESG Artifact Skill Routing");
		expect(prompt).toContain("activate `aesg-branding` and every matching format skill");
		expect(prompt).toContain("default to DOCX");
	});

	it("omits AESG routing when a required skill is unavailable to the model", () => {
		const prompt = formatSkillsForSystemPrompt([
			skill("aesg-branding"),
			skill("docx"),
			skill("pdf"),
			skill("pptx"),
			skill("xlsx", true),
		]);

		expect(prompt).not.toContain("# AESG Artifact Skill Routing");
	});
});
