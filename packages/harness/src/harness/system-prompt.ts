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
	return [
		"# AESG Artifact Skill Routing",
		"The AESG artifact skills are required workflow components, not optional suggestions.",
		`- Before creating, editing, converting, or exporting any Office or PDF deliverable, activate the skill named ${named("aesg-branding")} and every matching format skill. Activate them before planning the artifact or calling file-generation tools.`,
		`- Word, DOCX, document, report, proposal, letter, brief, policy, and memo deliverables route to ${named("aesg-branding")} then ${named("docx")}.`,
		`- PDF deliverables route to ${named("aesg-branding")} then ${named("pdf")}.`,
		`- PowerPoint, PPTX, presentation, slide, slide-deck, pitch-deck, and workshop-deck deliverables route to ${named("aesg-branding")} then ${named("pptx")}.`,
		`- Excel, XLSX, spreadsheet, workbook, register, tracker, schedule, and tabular-dashboard deliverables route to ${named("aesg-branding")} then ${named("xlsx")}.`,
		"- If the user requests several output formats, activate every matching format skill. If a generic professional document has no requested file format, default to DOCX.",
		`- For reading, inspecting, or analysing an existing file without producing a new artifact, activate its format skill; add ${named("aesg-branding")} when the answer must assess branding or when a branded file will be returned.`,
		"- Do not bypass the retained AESG templates or rebuild their branding with ad-hoc styling when the skills provide a canonical generator or template.",
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
