import {
  isMobileDevelopmentHost,
  normalizeMobileManualCode,
  normalizeMobileServerOrigin,
  parseMobilePairingUri,
  type MobilePairingUri,
} from "@berry/shared";

export type ScanResult =
  | { kind: "pairing"; pairing: MobilePairingUri }
  | { kind: "invalid"; message: string };

/** Interprets a scanned QR code; anything other than a Berry sign-in code is rejected. */
export function readScannedCode(text: string, options: { allowInsecureLocal: boolean }): ScanResult {
  const pairing = parseMobilePairingUri(text);
  if (!pairing) return { kind: "invalid", message: "That isn't a Berry sign-in code. On your computer, open Berry and choose Get the mobile app." };
  const serverProblem = serverOriginProblem(pairing.serverUrl, options) ?? (pairing.apiUrl ? serverOriginProblem(pairing.apiUrl, options) : null);
  if (serverProblem) return { kind: "invalid", message: serverProblem };
  return { kind: "pairing", pairing };
}

/** Normalizes a typed server address; bare hostnames get https://. */
export function readServerAddress(value: string, options: { allowInsecureLocal: boolean }): { origin: string } | { message: string } {
  const trimmed = value.trim();
  if (!trimmed) return { message: "Enter your organization's Berry address." };
  const origin = normalizeMobileServerOrigin(/^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  if (!origin) return { message: "Enter an address like berry.example.com." };
  const problem = serverOriginProblem(origin, options);
  return problem ? { message: problem } : { origin };
}

export function readManualCode(value: string): string | null {
  return normalizeMobileManualCode(value);
}

function serverOriginProblem(origin: string, options: { allowInsecureLocal: boolean }): string | null {
  if (origin.startsWith("https://")) return null;
  if (options.allowInsecureLocal && isMobileDevelopmentHost(origin)) return null;
  return "This server isn't using a secure (https) connection, so the app won't connect to it.";
}
