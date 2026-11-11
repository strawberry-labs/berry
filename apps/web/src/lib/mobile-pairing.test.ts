import { describe, expect, it, vi } from "vitest";
import { parseMobilePairingUri } from "@berry/shared";
import { describePairedDevice, formatCountdown, mobilePairingApi, secondsUntil } from "./mobile-pairing";

describe("mobile pairing helpers", () => {
  it("formats the code countdown", () => {
    expect(formatCountdown(120)).toBe("2:00");
    expect(formatCountdown(65)).toBe("1:05");
    expect(formatCountdown(0)).toBe("0:00");
    expect(secondsUntil("2026-10-09T10:00:30.000Z", Date.parse("2026-10-09T10:00:00.000Z"))).toBe(30);
    expect(secondsUntil("2026-10-09T09:59:00.000Z", Date.parse("2026-10-09T10:00:00.000Z"))).toBe(0);
  });

  it("describes a paired phone", () => {
    expect(describePairedDevice({ platform: "ios", osVersion: "26.1", appVersion: "1.0.0" })).toBe("iOS 26.1 · Berry 1.0.0");
    expect(describePairedDevice({ platform: "android", osVersion: null, appVersion: null })).toBe("Android");
  });

  it("uses a labelled demo adapter without an API client", async () => {
    vi.useFakeTimers();
    try {
      const api = mobilePairingApi(null);
      expect(api.demo).toBe(true);
      const pairing = await api.createPairing();
      expect(parseMobilePairingUri(pairing.qrPayload)?.pairingId).toBe(pairing.id);
      expect((await api.getPairing(pairing.id)).status).toBe("pending");
      vi.advanceTimersByTime(3_000);
      expect((await api.getPairing(pairing.id)).status).toBe("claimed");
      await api.approve(pairing.id);
      expect((await api.getPairing(pairing.id)).status).toBe("completed");
      const devices = await api.listDevices();
      expect(devices[0]?.model).toBe("iPhone 17 Pro");
      await api.revokeDevice(devices[0]!.deviceId);
      expect(await api.listDevices()).toHaveLength(devices.length - 1);
    } finally {
      vi.useRealTimers();
    }
  });
});
