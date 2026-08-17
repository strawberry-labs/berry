import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  DockerSandboxProvider,
  E2BSandboxProvider,
  createSandboxProviderFromConfig,
  sandboxProviderConfigFromEnv,
  type DockerCommandExecutor,
  type DockerCommandResult,
  type DockerStreamEvent,
  type SandboxHandle,
  type SandboxCreateInput,
  type SandboxProvider,
} from "@berry/sandbox-contract";
import type { ChatContentPart, ImageGenerationResult } from "@berry/router-client";
import {
  DEFAULT_SANDBOX_INPUT_MAX_BYTES,
  ORGANIZATION_SKILL_PACKAGE_MAX_BYTES,
  normalizeWorkerRole,
  sourceRevisionFromEnv,
  type AgentStreamEvent,
  type JsonValue,
} from "@berry/shared";
import { durableAttachmentPath } from "./durable-attachments.js";
import type { SandboxSnapshotJobPayload } from "./jobs.js";
import type { SqlExecutor } from "./sql-repositories.js";
import { s3ClientOptions } from "./s3-client-options.js";
import { emitWorkerOperationalEvent } from "./operational-telemetry.js";
import type {
  DurableTurnSnapshot,
  DurableTurnStep,
  DurableTurnToolExecutor,
  DurableSkillPackageFile,
  DurableSkillPackageStageOptions,
  TurnToolResult,
} from "./turn-runner.js";

const MAX_SNAPSHOT_ARCHIVE_BYTES = 384 * 1024 * 1024;
const MAX_MODEL_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_MODEL_IMAGE_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_MODEL_IMAGES = 5;
const PI_TOOL_MAX_LINES = 2_000;
const PI_TOOL_MAX_BYTES = 50 * 1024;
const PI_READ_MAX_LINE_LENGTH = 2_000;
const PI_GREP_MAX_LINE_LENGTH = 500;
const PI_GREP_META_PREFIX = "__BERRY_PI_GREP_META__";
export const PI_BASH_WRAPPER_SCRIPT = 'mkdir -p -- "$(dirname "$2")" || exit; set -o pipefail; bash -lc "$1" 2>&1 | tee -- "$2"; pipeline_status=("${PIPESTATUS[@]}"); [ "${pipeline_status[0]}" -ne 0 ] && exit "${pipeline_status[0]}"; exit "${pipeline_status[1]}"';
const DEFAULT_TERMINAL_SNAPSHOT_TIMEOUT_MS = 120_000;
const DEFAULT_INTERVAL_SNAPSHOT_TIMEOUT_MS = 60_000;
const DEFAULT_TERMINAL_SUSPEND_TIMEOUT_MS = 70_000;
const MAX_SNAPSHOT_FILES = 5_000;
const MAX_SNAPSHOT_BYTES = 250 * 1024 * 1024;
const INACTIVE_SANDBOX_STATES = new Set(["paused", "missing", "stopped", "destroyed"]);
const TERMINAL_RUN_STATES = new Set(["completed", "failed", "cancelled", "recovery_required"]);

/**
 * Runs inside the sandbox so hostile files are reduced before they cross the
 * provider boundary. Keep this dependency-free: every Berry sandbox includes
 * Node, but optional packages are not guaranteed.
 */
export const PI_READ_STREAM_SCRIPT = String.raw`
const fs = require("node:fs");
const { StringDecoder } = require("node:string_decoder");
const filePath = process.argv[1];
const offset = Number(process.argv[2] || 1);
const requestedLimit = Number(process.argv[3] || 0);
const maxLines = Number(process.argv[4]);
const maxBytes = Number(process.argv[5]);
const maxLineCharacters = Number(process.argv[6]);
const suffix = "\u2026 [truncated; use bash for full line]";
const suffixLength = Array.from(suffix).length;
let lineNumber = 1;
let totalLines = 0;
let sawContent = false;
let endedWithLineBreak = false;
let skipLf = false;
let atStart = true;
let prefix = [];
let prefixCharacters = 0;
let lineClamped = false;
let outputBytes = 0;
let truncatedBy = null;
let linesTruncated = false;
const output = [];
const selected = () => lineNumber >= offset && (requestedLimit === 0 || lineNumber < offset + requestedLimit);
const resetLine = () => {
  prefix = [];
  prefixCharacters = 0;
  lineClamped = false;
};
const finishLine = () => {
  totalLines = lineNumber;
  if (selected() && !truncatedBy) {
    let rendered = prefix.join("");
    if (lineClamped) {
      rendered = Array.from(rendered).slice(0, maxLineCharacters - suffixLength).join("") + suffix;
      linesTruncated = true;
    }
    const lineBytes = Buffer.byteLength(rendered, "utf8") + (output.length > 0 ? 1 : 0);
    if (output.length >= maxLines) truncatedBy = "lines";
    else if (outputBytes + lineBytes > maxBytes) truncatedBy = "bytes";
    else {
      output.push(rendered);
      outputBytes += lineBytes;
    }
  }
  lineNumber += 1;
  resetLine();
  endedWithLineBreak = true;
};
const appendCharacter = (character) => {
  endedWithLineBreak = false;
  if (atStart) {
    atStart = false;
    if (character === "\uFEFF") return;
  }
  sawContent = true;
  if (!selected() || truncatedBy) return;
  if (prefixCharacters < maxLineCharacters) {
    prefix.push(character);
    prefixCharacters += 1;
  } else {
    lineClamped = true;
  }
};
const consume = (text) => {
  for (const character of text) {
    if (skipLf) {
      skipLf = false;
      if (character === "\n") continue;
    }
    if (character === "\r") {
      atStart = false;
      sawContent = true;
      finishLine();
      skipLf = true;
    } else if (character === "\n") {
      atStart = false;
      sawContent = true;
      finishLine();
    } else {
      appendCharacter(character);
    }
  }
};
(async () => {
  const decoder = new StringDecoder("utf8");
  for await (const chunk of fs.createReadStream(filePath)) consume(decoder.write(chunk));
  consume(decoder.end());
  if (sawContent && !endedWithLineBreak) finishLine();
  const sizeBytes = fs.statSync(filePath).size;
  const details = {};
  let content;
  if (totalLines === 0) {
    content = "[File is empty.]";
    details.empty = true;
    details.totalLines = 0;
  } else if (offset > totalLines) {
    content = "[Offset " + offset + " is beyond end of file (" + totalLines + " lines total). Retry with offset=" + Math.max(1, totalLines) + " or smaller.]";
    details.eof = true;
    details.totalLines = totalLines;
  } else {
    const notices = [];
    if (truncatedBy) {
      const endDisplay = offset + output.length - 1;
      notices.push("Showing lines " + offset + "-" + endDisplay + " of " + totalLines + (truncatedBy === "bytes" ? " (50.0KB limit)" : "") + ". Use offset=" + (endDisplay + 1) + " to continue.");
      details.truncated = true;
      details.truncatedBy = truncatedBy;
      details.totalLines = totalLines;
      details.outputLines = output.length;
    } else if (requestedLimit > 0 && offset - 1 + requestedLimit < totalLines) {
      const endLine = offset - 1 + requestedLimit;
      notices.push((totalLines - endLine) + " more lines in file. Use offset=" + (endLine + 1) + " to continue.");
    }
    if (linesTruncated) {
      notices.push("Some lines were truncated to " + maxLineCharacters + " characters. Use bash for targeted full-line inspection.");
      details.truncated = true;
      details.linesTruncated = true;
    }
    content = output.join("\n") + (notices.length > 0 ? "\n\n[" + notices.join(" ") + "]" : "");
  }
  process.stdout.write(JSON.stringify({ content, details, sizeBytes }));
})().catch((error) => {
  process.stderr.write(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
`;

/** Convert ripgrep JSON to bounded Pi-style lines before it reaches the worker. */
export const PI_GREP_FILTER_SCRIPT = String.raw`
const readline = require("node:readline");
const root = String(process.argv[1] || "").replace(/\/+$/, "");
const limit = Number(process.argv[2]);
const maxBytes = Number(process.argv[3]);
const maxLineCharacters = Number(process.argv[4]);
const metaPrefix = "__BERRY_PI_GREP_META__";
let matchCount = 0;
let outputBytes = 0;
let wroteLine = false;
let limitReached = false;
let byteLimitReached = false;
let linesTruncated = false;
let finished = false;
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const finish = () => {
  if (finished) return;
  finished = true;
  process.stderr.write(metaPrefix + JSON.stringify({ matchCount, limitReached, byteLimitReached, linesTruncated }) + "\n");
};
const stop = () => {
  finish();
  input.close();
  process.stdin.destroy();
};
const displayPath = (value) => {
  const path = String(value || "").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!path.startsWith("/")) return path;
  if (path === root) return path.split("/").pop() || path;
  return path.startsWith(root + "/") ? path.slice(root.length + 1) : path;
};
input.on("line", (line) => {
  let event;
  try { event = JSON.parse(line); } catch { return; }
  if (event.type !== "match" && event.type !== "context") return;
  if (event.type === "match" && matchCount >= limit) {
    limitReached = true;
    stop();
    return;
  }
  const data = event.data || {};
  const path = data.path && data.path.text;
  const lineNumber = data.line_number;
  const text = data.lines && data.lines.text;
  if (typeof path !== "string" || !Number.isSafeInteger(lineNumber) || typeof text !== "string") return;
  if (event.type === "match") matchCount += 1;
  const separator = event.type === "match" ? ":" : "-";
  let rendered = displayPath(path) + separator + lineNumber + separator + text.replace(/[\r\n]+$/, "");
  const characters = Array.from(rendered);
  if (characters.length > maxLineCharacters) {
    rendered = characters.slice(0, maxLineCharacters).join("") + "... [truncated]";
    linesTruncated = true;
  }
  const lineBytes = Buffer.byteLength(rendered, "utf8") + (wroteLine ? 1 : 0);
  if (outputBytes + lineBytes > maxBytes) {
    byteLimitReached = true;
    stop();
    return;
  }
  if (wroteLine) process.stdout.write("\n");
  process.stdout.write(rendered);
  wroteLine = true;
  outputBytes += lineBytes;
});
input.on("close", finish);
process.on("beforeExit", finish);
`;

interface SnapshotArchive {
  version: 1;
  createdAt: string;
  files: Array<{ path: string; content: string; encoding: "base64"; mode?: number }>;
}

interface SnapshotRun {
  tenantId: string;
  userId?: string;
  workspaceId?: string;
  runId: string;
  sessionId: string;
  taskId: string;
  sandboxProvider: string | null;
  sandboxId: string | null;
  sandboxState?: string | null;
  runState: string;
  sandboxClaimedByNewerRun?: boolean;
  sessionLeafId: string | null;
}

interface SnapshotRecord {
  id: string;
  objectKey: string;
  contentHash: string;
  sequence: number;
}

interface SessionContinuityRecord {
  provider: string | null;
  sandboxId: string | null;
  snapshot: SnapshotRecord | null;
}

interface SandboxInputFile {
  fileId: string;
  name: string;
  mediaType: string;
  sizeBytes: number;
  objectKey: string;
  objectVersionId?: string | null;
}

interface SandboxOutputFile {
  fileId: string;
  name: string;
  mediaType: string;
  sizeBytes: number;
  objectKey: string;
}

interface PublishedSandboxOutput {
  sourcePath: string;
  sha256: string;
}

export interface SandboxSnapshotRepository {
  loadRun(tenantId: string, runId: string): Promise<SnapshotRun>;
  continuity(tenantId: string, runId: string): Promise<SessionContinuityRecord | null>;
  inputFiles(tenantId: string, runId: string, scope?: "turn" | "session"): Promise<readonly SandboxInputFile[]>;
  publishedOutputs?(tenantId: string, sessionId: string): Promise<readonly PublishedSandboxOutput[]>;
  recordArtifactOperationStart?(input: {
    tenantId: string;
    runId: string;
    operationKey: string;
    relativeKeyFingerprint: string;
    sourcePath: string;
  }): Promise<void>;
  recordArtifactOperationStorage?(input: {
    tenantId: string;
    runId: string;
    operationKey: string;
    storageReceipt: JsonValue;
  }): Promise<void>;
  completeArtifactOperation?(input: {
    tenantId: string;
    runId: string;
    operationKey: string;
    fileId: string;
  }): Promise<void>;
  failArtifactOperation?(input: {
    tenantId: string;
    runId: string;
    operationKey: string;
    errorClass: string;
  }): Promise<void>;
  beginFinalization?(input: {
    tenantId: string;
    runId: string;
    owner: string;
  }): Promise<{ id: string; attempt: number } | null>;
  finishFinalization?(input: {
    tenantId: string;
    runId: string;
    sessionId: string;
    owner: string;
    operationKey: string;
    status: "complete" | "partial";
    itemCount: number;
    completedCount: number;
    failedCount: number;
    manifest: JsonValue;
  }): Promise<void>;
  failFinalization?(input: {
    tenantId: string;
    runId: string;
    sessionId: string;
    owner: string;
    operationKey: string;
    errorClass: string;
  }): Promise<void>;
  skipFinalization?(input: {
    tenantId: string;
    runId: string;
    sessionId: string;
    operationKey: string;
    reason: string;
  }): Promise<void>;
  persistOutput(input: {
    snapshot: DurableTurnSnapshot;
    fileId: string;
    name: string;
    mediaType: string;
    sizeBytes: number;
    sha256: string;
    bucket: string;
    objectKey: string;
    etag: string | null;
    objectVersionId?: string | null;
    origin?: "sandbox_output" | "image_generation";
    sourcePath?: string;
  }): Promise<SandboxOutputFile>;
  latest(tenantId: string, runId: string): Promise<SnapshotRecord | null>;
  persist(input: {
    run: SnapshotRun;
    provider: string;
    sandboxId: string;
    objectKey: string;
    contentHash: string;
  }): Promise<SnapshotRecord>;
  recordSandbox(input: {
    tenantId: string;
    runId: string;
    provider: string;
    sandboxId: string;
    state: string;
  }): Promise<void>;
  withSandboxLifecycleLock?<T>(
    tenantId: string,
    sandboxId: string,
    operation: (repository: SandboxSnapshotRepository) => Promise<T>,
  ): Promise<T>;
  tryWithSandboxLifecycleLock?<T>(
    tenantId: string,
    sandboxId: string,
    operation: (repository: SandboxSnapshotRepository) => Promise<T>,
  ): Promise<T | null>;
}

export interface SandboxSnapshotObjectStore {
  put(key: string, body: Uint8Array): Promise<void>;
  putArtifact(key: string, body: Uint8Array, mediaType: string): Promise<{
    bucket: string;
    key: string;
    etag: string | null;
    objectVersionId?: string | null;
  }>;
  get(key: string): Promise<Uint8Array>;
  getSource(key: string, versionId?: string | null): Promise<Uint8Array>;
  streamSource?(key: string, maxBytes: number, versionId?: string | null): AsyncIterable<Uint8Array>;
}

export class SandboxContinuityManager implements DurableTurnToolExecutor {
  readonly #stagedInputFileIds = new Map<string, Set<string>>();
  readonly #sandboxStarts = new Map<string, Promise<{ provider: string; id: string; state: string }>>();

  constructor(
    private readonly provider: SandboxProvider,
    private readonly repository: SandboxSnapshotRepository,
    private readonly objects: SandboxSnapshotObjectStore | null,
    private readonly options: {
      image: string;
      cwd?: string;
      ttlSeconds?: number;
      maxInputBytes?: number;
      intervalSnapshotTimeoutMs?: number;
      terminalSnapshotTimeoutMs?: number;
      terminalSuspendTimeoutMs?: number;
      enableTerminalFinalization?: boolean;
      imageGeneration?: {
        endpoint: string;
        editsEndpoint: string;
        apiKey?: string;
        model: string;
        responseFormat: "url" | "b64_json";
      };
    },
  ) {}

  async modelContent(
    snapshot: DurableTurnSnapshot,
    signal?: AbortSignal,
    reportProgress?: () => void,
  ): Promise<readonly ChatContentPart[]> {
    signal?.throwIfAborted();
    const workspaceRoot = safeWorkspaceRoot(this.options.cwd ?? "/workspace");
    const attachedImages = (await this.repository.inputFiles(snapshot.tenantId, snapshot.id, "turn"))
      .filter((file) => file.mediaType.startsWith("image/"));
    signal?.throwIfAborted();
    const attachedImageIds = new Set(attachedImages.map((file) => file.fileId));
    const explicitPaths = requestedInspectionImagePaths(snapshot, workspaceRoot);
    const requestedSandboxImages = (explicitPaths ?? exposedSandboxImagePaths(snapshot, workspaceRoot))
      .filter((path) => {
        const attachmentId = sandboxAttachmentId(path, workspaceRoot);
        return !attachmentId || !attachedImageIds.has(attachmentId);
      });
    const selectedAttachments = explicitPaths
      ? explicitPaths.flatMap((path) => {
          const attachmentId = sandboxAttachmentId(path, workspaceRoot);
          const file = attachmentId ? attachedImages.find((candidate) => candidate.fileId === attachmentId) : undefined;
          return file ? [file] : [];
        })
      : attachedImages;
    if (requestedSandboxImages.length === 0 && selectedAttachments.length === 0) return [];

    const parts: ChatContentPart[] = [];
    let totalBytes = 0;
    const append = (mediaType: string, bytes: Uint8Array): boolean => {
      if (
        parts.length >= MAX_MODEL_IMAGES
        || bytes.byteLength === 0
        || bytes.byteLength > MAX_MODEL_IMAGE_BYTES
        || totalBytes + bytes.byteLength > MAX_MODEL_IMAGE_TOTAL_BYTES
      ) {
        return false;
      }
      parts.push({
        type: "image_url",
        image_url: {
          url: `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`,
        },
      });
      totalBytes += bytes.byteLength;
      return true;
    };

    const loadSandboxSources = async (paths: readonly string[]) => {
      if (paths.length === 0) return [];
      const sandbox = await this.ensureSandbox(snapshot, signal);
      return Promise.all(paths.slice(0, MAX_MODEL_IMAGES).map(async (path) => {
        signal?.throwIfAborted();
        const mediaType = binaryMediaType(path);
        if (!mediaType?.startsWith("image/")) throw new Error(`inspect_images only accepts image paths: ${path}`);
        const readInput = { sandbox_id: sandbox.id, path, encoding: "base64" } as const;
        const source = await (signal
          ? this.provider.files.read(readInput, { signal })
          : this.provider.files.read(readInput));
        reportProgress?.();
        return { path, mediaType, bytes: Buffer.from(source.content, "base64") };
      }));
    };
    const loadAttachmentSources = async (files: readonly SandboxInputFile[]) => {
      if (files.length === 0) return [];
      const objects = this.objects;
      if (!objects) throw new Error("Input image object storage is not configured");
      return Promise.all(files.map(async (file) => {
        signal?.throwIfAborted();
        const bytes = await objects.getSource(file.objectKey, file.objectVersionId);
        signal?.throwIfAborted();
        reportProgress?.();
        if (bytes.byteLength !== file.sizeBytes) {
          throw new Error(`Input image ${file.name} is incomplete`);
        }
        return {
          path: durableAttachmentPath({ fileId: file.fileId, name: file.name }, workspaceRoot),
          mediaType: file.mediaType,
          bytes,
        };
      }));
    };

    if (explicitPaths) {
      for (const file of selectedAttachments) {
        if (file.sizeBytes <= 0 || file.sizeBytes > MAX_MODEL_IMAGE_BYTES) {
          throw new Error(`Image exceeds the ${MAX_MODEL_IMAGE_BYTES} byte inspection limit: ${file.name}`);
        }
      }
      const [sandboxSources, attachmentSources] = await Promise.all([
        loadSandboxSources(requestedSandboxImages),
        loadAttachmentSources(selectedAttachments),
      ]);
      const loadedSources = [...sandboxSources, ...attachmentSources];
      const sources = explicitPaths.flatMap((path) => {
        const source = loadedSources.find((candidate) => candidate.path === path);
        return source ? [source] : [];
      });
      if (sources.length !== explicitPaths.length) {
        const loadedPaths = new Set(sources.map((source) => source.path));
        const missing = explicitPaths.filter((path) => !loadedPaths.has(path));
        throw new Error(`inspect_images could not load the exact requested image path${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`);
      }
      for (const source of sources) {
        if (!append(source.mediaType, source.bytes)) {
          throw new Error("The selected images exceed the per-image or 50 MB combined inspection limit");
        }
      }
      return parts;
    }

    const sandboxSources = await loadSandboxSources(requestedSandboxImages);
    for (const source of sandboxSources) append(source.mediaType, source.bytes);

    // Choose attachments only after sandbox images are validated. This keeps
    // concurrent reads while allowing later valid files to backfill slots left
    // by oversized or over-budget candidates.
    const attachmentFiles: SandboxInputFile[] = [];
    let plannedTotalBytes = totalBytes;
    for (const file of selectedAttachments) {
      if (attachmentFiles.length >= MAX_MODEL_IMAGES - parts.length) break;
      if (file.sizeBytes <= 0 || file.sizeBytes > MAX_MODEL_IMAGE_BYTES) continue;
      if (plannedTotalBytes + file.sizeBytes > MAX_MODEL_IMAGE_TOTAL_BYTES) continue;
      attachmentFiles.push(file);
      plannedTotalBytes += file.sizeBytes;
    }
    const attachmentSources = await loadAttachmentSources(attachmentFiles);
    for (const source of attachmentSources) append(source.mediaType, source.bytes);
    return parts;
  }

