import { createHash } from "node:crypto";
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
import type { ChatContentPart } from "@berry/router-client";
import type { JsonValue } from "@berry/shared";
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
  inputFiles(tenantId: string, runId: string): Promise<readonly SandboxInputFile[]>;
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
    },
  ) {}

  async modelContent(snapshot: DurableTurnSnapshot): Promise<readonly ChatContentPart[]> {
    const requestedSandboxImages = requestedSandboxImagePaths(snapshot);
    const attachedImages = (await this.repository.inputFiles(snapshot.tenantId, snapshot.id))
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
    if (toolName === "persist_artifact") {
      if (!this.objects) throw new Error("Artifact object storage is not configured");
      const path = safeOutputPath(stringValue(args.path) ?? "");
      const source = await this.provider.files.read({
        sandbox_id: sandbox.id,
        path,
        encoding: "base64",
      });
      const bytes = Buffer.from(source.content, "base64");
      const maxBytes = this.options.maxInputBytes ?? 100 * 1024 * 1024;
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

  async snapshot(payload: SandboxSnapshotJobPayload): Promise<{ noOp: boolean; snapshotId?: string }> {
    const run = await this.repository.loadRun(payload.tenantId, payload.runId);
    if (!run.sandboxId) return { noOp: true };
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
    const handle = await this.provider.create({
      request_id: snapshot.id,
      tenant_id: snapshot.tenantId,
      task_id: snapshot.taskId,
      session_id: snapshot.sessionId,
      image: stringValue(snapshot.runtimeRequest.sandboxImage) ?? this.options.image,
      cwd: this.options.cwd ?? "/workspace",
      ttl_seconds: this.options.ttlSeconds ?? 3600,
      network_policy: networkPolicy(snapshot.runtimeRequest.networkPolicy),
      writable_roots: [this.options.cwd ?? "/workspace"],
      metadata: { runId: snapshot.id },
    });
    if (latest && this.objects) {
      const archive = JSON.parse(Buffer.from(await this.objects.get(latest.objectKey)).toString("utf8")) as SnapshotArchive;
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
      const maxInputBytes = this.options.maxInputBytes ?? 100 * 1024 * 1024;
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
    if (toolName !== "read_file") return [];
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

  async inputFiles(tenantId: string, runId: string): Promise<readonly SandboxInputFile[]> {
    const rows = await this.executor.query<SandboxInputFileRow>(
      `
SELECT f.id AS file_id,f.display_name,f.media_type,f.size_bytes,f.object_key
FROM turn_runs r
JOIN file_associations a
  ON a.tenant_id=r.tenant_id AND a.message_id=r.request_message_id AND a.role='input'
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
ORDER BY a.created_at ASC,f.id ASC
      `.trim(),
      [tenantId, runId],
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
  }): Promise<SandboxOutputFile> {
    const run = async (executor: SqlExecutor): Promise<SandboxOutputFile> => {
      const rows = await executor.query<{ id: string }>(
        `
INSERT INTO files (
  id,tenant_id,owner_user_id,original_name,display_name,media_type,size_bytes,
  sha256,bucket,object_key,etag,origin,status,metadata
) VALUES (
  $1::uuid,$2::uuid,$3::uuid,$4,$4,$5,$6,$7,$8,$9,$10,
  'sandbox_output','available',$11::jsonb
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
          JSON.stringify({ source: "durable-sandbox", runId: input.snapshot.id }),
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
    private readonly maxSourceBytes = 100 * 1024 * 1024,
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
      positiveInteger(env.BERRY_SANDBOX_INPUT_MAX_BYTES, 100 * 1024 * 1024),
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

interface SandboxInputFileRow {
  file_id: string;
  display_name: string;
  media_type: string;
  size_bytes: number | string;
  object_key: string;
}
