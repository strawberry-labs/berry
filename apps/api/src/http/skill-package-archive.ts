import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { BadRequestException } from "@nestjs/common";
import { ORGANIZATION_SKILL_PACKAGE_MAX_BYTES, SKILL_PACKAGE_MAX_FILES, type SkillPackageFile } from "@berry/shared";
import yauzl, { type Entry, type ZipFile } from "yauzl";

const MAX_SKILL_BYTES = 262_144;

export type StagedOrganizationSkillFile = {
  path: string;
  absolutePath: string;
  sizeBytes: number;
  sha256: string;
  mode: number;
};

export type StagedOrganizationSkillArchive = {
  content: string;
  rootDirectory: string | null;
  packageFiles: string[];
  resourceFiles: StagedOrganizationSkillFile[];
  hash: string;
  bytes: number;
};

export type OrganizationSkillArchive = {
  content: string;
  packageFiles: string[];
  resourceFiles: SkillPackageFile[];
};

/**
 * Compatibility helper for small in-memory callers and tests. Production
 * uploads use extractOrganizationSkillArchive so the archive and resources are
 * never held in memory or expanded to base64 as one aggregate payload.
 */
export async function readOrganizationSkillArchive(bytes: Uint8Array): Promise<OrganizationSkillArchive> {
  if (bytes.byteLength > ORGANIZATION_SKILL_PACKAGE_MAX_BYTES) {
    throw new BadRequestException("Organization skill archives are limited to 100 MB");
  }
  const temporaryRoot = await mkdtemp(join(tmpdir(), "berry-skill-read-"));
  try {
    const archivePath = join(temporaryRoot, "package.skill");
    await writeFile(archivePath, bytes);
    const staged = await extractOrganizationSkillArchive(archivePath, join(temporaryRoot, "entries"));
    return {
      content: staged.content,
      packageFiles: staged.packageFiles,
      resourceFiles: await Promise.all(staged.resourceFiles.map(async (file) => ({
        path: file.path,
        contentBase64: (await readFile(file.absolutePath)).toString("base64"),
        mode: file.mode,
      }))),
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function extractOrganizationSkillArchive(
  archivePath: string,
  extractionRoot: string,
): Promise<StagedOrganizationSkillArchive> {
  await mkdir(extractionRoot, { recursive: true });
  let staged: RawStagedEntry[];
  try {
    staged = await extractEntries(archivePath, extractionRoot);
  } catch (cause) {
    if (cause instanceof BadRequestException) throw cause;
    if (cause instanceof Error && /invalid relative path|absolute path|backslash/i.test(cause.message)) {
      throw new BadRequestException("The package contains an unsafe file path");
    }
    throw new BadRequestException("The uploaded file is not a valid .skill or ZIP archive");
  }
  if (staged.length > SKILL_PACKAGE_MAX_FILES + 1) {
    throw new BadRequestException(`Skill packages may contain at most ${SKILL_PACKAGE_MAX_FILES} resource files`);
  }
  const skillCandidates = staged.filter((entry) => /(^|\/)SKILL\.md$/i.test(entry.archivePath));
  if (skillCandidates.length !== 1) {
    throw new BadRequestException(skillCandidates.length ? "The package contains more than one SKILL.md" : "The package does not contain SKILL.md");
  }
  const skillEntry = skillCandidates[0]!;
  const root = skillEntry.archivePath.slice(0, -"SKILL.md".length);
  if (root && root.slice(0, -1).includes("/")) {
    throw new BadRequestException("SKILL.md must be at the archive root or inside one top-level folder");
  }
  if (root && staged.some((entry) => !entry.archivePath.startsWith(root))) {
    throw new BadRequestException("The package contains files outside its skill folder");
  }
  if (skillEntry.sizeBytes > MAX_SKILL_BYTES) throw new BadRequestException("SKILL.md is limited to 256 KB");
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(skillEntry.absolutePath));
  } catch {
    throw new BadRequestException("SKILL.md must be valid UTF-8 text");
  }
  if (!content.trim()) throw new BadRequestException("SKILL.md is empty");

  const seen = new Set<string>();
  const resourceFiles = staged
    .filter((entry) => entry !== skillEntry)
    .map((entry): StagedOrganizationSkillFile => {
      const path = root ? entry.archivePath.slice(root.length) : entry.archivePath;
      validatePackageRelativePath(path);
      if (seen.has(path)) throw new BadRequestException(`Skill package contains duplicate path: ${path}`);
      seen.add(path);
      return { path, absolutePath: entry.absolutePath, sizeBytes: entry.sizeBytes, sha256: entry.sha256, mode: entry.mode };
    })
    .sort((left, right) => left.path.localeCompare(right.path));

  const hash = createHash("sha256").update("SKILL.md\0").update(content);
  for (const file of resourceFiles) {
    hash.update("\0").update(file.path).update("\0");
    for await (const chunk of createReadStream(file.absolutePath)) hash.update(chunk);
  }
  const extractedBytes = skillEntry.sizeBytes + resourceFiles.reduce((total, file) => total + file.sizeBytes, 0);
  return {
    content,
    rootDirectory: root ? root.slice(0, -1) : null,
    packageFiles: ["SKILL.md", ...resourceFiles.map((file) => file.path)],
    resourceFiles,
    hash: hash.digest("hex"),
    bytes: extractedBytes,
  };
}

type RawStagedEntry = {
  archivePath: string;
  absolutePath: string;
  sizeBytes: number;
  sha256: string;
  mode: number;
};

async function extractEntries(archivePath: string, extractionRoot: string): Promise<RawStagedEntry[]> {
  const zip = await openZip(archivePath);
  const files: RawStagedEntry[] = [];
  let extractedBytes = 0;
  try {
    while (true) {
      const entry = await nextEntry(zip);
      if (!entry) break;
      const archiveEntryPath = entry.fileName.replaceAll("\\", "/");
      validateArchivePath(archiveEntryPath);
      if (ignoredArchiveEntry(archiveEntryPath) || archiveEntryPath.endsWith("/")) continue;
      if (isSymbolicLink(entry)) throw new BadRequestException("Skill packages cannot contain symbolic links");
      if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0) {
        throw new BadRequestException("The package has invalid file-size metadata");
      }
      if (files.length >= SKILL_PACKAGE_MAX_FILES + 1) {
        throw new BadRequestException(`Skill packages may contain at most ${SKILL_PACKAGE_MAX_FILES} resource files`);
      }
      if (entry.uncompressedSize > ORGANIZATION_SKILL_PACKAGE_MAX_BYTES - extractedBytes) {
        throw new BadRequestException("Organization skill packages are limited to 100 MB extracted");
      }
      const absolutePath = join(extractionRoot, `${String(files.length).padStart(4, "0")}-${randomUUID()}`);
      const digest = createHash("sha256");
      let written = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          written += chunk.byteLength;
          if (written > entry.uncompressedSize || written > ORGANIZATION_SKILL_PACKAGE_MAX_BYTES - extractedBytes) {
            callback(new BadRequestException("Organization skill packages are limited to 100 MB extracted"));
            return;
          }
          digest.update(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(await openEntryStream(zip, entry), counter, createWriteStream(absolutePath, { flags: "wx", mode: 0o600 }));
      if (written !== entry.uncompressedSize) throw new BadRequestException("The package has invalid file-size metadata");
      extractedBytes += written;
      files.push({
        archivePath: archiveEntryPath,
        absolutePath,
        sizeBytes: written,
        sha256: digest.digest("hex"),
        mode: archiveMode(entry, archiveEntryPath),
      });
    }
    return files;
  } finally {
    zip.close();
  }
}

function openZip(path: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, validateEntrySizes: true, strictFileNames: false }, (error, zip) => {
      if (error || !zip) reject(error ?? new Error("ZIP could not be opened"));
      else resolve(zip);
    });
  });
}

