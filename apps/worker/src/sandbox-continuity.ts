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
import { DEFAULT_SANDBOX_INPUT_MAX_BYTES, type JsonValue } from "@berry/shared";
import { parsePatch, type PatchHunk } from "@berry/local-agent";
import { durableAttachmentPath } from "./durable-attachments.js";
import type { SandboxSnapshotJobPayload } from "./jobs.js";
import type { SqlExecutor } from "./sql-repositories.js";
import type {
  DurableTurnSnapshot,
  DurableTurnStep,
  DurableTurnToolExecutor,
  TurnToolResult,
} from "./turn-runner.js";

const MAX_SNAPSHOT_ARCHIVE_BYTES = 384 * 1024 * 1024;
const MAX_MODEL_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_MODEL_IMAGE_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_MODEL_IMAGES = 5;

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
}

interface SandboxOutputFile {
  fileId: string;
  name: string;
  mediaType: string;
  sizeBytes: number;
  objectKey: string;
}

export interface SandboxSnapshotRepository {
  loadRun(tenantId: string, runId: string): Promise<SnapshotRun>;
  continuity(tenantId: string, runId: string): Promise<SessionContinuityRecord | null>;
  inputFiles(tenantId: string, runId: string, scope?: "turn" | "session"): Promise<readonly SandboxInputFile[]>;
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
}

export interface SandboxSnapshotObjectStore {
  put(key: string, body: Uint8Array): Promise<void>;
  putArtifact(key: string, body: Uint8Array, mediaType: string): Promise<{
    bucket: string;
    key: string;
    etag: string | null;
  }>;
  get(key: string): Promise<Uint8Array>;
  getSource(key: string): Promise<Uint8Array>;
  streamSource?(key: string, maxBytes: number): AsyncIterable<Uint8Array>;
}

