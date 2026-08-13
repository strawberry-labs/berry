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
  createSandboxProviderFromConfig,
  sandboxProviderConfigFromEnv,
  type DockerCommandExecutor,
  type DockerCommandResult,
  type DockerStreamEvent,
  type SandboxProvider,
} from "@berry/sandbox-contract";
import type { ChatContentPart, ImageGenerationResult } from "@berry/router-client";
import {
  DEFAULT_SANDBOX_INPUT_MAX_BYTES,
  ORGANIZATION_SKILL_PACKAGE_MAX_BYTES,
  type JsonValue,
} from "@berry/shared";
import { parsePatch, type PatchHunk } from "@berry/local-agent";
import { durableAttachmentPath } from "./durable-attachments.js";
import type { SandboxSnapshotJobPayload } from "./jobs.js";
import type { SqlExecutor } from "./sql-repositories.js";
import { s3ClientOptions } from "./s3-client-options.js";
import type {
  DurableTurnSnapshot,
  DurableTurnStep,
  DurableTurnToolExecutor,
  DurableSkillPackageFile,
  TurnToolResult,
} from "./turn-runner.js";

const MAX_SNAPSHOT_ARCHIVE_BYTES = 384 * 1024 * 1024;
const MAX_MODEL_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_MODEL_IMAGE_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_MODEL_IMAGES = 5;
const DEFAULT_TERMINAL_SNAPSHOT_TIMEOUT_MS = 120_000;
const DEFAULT_INTERVAL_SNAPSHOT_TIMEOUT_MS = 60_000;
const DEFAULT_TERMINAL_SUSPEND_TIMEOUT_MS = 70_000;
const MAX_SNAPSHOT_FILES = 5_000;
const MAX_SNAPSHOT_BYTES = 250 * 1024 * 1024;
const INACTIVE_SANDBOX_STATES = new Set(["paused", "missing", "stopped", "destroyed"]);
const TERMINAL_RUN_STATES = new Set(["completed", "failed", "cancelled", "recovery_required"]);

interface SnapshotArchive {
  version: 1;
  createdAt: string;
  files: Array<{ path: string; content: string; encoding: "base64"; mode?: number }>;
}

