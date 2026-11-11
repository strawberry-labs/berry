import { describe, expect, it } from "vitest";
import { CONTEXT_LIMIT_MESSAGE, isContextLimitFailure } from "./context-limit.js";

describe("context limit failures", () => {
  it.each(["CONTEXT_LENGTH_EXCEEDED", "context_length_exceeded", "CONTEXT_WINDOW_EXCEEDED", "MAX_CONTEXT_LENGTH_EXCEEDED", "PROMPT_TOO_LONG", "INPUT_TOO_LONG"])("recognizes %s without enabling unchanged transport retries", (code) => {
    expect(isContextLimitFailure({ status: 400, code })).toBe(true);
  });
  it.each([401, 402, 403, 429, 500])("does not treat HTTP %s as recoverable context overflow", (status) => {
    expect(isContextLimitFailure({ status, code: "CONTEXT_LENGTH_EXCEEDED" })).toBe(false);
  });
  it("leaves ordinary malformed requests alone and explains preserved history", () => {
    expect(isContextLimitFailure({ status: 400, code: "INVALID_REQUEST" })).toBe(false);
    expect(isContextLimitFailure({ status: 400, code: undefined })).toBe(false);
    expect(CONTEXT_LIMIT_MESSAGE).toContain("history and files are saved");
    expect(CONTEXT_LIMIT_MESSAGE).not.toContain("configuration");
  });
});
