import { describe, expect, it } from "vitest";
import { isLocalNetworkHost, validateMobileConnection } from "./connections";

describe("mobile connection validation", () => {
  it("allows HTTPS Berry account connections with push enabled", () => {
    const result = validateMobileConnection({ kind: "berry-account", apiBaseUrl: "https://api.berry.test", sessionToken: "session" });
    expect(result.pushAvailable).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("allows LAN HTTP endpoints with explicit plaintext and no-push warnings", () => {
    const result = validateMobileConnection({ kind: "lan-local", baseUrl: "http://192.168.1.20:11434/v1", model: "llama3.2" });
    expect(result.pushAvailable).toBe(false);
    expect(result.warnings.join(" ")).toContain("Plain HTTP");
    expect(result.warnings.join(" ")).toContain("cannot receive push");
  });

  it("rejects non-local HTTP endpoints", () => {
    expect(() => validateMobileConnection({ kind: "self-hosted", apiBaseUrl: "http://berry.example.test" })).toThrow("Plain HTTP");
  });

  it("recognizes RFC1918 and localhost ranges", () => {
    expect(isLocalNetworkHost("localhost")).toBe(true);
    expect(isLocalNetworkHost("10.0.0.2")).toBe(true);
    expect(isLocalNetworkHost("172.20.1.2")).toBe(true);
    expect(isLocalNetworkHost("192.168.1.20")).toBe(true);
    expect(isLocalNetworkHost("8.8.8.8")).toBe(false);
  });
});
