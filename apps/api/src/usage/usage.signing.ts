import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalJson } from "@berry/sandbox-contract";
import {
  CloudUsageIngestRequestSchema,
  type CloudUsageIngestRequest,
  type JsonValue,
} from "@berry/shared";

export const USAGE_EVENT_VERIFIER = Symbol("USAGE_EVENT_VERIFIER");

export interface UsageEventVerifier {
  verify(input: CloudUsageIngestRequest): boolean;
  describe(): { configuredKeyIds: string[]; maxSkewMs: number };
}

export class HmacUsageEventVerifier implements UsageEventVerifier {
  readonly #secrets: Map<string, string | Uint8Array>;
  readonly #maxSkewMs: number;
  readonly #now: () => Date;

  constructor(options: {
    secrets: Map<string, string | Uint8Array> | Record<string, string | Uint8Array>;
    maxSkewMs?: number | undefined;
    now?: (() => Date) | undefined;
  }) {
    this.#secrets = options.secrets instanceof Map ? options.secrets : new Map(Object.entries(options.secrets));
    this.#maxSkewMs = options.maxSkewMs ?? 5 * 60_000;
    this.#now = options.now ?? (() => new Date());
  }

  verify(input: CloudUsageIngestRequest): boolean {
    const parsed = CloudUsageIngestRequestSchema.parse(input);
    const secret = this.#secrets.get(parsed.signature.keyId);
    if (!secret) return false;
    const signedAt = new Date(parsed.signature.signedAt);
    if (!Number.isFinite(signedAt.getTime())) return false;
    if (this.#maxSkewMs >= 0 && Math.abs(this.#now().getTime() - signedAt.getTime()) > this.#maxSkewMs) return false;
    const expected = signUsagePayload(parsed.event, parsed.signature.keyId, parsed.signature.signedAt, secret);
    return safeEqual(expected, parsed.signature.signature);
  }

  describe(): { configuredKeyIds: string[]; maxSkewMs: number } {
    return { configuredKeyIds: [...this.#secrets.keys()].sort(), maxSkewMs: this.#maxSkewMs };
  }
}

export function createUsageEventVerifierFromEnv(env: NodeJS.ProcessEnv = process.env): HmacUsageEventVerifier {
  return new HmacUsageEventVerifier({
    secrets: parseUsageSigningSecrets(env.BERRY_USAGE_SIGNING_SECRETS ?? ""),
    maxSkewMs: numberEnv(env.BERRY_USAGE_SIGNATURE_MAX_SKEW_MS, 5 * 60_000),
  });
}

export function parseUsageSigningSecrets(raw: string): Map<string, string> {
  const secrets = new Map<string, string>();
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf(":");
    if (separator <= 0 || separator === trimmed.length - 1) continue;
    secrets.set(trimmed.slice(0, separator), trimmed.slice(separator + 1));
  }
  return secrets;
}

export function signCloudUsageEventForTest(input: {
  event: JsonValue;
  keyId: string;
  secret: string | Uint8Array;
  signedAt?: string | Date | undefined;
}): { algorithm: "hmac-sha256"; keyId: string; signedAt: string; signature: string } {
  const signedAt = input.signedAt instanceof Date ? input.signedAt.toISOString() : new Date(input.signedAt ?? new Date()).toISOString();
  return {
    algorithm: "hmac-sha256",
    keyId: input.keyId,
    signedAt,
    signature: signUsagePayload(input.event, input.keyId, signedAt, input.secret),
  };
}

function signUsagePayload(event: JsonValue, keyId: string, signedAt: string, secret: string | Uint8Array): string {
  return createHmac("sha256", secret)
    .update(`${keyId}.${signedAt}.`)
    .update(canonicalJson(event))
    .digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function numberEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
