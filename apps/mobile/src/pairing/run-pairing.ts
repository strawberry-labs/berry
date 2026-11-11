import type { BerryApiClient } from "@berry/api-client";
import type { MobileBrand, MobilePairingDevice, MobilePairingPollResponse, MobileServerInfo } from "@berry/shared";
import { checkCompatibility, type Compatibility } from "../session/compatibility";
import type { PendingPairing } from "./pending";

export type PairingProgress =
  | { step: "connecting" }
  | { step: "incompatible"; compatibility: Extract<Compatibility, { ok: false }>; brand: MobileBrand }
  | { step: "waiting"; brand: MobileBrand }
  | { step: "denied"; brand: MobileBrand }
  | { step: "expired"; brand: MobileBrand | null }
  | { step: "approved"; serverUrl: string; apiUrl: string; serverInfo: MobileServerInfo; result: Extract<MobilePairingPollResponse, { status: "approved" }> };

export type PairingEnvironment = {
  client: (apiUrl: string) => Pick<BerryApiClient, "getMobileServerInfo" | "claimMobilePairing" | "pollMobilePairing">;
  appVersion: string;
  minimumServerVersion: string;
  device: MobilePairingDevice;
};

/**
 * Checks the server, claims the code, then long-polls until the person
 * approves or denies this phone on their computer.
 */
export async function runPairing(pending: PendingPairing, onProgress: (progress: PairingProgress) => void, signal: AbortSignal, environment: PairingEnvironment): Promise<void> {
  onProgress({ step: "connecting" });
  const serverUrl = pending.kind === "qr" ? pending.pairing.serverUrl : pending.origin;
  const apiUrl = pending.kind === "qr" ? pending.pairing.apiUrl ?? pending.pairing.serverUrl : pending.origin;
  const client = environment.client(apiUrl);
  const serverInfo = await client.getMobileServerInfo();
  if (signal.aborted) return;
  const compatibility = checkCompatibility(serverInfo, environment.appVersion, environment.minimumServerVersion);
  if (!compatibility.ok) {
    onProgress({ step: "incompatible", compatibility, brand: serverInfo.brand });
    return;
  }
  const device = environment.device;
  const claim = await client.claimMobilePairing(pending.kind === "qr"
    ? { pairingId: pending.pairing.pairingId, secret: pending.pairing.secret, device }
    : { manualCode: pending.code, device });
  if (signal.aborted) return;
  const brand = claim.brand;
  onProgress({ step: "waiting", brand });
  while (!signal.aborted) {
    const result = await client.pollMobilePairing({ pairingId: claim.pairingId, claimToken: claim.claimToken }, signal);
    if (signal.aborted) return;
    if (result.status === "awaiting") continue;
    if (result.status === "denied") return onProgress({ step: "denied", brand });
    if (result.status === "expired") return onProgress({ step: "expired", brand });
    return onProgress({ step: "approved", serverUrl, apiUrl, serverInfo, result });
  }
}
