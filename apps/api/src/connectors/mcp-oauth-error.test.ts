import { describe, expect, it } from "vitest";
import { mcpOAuthStartError } from "./mcp-oauth-error.ts";
describe("MCP OAuth errors", () => {
  it("explains the observed endpoint mismatch with the same-origin endpoint", () => {
    const error = mcpOAuthStartError(new Error("Protected resource https://connect.aesg.com/mcp does not match expected https://connect.aesg.com/ (or origin)"), "https://connect.aesg.com/");
    expect(error.getStatus()).toBe(400);
    expect(error.getResponse()).toMatchObject({ code: "mcp_endpoint_mismatch", message: expect.stringContaining("https://connect.aesg.com/mcp") });
  });
  it("does not recommend a different host or expose credentials in upstream URLs", () => {
    for (const resource of ["https://evil.example/mcp", "https://connect.aesg.com/mcp?token=secret"]) {
      const error = mcpOAuthStartError(new Error(`Protected resource ${resource} does not match expected https://connect.aesg.com/`), "https://connect.aesg.com/");
      expect(JSON.stringify(error.getResponse())).not.toContain(resource);
    }
  });
  it("does not expose raw upstream errors", () => {
    const error = mcpOAuthStartError(new Error("private upstream token=secret"), "https://connect.aesg.com/mcp");
    expect(error.getStatus()).toBe(503);
    expect(JSON.stringify(error.getResponse())).not.toContain("secret");
  });
});
