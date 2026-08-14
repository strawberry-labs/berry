import { describe, expect, it } from "vitest";
import { DEFERRED_SKILL_RESOURCE_INSTRUCTIONS } from "@berry/shared";
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
		expect(prompt).toContain("`activate_skill` returns the exact staged skill directory");
		expect(prompt).toContain("Final deliverables only: `<workspace-root>/outputs`");
		expect(prompt).toContain("Any `/workspace` path in a skill is a placeholder");
		expect(prompt).toContain(DEFERRED_SKILL_RESOURCE_INSTRUCTIONS);
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

	it("recognizes database-backed organization skills by their invocation name", () => {
		const organizationSkill = (name: string, recordId: string): Skill => ({
			name,
			description: `${name} description`,
			content: `${name} instructions`,
			filePath: `/organization-skills/${recordId}/SKILL.md`,
		});
		const prompt = formatSkillsForSystemPrompt([
			organizationSkill("aesg-branding", "orgcap-branding"),
			organizationSkill("cv-creator", "orgcap-cv"),
			organizationSkill("docx", "orgcap-docx"),
			organizationSkill("pdf", "orgcap-pdf"),
			organizationSkill("pptx", "orgcap-pptx"),
			organizationSkill("xlsx", "orgcap-xlsx"),
		]);

		expect(prompt).toContain("# AESG artifact workspace");
		expect(prompt).toContain('activate "aesg-branding" and "cv-creator"');
	});
});
