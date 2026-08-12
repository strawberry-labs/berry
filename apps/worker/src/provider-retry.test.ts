import { RouterClientError } from "@berry/router-client";
import { describe, expect, it } from "vitest";
import { classifyProviderFailure, isRetryableProviderFailure } from "./provider-retry.js";

describe("provider retry classification", () => {
  it.each([400, 401, 403, 404, 409, 422])("treats provider HTTP %i as permanent", (status) => {
    const error = new RouterClientError("provider rejected request", status, "{}", {
      code: "invalid_request",
      requestId: "brq_permanent",
    });

    expect(classifyProviderFailure(error)).toEqual({
      retryable: false,
      category: "permanent_client",
      status,
      code: "INVALID_REQUEST",
      requestId: "brq_permanent",
    });
    expect(isRetryableProviderFailure(error)).toBe(false);
  });

  it("does not retry an HTTP 400 even when its body describes a timeout", () => {
    const error = new RouterClientError("provider timed out validating tool_choice", 400, "{}", {
      code: "ETIMEDOUT",
    });
    expect(classifyProviderFailure(error)).toMatchObject({
      retryable: false,
      category: "permanent_client",
      status: 400,
    });
  });

  it.each([
    [408, "timeout"],
    [429, "rate_limit"],
    [500, "server"],
    [502, "server"],
    [503, "server"],
  ] as const)("retries provider HTTP %i", (status, category) => {
    expect(classifyProviderFailure(new RouterClientError("transient provider failure", status))).toMatchObject({
      retryable: true,
      category,
      status,
    });
  });

  it.each(["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT"])(
    "retries timeout code %s",
    (code) => {
      expect(classifyProviderFailure(Object.assign(new Error("request failed"), { code }))).toMatchObject({
        retryable: true,
        category: "timeout",
        code,
      });
    },
  );

  it.each(["ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "UND_ERR_SOCKET"])(
    "retries connection code %s, including nested fetch causes",
    (code) => {
      const cause = Object.assign(new Error("socket failed"), { code });
      const error = new TypeError("fetch failed", { cause });
      expect(classifyProviderFailure(error)).toMatchObject({ retryable: true, category: "connection", code });
    },
  );

  it("retries named timeout errors but not explicit cancellation", () => {
    expect(classifyProviderFailure(Object.assign(new Error("operation expired"), { name: "TimeoutError" })))
      .toMatchObject({ retryable: true, category: "timeout" });
    expect(classifyProviderFailure(Object.assign(new Error("operation aborted"), { name: "AbortError" })))
      .toMatchObject({ retryable: false, category: "aborted" });
  });

  it("keeps unknown failures retryable for backward-compatible durable recovery", () => {
    expect(classifyProviderFailure(new Error("unexpected parser failure")))
      .toEqual({ retryable: true, category: "unknown", status: undefined, code: undefined, requestId: undefined });
  });
});
