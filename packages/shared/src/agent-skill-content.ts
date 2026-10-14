import { parse as parseYaml } from "yaml";

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type AgentSkillMetadata = {
  name: string;
  description: string;
  version: string | null;
  license: string | null;
  compatibility: string | null;
  allowedTools: string | null;
};

// Shown with structural errors so a whole valid header can be written at once (H-018).
const FRONTMATTER_EXAMPLE = "Start SKILL.md with:\n---\nname: my-skill\ndescription: What the skill does and when to use it.\n---\n(name: lowercase letters, numbers and single hyphens, at most 64 characters; description: at most 1024 characters)";

/** Parse and validate the portable SKILL.md contract shared by API and Worker. */
export function parseAgentSkillMarkdown(raw: string): AgentSkillMetadata {
  const content = raw.replace(/\r\n?/g, "\n");
  if (!content.startsWith("---\n")) throw new Error(`SKILL.md must begin with YAML frontmatter. ${FRONTMATTER_EXAMPLE}`);
  const delimiter = content.indexOf("\n---\n", 4);
  const eofDelimiter = content.endsWith("\n---") ? content.length - 4 : -1;
  const end = delimiter >= 0 ? delimiter : eofDelimiter;
  if (end < 0) throw new Error(`SKILL.md frontmatter must end with ---. ${FRONTMATTER_EXAMPLE}`);

  let parsed: unknown;
  try {
    parsed = parseYaml(content.slice(4, end));
  } catch (cause) {
    throw new Error(`SKILL.md contains invalid YAML: ${cause instanceof Error ? cause.message : "parse failed"}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`SKILL.md frontmatter must be a YAML mapping. ${FRONTMATTER_EXAMPLE}`);
  }
  // Report every field problem together instead of one per save attempt (H-018).
  const problems: string[] = [];
  const check = <T>(read: () => T): T | null => {
    try {
      return read();
    } catch (cause) {
      problems.push(cause instanceof Error ? cause.message : String(cause));
      return null;
    }
  };
  const fields = parsed as Record<string, unknown>;
  const name = check(() => requiredString(fields.name, "name", 64));
  const description = check(() => requiredString(fields.description, "description", 1024));
  if (name !== null && !SKILL_NAME.test(name)) {
    problems.push("Skill name must use lowercase letters, numbers, and single hyphens only");
  }
  if (fields.metadata !== undefined) {
    if (!fields.metadata || typeof fields.metadata !== "object" || Array.isArray(fields.metadata)) {
      problems.push("Skill metadata must be a mapping");
    } else {
      for (const [key, value] of Object.entries(fields.metadata as Record<string, unknown>)) {
        if (typeof value !== "string") problems.push(`Skill metadata.${key} must be a string`);
      }
    }
  }
  const version = check(() => optionalString(fields.version, "version", 64));
  const license = check(() => optionalString(fields.license, "license", 1024));
  const compatibility = check(() => optionalString(fields.compatibility, "compatibility", 500));
  const allowedTools = check(() => optionalString(fields["allowed-tools"], "allowed-tools", 4096));
  if (problems.length === 1) throw new Error(problems[0]);
  if (problems.length > 1) throw new Error(`SKILL.md has ${problems.length} problems: ${problems.join("; ")}`);
  return {
    name: name!,
    description: description!,
    version,
    license,
    compatibility,
    allowedTools,
  };
}

function requiredString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`SKILL.md frontmatter requires ${field}`);
  const result = value.trim();
  if (result.length > max) throw new Error(`${field} must be at most ${max} characters`);
  return result;
}

function optionalString(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const result = value.trim();
  if (result.length > max) throw new Error(`${field} must be at most ${max} characters`);
  return result || null;
}
