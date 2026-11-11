import { describe, expect, it } from "vitest";
import { buildMobilePairingUri, type MobileServerInfo } from "@berry/shared";
import { checkCompatibility, hasCapability } from "../session/compatibility";
import { readManualCode, readScannedCode, readServerAddress } from "./pairing";
import { runPairing, type PairingProgress } from "./run-pairing";

const pairingId = "6f1c3c1e-2b9a-4f7e-9a51-0c6c2d3e4f50";
const secret = "Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx5d2Fs";
const device = { model: "iPhone 17 Pro", platform: "ios" as const, osVersion: "26.2", appVersion: "1.0.0" };
const info: MobileServerInfo = {
  protocolVersion: 1,
  serverVersion: "1.2.0",
  minimumAppVersion: "1.0.0",
  capabilities: ["tasks", "library"],
  mobileEnabled: true,
  serverUrl: "https://berry.acme.com",
  apiUrl: "https://berry.acme.com",
  brand: { applicationName: "Acme AI", logoUrl: null, accentColor: "#7c6df2" },
};

describe("scanning", () => {
  it("accepts Berry sign-in codes for https servers", () => {
    const result = readScannedCode(buildMobilePairingUri({ serverUrl: "https://berry.acme.com", pairingId, secret }), { allowInsecureLocal: false });
    expect(result).toMatchObject({ kind: "pairing", pairing: { serverUrl: "https://berry.acme.com", pairingId } });
  });

  it("rejects other QR codes and plain-http servers in store builds", () => {
    expect(readScannedCode("https://example.com", { allowInsecureLocal: false }).kind).toBe("invalid");
    const local = buildMobilePairingUri({ serverUrl: "http://192.168.1.20:3001", pairingId, secret });
    expect(readScannedCode(local, { allowInsecureLocal: false }).kind).toBe("invalid");
    expect(readScannedCode(local, { allowInsecureLocal: true }).kind).toBe("pairing");
    expect(readScannedCode(buildMobilePairingUri({ serverUrl: "http://berry.acme.com", pairingId, secret }), { allowInsecureLocal: true }).kind).toBe("invalid");
  });

  it("normalizes typed server addresses and codes", () => {
    expect(readServerAddress("berry.acme.com", { allowInsecureLocal: false })).toEqual({ origin: "https://berry.acme.com" });
    expect(readServerAddress("https://berry.acme.com/", { allowInsecureLocal: false })).toEqual({ origin: "https://berry.acme.com" });
    expect(readServerAddress("http://berry.acme.com", { allowInsecureLocal: false })).toHaveProperty("message");
    expect(readServerAddress("", { allowInsecureLocal: false })).toHaveProperty("message");
    expect(readManualCode("ab12-cd34")).toBe("AB12CD34");
    expect(readManualCode("short")).toBeNull();
  });
});

describe("compatibility", () => {
  it("accepts a supported server", () => {
    expect(checkCompatibility(info, "1.0.0", "1.0.0")).toEqual({ ok: true });
    expect(hasCapability(info, "library")).toBe(true);
    expect(hasCapability(info, "scheduled-tasks")).toBe(false);
  });

  it("explains why it can't connect", () => {
    expect(checkCompatibility({ ...info, mobileEnabled: false }, "1.0.0", "1.0.0")).toMatchObject({ ok: false, reason: "disabled" });
    expect(checkCompatibility({ ...info, minimumAppVersion: "2.0.0" }, "1.0.0", "1.0.0")).toMatchObject({ ok: false, reason: "app-too-old" });
    expect(checkCompatibility({ ...info, protocolVersion: 2 }, "1.0.0", "1.0.0")).toMatchObject({ ok: false, reason: "app-too-old" });
    expect(checkCompatibility({ ...info, serverVersion: "0.9.0" }, "1.0.0", "1.0.0")).toMatchObject({ ok: false, reason: "server-too-old" });
  });
});

describe("pairing flow", () => {
  function fakeClient(polls: Array<{ status: string } & Record<string, unknown>>) {
    const calls: string[] = [];
    return {
      calls,
      client: {
        getMobileServerInfo: async () => { calls.push("info"); return info; },
        claimMobilePairing: async (input: unknown) => {
          calls.push(`claim:${"manualCode" in (input as object) ? "code" : "qr"}`);
          return { pairingId, claimToken: "t".repeat(43), expiresAt: "", brand: info.brand };
        },
        pollMobilePairing: async () => { calls.push("poll"); return polls.shift() as never; },
      },
    };
  }

  it("waits for approval, then hands back the session", async () => {
    const fake = fakeClient([{ status: "awaiting" }, { status: "approved", sessionToken: "token", sessionExpiresAt: "", deviceId: "d1", user: { id: "u1", email: "a@b.c", name: null, image: null } }]);
    const progress: PairingProgress[] = [];
    await runPairing({ kind: "qr", pairing: { version: 1, serverUrl: "https://berry.acme.com", apiUrl: null, pairingId, secret } }, (step) => progress.push(step), new AbortController().signal, {
      client: () => fake.client as never, appVersion: "1.0.0", minimumServerVersion: "1.0.0", device,
    });
    expect(progress.map((step) => step.step)).toEqual(["connecting", "waiting", "approved"]);
    expect(fake.calls).toEqual(["info", "claim:qr", "poll", "poll"]);
    expect(progress.at(-1)).toMatchObject({ serverUrl: "https://berry.acme.com", apiUrl: "https://berry.acme.com" });
  });

  it("stops before claiming when the server is incompatible", async () => {
    const fake = fakeClient([]);
    const progress: PairingProgress[] = [];
    await runPairing({ kind: "code", origin: "https://berry.acme.com", code: "AB12CD34" }, (step) => progress.push(step), new AbortController().signal, {
      client: () => fake.client as never, appVersion: "0.5.0", minimumServerVersion: "1.0.0", device,
    });
    expect(progress.at(-1)).toMatchObject({ step: "incompatible", compatibility: { reason: "app-too-old" } });
    expect(fake.calls).toEqual(["info"]);
  });

  it("reports a denied sign-in", async () => {
    const fake = fakeClient([{ status: "denied" }]);
    const progress: PairingProgress[] = [];
    await runPairing({ kind: "code", origin: "https://berry.acme.com", code: "AB12CD34" }, (step) => progress.push(step), new AbortController().signal, {
      client: () => fake.client as never, appVersion: "1.0.0", minimumServerVersion: "1.0.0", device,
    });
    expect(progress.at(-1)?.step).toBe("denied");
    expect(fake.calls).toEqual(["info", "claim:code", "poll"]);
  });
});
