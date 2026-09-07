import { describe, expect, it } from "vitest";
import { BerryApiError } from "@berry/api-client";
import { actionErrorMessage } from "./action-error";
describe("action errors", () => {
  it("uses actionable endpoint errors instead of the generic HTTP message", () => {
    expect(actionErrorMessage(new BerryApiError("Berry API request failed with 400", 400, { message: "Use the MCP endpoint", code: "mcp_endpoint_mismatch" }), "Retry")).toBe("Use the MCP endpoint");
  });
  it("hides internal server details but permits the known safe OAuth response", () => {
    expect(actionErrorMessage(new BerryApiError("Berry API request failed with 500", 500, { message: "database secret" }), "Please retry")).toBe("Please retry");
    expect(actionErrorMessage(new BerryApiError("503", 503, { code: "mcp_oauth_unavailable", message: "Check the MCP URL" }), "Retry")).toBe("Check the MCP URL");
  });
  it("replaces generic access errors and shows field validation messages", () => {
    expect(actionErrorMessage(new BerryApiError("401", 401, { message: "Unauthorized" }), "Retry")).toContain("Sign in again");
    expect(actionErrorMessage(new BerryApiError("403", 403, { message: "Forbidden" }), "Retry")).toContain("permission");
    expect(actionErrorMessage(new BerryApiError("400", 400, { message: ["Run timeout must be positive", "Invalid domain"] }), "Retry")).toBe("Run timeout must be positive. Invalid domain");
  });

});
