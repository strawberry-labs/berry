import { createHash, randomBytes } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { inflateRawSync } from "node:zlib";
import { parse as parseYaml } from "yaml";

export interface SkillPackageLimits {
  maxArchiveBytes: number;
  maxExtractedBytes: number;
  maxIndividualFileBytes: number;
  maxFiles: number;
  maxPathLength: number;
  maxDirectoryDepth: number;
  maxCompressionRatio: number;
  maxEntryCompressionRatio: number;
}

export const DEFAULT_SKILL_PACKAGE_LIMITS: Readonly<SkillPackageLimits> = Object.freeze({
  maxArchiveBytes: 50 * 1024 * 1024,
  maxExtractedBytes: 250 * 1024 * 1024,
  maxIndividualFileBytes: 100 * 1024 * 1024,
  maxFiles: 2_000,
  maxPathLength: 240,
  maxDirectoryDepth: 20,
  maxCompressionRatio: 200,
  maxEntryCompressionRatio: 500,
});

export type SkillPackageErrorCode =
  | "archive_too_large"
  | "invalid_zip"
  | "unsupported_zip"
  | "encrypted_entry"
  | "unsafe_archive_path"
  | "link_entry"
  | "archive_limit_exceeded"
  | "compression_ratio_exceeded"
  | "ambiguous_skill_root"
  | "missing_skill_file"
  | "invalid_skill_metadata"
  | "skill_name_mismatch"
  | "archive_changed"
  | "skill_conflict"
  | "install_failed";

export class SkillPackageError extends Error {
  constructor(
    readonly code: SkillPackageErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "SkillPackageError";
  }
}

export interface SkillPackageMetadata {
  name: string;
  description: string;
  license: string | null;
  compatibility: string | null;
  allowedTools: string | null;
  metadata: Record<string, string>;
  version: string;
}

export interface SkillPackagePreview extends SkillPackageMetadata {
  archivePath: string;
  archiveName: string;
  fingerprint: string;
  archiveSize: number;
  extractedSize: number;
  fileCount: number;
  rootLayout: "archive-root" | "top-level-directory";
  sourceDirectoryName: string | null;
  hasScripts: boolean;
  scripts: string[];
  references: string[];
  assets: string[];
  resources: string[];
}

interface ZipEntry {
  archivePath: string;
  path: string;
  isDirectory: boolean;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
  localHeaderOffset: number;
}

export interface InspectedSkillPackage {
  preview: SkillPackagePreview;
  archive: Buffer;
  entries: ZipEntry[];
  rootPrefix: string;
  limits: SkillPackageLimits;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_EOCD_SEARCH = 65_557;
const ZIP64_SENTINEL_16 = 0xffff;
const ZIP64_SENTINEL_32 = 0xffffffff;
const UNIX_FILE_TYPE_MASK = 0o170000;
const UNIX_REGULAR_FILE = 0o100000;
const UNIX_DIRECTORY = 0o040000;
const UNIX_SYMLINK = 0o120000;

export function mergeSkillPackageLimits(overrides?: Partial<SkillPackageLimits>): SkillPackageLimits {
  const merged = { ...DEFAULT_SKILL_PACKAGE_LIMITS, ...(overrides ?? {}) };
  for (const [field, value] of Object.entries(merged)) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new SkillPackageError("archive_limit_exceeded", `${field} must be a positive finite number.`, { field });
    }
  }
  return merged;
}

