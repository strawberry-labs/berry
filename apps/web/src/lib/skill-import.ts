import JSZip from "jszip";

const MAX_ARCHIVE_BYTES = 5 * 1024 * 1024;
const MAX_SKILL_BYTES = 262_144;
const MAX_FILES = 500;

export type BrowserSkillImport = {
  content: string;
  fileName: string;
  packageFiles: string[];
  resourceFiles: Array<{ path: string; contentBase64: string; mode?: number | undefined }>;
};

export type BrowserSkillExport = {
  blob: Blob;
  fileName: string;
};

export async function createBrowserSkillExport(
  name: string,
  content: string,
  resourceFiles: readonly { path: string; contentBase64: string; mode?: number | undefined }[] = [],
): Promise<BrowserSkillExport> {
  validateContent(content);
  const archive = new JSZip();
  archive.file("SKILL.md", content);
  for (const file of resourceFiles) {
    validateArchivePath(file.path);
    archive.file(file.path, file.contentBase64, {
      base64: true,
      ...(file.mode !== undefined ? { unixPermissions: file.mode } : {}),
    });
  }
  const blob = await archive.generateAsync({
    type: "blob",
    platform: "UNIX",
    mimeType: "application/zip",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  return { blob, fileName: `${safeSkillFileStem(name)}.skill` };
}

export async function readBrowserSkillImport(file: File): Promise<BrowserSkillImport> {
  if (file.size > MAX_ARCHIVE_BYTES) throw new Error("Skill files are limited to 5 MB");
  if (!/\.(skill|zip)$/i.test(file.name)) {
    const content = await file.text();
    validateContent(content);
    return { content, fileName: file.name, packageFiles: ["SKILL.md"], resourceFiles: [] };
  }

  const archive = await JSZip.loadAsync(await file.arrayBuffer(), { createFolders: false });
  const entries = Object.values(archive.files);
  if (entries.length > MAX_FILES) throw new Error(`Skill packages may contain at most ${MAX_FILES} files`);
  const declaredExtractedBytes = entries.reduce((total, entry) => {
    const size = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
    return total + (typeof size === "number" && Number.isFinite(size) ? size : 0);
  }, 0);
  if (declaredExtractedBytes > MAX_ARCHIVE_BYTES) throw new Error("Skill packages are limited to 5 MB extracted");
  for (const entry of entries) validateArchivePath(entry.name);
  const candidates = entries.filter((entry) => !entry.dir && /(^|\/)SKILL\.md$/i.test(entry.name));
  if (candidates.length !== 1) throw new Error(candidates.length ? "The package contains more than one SKILL.md" : "The package does not contain SKILL.md");

  const skillEntry = candidates[0]!;
  const root = skillEntry.name.slice(0, -"SKILL.md".length);
  if (root && root.slice(0, -1).includes("/")) throw new Error("SKILL.md must be at the archive root or inside one top-level folder");
  const outside = entries.find((entry) => !entry.dir && root && !entry.name.startsWith(root));
  if (outside) throw new Error("The package contains files outside its skill folder");
  const packageFiles = entries
    .filter((entry) => !entry.dir && (!root || entry.name.startsWith(root)))
    .map((entry) => root ? entry.name.slice(root.length) : entry.name)
    .sort();
  const content = await skillEntry.async("string");
  validateContent(content);
  const resourceEntries = entries
    .filter((entry) => !entry.dir && entry !== skillEntry && (!root || entry.name.startsWith(root)))
    .sort((left, right) => left.name.localeCompare(right.name));
  let extractedBytes = new TextEncoder().encode(content).byteLength;
  const resourceFiles: BrowserSkillImport["resourceFiles"] = [];
  for (const entry of resourceEntries) {
    const path = root ? entry.name.slice(root.length) : entry.name;
    const contentBase64 = await entry.async("base64");
    extractedBytes += base64ByteLength(contentBase64);
    if (extractedBytes > MAX_ARCHIVE_BYTES) throw new Error("Skill packages are limited to 5 MB extracted");
    const mode = typeof entry.unixPermissions === "number" && entry.unixPermissions > 0
      ? entry.unixPermissions & 0o777
      : undefined;
    resourceFiles.push({ path, contentBase64, ...(mode !== undefined ? { mode } : {}) });
  }
  return { content, fileName: file.name, packageFiles, resourceFiles };
}

function validateArchivePath(path: string): void {
  const normalized = path.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[a-z]:\//i.test(normalized) || normalized.split("/").includes("..")) throw new Error("The package contains an unsafe file path");
}

function validateContent(content: string): void {
  if (!content.trim()) throw new Error("SKILL.md is empty");
  if (new TextEncoder().encode(content).byteLength > MAX_SKILL_BYTES) throw new Error("SKILL.md is limited to 256 KB");
}

function safeSkillFileStem(name: string): string {
  return name
    .trim()
    .replace(/\.skill$/i, "")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 120) || "skill";
}

function base64ByteLength(value: string): number {
  if (!value) return 0;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return value.length * 3 / 4 - padding;
}