  async stageAssociatedInputFiles(
    snapshot: DurableTurnSnapshot,
    fileIds: readonly string[],
    options: { signal?: AbortSignal | undefined; reportProgress?: (() => void) | undefined } = {},
  ): Promise<readonly {
    fileId: string;
    name: string;
    mediaType: string;
    path: string;
  }[]> {
    const sandbox = await this.ensureSandbox(snapshot, options.signal);
    const workspaceRoot = safeWorkspaceRoot(this.options.cwd ?? "/workspace");
    const selected = new Set(fileIds);
    const files = (await this.repository.inputFiles(snapshot.tenantId, snapshot.id))
      .filter((file) => selected.has(file.fileId));
    options.signal?.throwIfAborted();
    await this.stageInputFiles(snapshot, sandbox.id, this.repository, selected, options.signal, options.reportProgress);
    return files.map((file) => ({
      fileId: file.fileId,
      name: file.name,
      mediaType: file.mediaType,
      path: durableAttachmentPath({ fileId: file.fileId, name: file.name }, workspaceRoot),
    }));
  }

  async readSkillPackage(snapshot: DurableTurnSnapshot, requestedPath: string): Promise<readonly DurableSkillPackageFile[]> {
    const sandbox = await this.ensureSandbox(snapshot);
    const workspaceRoot = safeWorkspaceRoot(this.options.cwd ?? "/workspace");
    const normalized = safeWorkspacePath(requestedPath, workspaceRoot);
    const root = normalized.toLowerCase().endsWith("/skill.md")
      ? normalized.slice(0, -"/SKILL.md".length)
      : normalized;
    const listing = await this.provider.files.list({ sandbox_id: sandbox.id, path: root, recursive: true });
    const entries = listing.entries.filter((entry) => entry.type !== "directory");
    if (entries.some((entry) => entry.type === "symlink")) throw new Error("Skill packages cannot contain symbolic links");
    if (entries.length === 0 || entries.length > 501) throw new Error("Skill package must contain SKILL.md and at most 500 resource files");
    const sortedEntries = entries.sort((left, right) => left.path.localeCompare(right.path));
    const totalBytes = sortedEntries.reduce((total, entry) => total + entry.size_bytes, 0);
    if (totalBytes > ORGANIZATION_SKILL_PACKAGE_MAX_BYTES) throw new Error("Skill packages are limited to 100 MB extracted");
    const files = new Array<DurableSkillPackageFile>(sortedEntries.length);
    let nextIndex = 0;
    await Promise.all(Array.from({ length: Math.min(4, sortedEntries.length) }, async () => {
      while (nextIndex < sortedEntries.length) {
        const index = nextIndex++;
        const entry = sortedEntries[index]!;
        const relativePath = relativeSkillPackagePath(root, entry.path);
        const source = await this.provider.files.read({ sandbox_id: sandbox.id, path: entry.path, encoding: "base64" });
        files[index] = { path: relativePath, contentBase64: source.content, mode: relativePath.startsWith("scripts/") ? 0o755 : 0o644 };
      }
    }));
    if (!files.some((file) => file.path === "SKILL.md")) throw new Error("Skill package directory must contain SKILL.md at its root");
    return files;
  }

