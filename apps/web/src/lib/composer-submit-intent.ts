export type ComposerSubmitIntent = "send" | "queue" | "steer" | "ignore";

type ComposerSubmitEvent = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "isComposing" | "metaKey" | "repeat" | "shiftKey"
>;

export function resolveComposerSubmitIntent(
  working: boolean,
  event?: ComposerSubmitEvent | null,
): ComposerSubmitIntent {
  if (event?.isComposing || event?.repeat || event?.altKey || event?.shiftKey) return "ignore";
  const modifier = Boolean(event?.metaKey || event?.ctrlKey);
  if (modifier) return working ? "steer" : "ignore";
  return working ? "queue" : "send";
}
