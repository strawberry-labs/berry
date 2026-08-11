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
			skill("CV Creator", "cv-creator"),
			skill("AESG Word documents", "docx"),
			skill("AESG PDF documents", "pdf"),
			skill("AESG PowerPoint presentations", "pptx"),
			skill("AESG Excel workbooks", "xlsx"),
		]);

		expect(prompt).toContain("# AESG artifact workspace");
		expect(prompt).toContain('activate "AESG branding" and the matching skill');
		expect(prompt).toContain('activate "AESG branding" and "CV Creator"');
		expect(prompt).toContain("`<workspace-root>/inputs/<file-id>/<filename>`");
		expect(prompt).toContain("`/managed-skills/<skill-id>` (read-only)");
		expect(prompt).toContain("Final deliverables only: `<workspace-root>/outputs`");
		expect(prompt).toContain("Any `/workspace` path in a skill is a placeholder");
	});

	it("omits AESG routing when a required skill is unavailable to the model", () => {
		const prompt = formatSkillsForSystemPrompt([
			skill("AESG branding", "aesg-branding"),
			skill("CV Creator", "cv-creator"),
			skill("AESG Word documents", "docx"),
			skill("AESG PDF documents", "pdf"),
			skill("AESG PowerPoint presentations", "pptx"),
			skill("AESG Excel workbooks", "xlsx", true),
		]);

		expect(prompt).not.toContain("# AESG artifact workspace");
	});

	it("keeps format routing when the optional CV skill is unavailable", () => {
		const prompt = formatSkillsForSystemPrompt([
			skill("AESG branding", "aesg-branding"),
			skill("AESG Word documents", "docx"),
			skill("AESG PDF documents", "pdf"),
			skill("AESG PowerPoint presentations", "pptx"),
			skill("AESG Excel workbooks", "xlsx"),
		]);

		expect(prompt).toContain("# AESG artifact workspace");
		expect(prompt).not.toContain("For a CV or resume");
	});
});