  async stageSkillPackage(
    snapshot: DurableTurnSnapshot,
    packageId: string,
    files: readonly DurableSkillPackageFile[],
    options: DurableSkillPackageStageOptions = {},
  ): Promise<{ filePath: string; resources: string[]; stagedResources: string[]; stagingSandboxId: string }> {
    const sandbox = await this.ensureSandbox(snapshot, options.signal);
    options.signal?.throwIfAborted();
    options.reportProgress?.();
    const workspaceRoot = safeWorkspaceRoot(this.options.cwd ?? "/workspace");
    const safeId = packageId.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "").slice(0, 160) || "skill";
    if (files.length === 0 || files.length > 501) throw new Error("Skill package must contain SKILL.md and at most 500 resource files");
    const seen = new Set<string>();
    const normalizedFiles = files.map((file) => {
      const path = safeRelativeSkillPackagePath(file.path);
      if (seen.has(path)) throw new Error(`Skill package contains duplicate path: ${path}`);
      seen.add(path);
      const bytes = immediateSkillPackageBytes(file);
      const sizeBytes = file.sizeBytes ?? bytes?.byteLength;
      const sha256 = file.sha256?.toLowerCase() ?? (bytes ? createHash("sha256").update(bytes).digest("hex") : undefined);
      if (!Number.isSafeInteger(sizeBytes) || sizeBytes === undefined || sizeBytes < 0 || !sha256 || !/^[a-f0-9]{64}$/.test(sha256)) {
        throw new Error(`Skill package file metadata is invalid: ${path}`);
      }
      if (bytes && (bytes.byteLength !== sizeBytes || createHash("sha256").update(bytes).digest("hex") !== sha256)) {
        throw new Error(`Skill package file metadata does not match its content: ${path}`);
      }
      return { ...file, path, bytes, sizeBytes, sha256 };
    });
    if (!seen.has("SKILL.md")) throw new Error("Skill package is missing SKILL.md");
    const packageRevision = createHash("sha256");
    for (const file of [...normalizedFiles].sort((left, right) => left.path.localeCompare(right.path))) {
      packageRevision.update(file.path).update("\0").update(String(file.sizeBytes)).update("\0").update(file.sha256).update("\0");
    }
    const totalBytes = normalizedFiles.reduce((total, file) => total + file.sizeBytes, 0);
    if (totalBytes > ORGANIZATION_SKILL_PACKAGE_MAX_BYTES) throw new Error("Skill packages are limited to 100 MB extracted");
    // Reused sandboxes can retain prior files. A content-addressed directory makes
    // package revisions immutable, so resources removed by an update cannot leak
    // into a later activation of the same skill.
    const revision = packageRevision.digest("hex");
    const root = `${workspaceRoot}/runtime-skills/${safeId}-${revision.slice(0, 16)}`;
    const selectedResourcePaths = options.resourcePaths === undefined
      ? normalizedFiles.filter((file) => file.path !== "SKILL.md").map((file) => file.path)
      : [...new Set(options.resourcePaths.map(safeRelativeSkillPackagePath))];
    const unknownPaths = selectedResourcePaths.filter((path) => path === "SKILL.md" || !seen.has(path));
    if (unknownPaths.length > 0) {
      throw new Error(`Unknown skill package resource${unknownPaths.length === 1 ? "" : "s"}: ${unknownPaths.join(", ")}`);
    }
    const targetPaths = new Set(["SKILL.md", ...selectedResourcePaths]);
    const stagedPaths = durablyStagedSkillPackagePaths(snapshot, root, sandbox.id);
    const missingFiles = normalizedFiles.filter((file) => targetPaths.has(file.path) && !stagedPaths.has(file.path));
    const lazyPaths = missingFiles.filter((file) => !file.bytes).map((file) => file.path);
    const loaded = lazyPaths.length > 0 && options.loadContentBytes
      ? await options.loadContentBytes(lazyPaths)
      : new Map<string, Uint8Array>();
    options.reportProgress?.();
    options.signal?.throwIfAborted();
    const prepared = await mapWithConcurrency(missingFiles, 4, async (file) => {
      const loadedBytes = loaded.get(file.path);
      const bytes = file.bytes ?? (loadedBytes
        ? Buffer.from(loadedBytes.buffer, loadedBytes.byteOffset, loadedBytes.byteLength)
        : await loadSkillPackageBytes(file));
      if (bytes.byteLength !== file.sizeBytes || createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
        throw new Error(`Skill package file changed while it was being staged: ${file.path}`);
      }
      return {
        path: `${root}/${file.path}`,
        relativePath: file.path,
        content: bytes,
        mode: file.mode ?? (file.path.startsWith("scripts/") ? 0o755 : 0o644),
      };
    });
    if (prepared.length > 0) {
      if (this.provider.files.writeManyBytes) {
        await this.provider.files.writeManyBytes({
          sandbox_id: sandbox.id,
          files: prepared.map(({ path, content, mode }) => ({ path, content, mode })),
        }, { signal: options.signal });
      } else {
        await mapWithConcurrency(prepared, 4, async ({ path, content, mode }) => {
          options.signal?.throwIfAborted();
          if (this.provider.files.writeBytes) {
            await this.provider.files.writeBytes({ sandbox_id: sandbox.id, path, content, mode }, { signal: options.signal });
          } else {
            await this.provider.files.write({ sandbox_id: sandbox.id, path, content: content.toString("base64"), encoding: "base64", mode }, { signal: options.signal });
          }
        });
      }
      options.signal?.throwIfAborted();
      options.reportProgress?.();
      for (const file of prepared) stagedPaths.add(file.relativePath);
    }
    return {
      filePath: `${root}/SKILL.md`,
      resources: normalizedFiles.filter((file) => file.path !== "SKILL.md").map((file) => `${root}/${file.path}`),
      stagedResources: normalizedFiles
        .filter((file) => file.path !== "SKILL.md" && stagedPaths.has(file.path))
        .map((file) => `${root}/${file.path}`),
      stagingSandboxId: sandbox.id,
    };
  }

  supportsAbort(_snapshot: DurableTurnSnapshot, _step: DurableTurnStep): boolean {
    // Sandbox reads still await repository, lifecycle-lock, and object-store
    // operations without an AbortSignal contract. Keep them non-abortable so
    // the turn runner retains its lease until the complete operation settles.
    return false;
  }

  async execute(
    snapshot: DurableTurnSnapshot,
    step: DurableTurnStep,
    signal?: AbortSignal,
    reportProgress?: () => void,
  ): Promise<TurnToolResult> {
    const toolName = stringValue(step.input.toolName) ?? step.type.slice(5);
    const prepared = prepareCoreToolArguments(toolName, step.input.arguments);
    const args = prepared.args;
    validateCoreToolArguments(toolName, args);
    const inputRepairDetails = prepared.repairs.length > 0
      ? { inputRepairs: prepared.repairs }
      : {};
    const sandbox = await this.ensureSandbox(snapshot, signal);
    const workspaceRoot = safeWorkspaceRoot(this.options.cwd ?? "/workspace");
    if (toolName === "read") {
      const path = safeReadablePath(requiredToolPath(args, toolName), workspaceRoot);
      const mediaType = binaryMediaType(path);
      if (mediaType === "application/pdf") {
        const content = await extractPdfText(this.provider, sandbox.id, path, step, workspaceRoot, signal, reportProgress);
        const formatted = piReadContent(content, args);
        return {
          output: {
            path,
            content: formatted.content,
            mediaType,
            extractedText: true,
            ...formatted.details,
            ...inputRepairDetails,
          },
          summary: `Extracted text from ${path}`,
          sandbox,
        };
      }
      if (mediaType) {
        return {
          output: {
            path,
            binary: true,
            mediaType,
            ...(mediaType.startsWith("image/") ? { visionPath: path } : {}),
            content: mediaType.startsWith("image/")
              ? `This ${mediaType} image will be attached to the next model request for visual inspection.`
              : `This is a binary ${mediaType} file. It was not decoded as UTF-8. Use a document-capable skill/tool, or bash with an appropriate inspection utility.`,
            ...inputRepairDetails,
          },
          summary: `Identified ${path} as a binary ${mediaType} file`,
          sandbox,
        };
      }
      const result = await readSandboxText(
        this.provider,
        sandbox.id,
        `${step.idempotencyKey ?? step.id}:pi-read`,
        path,
        args,
        workspaceRoot,
        signal,
        reportProgress,
      );
      return {
        output: { path, content: result.content, sizeBytes: result.sizeBytes, ...result.details, ...inputRepairDetails },
        summary: `Read ${path}`,
        sandbox,
      };
    }
    if (toolName === "ls") {
      const path = safeReadablePath(stringValue(args.path) ?? workspaceRoot, workspaceRoot);
      const limit = numberValue(args.limit) ?? 500;
      const listInput = { sandbox_id: sandbox.id, path, recursive: false };
      const result = await (signal
        ? this.provider.files.list(listInput, { signal })
        : this.provider.files.list(listInput));
      reportProgress?.();
      const entries = result.entries
        .flatMap((entry) => {
          if (entry.path.replace(/\/+$/, "") === path.replace(/\/+$/, "")) return [];
          const name = entry.path.replace(/\/+$/, "").split("/").at(-1) ?? entry.path;
          return [`${name}${entry.type === "directory" ? "/" : ""}`];
        })
        .sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()));
      const limited = entries.slice(0, limit);
      const truncated = truncatePiHead(limited.join("\n"), Number.MAX_SAFE_INTEGER);
      const notices = [
        ...(entries.length > limit ? [`${limit} entries limit reached. Use limit=${limit * 2} for more`] : []),
        ...(truncated.truncated ? ["50.0KB limit reached"] : []),
      ];
      const content = limited.length === 0
        ? "(empty directory)"
        : `${truncated.content}${notices.length > 0 ? `\n\n[${notices.join(". ")}]` : ""}`;
      return {
        output: { path: result.path, content, ...(notices.length > 0 ? { truncated: true } : {}), ...inputRepairDetails },
        summary: `Listed ${limited.length} entries under ${result.path}`,
        sandbox,
      };
    }
    if (toolName === "write") {
      const path = safeWorkspacePath(requiredToolPath(args, toolName), workspaceRoot);
      const content = requiredToolString(args, "content", toolName, true);
      const writeInput = {
        sandbox_id: sandbox.id,
        path,
        content,
        encoding: "utf8",
      } as const;
      const result = await (signal
        ? this.provider.files.write(writeInput, { signal })
        : this.provider.files.write(writeInput));
      reportProgress?.();
      return {
        output: { path: result.path, sizeBytes: result.size_bytes, mtime: result.mtime, ...inputRepairDetails },
        summary: `Wrote ${result.path}`,
        sandbox,
      };
    }
    if (toolName === "edit") {
      const path = safeWorkspacePath(requiredToolPath(args, toolName), workspaceRoot);
      const edits = piEditEntries(args).map((edit) => ({
        oldText: edit.oldText.replace(/\r\n/g, "\n").replace(/\r/g, "\n"),
        newText: edit.newText.replace(/\r\n/g, "\n").replace(/\r/g, "\n"),
      }));
      const readInput = { sandbox_id: sandbox.id, path, encoding: "utf8" } as const;
      const existing = await (signal
        ? this.provider.files.read(readInput, { signal })
        : this.provider.files.read(readInput));
      reportProgress?.();
      const bom = existing.content.startsWith("\uFEFF") ? "\uFEFF" : "";
      const source = bom ? existing.content.slice(1) : existing.content;
      const lineEnding = source.includes("\r\n") ? "\r\n" : source.includes("\r") ? "\r" : "\n";
      const normalizedSource = source.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      const replacements = edits.map((edit, index) => {
        const start = normalizedSource.indexOf(edit.oldText);
        if (start < 0) throw new Error(`edits[${index}].oldText was not found in ${path}`);
        if (normalizedSource.indexOf(edit.oldText, start + 1) >= 0) {
          throw new Error(`edits[${index}].oldText is not unique in ${path}; provide more context`);
        }
        return { ...edit, start, end: start + edit.oldText.length, index };
      }).sort((left, right) => left.start - right.start);
      for (let index = 1; index < replacements.length; index += 1) {
        const previous = replacements[index - 1]!;
        const current = replacements[index]!;
        if (current.start < previous.end) {
          throw new Error(`edits[${previous.index}] and edits[${current.index}] overlap in ${path}; merge them into one edit`);
        }
      }
      let content = normalizedSource;
      for (const replacement of [...replacements].reverse()) {
        content = `${content.slice(0, replacement.start)}${replacement.newText}${content.slice(replacement.end)}`;
      }
      const finalContent = bom + (lineEnding === "\n" ? content : content.replace(/\n/g, lineEnding));
      const writeInput = { sandbox_id: sandbox.id, path, content: finalContent, encoding: "utf8" } as const;
      const written = await (signal
        ? this.provider.files.write(writeInput, { signal })
        : this.provider.files.write(writeInput));
      reportProgress?.();
      return {
        output: { path: written.path, replacements: replacements.length, sizeBytes: written.size_bytes, ...inputRepairDetails },
        summary: `Edited ${written.path}`,
        sandbox,
      };
    }
    if (toolName === "find") {
      const pattern = stringValue(args.pattern, true);
      if (pattern === null) throw new Error("find requires a pattern");
      const path = safeReadablePath(stringValue(args.path) ?? workspaceRoot, workspaceRoot);
      const limit = numberValue(args.limit) ?? 1_000;
      const result = await sandboxCommand(this.provider, sandbox.id, step.id, [
        "sh", "-c",
        'root="$1"; pattern="$2"; if ! command -v rg >/dev/null 2>&1; then echo "ripgrep (rg) is required for find" >&2; exit 127; fi; cd "$root" || exit; rg --files --hidden -g "!.git/**" -g "!node_modules/**" -g "$pattern"; status=$?; [ "$status" -eq 0 ] || [ "$status" -eq 1 ]',
        "berry-find", path, pattern,
      ], workspaceRoot, signal, reportProgress);
      const allFiles = result.split("\n").filter(Boolean);
      const files = allFiles.slice(0, limit);
      const truncated = truncatePiHead(files.join("\n"), Number.MAX_SAFE_INTEGER);
      const notices = [
        ...(allFiles.length > limit ? [`${limit} results limit reached`] : []),
        ...(truncated.truncated ? ["50.0KB limit reached"] : []),
      ];
      const content = files.length === 0
        ? "No files found matching pattern"
        : `${truncated.content}${notices.length > 0 ? `\n\n[${notices.join(". ")}]` : ""}`;
      return {
        output: { path, pattern, content, ...(notices.length > 0 ? { truncated: true } : {}), ...inputRepairDetails },
        summary: `Matched ${files.length} files`,
        sandbox,
      };
    }
    if (toolName === "grep") {
      const pattern = stringValue(args.pattern, true);
      if (pattern === null) throw new Error("grep requires a pattern");
      const path = safeReadablePath(stringValue(args.path) ?? workspaceRoot, workspaceRoot);
      const ignoreCase = args.ignoreCase === true;
      const literal = args.literal === true;
      const context = numberValue(args.context) ?? 0;
      const limit = numberValue(args.limit) ?? 100;
      const glob = stringValue(args.glob);
      const result = await sandboxCommandOutput(this.provider, sandbox.id, step.id, [
        "bash", "-c",
        `root="$1"; pattern="$2"; ignore="$3"; literal="$4"; glob="$5"; context="$6"; limit="$7"; filter="$8"; if ! command -v rg >/dev/null 2>&1; then echo "ripgrep (rg) is required for grep" >&2; exit 127; fi; if ! command -v node >/dev/null 2>&1; then echo "node is required for bounded grep output" >&2; exit 127; fi; set -- --json --line-number --color never --hidden -g "!.git/**" -g "!node_modules/**" -C "$context"; [ "$ignore" = 1 ] && set -- "$@" -i; [ "$literal" = 1 ] && set -- "$@" -F; [ -n "$glob" ] && set -- "$@" -g "$glob"; set -o pipefail; rg "$@" -- "$pattern" "$root" | node -e "$filter" "$root" "$limit" "${PI_TOOL_MAX_BYTES}" "${PI_GREP_MAX_LINE_LENGTH}"; status=$?; [ "$status" -eq 0 ] || [ "$status" -eq 1 ] || [ "$status" -eq 141 ]`,
        "berry-grep",
        path,
        pattern,
        ignoreCase ? "1" : "0",
        literal ? "1" : "0",
        glob ?? "",
        String(context),
        String(limit),
        PI_GREP_FILTER_SCRIPT,
      ], workspaceRoot, signal, reportProgress);
      const meta = parsePiGrepMetadata(result.stderr);
      const notices = [
        ...(meta.limitReached ? [`${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern`] : []),
        ...(meta.byteLimitReached ? ["50.0KB limit reached"] : []),
        ...(meta.linesTruncated ? ["Some lines truncated to 500 chars. Use read tool to see full lines"] : []),
      ];
      const matches = meta.matchCount === 0
        ? "No matches found"
        : `${result.stdout}${notices.length > 0 ? `\n\n[${notices.join(". ")}]` : ""}`;
      return {
        output: { path, pattern, matches, matchCount: meta.matchCount, ...(notices.length > 0 ? { truncated: true } : {}), ...inputRepairDetails },
        summary: `Matched ${meta.matchCount} lines under ${path}`,
        sandbox,
      };
    }
    if (toolName === "create_image") {
      const capability = objectValue(snapshot.runtimeRequest.imageGeneration);
      const config = this.options.imageGeneration;
      if (!config || !stringValue(capability.model)) throw new Error("Image generation is not configured for this durable turn");
      const prompt = stringValue(args.prompt);
      if (!prompt) throw new Error("create_image requires a prompt");
      const references = Array.isArray(args.reference_image_paths)
        ? args.reference_image_paths.filter((value): value is string => typeof value === "string").slice(0, 16)
        : [];
      const referenceImageUrls: string[] = [];
      for (const reference of references) {
        const path = safeReadablePath(reference, workspaceRoot);
        const mediaType = binaryMediaType(path);
        if (!mediaType?.startsWith("image/")) throw new Error(`Reference is not a supported image: ${path}`);
        const readInput = { sandbox_id: sandbox.id, path, encoding: "base64" } as const;
        const source = await (signal
          ? this.provider.files.read(readInput, { signal })
          : this.provider.files.read(readInput));
        reportProgress?.();
        referenceImageUrls.push(`data:${mediaType};base64,${source.content}`);
      }
      const generated = await generateDurableImage(config, {
        prompt,
        model: stringValue(capability.model) ?? config.model,
        size: stringValue(args.size) ?? imageSizeForAspectRatio(stringValue(args.aspect_ratio)),
        transparentBackground: args.transparent_background === true,
        idempotencyKey: step.idempotencyKey ?? step.id,
        ...(referenceImageUrls.length > 0 ? { referenceImageUrls } : {}),
      });
      const first = generated.data[0];
      if (!first) throw new Error("The image provider returned no image");
      const bytes = first.b64_json
        ? Buffer.from(first.b64_json, "base64")
        : await downloadGeneratedImage(first.url);
      if (bytes.byteLength === 0) throw new Error("The image provider returned an empty image");
      const title = safeArtifactName(stringValue(args.title) ?? "Generated image").replace(/\.(png|jpe?g|webp)$/i, "");
      const path = `${workspaceRoot}/outputs/${title}.png`;
      await this.provider.files.write({ sandbox_id: sandbox.id, path, content: bytes.toString("base64"), encoding: "base64" });
      if (!this.objects) throw new Error("Artifact object storage is not configured");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const stored = await this.objects.putArtifact(
        `tenants/${snapshot.tenantId}/users/${snapshot.userId}/files/${step.id}/${sha256}/original/${title}.png`,
        bytes,
        "image/png",
      );
      const output = await this.repository.persistOutput({
        snapshot,
        fileId: step.id,
        name: `${title}.png`,
        mediaType: "image/png",
        sizeBytes: bytes.byteLength,
        sha256,
        bucket: stored.bucket,
        objectKey: stored.key,
        etag: stored.etag,
        ...(stored.objectVersionId !== undefined ? { objectVersionId: stored.objectVersionId } : {}),
        origin: "image_generation",
        sourcePath: path,
      });
      const dimensions = imageDimensions(stringValue(args.size) ?? imageSizeForAspectRatio(stringValue(args.aspect_ratio)));
      const image = {
        src: `/v1/files/${output.fileId}/content`,
        downloadUrl: `/v1/files/${output.fileId}/content`,
        fileId: output.fileId,
        title,
        prompt,
        ...(first.revised_prompt ? { revisedPrompt: first.revised_prompt } : {}),
        aspectRatio: stringValue(args.aspect_ratio) ?? "1:1",
        width: dimensions.width,
        height: dimensions.height,
        mimeType: "image/png",
        sizeBytes: output.sizeBytes,
        transparentBackground: args.transparent_background === true,
        generationId: step.id,
      };
      return {
        output: { text: `Generated ${title}.png`, image, visionPath: path, artifact: { kind: "file", path: image.src, fileId: output.fileId, name: output.name, mediaType: output.mediaType, size: output.sizeBytes } },
        summary: `Generated ${title}.png`,
        sandbox,
      };
    }
    if (toolName === "persist_artifact") {
      if (!this.objects) throw new Error("Artifact object storage is not configured");
      const path = safeOutputPath(stringValue(args.path) ?? "", workspaceRoot);
      const source = await this.provider.files.read({
        sandbox_id: sandbox.id,
        path,
        encoding: "base64",
      });
      const bytes = Buffer.from(source.content, "base64");
      const maxBytes = this.options.maxInputBytes ?? DEFAULT_SANDBOX_INPUT_MAX_BYTES;
      if (bytes.byteLength === 0) throw new Error("Cannot persist an empty artifact");
      if (bytes.byteLength > maxBytes) throw new Error(`Artifact exceeds the ${maxBytes}-byte output limit`);
      const name = safeArtifactName(stringValue(args.name) ?? path.split("/").at(-1) ?? "artifact");
      const mediaType = stringValue(args.media_type)
        ?? binaryMediaType(name)
        ?? "application/octet-stream";
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const stored = await this.objects.putArtifact(
        `tenants/${snapshot.tenantId}/users/${snapshot.userId}/files/${step.id}/${sha256}/original/${name}`,
        bytes,
        mediaType,
      );
      const output = await this.repository.persistOutput({
        snapshot,
        fileId: step.id,
        name,
        mediaType,
        sizeBytes: bytes.byteLength,
        sha256,
        bucket: stored.bucket,
        objectKey: stored.key,
        etag: stored.etag,
        ...(stored.objectVersionId !== undefined ? { objectVersionId: stored.objectVersionId } : {}),
        sourcePath: path,
      });
      return {
        output: {
          text: `Persisted artifact: ${name}`,
          artifact: {
            kind: "file",
            path: `/v1/files/${output.fileId}/content`,
            name: output.name,
            mediaType: output.mediaType,
            size: output.sizeBytes,
            storage: "s3",
            key: output.objectKey,
            fileId: output.fileId,
          },
          path: `/v1/files/${output.fileId}/content`,
        },
        summary: `Persisted ${name}`,
        sandbox,
      };
    }
    if (toolName === "bash") {
      const command = stringValue(args.command);
      if (!command) throw new Error("bash requires a command");
      const requestedTimeoutMs = numberValue(args.timeout) !== null
        ? Math.min(2_147_483_647, Math.ceil(numberValue(args.timeout)! * 1_000))
        : 0;
      const fullOutputPath = `${workspaceRoot}/.berry-tool-output/bash-${createHash("sha256").update(step.id).digest("hex").slice(0, 16)}.log`;
      const output = new PiTailCollector();
      let exitCode: number | null = null;
      for await (const event of this.provider.exec({
        sandbox_id: sandbox.id,
        request_id: step.idempotencyKey ?? step.id,
        command: [
          "bash",
          "-c",
          PI_BASH_WRAPPER_SCRIPT,
          "berry-bash",
          command,
          fullOutputPath,
        ],
        cwd: workspaceRoot,
        timeout_ms: requestedTimeoutMs,
      }, { signal })) {
        reportProgress?.();
        if (event.kind === "stdout" || event.kind === "stderr") output.append(event.data);
        else if (event.kind === "exit") exitCode = event.exit_code;
        else if (event.kind === "error") throw new Error(event.message);
      }
      const truncated = output.result();
      let text = truncated.content || "(no output)";
      if (truncated.truncated) {
        const startLine = truncated.totalLines - truncated.outputLines + 1;
        text += truncated.truncatedBy === "lines"
          ? `\n\n[Showing lines ${startLine}-${truncated.totalLines} of ${truncated.totalLines}. Full output: ${fullOutputPath}]`
          : `\n\n[Showing lines ${startLine}-${truncated.totalLines} of ${truncated.totalLines} (50.0KB limit). Full output: ${fullOutputPath}]`;
      }
      if (exitCode !== 0) throw new Error(`${text}\n\nCommand exited with code ${exitCode ?? "unknown"}`);
      return {
        output: { command, exitCode, output: text, ...(truncated.truncated ? { fullOutputPath, truncated: true } : {}), ...inputRepairDetails },
        summary: `Command completed with exit code ${exitCode ?? 0}`,
        sandbox,
      };
    }
    throw new Error(`Unsupported durable tool: ${toolName}`);
  }

  async finalize(snapshot: DurableTurnSnapshot): Promise<readonly TurnToolResult[]> {
    if (!snapshot.sandboxId || !this.objects) return [];
    const sandbox = await this.ensureSandbox(snapshot);
    return this.finalizeSandboxOutputs(snapshot, sandbox);
  }

  private async finalizeSandboxOutputs(
    snapshot: DurableTurnSnapshot,
    sandbox: { provider: string; id: string; state: string },
  ): Promise<readonly TurnToolResult[]> {
    const objects = this.objects;
    if (!objects) return [];
    const workspaceRoot = safeWorkspaceRoot(this.options.cwd ?? "/workspace");
    let listed: Awaited<ReturnType<SandboxProvider["files"]["list"]>>;
    try {
      listed = await this.provider.files.list({
        sandbox_id: sandbox.id,
        path: `${workspaceRoot}/outputs`,
        recursive: true,
      });
    } catch (error) {
      // The outputs directory is optional. E2B reports an absent directory as
      // FileNotFoundError, while local providers generally surface ENOENT.
      // Both mean there is simply nothing to publish; availability and other
      // listing failures must still fail finalization visibly.
      if (isMissingSandboxPath(error)) return [];
      throw error;
    }
    const explicitlyPersisted = new Set(snapshot.steps.flatMap((step) => {
      if (step.state !== "completed") return [];
      const name = stringValue(step.input.toolName) ?? step.type.slice(5);
      if (name !== "persist_artifact" && name !== "create_image") return [];
      const path = name === "persist_artifact"
        ? stringValue(objectValue(step.input.arguments).path)
        : stringValue(objectValue(step.output).visionPath);
      return path ? [safeOutputPath(path, workspaceRoot)] : [];
    }));
    const previouslyPublished = new Set<string>();
    for (const output of await this.repository.publishedOutputs?.(snapshot.tenantId, snapshot.sessionId) ?? []) {
      try {
        previouslyPublished.add(`${safeOutputPath(output.sourcePath, workspaceRoot)}\0${output.sha256}`);
      } catch {
        // Ignore malformed legacy metadata. The live sandbox path still goes
        // through safeOutputPath below before it can be read or published.
      }
    }
    const results: TurnToolResult[] = [];
    for (const entry of listed.entries) {
      if (entry.type !== "file" || explicitlyPersisted.has(entry.path) || !isDurableArtifact(entry.path)) continue;
      const path = safeOutputPath(entry.path, workspaceRoot);
      const source = await this.provider.files.read({ sandbox_id: sandbox.id, path, encoding: "base64" });
      const bytes = Buffer.from(source.content, "base64");
      if (bytes.byteLength === 0) continue;
      const name = safeArtifactName(path.split("/").at(-1) ?? "artifact");
      const mediaType = durableArtifactMediaType(name);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (previouslyPublished.has(`${path}\0${sha256}`)) continue;
      const relativeKey = path.slice(`${workspaceRoot}/`.length);
      const relativeKeyFingerprint = createHash("sha256").update(relativeKey).digest("hex");
      const operationKey = `${snapshot.id}:artifact:${relativeKeyFingerprint}`;
      const fileId = stableArtifactUuid(`${snapshot.id}:${path}:${sha256}`);
      await this.repository.recordArtifactOperationStart?.({
        tenantId: snapshot.tenantId,
        runId: snapshot.id,
        operationKey,
        relativeKeyFingerprint,
        sourcePath: path,
      });
      try {
        const stored = await objects.putArtifact(
          `tenants/${snapshot.tenantId}/users/${snapshot.userId}/files/auto/${fileId}/${sha256}/${name}`,
          bytes,
          mediaType,
        );
        await this.repository.recordArtifactOperationStorage?.({
          tenantId: snapshot.tenantId,
          runId: snapshot.id,
          operationKey,
          storageReceipt: {
            bucket: stored.bucket,
            key: stored.key,
            etag: stored.etag,
            ...(stored.objectVersionId !== undefined ? { objectVersionId: stored.objectVersionId } : {}),
          },
        });
        const output = await this.repository.persistOutput({
          snapshot, fileId, name, mediaType, sizeBytes: bytes.byteLength, sha256,
          bucket: stored.bucket, objectKey: stored.key, etag: stored.etag,
          ...(stored.objectVersionId !== undefined ? { objectVersionId: stored.objectVersionId } : {}),
          sourcePath: path,
        });
        await this.repository.completeArtifactOperation?.({
          tenantId: snapshot.tenantId,
          runId: snapshot.id,
          operationKey,
          fileId: output.fileId,
        });
        results.push({
          output: { text: `Published artifact: ${name}`, artifact: { kind: "file", path: `/v1/files/${output.fileId}/content`, name, mediaType, size: bytes.byteLength, fileId: output.fileId } },
          summary: `Published ${name}`,
          sandbox,
        });
      } catch (error) {
        await this.repository.failArtifactOperation?.({
          tenantId: snapshot.tenantId,
          runId: snapshot.id,
          operationKey,
          errorClass: error instanceof Error ? error.name : "artifact_operation_error",
        });
        throw error;
      }
    }
    return results;
  }

  private async finalizeTerminalRun(run: SnapshotRun): Promise<{ noOp: boolean; completedCount?: number }> {
    if (!run.sandboxId || !this.objects || !run.userId) return { noOp: true };
    const owner = `terminal-finalizer:${process.pid}:${run.runId}`;
    const lease = await this.repository.beginFinalization?.({
      tenantId: run.tenantId,
      runId: run.runId,
      owner,
    });
    if (this.repository.beginFinalization && !lease) return { noOp: true };
    const snapshot = terminalFinalizationSnapshot(run);
    try {
      const results = await this.finalizeSandboxOutputs(snapshot, {
        provider: run.sandboxProvider ?? this.provider.kind,
        id: run.sandboxId,
        state: run.sandboxState ?? "running",
      });
      await this.repository.finishFinalization?.({
        tenantId: run.tenantId,
        runId: run.runId,
        sessionId: run.sessionId,
        owner,
        operationKey: `${run.runId}:finalization`,
        status: "complete",
        itemCount: results.length,
        completedCount: results.length,
        failedCount: 0,
        manifest: results.map((result) => result.output) as JsonValue,
      });
      return { noOp: false, completedCount: results.length };
    } catch (error) {
      await this.repository.failFinalization?.({
        tenantId: run.tenantId,
        runId: run.runId,
        sessionId: run.sessionId,
        owner,
        operationKey: `${run.runId}:finalization`,
        errorClass: error instanceof Error ? error.name : "finalization_error",
      });
      throw error;
    }
  }

  async snapshot(payload: SandboxSnapshotJobPayload): Promise<{ noOp: boolean; snapshotId?: string }> {
    const candidate = await this.repository.loadRun(payload.tenantId, payload.runId);
    if (!candidate.sandboxId) {
      if (
        payload.reason === "before-finalize"
        && this.options.enableTerminalFinalization
        && TERMINAL_RUN_STATES.has(candidate.runState)
      ) {
        await this.skipTerminalFinalization(candidate, "sandbox_unavailable");
      }
      return { noOp: true };
    }
    const preserveWithLock = async (repository: SandboxSnapshotRepository) => {
      const run = await repository.loadRun(payload.tenantId, payload.runId);
      if (!run.sandboxId || run.sandboxId !== candidate.sandboxId) return { noOp: true };
      const terminal = payload.reason === "before-finalize";
      const beforeWait = payload.reason === "before-wait";
      const terminalSkipReason = terminal && TERMINAL_RUN_STATES.has(run.runState)
        ? run.sandboxClaimedByNewerRun === true
          ? "sandbox_claimed_by_newer_run"
          : run.sandboxState && INACTIVE_SANDBOX_STATES.has(run.sandboxState)
            ? `sandbox_${run.sandboxState}`
            : null
        : null;
      if (terminalSkipReason) {
        if (this.options.enableTerminalFinalization) {
          await this.skipTerminalFinalization(run, terminalSkipReason, repository);
        }
        return { noOp: true };
      }
      if (
        (run.sandboxState && INACTIVE_SANDBOX_STATES.has(run.sandboxState))
        || (run.sandboxState === "pause_requested" && !terminal)
        || (TERMINAL_RUN_STATES.has(run.runState) && !terminal)
        || (terminal && !TERMINAL_RUN_STATES.has(run.runState))
        || (beforeWait && run.runState !== "waiting")
        || (terminal && run.sandboxClaimedByNewerRun === true)
      ) {
        return { noOp: true };
      }

      let preservationCompleted = false;
      const snapshotTimeoutMs = terminal || beforeWait
        ? this.options.terminalSnapshotTimeoutMs ?? DEFAULT_TERMINAL_SNAPSHOT_TIMEOUT_MS
        : this.options.intervalSnapshotTimeoutMs ?? DEFAULT_INTERVAL_SNAPSHOT_TIMEOUT_MS;
      const preserve = async () => {
        if (terminal && this.options.enableTerminalFinalization) await this.finalizeTerminalRun(run);
        const archive = await this.capture(run.sandboxId!, Date.now() + snapshotTimeoutMs);
        const current = await repository.loadRun(payload.tenantId, payload.runId);
        if (!current.sandboxId || current.sandboxId !== run.sandboxId) {
          return { noOp: true };
        }
        if (payload.reason === "interval" && TERMINAL_RUN_STATES.has(current.runState)) {
          return { noOp: true };
        }
        const bytes = Buffer.from(JSON.stringify(archive));
        const contentHash = createHash("sha256")
          .update(JSON.stringify({ version: archive.version, files: archive.files }))
          .digest("hex");
        const prior = await repository.latest(payload.tenantId, payload.runId);
        if (prior?.contentHash === contentHash) {
          preservationCompleted = true;
          return { noOp: true, snapshotId: prior.id };
        }
        if (!this.objects) throw new Error("Sandbox snapshot object storage is not configured");
        const key = `sandbox-snapshots/${payload.tenantId}/${payload.runId}/${contentHash}.json`;
        await this.objects.put(key, bytes);
        const record = await repository.persist({
          run: current,
          provider: current.sandboxProvider ?? this.provider.kind,
          sandboxId: current.sandboxId!,
          objectKey: key,
          contentHash,
        });
        preservationCompleted = true;
        return { noOp: false, snapshotId: record.id };
      };
      let observedPaused = false;
      try {
        return await withTimeout(
          preserve(),
          snapshotTimeoutMs,
          `${terminal ? "Terminal" : beforeWait ? "Waiting" : "Interval"} sandbox snapshot`,
        );
      } catch (error) {
        if (!isSandboxPausedError(error)) throw error;
        observedPaused = true;
        await repository.recordSandbox({
          tenantId: payload.tenantId,
          runId: payload.runId,
          provider: run.sandboxProvider ?? this.provider.kind,
          sandboxId: run.sandboxId,
          state: "paused",
        });
        return { noOp: true };
      } finally {
        if ((terminal || beforeWait) && !observedPaused) {
          const canPause = Boolean(this.provider.suspend) && this.provider.supportsPause !== false;
          if (canPause || terminal || preservationCompleted) {
            const stop = canPause
              ? this.provider.suspend!.bind(this.provider)
              : this.provider.destroy.bind(this.provider);
            const lifecycle = terminal ? "Terminal turn" : "Waiting turn";
            const result = await withTimeout(
              stop({
                sandbox_id: run.sandboxId,
                reason: canPause
                  ? `${lifecycle} snapshot completed`
                  : `${lifecycle} sandbox cleanup completed`,
              }),
              this.options.terminalSuspendTimeoutMs ?? DEFAULT_TERMINAL_SUSPEND_TIMEOUT_MS,
              `${lifecycle} sandbox ${canPause ? "pause" : "stop"}`,
            );
            await repository.recordSandbox({
              tenantId: payload.tenantId,
              runId: payload.runId,
              provider: run.sandboxProvider ?? this.provider.kind,
              sandboxId: run.sandboxId,
              state: result.status === "missing" ? "missing" : canPause ? "paused" : "stopped",
            });
          }
        }
      }
    };
    if (payload.reason === "interval" && this.repository.tryWithSandboxLifecycleLock) {
      return await this.repository.tryWithSandboxLifecycleLock(
        payload.tenantId,
        candidate.sandboxId,
        preserveWithLock,
      ) ?? { noOp: true };
    }
    return this.withSandboxLifecycleLock(payload.tenantId, candidate.sandboxId, preserveWithLock);
  }

  private async skipTerminalFinalization(
    run: SnapshotRun,
    reason: string,
    repository: SandboxSnapshotRepository = this.repository,
  ): Promise<void> {
    await repository.skipFinalization?.({
      tenantId: run.tenantId,
      runId: run.runId,
      sessionId: run.sessionId,
      operationKey: `${run.runId}:finalization`,
      reason,
    });
  }

  private async ensureSandbox(
    snapshot: DurableTurnSnapshot,
    signal?: AbortSignal,
  ): Promise<{ provider: string; id: string; state: string }> {
    const key = `${snapshot.tenantId}:${snapshot.id}`;
    const existing = this.#sandboxStarts.get(key);
    if (existing) return existing;
    const started = this.ensureSandboxUncached(snapshot, signal).finally(() => {
      if (this.#sandboxStarts.get(key) === started) this.#sandboxStarts.delete(key);
    });
    this.#sandboxStarts.set(key, started);
    return started;
  }

  private async ensureSandboxUncached(
    snapshot: DurableTurnSnapshot,
    signal?: AbortSignal,
  ): Promise<{ provider: string; id: string; state: string }> {
    signal?.throwIfAborted();
    if (snapshot.sandboxId) {
      try {
        return await this.withSandboxLifecycleLock(snapshot.tenantId, snapshot.sandboxId, async (repository) => {
          if (this.provider.supportsResume !== false) {
            const resumeInput = {
              sandbox_id: snapshot.sandboxId!,
              reason: "Durable turn requested sandbox access",
            } as const;
            if (signal) await this.provider.resume?.(resumeInput, { signal });
            else await this.provider.resume?.(resumeInput);
          }
          if (this.provider.kind !== "e2b") {
            // Local/Router providers retain the cheap liveness probe. E2B's
            // first real operation is already a health check; its redundant
            // data-plane list request added tens of seconds to cold reconnects.
            await this.provider.files.list({
              sandbox_id: snapshot.sandboxId!,
              path: this.options.cwd ?? "/workspace",
              recursive: false,
            }, { signal });
          }
          // The in-memory staged-file set is intentionally process-local. On
          // worker restart or lease handoff, re-stage the run's durable input
          // associations before a tool is allowed to execute.
          await this.stageInputFiles(snapshot, snapshot.sandboxId!, repository, undefined, signal);
          await repository.recordSandbox({
            tenantId: snapshot.tenantId,
            runId: snapshot.id,
            provider: snapshot.sandboxProvider ?? this.provider.kind,
            sandboxId: snapshot.sandboxId!,
            state: "running",
          });
          return { provider: snapshot.sandboxProvider ?? this.provider.kind, id: snapshot.sandboxId!, state: "running" };
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        // Restore from the newest complete archive below.
      }
    }
    const latest = await this.repository.latest(snapshot.tenantId, snapshot.id);
    const continuity = await this.repository.continuity(snapshot.tenantId, snapshot.id);
    if (
      continuity?.sandboxId
      && (!continuity.provider || continuity.provider === this.provider.kind)
    ) {
      try {
        return await this.withSandboxLifecycleLock(snapshot.tenantId, continuity.sandboxId, async (repository) => {
          await repository.recordSandbox({
            tenantId: snapshot.tenantId,
            runId: snapshot.id,
            provider: continuity.provider ?? this.provider.kind,
            sandboxId: continuity.sandboxId!,
            state: "resume_requested",
          });
          if (this.provider.supportsResume !== false) {
            const resumeInput = {
              sandbox_id: continuity.sandboxId!,
              reason: "Follow-up turn requested the prior sandbox",
            } as const;
            if (signal) await this.provider.resume?.(resumeInput, { signal });
            else await this.provider.resume?.(resumeInput);
          }
          if (this.provider.kind !== "e2b") {
            await this.provider.files.list({
              sandbox_id: continuity.sandboxId!,
              path: this.options.cwd ?? "/workspace",
              recursive: false,
            }, { signal });
          }
          await this.stageInputFiles(snapshot, continuity.sandboxId!, repository, undefined, signal);
          await repository.recordSandbox({
            tenantId: snapshot.tenantId,
            runId: snapshot.id,
            provider: continuity.provider ?? this.provider.kind,
            sandboxId: continuity.sandboxId!,
            state: "running",
          });
          return {
            provider: continuity.provider ?? this.provider.kind,
            id: continuity.sandboxId!,
            state: "running",
          };
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        // The previous turn's sandbox expired. Restore its durable archive below.
      }
    }
    const createInput: SandboxCreateInput = {
      request_id: snapshot.id,
      tenant_id: snapshot.tenantId,
      task_id: snapshot.taskId,
      session_id: snapshot.sessionId,
      image: stringValue(snapshot.runtimeRequest.sandboxImage) ?? this.options.image,
      cwd: this.options.cwd ?? "/workspace",
      ttl_seconds: this.options.ttlSeconds ?? 300,
      network_policy: networkPolicy(snapshot.runtimeRequest.networkPolicy),
      writable_roots: [this.options.cwd ?? "/workspace"],
      metadata: { runId: snapshot.id },
    };
    let handle: SandboxHandle;
    try {
      handle = await this.provider.create(createInput, { signal });
    } catch (error) {
      // A provider may have created remote compute before an abort reached its
      // SDK promise. Recover only an explicit metadata match, persist its id,
      // and leave the existing terminal cleanup/recovery machinery responsible
      // for pausing it. Never guess an id or destroy an unowned sandbox here.
      const recovered = this.provider.recoverCreate
        ? await this.provider.recoverCreate(createInput).catch(() => null)
        : null;
      if (recovered) {
        await this.repository.recordSandbox({
          tenantId: snapshot.tenantId,
          runId: snapshot.id,
          provider: recovered.provider,
          sandboxId: recovered.sandbox_id,
          state: recovered.status,
        }).catch(() => undefined);
      }
      throw error;
    }
    const restorePoint = latest ?? continuity?.snapshot ?? null;
    const workspaceRoot = safeWorkspaceRoot(this.options.cwd ?? "/workspace");
    if (restorePoint && this.objects) {
      const archive = JSON.parse(Buffer.from(await this.objects.get(restorePoint.objectKey)).toString("utf8")) as SnapshotArchive;
      for (const file of archive.files) {
        await this.provider.files.write({
          sandbox_id: handle.sandbox_id,
          path: safeWorkspacePath(file.path, workspaceRoot),
          content: file.content,
          encoding: "base64",
          ...(file.mode !== undefined ? { mode: file.mode } : {}),
        }, { signal });
      }
    }
    await this.stageInputFiles(snapshot, handle.sandbox_id, this.repository, undefined, signal);
    await this.repository.recordSandbox({
      tenantId: snapshot.tenantId,
      runId: snapshot.id,
      provider: handle.provider,
      sandboxId: handle.sandbox_id,
      state: handle.status,
    });
    return { provider: handle.provider, id: handle.sandbox_id, state: handle.status };
  }

  private withSandboxLifecycleLock<T>(
    tenantId: string,
    sandboxId: string,
    operation: (repository: SandboxSnapshotRepository) => Promise<T>,
  ): Promise<T> {
    return this.repository.withSandboxLifecycleLock
      ? this.repository.withSandboxLifecycleLock(tenantId, sandboxId, operation)
      : operation(this.repository);
  }

  private async stageInputFiles(
    snapshot: DurableTurnSnapshot,
    sandboxId: string,
    repository: SandboxSnapshotRepository = this.repository,
    selectedFileIds?: ReadonlySet<string>,
    signal?: AbortSignal,
    reportProgress?: () => void,
  ): Promise<void> {
    signal?.throwIfAborted();
    const staged = this.#stagedInputFileIds.get(sandboxId) ?? new Set<string>();
    this.#stagedInputFileIds.set(sandboxId, staged);
    const files = (await repository.inputFiles(snapshot.tenantId, snapshot.id))
      .filter((file) => (!selectedFileIds || selectedFileIds.has(file.fileId)) && !staged.has(file.fileId));
    signal?.throwIfAborted();
    if (files.length === 0) return;
    if (!this.objects) throw new Error("Input file object storage is not configured");
    for (const file of files) {
      const maxInputBytes = this.options.maxInputBytes ?? DEFAULT_SANDBOX_INPUT_MAX_BYTES;
      if (file.sizeBytes > maxInputBytes) throw new Error(`Input file ${file.name} exceeds the sandbox input limit`);
      const workspaceRoot = safeWorkspaceRoot(this.options.cwd ?? "/workspace");
      const path = durableAttachmentPath({ fileId: file.fileId, name: file.name }, workspaceRoot);
      await this.prepareSandboxDirectory(snapshot.id, sandboxId, path, file.name, workspaceRoot, signal);
      await this.truncateSandboxFile(snapshot.id, sandboxId, path, file.name, signal);
      const source = this.objects.streamSource
        ? this.objects.streamSource(file.objectKey, maxInputBytes, file.objectVersionId)
        : singleChunk(await this.objects.getSource(file.objectKey, file.objectVersionId));
      signal?.throwIfAborted();
      let written = 0;
      for await (const sourceChunk of source) {
        for (let offset = 0; offset < sourceChunk.byteLength; offset += 256 * 1024) {
          const chunk = sourceChunk.subarray(offset, Math.min(sourceChunk.byteLength, offset + 256 * 1024));
          written += chunk.byteLength;
          if (written > maxInputBytes || written > file.sizeBytes) {
            throw new Error(`Input file ${file.name} exceeds its validated size`);
          }
          signal?.throwIfAborted();
          await this.appendSandboxChunk(snapshot.id, sandboxId, path, file.name, chunk, written, signal);
        }
      }
      if (written !== file.sizeBytes) throw new Error(`Input file ${file.name} is incomplete`);
      staged.add(file.fileId);
      reportProgress?.();
    }
  }

  private async truncateSandboxFile(
    runId: string,
    sandboxId: string,
    path: string,
    name: string,
    signal?: AbortSignal,
  ): Promise<void> {
    for await (const event of this.provider.exec({
      sandbox_id: sandboxId,
      request_id: `${runId}:stage:truncate:${createHash("sha256").update(path).digest("hex").slice(0, 16)}`,
      command: ["sh", "-c", ': > "$1"', "berry-stage", path],
      timeout_ms: 30_000,
    }, { signal })) {
      if (event.kind === "error") throw new Error(event.message);
      if (event.kind === "exit" && event.exit_code !== 0) {
        throw new Error(`Unable to initialize the sandbox file for ${name}`);
      }
    }
  }

  private async prepareSandboxDirectory(
    runId: string,
    sandboxId: string,
    path: string,
    name: string,
    cwd?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const directoryOutput: string[] = [];
    for await (const event of this.provider.exec({
      sandbox_id: sandboxId,
      request_id: `${runId}:stage:mkdir:${createHash("sha256").update(path).digest("hex").slice(0, 16)}`,
      command: ["mkdir", "-p", path.slice(0, path.lastIndexOf("/"))],
      ...(cwd ? { cwd } : {}),
      timeout_ms: 30_000,
    }, { signal })) {
      if (event.kind === "stdout" || event.kind === "stderr") directoryOutput.push(event.data);
      if (event.kind === "error") throw new Error(event.message);
      if (event.kind === "exit" && event.exit_code !== 0) {
        const detail = directoryOutput.join("").trim().slice(-2_000);
        throw new Error(`Unable to prepare the sandbox directory for ${name}${detail ? `: ${detail}` : ""}`);
      }
    }
  }

  private async setSandboxFileMode(
    runId: string,
    sandboxId: string,
    path: string,
    name: string,
    mode: number,
    signal?: AbortSignal,
  ): Promise<void> {
    for await (const event of this.provider.exec({
      sandbox_id: sandboxId,
      request_id: `${runId}:stage:chmod:${createHash("sha256").update(path).digest("hex").slice(0, 16)}`,
      command: ["chmod", mode.toString(8), "--", path],
      timeout_ms: 30_000,
    }, { signal })) {
      if (event.kind === "error") throw new Error(event.message);
      if (event.kind === "exit" && event.exit_code !== 0) throw new Error(`Unable to set permissions for ${name}`);
    }
  }

  private async appendSandboxChunk(
    runId: string,
    sandboxId: string,
    path: string,
    name: string,
    chunk: Uint8Array,
    written: number,
    signal?: AbortSignal,
  ): Promise<void> {
    for await (const event of this.provider.exec({
      sandbox_id: sandboxId,
      request_id: `${runId}:stage:append:${createHash("sha256").update(path).digest("hex").slice(0, 12)}:${written}`,
      command: [
        "sh",
        "-c",
        'base64 -d >> "$1"',
        "berry-stage",
        path,
      ],
      // Keep attachment bytes out of argv. A 256 KiB chunk expands beyond
      // Linux's per-argument limit when base64 encoded, which prevented E2B
      // from starting the staging process at all.
      stdin: Buffer.from(chunk).toString("base64"),
      timeout_ms: 30_000,
    }, { signal })) {
      if (event.kind === "error") throw new Error(event.message);
      if (event.kind === "exit" && event.exit_code !== 0) {
        throw new Error(`Unable to stream ${name} into the sandbox`);
      }
    }
  }

  private async capture(sandboxId: string, deadlineAt: number): Promise<SnapshotArchive> {
    const root = this.options.cwd ?? "/workspace";
    const list = await this.provider.files.list({ sandbox_id: sandboxId, path: root, recursive: true });
    const candidates = list.entries.filter((entry) =>
      entry.type === "file"
      && !excludedSnapshotPath(entry.path, root)
      && entry.size_bytes <= 25 * 1024 * 1024
    );
    if (candidates.length > MAX_SNAPSHOT_FILES) {
      throw new Error(`Sandbox snapshot exceeds the ${MAX_SNAPSHOT_FILES.toLocaleString("en-US")} file safety limit`);
    }
    const candidateBytes = candidates.reduce((total, entry) => total + entry.size_bytes, 0);
    if (candidateBytes > MAX_SNAPSHOT_BYTES) {
      throw new Error("Sandbox snapshot exceeds the 250 MB safety limit");
    }
    const files: SnapshotArchive["files"] = [];
    for (const entry of candidates) {
      if (Date.now() >= deadlineAt) throw new Error("Sandbox snapshot exceeded its time limit");
      const file = await this.provider.files.read({
        sandbox_id: sandboxId,
        path: entry.path,
        encoding: "base64",
      });
      files.push({ path: entry.path, content: file.content, encoding: "base64" });
    }
    files.sort((left, right) => left.path.localeCompare(right.path));
    return { version: 1, createdAt: new Date().toISOString(), files };
  }
}

function requestedInspectionImagePaths(snapshot: DurableTurnSnapshot, workspaceRoot = "/workspace"): string[] | null {
  const step = [...snapshot.steps].reverse().find((candidate) => {
    const toolName = stringValue(candidate.input.toolName) ?? candidate.type.slice(5);
    return candidate.state === "running" && toolName === "inspect_images";
  });
  const args = objectValue(step?.input.arguments);
  if (!Array.isArray(args?.paths)) return null;
  const paths = args.paths.flatMap((path) => typeof path === "string" && path.trim() ? [safeReadablePath(path, workspaceRoot)] : []);
  if (paths.length === 0 || paths.length > MAX_MODEL_IMAGES) {
    throw new Error(`inspect_images paths must contain between 1 and ${MAX_MODEL_IMAGES} image paths`);
  }
  return [...new Set(paths)];
}

function exposedSandboxImagePaths(snapshot: DurableTurnSnapshot, workspaceRoot = "/workspace"): string[] {
  const paths = snapshot.steps.flatMap((step) => {
    if (step.state !== "completed") return [];
    const toolName = stringValue(step.input.toolName) ?? step.type.slice(5);
    if (toolName !== "read" && toolName !== "create_image") return [];
    const output = objectValue(step.output);
    const path = stringValue(output.visionPath);
    if (!path) return [];
    return binaryMediaType(path)?.startsWith("image/") ? [path] : [];
  });
  return [...new Set(paths)].slice(-MAX_MODEL_IMAGES);
}

function sandboxAttachmentId(path: string, workspaceRoot = "/workspace"): string | null {
  const prefix = `${safeWorkspaceRoot(workspaceRoot)}/inputs/`;
  if (!path.startsWith(prefix)) return null;
  const fileId = path.slice(prefix.length).split("/", 1)[0]?.trim();
  return fileId || null;
}

export class SqlSandboxSnapshotRepository implements SandboxSnapshotRepository {
  constructor(private readonly executor: SqlExecutor) {}

  async loadRun(tenantId: string, runId: string): Promise<SnapshotRun> {
    const rows = await this.executor.query<SnapshotRunRow>(
      `
SELECT r.tenant_id,r.user_id,r.workspace_id,r.id AS run_id,r.session_id,r.task_id,r.state AS run_state,
       r.sandbox_provider,r.sandbox_id,r.sandbox_state,
       EXISTS (
         SELECT 1
         FROM turn_runs newer
         WHERE newer.tenant_id=r.tenant_id
           AND newer.session_id=r.session_id
           AND newer.sandbox_id=r.sandbox_id
           AND (
             newer.created_at>r.created_at
             OR (newer.created_at=r.created_at AND newer.id>r.id)
           )
       ) AS sandbox_claimed_by_newer_run,
       (SELECT entry_id FROM session_entries e
        WHERE e.tenant_id=r.tenant_id AND e.session_id=r.session_id AND e.is_leaf_marker=true
        ORDER BY e.sequence DESC LIMIT 1) AS session_leaf_id
FROM turn_runs r
WHERE r.tenant_id=$1::uuid AND r.id=$2::uuid
      `.trim(),
      [tenantId, runId],
    );
    const row = rows[0];
    if (!row) throw new Error("Turn run not found");
    return {
      tenantId: row.tenant_id,
      userId: row.user_id,
      workspaceId: row.workspace_id,
      runId: row.run_id,
      sessionId: row.session_id,
      taskId: row.task_id,
      sandboxProvider: row.sandbox_provider,
      sandboxId: row.sandbox_id,
      sandboxState: row.sandbox_state,
      runState: row.run_state,
      sandboxClaimedByNewerRun: row.sandbox_claimed_by_newer_run,
      sessionLeafId: row.session_leaf_id,
    };
  }

  async continuity(tenantId: string, runId: string): Promise<SessionContinuityRecord | null> {
    const rows = await this.executor.query<SessionContinuityRow>(
      `
WITH RECURSIVE current_run AS (
  SELECT tenant_id,id,session_id,request_message_id,created_at
  FROM turn_runs
  WHERE tenant_id=$1::uuid AND id=$2::uuid
), target_branch AS (
  SELECT entry.tenant_id,entry.session_id,entry.entry_id,entry.parent_entry_id,entry.run_id
  FROM current_run current_run_row
  JOIN session_entries entry
    ON entry.tenant_id=current_run_row.tenant_id
   AND entry.session_id=current_run_row.session_id
   AND entry.entry_id=current_run_row.request_message_id::text
  UNION ALL
  SELECT parent.tenant_id,parent.session_id,parent.entry_id,parent.parent_entry_id,parent.run_id
  FROM session_entries parent
  JOIN target_branch child
    ON child.tenant_id=parent.tenant_id
   AND child.session_id=parent.session_id
   AND child.parent_entry_id=parent.entry_id
)
SELECT prior.sandbox_provider,prior.sandbox_id,
       prior.created_at AS prior_created_at,
       prior.branch_compatible AS prior_branch_compatible,
       archived.id AS snapshot_id,archived.object_key,archived.content_hash,archived.sequence,
       archived.created_at AS snapshot_created_at,
       archived.session_leaf_id AS snapshot_session_leaf_id,
       archived.branch_compatible AS snapshot_branch_compatible,
       current_run_row.created_at AS target_created_at
FROM current_run current_run_row
LEFT JOIN LATERAL (
  SELECT r.sandbox_provider,r.sandbox_id,r.created_at,
         EXISTS (
           SELECT 1 FROM target_branch branch_entry
           WHERE branch_entry.run_id=r.id
         ) AS branch_compatible
  FROM turn_runs r
  WHERE r.tenant_id=current_run_row.tenant_id
    AND r.session_id=current_run_row.session_id
    AND r.id<>current_run_row.id
    AND r.created_at<current_run_row.created_at
    AND r.sandbox_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM target_branch branch_entry
      WHERE branch_entry.run_id=r.id
    )
  ORDER BY r.created_at DESC,r.id DESC
  LIMIT 1
) prior ON true
LEFT JOIN LATERAL (
  SELECT s.id,s.object_key,s.content_hash,s.sequence,s.created_at,s.session_leaf_id,
         EXISTS (
           SELECT 1 FROM target_branch branch_entry
           WHERE branch_entry.entry_id=s.session_leaf_id
         ) AS branch_compatible
  FROM sandbox_snapshots s
  WHERE s.tenant_id=current_run_row.tenant_id
    AND s.session_id=current_run_row.session_id
    AND s.status='complete'
    AND s.created_at<current_run_row.created_at
    AND s.session_leaf_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM target_branch branch_entry
      WHERE branch_entry.entry_id=s.session_leaf_id
    )
  ORDER BY s.completed_at DESC NULLS LAST,s.sequence DESC
  LIMIT 1
) archived ON true
      `.trim(),
      [tenantId, runId],
    );
    const row = rows[0];
    if (!row || (!row.sandbox_id && !row.snapshot_id)) return null;
    const compatibleSandbox = row.sandbox_id
      && row.prior_branch_compatible === true
      && isTimestampStrictlyBefore(row.prior_created_at, row.target_created_at);
    const compatibleSnapshot = row.snapshot_id
      && row.object_key
      && row.content_hash
      && row.sequence !== null
      && row.snapshot_session_leaf_id
      && row.snapshot_branch_compatible === true
      && isTimestampStrictlyBefore(row.snapshot_created_at, row.target_created_at);
    if (!compatibleSandbox && !compatibleSnapshot) return null;
    return {
      provider: compatibleSandbox ? row.sandbox_provider : null,
      sandboxId: compatibleSandbox ? row.sandbox_id : null,
      snapshot: compatibleSnapshot
        ? mapSnapshot({
          id: row.snapshot_id!,
          object_key: row.object_key!,
          content_hash: row.content_hash!,
          sequence: row.sequence!,
        })
        : null,
    };
  }

  async inputFiles(tenantId: string, runId: string, scope: "turn" | "session" = "session"): Promise<readonly SandboxInputFile[]> {
    const rows = await this.executor.query<SandboxInputFileRow>(
      `
SELECT DISTINCT f.id AS file_id,f.display_name,f.media_type,
  CASE WHEN f.blob_id IS NOT NULL THEN blob.size_bytes ELSE f.size_bytes END AS size_bytes,
  CASE WHEN f.blob_id IS NOT NULL THEN blob.object_key ELSE f.object_key END AS object_key,
  CASE WHEN f.blob_id IS NOT NULL THEN blob.object_version_id ELSE f.object_version_id END AS object_version_id
FROM turn_runs r
JOIN file_associations a
  ON a.tenant_id=r.tenant_id AND a.session_id=r.session_id AND a.role='input'
  AND ($3::text='session' OR a.message_id=r.request_message_id OR a.turn_id=r.id::text)
JOIN files f
  ON f.tenant_id=a.tenant_id AND f.id=a.file_id
LEFT JOIN file_blobs blob
  ON blob.tenant_id=f.tenant_id AND blob.id=f.blob_id
WHERE r.tenant_id=$1::uuid AND r.id=$2::uuid
  AND (a.created_at<=r.created_at OR a.turn_id=r.id::text OR f.origin='connector_import')
  AND f.status IN ('processing', 'available')
  AND f.deleted_at IS NULL
  AND (
    f.blob_id IS NULL
    OR (blob.verification_status='verified' AND blob.deleted_at IS NULL)
  )
  AND (
    EXISTS (
      SELECT 1
      FROM file_uploads u
      WHERE u.tenant_id=f.tenant_id AND u.file_id=f.id AND u.status='completed'
    )
    OR (
      f.origin IN ('sandbox_output','image_generation','browser_capture','legacy_artifact','connector_import')
      AND (f.status='available' OR (f.origin='connector_import' AND f.status='processing'))
    )
  )
ORDER BY f.id ASC
      `.trim(),
      [tenantId, runId, scope],
    );
    return rows.map((row) => ({
      fileId: row.file_id,
      name: row.display_name,
      mediaType: row.media_type,
      sizeBytes: Number(row.size_bytes),
      objectKey: row.object_key,
      objectVersionId: row.object_version_id,
    }));
  }

  async persistOutput(input: {
    snapshot: DurableTurnSnapshot;
    fileId: string;
    name: string;
    mediaType: string;
    sizeBytes: number;
    sha256: string;
    bucket: string;
    objectKey: string;
    etag: string | null;
    objectVersionId?: string | null;
    origin?: "sandbox_output" | "image_generation";
    sourcePath?: string;
  }): Promise<SandboxOutputFile> {
    const run = async (executor: SqlExecutor): Promise<SandboxOutputFile> => {
      const ownerNamespace = `tenants/${input.snapshot.tenantId}/users/${input.snapshot.userId}/files/`;
      if ((!input.objectKey.startsWith(ownerNamespace) && !input.objectKey.includes(`/${ownerNamespace}`))
        || input.objectKey.includes("\\")
        || input.objectKey.split("/").includes("..")) {
        throw new Error("Sandbox artifact key is outside the tenant user namespace");
      }
      const existing = await executor.query<{
        id: string;
        owner_user_id: string | null;
        object_key: string;
        resolved_bucket: string;
        resolved_size_bytes: string | number;
        sha256: string | null;
      }>(`
        SELECT f.id, f.owner_user_id, f.object_key,
          COALESCE(blob.bucket, f.bucket) AS resolved_bucket,
          COALESCE(blob.size_bytes, f.size_bytes) AS resolved_size_bytes,
          COALESCE(blob.sha256, f.sha256) AS sha256
        FROM files f
        LEFT JOIN file_blobs blob ON blob.tenant_id=f.tenant_id AND blob.id=f.blob_id
        WHERE f.tenant_id = $1::uuid AND (f.id = $2::uuid OR f.object_key = $3)
        ORDER BY f.id
        FOR UPDATE OF f
      `, [input.snapshot.tenantId, input.fileId, input.objectKey]);
      if (existing.some((file) => file.id !== input.fileId
        || file.owner_user_id !== input.snapshot.userId
        || file.object_key !== input.objectKey
        || file.resolved_bucket !== input.bucket
        || Number(file.resolved_size_bytes) !== input.sizeBytes
        || file.sha256 !== input.sha256)) {
        throw new Error("Sandbox artifact identity conflicts with an existing file");
      }
      let fileId = existing[0]?.id;
      if (!fileId) {
        const blobId = randomUUID();
        await executor.execute(`
          INSERT INTO file_blobs (
            id,tenant_id,bucket,object_key,size_bytes,etag,object_version_id,
            verification_status,metadata
          ) VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,'unverified',$8::jsonb)
        `, [blobId, input.snapshot.tenantId, input.bucket, input.objectKey, input.sizeBytes, input.etag, input.objectVersionId ?? null, JSON.stringify({ expectedSha256: input.sha256, source: "durable-sandbox" })]);
        const rows = await executor.query<{ id: string }>(`
          INSERT INTO files (
            id,tenant_id,owner_user_id,blob_id,original_name,display_name,media_type,size_bytes,
            sha256,bucket,object_key,etag,object_version_id,origin,status,metadata
          ) VALUES (
            $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$5,$6,$7,$8,$9,$10,$11,
            $12,$13,'available',$14::jsonb
          )
          RETURNING id
        `, [input.fileId, input.snapshot.tenantId, input.snapshot.userId, blobId, input.name, input.mediaType, input.sizeBytes, input.sha256, input.bucket, input.objectKey, input.etag, input.objectVersionId ?? null, input.origin ?? "sandbox_output", JSON.stringify({ source: "durable-sandbox", runId: input.snapshot.id, ...(input.sourcePath ? { sourcePath: input.sourcePath } : {}) })]);
        fileId = rows[0]?.id;
        await executor.execute(`
          INSERT INTO runtime_outbox (tenant_id,event_type,aggregate_id,dedupe_key,payload)
          VALUES ($1::uuid,'file.verify-blob',$2,$3,$4::jsonb)
          ON CONFLICT (tenant_id,dedupe_key) DO NOTHING
        `, [input.snapshot.tenantId, blobId, `file.verify-blob:${blobId}`, JSON.stringify({ tenantId: input.snapshot.tenantId, blobId })]);
      }
      if (!fileId) throw new Error("Unable to register the sandbox artifact");
      await executor.execute(`
        INSERT INTO file_library_entries (tenant_id,user_id,file_id)
        VALUES ($1::uuid,$2::uuid,$3::uuid)
        ON CONFLICT (tenant_id,user_id,file_id) DO UPDATE
        SET deleted_at=NULL,updated_at=now()
      `, [input.snapshot.tenantId, input.snapshot.userId, fileId]);
      const locked = await executor.query<{ id: string }>(`
        SELECT id FROM files
        WHERE tenant_id=$1::uuid AND id=$2::uuid AND deleted_at IS NULL
        FOR UPDATE
      `, [input.snapshot.tenantId, fileId]);
      if (!locked[0]) throw new Error("Sandbox artifact became unavailable");
      await executor.execute(
        `
INSERT INTO file_associations (
  tenant_id,file_id,task_id,session_id,turn_id,role,created_by_user_id
) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,'output',$6::uuid)
ON CONFLICT DO NOTHING
        `.trim(),
        [
          input.snapshot.tenantId,
          fileId,
          input.snapshot.taskId,
          input.snapshot.sessionId,
          input.snapshot.id,
          input.snapshot.userId,
        ],
      );
      return {
        fileId,
        name: input.name,
        mediaType: input.mediaType,
        sizeBytes: input.sizeBytes,
        objectKey: input.objectKey,
      };
    };
    return this.executor.transaction ? this.executor.transaction(run) : run(this.executor);
  }

  async publishedOutputs(tenantId: string, sessionId: string): Promise<readonly PublishedSandboxOutput[]> {
    const rows = await this.executor.query<{ source_path: string; sha256: string }>(
      `
SELECT DISTINCT f.metadata->>'sourcePath' AS source_path,
  COALESCE(blob.sha256, f.sha256) AS sha256
FROM file_associations a
JOIN files f ON f.tenant_id=a.tenant_id AND f.id=a.file_id
LEFT JOIN file_blobs blob ON blob.tenant_id=f.tenant_id AND blob.id=f.blob_id
WHERE a.tenant_id=$1::uuid AND a.session_id=$2::uuid AND a.role='output'
  AND f.status='available' AND f.deleted_at IS NULL
  AND (
    f.blob_id IS NULL
    OR (blob.verification_status='verified' AND blob.deleted_at IS NULL)
  )
  AND f.metadata->>'sourcePath' IS NOT NULL
  AND COALESCE(blob.sha256, f.sha256) IS NOT NULL
      `.trim(),
      [tenantId, sessionId],
    );
    return rows.map((row) => ({ sourcePath: row.source_path, sha256: row.sha256 }));
  }

  async recordArtifactOperationStart(input: {
    tenantId: string;
    runId: string;
    operationKey: string;
    relativeKeyFingerprint: string;
    sourcePath: string;
  }): Promise<void> {
    await this.executor.execute(
      `
INSERT INTO artifact_operations (
  tenant_id,run_id,finalization_id,operation_key,relative_key_fingerprint,source_path,status,
  storage_receipt,file_id,verification_status,error_class,updated_at
)
SELECT $1::uuid,$2::uuid,f.id,$3,$4,$5,'pending',NULL,NULL,'pending',NULL,now()
FROM turn_finalizations f
WHERE f.tenant_id=$1::uuid AND f.run_id=$2::uuid
ON CONFLICT (tenant_id,run_id,relative_key_fingerprint) DO UPDATE
SET operation_key=EXCLUDED.operation_key,source_path=EXCLUDED.source_path,status='pending',
    storage_receipt=NULL,file_id=NULL,verification_status='pending',error_class=NULL,updated_at=now()
      `.trim(),
      [input.tenantId, input.runId, input.operationKey, input.relativeKeyFingerprint, input.sourcePath],
    );
  }

  async recordArtifactOperationStorage(input: {
    tenantId: string;
    runId: string;
    operationKey: string;
    storageReceipt: JsonValue;
  }): Promise<void> {
    await this.executor.execute(
      `
UPDATE artifact_operations
SET status='staged',storage_receipt=$4::jsonb,verification_status='pending',updated_at=now()
WHERE tenant_id=$1::uuid AND run_id=$2::uuid AND operation_key=$3
      `.trim(),
      [input.tenantId, input.runId, input.operationKey, JSON.stringify(input.storageReceipt)],
    );
  }

  async completeArtifactOperation(input: {
    tenantId: string;
    runId: string;
    operationKey: string;
    fileId: string;
  }): Promise<void> {
    await this.executor.execute(
      `
UPDATE artifact_operations operation
SET status=CASE
      WHEN blob.verification_status='verified' THEN 'complete'
      WHEN blob.verification_status='failed' THEN 'failed'
      ELSE 'staged'
    END,
    file_id=$4::uuid,
    verification_status=CASE
      WHEN blob.verification_status='verified' THEN 'verified'
      WHEN blob.verification_status='failed' THEN 'failed'
      ELSE 'pending'
    END,
    error_class=CASE
      WHEN blob.verification_status='failed' THEN COALESCE(operation.error_class,'blob_verification_failed')
      ELSE NULL
    END,
    updated_at=now()
FROM files file
LEFT JOIN file_blobs blob
  ON blob.tenant_id=file.tenant_id AND blob.id=file.blob_id
WHERE operation.tenant_id=$1::uuid AND operation.run_id=$2::uuid
  AND operation.operation_key=$3
  AND file.tenant_id=operation.tenant_id AND file.id=$4::uuid
      `.trim(),
      [input.tenantId, input.runId, input.operationKey, input.fileId],
    );
  }

  async failArtifactOperation(input: {
    tenantId: string;
    runId: string;
    operationKey: string;
    errorClass: string;
  }): Promise<void> {
    await this.executor.execute(
      `
UPDATE artifact_operations
SET status='failed',verification_status='failed',error_class=$4,updated_at=now()
WHERE tenant_id=$1::uuid AND run_id=$2::uuid AND operation_key=$3
      `.trim(),
      [input.tenantId, input.runId, input.operationKey, input.errorClass.slice(0, 128)],
    );
  }

  async beginFinalization(input: {
    tenantId: string;
    runId: string;
    owner: string;
  }): Promise<{ id: string; attempt: number } | null> {
    const rows = await this.executor.query<{ id: string; attempt: number | string }>(
      `
UPDATE turn_finalizations
SET status='running',attempt=attempt+1,lease_owner=$3,lease_expires_at=now()+interval '5 minutes',
    started_at=COALESCE(started_at,now()),last_error=NULL,updated_at=now()
WHERE tenant_id=$1::uuid AND run_id=$2::uuid
  AND status IN ('pending','failed','partial','running')
  AND (lease_expires_at IS NULL OR lease_expires_at<=now() OR lease_owner=$3)
RETURNING id,attempt
      `.trim(),
      [input.tenantId, input.runId, input.owner],
    );
    const row = rows[0];
    return row ? { id: row.id, attempt: Number(row.attempt) } : null;
  }

  async finishFinalization(input: {
    tenantId: string;
    runId: string;
    sessionId: string;
    owner: string;
    operationKey: string;
    status: "complete" | "partial";
    itemCount: number;
    completedCount: number;
    failedCount: number;
    manifest: JsonValue;
  }): Promise<void> {
    const updated = await this.executor.query<{
      id: string;
      status: "complete" | "partial" | "failed";
      item_count: number | string;
      completed_count: number | string;
      failed_count: number | string;
      last_error: string | null;
    }>(
      `
WITH counts AS (
  SELECT finalization.id,
         GREATEST($5::integer,COUNT(operation.id)::integer) AS item_count,
         COUNT(operation.id) FILTER (
           WHERE operation.status='complete' AND operation.verification_status='verified'
         )::integer AS completed_count,
         COUNT(operation.id) FILTER (
           WHERE operation.status='failed' OR operation.verification_status='failed'
         )::integer AS failed_count,
         MAX(operation.error_class) FILTER (
           WHERE operation.status='failed' OR operation.verification_status='failed'
         ) AS operation_error
  FROM turn_finalizations finalization
  LEFT JOIN artifact_operations operation
    ON operation.tenant_id=finalization.tenant_id
   AND operation.finalization_id=finalization.id
  WHERE finalization.tenant_id=$1::uuid AND finalization.run_id=$2::uuid
    AND finalization.lease_owner=$3
  GROUP BY finalization.id
)
UPDATE turn_finalizations finalization
SET status=CASE
      WHEN counts.item_count=0 THEN $4
      WHEN counts.completed_count=counts.item_count THEN 'complete'
      WHEN counts.failed_count=counts.item_count THEN 'failed'
      ELSE 'partial'
    END,
    item_count=counts.item_count,
    completed_count=counts.completed_count,
    failed_count=counts.failed_count,
    manifest=$6::jsonb,
    last_error=CASE WHEN counts.failed_count>0
      THEN COALESCE(counts.operation_error,finalization.last_error,'artifact_verification_failed')
      ELSE NULL END,
    completed_at=CASE
      WHEN counts.item_count=0 OR counts.completed_count+counts.failed_count>=counts.item_count THEN now()
      ELSE NULL
    END,
    lease_owner=NULL,lease_expires_at=NULL,updated_at=now()
FROM counts
WHERE finalization.tenant_id=$1::uuid AND finalization.id=counts.id
RETURNING finalization.id,finalization.status,finalization.item_count,
          finalization.completed_count,finalization.failed_count,finalization.last_error
      `.trim(),
      [input.tenantId, input.runId, input.owner, input.status, input.itemCount, JSON.stringify(input.manifest)],
    );
    const result = updated[0];
    if (result?.status === "failed") {
      await this.appendFinalizationEvent(input.tenantId, input.runId, input.sessionId, input.operationKey, {
        kind: "finalization.error",
        runId: input.runId,
        operationKey: input.operationKey,
        errorClass: (result.last_error ?? "artifact_verification_failed").slice(0, 128),
      });
    } else if (result) {
      await this.appendFinalizationEvent(input.tenantId, input.runId, input.sessionId, input.operationKey, {
        kind: "finalization.end",
        runId: input.runId,
        operationKey: input.operationKey,
        status: result.status,
        itemCount: Number(result.item_count),
        completedCount: Number(result.completed_count),
        failedCount: Number(result.failed_count),
      });
    }
  }

  async failFinalization(input: {
    tenantId: string;
    runId: string;
    sessionId: string;
    owner: string;
    operationKey: string;
    errorClass: string;
  }): Promise<void> {
    const updated = await this.executor.query<{ id: string }>(
      `
UPDATE turn_finalizations
SET status='failed',last_error=$4,lease_owner=NULL,lease_expires_at=NULL,updated_at=now()
WHERE tenant_id=$1::uuid AND run_id=$2::uuid AND lease_owner=$3
RETURNING id
      `.trim(),
      [input.tenantId, input.runId, input.owner, input.errorClass.slice(0, 128)],
    );
    if (updated[0]) {
      await this.appendFinalizationEvent(input.tenantId, input.runId, input.sessionId, input.operationKey, {
        kind: "finalization.error",
        runId: input.runId,
        operationKey: input.operationKey,
        errorClass: input.errorClass.slice(0, 128),
      });
    }
  }

  async skipFinalization(input: {
    tenantId: string;
    runId: string;
    sessionId: string;
    operationKey: string;
    reason: string;
  }): Promise<void> {
    const reason = input.reason.slice(0, 128);
    const event: Extract<AgentStreamEvent, { kind: "finalization.end" }> = {
      kind: "finalization.end",
      runId: input.runId,
      operationKey: input.operationKey,
      status: "skipped",
      itemCount: 0,
      completedCount: 0,
      failedCount: 0,
    };
    await this.executor.execute(
      `
WITH settled AS (
  UPDATE turn_finalizations
  SET status='skipped',item_count=0,completed_count=0,failed_count=0,
      manifest=NULL,last_error=$3::text,started_at=COALESCE(started_at,now()),
      completed_at=COALESCE(completed_at,now()),lease_owner=NULL,lease_expires_at=NULL,updated_at=now()
  WHERE tenant_id=$1::uuid AND run_id=$2::uuid
    AND status IN ('pending','failed','partial','running')
    AND (status<>'running' OR lease_expires_at IS NULL OR lease_expires_at<=now())
  RETURNING id
), next_sequence AS (
  SELECT COALESCE(MAX(sequence),0)+1 AS sequence
  FROM turn_events
  WHERE tenant_id=$1::uuid AND run_id=$2::uuid
)
INSERT INTO turn_events (tenant_id,run_id,session_id,sequence,event_type,payload)
SELECT $1::uuid,$2::uuid,$4::uuid,next_sequence.sequence,'finalization.end',$5::jsonb
FROM settled CROSS JOIN next_sequence
WHERE NOT EXISTS (
  SELECT 1 FROM turn_events
  WHERE tenant_id=$1::uuid AND run_id=$2::uuid AND event_type='finalization.end'
    AND payload->>'operationKey'=$6::text AND payload->>'status'='skipped'
)
ON CONFLICT (tenant_id,run_id,sequence) DO NOTHING
      `.trim(),
      [input.tenantId, input.runId, reason, input.sessionId, JSON.stringify(event), input.operationKey],
    );
  }

  private async appendFinalizationEvent(
    tenantId: string,
    runId: string,
    sessionId: string,
    operationKey: string,
    event: Extract<AgentStreamEvent, { kind: "finalization.end" | "finalization.error" }>,
  ): Promise<void> {
    await this.executor.execute(
      `
WITH next_sequence AS (
  SELECT COALESCE(MAX(sequence),0)+1 AS sequence
  FROM turn_events
  WHERE tenant_id=$1::uuid AND run_id=$2::uuid
)
INSERT INTO turn_events (tenant_id,run_id,session_id,sequence,event_type,payload)
SELECT $1::uuid,$2::uuid,$3::uuid,next_sequence.sequence,$4,$5::jsonb
FROM next_sequence
WHERE NOT EXISTS (
  SELECT 1 FROM turn_events
  WHERE tenant_id=$1::uuid AND run_id=$2::uuid AND event_type=$4
    AND payload->>'operationKey'=$6
    AND (
      $4<>'finalization.end'
      OR payload->>'status'=COALESCE($5::jsonb->>'status','')
    )
)
ON CONFLICT (tenant_id,run_id,sequence) DO NOTHING
      `.trim(),
      [tenantId, runId, sessionId, event.kind, JSON.stringify(event), operationKey],
    );
  }

  async latest(tenantId: string, runId: string): Promise<SnapshotRecord | null> {
    const rows = await this.executor.query<SnapshotRow>(
      `
SELECT id,object_key,content_hash,sequence
FROM sandbox_snapshots
WHERE tenant_id=$1::uuid AND run_id=$2::uuid AND status='complete'
ORDER BY sequence DESC
LIMIT 1
      `.trim(),
      [tenantId, runId],
    );
    return rows[0] ? mapSnapshot(rows[0]) : null;
  }

  async persist(input: {
    run: SnapshotRun;
    provider: string;
    sandboxId: string;
    objectKey: string;
    contentHash: string;
  }): Promise<SnapshotRecord> {
    const run = async (executor: SqlExecutor): Promise<SnapshotRecord> => {
      const next = await executor.query<{ sequence: number | string }>(
        "SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM sandbox_snapshots WHERE tenant_id=$1::uuid AND run_id=$2::uuid",
        [input.run.tenantId, input.run.runId],
      );
      const rows = await executor.query<SnapshotRow>(
        `
INSERT INTO sandbox_snapshots (
  tenant_id,run_id,session_id,sandbox_provider,sandbox_id,object_key,
  content_hash,sequence,status,session_leaf_id,completed_at
) VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,'complete',$9,now())
RETURNING id,object_key,content_hash,sequence
        `.trim(),
        [
          input.run.tenantId,
          input.run.runId,
          input.run.sessionId,
          input.provider,
          input.sandboxId,
          input.objectKey,
          input.contentHash,
          Number(next[0]?.sequence ?? 1),
          input.run.sessionLeafId,
        ],
      );
      const row = rows[0];
      if (!row) throw new Error("Unable to persist sandbox snapshot");
      return mapSnapshot(row);
    };
    return this.executor.transaction ? this.executor.transaction(run) : run(this.executor);
  }

  async recordSandbox(input: {
    tenantId: string;
    runId: string;
    provider: string;
    sandboxId: string;
    state: string;
  }): Promise<void> {
    await this.executor.execute(
      `
UPDATE turn_runs
SET sandbox_provider=$3,sandbox_id=$4,sandbox_state=$5,
    sandbox_heartbeat_at=now(),updated_at=now()
WHERE tenant_id=$1::uuid AND id=$2::uuid
      `.trim(),
      [input.tenantId, input.runId, input.provider, input.sandboxId, input.state],
    );
  }

  async withSandboxLifecycleLock<T>(
    tenantId: string,
    sandboxId: string,
    operation: (repository: SandboxSnapshotRepository) => Promise<T>,
  ): Promise<T> {
    if (!this.executor.transaction) return operation(this);
    return this.executor.transaction(async (executor) => {
      await executor.execute(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`${tenantId}:${sandboxId}`],
      );
      return operation(new SqlSandboxSnapshotRepository(executor));
    });
  }

  async tryWithSandboxLifecycleLock<T>(
    tenantId: string,
    sandboxId: string,
    operation: (repository: SandboxSnapshotRepository) => Promise<T>,
  ): Promise<T | null> {
    if (!this.executor.transaction) return operation(this);
    return this.executor.transaction(async (executor) => {
      const rows = await executor.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked",
        [`${tenantId}:${sandboxId}`],
      );
      if (rows[0]?.locked !== true) return null;
      return operation(new SqlSandboxSnapshotRepository(executor));
    });
  }
}

export class S3SandboxSnapshotObjectStore implements SandboxSnapshotObjectStore {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
    private readonly prefix: string,
    private readonly maxSourceBytes = DEFAULT_SANDBOX_INPUT_MAX_BYTES,
  ) {}

  static fromEnv(env: NodeJS.ProcessEnv): S3SandboxSnapshotObjectStore | null {
    const endpoint = env.BERRY_ARTIFACT_S3_ENDPOINT;
    const bucket = env.BERRY_ARTIFACT_S3_BUCKET;
    const accessKeyId = env.BERRY_ARTIFACT_S3_ACCESS_KEY_ID;
    const secretAccessKey = env.BERRY_ARTIFACT_S3_SECRET_ACCESS_KEY;
    if (!bucket) return null;
    return new S3SandboxSnapshotObjectStore(
      new S3Client(s3ClientOptions({ endpoint, region: env.BERRY_ARTIFACT_S3_REGION, accessKeyId, secretAccessKey })),
      bucket,
      (env.BERRY_ARTIFACT_S3_PREFIX ?? "artifacts").replace(/^\/+|\/+$/g, ""),
      positiveInteger(env.BERRY_SANDBOX_INPUT_MAX_BYTES, DEFAULT_SANDBOX_INPUT_MAX_BYTES),
    );
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: `${this.prefix}/${key}`,
      Body: body,
      ContentType: "application/json",
    }));
  }

  async putArtifact(key: string, body: Uint8Array, mediaType: string): Promise<{
    bucket: string;
    key: string;
    etag: string | null;
    objectVersionId?: string | null;
  }> {
    const objectKey = key.startsWith(`${this.prefix}/`) ? key : `${this.prefix}/${key}`;
    const result = await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: objectKey,
      Body: body,
      ContentType: mediaType,
    }));
    return {
      bucket: this.bucket,
      key: objectKey,
      etag: result.ETag?.replaceAll("\"", "") ?? null,
      objectVersionId: result.VersionId ?? null,
    };
  }

  async get(key: string): Promise<Uint8Array> {
    return this.readObject(this.snapshotKey(key), MAX_SNAPSHOT_ARCHIVE_BYTES, "Sandbox snapshot");
  }

  async getSource(key: string, versionId?: string | null): Promise<Uint8Array> {
    return this.readObject(key, this.maxSourceBytes, "Input file", versionId);
  }

  private async readObject(key: string, maxBytes: number, label: string, versionId?: string | null): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of this.streamKey(key, maxBytes, label, versionId)) {
      chunks.push(chunk);
      total += chunk.byteLength;
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }

  async *streamSource(key: string, maxBytes: number, versionId?: string | null): AsyncIterable<Uint8Array> {
    yield* this.streamKey(key, maxBytes, "Input file", versionId);
  }

  private async *streamKey(key: string, maxBytes: number, label: string, versionId?: string | null): AsyncIterable<Uint8Array> {
    const result = await this.client.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ...(versionId ? { VersionId: versionId } : {}),
    }));
    if (!result.Body) throw new Error(`${label} object has no body`);
    if (result.ContentLength !== undefined && result.ContentLength > maxBytes) {
      throw new Error(`${label} object exceeds the ${maxBytes}-byte sandbox limit`);
    }
    let total = 0;
    for await (const raw of result.Body as AsyncIterable<Uint8Array>) {
      const chunk = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      total += chunk.byteLength;
      if (total > maxBytes) throw new Error(`${label} object exceeds the ${maxBytes}-byte sandbox limit`);
      yield chunk;
    }
  }

  private snapshotKey(key: string): string {
    return key.startsWith(`${this.prefix}/`) ? key : `${this.prefix}/${key}`;
  }
}

