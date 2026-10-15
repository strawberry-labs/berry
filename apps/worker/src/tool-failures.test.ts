import { describe, expect, it } from "vitest";
import { McpToolError } from "@berry/local-agent/mcp";
import { classifyToolFailure, storedToolFailure, type ToolFailureCategory } from "./tool-failures.js";

// Strings recorded by the production evidence audit (H-003, H-006), masked.
describe("tool failure classes (H-003, H-006)", () => {
  it.each([
    ["Connector token is invalid or expired", "credentials"],
    ['Streamable HTTP error: Error POSTing to endpoint: {"error":"invalid_token","error_description":"<redacted>"}', "credentials"],
    ["Google connection for Google Workspace has expired; reconnect it in Settings → Connectors", "credentials"],
    ["MCP server BerryCrawl timed out after 10000ms", "transient"],
    ["search_queries must be a non-empty list of non-empty strings.", "invalid_input"],
    ["No proxy provider configured for stealth", "configuration"],
    ["Scrape failed: SCRAPE_PROXY_UNAVAILABLE", "transient"],
    ["Scrape failed: SCRAPE_CHALLENGE_DETECTED", "missing_resource"],
    ["Drive files are limited to 100 MB", "invalid_input"],
    ["Google API 400: This operation is not supported for this document. The document must not be an Office file.", "invalid_input"],
    ["[not_found] path not found: lstat /workspace/missing no such file or directory", "missing_resource"],
    ["edits[0].oldText was not found in /workspace/notes.md", "invalid_input"],
    ["Sandbox reads must remain under /workspace or /tmp", "invalid_input"],
    ["Vision inspection was not admitted for this turn", "configuration"],
    ["MCP tool Drive:read is unavailable because its definition changed after administrator review", "configuration"],
    ["Provider request failed with 502", "transient"],
    ["ModuleNotFoundError: No module named 'office_converter'", "missing_resource"],
    ["Image provider: insufficient_quota for this account", "credit_exhausted"],
    ["Google Workspace is not connected for this user", "credentials"],
    ["The terminal is not connected to a running sandbox", "unknown"],
    ["Something unexpected happened", "unknown"],
  ] as const)("classifies %j as %s", (message, category) => {
    const failure = classifyToolFailure(new Error(message), { changesState: false });
    expect(failure.category).toBe(category satisfies ToolFailureCategory);
    expect(failure.action.length).toBeGreaterThan(20);
    expect(failure.deterministic).toBe(
      ["invalid_input", "missing_resource", "configuration", "credentials", "credit_exhausted"].includes(category),
    );
  });

  it("uses HTTP statuses before wording", () => {
    const withStatus = (status: number) => Object.assign(new Error("Request failed"), { status });
    expect(classifyToolFailure(withStatus(401), { changesState: false }).category).toBe("credentials");
    expect(classifyToolFailure(withStatus(402), { changesState: false }).category).toBe("credit_exhausted");
    expect(classifyToolFailure(withStatus(403), { changesState: false }).category).toBe("configuration");
    expect(classifyToolFailure(withStatus(404), { changesState: false }).category).toBe("missing_resource");
    expect(classifyToolFailure(withStatus(422), { changesState: false }).category).toBe("invalid_input");
    expect(classifyToolFailure(withStatus(503), { changesState: false })).toMatchObject({ category: "transient", status: 503 });
  });

  it("reads codes kept by the MCP boundary", () => {
    const proxy = new McpToolError("Scrape failed", { error: { code: "SCRAPE_PROXY_UNAVAILABLE", message: "proxy tunnel failed" } });
    const token = new McpToolError("Upstream rejected the call", { error: "invalid_token", error_description: "<redacted>" });
    expect(classifyToolFailure(proxy, { changesState: false })).toMatchObject({ category: "transient", code: "SCRAPE_PROXY_UNAVAILABLE" });
    expect(classifyToolFailure(token, { changesState: false })).toMatchObject({ category: "credentials", code: "invalid_token" });
  });

  it("treats an interrupted change-making call as an unknown outcome unless the request never left", () => {
    expect(classifyToolFailure(new Error("socket hang up"), { changesState: true })).toMatchObject({
      category: "unknown_outcome", outcome: "unknown", deterministic: false,
    });
    expect(classifyToolFailure(new Error("tool timed out"), { changesState: true, timedOut: true }).category).toBe("unknown_outcome");
    const refused = Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:443"), { code: "ECONNREFUSED" });
    expect(classifyToolFailure(refused, { changesState: true })).toMatchObject({ category: "transient", outcome: "not_applied" });
    expect(classifyToolFailure(new Error("socket hang up"), { changesState: false }).category).toBe("transient");
    // A workspace that could not be reached ran nothing (H-009).
    const unreachable = new Error("The workspace is temporarily unreachable (connect ETIMEDOUT 10.0.0.1:443). Nothing was run and no files were changed; retry this step.");
    expect(classifyToolFailure(unreachable, { changesState: true })).toMatchObject({ category: "transient", outcome: "not_applied" });
    const refusedSandbox = new Error("The sandbox provider refused access (401: Invalid API key). Nothing was run. An administrator must check the sandbox provider configuration; retrying will not help.");
    expect(classifyToolFailure(refusedSandbox, { changesState: true }).category).toBe("configuration");
  });

  it("round-trips the stored class from a failed step's output", () => {
    const failure = classifyToolFailure(new Error("Connector token is invalid or expired"), { changesState: false });
    expect(storedToolFailure({ failure: JSON.parse(JSON.stringify(failure)) })).toEqual(failure);
    expect(storedToolFailure({ failure: { category: "made_up" } })).toBeNull();
    expect(storedToolFailure(null)).toBeNull();
  });
});
