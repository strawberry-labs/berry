import { createHash } from "node:crypto";
import sharp, { type Sharp } from "sharp";
import type { ChatMessage, ChatToolDefinition } from "@berry/router-client";

// These are encoded-payload limits, not source-file sizes. Five images leave
// room for conversation text, tools, and JSON below common 5 MiB ingress caps.
export const MODEL_IMAGE_LIMITS = {
  maxCount: 5,
  maxSourceBytes: 20 * 1024 * 1024,
  maxDimension: 2_000,
  maxBase64Bytes: 600 * 1024,
  maxTotalBase64Bytes: 3 * 1024 * 1024,
  maxInputPixels: 40_000_000,
} as const;

export type PreparedModelImage = {
  ok: true;
  data: string;
  mediaType: string;
  originalWidth: number;
  originalHeight: number;
  width: number;
  height: number;
  transformed: boolean;
  firstFrameOnly: boolean;
  /** Background that transparent pixels were flattened onto, if any. */
  matte?: "white" | "black";
} | { ok: false; reason: string };

// Repeated model steps re-read the same authorized sources. Cache only the
// bounded previews, keyed by content rather than path (files can be replaced).
const cache = new Map<string, Extract<PreparedModelImage, { ok: true }>>();
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
let cacheBytes = 0;

export async function prepareModelImage(
  input: Uint8Array,
  signal?: AbortSignal,
): Promise<PreparedModelImage> {
  signal?.throwIfAborted();
  if (input.byteLength === 0 || input.byteLength > MODEL_IMAGE_LIMITS.maxSourceBytes) {
    return { ok: false, reason: "the source is empty or exceeds the 20 MiB image inspection limit" };
  }
  const key = createHash("sha256").update(input).digest("hex");
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const source = () => sharp(bytes, {
    limitInputPixels: MODEL_IMAGE_LIMITS.maxInputPixels,
    failOn: "warning",
    sequentialRead: true,
    animated: false,
  }).timeout({ seconds: 5 });
  try {
    const meta = await source().metadata();
    signal?.throwIfAborted();
    if (!meta.width || !meta.height || !["png", "jpeg", "webp", "gif", "tiff", "heif", "avif"].includes(meta.format ?? "")) {
      return { ok: false, reason: "the file is not a supported raster image" };
    }
    const swap = (meta.orientation ?? 1) >= 5;
    const originalWidth = swap ? meta.height : meta.width;
    const originalHeight = swap ? meta.width : meta.height;
    const firstFrameOnly = (meta.pages ?? 1) > 1;
    // Providers composite transparency differently (often onto black, which hides
    // dark text), so transparent images get an explicit contrasting matte (H-042).
    const matte = meta.hasAlpha ? await transparencyMatte(source) : null;
    signal?.throwIfAborted();
    const result = (buffer: Buffer, mediaType: string, width: number, height: number, transformed: boolean): PreparedModelImage => {
      const data = buffer.toString("base64");
      if (data.length > MODEL_IMAGE_LIMITS.maxBase64Bytes) {
        return { ok: false, reason: "the encoded preview exceeds its image budget" };
      }
      const prepared = {
        ok: true as const, data, mediaType, originalWidth, originalHeight, width, height, transformed, firstFrameOnly,
        ...(matte ? { matte: matte === "#000000" ? "black" as const : "white" as const } : {}),
      };
      const existing = cache.get(key);
      if (existing) { cacheBytes -= existing.data.length; cache.delete(key); }
      while (cache.size > 0 && (cacheBytes + data.length > MAX_CACHE_BYTES || cache.size >= 128)) {
        const oldest = cache.keys().next().value!;
        cacheBytes -= cache.get(oldest)!.data.length;
        cache.delete(oldest);
      }
      cache.set(key, prepared);
      cacheBytes += data.length;
      return prepared;
    };
    if (
      ["png", "jpeg", "webp"].includes(meta.format!)
      && !matte
      && (meta.orientation ?? 1) === 1 && !firstFrameOnly
      && originalWidth <= MODEL_IMAGE_LIMITS.maxDimension
      && originalHeight <= MODEL_IMAGE_LIMITS.maxDimension
      && Math.ceil(bytes.byteLength / 3) * 4 <= MODEL_IMAGE_LIMITS.maxBase64Bytes
    ) {
      return result(bytes, `image/${meta.format}`, originalWidth, originalHeight, false);
    }
    // Retain readable dimensions before reducing them. PNG protects diagrams
    // and text; JPEG with a white matte bounds photographs and transparency.
    for (let dimension: number = MODEL_IMAGE_LIMITS.maxDimension; ; dimension = Math.max(512, Math.floor(dimension * 0.75))) {
      const pipeline = () => {
        const resized = source().rotate().resize({ width: dimension, height: dimension, fit: "inside", withoutEnlargement: true });
        return matte ? resized.flatten({ background: matte }) : resized;
      };
      signal?.throwIfAborted();
      const png = await pipeline().png({ compressionLevel: 6 }).toBuffer({ resolveWithObject: true });
      signal?.throwIfAborted();
      if (Math.ceil(png.data.byteLength / 3) * 4 <= MODEL_IMAGE_LIMITS.maxBase64Bytes) {
        return result(png.data, "image/png", png.info.width, png.info.height, true);
      }
      for (const quality of [88, 78, 65, 50]) {
        const jpeg = await pipeline().flatten({ background: matte ?? "#ffffff" }).jpeg({ quality, chromaSubsampling: "4:4:4" }).toBuffer({ resolveWithObject: true });
        signal?.throwIfAborted();
        if (Math.ceil(jpeg.data.byteLength / 3) * 4 <= MODEL_IMAGE_LIMITS.maxBase64Bytes) {
          return result(jpeg.data, "image/jpeg", jpeg.info.width, jpeg.info.height, true);
        }
      }
      if (dimension === 512) break;
    }
    return { ok: false, reason: "a readable preview could not fit within the encoded image limit" };
  } catch {
    signal?.throwIfAborted();
    return { ok: false, reason: "the image could not be decoded safely or resized within the processing limit" };
  }
}

