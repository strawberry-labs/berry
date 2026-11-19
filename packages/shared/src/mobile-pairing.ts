import { z } from "zod";

/**
 * Contract between a Berry server and the Berry mobile companion app.
 *
 * The phone signs in by scanning a QR code shown on the web. The QR carries a
 * short-lived, single-use pairing secret (never a session token); the web user
 * approves the claimed device, and the phone then collects its own session.
 *
 * Everything in this file must run in browsers, Node, and React Native
 * (Hermes), so it avoids Node APIs and the partially implemented RN `URL`.
 */

export const MOBILE_PROTOCOL_VERSION = 1;
export const MOBILE_PAIRING_URI_SCHEME = "berry";
export const MOBILE_PAIRING_URI_HOST = "pair";
export const MOBILE_PAIRING_TTL_SECONDS = 120;
export const MOBILE_PAIRING_APPROVAL_WINDOW_SECONDS = 180;
export const MOBILE_PAIRING_POLL_TIMEOUT_MS = 25_000;
export const MOBILE_MANUAL_CODE_LENGTH = 8;

/** Crockford base32 without I, L, O, U so codes survive being read aloud. */
export const MOBILE_MANUAL_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const MobileCapabilitySchema = z.enum([
  "mobile-pairing",
  "tasks",
  "projects",
  "library",
  "skills",
  "scheduled-tasks",
  "queued-follow-ups",
  "image-generation",
  "personalization",
  "connectors",
  "mcp",
  "usage",
  "archived-tasks",
]);
export type MobileCapability = z.infer<typeof MobileCapabilitySchema>;

export const MobileBrandSchema = z.object({
  applicationName: z.string().min(1).max(80),
  logoUrl: z.string().max(2048).nullable(),
  accentColor: z.string().max(64).nullable(),
});
export type MobileBrand = z.infer<typeof MobileBrandSchema>;

export const MobileServerInfoSchema = z.object({
  protocolVersion: z.number().int().positive(),
  serverVersion: z.string().min(1).max(64),
  minimumAppVersion: z.string().min(1).max(64),
  // Unknown capabilities from newer servers are kept as strings so older apps
  // can ignore them instead of failing to parse.
  capabilities: z.array(z.string().max(64)).max(64),
  mobileEnabled: z.boolean(),
  serverUrl: z.string().min(1).max(2048),
  apiUrl: z.string().min(1).max(2048),
  brand: MobileBrandSchema,
});
export type MobileServerInfo = z.infer<typeof MobileServerInfoSchema>;

export const MobileClientPlatformSchema = z.enum(["ios", "android"]);
export type MobileClientPlatform = z.infer<typeof MobileClientPlatformSchema>;

export const MobilePairingDeviceSchema = z.object({
  model: z.string().trim().min(1).max(120),
  platform: MobileClientPlatformSchema,
  osVersion: z.string().trim().min(1).max(40),
  appVersion: z.string().trim().min(1).max(40),
}).strict();
export type MobilePairingDevice = z.infer<typeof MobilePairingDeviceSchema>;

export const MobilePairingStatusValueSchema = z.enum([
  "pending",
  "claimed",
  "approved",
  "denied",
  "expired",
  "completed",
  "cancelled",
]);
export type MobilePairingStatusValue = z.infer<typeof MobilePairingStatusValueSchema>;

export const MobilePairingCreateResponseSchema = z.object({
  id: z.string().uuid(),
  qrPayload: z.string().min(1).max(512),
  manualCode: z.string().regex(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/),
  serverUrl: z.string().min(1).max(2048),
  /** Where the app reaches /v1 when it differs from serverUrl; typed with the manual code. */
  apiUrl: z.string().min(1).max(2048).optional(),
  expiresAt: z.string(),
});
export type MobilePairingCreateResponse = z.infer<typeof MobilePairingCreateResponseSchema>;

export const MobilePairingStatusSchema = z.object({
  id: z.string().uuid(),
  status: MobilePairingStatusValueSchema,
  expiresAt: z.string(),
  device: MobilePairingDeviceSchema.nullable(),
  claimedIp: z.string().nullable(),
});
export type MobilePairingStatus = z.infer<typeof MobilePairingStatusSchema>;

export const MobilePairingClaimRequestSchema = z.union([
  z.object({
    pairingId: z.string().uuid(),
    secret: z.string().min(32).max(128),
    device: MobilePairingDeviceSchema,
  }).strict(),
  z.object({
    manualCode: z.string().trim().min(MOBILE_MANUAL_CODE_LENGTH).max(MOBILE_MANUAL_CODE_LENGTH + 2),
    device: MobilePairingDeviceSchema,
  }).strict(),
]);
export type MobilePairingClaimRequest = z.infer<typeof MobilePairingClaimRequestSchema>;

export const MobilePairingClaimResponseSchema = z.object({
  pairingId: z.string().uuid(),
  claimToken: z.string().min(32).max(128),
  expiresAt: z.string(),
  brand: MobileBrandSchema,
});
export type MobilePairingClaimResponse = z.infer<typeof MobilePairingClaimResponseSchema>;

