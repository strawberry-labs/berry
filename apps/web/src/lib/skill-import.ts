import JSZip from "jszip";

const MAX_ARCHIVE_BYTES = 5 * 1024 * 1024;
const MAX_SKILL_BYTES = 262_144;
const MAX_FILES = 500;

export type BrowserSkillImport = {
  content: string;
  fileName: string;
  packageFiles: string[];
};

export async function readBrowserSkillImport(file: File): Promise<BrowserSkillImport> {
  if (file.size > MAX_ARCHIVE_BYTES) throw new Error("Skill files are limited to 5 MB");
  if (!/\.(skill|zip)$/i.test(file.name)) {
    const content = await file.text();
    validateContent(content);
    return { content, fileName: file.name, packageFiles: ["SKILL.md"] };
  }

  const archive = await JSZip.loadAsync(await file.arrayBuffer(), { createFolders: false });
  const entries = Object.values(archive.files);
  if (entries.length > MAX_FILES) throw new Error(`Skill packages may contain at most ${MAX_FILES} files`);
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
  return { content, fileName: file.name, packageFiles };
}

function validateArchivePath(path: string): void {
  const normalized = path.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[a-z]:\//i.test(normalized) || normalized.split("/").includes("..")) throw new Error("The package contains an unsafe file path");
}

function validateContent(content: string): void {
  if (!content.trim()) throw new Error("SKILL.md is empty");
  if (new TextEncoder().encode(content).byteLength > MAX_SKILL_BYTES) throw new Error("SKILL.md is limited to 256 KB");
}
