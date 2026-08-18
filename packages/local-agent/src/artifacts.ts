import { basename, extname } from "node:path";

const DEFAULT_ARTIFACT_MEDIA_TYPE = "application/octet-stream";

const MEDIA_TYPE_BY_EXTENSION: Record<string, string> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".csv": "text/csv",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".docm": "application/vnd.ms-word.document.macroEnabled.12",
  ".epub": "application/epub+zip",
  ".gif": "image/gif",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".md": "text/markdown",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".odp": "application/vnd.oasis.opendocument.presentation",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".pptm": "application/vnd.ms-powerpoint.presentation.macroEnabled.12",
  ".py": "text/x-python",
  ".rtf": "application/rtf",
  ".svg": "image/svg+xml",
  ".tar": "application/x-tar",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".tsv": "text/tab-separated-values",
  ".txt": "text/plain",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".zip": "application/zip",
};

const AUTO_PUBLISH_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".csv",
  ".doc",
  ".docx",
  ".docm",
  ".epub",
  ".gif",
  ".html",
  ".jpeg",
  ".jpg",
  ".json",
  ".md",
  ".mov",
  ".mp3",
  ".mp4",
  ".odp",
  ".ods",
  ".odt",
  ".pdf",
  ".png",
  ".ppt",
  ".pptx",
  ".pptm",
  ".rtf",
  ".svg",
  ".tar",
  ".tif",
  ".tiff",
  ".tsv",
  ".txt",
  ".wav",
  ".webm",
  ".webp",
  ".xls",
  ".xlsx",
  ".xml",
  ".yaml",
  ".yml",
  ".zip",
]);

const DEFAULT_ARTIFACT_EXTENSION_BY_MEDIA_TYPE: Record<string, string> = {
  "application/epub+zip": ".epub",
  "application/gzip": ".gz",
  "application/msword": ".doc",
  "application/pdf": ".pdf",
  "application/rtf": ".rtf",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.ms-powerpoint.presentation.macroEnabled.12": ".pptm",
  "application/vnd.ms-word.document.macroEnabled.12": ".docm",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/zip": ".zip",
  "image/avif": ".avif",
  "image/bmp": ".bmp",
  "image/gif": ".gif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/svg+xml": ".svg",
  "image/tiff": ".tiff",
  "image/webp": ".webp",
  "text/csv": ".csv",
  "text/html": ".html",
  "text/markdown": ".md",
  "text/plain": ".txt",
};

const GENERIC_ZIP_MEDIA_TYPE = "application/zip";

export function artifactMediaType(pathOrName: string): string {
  return MEDIA_TYPE_BY_EXTENSION[extname(pathOrName).toLowerCase()] ?? DEFAULT_ARTIFACT_MEDIA_TYPE;
}

export function artifactDisplayName(sourcePath: string, requestedName?: string | null, mediaType?: string): string {
  const sourceName = basename(sourcePath) || "artifact";
  const name = requestedName?.trim() || sourceName;
  const sourceExtension = artifactMediaType(sourcePath) !== DEFAULT_ARTIFACT_MEDIA_TYPE ? extname(sourceName) : undefined;
  const extension = sourceExtension ?? DEFAULT_ARTIFACT_EXTENSION_BY_MEDIA_TYPE[mediaType?.trim().toLowerCase() ?? ""];
  return extension && !extname(name) ? `${name}${extension}` : name;
}

export function resolveArtifactMediaType(input: {
  bytes: Uint8Array;
  sourcePath: string;
  requestedName?: string | null;
  explicitMediaType?: string | null;
}): string {
  const detectedMediaType = detectArtifactMediaType(input.bytes);
  const explicitMediaType = input.explicitMediaType?.trim();
  const sourceMediaType = artifactMediaType(input.sourcePath);
  const nameMediaType = artifactMediaType(input.requestedName ?? "");

  // A ZIP container can be a DOCX/XLSX/PPTX, so a generic ZIP result should
  // yield to a known semantic extension when the container could not be
  // classified. Strong signatures (PDF, images, audio/video) win over
  // agent-supplied metadata and misleading extensions.
  if (detectedMediaType && detectedMediaType !== GENERIC_ZIP_MEDIA_TYPE) return detectedMediaType;
  if (explicitMediaType) return explicitMediaType;
  if (sourceMediaType !== DEFAULT_ARTIFACT_MEDIA_TYPE) return sourceMediaType;
  if (nameMediaType !== DEFAULT_ARTIFACT_MEDIA_TYPE) return nameMediaType;
  return detectedMediaType ?? DEFAULT_ARTIFACT_MEDIA_TYPE;
}