/**
 * Matte for an image with real transparency: white, or black when the visible
 * content is itself light (for example a white logo). Null when fully opaque.
 */
async function transparencyMatte(source: () => Sharp): Promise<"#ffffff" | "#000000" | null> {
  if ((await source().stats()).isOpaque) return null;
  const { data, info } = await source()
    .resize(128, 128, { fit: "inside" })
    .toColourspace("srgb")
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let weight = 0;
  let luminance = 0;
  for (let index = 0; index + 3 < data.length; index += info.channels) {
    const alpha = data[index + 3]! / 255;
    weight += alpha;
    luminance += alpha * (0.2126 * data[index]! + 0.7152 * data[index + 1]! + 0.0722 * data[index + 2]!) / 255;
  }
  return weight > 0 && luminance / weight > 0.6 ? "#000000" : "#ffffff";
}

export function modelImageOmission(path: string, reason: string): string {
  return `[Image not sent: ${JSON.stringify(path)}; ${reason}. The original file is unchanged. Use bash to create a smaller PNG/JPEG copy or crop the relevant region, then read that new path. Do not repeat read on this unchanged image or claim to have seen its pixels.]`;
}

/** Final image gate includes text, schemas, UTF-8 bytes, and JSON framing. */
export function limitModelImagePayload(
  messages: ChatMessage[],
  tools: readonly ChatToolDefinition[],
  maxBytes = 4 * 1024 * 1024,
): ChatMessage[] {
  const size = (value: ChatMessage[]) => Buffer.byteLength(JSON.stringify({ messages: value, tools }), "utf8") + 16_384;
  if (size(messages) <= maxBytes) return messages;
  const bounded = messages.map((message) => ({ ...message, content: Array.isArray(message.content) ? [...message.content] : message.content }));
  // Prefer the newest exposed images. Never change durable history or files.
  for (const message of bounded) {
    if (!Array.isArray(message.content)) continue;
    for (let index = 0; index < message.content.length; index += 1) {
      const part = message.content[index]!;
      if (part.type !== "image_url") continue;
      message.content[index] = {
        type: "text",
        text: "[Image not sent: the combined model request exceeds the image payload budget. Use bash to make smaller image copies or crop the relevant details, then read those new paths. Do not claim to have seen this image.]",
      };
      if (size(bounded) <= maxBytes) return bounded;
    }
  }
  // Text-only context overflow is handled by the runner's compaction policy.
  return bounded;
}
