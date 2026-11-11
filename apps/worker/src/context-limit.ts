import type { ProviderRetryClassification } from "@berry/shared";

export const CONTEXT_LIMIT_MESSAGE = "This chat has reached the model's context limit. Your chat history and files are saved. Start a new chat with the relevant files, or ask an administrator to compact this chat.";

const CONTEXT_LIMIT_CODES = new Set([
  "CONTEXT_LENGTH_EXCEEDED",
  "CONTEXT_WINDOW_EXCEEDED",
  "MAX_CONTEXT_LENGTH_EXCEEDED",
  "PROMPT_TOO_LONG",
  "INPUT_TOO_LONG",
]);

/** A changed, compacted request can recover these otherwise permanent 4xx failures. */
export function isContextLimitFailure(failure: Pick<ProviderRetryClassification, "code" | "status">): boolean {
  return (failure.status === undefined || [400, 413, 422].includes(failure.status))
    && CONTEXT_LIMIT_CODES.has(failure.code?.trim().toUpperCase() ?? "");
}
