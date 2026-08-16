import { PREVIEW_LIMITS } from "./file-preview-policy";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const MAX_IMAGE_DIMENSION = 16_384;
const MAX_HEADER_SCAN_BYTES = 1 * 1024 * 1024;
const MAX_ICO_ENTRIES = 64;
const MAX_ICO_HEADER_WORK = 4 * 1024 * 1024;
const MAX_ANIMATION_FRAMES = 64;

export function assertImagePreviewBounds(bytes: Uint8Array, mediaType: string): void {
  let normalized = mediaType.split(";", 1)[0]!.trim().toLowerCase();
  if (normalized === "image/jpg" || normalized === "image/pjpeg") normalized = "image/jpeg";
  if (normalized === "image/vnd.microsoft.icon") normalized = "image/x-icon";
  const dimensions = normalized === "image/png" ? readPng(bytes)
    : normalized === "image/jpeg" ? readJpeg(bytes)
      : normalized === "image/gif" ? readGif(bytes)
        : normalized === "image/webp" ? readWebp(bytes)
          : normalized === "image/avif" ? readAvif(bytes)
          : normalized === "image/x-icon" ? readIco(bytes)
            : null;
  if (!dimensions) throw new Error("The image format cannot be bounded safely for preview.");
  const [width, height] = dimensions;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION || width * height > PREVIEW_LIMITS.maxImagePixels) {
    throw new Error("The image dimensions are too large to preview safely.");
  }
}

function readPng(bytes: Uint8Array): [number, number] | null {
  if (bytes.length < 24 || !PNG_SIGNATURE.every((value, index) => bytes[index] === value)) return null;
  return [readUint32(bytes, 16), readUint32(bytes, 20)];
}

function readGif(bytes: Uint8Array): [number, number] | null {
  if (bytes.length < 10 || !ascii(bytes, 0, 6).match(/^GIF8[79]a$/)) return null;
  // Animated frame descriptors can appear late in a GIF. Refuse files whose
  // complete frame stream is too large to inspect synchronously.
  if (bytes.length > MAX_HEADER_SCAN_BYTES) return null;
  let width = readUint16LE(bytes, 6);
  let height = readUint16LE(bytes, 8);
  if (width < 1 || height < 1) return null;
  let offset = 13;
  const globalTable = bytes[10]!;
  if (globalTable & 0x80) offset += 3 * (1 << ((globalTable & 0x07) + 1));
  let frames = 0;
  let framePixels = 0;
  while (offset < bytes.length) {
    const marker = bytes[offset++];
    if (marker === 0x3b) break;
    if (marker === 0x21) {
      if (offset >= bytes.length) return null;
      const next = skipGifSubBlocks(bytes, offset + 1);
      if (next == null) return null;
      offset = next;
      continue;
    }
    if (marker !== 0x2c || offset + 9 > bytes.length) return null;
    const frameWidth = readUint16LE(bytes, offset + 4);
    const frameHeight = readUint16LE(bytes, offset + 6);
    if (frameWidth < 1 || frameHeight < 1) return null;
    width = Math.max(width, frameWidth);
    height = Math.max(height, frameHeight);
    frames += 1;
    framePixels += frameWidth * frameHeight;
    if (frames > MAX_ANIMATION_FRAMES || framePixels > PREVIEW_LIMITS.maxImagePixels) return null;
    const imagePacked = bytes[offset + 8]!;
    offset += 9;
    if (imagePacked & 0x80) offset += 3 * (1 << ((imagePacked & 0x07) + 1));
    if (offset >= bytes.length) return null;
    offset += 1; // LZW minimum code size
    const next = skipGifSubBlocks(bytes, offset);
    if (next == null) return null;
    offset = next;
  }
  return [width, height];
}

function skipGifSubBlocks(bytes: Uint8Array, start: number): number | null {
  let offset = start;
  while (offset < bytes.length) {
    const length = bytes[offset++]!;
    if (length === 0) return offset;
    if (offset + length > bytes.length) return null;
    offset += length;
  }
  return null;
}

function readIco(bytes: Uint8Array): [number, number] | null {
  if (bytes.length < 6 || readUint16LE(bytes, 0) !== 0 || readUint16LE(bytes, 2) !== 1) return null;
  const count = readUint16LE(bytes, 4);
  if (count < 1 || count > MAX_ICO_ENTRIES || bytes.length < 6 + count * 16) return null;
  let width = 0;
  let height = 0;
  let headerWork = 0;
  for (let index = 0; index < count; index += 1) {
    const offset = 6 + index * 16;
    width = Math.max(width, bytes[offset] || 256);
    height = Math.max(height, bytes[offset + 1] || 256);
    const payloadBytes = readUint32LE(bytes, offset + 8);
    const payloadOffset = readUint32LE(bytes, offset + 12);
    if (payloadBytes < 1 || payloadOffset > bytes.length || payloadOffset + payloadBytes > bytes.length) return null;
    const payload = bytes.subarray(payloadOffset, payloadOffset + payloadBytes);
    headerWork += Math.min(payload.byteLength, MAX_HEADER_SCAN_BYTES);
    if (headerWork > MAX_ICO_HEADER_WORK) return null;
    const embedded = readPng(payload) ?? readJpeg(payload) ?? readDib(payload);
    if (!embedded) return null;
    width = Math.max(width, embedded[0]);
    height = Math.max(height, embedded[1]);
  }
  return [width, height];
}

