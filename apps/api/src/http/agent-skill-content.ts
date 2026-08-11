import { BadRequestException } from "@nestjs/common";
import {
  parseAgentSkillMarkdown as parseSharedAgentSkillMarkdown,
  type AgentSkillMetadata,
} from "@berry/shared";

export type { AgentSkillMetadata } from "@berry/shared";

export function parseAgentSkillMarkdown(raw: string): AgentSkillMetadata {
  try {
    return parseSharedAgentSkillMarkdown(raw);
  } catch (cause) {
    if (cause instanceof BadRequestException) throw cause;
    throw new BadRequestException(cause instanceof Error ? cause.message : "SKILL.md is invalid");
  }
}