export class SandboxContinuityManager implements DurableTurnToolExecutor {
  constructor(
    private readonly provider: SandboxProvider,
    private readonly repository: SandboxSnapshotRepository,
    private readonly objects: SandboxSnapshotObjectStore | null,
    private readonly options: {
      image: string;
      cwd?: string;
      ttlSeconds?: number;
      maxInputBytes?: number;
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
    const requestedSandboxImages = requestedSandboxImagePaths(snapshot);
    const attachedImages = (await this.repository.inputFiles(snapshot.tenantId, snapshot.id, "turn"))
      .filter((file) => file.mediaType.startsWith("image/"));
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
        const bytes = await this.objects.getSource(file.objectKey);
        if (bytes.byteLength !== file.sizeBytes) {
          throw new Error(`Input image ${file.name} is incomplete`);
        }
        append(file.mediaType, bytes);
      }
    }
    return parts;
  }

  async execute(snapshot: DurableTurnSnapshot, step: DurableTurnStep): Promise<TurnToolResult> {
    const sandbox = await this.ensureSandbox(snapshot);
    const args = objectValue(step.input.arguments);
    const toolName = stringValue(step.input.toolName) ?? step.type.slice(5);
    if (toolName === "read_file") {
      const path = safeReadablePath(stringValue(args.path) ?? "");
      const mediaType = binaryMediaType(path);
      if (mediaType === "application/pdf") {
        const content = await extractPdfText(this.provider, sandbox.id, path, step);
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
      const path = safeReadablePath(stringValue(args.path) ?? "/workspace");
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
      const path = safeWorkspacePath(stringValue(args.path) ?? "");
      const content = stringValue(args.content, true) ?? "";
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
    if (toolName === "edit_file") {
      const path = safeWorkspacePath(stringValue(args.path) ?? "");
      const oldString = stringValue(args.old_string, true);
      const newString = stringValue(args.new_string, true) ?? "";
      if (oldString === null || oldString.length === 0) throw new Error("edit_file requires a non-empty old_string");
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
      const result = await applySandboxPatch(this.provider, sandbox.id, patch, step.id);
      return { output: result, summary: "Applied workspace patch", sandbox };
    }
    if (toolName === "glob") {
      const pattern = stringValue(args.pattern);
      if (!pattern) throw new Error("glob requires a pattern");
      const path = safeReadablePath(stringValue(args.path) ?? "/workspace");
      const result = await sandboxCommand(this.provider, sandbox.id, step.id, [
        "sh", "-c",
        'root="$1"; pattern="$2"; if command -v rg >/dev/null 2>&1; then cd "$root" && rg --files -g "$pattern"; else find "$root" -type f -print; fi',
        "berry-glob", path, pattern,
      ], this.options.cwd ?? "/workspace");
      const files = result.split("\n").filter(Boolean).slice(0, 10_000);
      return { output: { path, pattern, files }, summary: `Matched ${files.length} files`, sandbox };
    }
    if (toolName === "grep") {
      const pattern = stringValue(args.pattern, true);
      if (!pattern) throw new Error("grep requires a pattern");
      const path = safeReadablePath(stringValue(args.path) ?? "/workspace");
      const result = await sandboxCommand(this.provider, sandbox.id, step.id, [
        "sh", "-c",
        'root="$1"; pattern="$2"; ignore="$3"; if command -v rg >/dev/null 2>&1; then [ "$ignore" = 1 ] && flag=-i || flag=; rg -n --column --color never $flag -- "$pattern" "$root" || [ $? -eq 1 ]; else grep -RIn -- "$pattern" "$root" || [ $? -eq 1 ]; fi',
        "berry-grep", path, pattern, args.ignore_case === true ? "1" : "0",
      ], this.options.cwd ?? "/workspace");
      return { output: { path, pattern, matches: result.slice(0, 1_000_000) }, summary: `Searched ${path}`, sandbox };
    }
    if (toolName === "git_status" || toolName === "git_diff" || toolName === "git_log" || toolName === "git_checkpoint") {
      const command = toolName === "git_status"
        ? ["git", "status", "--short", "--branch"]
        : toolName === "git_diff"
          ? ["git", "diff", "--", ...(stringValue(args.path) ? [safeWorkspacePath(stringValue(args.path)!)] : [])]
          : toolName === "git_log"
            ? ["git", "log", `-${Math.min(100, Math.max(1, numberValue(args.limit) ?? 10))}`, "--oneline", "--decorate"]
            : ["sh", "-c", 'git add -A && git commit -m "$1"', "berry-checkpoint", stringValue(args.message) ?? "Berry checkpoint"];
      const output = await sandboxCommand(this.provider, sandbox.id, step.id, command, this.options.cwd ?? "/workspace");
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
        const path = safeReadablePath(reference);
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
      const path = `/workspace/outputs/${title}.png`;
      await this.provider.files.write({ sandbox_id: sandbox.id, path, content: bytes.toString("base64"), encoding: "base64" });
      if (!this.objects) throw new Error("Artifact object storage is not configured");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const stored = await this.objects.putArtifact(
        `tenants/${snapshot.tenantId}/users/${snapshot.userId}/files/${step.id}/original/${title}.png`,
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
      const path = safeOutputPath(stringValue(args.path) ?? "");
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
        `tenants/${snapshot.tenantId}/users/${snapshot.userId}/files/${step.id}/original/${name}`,
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
        command: ["sh", "-lc", command],
        cwd: this.options.cwd ?? "/workspace",
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
    let listed;
    try {
      listed = await this.provider.files.list({ sandbox_id: snapshot.sandboxId, path: "/workspace/outputs", recursive: true });
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
      return path ? [safeOutputPath(path)] : [];
    }));
    const results: TurnToolResult[] = [];
    for (const entry of listed.entries) {
      if (entry.type !== "file" || explicitlyPersisted.has(entry.path) || !isDurableArtifact(entry.path)) continue;
      const path = safeOutputPath(entry.path);
      const source = await this.provider.files.read({ sandbox_id: snapshot.sandboxId, path, encoding: "base64" });
      const bytes = Buffer.from(source.content, "base64");
      if (bytes.byteLength === 0) continue;
      const name = safeArtifactName(path.split("/").at(-1) ?? "artifact");
      const mediaType = durableArtifactMediaType(name);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const fileId = randomUUID();
      const stored = await this.objects.putArtifact(
        `tenants/${snapshot.tenantId}/users/${snapshot.userId}/files/auto/${sha256}/${name}`,
        bytes,
        mediaType,
      );
      const output = await this.repository.persistOutput({
        snapshot, fileId, name, mediaType, sizeBytes: bytes.byteLength, sha256,
        bucket: stored.bucket, objectKey: stored.key, etag: stored.etag, sourcePath: path,
      });
      results.push({
        output: { text: `Published artifact: ${name}`, artifact: { kind: "file", path: `/v1/files/${output.fileId}/content`, name, mediaType, size: bytes.byteLength, fileId: output.fileId } },
        summary: `Published ${name}`,
        sandbox: { provider: this.provider.kind, id: snapshot.sandboxId, state: snapshot.sandboxState ?? "running" },
      });
    }
    return results;
  }

  async snapshot(payload: SandboxSnapshotJobPayload): Promise<{ noOp: boolean; snapshotId?: string }> {
    const run = await this.repository.loadRun(payload.tenantId, payload.runId);
    if (!run.sandboxId) return { noOp: true };
    try {
      const archive = await this.capture(run.sandboxId);
      const bytes = Buffer.from(JSON.stringify(archive));
      const contentHash = createHash("sha256")
        .update(JSON.stringify({ version: archive.version, files: archive.files }))
        .digest("hex");
      const prior = await this.repository.latest(payload.tenantId, payload.runId);
      if (prior?.contentHash === contentHash) return { noOp: true, snapshotId: prior.id };
      if (!this.objects) throw new Error("Sandbox snapshot object storage is not configured");
      const key = `sandbox-snapshots/${payload.tenantId}/${payload.runId}/${contentHash}.json`;
      await this.objects.put(key, bytes);
      const record = await this.repository.persist({
        run,
        provider: run.sandboxProvider ?? this.provider.kind,
        sandboxId: run.sandboxId,
        objectKey: key,
        contentHash,
      });
      return { noOp: false, snapshotId: record.id };
    } finally {
      if (payload.reason === "before-finalize" && this.provider.suspend) {
        const result = await this.provider.suspend({
          sandbox_id: run.sandboxId,
          reason: "Terminal turn snapshot completed",
        });
        await this.repository.recordSandbox({
          tenantId: payload.tenantId,
          runId: payload.runId,
          provider: run.sandboxProvider ?? this.provider.kind,
          sandboxId: run.sandboxId,
          state: result.status === "missing" ? "missing" : "paused",
        });
      }
    }
  }

  private async ensureSandbox(snapshot: DurableTurnSnapshot): Promise<{ provider: string; id: string; state: string }> {
    if (snapshot.sandboxId) {
      try {
        await this.provider.files.list({
          sandbox_id: snapshot.sandboxId,
          path: this.options.cwd ?? "/workspace",
          recursive: false,
        });
        return { provider: snapshot.sandboxProvider ?? this.provider.kind, id: snapshot.sandboxId, state: "running" };
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
        await this.provider.files.list({
          sandbox_id: continuity.sandboxId,
          path: this.options.cwd ?? "/workspace",
          recursive: false,
        });
        await this.stageInputFiles(snapshot, continuity.sandboxId);
        await this.repository.recordSandbox({
          tenantId: snapshot.tenantId,
          runId: snapshot.id,
          provider: continuity.provider ?? this.provider.kind,
          sandboxId: continuity.sandboxId,
          state: "running",
        });
        return {
          provider: continuity.provider ?? this.provider.kind,
          id: continuity.sandboxId,
          state: "running",
        };
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
    if (restorePoint && this.objects) {
      const archive = JSON.parse(Buffer.from(await this.objects.get(restorePoint.objectKey)).toString("utf8")) as SnapshotArchive;
      for (const file of archive.files) {
        await this.provider.files.write({
          sandbox_id: handle.sandbox_id,
          path: safeWorkspacePath(file.path),
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

  private async stageInputFiles(snapshot: DurableTurnSnapshot, sandboxId: string): Promise<void> {
    const files = await this.repository.inputFiles(snapshot.tenantId, snapshot.id);
    if (files.length === 0) return;
    if (!this.objects) throw new Error("Input file object storage is not configured");
    for (const file of files) {
      const maxInputBytes = this.options.maxInputBytes ?? DEFAULT_SANDBOX_INPUT_MAX_BYTES;
      if (file.sizeBytes > maxInputBytes) throw new Error(`Input file ${file.name} exceeds the sandbox input limit`);
      const path = durableAttachmentPath({ fileId: file.fileId, name: file.name });
      for await (const event of this.provider.exec({
        sandbox_id: sandboxId,
        request_id: `${snapshot.id}:stage:${file.fileId}`,
        command: ["mkdir", "-p", path.slice(0, path.lastIndexOf("/"))],
        timeout_ms: 30_000,
      })) {
        if (event.kind === "error") throw new Error(event.message);
        if (event.kind === "exit" && event.exit_code !== 0) {
          throw new Error(`Unable to prepare the sandbox directory for ${file.name}`);
        }
      }
      await this.truncateSandboxFile(snapshot.id, sandboxId, path, file.name);
      const source = this.objects.streamSource
        ? this.objects.streamSource(file.objectKey, maxInputBytes)
        : singleChunk(await this.objects.getSource(file.objectKey));
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

  private async capture(sandboxId: string): Promise<SnapshotArchive> {
    const root = this.options.cwd ?? "/workspace";
    const list = await this.provider.files.list({ sandbox_id: sandboxId, path: root, recursive: true });
    const files: SnapshotArchive["files"] = [];
    let total = 0;
    for (const entry of list.entries) {
      if (entry.type !== "file" || excludedSnapshotPath(entry.path, root)) continue;
      if (entry.size_bytes > 25 * 1024 * 1024) continue;
      total += entry.size_bytes;
      if (total > 250 * 1024 * 1024) throw new Error("Sandbox snapshot exceeds the 250 MB safety limit");
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

function requestedSandboxImagePaths(snapshot: DurableTurnSnapshot): string[] {
  const paths = snapshot.steps.flatMap((step) => {
    if (step.state !== "completed") return [];
    const toolName = stringValue(step.input.toolName) ?? step.type.slice(5);
    if (toolName !== "read_file" && toolName !== "create_image") return [];
    const output = objectValue(step.output);
    const path = stringValue(output.visionPath);
    if (!path || path.startsWith("/workspace/inputs/")) return [];
    return binaryMediaType(path)?.startsWith("image/") ? [path] : [];
  });
  return [...new Set(paths)].slice(-MAX_MODEL_IMAGES).reverse();
}

export class SqlSandboxSnapshotRepository implements SandboxSnapshotRepository {
  constructor(private readonly executor: SqlExecutor) {}

  async loadRun(tenantId: string, runId: string): Promise<SnapshotRun> {
    const rows = await this.executor.query<SnapshotRunRow>(
      `
SELECT r.tenant_id,r.id AS run_id,r.session_id,r.task_id,r.sandbox_provider,r.sandbox_id,
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
SELECT DISTINCT f.id AS file_id,f.display_name,f.media_type,f.size_bytes,f.object_key
FROM turn_runs r
JOIN file_associations a
  ON a.tenant_id=r.tenant_id AND a.session_id=r.session_id AND a.role='input'
  AND a.created_at<=r.created_at
  AND ($3::text='session' OR a.message_id=r.request_message_id)
JOIN files f
  ON f.tenant_id=a.tenant_id AND f.id=a.file_id
WHERE r.tenant_id=$1::uuid AND r.id=$2::uuid
  AND f.status IN ('processing', 'available', 'failed')
  AND f.deleted_at IS NULL
  AND (
    EXISTS (
      SELECT 1
      FROM file_uploads u
      WHERE u.tenant_id=f.tenant_id AND u.file_id=f.id AND u.status='completed'
    )
    OR (
      f.origin IN ('sandbox_output','image_generation','browser_capture','legacy_artifact')
      AND f.status='available'
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
    origin?: "sandbox_output" | "image_generation";
    sourcePath?: string;
  }): Promise<SandboxOutputFile> {
    const run = async (executor: SqlExecutor): Promise<SandboxOutputFile> => {
      const rows = await executor.query<{ id: string }>(
        `
INSERT INTO files (
  id,tenant_id,owner_user_id,original_name,display_name,media_type,size_bytes,
  sha256,bucket,object_key,etag,origin,status,metadata
) VALUES (
  $1::uuid,$2::uuid,$3::uuid,$4,$4,$5,$6,$7,$8,$9,$10,
  $11,'available',$12::jsonb
)
ON CONFLICT (tenant_id,object_key) DO UPDATE SET
  owner_user_id=excluded.owner_user_id,
  display_name=excluded.display_name,
  media_type=excluded.media_type,
  size_bytes=excluded.size_bytes,
  sha256=excluded.sha256,
  etag=excluded.etag,
  status='available',
  metadata=excluded.metadata,
  updated_at=now()
RETURNING id
        `.trim(),
        [
          input.fileId,
          input.snapshot.tenantId,
          input.snapshot.userId,
          input.name,
          input.mediaType,
          input.sizeBytes,
          input.sha256,
          input.bucket,
          input.objectKey,
          input.etag,
          input.origin ?? "sandbox_output",
          JSON.stringify({ source: "durable-sandbox", runId: input.snapshot.id, ...(input.sourcePath ? { sourcePath: input.sourcePath } : {}) }),
        ],
      );
      const fileId = rows[0]?.id;
      if (!fileId) throw new Error("Unable to register the sandbox artifact");
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
    if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
    return new S3SandboxSnapshotObjectStore(
      new S3Client({
        endpoint,
        region: env.BERRY_ARTIFACT_S3_REGION ?? "us-east-1",
        forcePathStyle: true,
        credentials: { accessKeyId, secretAccessKey },
      }),
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
    };
  }

  async get(key: string): Promise<Uint8Array> {
    return this.readObject(this.snapshotKey(key), MAX_SNAPSHOT_ARCHIVE_BYTES, "Sandbox snapshot");
  }

  async getSource(key: string): Promise<Uint8Array> {
    return this.readObject(key, this.maxSourceBytes, "Input file");
  }

  private async readObject(key: string, maxBytes: number, label: string): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of this.streamKey(key, maxBytes, label)) {
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

  async *streamSource(key: string, maxBytes: number): AsyncIterable<Uint8Array> {
    yield* this.streamKey(key, maxBytes, "Input file");
  }

  private async *streamKey(key: string, maxBytes: number, label: string): AsyncIterable<Uint8Array> {
    const result = await this.client.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
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
): Promise<JsonValue> {
  const operations = parsePatch(patch);
  const result = { added: [] as string[], updated: [] as string[], deleted: [] as string[] };
  for (const operation of operations) {
    const target = safeWorkspacePath(operation.path);
    if (operation.kind === "add") {
      await provider.files.write({ sandbox_id: sandboxId, path: target, content: operation.content, encoding: "utf8" });
      result.added.push(operation.path);
      continue;
    }
    if (operation.kind === "delete") {
      await sandboxCommand(provider, sandboxId, `${requestId}:delete`, ["rm", "--", target], "/workspace");
      result.deleted.push(operation.path);
      continue;
    }
    const existing = await provider.files.read({ sandbox_id: sandboxId, path: target, encoding: "utf8" });
    const content = applyPatchHunks(operation.path, existing.content, operation.hunks);
    const destination = operation.moveTo ? safeWorkspacePath(operation.moveTo) : target;
    await provider.files.write({ sandbox_id: sandboxId, path: destination, content, encoding: "utf8" });
    if (operation.moveTo) {
      await sandboxCommand(provider, sandboxId, `${requestId}:move`, ["rm", "--", target], "/workspace");
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
  return parts.some((part) => [
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

function safeWorkspacePath(value: string): string {
  return safeSandboxPath(value, ["workspace"], "Sandbox writes must remain under /workspace");
}

function safeReadablePath(value: string): string {
  return safeSandboxPath(
    value,
    ["workspace", "managed-skills"],
    "Sandbox reads must remain under /workspace or /managed-skills",
  );
}

function safeOutputPath(value: string): string {
  const path = safeWorkspacePath(value);
  if (!path.startsWith("/workspace/outputs/") && !path.startsWith("/workspace/output/")) {
    throw new Error("Artifacts must be created under /workspace/outputs");
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

function safeSandboxPath(value: string, roots: readonly string[], errorMessage: string): string {
  const normalized = value.trim().replaceAll("\\", "/");
  const absolute = normalized.startsWith("/") ? normalized : `/workspace/${normalized}`;
  const parts = absolute.split("/").filter(Boolean);
  if (!parts[0] || !roots.includes(parts[0]) || parts.includes("..") || parts.includes(".")) {
    throw new Error(errorMessage);
  }
  return `/${parts.join("/")}`;
}

async function extractPdfText(
  provider: SandboxProvider,
  sandboxId: string,
  path: string,
  step: DurableTurnStep,
): Promise<string> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let exitCode: number | null = null;
  for await (const event of provider.exec({
    sandbox_id: sandboxId,
    request_id: `${step.idempotencyKey ?? step.id}:pdf-text`,
    command: ["pdftotext", "-layout", path, "-"],
    cwd: "/workspace",
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

function mapSnapshot(row: SnapshotRow): SnapshotRecord {
  return {
    id: row.id,
    objectKey: row.object_key,
    contentHash: row.content_hash,
    sequence: Number(row.sequence),
  };
}

interface SnapshotRunRow {
  tenant_id: string;
  run_id: string;
  session_id: string;
  task_id: string;
  sandbox_provider: string | null;
  sandbox_id: string | null;
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
}
