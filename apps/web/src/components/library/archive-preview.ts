export type ArchiveEntry = {
  name: string;
  compressedBytes: number;
  expandedBytes: number;
  encrypted?: boolean;
};

export type ArchivePreviewLimits = {
  sourceBytes: number;
  expandedBytes: number;
  entryCount: number;
  entryBytes: number;
  expansionRatio: number;
};

export type ArchivePreviewResult =
  | { ok: true; expandedBytes: number; entries: number }
  | { ok: false; reason: string };

/** Validate central-directory metadata before any office renderer sees a ZIP. */
export function validateArchivePreview(
  sourceBytes: number,
  entries: readonly ArchiveEntry[],
  limits: ArchivePreviewLimits,
): ArchivePreviewResult {
  if (!Number.isSafeInteger(sourceBytes) || sourceBytes < 0 || sourceBytes > limits.sourceBytes) {
    return { ok: false, reason: "The compressed file is too large to preview safely." };
  }
  if (entries.length === 0) return { ok: false, reason: "The archive is empty or invalid." };
  if (entries.length > limits.entryCount) return { ok: false, reason: "The archive contains too many entries to preview safely." };

  let expandedBytes = 0;
  for (const entry of entries) {
    if (entry.encrypted) return { ok: false, reason: "Encrypted archives cannot be previewed safely." };
    if (!safeArchivePath(entry.name)) return { ok: false, reason: "The archive contains an unsafe path." };
    if (!Number.isSafeInteger(entry.compressedBytes) || !Number.isSafeInteger(entry.expandedBytes) || entry.compressedBytes < 0 || entry.expandedBytes < 0) {
      return { ok: false, reason: "The archive contains invalid size metadata." };
    }
    if (entry.expandedBytes > limits.entryBytes) return { ok: false, reason: "An archive entry is too large to preview safely." };
    expandedBytes += entry.expandedBytes;
    if (expandedBytes > limits.expandedBytes) return { ok: false, reason: "The expanded archive is too large to preview safely." };
    if (entry.expandedBytes > 0 && entry.compressedBytes === 0) return { ok: false, reason: "The archive contains invalid compression metadata." };
    if (entry.compressedBytes > 0 && entry.expandedBytes / entry.compressedBytes > limits.expansionRatio) {
      return { ok: false, reason: "The archive expansion ratio is too high to preview safely." };
    }
  }
  return { ok: true, expandedBytes, entries: entries.length };
}

export function safeArchivePath(name: string): boolean {
  if (!name || name.includes("\\") || name.startsWith("/") || /^[A-Za-z]:/.test(name)) return false;
  const segments = name.split("/");
  return !segments.some((segment, index) => segment === ".." || (segment === "" && index < segments.length - 1));
}
