import { PASSIVE_INLINE_FILE_MEDIA_TYPES, type StoredFile } from "@berry/shared";

export type FilePreviewKind = "image" | "spreadsheet" | "docx" | "pptx" | "code" | "unsupported";

/**
 * These are deliberately client-side ceilings. The API remains the authority
 * for upload and download authorization; the browser policy prevents a
 * legitimate but pathological file from turning a preview into a renderer
 * or memory denial of service.
 */
export const PREVIEW_LIMITS = {
  imageBytes: 25 * 1024 * 1024,
  maxImagePixels: 16_000_000,
  codeBytes: 2 * 1024 * 1024,
  spreadsheetBytes: 25 * 1024 * 1024,
  // DOCX is rendered by docx-preview on the main thread. Keep its hard
  // ceiling materially below the generic office/archive ceiling; larger
  // documents are intentionally download-only because that renderer cannot
  // be terminated once parsing starts.
  docxBytes: 1 * 1024 * 1024,
  docxExpandedBytes: 4 * 1024 * 1024,
  docxEntryBytes: 2 * 1024 * 1024,
  legacySpreadsheetBytes: 2 * 1024 * 1024,
  pptxBytes: 50 * 1024 * 1024,
  officeBytes: 50 * 1024 * 1024,
  archiveExpandedBytes: 200 * 1024 * 1024,
  spreadsheetExpandedBytes: 50 * 1024 * 1024,
  spreadsheetEntryBytes: 10 * 1024 * 1024,
  archiveEntryCount: 5_000,
  archiveEntryBytes: 25 * 1024 * 1024,
  maxSlides: 200,
  maxPages: 20,
  maxSpreadsheetSheets: 50,
  maxSpreadsheetRows: 10_000,
  maxSpreadsheetColumns: 100,
  maxSpreadsheetCells: 200_000,
  maxSpreadsheetCellBytes: 256 * 1024,
  maxSpreadsheetOutputBytes: 8 * 1024 * 1024,
} as const;

const PASSIVE_IMAGE_MEDIA_TYPES = new Set<string>(PASSIVE_INLINE_FILE_MEDIA_TYPES);
const IMAGE_FILE_EXTENSION = /\.(?:avif|bmp|gif|heic|heif|ico|jpe?g|png|svg|tiff?|webp)$/i;
const IMAGE_EXTENSION_MEDIA_TYPES: Record<string, string> = {
  avif: "image/avif",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heic",
  ico: "image/x-icon",
  "x-icon": "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  tif: "image/tiff",
  tiff: "image/tiff",
  webp: "image/webp",
};

