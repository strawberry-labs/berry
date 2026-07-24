import { basename, extname } from "node:path";

const DEFAULT_ARTIFACT_MEDIA_TYPE = "application/octet-stream";

const MEDIA_TYPE_BY_EXTENSION: Record<string, string> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".csv": "text/csv",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
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

export function artifactMediaType(pathOrName: string): string {
  return MEDIA_TYPE_BY_EXTENSION[extname(pathOrName).toLowerCase()] ?? DEFAULT_ARTIFACT_MEDIA_TYPE;
}

export function artifactDisplayName(sourcePath: string, requestedName?: string): string {
  const sourceName = basename(sourcePath) || "artifact";
  const name = requestedName?.trim() || sourceName;
  const sourceExtension = extname(sourceName);
  return sourceExtension && !extname(name) ? `${name}${sourceExtension}` : name;
}

export function isAutoPublishableArtifact(pathOrName: string): boolean {
  const name = basename(pathOrName);
  if (!name || name.startsWith(".") || name.endsWith("~")) return false;
  return AUTO_PUBLISH_EXTENSIONS.has(extname(name).toLowerCase());
}
