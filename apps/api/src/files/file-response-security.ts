import type { ServerResponse } from "node:http";
import { PASSIVE_INLINE_FILE_MEDIA_TYPES } from "@berry/shared";

export const FILE_RESPONSE_CSP = "default-src 'none'; sandbox";
export const FILE_TYPE_SAMPLE_BYTES = 8 * 1024;
// Protected content must reauthorize on every browser request. Public immutable
// caching is reserved for security-versioned, revocation-safe asset URLs.
export const PROTECTED_FILE_CACHE_CONTROL = "private, max-age=0, must-revalidate";
export const PUBLIC_IMMUTABLE_FILE_CACHE_CONTROL = "public, max-age=31536000, immutable";
export const INVALID_FILE_CACHE_CONTROL = "no-store";

const PASSIVE_INLINE_MEDIA_TYPES = new Set<string>(PASSIVE_INLINE_FILE_MEDIA_TYPES);

const MEDIA_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

export type FileResponsePolicy = {
  contentType: string;
  disposition: "attachment" | "inline";
  declaredMediaType: string | null;
  detectedMediaType: string;
  mediaTypeMatches: boolean;
};

export function normalizeMediaType(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (!MEDIA_TYPE_PATTERN.test(normalized)) return null;
  if (normalized === "image/jpg" || normalized === "image/pjpeg") return "image/jpeg";
  if (normalized === "image/vnd.microsoft.icon") return "image/x-icon";
  return normalized;
}

