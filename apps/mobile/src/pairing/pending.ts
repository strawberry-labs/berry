import type { MobilePairingUri } from "@berry/shared";

export type PendingPairing =
  | { kind: "qr"; pairing: MobilePairingUri }
  | { kind: "code"; origin: string; code: string };

// Held in memory only, so the single-use secret never lands in navigation
// state, logs, or storage.
let pending: PendingPairing | null = null;

export function setPendingPairing(value: PendingPairing): void {
  pending = value;
}

export function peekPendingPairing(): PendingPairing | null {
  return pending;
}

export function clearPendingPairing(): void {
  pending = null;
}
