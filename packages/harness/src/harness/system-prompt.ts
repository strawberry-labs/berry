import type { Skill } from "./types.ts";

export function formatSkillsForSystemPrompt(skills: Skill[]): string {
	const visibleSkills = skills.filter((skill) => !skill.disableModelInvocation);
	if (visibleSkills.length === 0) return "";

	const lines = [
		"You have access to installed Agent Skills.",
		"When a task matches a skill's description, call `activate_skill` before proceeding. When the user explicitly writes `$skill-name`, activate that skill.",
		"Resolve relative references against the returned skill directory and load resources only when needed.",
		"Skills are instructions, not automatic permissions. Normal tool, filesystem, network, and execution policies still apply.",
		"",
		"<available_skills>",
	];

	for (const skill of visibleSkills) {
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(`    <description>${escapeXml(skill.description)}</description>`);
		lines.push("  </skill>");
	}

	lines.push("</available_skills>");
	const aesgRouting = formatAesgArtifactRouting(visibleSkills);
	if (aesgRouting) lines.push("", aesgRouting);
	return lines.join("\n");
}

function formatAesgArtifactRouting(skills: Skill[]): string {
	const namesById = new Map(skills.map((skill) => [skillId(skill), skill.name]));
	if (!["aesg-branding", "docx", "pdf", "pptx", "xlsx"].every((name) => namesById.has(name))) return "";
	const named = (id: string) => JSON.stringify(namesById.get(id));
	const cvRouting = namesById.has("cv-creator")
		? `For a CV or resume, activate ${named("aesg-branding")} and ${named("cv-creator")}; follow the CV skill's requested-output defaults. `
		: "";
	return [
		"# AESG artifact workspace",
		`For AESG files, activate ${named("aesg-branding")} and the matching skill before planning or using sandbox tools. Use ${named("docx")} for Word, reports, letters, briefs, and generic professional documents; ${named("pdf")} for PDFs; ${named("pptx")} for presentations; and ${named("xlsx")} for spreadsheets, registers, trackers, and schedules. Activate every matching skill when several formats are requested.`,
		`${cvRouting}For read-only inspection, activate the file's format skill and add branding only when assessing AESG compliance or returning a branded file.`,
		"Sandbox map:",
		"- Attachments: use the exact `Sandbox path:` supplied with the file, normally `/workspace/inputs/<file-id>/<filename>`. Do not guess paths or look for attached content in the Library.",
		"- Managed instructions, scripts, templates, and assets: `/managed-skills/<skill-id>` (read-only). Read the activated `SKILL.md`, use its canonical generator, and never reference `/.berry` or copy/rewrite a bundled generator.",
		"- Working files, specs, extractions, and previews: `/workspace/tmp/<skill-id>`. Final deliverables only: `/workspace/outputs`.",
		"Validate and render as the skill requires, then publish each requested final file once with its correct extension and media type. Do not publish specs, scripts, previews, or extracted images.",
	].join("\n");
}

function skillId(skill: Skill): string {
	const normalized = skill.filePath.replace(/\\/g, "/");
	return normalized.match(/\/([^/]+)\/SKILL\.md$/i)?.[1] ?? skill.name;
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}