export function inspectSkillPackage(
  archivePath: string,
  overrides?: Partial<SkillPackageLimits>,
): InspectedSkillPackage {
  const limits = mergeSkillPackageLimits(overrides);
  const resolvedPath = resolve(archivePath);
  const archive = readFileSync(resolvedPath);
  if (archive.byteLength > limits.maxArchiveBytes) {
    fail("archive_too_large", `Archive exceeds the ${formatBytes(limits.maxArchiveBytes)} limit.`, {
      archiveSize: archive.byteLength,
      limit: limits.maxArchiveBytes,
    });
  }
  const rawEntries = readCentralDirectory(archive, limits);
  const skillRoots = rawEntries
    .filter((entry) => !entry.isDirectory && (entry.path.toLowerCase() === "skill.md" || entry.path.toLowerCase().endsWith("/skill.md")))
    .map((entry) => dirnameArchivePath(entry.path));
  const uniqueRoots = [...new Set(skillRoots)];
  if (uniqueRoots.length === 0) fail("missing_skill_file", "The archive does not contain a readable SKILL.md file.");
  if (uniqueRoots.length !== 1) {
    fail("ambiguous_skill_root", "The archive contains multiple possible skill roots.", { roots: uniqueRoots });
  }
  const rootPrefix = uniqueRoots[0] ? `${uniqueRoots[0]}/` : "";
  if (rootPrefix && rootPrefix.slice(0, -1).includes("/")) {
    fail("ambiguous_skill_root", "SKILL.md must be at the archive root or inside one top-level directory.", {
      root: rootPrefix.slice(0, -1),
    });
  }
  const entries = rawEntries
    .filter((entry) => rootPrefix ? entry.path.startsWith(rootPrefix) : true)
    .map((entry) => ({ ...entry, archivePath: entry.path, path: rootPrefix ? entry.path.slice(rootPrefix.length) : entry.path }))
    .filter((entry) => entry.path.length > 0);
  const outsideFiles = rawEntries.filter((entry) => !entry.isDirectory && rootPrefix && !entry.path.startsWith(rootPrefix));
  if (outsideFiles.length > 0) {
    fail("ambiguous_skill_root", "The archive contains files outside its skill directory.", {
      entry: outsideFiles[0]!.path,
    });
  }
  const skillEntry = entries.find((entry) => !entry.isDirectory && entry.path === "SKILL.md");
  if (!skillEntry) fail("missing_skill_file", "The selected skill root does not contain SKILL.md.");
  const skillMarkdown = extractEntry(archive, skillEntry!, limits).toString("utf8");
  const sourceDirectoryName = rootPrefix ? rootPrefix.slice(0, -1) : null;
  const parsed = parseSkillMetadata(skillMarkdown, sourceDirectoryName);
  const files = entries.filter((entry) => !entry.isDirectory).map((entry) => entry.path).sort();
  const scripts = files.filter((path) => path.startsWith("scripts/"));
  const references = files.filter((path) => path.startsWith("references/"));
  const assets = files.filter((path) => path.startsWith("assets/"));
  const resources = files.filter((path) => path !== "SKILL.md").slice(0, 500);
  const preview: SkillPackagePreview = {
    ...parsed,
    archivePath: resolvedPath,
    archiveName: basename(resolvedPath),
    fingerprint: createHash("sha256").update(archive).digest("hex"),
    archiveSize: archive.byteLength,
    extractedSize: entries.reduce((sum, entry) => sum + (entry.isDirectory ? 0 : entry.uncompressedSize), 0),
    fileCount: files.length,
    rootLayout: rootPrefix ? "top-level-directory" : "archive-root",
    sourceDirectoryName,
    hasScripts: scripts.length > 0,
    scripts,
    references,
    assets,
    resources,
  };
  return { preview, archive, entries, rootPrefix, limits };
}

