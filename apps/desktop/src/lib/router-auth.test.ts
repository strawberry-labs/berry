import { describe, expect, it } from "vitest";
import { parseRouterCallback } from "./router-auth";

describe("parseRouterCallback", () => {
  it("accepts only the configured Router OAuth callback with code and state", () => {
    expect(parseRouterCallback("berry://router/oauth/callback?code=abc&state=state_1")).toEqual({ code: "abc", state: "state_1" });
    expect(parseRouterCallback("berry://router/oauth/callback?code=abc")).toBeNull();
    expect(parseRouterCallback("berry://other/oauth/callback?code=abc&state=state_1")).toBeNull();
    expect(parseRouterCallback("https://router.example.test/callback?code=abc&state=state_1")).toBeNull();
  });
});
