import { describe, expect, it } from "vitest";
import { buildSiteContentSecurityPolicy } from "./site-csp.ts";

describe("site CSP", () => {
  it("uses a per-response nonce and narrow production source lists", () => {
    const policy = buildSiteContentSecurityPolicy({
      nonce: "nonce123",
      connectOrigins: ["https://api.example.test"],
      imageOrigins: ["https://files.example.test"],
      frameSources: ["https://sandbox.example.test"],
    });
    expect(policy).toContain("script-src 'self' 'nonce-nonce123'");
    expect(policy).toContain("script-src-attr 'none'");
    expect(policy).toContain("style-src 'self'; style-src-elem 'self'; style-src-attr 'unsafe-inline'");
    expect(policy).toContain("connect-src 'self' https://api.example.test");
    expect(policy).toContain("img-src 'self' data: blob: https://*.googleusercontent.com https://files.example.test");
    expect(policy).toContain("worker-src 'self' blob:");
    expect(policy).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(policy).not.toContain("connect-src 'self' https:;");
  });
});