interface SnapshotRun {
  tenantId: string;
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
      imageGeneration?: {
        endpoint: string;
        editsEndpoint: string;
        apiKey?: string;
        model: string;
        responseFormat: "url" | "b64_json";
      };
    },
  ) {}

  async modelContent(snapshot: DurableTurnSnapshot): Promise<readonly ChatContentPart[]> {
    const workspaceRoot = safeWorkspaceRoot(this.options.cwd ?? "/workspace");
    const attachedImages = (await this.repository.inputFiles(snapshot.tenantId, snapshot.id, "turn"))
      .filter((file) => file.mediaType.startsWith("image/"));
    const attachedImageIds = new Set(attachedImages.map((file) => file.fileId));
    const requestedSandboxImages = requestedSandboxImagePaths(snapshot, workspaceRoot)
      .filter((path) => {
        const attachmentId = sandboxAttachmentId(path, workspaceRoot);
        return !attachmentId || !attachedImageIds.has(attachmentId);
      });
    if (requestedSandboxImages.length === 0 && attachedImages.length === 0) return [];

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

    if (requestedSandboxImages.length > 0) {
      const sandbox = await this.ensureSandbox(snapshot);
      for (const path of requestedSandboxImages) {
        if (parts.length >= MAX_MODEL_IMAGES) break;
        const mediaType = binaryMediaType(path);
        if (!mediaType?.startsWith("image/")) continue;
        const source = await this.provider.files.read({
          sandbox_id: sandbox.id,
          path,
          encoding: "base64",
        });
        append(mediaType, Buffer.from(source.content, "base64"));
      }
    }

    if (attachedImages.length > 0) {
      if (!this.objects) throw new Error("Input image object storage is not configured");
      for (const file of attachedImages) {
        if (parts.length >= MAX_MODEL_IMAGES) break;
        if (file.sizeBytes > MAX_MODEL_IMAGE_BYTES) continue;
        const bytes = await this.objects.getSource(file.objectKey, file.objectVersionId);
        if (bytes.byteLength !== file.sizeBytes) {
          throw new Error(`Input image ${file.name} is incomplete`);
        }
        append(file.mediaType, bytes);
      }
    }
    return parts;
  }

  async stageAssociatedInputFiles(snapshot: DurableTurnSnapshot, fileIds: readonly string[]): Promise<readonly {
    fileId: string;
    name: string;
    mediaType: string;
    path: string;
  }[]> {
    const sandbox = await this.ensureSandbox(snapshot);
    const workspaceRoot = safeWorkspaceRoot(this.options.cwd ?? "/workspace");
    const selected = new Set(fileIds);
    const files = (await this.repository.inputFiles(snapshot.tenantId, snapshot.id))
      .filter((file) => selected.has(file.fileId));
    await this.stageInputFiles(snapshot, sandbox.id, this.repository, selected);
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

  async stageSkillPackage(snapshot: DurableTurnSnapshot, packageId: string, files: readonly DurableSkillPackageFile[]): Promise<{ filePath: string; resources: string[] }> {
    const sandbox = await this.ensureSandbox(snapshot);
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
    const readyPath = `${root}/.berry-package-ready`;
    const ready = await this.provider.files.read({ sandbox_id: sandbox.id, path: readyPath, encoding: "utf8" }).catch(() => null);
    if (ready?.content.trim() === revision) {
      return {
        filePath: `${root}/SKILL.md`,
        resources: normalizedFiles.filter((file) => file.path !== "SKILL.md").map((file) => `${root}/${file.path}`),
      };
    }
    for (const file of normalizedFiles) {
      const bytes = file.bytes ?? await loadSkillPackageBytes(file);
      if (bytes.byteLength !== file.sizeBytes || createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
        throw new Error(`Skill package file changed while it was being staged: ${file.path}`);
      }
      const path = `${root}/${file.path}`;
      const mode = file.mode ?? (file.path.startsWith("scripts/") ? 0o755 : 0o644);
      if (this.provider.files.writeBytes) {
        await this.provider.files.writeBytes({ sandbox_id: sandbox.id, path, content: bytes, mode });
      } else {
        await this.provider.files.write({ sandbox_id: sandbox.id, path, content: bytes.toString("base64"), encoding: "base64", mode });
      }
    }
    await this.provider.files.write({ sandbox_id: sandbox.id, path: readyPath, content: revision, encoding: "utf8", mode: 0o444 });
    return {
      filePath: `${root}/SKILL.md`,
      resources: normalizedFiles.filter((file) => file.path !== "SKILL.md").map((file) => `${root}/${file.path}`),
    };
  }

  async execute(snapshot: DurableTurnSnapshot, step: DurableTurnStep): Promise<TurnToolResult> {
    const args = objectValue(step.input.arguments);
    const toolName = stringValue(step.input.toolName) ?? step.type.slice(5);
    if (typeof args.raw === "string") {
      throw new Error(
        `The ${toolName} arguments were incomplete or invalid JSON. Call the tool again with its schema fields directly; do not send a raw wrapper.`,
      );
    }
    validateFileToolArguments(toolName, args);
    const sandbox = await this.ensureSandbox(snapshot);
    const workspaceRoot = safeWorkspaceRoot(this.options.cwd ?? "/workspace");
    if (toolName === "read_file") {
      const path = safeReadablePath(requiredToolPath(args, toolName), workspaceRoot);
      const mediaType = binaryMediaType(path);
      if (mediaType === "application/pdf") {
        const content = await extractPdfText(this.provider, sandbox.id, path, step, workspaceRoot);
        return {
          output: {
            path,
            content,
            mediaType,
            extractedText: true,
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
              : `This is a binary ${mediaType} file. It was not decoded as UTF-8. Use a document-capable skill/tool, or run_command with an appropriate inspection utility.`,
          },
          summary: `Identified ${path} as a binary ${mediaType} file`,
          sandbox,
        };
      }
      const result = await this.provider.files.read({ sandbox_id: sandbox.id, path, encoding: "utf8" });
      return {
        output: { path: result.path, content: result.content, sizeBytes: result.size_bytes },
        summary: `Read ${result.path}`,
        sandbox,
      };
    }
    if (toolName === "list_files") {
      const path = safeReadablePath(requiredToolPath(args, toolName), workspaceRoot);
      const result = await this.provider.files.list({
        sandbox_id: sandbox.id,
        path,
        recursive: args.recursive === true,
      });
      return {
        output: {
          path: result.path,
          entries: result.entries.map((entry) => ({
            path: entry.path,
            type: entry.type,
            sizeBytes: entry.size_bytes,
            mtime: entry.mtime,
          })),
        },
        summary: `Listed ${result.entries.length} entries under ${result.path}`,
        sandbox,
      };
    }
    if (toolName === "write_file") {
      const path = safeWorkspacePath(requiredToolPath(args, toolName), workspaceRoot);
      const content = requiredToolString(args, "content", toolName, true);
      const result = await this.provider.files.write({
        sandbox_id: sandbox.id,
        path,
        content,
        encoding: "utf8",
      });
      return {
        output: { path: result.path, sizeBytes: result.size_bytes, mtime: result.mtime },
        summary: `Wrote ${result.path}`,
        sandbox,
      };
    }
    // Legacy compatibility for append steps persisted before append_file was
    // removed from the model-visible toolset.
    if (toolName === "append_file") {
      const path = safeWorkspacePath(requiredToolPath(args, toolName), workspaceRoot);
      const content = requiredToolString(args, "content", toolName);
      const expectedSizeBytes = numberValue(args.expected_size_bytes);
      if (expectedSizeBytes === null || !Number.isInteger(expectedSizeBytes) || expectedSizeBytes < 0) {
        throw new Error("append_file requires a non-negative integer expected_size_bytes from the previous write result");
      }
      const existing = await this.provider.files.read({ sandbox_id: sandbox.id, path, encoding: "utf8" });
      const appendedBytes = Buffer.byteLength(content, "utf8");
      if (existing.size_bytes === expectedSizeBytes + appendedBytes && existing.content.endsWith(content)) {
        return {
          output: { path: existing.path, sizeBytes: existing.size_bytes, appendedBytes, alreadyApplied: true },
          summary: `Append was already applied to ${existing.path}`,
          sandbox,
        };
      }
      if (existing.size_bytes !== expectedSizeBytes) {
        throw new Error(
          `append_file expected ${expectedSizeBytes} bytes at ${path}, but found ${existing.size_bytes}; read the file before retrying`,
        );
      }
      const result = await this.provider.files.write({
        sandbox_id: sandbox.id,
        path,
        content: existing.content + content,
        encoding: "utf8",
      });
      return {
        output: { path: result.path, sizeBytes: result.size_bytes, appendedBytes, mtime: result.mtime },
        summary: `Appended ${appendedBytes} bytes to ${result.path}`,
        sandbox,
      };
    }
    if (toolName === "edit_file") {
      const path = safeWorkspacePath(requiredToolPath(args, toolName), workspaceRoot);
      const oldString = requiredToolString(args, "old_string", toolName);
      const newString = requiredToolString(args, "new_string", toolName, true);
      const existing = await this.provider.files.read({ sandbox_id: sandbox.id, path, encoding: "utf8" });
      const occurrences = existing.content.split(oldString).length - 1;
      if (occurrences === 0) throw new Error(`old_string was not found in ${path}`);
      if (occurrences > 1 && args.replace_all !== true) {
        throw new Error(`old_string occurs ${occurrences} times in ${path}; set replace_all or provide more context`);
      }
      const content = args.replace_all === true
        ? existing.content.split(oldString).join(newString)
        : existing.content.replace(oldString, newString);
      const written = await this.provider.files.write({ sandbox_id: sandbox.id, path, content, encoding: "utf8" });
      return {
        output: { path: written.path, replacements: args.replace_all === true ? occurrences : 1, sizeBytes: written.size_bytes },
        summary: `Edited ${written.path}`,
        sandbox,
      };
    }
    if (toolName === "apply_patch") {
      const patch = stringValue(args.patch, true);
      if (!patch) throw new Error("apply_patch requires a patch");
      const result = await applySandboxPatch(this.provider, sandbox.id, patch, step.id, workspaceRoot);
      return { output: result, summary: "Applied workspace patch", sandbox };
    }
    if (toolName === "glob") {
      const pattern = stringValue(args.pattern);
      if (!pattern) throw new Error("glob requires a pattern");
      const path = safeReadablePath(stringValue(args.path) ?? workspaceRoot, workspaceRoot);
      const result = await sandboxCommand(this.provider, sandbox.id, step.id, [
        "sh", "-c",
        'root="$1"; pattern="$2"; if command -v rg >/dev/null 2>&1; then cd "$root" && rg --files -g "$pattern"; else find "$root" -type f -print; fi',
        "berry-glob", path, pattern,
      ], workspaceRoot);
      const files = result.split("\n").filter(Boolean).slice(0, 10_000);
      return { output: { path, pattern, files }, summary: `Matched ${files.length} files`, sandbox };
    }
    if (toolName === "grep") {
      const pattern = stringValue(args.pattern, true);
      if (!pattern) throw new Error("grep requires a pattern");
      const path = safeReadablePath(stringValue(args.path) ?? workspaceRoot, workspaceRoot);
      const result = await sandboxCommand(this.provider, sandbox.id, step.id, [
        "sh", "-c",
        'root="$1"; pattern="$2"; ignore="$3"; if command -v rg >/dev/null 2>&1; then [ "$ignore" = 1 ] && flag=-i || flag=; rg -n --column --color never $flag -- "$pattern" "$root" || [ $? -eq 1 ]; else grep -RIn -- "$pattern" "$root" || [ $? -eq 1 ]; fi',
        "berry-grep", path, pattern, args.ignore_case === true ? "1" : "0",
      ], workspaceRoot);
      return { output: { path, pattern, matches: result.slice(0, 1_000_000) }, summary: `Searched ${path}`, sandbox };
    }
    if (toolName === "git_status" || toolName === "git_diff" || toolName === "git_log" || toolName === "git_checkpoint") {
      const command = toolName === "git_status"
        ? ["git", "status", "--short", "--branch"]
        : toolName === "git_diff"
          ? ["git", "diff", "--", ...(stringValue(args.path) ? [safeWorkspacePath(stringValue(args.path)!, workspaceRoot)] : [])]
          : toolName === "git_log"
            ? ["git", "log", `-${Math.min(100, Math.max(1, numberValue(args.limit) ?? 10))}`, "--oneline", "--decorate"]
            : ["sh", "-c", 'git add -A && git commit -m "$1"', "berry-checkpoint", stringValue(args.message) ?? "Berry checkpoint"];
      const output = await sandboxCommand(this.provider, sandbox.id, step.id, command, workspaceRoot);
      return { output: { command: toolName, output }, summary: `${toolName} completed`, sandbox };
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
        const source = await this.provider.files.read({ sandbox_id: sandbox.id, path, encoding: "base64" });
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
    if (toolName === "run_command") {
      const command = stringValue(args.command);
      if (!command) throw new Error("run_command requires a command");
      const output: string[] = [];
      let exitCode: number | null = null;
      for await (const event of this.provider.exec({
        sandbox_id: sandbox.id,
        request_id: step.idempotencyKey ?? step.id,
        command: ["bash", "-lc", command],
        cwd: workspaceRoot,
        timeout_ms: numberValue(args.timeoutMs) ?? 120_000,
      })) {
        if (event.kind === "stdout") output.push(event.data);
        else if (event.kind === "stderr") output.push(event.data);
        else if (event.kind === "exit") exitCode = event.exit_code;
        else if (event.kind === "error") throw new Error(event.message);
      }
      const text = output.join("").slice(0, 1_000_000);
      if (exitCode !== 0) throw new Error(`Command exited with ${exitCode ?? "unknown"}: ${text.slice(-4_000)}`);
      return {
        output: { command, exitCode, output: text },
        summary: `Command completed with exit code ${exitCode ?? 0}`,
        sandbox,
      };
    }
    throw new Error(`Unsupported durable tool: ${toolName}`);
  }

  async finalize(snapshot: DurableTurnSnapshot): Promise<readonly TurnToolResult[]> {
    if (!snapshot.sandboxId || !this.objects) return [];
    const sandbox = await this.ensureSandbox(snapshot);
    const workspaceRoot = safeWorkspaceRoot(this.options.cwd ?? "/workspace");
    let listed;
    try {
      listed = await this.provider.files.list({ sandbox_id: sandbox.id, path: `${workspaceRoot}/outputs`, recursive: true });
    } catch {
      return [];
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
      const fileId = randomUUID();
      const stored = await this.objects.putArtifact(
        `tenants/${snapshot.tenantId}/users/${snapshot.userId}/files/auto/${fileId}/${sha256}/${name}`,
        bytes,
        mediaType,
      );
      const output = await this.repository.persistOutput({
        snapshot, fileId, name, mediaType, sizeBytes: bytes.byteLength, sha256,
        bucket: stored.bucket, objectKey: stored.key, etag: stored.etag,
        ...(stored.objectVersionId !== undefined ? { objectVersionId: stored.objectVersionId } : {}),
        sourcePath: path,
      });
      results.push({
        output: { text: `Published artifact: ${name}`, artifact: { kind: "file", path: `/v1/files/${output.fileId}/content`, name, mediaType, size: bytes.byteLength, fileId: output.fileId } },
        summary: `Published ${name}`,
        sandbox,
      });
    }
    return results;
  }

  async snapshot(payload: SandboxSnapshotJobPayload): Promise<{ noOp: boolean; snapshotId?: string }> {
    const candidate = await this.repository.loadRun(payload.tenantId, payload.runId);
    if (!candidate.sandboxId) return { noOp: true };
    const preserveWithLock = async (repository: SandboxSnapshotRepository) => {
      const run = await repository.loadRun(payload.tenantId, payload.runId);
      if (!run.sandboxId || run.sandboxId !== candidate.sandboxId) return { noOp: true };
      const terminal = payload.reason === "before-finalize";
      const beforeWait = payload.reason === "before-wait";
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

  private async ensureSandbox(snapshot: DurableTurnSnapshot): Promise<{ provider: string; id: string; state: string }> {
    if (snapshot.sandboxId) {
      try {
        return await this.withSandboxLifecycleLock(snapshot.tenantId, snapshot.sandboxId, async (repository) => {
          if (this.provider.supportsResume !== false) {
            await this.provider.resume?.({
              sandbox_id: snapshot.sandboxId!,
              reason: "Durable turn requested sandbox access",
            });
          }
          await this.provider.files.list({
            sandbox_id: snapshot.sandboxId!,
            path: this.options.cwd ?? "/workspace",
            recursive: false,
          });
          // The in-memory staged-file set is intentionally process-local. On
          // worker restart or lease handoff, re-stage the run's durable input
          // associations before a tool is allowed to execute.
          await this.stageInputFiles(snapshot, snapshot.sandboxId!, repository);
          await repository.recordSandbox({
            tenantId: snapshot.tenantId,
            runId: snapshot.id,
            provider: snapshot.sandboxProvider ?? this.provider.kind,
            sandboxId: snapshot.sandboxId!,
            state: "running",
          });
          return { provider: snapshot.sandboxProvider ?? this.provider.kind, id: snapshot.sandboxId!, state: "running" };
        });
      } catch {
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
            await this.provider.resume?.({
              sandbox_id: continuity.sandboxId!,
              reason: "Follow-up turn requested the prior sandbox",
            });
          }
          await this.provider.files.list({
            sandbox_id: continuity.sandboxId!,
            path: this.options.cwd ?? "/workspace",
            recursive: false,
          });
          await this.stageInputFiles(snapshot, continuity.sandboxId!, repository);
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
      } catch {
        // The previous turn's sandbox expired. Restore its durable archive below.
      }
    }
    const handle = await this.provider.create({
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
    });
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
        });
      }
    }
    await this.stageInputFiles(snapshot, handle.sandbox_id);
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
  ): Promise<void> {
    const staged = this.#stagedInputFileIds.get(sandboxId) ?? new Set<string>();
    this.#stagedInputFileIds.set(sandboxId, staged);
    const files = (await repository.inputFiles(snapshot.tenantId, snapshot.id))
      .filter((file) => (!selectedFileIds || selectedFileIds.has(file.fileId)) && !staged.has(file.fileId));
    if (files.length === 0) return;
    if (!this.objects) throw new Error("Input file object storage is not configured");
    for (const file of files) {
      const maxInputBytes = this.options.maxInputBytes ?? DEFAULT_SANDBOX_INPUT_MAX_BYTES;
      if (file.sizeBytes > maxInputBytes) throw new Error(`Input file ${file.name} exceeds the sandbox input limit`);
      const workspaceRoot = safeWorkspaceRoot(this.options.cwd ?? "/workspace");
      const path = durableAttachmentPath({ fileId: file.fileId, name: file.name }, workspaceRoot);
      await this.prepareSandboxDirectory(snapshot.id, sandboxId, path, file.name, workspaceRoot);
      await this.truncateSandboxFile(snapshot.id, sandboxId, path, file.name);
      const source = this.objects.streamSource
        ? this.objects.streamSource(file.objectKey, maxInputBytes, file.objectVersionId)
        : singleChunk(await this.objects.getSource(file.objectKey, file.objectVersionId));
      let written = 0;
      for await (const sourceChunk of source) {
        for (let offset = 0; offset < sourceChunk.byteLength; offset += 256 * 1024) {
          const chunk = sourceChunk.subarray(offset, Math.min(sourceChunk.byteLength, offset + 256 * 1024));
          written += chunk.byteLength;
          if (written > maxInputBytes || written > file.sizeBytes) {
            throw new Error(`Input file ${file.name} exceeds its validated size`);
          }
          await this.appendSandboxChunk(snapshot.id, sandboxId, path, file.name, chunk, written);
        }
      }
      if (written !== file.sizeBytes) throw new Error(`Input file ${file.name} is incomplete`);
      staged.add(file.fileId);
    }
  }

  private async truncateSandboxFile(
    runId: string,
    sandboxId: string,
    path: string,
    name: string,
  ): Promise<void> {
    for await (const event of this.provider.exec({
      sandbox_id: sandboxId,
      request_id: `${runId}:stage:truncate:${createHash("sha256").update(path).digest("hex").slice(0, 16)}`,
      command: ["sh", "-c", ': > "$1"', "berry-stage", path],
      timeout_ms: 30_000,
    })) {
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
  ): Promise<void> {
    const directoryOutput: string[] = [];
    for await (const event of this.provider.exec({
      sandbox_id: sandboxId,
      request_id: `${runId}:stage:mkdir:${createHash("sha256").update(path).digest("hex").slice(0, 16)}`,
      command: ["mkdir", "-p", path.slice(0, path.lastIndexOf("/"))],
      ...(cwd ? { cwd } : {}),
      timeout_ms: 30_000,
    })) {
      if (event.kind === "stdout" || event.kind === "stderr") directoryOutput.push(event.data);
      if (event.kind === "error") throw new Error(event.message);
      if (event.kind === "exit" && event.exit_code !== 0) {
        const detail = directoryOutput.join("").trim().slice(-2_000);
        throw new Error(`Unable to prepare the sandbox directory for ${name}${detail ? `: ${detail}` : ""}`);
      }
    }
  }

  private async setSandboxFileMode(runId: string, sandboxId: string, path: string, name: string, mode: number): Promise<void> {
    for await (const event of this.provider.exec({
      sandbox_id: sandboxId,
      request_id: `${runId}:stage:chmod:${createHash("sha256").update(path).digest("hex").slice(0, 16)}`,
      command: ["chmod", mode.toString(8), "--", path],
      timeout_ms: 30_000,
    })) {
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
    })) {
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

function requestedSandboxImagePaths(snapshot: DurableTurnSnapshot, workspaceRoot = "/workspace"): string[] {
  const paths = snapshot.steps.flatMap((step) => {
    if (step.state !== "completed") return [];
    const toolName = stringValue(step.input.toolName) ?? step.type.slice(5);
    if (toolName !== "read_file" && toolName !== "create_image") return [];
    const output = objectValue(step.output);
    const path = stringValue(output.visionPath);
    if (!path) return [];
    return binaryMediaType(path)?.startsWith("image/") ? [path] : [];
  });
  return [...new Set(paths)].slice(-MAX_MODEL_IMAGES).reverse();
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
SELECT r.tenant_id,r.id AS run_id,r.session_id,r.task_id,r.state AS run_state,
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
WITH current_run AS (
  SELECT tenant_id,id,session_id,created_at
  FROM turn_runs
  WHERE tenant_id=$1::uuid AND id=$2::uuid
)
SELECT prior.sandbox_provider,prior.sandbox_id,
       archived.id AS snapshot_id,archived.object_key,archived.content_hash,archived.sequence
FROM current_run current_run_row
LEFT JOIN LATERAL (
  SELECT r.sandbox_provider,r.sandbox_id
  FROM turn_runs r
  WHERE r.tenant_id=current_run_row.tenant_id
    AND r.session_id=current_run_row.session_id
    AND r.id<>current_run_row.id
    AND r.created_at<=current_run_row.created_at
    AND r.sandbox_id IS NOT NULL
  ORDER BY r.created_at DESC,r.id DESC
  LIMIT 1
) prior ON true
LEFT JOIN LATERAL (
  SELECT s.id,s.object_key,s.content_hash,s.sequence
  FROM sandbox_snapshots s
  WHERE s.tenant_id=current_run_row.tenant_id
    AND s.session_id=current_run_row.session_id
    AND s.status='complete'
  ORDER BY s.completed_at DESC NULLS LAST,s.sequence DESC
  LIMIT 1
) archived ON true
      `.trim(),
      [tenantId, runId],
    );
    const row = rows[0];
    if (!row || (!row.sandbox_id && !row.snapshot_id)) return null;
    return {
      provider: row.sandbox_provider,
      sandboxId: row.sandbox_id,
      snapshot: row.snapshot_id && row.object_key && row.content_hash && row.sequence !== null
        ? mapSnapshot({
          id: row.snapshot_id,
          object_key: row.object_key,
          content_hash: row.content_hash,
          sequence: row.sequence,
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
  AND f.status IN ('processing', 'available', 'failed')
  AND f.deleted_at IS NULL
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
  AND f.metadata->>'sourcePath' IS NOT NULL
  AND COALESCE(blob.sha256, f.sha256) IS NOT NULL
      `.trim(),
      [tenantId, sessionId],
    );
    return rows.map((row) => ({ sourcePath: row.source_path, sha256: row.sha256 }));
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
): Promise<string> {
  const output: string[] = [];
  let exitCode: number | null = null;
  for await (const event of provider.exec({
    sandbox_id: sandboxId,
    request_id: requestId,
    command,
    cwd,
    timeout_ms: 120_000,
  })) {
    if (event.kind === "stdout" || event.kind === "stderr") output.push(event.data);
    else if (event.kind === "exit") exitCode = event.exit_code;
    else if (event.kind === "error") throw new Error(event.message);
  }
  const text = output.join("").slice(0, 1_000_000);
  if (exitCode !== 0) throw new Error(`Command exited with ${exitCode ?? "unknown"}: ${text.slice(-4_000)}`);
  return text;
}