export function detectMediaType(sample: Uint8Array): string {
  if (startsWith(sample, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(sample, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (ascii(sample, 0, 6) === "GIF87a" || ascii(sample, 0, 6) === "GIF89a") return "image/gif";
  if (ascii(sample, 0, 4) === "RIFF" && ascii(sample, 8, 12) === "WEBP") return "image/webp";
  if (ascii(sample, 4, 8) === "ftyp" && hasIsoBrand(sample, "avif", "avis")) return "image/avif";
  if (startsWith(sample, [0x00, 0x00, 0x01, 0x00])) return "image/x-icon";
  if (startsWith(sample, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  if (startsWith(sample, [0x50, 0x4b, 0x03, 0x04]) || startsWith(sample, [0x50, 0x4b, 0x05, 0x06])) return "application/zip";
  if (startsWith(sample, [0x1f, 0x8b])) return "application/gzip";

  const text = decodeText(sample);
  if (text === null) return "application/octet-stream";
  const prefix = text.slice(0, FILE_TYPE_SAMPLE_BYTES).trimStart().toLowerCase();
  if (looksLikeSvg(prefix)) return "image/svg+xml";
  if (looksLikeHtml(prefix)) return "text/html";
  if (prefix.startsWith("<?xml") || prefix.startsWith("<!doctype xml") || prefix.startsWith("<rss") || prefix.startsWith("<feed")) {
    return "application/xml";
  }
  return "text/plain";
}

export function fileResponsePolicy(input: {
  declaredMediaType: unknown;
  detectedMediaType: unknown;
  allowInline: boolean;
}): FileResponsePolicy {
  const declaredMediaType = normalizeMediaType(input.declaredMediaType);
  const detectedMediaType = normalizeMediaType(input.detectedMediaType) ?? "application/octet-stream";
  const mediaTypeMatches = declaredMediaType !== null && declaredMediaType === detectedMediaType;
  const disposition = input.allowInline && mediaTypeMatches && PASSIVE_INLINE_MEDIA_TYPES.has(detectedMediaType)
    ? "inline"
    : "attachment";
  return {
    contentType: disposition === "inline" ? detectedMediaType : "application/octet-stream",
    disposition,
    declaredMediaType,
    detectedMediaType,
    mediaTypeMatches,
  };
}

export function setUntrustedFileResponseHeaders(
  response: ServerResponse,
  input: {
    fileName: string;
    policy: Pick<FileResponsePolicy, "contentType" | "disposition">;
    crossOriginResourcePolicy?: "cross-origin" | "same-origin" | "same-site";
  },
): void {
  response.setHeader("Content-Type", input.policy.contentType);
  response.setHeader("Content-Disposition", contentDisposition(input.policy.disposition, input.fileName));
  response.setHeader("Content-Security-Policy", FILE_RESPONSE_CSP);
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  // Protected files remain credential-gated. `same-site` permits the supported
  // web.example.com -> api.example.com deployment without exposing passive
  // previews to unrelated sites.
  response.setHeader("Cross-Origin-Resource-Policy", input.crossOriginResourcePolicy ?? "same-site");
}

export function contentDisposition(disposition: "attachment" | "inline", fileName: string): string {
  const normalized = safeUnicodePrefix(fileName
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\\/]/g, "-")
    .replace(/\s+/g, " ")
    .trim(), 180) || "download";
  const fallback = normalized
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_")
    .slice(0, 180) || "download";
  const encoded = encodeURIComponent(normalized).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function safeUnicodePrefix(value: string, maximumCodePoints: number): string {
  let result = "";
  let count = 0;
  for (const character of value) {
    if (count >= maximumCodePoints) break;
    const codePoint = character.codePointAt(0)!;
    // `for...of` preserves valid surrogate pairs. Replace a lone surrogate so
    // encodeURIComponent can never throw on malformed persisted metadata.
    result += codePoint >= 0xd800 && codePoint <= 0xdfff ? "\ufffd" : character;
    count += 1;
  }
  return result;
}

export async function bufferBodyPrefix(
  body: AsyncIterable<Uint8Array>,
  maximumBytes = FILE_TYPE_SAMPLE_BYTES,
): Promise<{ sample: Uint8Array; body: AsyncIterable<Uint8Array>; cancel: () => Promise<void> }> {
  const iterator = body[Symbol.asyncIterator]();
  const buffered: Uint8Array[] = [];
  const sampleParts: Uint8Array[] = [];
  let sampleBytes = 0;
  let sourceDone = false;
  while (sampleBytes < maximumBytes) {
    const next = await iterator.next();
    if (next.done) {
      sourceDone = true;
      break;
    }
    const chunk = next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value);
    buffered.push(chunk);
    const remaining = maximumBytes - sampleBytes;
    const samplePart = chunk.subarray(0, Math.min(chunk.byteLength, remaining));
    sampleParts.push(samplePart);
    sampleBytes += samplePart.byteLength;
    if (chunk.byteLength >= remaining) break;
  }

  let consumed = false;
  const replay = {
    async *[Symbol.asyncIterator]() {
      if (consumed) throw new Error("Stored file response bodies can only be consumed once");
      consumed = true;
      try {
        for (const chunk of buffered) yield chunk;
        while (!sourceDone) {
          const next = await iterator.next();
          if (next.done) {
            sourceDone = true;
            break;
          }
          yield next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value);
        }
      } finally {
        if (!sourceDone && iterator.return) {
          await iterator.return();
          sourceDone = true;
        }
      }
    },
  };

  return {
    sample: concatenate(sampleParts, sampleBytes),
    body: replay,
    cancel: async () => {
      if (!sourceDone && iterator.return) await iterator.return();
      sourceDone = true;
    },
  };
}

export async function readBodyBounded(body: AsyncIterable<Uint8Array>, maximumBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) throw new Error("A valid file-response byte limit is required");
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for await (const value of body) {
    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
    totalBytes += chunk.byteLength;
    if (totalBytes > maximumBytes) throw new Error(`Stored file response exceeds the ${maximumBytes} byte limit`);
    chunks.push(chunk);
  }
  return concatenate(chunks, totalBytes);
}

function startsWith(value: Uint8Array, signature: readonly number[]): boolean {
  return value.byteLength >= signature.length && signature.every((byte, index) => value[index] === byte);
}

function ascii(value: Uint8Array, start: number, end: number): string {
  if (value.byteLength < end) return "";
  return String.fromCharCode(...value.subarray(start, end));
}

function hasIsoBrand(value: Uint8Array, ...brands: string[]): boolean {
  for (let offset = 8; offset + 4 <= Math.min(value.byteLength, 64); offset += 4) {
    if (brands.includes(ascii(value, offset, offset + 4))) return true;
  }
  return false;
}

function decodeText(value: Uint8Array): string | null {
  if (value.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    return null;
  }
}

function looksLikeSvg(value: string): boolean {
  if (value.startsWith("<svg") || value.startsWith("<!doctype svg")) return true;
  if (!value.startsWith("<?xml")) return false;
  const declarationEnd = value.indexOf("?>");
  return declarationEnd >= 0 && value.slice(declarationEnd + 2).trimStart().startsWith("<svg");
}

function looksLikeHtml(value: string): boolean {
  return ["<!doctype html", "<html", "<head", "<body", "<script", "<iframe", "<object", "<embed", "<link", "<meta"]
    .some((prefix) => value.startsWith(prefix));
}

function concatenate(parts: readonly Uint8Array[], totalBytes: number): Uint8Array {
  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}
