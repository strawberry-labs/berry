import { describe, expect, it } from "vitest";
import { BerryApiError } from "@berry/api-client";
import { actionErrorMessage, isAbort } from "./errors";

describe("actionErrorMessage", () => {
  it("keeps safe API messages and hides server failures", () => {
    expect(actionErrorMessage(new BerryApiError("x", 400, { message: "Name is taken" }), "fallback")).toBe("Name is taken");
    expect(actionErrorMessage(new BerryApiError("x", 400, { message: ["a", "b"] }), "fallback")).toBe("a. b");
    expect(actionErrorMessage(new BerryApiError("x", 403, {}), "fallback")).toBe("You do not have permission to perform this action.");
    expect(actionErrorMessage(new BerryApiError("x", 401, {}), "fallback")).toBe("You've been signed out of this server.");
    expect(actionErrorMessage(new BerryApiError("x", 500, { message: "stack trace" }), "fallback")).toBe("fallback");
  });

  it("shows the first validation issue instead of a JSON dump", () => {
    const zod = Object.assign(new Error("[...]"), { name: "ZodError", issues: [{ path: ["prompt"], message: "String must contain at least 1 character(s)" }] });
    expect(actionErrorMessage(zod, "fallback")).toBe("Instructions: String must contain at least 1 character(s)");
    const named = Object.assign(new Error("[...]"), { name: "ZodError", issues: [{ path: ["timezone"], message: "Use a valid IANA timezone, such as Asia/Dubai" }] });
    expect(actionErrorMessage(named, "fallback")).toBe("Use a valid IANA timezone, such as Asia/Dubai");
  });

  it("explains network failures and keeps plain error messages", () => {
    expect(actionErrorMessage(new TypeError("Network request failed"), "fallback")).toBe("Couldn't reach the server. Check your connection and try again.");
    expect(actionErrorMessage(new Error("Choose a valid time"), "fallback")).toBe("Choose a valid time");
    expect(actionErrorMessage("weird", "fallback")).toBe("fallback");
    expect(isAbort(Object.assign(new Error("x"), { name: "AbortError" }))).toBe(true);
    expect(isAbort(new Error("Upload aborted"))).toBe(true);
    expect(isAbort(new Error("nope"))).toBe(false);
  });
});
