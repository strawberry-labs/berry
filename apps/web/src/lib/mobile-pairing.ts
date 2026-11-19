import type { BerryApiClient } from "@berry/api-client";
import {
  MOBILE_MANUAL_CODE_ALPHABET,
  MOBILE_PAIRING_TTL_SECONDS,
  buildMobilePairingUri,
  formatMobileManualCode,
  type MobileDeviceRegistration,
  type MobilePairingCreateResponse,
  type MobilePairingStatus,
} from "@berry/shared";

/** What the web needs to pair and manage phones; real API or a labelled demo. */
export interface MobilePairingApi {
  readonly demo: boolean;
  createPairing(): Promise<MobilePairingCreateResponse>;
  getPairing(id: string, signal?: AbortSignal): Promise<MobilePairingStatus>;
  approve(id: string): Promise<MobilePairingStatus>;
  deny(id: string): Promise<MobilePairingStatus>;
  cancel(id: string): Promise<void>;
  listDevices(): Promise<MobileDeviceRegistration[]>;
  revokeDevice(deviceId: string): Promise<void>;
}

export function mobilePairingApi(client: BerryApiClient | null): MobilePairingApi {
  if (!client) return demoMobilePairingApi;
  return {
    demo: false,
    createPairing: () => client.createMobilePairing(),
    getPairing: (id, signal) => client.getMobilePairing(id, signal),
    approve: (id) => client.approveMobilePairing(id),
    deny: (id) => client.denyMobilePairing(id),
    cancel: (id) => client.cancelMobilePairing(id),
    listDevices: () => client.listPairedMobileDevices(),
    revokeDevice: (deviceId) => client.revokePairedMobileDevice(deviceId),
  };
}

/** Seconds left before a code expires, never negative. */
export function secondsUntil(expiresAt: string, now = Date.now()): number {
  return Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now) / 1000));
}

export function formatCountdown(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

export function describePairedDevice(device: Pick<MobileDeviceRegistration, "platform" | "osVersion" | "appVersion">): string {
  const platform = device.platform === "ios" ? "iOS" : device.platform === "android" ? "Android" : "Mobile";
  return [device.osVersion ? `${platform} ${device.osVersion}` : platform, device.appVersion ? `Berry ${device.appVersion}` : null].filter(Boolean).join(" · ");
}

// Demo mode has no API. This adapter simulates a phone scanning the code a few
// seconds after it appears so the approval flow can be seen and tested.
const DEMO_SCAN_DELAY_MS = 3_000;
const DEMO_DEVICE = { model: "iPhone 17 Pro", platform: "ios" as const, osVersion: "26.1", appVersion: "1.0.0" };

type DemoPairing = { id: string; createdAt: number; expiresAt: string; status: MobilePairingStatus["status"] };

const demoState: { pairings: Map<string, DemoPairing>; devices: MobileDeviceRegistration[] } = { pairings: new Map(), devices: [] };

const demoMobilePairingApi: MobilePairingApi = {
  demo: true,
  async createPairing() {
    const id = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + MOBILE_PAIRING_TTL_SECONDS * 1000).toISOString();
    demoState.pairings.set(id, { id, createdAt: Date.now(), expiresAt, status: "pending" });
    const secret = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const code = Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => MOBILE_MANUAL_CODE_ALPHABET[byte % MOBILE_MANUAL_CODE_ALPHABET.length]).join("");
    const serverUrl = typeof window === "undefined" ? "https://berry.example.com" : window.location.origin;
    return { id, qrPayload: buildMobilePairingUri({ serverUrl, pairingId: id, secret }), manualCode: formatMobileManualCode(code), serverUrl, expiresAt };
  },
  async getPairing(id) {
    const pairing = demoPairing(id);
    if (pairing.status === "pending" && Date.now() - pairing.createdAt >= DEMO_SCAN_DELAY_MS) pairing.status = "claimed";
    if (pairing.status === "approved") {
      pairing.status = "completed";
      const now = new Date().toISOString();
      demoState.devices.unshift({
        id: crypto.randomUUID(), tenantId: null, userId: null, deviceId: crypto.randomUUID(), platform: DEMO_DEVICE.platform,
        pushProvider: "none", pushTokenLast4: null, endpointMode: "paired", appVersion: DEMO_DEVICE.appVersion, capabilities: [],
        status: "active", displayName: DEMO_DEVICE.model, model: DEMO_DEVICE.model, osVersion: DEMO_DEVICE.osVersion,
        pairedAt: now, revokedAt: null, current: false, createdAt: now, updatedAt: now, lastSeenAt: now,
      });
    }
    return demoStatus(pairing);
  },
  async approve(id) {
    const pairing = demoPairing(id);
    if (pairing.status === "claimed") pairing.status = "approved";
    return demoStatus(pairing);
  },
  async deny(id) {
    const pairing = demoPairing(id);
    if (pairing.status === "pending" || pairing.status === "claimed") pairing.status = "denied";
    return demoStatus(pairing);
  },
  async cancel(id) {
    const pairing = demoState.pairings.get(id);
    if (pairing && (pairing.status === "pending" || pairing.status === "claimed")) pairing.status = "cancelled";
  },
  async listDevices() {
    return demoState.devices.filter((device) => device.status === "active");
  },
  async revokeDevice(deviceId) {
    demoState.devices = demoState.devices.filter((device) => device.deviceId !== deviceId);
  },
};

function demoPairing(id: string): DemoPairing {
  const pairing = demoState.pairings.get(id);
  if (!pairing) throw new Error("Pairing not found");
  return pairing;
}

function demoStatus(pairing: DemoPairing): MobilePairingStatus {
  const open = pairing.status === "pending" || pairing.status === "claimed" || pairing.status === "approved";
  return {
    id: pairing.id,
    status: open && secondsUntil(pairing.expiresAt) === 0 ? "expired" : pairing.status,
    expiresAt: pairing.expiresAt,
    device: pairing.status === "pending" ? null : DEMO_DEVICE,
    claimedIp: pairing.status === "pending" ? null : "203.0.113.24",
  };
}
