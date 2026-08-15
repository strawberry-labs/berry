import { PASSIVE_INLINE_FILE_MEDIA_TYPES, type StoredFile } from "@berry/shared";

export type FilePreviewKind = "image" | "spreadsheet" | "docx" | "pptx" | "code" | "unsupported";

const PASSIVE_IMAGE_MEDIA_TYPES = new Set<string>(PASSIVE_INLINE_FILE_MEDIA_TYPES);
const IMAGE_FILE_EXTENSION = /\.(?:avif|bmp|gif|heic|heif|ico|jpe?g|png|svg|tiff?|webp)$/i;

export function isPassiveInlineImageFile(file: Pick<StoredFile, "name" | "mediaType">): boolean {
  return PASSIVE_IMAGE_MEDIA_TYPES.has(normalizedMediaType(file.mediaType));
}

export function filePreviewKind(file: Pick<StoredFile, "name" | "mediaType">): FilePreviewKind {
  const mediaType = normalizedMediaType(file.mediaType);
  const lowerName = file.name.toLowerCase();
  if (PASSIVE_IMAGE_MEDIA_TYPES.has(mediaType)) return "image";
  // Active or unsupported image formats must not fall through to an <img>, a
  // native browser plugin, or the code viewer based only on their extension.
  if (mediaType.startsWith("image/") || IMAGE_FILE_EXTENSION.test(lowerName)) return "unsupported";
  if (mediaType === "application/pdf" || lowerName.endsWith(".pdf")) return "unsupported";
  if (isSpreadsheet(lowerName)) return "spreadsheet";
  if (lowerName.endsWith(".docx")) return "docx";
  if (lowerName.endsWith(".pptx")) return "pptx";
  if (isCodeFile(lowerName, mediaType)) return "code";
  return "unsupported";
}

function normalizedMediaType(value: string): string {
  const mediaType = value.split(";", 1)[0]!.trim().toLowerCase();
  if (mediaType === "image/jpg" || mediaType === "image/pjpeg") return "image/jpeg";
  if (mediaType === "image/vnd.microsoft.icon") return "image/x-icon";
  return mediaType;
}

function isSpreadsheet(lowerName: string): boolean {
  const extension = lowerName.split(".").at(-1)?.trim();
  return Boolean(extension && ["xlsx", "xls", "csv", "tsv"].includes(extension));
}

function isCodeFile(lowerName: string, mediaType: string): boolean {
  if (mediaType.startsWith("text/")) return true;
  if (["application/json", "application/ld+json", "application/javascript", "application/sql", "application/xml", "application/x-yaml"].includes(mediaType)) return true;
  return /(?:^|\.)(?:c|cc|cpp|cs|css|cts|cxx|dockerfile|env|go|h|hpp|html|ini|java|js|json|jsonc|jsx|md|mdx|mjs|php|py|pyi|rb|rs|scss|sh|sql|toml|ts|tsx|txt|xml|ya?ml|zsh)$/i.test(lowerName);
}
