import { createHmac, timingSafeEqual } from "node:crypto";
import { SignedSandboxUsageEventSchema, SandboxUsageEventSchema, type SandboxUsageEvent, type SignedSandboxUsageEvent } from "./schemas.js";

export interface SandboxUsageSigningOptions {
  keyId: string;
  secret: string | Uint8Array;
  signedAt?: string | Date | undefined;
}

export interface SandboxUsageVerificationOptions {
  secretForKeyId(keyId: string): string | Uint8Array | null | undefined;
  maxSkewMs?: number | undefined;
  now?: Date | undefined;
}

export function signSandboxUsageEvent(
  event: SandboxUsageEvent,
  options: SandboxUsageSigningOptions,
): SignedSandboxUsageEvent {
  const parsedEvent = SandboxUsageEventSchema.parse(event);
  const signedAt = iso(options.signedAt ?? new Date());
  return SignedSandboxUsageEventSchema.parse({
    event: parsedEvent,
    signature: {
      algorithm: "hmac-sha256",
      key_id: options.keyId,
      signed_at: signedAt,
      signature: hmac(parsedEvent, options.keyId, signedAt, options.secret),
    },
  });
}

export function verifySandboxUsageEvent(
  signed: SignedSandboxUsageEvent,
  options: SandboxUsageVerificationOptions,
): boolean {
  const parsed = SignedSandboxUsageEventSchema.parse(signed);
  const secret = options.secretForKeyId(parsed.signature.key_id);
  if (!secret) return false;
  if (options.maxSkewMs !== undefined) {
    const now = options.now ?? new Date();
    const signedAt = new Date(parsed.signature.signed_at);
    if (Math.abs(now.getTime() - signedAt.getTime()) > options.maxSkewMs) return false;
  }
  const expected = hmac(parsed.event, parsed.signature.key_id, parsed.signature.signed_at, secret);
  return safeEqual(expected, parsed.signature.signature);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function hmac(event: SandboxUsageEvent, keyId: string, signedAt: string, secret: string | Uint8Array): string {
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

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJson(entry)]),
    );
  }
  return value;
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