export function installInspectedSkillPackage(
  inspected: InspectedSkillPackage,
  destination: string,
  options: { replace: boolean; expectedFingerprint?: string },
): void {
  if (options.expectedFingerprint && options.expectedFingerprint !== inspected.preview.fingerprint) {
    fail("archive_changed", "The .skill file changed after it was reviewed. Inspect it again before installing.", {
      expectedFingerprint: options.expectedFingerprint,
      actualFingerprint: inspected.preview.fingerprint,
    });
  }
  const target = resolve(destination);
  const parent = dirname(target);
  if (basename(target) !== inspected.preview.name) {
    fail("skill_name_mismatch", "The installation directory must match the skill name.", {
      name: inspected.preview.name,
      destination: target,
    });
  }
  const existing = safeLstat(target);
  if (existing && !options.replace) {
    fail("skill_conflict", `A skill named ${inspected.preview.name} already exists at the destination.`, {
      destination: target,
    });
  }
  if (existing?.isSymbolicLink()) fail("link_entry", "The existing skill destination is a symbolic link.", { destination: target });
  mkdirSync(parent, { recursive: true });
  const staging = join(parent, `.skill-stage-${randomBytes(10).toString("hex")}`);
  const backup = join(parent, `.skill-backup-${randomBytes(10).toString("hex")}`);
  let movedExisting = false;
  try {
    mkdirSync(staging, { recursive: false });
    for (const entry of inspected.entries) {
      if (entry.isDirectory) continue;
      const targetFile = containedPath(staging, entry.path);
      mkdirSync(dirname(targetFile), { recursive: true });
      writeFileSync(targetFile, extractEntry(inspected.archive, entry, inspected.limits), { flag: "wx" });
    }
    validateExtractedSkill(staging, inspected.preview);
    if (existing) {
      renameSync(target, backup);
      movedExisting = true;
    }
    renameSync(staging, target);
    if (movedExisting) {
      try {
        rmSync(backup, { recursive: true, force: true });
      } catch {
        // The new installation is already committed. A stale backup is safer
        // than reporting failure after the destination was replaced.
      }
    }
  } catch (error) {
    if (movedExisting && !safeLstat(target) && safeLstat(backup)) renameSync(backup, target);
    if (error instanceof SkillPackageError) throw error;
    throw new SkillPackageError("install_failed", `Skill installation failed: ${errorMessage(error)}`, {
      destination: target,
    });
  } finally {
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; staging paths are never used as installations.
    }
    if (safeLstat(target)) {
      try {
        rmSync(backup, { recursive: true, force: true });
      } catch {
        // Preserve a successful atomic installation even if cleanup is denied.
      }
    }
  }
}

export function parseSkillMetadata(raw: string, containingDirectory: string | null): SkillPackageMetadata {
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---\n")) {
    fail("invalid_skill_metadata", "SKILL.md must begin with YAML frontmatter.", { field: "frontmatter" });
  }
  const delimiter = normalized.indexOf("\n---\n", 4);
  const endAtEof = normalized.endsWith("\n---") ? normalized.length - 4 : -1;
  const end = delimiter >= 0 ? delimiter : endAtEof;
  if (end < 0) fail("invalid_skill_metadata", "SKILL.md frontmatter is not closed with ---.", { field: "frontmatter" });
  let parsed: unknown;
  try {
    parsed = parseYaml(normalized.slice(4, end));
  } catch (error) {
    fail("invalid_skill_metadata", `SKILL.md contains invalid YAML: ${errorMessage(error)}`, { field: "frontmatter" });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("invalid_skill_metadata", "SKILL.md frontmatter must be a YAML mapping.", { field: "frontmatter" });
  }
  const fields = parsed as Record<string, unknown>;
  const name = requiredMetadataString(fields.name, "name");
  const description = requiredMetadataString(fields.description, "description");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
    fail("invalid_skill_metadata", "name must be 1–64 lowercase letters, numbers, or single hyphens.", {
      field: "name",
      value: name,
    });
  }
  if (description.length > 1024) {
    fail("invalid_skill_metadata", "description must be 1–1024 characters.", { field: "description" });
  }
  if (containingDirectory && containingDirectory !== name) {
    fail("skill_name_mismatch", `Frontmatter name "${name}" does not match archive directory "${containingDirectory}".`, {
      name,
      directory: containingDirectory,
    });
  }
  const compatibility = optionalMetadataString(fields.compatibility, "compatibility", 500);
  const license = optionalMetadataString(fields.license, "license", 1024);
  const allowedTools = optionalMetadataString(fields["allowed-tools"], "allowed-tools", 4096);
  const metadata: Record<string, string> = {};
  if (fields.metadata !== undefined) {
    if (!fields.metadata || typeof fields.metadata !== "object" || Array.isArray(fields.metadata)) {
      fail("invalid_skill_metadata", "metadata must be a mapping of string keys to string values.", { field: "metadata" });
    }
    for (const [key, value] of Object.entries(fields.metadata as Record<string, unknown>)) {
      if (typeof value !== "string") {
        fail("invalid_skill_metadata", `metadata.${key} must be a string.`, { field: `metadata.${key}` });
      }
      metadata[key] = value;
    }
  }
  const version = typeof fields.version === "string" && fields.version.trim() ? fields.version.trim().slice(0, 64) : "0.1.0";
  return { name, description, license, compatibility, allowedTools, metadata, version };
}

