import type { Message, MessagePart } from "@berry/shared";

export function isContinuableAssistantTurn(messages: Message[]): boolean {
  const latestAssistant = messages.at(-1);
  return latestAssistant?.status === "failed" || latestAssistant?.status === "cancelled";
}

export function isImageMessagePart(part: MessagePart): boolean {
  if (part.kind !== "image") return false;
  if (typeof part.content === "string") {
    return part.content.startsWith("data:") || part.content.startsWith("https://") || part.content.startsWith("http://") || part.content.startsWith("/");
  }
  return Boolean(part.content && typeof part.content === "object" && !Array.isArray(part.content) && typeof part.content.src === "string");
}