async function applySandboxPatch(
  provider: SandboxProvider,
  sandboxId: string,
  patch: string,
  requestId: string,
  workspaceRoot: string,
): Promise<JsonValue> {
  const operations = parsePatch(patch);
  const result = { added: [] as string[], updated: [] as string[], deleted: [] as string[] };
  for (const operation of operations) {
    const target = safeWorkspacePath(operation.path, workspaceRoot);
    if (operation.kind === "add") {
      await provider.files.write({ sandbox_id: sandboxId, path: target, content: operation.content, encoding: "utf8" });
      result.added.push(operation.path);
      continue;
    }
    if (operation.kind === "delete") {
      await sandboxCommand(provider, sandboxId, `${requestId}:delete`, ["rm", "--", target], workspaceRoot);
      result.deleted.push(operation.path);
      continue;
    }
    const existing = await provider.files.read({ sandbox_id: sandboxId, path: target, encoding: "utf8" });
    const content = applyPatchHunks(operation.path, existing.content, operation.hunks);
    const destination = operation.moveTo ? safeWorkspacePath(operation.moveTo, workspaceRoot) : target;
    await provider.files.write({ sandbox_id: sandboxId, path: destination, content, encoding: "utf8" });
    if (operation.moveTo) {
      await sandboxCommand(provider, sandboxId, `${requestId}:move`, ["rm", "--", target], workspaceRoot);
      result.updated.push(operation.moveTo);
    } else {
      result.updated.push(operation.path);
    }
  }
  return result;
}

