import type { StoredFile } from "@berry/shared";

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function fileTypeLabel(file: Pick<StoredFile, "name" | "mediaType">): string {
  const extension = file.name.split(".").at(-1)?.toUpperCase();
  if (extension && extension.length <= 8) return extension;
  if (file.mediaType.startsWith("image/")) return "Image";
  if (file.mediaType.startsWith("text/")) return "Text";
  return "File";
}