function readDib(bytes: Uint8Array): [number, number] | null {
  if (bytes.length < 12) return null;
  const headerBytes = readUint32LE(bytes, 0);
  if (headerBytes >= 40 && bytes.length >= 12) {
    const width = readInt32LE(bytes, 4);
    const height = Math.abs(readInt32LE(bytes, 8));
    return [Math.abs(width), Math.max(1, Math.floor(height / 2))];
  }
  if (headerBytes === 12 && bytes.length >= 8) return [readUint16LE(bytes, 4), readUint16LE(bytes, 6)];
  return null;
}

function readWebp(bytes: Uint8Array): [number, number] | null {
  if (bytes.length < 16 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 12) !== "WEBP") return null;
  const chunk = ascii(bytes, 12, 16);
  if (chunk === "VP8X" && bytes.length >= 30) {
    const width = 1 + readUint24LE(bytes, 24);
    const height = 1 + readUint24LE(bytes, 27);
    if (bytes[20]! & 0x02) {
      if (bytes.length > MAX_HEADER_SCAN_BYTES) return null;
      let offset = 30;
      let frames = 0;
      let framePixels = 0;
      while (offset + 8 <= bytes.length) {
        const name = ascii(bytes, offset, offset + 4);
        const chunkBytes = readUint32LE(bytes, offset + 4);
        const payload = offset + 8;
        if (payload + chunkBytes > bytes.length) return null;
        if (name === "ANMF") {
          if (chunkBytes < 12) return null;
          const frameWidth = 1 + readUint24LE(bytes, payload + 6);
          const frameHeight = 1 + readUint24LE(bytes, payload + 9);
          frames += 1;
          framePixels += frameWidth * frameHeight;
          if (frames > MAX_ANIMATION_FRAMES || framePixels > PREVIEW_LIMITS.maxImagePixels) return null;
        }
        offset = payload + chunkBytes + (chunkBytes & 1);
      }
    }
    return [width, height];
  }
  if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    const width = 1 + (bytes[21]! | ((bytes[22]! & 0x3f) << 8));
    const height = 1 + (((bytes[22]! >> 6) & 0x03) | (bytes[23]! << 2) | ((bytes[24]! & 0x0f) << 10));
    return [width, height];
  }
  if (chunk === "VP8 " && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return [readUint16LE(bytes, 26) & 0x3fff, readUint16LE(bytes, 28) & 0x3fff];
  }
  return null;
}

function readAvif(bytes: Uint8Array): [number, number] | null {
  if (bytes.length < 16 || ascii(bytes, 4, 8) !== "ftyp") return null;
  // A primary-item ispe can appear after an early thumbnail. Only accept an
  // AVIF when the complete bounded metadata region can be inspected; larger
  // files remain download-only rather than guessing at decoded dimensions.
  if (bytes.length > MAX_HEADER_SCAN_BYTES) return null;
  const end = bytes.length - 16;
  let width = 0;
  let height = 0;
  for (let offset = 8; offset <= end; offset += 1) {
    if (!isAsciiAt(bytes, offset, "ispe")) continue;
    width = Math.max(width, readUint32(bytes, offset + 8));
    height = Math.max(height, readUint32(bytes, offset + 12));
  }
  return width > 0 && height > 0 ? [width, height] : null;
}

function readJpeg(bytes: Uint8Array): [number, number] | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  const end = Math.min(bytes.length, MAX_HEADER_SCAN_BYTES);
  while (offset + 4 <= end) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < end && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0xd8 || marker === 0xd9 || marker === 0x01) continue;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > end) return null;
    const segmentLength = readUint16(bytes, offset);
    if (segmentLength < 2 || offset + segmentLength > end) return null;
    const isStartOfFrame = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
    if (isStartOfFrame && segmentLength >= 7) return [readUint16(bytes, offset + 3), readUint16(bytes, offset + 5)];
    offset += segmentLength;
  }
  return null;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

function isAsciiAt(bytes: Uint8Array, offset: number, value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (bytes[offset + index] !== value.charCodeAt(index)) return false;
  }
  return true;
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readInt32LE(bytes: Uint8Array, offset: number): number {
  return readUint32LE(bytes, offset) | 0;
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! * 0x1000000);
}

function readUint16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function readUint24LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! * 0x1000000 + ((bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!);
}