function nextEntry(zip: ZipFile): Promise<Entry | null> {
  return new Promise((resolve, reject) => {
    const onEntry = (entry: Entry) => { cleanup(); resolve(entry); };
    const onEnd = () => { cleanup(); resolve(null); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const cleanup = () => {
      zip.off("entry", onEntry);
      zip.off("end", onEnd);
      zip.off("error", onError);
    };
    zip.once("entry", onEntry);
    zip.once("end", onEnd);
    zip.once("error", onError);
    zip.readEntry();
  });
}

function openEntryStream(zip: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) reject(error ?? new Error("ZIP entry could not be read"));
      else resolve(stream);
    });
  });
}

function archiveMode(entry: Entry, path: string): number {
  const mode = (entry.externalFileAttributes >>> 16) & 0o777;
  return mode || (path.startsWith("scripts/") || path.includes("/scripts/") ? 0o755 : 0o644);
}

function isSymbolicLink(entry: Entry): boolean {
  return ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000;
}

function ignoredArchiveEntry(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/^\/+/, "");
  return normalized === ".DS_Store" || normalized.endsWith("/.DS_Store") || normalized === "__MACOSX" || normalized.startsWith("__MACOSX/");
}

function validateArchivePath(path: string): void {
  const normalized = path.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || /^[a-z]:\//i.test(normalized) || normalized.split("/").includes("..") || normalized.includes("\0")) {
    throw new BadRequestException("The package contains an unsafe file path");
  }
}

function validatePackageRelativePath(path: string): void {
  validateArchivePath(path);
  if (path.length > 512 || path.endsWith("/") || path.toLowerCase() === "skill.md") {
    throw new BadRequestException("The package contains an invalid or duplicate file path");
  }
}
