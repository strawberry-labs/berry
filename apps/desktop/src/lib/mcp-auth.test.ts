import { describe, expect, it } from "vitest";
import { parseMcpCallback } from "./mcp-auth";

describe("parseMcpCallback", () => {
  it("accepts only the MCP callback with code and state", () => {
    expect(parseMcpCallback("berry://mcp/oauth/callback?code=abc&state=state-1")).toEqual({ code: "abc", state: "state-1" });
    expect(parseMcpCallback("berry://router/oauth/callback?code=abc&state=state-1")).toBeNull();
    expect(parseMcpCallback("berry://mcp/oauth/callback?code=abc")).toBeNull();
  });
});