const PREVIEW_MEDIA_TYPES = {
  docx: new Set(["application/vnd.openxmlformats-officedocument.wordprocessingml.document"]),
  pptx: new Set(["application/vnd.openxmlformats-officedocument.presentationml.presentation"]),
  xlsx: new Set(["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]),
  xls: new Set(["application/vnd.ms-excel", "application/msexcel"]),
  csv: new Set(["text/csv", "application/csv", "text/plain"]),
  tsv: new Set(["text/tab-separated-values", "text/plain"]),
};

type PreviewFile = Pick<StoredFile, "name" | "mediaType"> & {
  declaredMediaType?: string | null | undefined;
  detectedMediaType?: string | null | undefined;
  size?: number | undefined;
};

export type PreviewDecision = {
  kind: FilePreviewKind;
  allowed: boolean;
  reason: string | null;
  maxSourceBytes: number | null;
};

export function fileExtension(name: string): string {
  return name.trim().toLowerCase().split(".").at(-1)?.trim() ?? "";
}

export function isPassiveInlineImageFile(file: Pick<StoredFile, "name" | "mediaType"> & { declaredMediaType?: string | null | undefined; detectedMediaType?: string | null | undefined; size?: number | null | undefined }): boolean {
  const detected = normalizedMediaType(file.detectedMediaType);
  if (file.size != null && file.size > PREVIEW_LIMITS.imageBytes) return false;
  const declared = normalizedMediaType(file.declaredMediaType ?? file.mediaType);
  const mediaType = detected ?? declared;
  const extension = typeof file.name === "string" ? fileExtension(file.name) : null;
  const extensionMatches = extension === null || imageExtensionMatches(extension, mediaType ?? "");
  return Boolean(mediaType && PASSIVE_IMAGE_MEDIA_TYPES.has(mediaType) && extensionMatches && (!detected || !declared || detected === declared));
}

export function filePreviewKind(file: Pick<StoredFile, "name" | "mediaType"> & { declaredMediaType?: string | null | undefined; detectedMediaType?: string | null | undefined; size?: number | null | undefined }): FilePreviewKind {
  return classifyPreviewKind(file);
}

export function filePreviewDecision(file: PreviewFile): PreviewDecision {
  const kind = classifyPreviewKind(file);
  if (kind === "unsupported") return { kind, allowed: false, reason: "This file type is not safe to preview in the browser.", maxSourceBytes: null };

  const declared = normalizedMediaType(file.declaredMediaType ?? file.mediaType);
  const detected = normalizedMediaType(file.detectedMediaType);
  const containerKind = (detected === "application/zip" || detected === "application/octet-stream") ? officeKindForExtension(file.name) : null;
  const compatibleZip = containerKind !== null && (declared === "application/zip" || officeMediaTypeMatches(containerKind, declared));
  const compatibleLegacyXls = detected === "application/octet-stream"
    && fileExtension(file.name) === "xls"
    && PREVIEW_MEDIA_TYPES.xls.has(declared ?? "");
  const compatibleText = detected === "text/plain"
    && isTextualPreviewDeclaration(file.name, declared);
  if (detected && declared && detected !== declared && !compatibleZip && !compatibleLegacyXls && !compatibleText) {
    return { kind: "unsupported", allowed: false, reason: "The detected file type does not match its declared type.", maxSourceBytes: null };
  }

  const maxSourceBytes = maxBytesForKind(kind, file.name);
  if (file.size != null && file.size > maxSourceBytes) {
    return { kind, allowed: false, reason: `This ${kind} is too large to preview safely. Download it to open the complete file.`, maxSourceBytes };
  }

  // Legacy BIFF workbooks do not have a bounded archive preflight. Without a
  // server signature, a file declared as .xls could actually be an OOXML ZIP
  // (or another parser-hostile payload), so keep unknown legacy binaries
  // download-only until detection has completed.
  if (kind === "spreadsheet" && fileExtension(file.name) === "xls" && !detected) {
    return { kind: "unsupported", allowed: false, reason: "The legacy workbook type could not be validated safely.", maxSourceBytes: null };
  }

  if (kind === "image" && !isPassiveInlineImageFile(file)) {
    return { kind: "unsupported", allowed: false, reason: "Only passive, signature-validated images can be previewed inline.", maxSourceBytes: null };
  }

  return { kind, allowed: true, reason: null, maxSourceBytes };
}

function maxBytesForKind(kind: Exclude<FilePreviewKind, "unsupported">, name?: string): number {
  if (kind === "image") return PREVIEW_LIMITS.imageBytes;
  if (kind === "code") return PREVIEW_LIMITS.codeBytes;
  if (kind === "spreadsheet") return name && fileExtension(name) === "xls" ? PREVIEW_LIMITS.legacySpreadsheetBytes : PREVIEW_LIMITS.spreadsheetBytes;
  if (kind === "docx") return PREVIEW_LIMITS.docxBytes;
  return PREVIEW_LIMITS.pptxBytes;
}

function classifyPreviewKind(file: Pick<StoredFile, "name" | "mediaType"> & { declaredMediaType?: string | null | undefined; detectedMediaType?: string | null | undefined }): FilePreviewKind {
  const declaredMediaType = normalizedMediaType(file.declaredMediaType ?? file.mediaType);
  const detectedMediaType = normalizedMediaType(file.detectedMediaType);
  const mediaType = detectedMediaType === "application/zip" || detectedMediaType === "application/octet-stream"
    ? declaredMediaType ?? detectedMediaType ?? ""
    : detectedMediaType ?? declaredMediaType ?? "";
  const lowerName = file.name.trim().toLowerCase();
  const extension = fileExtension(file.name);
  const officeExtensionKind = officeKindForExtension(lowerName);

  // SVG, PDF and all non-allowlisted image formats remain download-only even
  // when a browser could technically render them.
  if (PASSIVE_IMAGE_MEDIA_TYPES.has(mediaType) && imageExtensionMatches(extension, mediaType)) return "image";
  if (mediaType.startsWith("image/") || IMAGE_FILE_EXTENSION.test(lowerName)) return "unsupported";
  if (mediaType === "application/pdf" || lowerName.endsWith(".pdf")) return "unsupported";

  if (mediaType === "application/zip") {
    const containerKind = officeKindForExtension(file.name);
    if (containerKind) return containerKind;
  }
  if (extension === "xls" && !PREVIEW_MEDIA_TYPES.xls.has(mediaType)) return "unsupported";
  if (officeExtensionKind && mediaType !== "application/zip" && !officeMediaTypeMatches(officeExtensionKind, mediaType)) return "unsupported";
  if (extension === "xlsx" && PREVIEW_MEDIA_TYPES.xlsx.has(mediaType)) return "spreadsheet";
  if (extension === "xls" && PREVIEW_MEDIA_TYPES.xls.has(mediaType)) return "spreadsheet";
  if (extension === "csv" && PREVIEW_MEDIA_TYPES.csv.has(mediaType)) return "spreadsheet";
  if (extension === "tsv" && PREVIEW_MEDIA_TYPES.tsv.has(mediaType)) return "spreadsheet";
  if (extension === "docx" && PREVIEW_MEDIA_TYPES.docx.has(mediaType)) return "docx";
  if (extension === "pptx" && PREVIEW_MEDIA_TYPES.pptx.has(mediaType)) return "pptx";
  if (isCodeFile(lowerName, mediaType)) return "code";
  return "unsupported";
}

function imageExtensionMatches(extension: string, mediaType: string): boolean {
  return IMAGE_EXTENSION_MEDIA_TYPES[extension] === mediaType;
}

function officeKindForExtension(name: string): Extract<FilePreviewKind, "docx" | "pptx" | "spreadsheet"> | null {
  const extension = fileExtension(name);
  if (extension === "docx") return "docx";
  if (extension === "pptx") return "pptx";
  if (extension === "xlsx") return "spreadsheet";
  return null;
}

function officeMediaTypeMatches(kind: Extract<FilePreviewKind, "docx" | "pptx" | "spreadsheet">, mediaType: string | null): boolean {
  if (!mediaType) return false;
  if (kind === "docx") return PREVIEW_MEDIA_TYPES.docx.has(mediaType);
  if (kind === "pptx") return PREVIEW_MEDIA_TYPES.pptx.has(mediaType);
  return PREVIEW_MEDIA_TYPES.xlsx.has(mediaType);
}

function isTextualPreviewDeclaration(name: string, declared: string | null): boolean {
  if (!declared || (!declared.startsWith("text/") && !TEXTUAL_APPLICATION_MEDIA_TYPES.has(declared))) return false;
  const kind = classifyPreviewKind({ name, mediaType: declared });
  return kind === "code" || (kind === "spreadsheet" && (fileExtension(name) === "csv" || fileExtension(name) === "tsv"));
}

const TEXTUAL_APPLICATION_MEDIA_TYPES = new Set([
  "application/csv",
  "application/javascript",
  "application/json",
  "application/ld+json",
  "application/sql",
  "application/xml",
  "application/x-yaml",
]);

function normalizedMediaType(value: string | null | undefined): string | null {
  if (!value) return null;
  const mediaType = value.split(";", 1)[0]!.trim().toLowerCase();
  if (!mediaType) return null;
  if (mediaType === "image/jpg" || mediaType === "image/pjpeg") return "image/jpeg";
  if (mediaType === "image/vnd.microsoft.icon") return "image/x-icon";
  if (mediaType === "application/msexcel") return "application/msexcel";
  return mediaType;
}

function isCodeFile(lowerName: string, mediaType: string): boolean {
  if (mediaType.startsWith("text/") && !lowerName.endsWith(".csv") && !lowerName.endsWith(".tsv")) return true;
  if (["application/json", "application/ld+json", "application/javascript", "application/sql", "application/xml", "application/x-yaml"].includes(mediaType)) return true;
  return /(?:^|\.)(?:c|cc|cpp|cs|css|cts|cxx|dockerfile|env|go|h|hpp|html|ini|java|js|json|jsonc|jsx|md|mdx|mjs|php|py|pyi|rb|rs|scss|sh|sql|toml|ts|tsx|txt|xml|ya?ml|zsh)$/i.test(lowerName);
}