function applyPatchHunks(path: string, content: string, hunks: PatchHunk[]): string {
  let lines = content.split("\n");
  let searchFrom = 0;
  for (const hunk of hunks) {
    const anchor = hunk.removed.length > 0 ? hunk.removed : hunk.context;
    if (anchor.length === 0) {
      lines = [...lines, ...hunk.added];
      continue;
    }
    const index = findLineSequence(lines, anchor, searchFrom);
    if (index < 0) throw new Error(`Could not locate patch hunk in ${path}:\n${anchor.join("\n")}`);
    if (hunk.removed.length > 0) {
      lines.splice(index, hunk.removed.length, ...hunk.added);
      searchFrom = index + hunk.added.length;
    } else {
      const insertAt = index + anchor.length;
      lines.splice(insertAt, 0, ...hunk.added);
      searchFrom = insertAt + hunk.added.length;
    }
  }
  return lines.join("\n");
}

function findLineSequence(haystack: string[], needle: string[], from: number): number {
  outer: for (let index = from; index <= haystack.length - needle.length; index += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) continue outer;
    }
    return index;
  }
  return from > 0 ? findLineSequence(haystack, needle, 0) : -1;
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

function validateFileToolArguments(toolName: string, args: Record<string, unknown>): void {
  if (toolName === "read_file" || toolName === "list_files") {
    requiredToolPath(args, toolName);
    return;
  }
  if (toolName === "write_file") {
    requiredToolPath(args, toolName);
    requiredToolString(args, "content", toolName, true);
    return;
  }
  if (toolName === "append_file") {
    requiredToolPath(args, toolName);
    requiredToolString(args, "content", toolName);
    const expectedSizeBytes = numberValue(args.expected_size_bytes);
    if (expectedSizeBytes === null || !Number.isInteger(expectedSizeBytes) || expectedSizeBytes < 0) {
      throw new Error("append_file requires a non-negative integer expected_size_bytes from the previous write result");
    }
    return;
  }
  if (toolName === "edit_file") {
    requiredToolPath(args, toolName);
    requiredToolString(args, "old_string", toolName);
    requiredToolString(args, "new_string", toolName, true);
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
  })) {
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
  snapshot_id: string | null;
  object_key: string | null;
  content_hash: string | null;
  sequence: number | string | null;
}

interface SandboxInputFileRow {
  file_id: string;
  display_name: string;
  media_type: string;
  size_bytes: number | string;
  object_key: string;
  object_version_id: string | null;
}