export const MobilePairingPollRequestSchema = z.object({
  pairingId: z.string().uuid(),
  claimToken: z.string().min(32).max(128),
}).strict();
export type MobilePairingPollRequest = z.infer<typeof MobilePairingPollRequestSchema>;

export const MobileSessionUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  image: z.string().nullable(),
});
export type MobileSessionUser = z.infer<typeof MobileSessionUserSchema>;

export const MobilePairingPollResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("awaiting") }),
  z.object({ status: z.literal("denied") }),
  z.object({ status: z.literal("expired") }),
  z.object({
    status: z.literal("approved"),
    sessionToken: z.string().min(16).max(256),
    sessionExpiresAt: z.string(),
    deviceId: z.string(),
    user: MobileSessionUserSchema,
  }),
]);
export type MobilePairingPollResponse = z.infer<typeof MobilePairingPollResponseSchema>;

export type MobilePairingUri = {
  version: number;
  serverUrl: string;
  apiUrl: string | null;
  pairingId: string;
  secret: string;
};

const ORIGIN_PATTERN = /^(https?):\/\/(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?\/?$/i;

/**
 * Normalizes a server base URL to its origin (`https://host[:port]`). Paths,
 * queries, fragments and credentials are rejected rather than silently
 * dropped, because the URL comes from a scanned code or a typed field.
 */
export function normalizeMobileServerOrigin(value: string): string | null {
  const trimmed = value.trim();
  const match = ORIGIN_PATTERN.exec(trimmed);
  if (!match) return null;
  const scheme = match[1]!.toLowerCase();
  const host = match[2]!.toLowerCase();
  const port = match[3];
  if (host.startsWith(".") || host.endsWith(".") || host.includes("..")) return null;
  if (port !== undefined) {
    const numeric = Number(port);
    if (!Number.isInteger(numeric) || numeric < 1 || numeric > 65535) return null;
    if ((scheme === "https" && numeric === 443) || (scheme === "http" && numeric === 80)) return `${scheme}://${host}`;
    return `${scheme}://${host}:${numeric}`;
  }
  return `${scheme}://${host}`;
}

/** Hosts that may be reached over plain HTTP in development builds only. */
export function isMobileDevelopmentHost(origin: string): boolean {
  const host = origin.replace(/^https?:\/\//, "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true;
  const octets = host.split(".").map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = octets as [number, number, number, number];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function buildMobilePairingUri(input: { serverUrl: string; apiUrl?: string | null; pairingId: string; secret: string }): string {
  const params = [
    `v=${MOBILE_PROTOCOL_VERSION}`,
    `s=${encodeURIComponent(input.serverUrl)}`,
    ...(input.apiUrl && input.apiUrl !== input.serverUrl ? [`a=${encodeURIComponent(input.apiUrl)}`] : []),
    `i=${encodeURIComponent(input.pairingId)}`,
    `k=${encodeURIComponent(input.secret)}`,
  ];
  return `${MOBILE_PAIRING_URI_SCHEME}://${MOBILE_PAIRING_URI_HOST}?${params.join("&")}`;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

export function parseMobilePairingUri(text: string): MobilePairingUri | null {
  const trimmed = text.trim();
  if (trimmed.length > 1024) return null;
  const prefix = `${MOBILE_PAIRING_URI_SCHEME}://${MOBILE_PAIRING_URI_HOST}?`;
  if (trimmed.slice(0, prefix.length).toLowerCase() !== prefix) return null;
  const params = new Map<string, string>();
  for (const part of trimmed.slice(prefix.length).split("&")) {
    const separator = part.indexOf("=");
    if (separator <= 0) return null;
    const key = part.slice(0, separator);
    if (params.has(key)) return null;
    try {
      params.set(key, decodeURIComponent(part.slice(separator + 1)));
    } catch {
      return null;
    }
  }
  const version = Number(params.get("v"));
  if (!Number.isInteger(version) || version < 1) return null;
  const serverUrl = normalizeMobileServerOrigin(params.get("s") ?? "");
  const apiParam = params.get("a");
  const apiUrl = apiParam === undefined ? null : normalizeMobileServerOrigin(apiParam);
  const pairingId = params.get("i") ?? "";
  const secret = params.get("k") ?? "";
  if (!serverUrl || (apiParam !== undefined && !apiUrl)) return null;
  if (!UUID_PATTERN.test(pairingId) || !SECRET_PATTERN.test(secret)) return null;
  return { version, serverUrl, apiUrl, pairingId: pairingId.toLowerCase(), secret };
}

/** Uppercases, maps look-alike characters, and strips separators. */
export function normalizeMobileManualCode(value: string): string | null {
  const cleaned = value
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  if (cleaned.length !== MOBILE_MANUAL_CODE_LENGTH) return null;
  for (const character of cleaned) {
    if (!MOBILE_MANUAL_CODE_ALPHABET.includes(character)) return null;
  }
  return cleaned;
}

export function formatMobileManualCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Compares dotted numeric versions (`1.2.10` > `1.2.9`); non-numeric parts count as 0. */
export function compareMobileVersions(left: string, right: string): number {
  const a = left.split(/[.+-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
  const b = right.split(/[.+-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}
