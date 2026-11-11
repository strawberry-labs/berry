import { describe, expect, it } from "vitest";
import { buildSiteContentSecurityPolicy, storageConnectOrigins } from "./site-csp.ts";

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
    expect(policy).toContain("frame-src 'self' https://accounts.google.com");
    expect(policy).toContain("https://sandbox.example.test");
    expect(policy).toContain("worker-src 'self' blob:");
    expect(policy).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(policy).not.toContain("connect-src 'self' https:;");
  });
});

it("allows only the configured storage origin for direct uploads and downloads", () => {
  expect(storageConnectOrigins({ bucket: "private-files", region: "eu-west-1" })).toEqual(["https://private-files.s3.eu-west-1.amazonaws.com"]);
  expect(storageConnectOrigins({ bucket: "private.files", region: "eu-west-1" })).toEqual(["https://s3.eu-west-1.amazonaws.com"]);
  expect(storageConnectOrigins({ endpoint: "https://storage.test:9000/path" })).toEqual(["https://storage.test:9000"]);
  expect(storageConnectOrigins({ endpoint: "javascript:alert(1)" })).toEqual([]);
  expect(storageConnectOrigins({})).toEqual([]);
});

it("allows the exact accelerated bucket origin while retaining regular signed URLs", () => {
  expect(storageConnectOrigins({ bucket: "private-files", region: "eu-west-1", accelerate: true })).toEqual(["https://private-files.s3.eu-west-1.amazonaws.com", "https://private-files.s3-accelerate.amazonaws.com"]);
});
