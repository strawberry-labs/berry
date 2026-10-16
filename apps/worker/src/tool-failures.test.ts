import { describe, expect, it } from "vitest";
import { McpToolError } from "@berry/local-agent/mcp";
import { classifyToolFailure, storedToolFailure, type ToolFailureCategory } from "./tool-failures.js";
import { IMAGE_PROVIDER_CREDIT_EXHAUSTED_MESSAGE } from "./provider-credits.js";

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

  it("tells the model to send the user to support when a provider is out of credit (H-005)", () => {
    const failure = classifyToolFailure(new Error(`${IMAGE_PROVIDER_CREDIT_EXHAUSTED_MESSAGE} (HTTP 402: Payment Required)`), { changesState: false });
    expect(failure.category).toBe("credit_exhausted");
    expect(failure.action).toContain("contact support or their administrator");
    expect(failure.action).not.toContain("change the provider");
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

  it("treats a server error on a change-making call as an unknown outcome and a rejection as not applied", () => {
    const withStatus = (status: number, message = "Request failed") => Object.assign(new Error(message), { status });
    // The target may have applied the change before it answered with a server error.
    for (const error of [
      withStatus(500, "Internal Server Error"),
      withStatus(503),
      new McpToolError("The record service failed", { error: { status: 500, message: "internal error" } }),
      new McpToolError("Upstream gateway failed", { status: 504 }),
      new Error("The record service answered 500 Internal Server Error"),
    ]) {
      expect(classifyToolFailure(error, { changesState: true })).toMatchObject({ category: "unknown_outcome", outcome: "unknown" });
      expect(classifyToolFailure(error, { changesState: false })).toMatchObject({ category: "transient", outcome: "not_applied" });
    }
    // A rate limit or a client error refuses the change before it is made.
    expect(classifyToolFailure(withStatus(429, "Too Many Requests"), { changesState: true })).toMatchObject({ category: "transient", outcome: "not_applied" });
    expect(classifyToolFailure(new McpToolError("Slow down", { error: { status: 429 } }), { changesState: true })).toMatchObject({ category: "unknown_outcome", outcome: "unknown" });
    expect(classifyToolFailure(withStatus(409, "A record with this title already exists"), { changesState: true })).toMatchObject({ category: "invalid_input", outcome: "not_applied" });
  });

  it("does not treat a finished command as proof that its change was not made", () => {
    // curl can exit after the server accepted its POST but before the response arrived.
    const timedOut = new Error("curl: (28) Operation timed out after 100 milliseconds with 0 bytes received\n\nCommand exited with code 28");
    expect(classifyToolFailure(timedOut, { changesState: true })).toMatchObject({ category: "unknown_outcome", outcome: "unknown" });
    expect(classifyToolFailure(timedOut, { changesState: false })).toMatchObject({ category: "transient", outcome: "not_applied" });
    // A command's own output cannot claim that nothing ran; only Berry's report from before dispatch can (H-009).
    const claimed = new Error("Nothing was run\ncurl: (28) Operation timed out\n\nCommand exited with code 28");
    expect(classifyToolFailure(claimed, { changesState: true }).outcome).toBe("unknown");
    const unreachable = new Error("The workspace is temporarily unreachable (connect ETIMEDOUT 10.0.0.1:443). Nothing was run and no files were changed; retry this step.");
    expect(classifyToolFailure(unreachable, { changesState: true }).outcome).toBe("not_applied");
  });

  it("keeps the failure class of a command that ran separate from what it may have changed", () => {
    // Whatever a command printed, it ran: an earlier part may already have taken effect.
    for (const [output, category] of [
      ["created", "unknown"],
      ["created\nTraceback (most recent call last):\nValueError: bad row", "unknown"],
      ["created\ncat: /workspace/receipt.json: No such file or directory", "missing_resource"],
      ["created\ncurl: (22) The requested URL returned error: 401 Unauthorized", "credentials"],
    ] as const) {
      const ran = new Error(`${output}\n\nCommand exited with code 1`);
      expect(classifyToolFailure(ran, { changesState: true })).toMatchObject({ category, outcome: "unknown" });
      expect(classifyToolFailure(ran, { changesState: false })).toMatchObject({ category, outcome: "not_applied" });
    }
  });

  it("treats an unrecognised failure of a change as uncertain, and a recognised rejection as not applied", () => {
    expect(classifyToolFailure(new Error("Something unexpected happened"), { changesState: true })).toMatchObject({ category: "unknown", outcome: "unknown" });
    expect(classifyToolFailure(new Error("Something unexpected happened"), { changesState: false }).outcome).toBe("not_applied");
    expect(classifyToolFailure(new McpToolError("Rejected", { error: { status: 409, message: "A record with this title already exists" } }), { changesState: true }))
      .toMatchObject({ category: "invalid_input", outcome: "unknown" });
    expect(classifyToolFailure(new Error("MCP tool mcp__Records__create is not enabled for this turn"), { changesState: true }))
      .toMatchObject({ category: "configuration", outcome: "not_applied" });
  });

  it("requires executor evidence of a transport refusal after dispatch", () => {
    const dispatched = (error: Error) => Object.assign(error, { toolCallPhase: "dispatched" });
    // The MCP SDK checks a result against the tool's output schema after the tool ran.
    const output = dispatched(new Error("MCP error -32602: Structured content does not match the tool's output schema: data/id must be string"));
    expect(classifyToolFailure(output, { changesState: true })).toMatchObject({ category: "invalid_input", outcome: "unknown" });
    expect(classifyToolFailure(output, { changesState: false }).outcome).toBe("not_applied");
    // Wording such as "required" or "invalid" is not a refusal.
    expect(classifyToolFailure(dispatched(new McpToolError("title is required and must be unique", null)), { changesState: true }).outcome).toBe("unknown");
    // A status in the executed tool result is not transport evidence.
    expect(classifyToolFailure(dispatched(new McpToolError("Duplicate", { error: { status: 409 } })), { changesState: true }))
      .toMatchObject({ category: "invalid_input", outcome: "unknown" });
    expect(classifyToolFailure(dispatched(Object.assign(new Error("Streamable HTTP error: Error POSTing to endpoint (HTTP 401): invalid_token"), { code: 401 })), { changesState: true }))
      .toMatchObject({ category: "credentials", outcome: "unknown" });
    // A server that was never reached ran nothing.
    expect(classifyToolFailure(Object.assign(new Error("MCP server records timed out after 10000ms"), { toolCallPhase: "not_sent" }), { changesState: true }))
      .toMatchObject({ category: "transient", outcome: "not_applied" });
  });

  it("does not read a code or wording that a call's target returned as proof that nothing was applied", () => {
    // The server saved the record, then a dependency it uses failed (H-003).
    for (const [code, category] of [["RATE_LIMIT", "unknown_outcome"], ["ECONNREFUSED", "unknown"]] as const) {
      const error = new McpToolError("The record was saved, but updating its search index failed", {
        error: { code, message: "The record was saved, but updating its search index failed" },
      });
      expect(classifyToolFailure(error, { changesState: true })).toMatchObject({ category, outcome: "unknown", code });
      expect(classifyToolFailure(error, { changesState: false }).outcome).toBe("not_applied");
    }
    expect(classifyToolFailure(new McpToolError("Nothing was run", null), { changesState: true }).outcome).toBe("unknown");
    // A shell command the sandbox received may have run, whatever its error says.
    const sent = Object.assign(new Error("invalid schema in post-processing"), { toolCallPhase: "dispatched" });
    expect(classifyToolFailure(sent, { changesState: true }).outcome).toBe("unknown");
    // A result status can describe a failed sub-operation after an applied write.
    expect(classifyToolFailure(new McpToolError("Slow down", { error: { code: "RATE_LIMIT", status: 429 } }), { changesState: true }))
      .toMatchObject({ category: "unknown_outcome", outcome: "unknown" });
    const notSent = Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:443"), { code: "ECONNREFUSED", toolCallPhase: "not_sent" });
    expect(classifyToolFailure(notSent, { changesState: true })).toMatchObject({ category: "transient", outcome: "not_applied" });
  });

  it("recognises the SDK's output checks in a stored error, which has no phase", () => {
    for (const message of [
      "MCP error -32602: Structured content does not match the tool's output schema: data/id must be string",
      "MCP error -32600: Tool create_record has an output schema but did not return structured content",
      "MCP error -32602: Failed to validate structured content: schema is invalid",
    ]) expect(classifyToolFailure(new Error(message), { changesState: true }).outcome).toBe("unknown");
    // Other stored wording is classified as before.
    expect(classifyToolFailure(new Error("title must not be empty"), { changesState: true }).outcome).toBe("not_applied");
  });

  it.each([400, 401, 402, 403, 404, 409, 422, 429])("does not infer non-application from a tool result's %i status", (status) => {
    const result = new McpToolError("Saved; post-processing failed", { error: { status } });
    expect(classifyToolFailure(result, { changesState: true }).outcome).toBe("unknown");
    expect(classifyToolFailure(result, { changesState: false }).outcome).toBe("not_applied");
    const refused = Object.assign(new Error("HTTP request refused"), { status, toolCallPhase: "rejected" });
    expect(classifyToolFailure(refused, { changesState: true }).outcome).toBe("not_applied");
    const delivery = Object.assign(new Error("Image delivery failed", { cause: Object.assign(
      new Error("Nothing was run"), { status, toolCallPhase: "not_sent" },
    ) }), { toolCallPhase: "dispatched" });
    expect(classifyToolFailure(delivery, { changesState: true }).outcome).toBe("unknown");
  });

  it("round-trips the stored class from a failed step's output", () => {
    const failure = classifyToolFailure(new Error("Connector token is invalid or expired"), { changesState: false });
    expect(storedToolFailure({ failure: JSON.parse(JSON.stringify(failure)) })).toEqual(failure);
    expect(storedToolFailure({ failure: { category: "made_up" } })).toBeNull();
    expect(storedToolFailure(null)).toBeNull();
  });
});