export function detectArtifactMediaType(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") return "image/gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp";
  if (startsWith(bytes, [0x42, 0x4d])) return "image/bmp";
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return "image/tiff";
  if (startsWith(bytes, [0x1f, 0x8b])) return "application/gzip";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WAVE") return "audio/wav";
  if (ascii(bytes, 0, 3) === "ID3") return "audio/mpeg";
  if (ascii(bytes, 4, 8) === "ftyp") {
    const brand = ascii(bytes, 8, 12);
    if (brand === "avif" || brand === "avis") return "image/avif";
    if (brand === "qt  ") return "video/quicktime";
    return "video/mp4";
  }
  if (ascii(bytes, 257, 262) === "ustar") return "application/x-tar";
  if (startsWith(bytes, [0x7b, 0x5c, 0x72, 0x74, 0x66])) return "application/rtf";

  if (isZip(bytes)) return zipMediaType(bytes);
  return null;
}

export function isAutoPublishableArtifact(pathOrName: string): boolean {
  const name = basename(pathOrName);
  if (!name || name.startsWith(".") || name.endsWith("~")) return false;
  return AUTO_PUBLISH_EXTENSIONS.has(extname(name).toLowerCase());
}

function zipMediaType(bytes: Uint8Array): string {
  const entries = zipEntryNames(bytes);
  if (entries) {
    const hasVbaProject = entries.some((entry) => entry.endsWith("/vbaProject.bin") || entry === "vbaProject.bin");
    if (entries.some((entry) => entry.startsWith("word/"))) {
      return hasVbaProject ? "application/vnd.ms-word.document.macroEnabled.12" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    }
    if (entries.some((entry) => entry.startsWith("xl/"))) {
      return hasVbaProject ? "application/vnd.ms-excel.sheet.macroEnabled.12" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    }
    if (entries.some((entry) => entry.startsWith("ppt/"))) {
      return hasVbaProject ? "application/vnd.ms-powerpoint.presentation.macroEnabled.12" : "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    }
  }
  if (containsAscii(bytes, "application/epub+zip")) return "application/epub+zip";
  if (containsAscii(bytes, "application/vnd.oasis.opendocument.text")) return "application/vnd.oasis.opendocument.text";
  if (containsAscii(bytes, "application/vnd.oasis.opendocument.spreadsheet")) return "application/vnd.oasis.opendocument.spreadsheet";
  if (containsAscii(bytes, "application/vnd.oasis.opendocument.presentation")) return "application/vnd.oasis.opendocument.presentation";
  return GENERIC_ZIP_MEDIA_TYPE;
}

function zipEntryNames(bytes: Uint8Array): string[] | null {
  const eocdOffset = findEndOfCentralDirectory(bytes);
  if (eocdOffset === null) return null;
  const entryCount = readUint16(bytes, eocdOffset + 10);
  const centralDirectorySize = readUint32(bytes, eocdOffset + 12);
  const centralDirectoryOffset = readUint32(bytes, eocdOffset + 16);
  if (entryCount === null || centralDirectorySize === null || centralDirectoryOffset === null
    || centralDirectorySize === 0xffffffff || centralDirectoryOffset === 0xffffffff
    || centralDirectoryOffset + centralDirectorySize > bytes.length) {
    return null;
  }

  const entries: string[] = [];
  let cursor = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (readUint32(bytes, cursor) !== 0x02014b50) return null;
    const nameLength = readUint16(bytes, cursor + 28);
    const extraLength = readUint16(bytes, cursor + 30);
    const commentLength = readUint16(bytes, cursor + 32);
    if (nameLength === null || extraLength === null || commentLength === null) return null;
    const nameStart = cursor + 46;
    const next = nameStart + nameLength + extraLength + commentLength;
    if (next > bytes.length || next > centralDirectoryOffset + centralDirectorySize) return null;
    entries.push(new TextDecoder().decode(bytes.subarray(nameStart, nameStart + nameLength)));
    cursor = next;
  }
  return entries;
}

function findEndOfCentralDirectory(bytes: Uint8Array): number | null {
  const firstOffset = Math.max(0, bytes.length - 22 - 0xffff);
  for (let offset = bytes.length - 22; offset >= firstOffset; offset -= 1) {
    if (readUint32(bytes, offset) === 0x06054b50) return offset;
  }
  return null;
}

function isZip(bytes: Uint8Array): boolean {
  return startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])
    || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])
    || startsWith(bytes, [0x50, 0x4b, 0x07, 0x08]);
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  if (start < 0 || end > bytes.length || start >= end) return "";
  return String.fromCharCode(...bytes.subarray(start, end));
}

function containsAscii(bytes: Uint8Array, value: string): boolean {
  const needle = new TextEncoder().encode(value);
  outer: for (let offset = 0; offset <= bytes.length - needle.length; offset += 1) {
    for (let index = 0; index < needle.length; index += 1) {
      if (bytes[offset + index] !== needle[index]) continue outer;
    }
    return true;
  }
  return false;
}

function readUint16(bytes: Uint8Array, offset: number): number | null {
  if (offset < 0 || offset + 2 > bytes.length) return null;
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readUint32(bytes: Uint8Array, offset: number): number | null {
  if (offset < 0 || offset + 4 > bytes.length) return null;
  return (bytes[offset]!
    | (bytes[offset + 1]! << 8)
    | (bytes[offset + 2]! << 16)
    | (bytes[offset + 3]! << 24)) >>> 0;
}
