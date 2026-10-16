import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import type { ChatMessage, ChatToolDefinition } from "@berry/router-client";
import { limitModelImagePayload, MODEL_IMAGE_LIMITS, modelImageOmission, prepareModelImage } from "./model-image.js";

describe("model image preparation", () => {
  it("preserves a small valid PNG byte-for-byte and reuses its preview", async () => {
    // An RGBA PNG whose pixels are all opaque (typical screenshots) still passes through.
    const source = await sharp({ create: { width: 100, height: 50, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } } }).png().toBuffer();
    const before = Buffer.from(source);
    const result = await prepareModelImage(source);
    expect(result).toMatchObject({ ok: true, data: source.toString("base64"), mediaType: "image/png", width: 100, height: 50, transformed: false });
    expect(source.equals(before)).toBe(true);
    expect(await prepareModelImage(source)).toBe(result);
  });

  it("resizes dimension-heavy images even when their compressed file is small", async () => {
    const source = await sharp({ create: { width: 4_000, height: 2_000, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    expect(source.byteLength).toBeLessThan(MODEL_IMAGE_LIMITS.maxBase64Bytes);
    const result = await prepareModelImage(source);
    expect(result).toMatchObject({ ok: true, originalWidth: 4_000, originalHeight: 2_000, width: 2_000, height: 1_000, transformed: true });
    if (!result.ok) throw new Error(result.reason);
    expect(result.data.length).toBeLessThanOrEqual(MODEL_IMAGE_LIMITS.maxBase64Bytes);
    // Fully transparent: flattened onto white, so it still reads as blank (H-042).
    const flattened = await sharp(Buffer.from(result.data, "base64")).stats();
    expect(flattened.isOpaque).toBe(true);
    expect(flattened.channels.slice(0, 3).every((channel) => channel.min === 255 && channel.max === 255)).toBe(true);
  });

  describe("transparent images (H-042)", () => {
    /** A transparent canvas with one opaque band of the given grey level. */
    const banded = async (width: number, height: number, level: number, palette: boolean) => {
      const pixels = Buffer.alloc(width * height * 4);
      for (let y = Math.floor(height / 3); y < Math.floor((2 * height) / 3); y += 1) {
        for (let x = 0; x < width; x += 1) {
          const offset = (y * width + x) * 4;
          pixels[offset] = level; pixels[offset + 1] = level; pixels[offset + 2] = level; pixels[offset + 3] = 255;
        }
      }
      return sharp(pixels, { raw: { width, height, channels: 4 } }).png(palette ? { palette: true } : {}).toBuffer();
    };
    const pixel = async (data: string, x: number, y: number) => {
      const { data: raw, info } = await sharp(Buffer.from(data, "base64")).raw().toBuffer({ resolveWithObject: true });
      return raw[(y * info.width + x) * info.channels]!;
    };

    it("shows dark content on white instead of leaving the provider to composite it on black", async () => {
      // Shape of task f65e8afa: a wide palette PNG with dark text on transparency.
      const source = await banded(4_697, 131, 0, true);
      const before = Buffer.from(source);
      const result = await prepareModelImage(source);
      expect(result).toMatchObject({ ok: true, matte: "white", transformed: true, width: 2_000 });
      if (!result.ok) throw new Error(result.reason);
      expect((await sharp(Buffer.from(result.data, "base64")).stats()).isOpaque).toBe(true);
      expect(await pixel(result.data, 10, 2)).toBe(255);
      expect(await pixel(result.data, 10, Math.floor(result.height / 2))).toBeLessThan(30);
      expect(source.equals(before)).toBe(true);
    });

    it("shows light content such as a white logo on black", async () => {
      const result = await prepareModelImage(await banded(120, 60, 255, false));
      expect(result).toMatchObject({ ok: true, matte: "black", transformed: true, width: 120, height: 60 });
      if (!result.ok) throw new Error(result.reason);
      expect(await pixel(result.data, 5, 2)).toBe(0);
      expect(await pixel(result.data, 5, 30)).toBe(255);
    });
  });

  it("compresses noisy PNG data against its base64 size, not just pixel dimensions", async () => {
    const source = await sharp(randomBytes(1_400 * 1_000 * 3), { raw: { width: 1_400, height: 1_000, channels: 3 } }).png().toBuffer();
    const result = await prepareModelImage(source);
    expect(source.byteLength).toBeGreaterThan(4_000_000);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.mediaType).toBe("image/jpeg");
    expect(result.data.length).toBeLessThanOrEqual(MODEL_IMAGE_LIMITS.maxBase64Bytes);
    const decoded = await sharp(Buffer.from(result.data, "base64")).metadata();
    expect(decoded.width).toBe(result.width);
    expect(decoded.height).toBe(result.height);
    expect(result.width).toBeGreaterThanOrEqual(512);
    expect(result.width / result.height).toBeCloseTo(1.4, 2);
    expect(source.toString("base64").length / result.data.length).toBeGreaterThan(5);
  }, 20_000);

  it("normalizes EXIF orientation and reports the displayed dimensions", async () => {
    const source = await sharp({ create: { width: 80, height: 40, channels: 3, background: "red" } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const result = await prepareModelImage(source);
    expect(result).toMatchObject({ ok: true, originalWidth: 40, originalHeight: 80, width: 40, height: 80, transformed: true });
    if (!result.ok) throw new Error(result.reason);
    const meta = await sharp(Buffer.from(result.data, "base64")).metadata();
    expect(meta.orientation).toBeUndefined();
  });

  it("does not cache by path or reuse a preview after content changes", async () => {
    const a = await sharp({ create: { width: 10, height: 10, channels: 3, background: "red" } }).png().toBuffer();
    const b = await sharp({ create: { width: 10, height: 10, channels: 3, background: "blue" } }).png().toBuffer();
    expect(await prepareModelImage(a)).not.toEqual(await prepareModelImage(b));
  });

  it("rejects corrupt, empty, oversized, and decompression-heavy sources with an actionable notice", async () => {
    const largePixels = await sharp({ create: { width: 8_000, height: 6_000, channels: 3, background: "white" } }).png().toBuffer();
    for (const bytes of [Buffer.from("not an image"), Buffer.alloc(0), Buffer.alloc(MODEL_IMAGE_LIMITS.maxSourceBytes + 1), largePixels]) {
      const result = await prepareModelImage(bytes);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected omitted image");
      const notice = modelImageOmission("/workspace/image.png", result.reason);
      expect(notice).toContain("create a smaller PNG/JPEG copy or crop");
      expect(notice).toContain("original file is unchanged");
      expect(notice).toContain("Do not repeat read");
    }
  });

  it("honors cancellation even if the image was cached", async () => {
    const bytes = await sharp({ create: { width: 7, height: 9, channels: 3, background: "green" } }).png().toBuffer();
    await prepareModelImage(bytes);
    const controller = new AbortController();
    controller.abort(new Error("Cancelled image preparation"));
    await expect(prepareModelImage(bytes, controller.signal)).rejects.toThrow("Cancelled image preparation");
  });
});

describe("complete model image payload gate", () => {
  it("counts UTF-8 text and JSON bytes, removes oldest pixels first, and preserves history", () => {
    const messages: ChatMessage[] = [{ role: "user", content: [
      { type: "text", text: "界".repeat(5_000) },
      { type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(8_000)}` } },
      { type: "image_url", image_url: { url: `data:image/png;base64,${"B".repeat(8_000)}` } },
    ] }];
    const original = JSON.stringify(messages);
    const bounded = limitModelImagePayload(messages, [], 45_000);
    expect(JSON.stringify(messages)).toBe(original);
    expect(JSON.stringify(bounded)).not.toContain("A".repeat(8_000));
    expect(JSON.stringify(bounded)).toContain("B".repeat(8_000));
    expect(JSON.stringify(bounded)).toContain("Do not claim to have seen");
    expect(Buffer.byteLength(JSON.stringify({ messages: bounded, tools: [] })) + 16_384).toBeLessThanOrEqual(45_000);
  });

  it("reserves room for large tool schemas and leaves small requests untouched", () => {
    const messages: ChatMessage[] = [{ role: "user", content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${"C".repeat(20_000)}` } }] }];
    expect(limitModelImagePayload(messages, [], 50_000)).toBe(messages);
    const tools: ChatToolDefinition[] = [{ type: "function", function: { name: "test", description: "schema".repeat(3_000), parameters: {} } }];
    const bounded = limitModelImagePayload(messages, tools, 50_000);
    expect(JSON.stringify(bounded)).not.toContain("C".repeat(20_000));
    expect(JSON.stringify(bounded)).toContain("Image not sent");
  });
});
