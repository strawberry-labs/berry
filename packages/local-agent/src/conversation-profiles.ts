import type { ConversationKind } from "@berry/shared";

const PROFILE_PROMPTS: Record<ConversationKind, string> = {
  chat: [
    "# Chat presentation",
    "Keep the interaction thread-first and explain useful work in the conversation.",
    "You may use the full authorized tool set, including files, shell, browser, MCP, skills, and sub-agents. Presentation kind never changes permissions or sandbox policy.",
  ].join("\n"),
  code: [
    "# Code presentation",
    "Work end to end in the repository: inspect relevant code, make focused changes when asked, and verify the result with appropriate tools.",
    "The visible developer workspace is a presentation aid, not an additional permission tier.",
  ].join("\n"),
};

export function conversationProfilePrompt(kind: ConversationKind): string {
  return PROFILE_PROMPTS[kind];
}
