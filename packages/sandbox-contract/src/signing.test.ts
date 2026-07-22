import { describe, expect, it } from "vitest";
import { canonicalJson, signSandboxUsageEvent, verifySandboxUsageEvent } from "./signing.js";
import type { SandboxUsageEvent } from "./schemas.js";

const event: SandboxUsageEvent = {
  request_id: "req_1",
  sandbox_id: "sandbox_1",
  tenant_id: "00000000-0000-7000-8000-000000000001",
  provider: "berry_box",
  status: "completed",
  price_version: "sandbox-prices-2026-07",
  runtime_ms: 1000,
  vcpu_seconds: 2,
  memory_gib_seconds: 4,
  storage_gib_seconds: 10,
  ts: "2026-07-10T00:00:00.000Z",
  metadata: {},
};

describe("sandbox usage signing", () => {
  it("canonicalizes object key order before signing", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("signs and verifies normalized usage events", () => {
    const signed = signSandboxUsageEvent(event, {
      keyId: "test-key",
      secret: "secret",
      signedAt: "2026-07-10T00:00:01.000Z",
    });

    expect(signed.signature).toMatchObject({ algorithm: "hmac-sha256", key_id: "test-key" });
    expect(verifySandboxUsageEvent(signed, {
      secretForKeyId: (keyId) => keyId === "test-key" ? "secret" : null,
      now: new Date("2026-07-10T00:00:02.000Z"),
      maxSkewMs: 10_000,
    })).toBe(true);
  });

  it("rejects tampered payloads and stale signatures", () => {
    const signed = signSandboxUsageEvent(event, {
      keyId: "test-key",
      secret: "secret",
      signedAt: "2026-07-10T00:00:01.000Z",
    });
    const tampered = {
      ...signed,
      event: { ...signed.event, runtime_ms: signed.event.runtime_ms + 1 },
    };

    expect(verifySandboxUsageEvent(tampered, { secretForKeyId: () => "secret" })).toBe(false);
    expect(verifySandboxUsageEvent(signed, {
      secretForKeyId: () => "secret",
      now: new Date("2026-07-10T00:01:00.000Z"),
      maxSkewMs: 1_000,
    })).toBe(false);
  });
});
