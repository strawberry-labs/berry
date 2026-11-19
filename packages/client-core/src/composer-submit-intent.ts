export type ComposerSubmitIntent = "send" | "queue" | "steer" | "ignore";

/** The keyboard fields that matter; a DOM KeyboardEvent satisfies it. */
type ComposerSubmitEvent = {
  altKey?: boolean;
  ctrlKey?: boolean;
  isComposing?: boolean;
  metaKey?: boolean;
  repeat?: boolean;
  shiftKey?: boolean;
};

export function resolveComposerSubmitIntent(
  working: boolean,
  event?: ComposerSubmitEvent | null,
): ComposerSubmitIntent {
  if (event?.isComposing || event?.repeat || event?.altKey || event?.shiftKey) return "ignore";
  const modifier = Boolean(event?.metaKey || event?.ctrlKey);
  if (modifier) return working ? "steer" : "ignore";
  return working ? "queue" : "send";
}
