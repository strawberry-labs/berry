import { BadRequestException } from "@nestjs/common";
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

export function parseAgentSkillMarkdown(raw: string): AgentSkillMetadata {
  const content = raw.replace(/\r\n?/g, "\n");
  if (!content.startsWith("---\n")) throw new BadRequestException("SKILL.md must begin with YAML frontmatter");
  const delimiter = content.indexOf("\n---\n", 4);
  const eofDelimiter = content.endsWith("\n---") ? content.length - 4 : -1;
  const end = delimiter >= 0 ? delimiter : eofDelimiter;
  if (end < 0) throw new BadRequestException("SKILL.md frontmatter must end with ---");

  let parsed: unknown;
  try {
    parsed = parseYaml(content.slice(4, end));
  } catch (cause) {
    throw new BadRequestException(`SKILL.md contains invalid YAML: ${cause instanceof Error ? cause.message : "parse failed"}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new BadRequestException("SKILL.md frontmatter must be a YAML mapping");
  const fields = parsed as Record<string, unknown>;
  const name = requiredString(fields.name, "name", 64);
  const description = requiredString(fields.description, "description", 1024);
  if (!SKILL_NAME.test(name)) throw new BadRequestException("Skill name must use lowercase letters, numbers, and single hyphens only");
  if (fields.metadata !== undefined) {
    if (!fields.metadata || typeof fields.metadata !== "object" || Array.isArray(fields.metadata)) throw new BadRequestException("Skill metadata must be a mapping");
    for (const [key, value] of Object.entries(fields.metadata as Record<string, unknown>)) {
      if (typeof value !== "string") throw new BadRequestException(`Skill metadata.${key} must be a string`);
    }
  }
  return {
    name,
    description,
    version: optionalString(fields.version, "version", 64),
    license: optionalString(fields.license, "license", 1024),
    compatibility: optionalString(fields.compatibility, "compatibility", 500),
    allowedTools: optionalString(fields["allowed-tools"], "allowed-tools", 4096),
  };
}

function requiredString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw new BadRequestException(`SKILL.md frontmatter requires ${field}`);
  const result = value.trim();
  if (result.length > max) throw new BadRequestException(`${field} must be at most ${max} characters`);
  return result;
}

function optionalString(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new BadRequestException(`${field} must be a string`);
  const result = value.trim();
  if (result.length > max) throw new BadRequestException(`${field} must be at most ${max} characters`);
  return result || null;
}