function readCentralDirectory(archive: Buffer, limits: SkillPackageLimits): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(archive);
  const disk = archive.readUInt16LE(eocd + 4);
  const centralDisk = archive.readUInt16LE(eocd + 6);
  const entriesOnDisk = archive.readUInt16LE(eocd + 8);
  const entryCount = archive.readUInt16LE(eocd + 10);
  const centralSize = archive.readUInt32LE(eocd + 12);
  const centralOffset = archive.readUInt32LE(eocd + 16);
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    fail("unsupported_zip", "Multi-disk ZIP archives are not supported.");
  }
  if (entryCount === ZIP64_SENTINEL_16 || centralSize === ZIP64_SENTINEL_32 || centralOffset === ZIP64_SENTINEL_32) {
    fail("unsupported_zip", "ZIP64 archives are not supported for .skill packages.");
  }
  if (centralOffset + centralSize > archive.byteLength || entryCount > limits.maxFiles + 200) {
    fail("invalid_zip", "The ZIP central directory is outside the archive bounds.");
  }
  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let offset = centralOffset;
  let totalExtracted = 0;
  let totalCompressed = 0;
  let fileCount = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > archive.byteLength || archive.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      fail("invalid_zip", "The ZIP central directory contains an invalid entry.", { index });
    }
    const versionMadeBy = archive.readUInt16LE(offset + 4);
    const flags = archive.readUInt16LE(offset + 8);
    const method = archive.readUInt16LE(offset + 10);
    const crc = archive.readUInt32LE(offset + 16);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const externalAttributes = archive.readUInt32LE(offset + 38);
    const localHeaderOffset = archive.readUInt32LE(offset + 42);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > archive.byteLength) fail("invalid_zip", "A ZIP entry extends beyond the archive bounds.", { index });
    const nameBytes = archive.subarray(offset + 46, offset + 46 + nameLength);
    const decoded = decodeEntryName(nameBytes, Boolean(flags & 0x800));
    const path = validateArchivePath(decoded, limits);
    const portablePath = path.toLocaleLowerCase("en-US");
    if (seen.has(portablePath)) fail("invalid_zip", "The archive contains duplicate normalized paths.", { entry: path });
    seen.add(portablePath);
    if (flags & 0x1 || flags & 0x40) fail("encrypted_entry", "Encrypted ZIP entries are not allowed.", { entry: path });
    if (method !== 0 && method !== 8) {
      fail("unsupported_zip", `Unsupported ZIP compression method ${method}.`, { entry: path, method });
    }
    if (compressedSize === ZIP64_SENTINEL_32 || uncompressedSize === ZIP64_SENTINEL_32 || localHeaderOffset === ZIP64_SENTINEL_32) {
      fail("unsupported_zip", "ZIP64 entries are not supported.", { entry: path });
    }
    const hostSystem = versionMadeBy >>> 8;
    const unixMode = hostSystem === 3 ? externalAttributes >>> 16 : 0;
    const unixType = unixMode & UNIX_FILE_TYPE_MASK;
    if (unixType === UNIX_SYMLINK || (unixType !== 0 && unixType !== UNIX_REGULAR_FILE && unixType !== UNIX_DIRECTORY)) {
      fail("link_entry", "Symbolic links, hard links, and special files are not allowed.", { entry: path });
    }
    const isDirectory = path.endsWith("/") || unixType === UNIX_DIRECTORY || Boolean(externalAttributes & 0x10);
    if (!isDirectory) {
      fileCount += 1;
      totalExtracted += uncompressedSize;
      totalCompressed += compressedSize;
      if (fileCount > limits.maxFiles) failLimit("file count", limits.maxFiles, path);
      if (uncompressedSize > limits.maxIndividualFileBytes) failLimit("individual file size", limits.maxIndividualFileBytes, path);
      if (totalExtracted > limits.maxExtractedBytes) failLimit("extracted size", limits.maxExtractedBytes, path);
      const ratio = compressionRatio(uncompressedSize, compressedSize);
      if (ratio > limits.maxEntryCompressionRatio) {
        fail("compression_ratio_exceeded", "A ZIP entry has a suspicious compression ratio.", { entry: path, ratio });
      }
    }
    entries.push({ archivePath: path, path, isDirectory, compressionMethod: method, compressedSize, uncompressedSize, crc32: crc, localHeaderOffset });
    offset = end;
  }
  const overallRatio = compressionRatio(totalExtracted, totalCompressed);
  if (overallRatio > limits.maxCompressionRatio) {
    fail("compression_ratio_exceeded", "The archive has a suspicious overall compression ratio.", { ratio: overallRatio });
  }
  return entries;
}

