import { describe, expect, it } from "vitest";
import { modelDefaultEnforcement } from "./admin-catalog-screens";

describe("organization model defaults", () => {
  it("keeps every chat-default UI path overridable", () => {
    expect(modelDefaultEnforcement("chat", true)).toBe(false);
    expect(modelDefaultEnforcement("chat", false)).toBe(false);
  });

  it("preserves the existing enforcement choice for code defaults", () => {
    expect(modelDefaultEnforcement("code", true)).toBe(true);
    expect(modelDefaultEnforcement("code", false)).toBe(false);
  });
});
