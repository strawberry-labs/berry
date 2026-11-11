import { describe, expect, it } from "vitest";
import {
  MobilePairingClaimRequestSchema,
  MobilePairingPollResponseSchema,
  MobileServerInfoSchema,
  buildMobilePairingUri,
  compareMobileVersions,
  formatMobileManualCode,
  isMobileDevelopmentHost,
  normalizeMobileManualCode,
  normalizeMobileServerOrigin,
  parseMobilePairingUri,
} from "./mobile-pairing.ts";

const pairingId = "6f1c3c1e-2b9a-4f7e-9a51-0c6c2d3e4f50";
const secret = "Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx5d2Fs";

describe("mobile pairing URIs", () => {
  it("round-trips the server, pairing id, and secret", () => {
    const uri = buildMobilePairingUri({ serverUrl: "https://berry.acme.com", pairingId, secret });
    expect(uri.startsWith("berry://pair?v=1&s=")).toBe(true);
    expect(uri).not.toContain("&a=");
    expect(parseMobilePairingUri(uri)).toEqual({ version: 1, serverUrl: "https://berry.acme.com", apiUrl: null, pairingId, secret });
  });

  it("includes the API origin only when it differs from the server", () => {
    const uri = buildMobilePairingUri({ serverUrl: "https://berry.acme.com", apiUrl: "https://api.berry.acme.com", pairingId, secret });
    expect(parseMobilePairingUri(uri)?.apiUrl).toBe("https://api.berry.acme.com");
    expect(buildMobilePairingUri({ serverUrl: "https://a.test", apiUrl: "https://a.test", pairingId, secret })).not.toContain("&a=");
  });

  it("stays small enough for a dense-but-scannable QR code", () => {
    const uri = buildMobilePairingUri({ serverUrl: "https://berry.internal.example-corporation.com", apiUrl: "https://api.berry.internal.example-corporation.com", pairingId, secret });
    expect(uri.length).toBeLessThan(260);
  });

  it.each([
    ["wrong scheme", `https://pair?v=1&s=https%3A%2F%2Fa.test&i=${pairingId}&k=${secret}`],
    ["missing secret", `berry://pair?v=1&s=https%3A%2F%2Fa.test&i=${pairingId}`],
    ["short secret", `berry://pair?v=1&s=https%3A%2F%2Fa.test&i=${pairingId}&k=abc`],
    ["bad pairing id", `berry://pair?v=1&s=https%3A%2F%2Fa.test&i=not-a-uuid&k=${secret}`],
    ["server with a path", `berry://pair?v=1&s=https%3A%2F%2Fa.test%2Fevil&i=${pairingId}&k=${secret}`],
    ["javascript server", `berry://pair?v=1&s=javascript%3Aalert(1)&i=${pairingId}&k=${secret}`],
    ["duplicate keys", `berry://pair?v=1&s=https%3A%2F%2Fa.test&s=https%3A%2F%2Fb.test&i=${pairingId}&k=${secret}`],
    ["bad encoding", `berry://pair?v=1&s=%E0%A4%A&i=${pairingId}&k=${secret}`],
    ["oversized", `berry://pair?v=1&s=https%3A%2F%2Fa.test&i=${pairingId}&k=${secret}&x=${"a".repeat(1100)}`],
  ])("rejects %s", (_label, uri) => {
    expect(parseMobilePairingUri(uri)).toBeNull();
  });
});

describe("server origins", () => {
  it("normalizes to scheme, host and non-default port", () => {
    expect(normalizeMobileServerOrigin(" HTTPS://Berry.Acme.com/ ")).toBe("https://berry.acme.com");
    expect(normalizeMobileServerOrigin("https://berry.acme.com:443")).toBe("https://berry.acme.com");
    expect(normalizeMobileServerOrigin("http://192.168.1.20:3108")).toBe("http://192.168.1.20:3108");
  });

  it("rejects paths, credentials and other schemes", () => {
    expect(normalizeMobileServerOrigin("https://berry.acme.com/app")).toBeNull();
    expect(normalizeMobileServerOrigin("https://user:pass@berry.acme.com")).toBeNull();
    expect(normalizeMobileServerOrigin("ftp://berry.acme.com")).toBeNull();
    expect(normalizeMobileServerOrigin("https://berry..acme.com")).toBeNull();
    expect(normalizeMobileServerOrigin("https://berry.acme.com:70000")).toBeNull();
  });

  it("recognizes development hosts that may use plain HTTP", () => {
    expect(isMobileDevelopmentHost("http://localhost:3108")).toBe(true);
    expect(isMobileDevelopmentHost("http://192.168.1.20")).toBe(true);
    expect(isMobileDevelopmentHost("http://172.20.0.4")).toBe(true);
    expect(isMobileDevelopmentHost("http://172.40.0.4")).toBe(false);
    expect(isMobileDevelopmentHost("http://berry.acme.com")).toBe(false);
  });
});

describe("manual codes", () => {
  it("normalizes separators, case and look-alike characters", () => {
    expect(normalizeMobileManualCode("ab1c-d2ef")).toBe("AB1CD2EF");
    expect(normalizeMobileManualCode("ABIC DOEF")).toBe("AB1CD0EF");
    expect(formatMobileManualCode("AB1CD2EF")).toBe("AB1C-D2EF");
  });

  it("rejects codes of the wrong length or alphabet", () => {
    expect(normalizeMobileManualCode("ABC")).toBeNull();
    expect(normalizeMobileManualCode("ABCDEFGU")).toBeNull();
  });

  it("accepts either a QR secret or a manual code when claiming", () => {
    const device = { model: "iPhone 17 Pro", platform: "ios", osVersion: "26.1", appVersion: "1.0.0" };
    expect(MobilePairingClaimRequestSchema.safeParse({ pairingId, secret, device }).success).toBe(true);
    expect(MobilePairingClaimRequestSchema.safeParse({ manualCode: "AB1C-D2EF", device }).success).toBe(true);
    expect(MobilePairingClaimRequestSchema.safeParse({ pairingId, device }).success).toBe(false);
  });
});

describe("compatibility", () => {
  it("compares app versions numerically", () => {
    expect(compareMobileVersions("1.2.10", "1.2.9")).toBe(1);
    expect(compareMobileVersions("1.0.0", "1.0")).toBe(0);
    expect(compareMobileVersions("0.9.0", "1.0.0")).toBe(-1);
  });

  it("lets older apps parse server info with unknown capabilities", () => {
    const parsed = MobileServerInfoSchema.parse({
      protocolVersion: 1,
      serverVersion: "1.4.0",
      minimumAppVersion: "1.0.0",
      capabilities: ["tasks", "some-future-capability"],
      mobileEnabled: true,
      serverUrl: "https://berry.acme.com",
      apiUrl: "https://berry.acme.com",
      brand: { applicationName: "Acme AI", logoUrl: null, accentColor: null },
    });
    expect(parsed.capabilities).toContain("some-future-capability");
  });

  it("only exposes a session token on approval", () => {
    expect(MobilePairingPollResponseSchema.parse({ status: "awaiting" })).toEqual({ status: "awaiting" });
    expect(MobilePairingPollResponseSchema.safeParse({ status: "approved" }).success).toBe(false);
  });
});
