const LEGACY_INPUT_PREFIX_PATTERN = /\/workspace\/inputs\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\//gi;
const RELATIVE_PACKAGE_REFERENCE_PATTERNS = [
  /`((?:\.\/)?(?:assets|scripts|references)\/[^`\r\n]+)`/gi,
  /\]\(\s*<?((?:\.\/)?(?:assets|scripts|references)\/[^)>\r\n]+)>?\s*\)/gi,
  /(?:^|[\s"'])((?:\.\/)?(?:assets|scripts|references)\/[\p{L}\p{N}._/+-]+)/gimu,
] as const;

export type LegacyInputReference = {
  fileId: string;
  prefix: string;
};

/**
 * Find only the stable, UUID-scoped portion of a legacy sandbox input path.
 * The filename is resolved from the files table instead of being captured
 * greedily from Markdown, where trailing punctuation or prose is ambiguous.
 */
export function legacyInputReferences(content: string): LegacyInputReference[] {
  const references = new Map<string, LegacyInputReference>();
  for (const match of content.matchAll(LEGACY_INPUT_PREFIX_PATTERN)) {
    const prefix = match[0];
    const fileId = match[1]?.toLowerCase();
    if (!prefix || !fileId || references.has(fileId)) continue;
    references.set(fileId, { fileId, prefix });
  }
  return [...references.values()];
}

export function legacyInputSourcePath(reference: LegacyInputReference, displayName: string): string {
  return `${reference.prefix}${safeLegacyInputFileName(displayName)}`;
}

export function replaceLegacyInputPath(content: string, sourcePath: string, packagePath: string): string {
  return content.split(sourcePath).join(packagePath);
}

/**
 * Finds stable-looking relative resource references left by the old browser
 * importer. That importer retained SKILL.md but discarded ancillary bytes, so
 * these references need an explicit re-upload when no package row exists.
 */
export function legacyRelativePackageReferences(content: string): string[] {
  const references = new Set<string>();
  for (const pattern of RELATIVE_PACKAGE_REFERENCE_PATTERNS) {
    for (const match of content.matchAll(pattern)) {
      const candidate = normalizeRelativePackageReference(match[1] ?? "");
      if (candidate) references.add(candidate);
    }
  }
  return [...references].sort((left, right) => left.localeCompare(right));
}

export function missingLegacyRelativePackageReferences(
  content: string,
  existingPaths: ReadonlySet<string>,
): string[] {
  return legacyRelativePackageReferences(content).filter((path) => !existingPaths.has(path));
}

export function uniqueRecoveredPackagePath(
  folder: string,
  baseName: string,
  fileId: string,
  usedPaths: Set<string>,
): string {
  const preferred = `${folder}/${baseName}`;
  if (!usedPaths.has(preferred)) {
    usedPaths.add(preferred);
    return preferred;
  }
  const stableId = fileId.toLowerCase().replace(/[^a-z0-9-]/g, "") || "recovered";
  let attempt = 1;
  while (true) {
    const suffix = attempt === 1 ? stableId : `${stableId}-${attempt}`;
    const candidate = `${folder}/${suffix}-${baseName}`;
    if (!usedPaths.has(candidate)) {
      usedPaths.add(candidate);
      return candidate;
    }
    attempt += 1;
  }
}

/** Mirrors the filename normalization used when durable inputs are staged. */
export function safeLegacyInputFileName(value: string): string {
  const basename = value.trim().replaceAll("\\", "/").split("/").at(-1) ?? "";
  const normalized = basename
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^\p{L}\p{N}._() -]+/gu, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  return normalized && normalized !== "." && normalized !== ".." ? normalized : "attachment";
}

function normalizeRelativePackageReference(value: string): string | null {
  const normalized = value
    .trim()
    .replace(/^\.\//, "")
    .replace(/[.,;:!?]+$/, "")
    .replaceAll("\\", "/");
  const parts = normalized.split("/");
  if (
    !/^(?:assets|scripts|references)\//i.test(normalized)
    || parts.some((part) => !part || part === "." || part === "..")
  ) return null;
  return normalized;
}
