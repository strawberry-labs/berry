import { describe, expect, it } from "vitest";
import { modelDefaultEnforcement, saveNewChatDefaultSafely } from "./admin-catalog-screens";

describe("organization model defaults", () => {
  it("keeps every chat-default UI path overridable", () => {
    expect(modelDefaultEnforcement("chat", true)).toBe(false);
    expect(modelDefaultEnforcement("chat", false)).toBe(false);
  });

  it("preserves the existing enforcement choice for code defaults", () => {
    expect(modelDefaultEnforcement("code", true)).toBe(true);
    expect(modelDefaultEnforcement("code", false)).toBe(false);
  });

  it("turns a rejected new-chat default request into visible feedback", async () => {
    await expect(saveNewChatDefaultSafely(async () => {
      throw new Error("Provider is unavailable");
    })).resolves.toEqual({ ok: false, error: "Provider is unavailable" });

    await expect(saveNewChatDefaultSafely(async () => {
      throw new Error("");
    })).resolves.toEqual({
      ok: false,
      error: "Could not save the default model. Try again.",
    });
  });
});
