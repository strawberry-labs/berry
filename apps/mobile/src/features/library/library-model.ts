import { PASSIVE_INLINE_FILE_MEDIA_TYPES, type StoredFile, type StoredFilePage, type Workspace } from "@berry/shared";

/** Platform-neutral Library logic ported from apps/web/src/components/library. */

export const LIBRARY_TABS = ["all", "images", "documents"] as const;
export type LibraryTab = (typeof LIBRARY_TABS)[number];
export const LIBRARY_PAGE_SIZE = 50;
/** The web's passive-image ceiling (PREVIEW_LIMITS.imageBytes). */
export const IMAGE_PREVIEW_MAX_BYTES = 25 * 1024 * 1024;

export function parseLibraryTab(value: unknown): LibraryTab {
  return typeof value === "string" && (LIBRARY_TABS as readonly string[]).includes(value) ? value as LibraryTab : "all";
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function fileExtension(name: string): string {
  const trimmed = name.trim().toLowerCase();
  const dot = trimmed.lastIndexOf(".");
  return dot > 0 ? trimmed.slice(dot + 1).trim() : "";
}

export function fileTypeLabel(file: Pick<StoredFile, "name" | "mediaType">): string {
  const extension = fileExtension(file.name).toUpperCase();
  if (extension && extension.length <= 8) return extension;
  if (file.mediaType.startsWith("image/")) return "Image";
  if (file.mediaType.startsWith("text/")) return "Text";
  return "File";
}

/** "PNG · 1.2 MB · 10/9/2026", the web card's metadata line. */
export function fileMetaLine(file: Pick<StoredFile, "name" | "mediaType" | "size" | "createdAt">, locale?: string): string {
  return `${fileTypeLabel(file)} · ${formatBytes(file.size)} · ${new Date(file.createdAt).toLocaleDateString(locale)}`;
}

const PASSIVE_IMAGE_MEDIA_TYPES = new Set<string>(PASSIVE_INLINE_FILE_MEDIA_TYPES);
const IMAGE_EXTENSION_MEDIA_TYPES: Record<string, string> = {
  avif: "image/avif",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heic",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  tif: "image/tiff",
  tiff: "image/tiff",
  webp: "image/webp",
};

function normalizedMediaType(value: string | null | undefined): string | null {
  if (!value) return null;
  const mediaType = value.split(";", 1)[0]!.trim().toLowerCase();
  if (!mediaType) return null;
  if (mediaType === "image/jpg" || mediaType === "image/pjpeg") return "image/jpeg";
  if (mediaType === "image/vnd.microsoft.icon") return "image/x-icon";
  return mediaType;
}

type ImageCandidate = Pick<StoredFile, "name" | "mediaType"> & {
  declaredMediaType?: string | null | undefined;
  detectedMediaType?: string | null | undefined;
  size?: number | null | undefined;
};

/**
 * The web's isPassiveInlineImageFile: only signature-validated raster images
 * whose extension, declared and detected types agree are shown inline. SVG
 * and anything ambiguous stays a document that opens in another app.
 */
export function isImageFile(file: ImageCandidate): boolean {
  if (file.size != null && file.size > IMAGE_PREVIEW_MAX_BYTES) return false;
  const detected = normalizedMediaType(file.detectedMediaType);
  const declared = normalizedMediaType(file.declaredMediaType ?? file.mediaType);
  const mediaType = detected ?? declared;
  const extension = fileExtension(file.name);
  const extensionMatches = IMAGE_EXTENSION_MEDIA_TYPES[extension] === mediaType;
  return Boolean(mediaType && PASSIVE_IMAGE_MEDIA_TYPES.has(mediaType) && extensionMatches && (!detected || !declared || detected === declared));
}

export function libraryItemsForTab<T extends ImageCandidate>(items: readonly T[], tab: LibraryTab): T[] {
  if (tab === "images") return items.filter(isImageFile);
  if (tab === "documents") return items.filter((item) => !isImageFile(item));
  return [...items];
}

export function libraryTabCounts(items: readonly ImageCandidate[]): Record<LibraryTab, number> {
  const images = items.filter(isImageFile).length;
  return { all: items.length, images, documents: items.length - images };
}

export function projectFilterWorkspaces(workspaces: readonly Workspace[]): Workspace[] {
  return workspaces.filter((workspace) => workspace.workspaceKind === "project");
}

/** Pages can overlap when files arrive between requests; keep the first copy, in API order. */
export function flattenLibraryPages(pages: readonly StoredFilePage[] | undefined): StoredFile[] {
  if (!pages) return [];
  const seen = new Set<string>();
  const items: StoredFile[] = [];
  for (const page of pages) {
    for (const item of page.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
  }
  return items;
}

export function removeFileFromPages<T extends { pages: StoredFilePage[] }>(data: T | undefined, fileId: string): T | undefined {
  if (!data) return data;
  return { ...data, pages: data.pages.map((page) => ({ ...page, items: page.items.filter((item) => item.id !== fileId) })) };
}

export type FileGlyphKind = "image" | "pdf" | "doc" | "sheet" | "csv" | "slides" | "archive" | "text" | "code" | "audio" | "video" | "file";

const GLYPH_EXTENSIONS: Array<[FileGlyphKind, RegExp]> = [
  ["pdf", /^pdf$/],
  ["doc", /^(docx?|odt|rtf|pages)$/],
  ["sheet", /^(xlsx?|ods|numbers)$/],
  ["csv", /^(csv|tsv)$/],
  ["slides", /^(pptx?|odp|key)$/],
  ["archive", /^(zip|skill|tar|gz|tgz|rar|7z|bz2)$/],
  ["text", /^(txt|md|mdx|log|rst)$/],
  ["code", /^(c|cc|cpp|cs|css|go|h|hpp|html?|ini|java|jsx?|json|jsonc|mjs|php|py|rb|rs|scss|sh|sql|swift|kt|toml|tsx?|xml|ya?ml|zsh)$/],
  ["image", /^(avif|bmp|gif|heic|heif|ico|jpe?g|png|svg|tiff?|webp)$/],
  ["audio", /^(mp3|m4a|wav|aac|flac|ogg)$/],
  ["video", /^(mp4|mov|m4v|webm|avi|mkv)$/],
];

/** Which file-type glyph stands in for a thumbnail, by extension then media type. */
export function fileGlyphKind(file: Pick<StoredFile, "name" | "mediaType">): FileGlyphKind {
  const extension = fileExtension(file.name);
  for (const [kind, pattern] of GLYPH_EXTENSIONS) if (pattern.test(extension)) return kind;
  const mediaType = file.mediaType.toLowerCase();
  if (mediaType === "application/pdf") return "pdf";
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("audio/")) return "audio";
  if (mediaType.startsWith("video/")) return "video";
  if (mediaType.startsWith("text/")) return "text";
  return "file";
}

/** A file name that is safe as a single path segment in the app's cache. */
export function safeLocalFileName(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, "-")
    .replace(/^[.\s-]+/, "")
    .trim()
    .slice(-160);
  return cleaned || "file";
}

/** Native download failures carry the HTTP status in their message; map them to the web's copy. */
export function downloadErrorMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause ?? "");
  if (/\b401\b/.test(message)) return "You've been signed out of this server.";
  if (/\b40[34]\b/.test(message)) return "This file is unavailable or you no longer have access to it.";
  if (/network|offline|internet|timed? ?out/i.test(message)) return "Couldn't reach the server. Check your connection and try again.";
  return "Download failed. Please retry.";
}

export function downloadPercent(received: number, total: number | null): number | null {
  if (!total || total <= 0) return null;
  return Math.max(0, Math.min(100, Math.floor((received / total) * 100)));
}
