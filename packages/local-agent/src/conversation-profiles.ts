import type { ConversationKind } from "@berry/shared";

const NORMAL_TASK_PROMPT = [
  "# Task presentation",
  "Keep the interaction clear and explain useful work in the task.",
  "You may use the full authorized tool set, including files, shell, browser, MCP, skills, and sub-agents. Programming work, code blocks, and repository changes are all supported within the same task experience.",
].join("\n");

/**
 * Legacy callers may still pass a persisted kind. It is intentionally ignored
 * so old records cannot create a second runtime or prompt experience.
 */
export function conversationProfilePrompt(_kind?: ConversationKind): string {
  return NORMAL_TASK_PROMPT;
}