function extractEntry(archive: Buffer, entry: ZipEntry, limits: SkillPackageLimits): Buffer {
  const offset = entry.localHeaderOffset;
  if (offset + 30 > archive.byteLength || archive.readUInt32LE(offset) !== LOCAL_SIGNATURE) {
    fail("invalid_zip", "A ZIP local header is invalid.", { entry: entry.archivePath });
  }
  const nameLength = archive.readUInt16LE(offset + 26);
  const extraLength = archive.readUInt16LE(offset + 28);
  const flags = archive.readUInt16LE(offset + 6);
  const method = archive.readUInt16LE(offset + 8);
  if (flags & 0x1 || flags & 0x40) fail("encrypted_entry", "Encrypted ZIP entries are not allowed.", { entry: entry.archivePath });
  if (method !== entry.compressionMethod) fail("invalid_zip", "A ZIP local header does not match its central-directory entry.", { entry: entry.archivePath });
  const localNameEnd = offset + 30 + nameLength;
  if (localNameEnd > archive.byteLength) fail("invalid_zip", "A ZIP local filename is outside the archive bounds.", { entry: entry.archivePath });
  const localName = validateArchivePath(decodeEntryName(archive.subarray(offset + 30, localNameEnd), Boolean(flags & 0x800)), limits);
  if (localName !== entry.archivePath) fail("invalid_zip", "A ZIP local filename does not match its central-directory entry.", { entry: entry.archivePath });
  const dataStart = offset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > archive.byteLength) fail("invalid_zip", "A ZIP entry payload is outside the archive bounds.", { entry: entry.archivePath });
  const compressed = archive.subarray(dataStart, dataEnd);
  let output: Buffer;
  try {
    output = entry.compressionMethod === 0
      ? Buffer.from(compressed)
      : inflateRawSync(compressed, { maxOutputLength: Math.min(limits.maxIndividualFileBytes, entry.uncompressedSize + 1) });
  } catch (error) {
    fail("invalid_zip", `Could not decompress ${entry.archivePath}: ${errorMessage(error)}`, { entry: entry.archivePath });
  }
  if (output!.byteLength !== entry.uncompressedSize || crc32(output!) !== entry.crc32) {
    fail("invalid_zip", "A ZIP entry failed size or CRC validation.", { entry: entry.archivePath });
  }
  return output!;
}