export function createWorkerSandboxProvider(env: NodeJS.ProcessEnv): SandboxProvider {
  const config = sandboxProviderConfigFromEnv(env);
  if (config.provider === "e2b" && config.e2b) {
    return new E2BSandboxProvider({
      ...config.e2b,
      onOperation: (event) => emitWorkerOperationalEvent(
        "sandbox.operation",
        normalizeWorkerRole(env.BERRY_WORKER_ROLE),
        sourceRevisionFromEnv(env),
        { ...event },
      ),
    });
  }
  if (config.provider !== "docker") return createSandboxProviderFromConfig(config);
  return new DockerSandboxProvider({
    executor: new NodeDockerExecutor(),
    imageAllowlist: [env.BERRY_SANDBOX_IMAGE ?? "node:22-bookworm"],
    containerNamePrefix: env.BERRY_DOCKER_SANDBOX_PREFIX ?? "berry-worker",
  });
}

class NodeDockerExecutor implements DockerCommandExecutor {
  async run(
    args: readonly string[],
    options: { stdin?: string | Buffer; signal?: AbortSignal } = {},
  ): Promise<DockerCommandResult> {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn("docker", [...args], {
        stdio: ["pipe", "pipe", "pipe"],
        ...(options.signal ? { signal: options.signal } : {}),
      });
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? 1));
      if (options.stdin !== undefined) child.stdin.end(options.stdin);
      else child.stdin.end();
    });
    return {
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
      exitCode,
    };
  }

  async *stream(
    args: readonly string[],
    options: { stdin?: string | Buffer; signal?: AbortSignal } = {},
  ): AsyncIterable<DockerStreamEvent> {
    const child = spawn("docker", [...args], {
      stdio: ["pipe", "pipe", "pipe"],
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const queue: DockerStreamEvent[] = [];
    let done = false;
    let wake: (() => void) | null = null;
    const push = (event: DockerStreamEvent) => {
      queue.push(event);
      wake?.();
      wake = null;
    };
    child.stdout.on("data", (chunk: Buffer) => push({ stream: "stdout", data: chunk.toString("utf8") }));
    child.stderr.on("data", (chunk: Buffer) => push({ stream: "stderr", data: chunk.toString("utf8") }));
    child.on("close", (code, signal) => {
      push({ stream: "exit", exitCode: code ?? 1, signal });
      done = true;
      wake?.();
      wake = null;
    });
    child.on("error", (error) => {
      push({ stream: "stderr", data: error.message });
      done = true;
      wake?.();
      wake = null;
    });
    if (options.stdin !== undefined) child.stdin.end(options.stdin);
    else child.stdin.end();
    while (!done || queue.length > 0) {
      const event = queue.shift();
      if (event) yield event;
      else await new Promise<void>((resolve) => { wake = resolve; });
    }
  }
}

async function sandboxCommand(
  provider: SandboxProvider,
  sandboxId: string,
  requestId: string,
  command: string[],
  cwd: string,
  signal?: AbortSignal,
  reportProgress?: () => void,
): Promise<string> {
  const result = await sandboxCommandOutput(provider, sandboxId, requestId, command, cwd, signal, reportProgress);
  return result.stdout;
}

async function sandboxCommandOutput(
  provider: SandboxProvider,
  sandboxId: string,
  requestId: string,
  command: string[],
  cwd: string,
  signal?: AbortSignal,
  reportProgress?: () => void,
): Promise<{ stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;
  for await (const event of provider.exec({
    sandbox_id: sandboxId,
    request_id: requestId,
    command,
    cwd,
    timeout_ms: 0,
  }, { signal })) {
    reportProgress?.();
    if (event.kind === "stdout") stdout = appendBoundedHead(stdout, event.data, 1_000_000);
    else if (event.kind === "stderr") stderr = appendBoundedTail(stderr, event.data, 100_000);
    else if (event.kind === "exit") exitCode = event.exit_code;
    else if (event.kind === "error") throw new Error(event.message);
  }
  if (exitCode !== 0) {
    const detail = (stderr || stdout).slice(-4_000);
    throw new Error(`Command exited with ${exitCode ?? "unknown"}: ${detail}`);
  }
  return { stdout, stderr };
}

function appendBoundedHead(current: string, chunk: string, maximum: number): string {
  if (current.length >= maximum) return current;
  return current + chunk.slice(0, maximum - current.length);
}

function appendBoundedTail(current: string, chunk: string, maximum: number): string {
  if (chunk.length >= maximum) return chunk.slice(-maximum);
  const combined = current + chunk;
  return combined.length <= maximum ? combined : combined.slice(-maximum);
}

async function readSandboxText(
  provider: SandboxProvider,
  sandboxId: string,
  requestId: string,
  path: string,
  args: Record<string, unknown>,
  cwd: string,
  signal?: AbortSignal,
  reportProgress?: () => void,
): Promise<{ content: string; details: Record<string, JsonValue>; sizeBytes: number }> {
  const offset = numberValue(args.offset) ?? 1;
  const limit = numberValue(args.limit) ?? 0;
  const result = await sandboxCommandOutput(provider, sandboxId, requestId, [
    "node",
    "-e",
    PI_READ_STREAM_SCRIPT,
    path,
    String(offset),
    String(limit),
    String(PI_TOOL_MAX_LINES),
    String(PI_TOOL_MAX_BYTES),
    String(PI_READ_MAX_LINE_LENGTH),
  ], cwd, signal, reportProgress);
  let parsed: Record<string, unknown>;
  try {
    parsed = objectValue(JSON.parse(result.stdout));
  } catch {
    throw new Error(`The bounded read helper returned invalid output for ${path}`);
  }
  const content = stringValue(parsed.content, true);
  const sizeBytes = numberValue(parsed.sizeBytes);
  if (content === null || sizeBytes === null || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new Error(`The bounded read helper returned incomplete output for ${path}`);
  }
  return {
    content,
    details: objectValue(parsed.details) as Record<string, JsonValue>,
    sizeBytes,
  };
}

function parsePiGrepMetadata(stderr: string): {
  matchCount: number;
  limitReached: boolean;
  byteLimitReached: boolean;
  linesTruncated: boolean;
} {
  const marker = stderr.lastIndexOf(PI_GREP_META_PREFIX);
  if (marker < 0) throw new Error("The bounded grep formatter did not return result metadata");
  const line = stderr.slice(marker + PI_GREP_META_PREFIX.length).split("\n", 1)[0] ?? "";
  let parsed: Record<string, unknown>;
  try {
    parsed = objectValue(JSON.parse(line));
  } catch {
    throw new Error("The bounded grep formatter returned invalid result metadata");
  }
  const matchCount = numberValue(parsed.matchCount);
  if (matchCount === null || !Number.isSafeInteger(matchCount) || matchCount < 0) {
    throw new Error("The bounded grep formatter returned an invalid match count");
  }
  return {
    matchCount,
    limitReached: parsed.limitReached === true,
    byteLimitReached: parsed.byteLimitReached === true,
    linesTruncated: parsed.linesTruncated === true,
  };
}

async function downloadGeneratedImage(url: string | undefined): Promise<Buffer> {
  if (!url) throw new Error("The image provider returned no image payload");
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("Generated image downloads must use HTTPS");
  const response = await fetch(parsed, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Unable to download generated image (${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}

async function generateDurableImage(
  config: NonNullable<ConstructorParameters<typeof SandboxContinuityManager>[3]["imageGeneration"]>,
  input: {
    prompt: string;
    model: string;
    size: string;
    transparentBackground: boolean;
    idempotencyKey: string;
    referenceImageUrls?: string[];
  },
): Promise<ImageGenerationResult> {
  const references = input.referenceImageUrls ?? [];
  const upstreamModel = input.model.split("/").at(-1) ?? input.model;
  const response = await fetch(references.length > 0 ? config.editsEndpoint : config.endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "Idempotency-Key": input.idempotencyKey,
      ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: input.model,
      prompt: input.prompt,
      ...(references.length > 0 ? {
        images: references.map((imageUrl) => ({ image_url: imageUrl })),
        ...(!upstreamModel.startsWith("gpt-image-2") ? { input_fidelity: "high" } : {}),
      } : {}),
      n: 1,
      size: input.size,
      ...(!upstreamModel.startsWith("gpt-image-") ? { response_format: config.responseFormat } : {}),
      background: input.transparentBackground ? "transparent" : "auto",
      ...(input.transparentBackground ? { output_format: "png" } : {}),
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`Image provider request failed with ${response.status}: ${(await response.text()).slice(0, 2_000)}`);
  const payload = await response.json() as ImageGenerationResult;
  if (!Array.isArray(payload.data)) throw new Error("Image provider response did not include data");
  return payload;
}

function imageSizeForAspectRatio(value: string | null): string {
  if (value === "3:4" || value === "9:16") return "1024x1536";
  if (value === "4:3" || value === "16:9") return "1536x1024";
  return "1024x1024";
}

function imageDimensions(value: string): { width: number; height: number } {
  const match = /^(\d+)x(\d+)$/.exec(value);
  return {
    width: Number(match?.[1] ?? 1024),
    height: Number(match?.[2] ?? 1024),
  };
}

function excludedSnapshotPath(path: string, root: string): boolean {
  const relative = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
  const parts = relative.split("/");
  return parts[0] === "tmp"
    || parts[0] === "inputs"
    || parts.some((part) => [
    ".git",
    "node_modules",
    ".next",
    ".cache",
    ".pnpm-store",
    ".berry-tool-output",
    "__pycache__",
    ".venv",
    "target",
    "dist",
  ].includes(part))
    || parts.some((part) => /^\.env(?:\.|$)/.test(part))
    || /(?:secret|credential|token|private[-_.]?key)/i.test(relative);
}

function safeWorkspaceRoot(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/").replace(/\/+$/, "");
  const parts = normalized.split("/").filter(Boolean);
  if (!normalized.startsWith("/") || parts.length === 0 || parts.includes("..") || parts.includes(".")) {
    throw new Error("Sandbox workspace root must be an absolute path without traversal segments");
  }
  return `/${parts.join("/")}`;
}

function isMissingSandboxPath(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "FileNotFoundError"
    || /^\[not_found\]\s+path not found:/i.test(error.message)
    || /\bno such file or directory\b/i.test(error.message);
}

interface PiTruncation {
  content: string;
  truncated: boolean;
  truncatedBy: "lines" | "bytes" | null;
  totalLines: number;
  outputLines: number;
}

function countedLines(content: string): string[] {
  if (!content) return [];
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines;
}

function normalizeToolText(content: string): string {
  return content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function truncatePiHead(content: string, maxLines = PI_TOOL_MAX_LINES): PiTruncation {
  const lines = countedLines(content);
  if (lines.length <= maxLines && Buffer.byteLength(content, "utf8") <= PI_TOOL_MAX_BYTES) {
    return { content, truncated: false, truncatedBy: null, totalLines: lines.length, outputLines: lines.length };
  }
  const selected: string[] = [];
  let bytes = 0;
  let truncatedBy: "lines" | "bytes" = "lines";
  for (const line of lines.slice(0, maxLines)) {
    const lineBytes = Buffer.byteLength(line, "utf8") + (selected.length > 0 ? 1 : 0);
    if (bytes + lineBytes > PI_TOOL_MAX_BYTES) {
      truncatedBy = "bytes";
      break;
    }
    selected.push(line);
    bytes += lineBytes;
  }
  if (selected.length >= maxLines) truncatedBy = "lines";
  return {
    content: selected.join("\n"),
    truncated: true,
    truncatedBy,
    totalLines: lines.length,
    outputLines: selected.length,
  };
}

class PiTailCollector {
  #content = "";
  #sawContent = false;
  #endsWithNewline = false;
  #totalNewlines = 0;
  #trimmedBytes = false;
  #trimmedLines = false;

  append(chunk: string): void {
    if (!chunk) return;
    this.#sawContent = true;
    this.#endsWithNewline = chunk.endsWith("\n");
    for (let index = 0; index < chunk.length; index += 1) {
      if (chunk.charCodeAt(index) === 10) this.#totalNewlines += 1;
    }

    let combined: string;
    if (Buffer.byteLength(chunk, "utf8") > PI_TOOL_MAX_BYTES) {
      combined = utf8Tail(chunk, PI_TOOL_MAX_BYTES);
      this.#trimmedBytes = true;
    } else {
      combined = `${this.#content}${chunk}`;
      if (Buffer.byteLength(combined, "utf8") > PI_TOOL_MAX_BYTES) {
        combined = utf8Tail(combined, PI_TOOL_MAX_BYTES);
        this.#trimmedBytes = true;
      }
    }

    const endsWithNewline = combined.endsWith("\n");
    const lines = countedLines(combined);
    if (lines.length > PI_TOOL_MAX_LINES) {
      combined = lines.slice(-PI_TOOL_MAX_LINES).join("\n");
      if (endsWithNewline) combined += "\n";
      this.#trimmedLines = true;
    }
    this.#content = combined;
  }

  result(): PiTruncation {
    const outputLines = countedLines(this.#content).length;
    const totalLines = this.#sawContent
      ? this.#totalNewlines + (this.#endsWithNewline ? 0 : 1)
      : 0;
    const truncated = this.#trimmedBytes || this.#trimmedLines;
    const truncatedBy = !truncated
      ? null
      : this.#trimmedLines && (!this.#trimmedBytes || outputLines >= PI_TOOL_MAX_LINES)
        ? "lines"
        : "bytes";
    return {
      content: this.#content,
      truncated,
      truncatedBy,
      totalLines,
      outputLines,
    };
  }
}

function utf8Tail(content: string, maxBytes: number): string {
  let candidateStart = Math.max(0, content.length - maxBytes);
  const candidateCode = content.charCodeAt(candidateStart);
  if (candidateStart > 0 && candidateCode >= 0xdc00 && candidateCode <= 0xdfff) candidateStart -= 1;
  const buffer = Buffer.from(content.slice(candidateStart), "utf8");
  let start = Math.max(0, buffer.length - maxBytes);
  while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start).toString("utf8");
}

export function piReadContent(
  source: string,
  args: Record<string, unknown>,
): { content: string; details: Record<string, JsonValue> } {
  const normalized = normalizeToolText(source);
  if (normalized.length === 0) {
    return {
      content: "[File is empty.]",
      details: { empty: true, totalLines: 0 },
    };
  }
  const allLines = countedLines(normalized);
  const offset = numberValue(args.offset);
  const limit = numberValue(args.limit);
  const startLine = offset === null ? 0 : offset - 1;
  if (startLine >= allLines.length) {
    return {
      content: `[Offset ${offset} is beyond end of file (${allLines.length} lines total). Retry with offset=${Math.max(1, allLines.length)} or smaller.]`,
      details: { eof: true, totalLines: allLines.length },
    };
  }
  const endLine = limit === null
    ? allLines.length
    : Math.min(allLines.length, startLine + limit);
  let linesTruncated = false;
  const selected = allLines.slice(startLine, endLine).map((line) => {
    const clamped = clampReadLine(line);
    linesTruncated ||= clamped.truncated;
    return clamped.content;
  }).join("\n");
  const truncated = truncatePiHead(selected);
  const startDisplay = startLine + 1;
  const notices: string[] = [];
  const details: Record<string, JsonValue> = {};
  if (truncated.truncated) {
    const endDisplay = startDisplay + truncated.outputLines - 1;
    notices.push(`Showing lines ${startDisplay}-${endDisplay} of ${allLines.length}${truncated.truncatedBy === "bytes" ? " (50.0KB limit)" : ""}. Use offset=${endDisplay + 1} to continue.`);
    Object.assign(details, {
      truncated: true,
      truncatedBy: truncated.truncatedBy,
      totalLines: allLines.length,
      outputLines: truncated.outputLines,
    });
  } else if (limit !== null && endLine < allLines.length) {
    notices.push(`${allLines.length - endLine} more lines in file. Use offset=${endLine + 1} to continue.`);
  }
  if (linesTruncated) {
    notices.push(`Some lines were truncated to ${PI_READ_MAX_LINE_LENGTH} characters. Use bash for targeted full-line inspection.`);
    details.truncated = true;
    details.linesTruncated = true;
  }
  return {
    content: `${truncated.content}${notices.length > 0 ? `\n\n[${notices.join(" ")}]` : ""}`,
    details,
  };
}

function clampReadLine(line: string): { content: string; truncated: boolean } {
  const characters = Array.from(line);
  if (characters.length <= PI_READ_MAX_LINE_LENGTH) return { content: line, truncated: false };
  const suffix = "… [truncated; use bash for full line]";
  const suffixLength = Array.from(suffix).length;
  return {
    content: `${characters.slice(0, PI_READ_MAX_LINE_LENGTH - suffixLength).join("")}${suffix}`,
    truncated: true,
  };
}

function piEditEntries(args: Record<string, unknown>): Array<{ oldText: string; newText: string }> {
  const edits = Array.isArray(args.edits) ? [...args.edits] : [];
  if (edits.length === 0) throw new Error("edit requires one or more edits");
  return edits.map((value, index) => {
    const edit = objectValue(value);
    const oldText = stringValue(edit.oldText);
    const newText = stringValue(edit.newText, true);
    if (!oldText) throw new Error(`edit requires a non-empty edits[${index}].oldText`);
    if (newText === null) throw new Error(`edit requires a string edits[${index}].newText`);
    return { oldText, newText };
  });
}

const CORE_TOOL_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

function prepareCoreToolArguments(
  toolName: string,
  input: unknown,
): { args: Record<string, unknown>; repairs: string[] } {
  const direct = objectValue(input);
  if (!CORE_TOOL_NAMES.has(toolName) || coreToolArgumentsValid(toolName, direct)) {
    return { args: direct, repairs: [] };
  }

  const repairs: string[] = [];
  const rootField = toolName === "bash"
    ? "command"
    : toolName === "grep" || toolName === "find"
      ? "pattern"
      : "path";
  let candidate: Record<string, unknown> = typeof input === "string"
    ? { [rootField]: input }
    : { ...direct };
  if (typeof input === "string") repairs.push(`wrapped bare string as ${rootField}`);

  if (typeof candidate.raw === "string") {
    try {
      const parsed = JSON.parse(candidate.raw);
      const parsedArguments = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? objectValue(parsed)
        : typeof parsed === "string"
          ? { [rootField]: parsed }
          : null;
      if (parsedArguments) {
        const explicit = Object.fromEntries(Object.entries(candidate).filter(([key]) => key !== "raw"));
        candidate = { ...parsedArguments, ...explicit };
        repairs.push("parsed the raw JSON wrapper after direct validation failed");
      }
    } catch {
      // Leave malformed raw input intact so validation returns the actionable retry error.
    }
  }

  moveCoreArgumentAlias(candidate, "path", [
    "filePath", "file_path", "absolutePath", "absolute_path", "targetPath", "target_path", "targetFile", "target_file", "file", "filename",
  ], repairs);
  if (toolName === "bash") moveCoreArgumentAlias(candidate, "command", ["cmd", "shellCommand", "shell_command"], repairs);
  if (toolName === "grep" || toolName === "find") {
    moveCoreArgumentAlias(candidate, "pattern", ["query", "search", "searchPattern", "search_pattern"], repairs);
  }
  if (toolName === "grep") moveCoreArgumentAlias(candidate, "ignoreCase", ["ignore_case"], repairs);

  if (toolName === "edit" && candidate.edits === undefined
    && typeof candidate.oldText === "string" && typeof candidate.newText === "string") {
    candidate.edits = [{ oldText: candidate.oldText, newText: candidate.newText }];
    delete candidate.oldText;
    delete candidate.newText;
    repairs.push("wrapped oldText/newText as one edits entry");
  }
  if (toolName === "edit" && typeof candidate.edits === "string") {
    try {
      candidate.edits = JSON.parse(candidate.edits);
      repairs.push("parsed stringified edits JSON");
    } catch {
      // Validation below explains that edits must be an array.
    }
  }
  if (toolName === "edit" && candidate.edits && typeof candidate.edits === "object" && !Array.isArray(candidate.edits)) {
    candidate.edits = [candidate.edits];
    repairs.push("wrapped one edit object as an edits array");
  }

  for (const field of ["offset", "limit", "timeout", "context"]) {
    if (typeof candidate[field] !== "string" || !candidate[field].trim()) continue;
    const parsed = Number(candidate[field]);
    if (!Number.isFinite(parsed)) continue;
    candidate[field] = parsed;
    repairs.push(`converted numeric string ${field}`);
  }

  const optionalFields = coreOptionalFields(toolName);
  for (const field of optionalFields) {
    if (candidate[field] !== null) continue;
    delete candidate[field];
    repairs.push(`removed null optional field ${field}`);
  }
  if (typeof candidate.path === "string") {
    const repairedPath = repairDegenerateMarkdownPath(candidate.path);
    if (repairedPath !== candidate.path) {
      candidate.path = repairedPath;
      repairs.push("unwrapped a markdown-autolinked path");
    }
  }
  return { args: candidate, repairs: [...new Set(repairs)] };
}

function moveCoreArgumentAlias(
  args: Record<string, unknown>,
  target: string,
  aliases: readonly string[],
  repairs: string[],
): void {
  for (const alias of aliases) {
    if (!(alias in args)) continue;
    if (args[target] === undefined) {
      args[target] = args[alias];
      repairs.push(`renamed ${alias} to ${target}`);
    } else {
      repairs.push(`removed redundant alias ${alias}`);
    }
    delete args[alias];
  }
}

function coreOptionalFields(toolName: string): readonly string[] {
  if (toolName === "read") return ["offset", "limit"];
  if (toolName === "bash") return ["timeout"];
  if (toolName === "grep") return ["path", "glob", "ignoreCase", "literal", "context", "limit"];
  if (toolName === "find") return ["path", "limit"];
  if (toolName === "ls") return ["path", "limit"];
  return [];
}

function repairDegenerateMarkdownPath(value: string): string {
  return value.replace(/\[([^\]\r\n]+)\]\(https?:\/\/([^/)\s]+)\/?\)/gi, (whole, label: string, target: string) =>
    label === target ? label : whole);
}

function coreToolArgumentsValid(toolName: string, args: Record<string, unknown>): boolean {
  try {
    validateCoreToolArguments(toolName, args);
    return true;
  } catch {
    return false;
  }
}

function validateCoreToolArguments(toolName: string, args: Record<string, unknown>): void {
  if (!CORE_TOOL_NAMES.has(toolName)) return;
  if (typeof args.raw === "string") {
    throw new Error(
      `The ${toolName} arguments were incomplete or invalid JSON. Call the tool again with its schema fields directly; do not send a raw wrapper.`,
    );
  }
  const allowed = toolName === "read" ? ["path", "offset", "limit"]
    : toolName === "bash" ? ["command", "timeout"]
      : toolName === "edit" ? ["path", "edits"]
        : toolName === "write" ? ["path", "content"]
          : toolName === "grep" ? ["pattern", "path", "glob", "ignoreCase", "literal", "context", "limit"]
            : toolName === "find" ? ["pattern", "path", "limit"]
              : ["path", "limit"];
  const unexpected = Object.keys(args).find((field) => !allowed.includes(field));
  if (unexpected) {
    throw new Error(`${toolName} received unsupported field ${JSON.stringify(unexpected)}. Use only: ${allowed.join(", ")}`);
  }

  if (toolName === "read") {
    validateCorePath(args, toolName, true);
    validateOptionalInteger(args, "offset", 1, toolName);
    validateOptionalInteger(args, "limit", 1, toolName);
    return;
  }
  if (toolName === "bash") {
    requiredToolString(args, "command", toolName);
    if (args.timeout !== undefined && (numberValue(args.timeout) === null || numberValue(args.timeout)! <= 0)) {
      throw new Error("bash timeout must be a finite number greater than zero");
    }
    return;
  }
  if (toolName === "edit") {
    validateCorePath(args, toolName, true);
    if (!Array.isArray(args.edits)) throw new Error("edit edits must be an array");
    piEditEntries(args);
    return;
  }
  if (toolName === "write") {
    validateCorePath(args, toolName, true);
    requiredToolString(args, "content", toolName, true);
    return;
  }
  if (toolName === "grep") {
    requiredToolString(args, "pattern", toolName, true);
    validateCorePath(args, toolName, false);
    validateOptionalString(args, "glob", toolName);
    validateOptionalBoolean(args, "ignoreCase", toolName);
    validateOptionalBoolean(args, "literal", toolName);
    validateOptionalInteger(args, "context", 0, toolName);
    validateOptionalInteger(args, "limit", 1, toolName);
    return;
  }
  if (toolName === "find") {
    requiredToolString(args, "pattern", toolName, true);
    validateCorePath(args, toolName, false);
    validateOptionalInteger(args, "limit", 1, toolName);
    return;
  }
  validateCorePath(args, toolName, false);
  validateOptionalInteger(args, "limit", 1, toolName);
}

function validateCorePath(args: Record<string, unknown>, toolName: string, required: boolean): void {
  if (args.path === undefined && !required) return;
  const path = requiredToolPath(args, toolName);
  if (repairDegenerateMarkdownPath(path) !== path) {
    throw new Error(`${toolName} path contains a markdown autolink and must be unwrapped`);
  }
}

function validateOptionalString(args: Record<string, unknown>, field: string, toolName: string): void {
  if (args[field] !== undefined && typeof args[field] !== "string") {
    throw new Error(`${toolName} ${field} must be a string`);
  }
}

function validateOptionalBoolean(args: Record<string, unknown>, field: string, toolName: string): void {
  if (args[field] !== undefined && typeof args[field] !== "boolean") {
    throw new Error(`${toolName} ${field} must be true or false`);
  }
}

function validateOptionalInteger(
  args: Record<string, unknown>,
  field: string,
  minimum: number,
  toolName: string,
): void {
  if (args[field] === undefined) return;
  const value = numberValue(args[field]);
  if (value === null || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${toolName} ${field} must be an integer greater than or equal to ${minimum}`);
  }
}

function requiredToolPath(args: Record<string, unknown>, toolName: string): string {
  const path = stringValue(args.path);
  if (!path) {
    throw new Error(
      `${toolName} requires a non-empty path. Retry once with the declared schema fields and repeat the exact path on every file-tool call.`,
    );
  }
  return path;
}

function requiredToolString(
  args: Record<string, unknown>,
  field: string,
  toolName: string,
  allowEmpty = false,
): string {
  const value = stringValue(args[field], allowEmpty);
  if (value === null) {
    throw new Error(`${toolName} requires ${allowEmpty ? "a string" : "a non-empty string"} ${field}`);
  }
  return value;
}

function immediateSkillPackageBytes(file: DurableSkillPackageFile): Buffer | null {
  if (file.contentBytes !== undefined) {
    return Buffer.isBuffer(file.contentBytes)
      ? file.contentBytes
      : Buffer.from(file.contentBytes.buffer, file.contentBytes.byteOffset, file.contentBytes.byteLength);
  }
  if (file.contentBase64 !== undefined) return Buffer.from(file.contentBase64, "base64");
  return null;
}

async function loadSkillPackageBytes(file: DurableSkillPackageFile): Promise<Buffer> {
  const immediate = immediateSkillPackageBytes(file);
  if (immediate) return immediate;
  if (!file.loadContentBytes) throw new Error(`Skill package file has no content: ${file.path}`);
  const loaded = await file.loadContentBytes();
  return Buffer.isBuffer(loaded)
    ? loaded
    : Buffer.from(loaded.buffer, loaded.byteOffset, loaded.byteLength);
}

function durablyStagedSkillPackagePaths(
  snapshot: DurableTurnSnapshot,
  root: string,
  stagingSandboxId: string,
): Set<string> {
  const staged = new Set<string>();
  const skillPath = `${root}/SKILL.md`;
  for (const step of snapshot.steps ?? []) {
    if (step.state !== "completed") continue;
    const toolName = stringValue(step.input.toolName) ?? step.type.slice(5);
    if (toolName !== "activate_skill") continue;
    const output = objectValue(step.output);
    if (stringValue(output.stagingSandboxId) !== stagingSandboxId) continue;
    if (stringValue(output.location) !== skillPath) continue;
    staged.add("SKILL.md");
    if (!Array.isArray(output.stagedResources)) continue;
    for (const value of output.stagedResources) {
      if (typeof value !== "string") continue;
      try {
        staged.add(relativeSkillPackagePath(root, value));
      } catch {
        // Ignore stale or malformed tool output rather than trusting a path
        // outside this content-addressed package root.
      }
    }
  }
  return staged;
}

async function mapWithConcurrency<T, TResult>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T, index: number) => Promise<TResult>,
): Promise<TResult[]> {
  const results = new Array<TResult>(values.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await operation(values[index]!, index);
    }
  }));
  return results;
}

function safeWorkspacePath(value: string, workspaceRoot = "/workspace"): string {
  const root = safeWorkspaceRoot(workspaceRoot);
  return safeSandboxPath(value, root, [root], `Sandbox writes must remain under ${root}`);
}

function safeRelativeSkillPackagePath(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/");
  const parts = normalized.split("/");
  if (!normalized || normalized.length > 512 || normalized.startsWith("/") || /^[a-z]:\//i.test(normalized) || parts.some((part) => !part || part === "." || part === "..") || normalized.includes("\0")) {
    throw new Error(`Unsafe skill package path: ${value}`);
  }
  return normalized;
}

function relativeSkillPackagePath(root: string, path: string): string {
  const prefix = `${root.replace(/\/+$/, "")}/`;
  if (!path.startsWith(prefix)) throw new Error("Skill package file escaped its root directory");
  return safeRelativeSkillPackagePath(path.slice(prefix.length));
}

function safeReadablePath(value: string, workspaceRoot = "/workspace"): string {
  const root = safeWorkspaceRoot(workspaceRoot);
  return safeSandboxPath(
    value,
    root,
    [root, "/managed-skills"],
    `Sandbox reads must remain under ${root} or /managed-skills`,
  );
}

function safeOutputPath(value: string, workspaceRoot = "/workspace"): string {
  const root = safeWorkspaceRoot(workspaceRoot);
  const path = safeWorkspacePath(value, root);
  if (!path.startsWith(`${root}/outputs/`) && !path.startsWith(`${root}/output/`)) {
    throw new Error(`Artifacts must be created under ${root}/outputs`);
  }
  return path;
}

function safeArtifactName(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\\/\0]/g, "-")
    .replace(/[^\p{L}\p{N}._() -]+/gu, "-")
    .replace(/\s+/g, " ")
    .slice(0, 180) || "artifact";
}

function stableArtifactUuid(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}

function terminalFinalizationSnapshot(run: SnapshotRun): DurableTurnSnapshot {
  return {
    id: run.runId,
    createdAt: new Date().toISOString(),
    tenantId: run.tenantId,
    userId: run.userId!,
    workspaceId: run.workspaceId ?? run.taskId,
    taskId: run.taskId,
    sessionId: run.sessionId,
    requestMessageId: null,
    state: run.runState as DurableTurnSnapshot["state"],
    attempt: 0,
    version: 0,
    leaseOwner: "terminal-finalizer",
    cancelledAt: null,
    runtimeRequest: {},
    groundingContext: {},
    promptManifest: {},
    sandboxProvider: run.sandboxProvider,
    sandboxId: run.sandboxId,
    sandboxState: run.sandboxState ?? null,
    usageTotals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costMicros: "0" },
    steps: [],
    entries: [],
    approvals: [],
  };
}

function safeSandboxPath(
  value: string,
  workspaceRoot: string,
  roots: readonly string[],
  errorMessage: string,
): string {
  const normalized = value.trim().replaceAll("\\", "/");
  const absolute = normalized.startsWith("/") ? normalized : `${workspaceRoot}/${normalized}`;
  const parts = absolute.split("/").filter(Boolean);
  const path = `/${parts.join("/")}`;
  const withinRoot = roots.some((root) => path === root || path.startsWith(`${root}/`));
  if (!parts[0] || !withinRoot || parts.includes("..") || parts.includes(".")) {
    throw new Error(errorMessage);
  }
  return path;
}

async function extractPdfText(
  provider: SandboxProvider,
  sandboxId: string,
  path: string,
  step: DurableTurnStep,
  workspaceRoot: string,
  signal?: AbortSignal,
  reportProgress?: () => void,
): Promise<string> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let exitCode: number | null = null;
  for await (const event of provider.exec({
    sandbox_id: sandboxId,
    request_id: `${step.idempotencyKey ?? step.id}:pdf-text`,
    command: ["pdftotext", "-layout", path, "-"],
    cwd: workspaceRoot,
    timeout_ms: 120_000,
  }, { signal })) {
    reportProgress?.();
    if (event.kind === "stdout") stdout.push(event.data);
    else if (event.kind === "stderr") stderr.push(event.data);
    else if (event.kind === "exit") exitCode = event.exit_code;
    else if (event.kind === "error") throw new Error(event.message);
  }
  const content = stdout.join("").slice(0, 1_000_000);
  if (exitCode !== 0) {
    throw new Error(`PDF text extraction exited with ${exitCode ?? "unknown"}: ${stderr.join("").slice(-4_000)}`);
  }
  return content || "[The PDF contains no extractable text. It may be scanned and require OCR.]";
}

function binaryMediaType(path: string): string | null {
  const extension = path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  return ({
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    tif: "image/tiff",
    tiff: "image/tiff",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    zip: "application/zip",
    gz: "application/gzip",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    mp4: "video/mp4",
    mov: "video/quicktime",
  } as Record<string, string>)[extension] ?? null;
}

const DURABLE_ARTIFACT_MEDIA_TYPES: Record<string, string> = {
  avif: "image/avif",
  bmp: "image/bmp",
  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  epub: "application/epub+zip",
  gif: "image/gif",
  html: "text/html",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  md: "text/markdown",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  odp: "application/vnd.oasis.opendocument.presentation",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odt: "application/vnd.oasis.opendocument.text",
  pdf: "application/pdf",
  png: "image/png",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  rtf: "application/rtf",
  svg: "image/svg+xml",
  tar: "application/x-tar",
  tif: "image/tiff",
  tiff: "image/tiff",
  tsv: "text/tab-separated-values",
  txt: "text/plain",
  wav: "audio/wav",
  webm: "video/webm",
  webp: "image/webp",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  zip: "application/zip",
};

function durableArtifactMediaType(path: string): string {
  const extension = path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  return DURABLE_ARTIFACT_MEDIA_TYPES[extension] ?? "application/octet-stream";
}

function isDurableArtifact(path: string): boolean {
  const name = path.split("/").at(-1) ?? "";
  if (!name || name.startsWith(".") || name.endsWith("~")) return false;
  return durableArtifactMediaType(name) !== "application/octet-stream";
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function networkPolicy(value: unknown): {
  egress: "on" | "off" | "unrestricted";
  allowedDomains: string[];
} {
  const object = objectValue(value);
  const egress = object.egress === "on" || object.egress === "unrestricted"
    ? object.egress
    : "off";
  return {
    egress,
    allowedDomains: Array.isArray(object.allowedDomains)
      ? object.allowedDomains.filter((item): item is string => typeof item === "string")
      : [],
  };
}

function stringValue(value: unknown, allowEmpty = false): string | null {
  if (typeof value !== "string") return null;
  return allowEmpty || value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function* singleChunk(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isSandboxPausedError(error: unknown): error is Error & { code: "sandbox_paused" } {
  return error instanceof Error
    && "code" in error
    && (error as Error & { code?: unknown }).code === "sandbox_paused";
}

function mapSnapshot(row: SnapshotRow): SnapshotRecord {
  return {
    id: row.id,
    objectKey: row.object_key,
    contentHash: row.content_hash,
    sequence: Number(row.sequence),
  };
}

function isTimestampStrictlyBefore(
  candidate: Date | string | null,
  target: Date | string | null,
): boolean {
  if (!candidate || !target) return false;
  const candidateMs = candidate instanceof Date ? candidate.getTime() : Date.parse(candidate);
  const targetMs = target instanceof Date ? target.getTime() : Date.parse(target);
  return Number.isFinite(candidateMs) && Number.isFinite(targetMs) && candidateMs < targetMs;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${operation} timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

interface SnapshotRunRow {
  tenant_id: string;
  user_id: string;
  workspace_id: string;
  run_id: string;
  session_id: string;
  task_id: string;
  sandbox_provider: string | null;
  sandbox_id: string | null;
  sandbox_state: string | null;
  run_state: string;
  sandbox_claimed_by_newer_run: boolean;
  session_leaf_id: string | null;
}

interface SnapshotRow {
  id: string;
  object_key: string;
  content_hash: string;
  sequence: number | string;
}

interface SessionContinuityRow {
  sandbox_provider: string | null;
  sandbox_id: string | null;
  prior_created_at: Date | string | null;
  prior_branch_compatible: boolean | null;
  snapshot_id: string | null;
  object_key: string | null;
  content_hash: string | null;
  sequence: number | string | null;
  snapshot_created_at: Date | string | null;
  snapshot_session_leaf_id: string | null;
  snapshot_branch_compatible: boolean | null;
  target_created_at: Date | string | null;
}

interface SandboxInputFileRow {
  file_id: string;
  display_name: string;
  media_type: string;
  size_bytes: number | string;
  object_key: string;
  object_version_id: string | null;
}
