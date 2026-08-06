import { describe, expect, it } from "vitest";
import { formatSkillsForSystemPrompt } from "../src/harness/system-prompt.ts";
import type { Skill } from "../src/harness/types.ts";

function skill(name: string, id = name, disableModelInvocation = false): Skill {
	return {
		name,
		description: `${name} description`,
		content: `${name} instructions`,
		filePath: `/managed-skills/${id}/SKILL.md`,
		disableModelInvocation,
	};
}

describe("formatSkillsForSystemPrompt", () => {
	it("adds mandatory format routing when the complete AESG artifact set is visible", () => {
		const prompt = formatSkillsForSystemPrompt([
			skill("AESG branding", "aesg-branding"),
			skill("AESG Word documents", "docx"),
			skill("AESG PDF documents", "pdf"),
			skill("AESG PowerPoint presentations", "pptx"),
			skill("AESG Excel workbooks", "xlsx"),
		]);

		expect(prompt).toContain("# AESG Artifact Skill Routing");
		expect(prompt).toContain('activate the skill named "AESG branding" and every matching format skill');
		expect(prompt).toContain('route to "AESG branding" then "AESG Word documents"');
		expect(prompt).toContain("default to DOCX");
	});

	it("omits AESG routing when a required skill is unavailable to the model", () => {
		const prompt = formatSkillsForSystemPrompt([
			skill("AESG branding", "aesg-branding"),
			skill("AESG Word documents", "docx"),
			skill("AESG PDF documents", "pdf"),
			skill("AESG PowerPoint presentations", "pptx"),
			skill("AESG Excel workbooks", "xlsx", true),
		]);

		expect(prompt).not.toContain("# AESG Artifact Skill Routing");
	});
});