function validateExtractedSkill(staging: string, preview: SkillPackagePreview): void {
  const skillPath = containedPath(staging, "SKILL.md");
  const stat = safeLstat(skillPath);
  if (!stat?.isFile() || stat.isSymbolicLink()) fail("missing_skill_file", "Staged skill is missing a regular SKILL.md file.");
  const parsed = parseSkillMetadata(readFileSync(skillPath, "utf8"), null);
  if (parsed.name !== preview.name || parsed.description !== preview.description) {
    fail("archive_changed", "Staged skill metadata differs from the import preview.");
  }
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const child = lstatSync(path);
      if (child.isSymbolicLink() || (!child.isDirectory() && !child.isFile())) {
        fail("link_entry", "The staged skill contains a link or special file.", { entry: relative(staging, path) });
      }
      if (child.isDirectory()) visit(path);
    }
  };
  visit(staging);
}

function validateArchivePath(input: string, limits: SkillPackageLimits): string {
  if (!input || input.includes("\0")) fail("unsafe_archive_path", "ZIP entry path is empty or contains a null byte.", { entry: input });
  if (input.startsWith("/") || input.startsWith("\\") || /^[/\\]{2}/.test(input) || /^[A-Za-z]:[/\\]/.test(input) || isAbsolute(input)) {
    fail("unsafe_archive_path", "Absolute, drive-letter, and UNC ZIP paths are not allowed.", { entry: input });
  }
  const normalized = input.replace(/\\/g, "/");
  const segments = normalized.split("/").filter((segment, index, all) => !(segment === "" && index === all.length - 1));
  if (segments.some((segment) => segment === ".." || segment === "." || segment === "")) {
    fail("unsafe_archive_path", "Relative traversal segments are not allowed in ZIP paths.", { entry: input });
  }
  if (normalized.length > limits.maxPathLength) failLimit("path length", limits.maxPathLength, normalized);
  if (segments.length > limits.maxDirectoryDepth + 1) failLimit("directory depth", limits.maxDirectoryDepth, normalized);
  return normalized;
}

function containedPath(root: string, archivePath: string): string {
  const target = resolve(root, ...archivePath.split("/"));
  const relativePath = relative(resolve(root), target);
  if (relativePath === "" || relativePath.startsWith(`..${sep}`) || relativePath === ".." || isAbsolute(relativePath)) {
    fail("unsafe_archive_path", "A normalized path escapes the installation directory.", { entry: archivePath });
  }
  return target;
}

function findEndOfCentralDirectory(archive: Buffer): number {
  const start = Math.max(0, archive.byteLength - MAX_EOCD_SEARCH);
  for (let offset = archive.byteLength - 22; offset >= start; offset -= 1) {
    if (archive.readUInt32LE(offset) === EOCD_SIGNATURE) {
      const commentLength = archive.readUInt16LE(offset + 20);
      if (offset + 22 + commentLength === archive.byteLength) return offset;
    }
  }
  fail("invalid_zip", "The file is not a valid ZIP archive.");
}

function decodeEntryName(bytes: Buffer, utf8: boolean): string {
  try {
    return new TextDecoder(utf8 ? "utf-8" : "latin1", { fatal: true }).decode(bytes);
  } catch {
    fail("invalid_zip", "A ZIP entry has an unreadable filename.");
  }
}

function requiredMetadataString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    fail("invalid_skill_metadata", `${field} is required and must be a non-empty string.`, { field });
  }
  return value.trim();
}

function optionalMetadataString(value: unknown, field: string, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    fail("invalid_skill_metadata", `${field} must be a non-empty string no longer than ${maxLength} characters.`, { field });
  }
  return value.trim();
}

function dirnameArchivePath(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

function compressionRatio(uncompressed: number, compressed: number): number {
  if (uncompressed === 0) return 1;
  if (compressed === 0) return Number.POSITIVE_INFINITY;
  return uncompressed / compressed;
}

function failLimit(kind: string, limit: number, entry?: string): never {
  fail("archive_limit_exceeded", `Archive ${kind} exceeds the configured limit.`, { kind, limit, ...(entry ? { entry } : {}) });
}

function fail(code: SkillPackageErrorCode, message: string, details: Record<string, unknown> = {}): never {
  throw new SkillPackageError(code, message, details);
}

function safeLstat(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatBytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

const CRC_TABLE = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(buffer: Buffer): number {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
