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
	return lines.join("\n");
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}
