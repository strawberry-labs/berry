import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import {
  err,
  ExecutionError,
  FileError,
  ok,
  type ExecutionEnv,
  type FileInfo,
  type Result,
  type ShellExecOptions,
} from "@berry/harness";
import type {
  SandboxCreateInput,
  SandboxExecEvent,
  SandboxFileEntry,
  SandboxHandle,
  SandboxProvider as ContractSandboxProvider,
} from "@berry/sandbox-contract";
import { networkPolicyForSandbox, type SandboxPolicy } from "@berry/shared";
import type { SandboxProvider, SandboxSession, SandboxSessionOptions } from "./sandbox-provider.ts";

export interface CloudSandboxProviderOptions {
  provider: ContractSandboxProvider;
  tenantId: string;
  image: string;
  cwd?: string | undefined;
  resources?: SandboxCreateInput["resources"] | undefined;
  ttlSeconds?: number | undefined;
  env?: Record<string, string> | undefined;
}

export class CloudSandboxProvider implements SandboxProvider {
  readonly kind = "cloud" as const;
  readonly #provider: ContractSandboxProvider;
  readonly #tenantId: string;
  readonly #image: string;
  readonly #cwd: string;
  readonly #resources: SandboxCreateInput["resources"] | undefined;
  readonly #ttlSeconds: number;
  readonly #env: Record<string, string>;
  readonly #sessions = new Set<CloudSandboxSession>();

  constructor(options: CloudSandboxProviderOptions) {
    this.#provider = options.provider;
    this.#tenantId = options.tenantId;
    this.#image = options.image;
    this.#cwd = options.cwd?.trim() || "/workspace";
    this.#resources = options.resources;
    this.#ttlSeconds = options.ttlSeconds ?? 3600;
    this.#env = options.env ?? {};
  }

  async createSession(options: SandboxSessionOptions): Promise<SandboxSession> {
    const sandbox = await this.#provider.create({
      request_id: `session_${options.sessionId}`,
      tenant_id: this.#tenantId,
      task_id: options.taskId,
      session_id: options.sessionId,
      image: this.#image,
      cwd: this.#cwd,
      env: this.#env,
      resources: this.#resources,
      ttl_seconds: this.#ttlSeconds,
      network_policy: networkPolicyForSandbox(options.policy),
      writable_roots: [this.#cwd],
      metadata: {
        local_workspace_path: options.workspacePath,
        sandbox_tier: options.policy.tier,
      },
    });
    const session = new CloudSandboxSession(this.#provider, sandbox);
    this.#sessions.add(session);
    return {
      env: session.env,
      escalatedEnv: session.env,
      status: {
        platform: "other",
        tier: options.policy.tier,
        enforcement: "enforced",
        mechanism: "none",
        network: options.policy.tier === "danger-full-access" ? "unrestricted" : options.policy.tier === "workspace-write" ? options.policy.network : "off",
        reason: null,
      },
      dispose: async () => {
        await session.dispose();
        this.#sessions.delete(session);
      },
    };
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.#sessions].map((session) => session.dispose()));
    this.#sessions.clear();
    if (this.#provider.dispose) await this.#provider.dispose();
  }
}

class CloudSandboxSession {
  readonly env: SandboxExecutionEnv;
  readonly #provider: ContractSandboxProvider;
  readonly #sandboxId: string;
  #disposed = false;

  constructor(provider: ContractSandboxProvider, sandbox: SandboxHandle) {
    this.#provider = provider;
    this.#sandboxId = sandbox.sandbox_id;
    this.env = new SandboxExecutionEnv({ provider, sandbox });
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const stop = this.#provider.suspend?.bind(this.#provider) ?? this.#provider.destroy.bind(this.#provider);
    await stop({ sandbox_id: this.#sandboxId, reason: "session disposed" });
  }
}

export interface SandboxExecutionEnvOptions {
  provider: ContractSandboxProvider;
  sandbox: SandboxHandle;
}

export class SandboxExecutionEnv implements ExecutionEnv {
  readonly cwd: string;
  readonly #provider: ContractSandboxProvider;
  readonly #sandbox: SandboxHandle;

  constructor(options: SandboxExecutionEnvOptions) {
    this.#provider = options.provider;
    this.#sandbox = options.sandbox;
    this.cwd = options.sandbox.cwd;
  }

  async absolutePath(path: string): Promise<Result<string, FileError>> {
    return ok(this.#resolve(path));
  }

  async joinPath(parts: string[]): Promise<Result<string, FileError>> {
    return ok(posixNormalize(parts.join("/")));
  }

  async exec(command: string, options: ShellExecOptions = {}): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
    if (options.abortSignal?.aborted) return err(new ExecutionError("aborted", "aborted"));
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    try {
      for await (const event of this.#provider.exec({
        sandbox_id: this.#sandbox.sandbox_id,
        request_id: `exec_${randomUUID()}`,
        // E2B's injected shell initialisation uses `source`, which is a Bash
        // builtin and produces noisy `source: not found` warnings under
        // Ubuntu's dash-backed /bin/sh. The artifact image ships Bash.
        command: ["bash", "-lc", command],
        cwd: this.#resolve(options.cwd ?? this.cwd),
        env: options.env ?? {},
        timeout_ms: Math.round((options.timeout ?? 120) * 1000),
      }, { signal: options.abortSignal })) {
        if (event.kind === "stdout") {
          stdout += event.data;
          options.onStdout?.(event.data);
        } else if (event.kind === "stderr") {
          stderr += event.data;
          options.onStderr?.(event.data);
        } else if (event.kind === "exit") {
          exitCode = event.exit_code ?? 0;
        } else if (event.kind === "error") {
          return err(new ExecutionError("unknown", event.message));
        }
      }
      return ok({ stdout, stderr, exitCode });
    } catch (error) {
      if (options.abortSignal?.aborted) return err(new ExecutionError("aborted", "aborted"));
      const cause = error instanceof Error ? error : new Error(String(error));
      return err(new ExecutionError("unknown", cause.message, cause));
    }
  }

  async readTextFile(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
    if (abortSignal?.aborted) return err(new FileError("aborted", "aborted", path));
    try {
      const result = await this.#provider.files.read({ sandbox_id: this.#sandbox.sandbox_id, path: this.#resolve(path), encoding: "utf8" });
      return ok(result.content);
    } catch (error) {
      return err(toFileError(error, this.#resolve(path)));
    }
  }

  async readTextLines(path: string, options: { maxLines?: number; abortSignal?: AbortSignal } = {}): Promise<Result<string[], FileError>> {
    const content = await this.readTextFile(path, options.abortSignal);
    if (!content.ok) return content;
    const lines = content.value.split("\n");
    return ok(options.maxLines === undefined ? lines : lines.slice(0, Math.max(0, options.maxLines)));
  }

  async readBinaryFile(path: string, abortSignal?: AbortSignal): Promise<Result<Uint8Array, FileError>> {
    if (abortSignal?.aborted) return err(new FileError("aborted", "aborted", path));
    try {
      const result = await this.#provider.files.read({ sandbox_id: this.#sandbox.sandbox_id, path: this.#resolve(path), encoding: "base64" });
      return ok(Buffer.from(result.content, "base64"));
    } catch (error) {
      return err(toFileError(error, this.#resolve(path)));
    }
  }

  async writeFile(path: string, content: string | Uint8Array, abortSignal?: AbortSignal): Promise<Result<void, FileError>> {
    if (abortSignal?.aborted) return err(new FileError("aborted", "aborted", path));
    try {
      const text = typeof content === "string" ? content : Buffer.from(content).toString("base64");
      await this.#provider.files.write({
        sandbox_id: this.#sandbox.sandbox_id,
        path: this.#resolve(path),
        encoding: typeof content === "string" ? "utf8" : "base64",
        content: text,
      });
      return ok(undefined);
    } catch (error) {
      return err(toFileError(error, this.#resolve(path)));
    }
  }

  async appendFile(path: string, content: string | Uint8Array, abortSignal?: AbortSignal): Promise<Result<void, FileError>> {
    if (typeof content === "string") {
      const existing = await this.readTextFile(path, abortSignal);
      if (!existing.ok) {
        if (existing.error.code !== "not_found") return existing;
        return this.writeFile(path, content, abortSignal);
      }
      return this.writeFile(path, `${existing.value}${content}`, abortSignal);
    }
    const existing = await this.readBinaryFile(path, abortSignal);
    if (!existing.ok) {
      if (existing.error.code !== "not_found") return existing;
      return this.writeFile(path, content, abortSignal);
    }
    return this.writeFile(path, Buffer.concat([Buffer.from(existing.value), Buffer.from(content)]), abortSignal);
  }

  async fileInfo(path: string): Promise<Result<FileInfo, FileError>> {
    const resolved = this.#resolve(path);
    try {
      const listing = await this.#provider.files.list({ sandbox_id: this.#sandbox.sandbox_id, path: resolved, recursive: false });
      const exact = listing.entries.find((entry: SandboxFileEntry) => entry.path === resolved);
      if (exact) return ok(fileInfoFromSandboxEntry(exact));
      return ok({ name: basename(resolved), path: resolved, kind: "directory", size: 0, mtimeMs: Date.now() });
    } catch {
      try {
        const file = await this.#provider.files.read({ sandbox_id: this.#sandbox.sandbox_id, path: resolved, encoding: "utf8" });
        return ok({ name: basename(file.path), path: file.path, kind: "file", size: file.size_bytes, mtimeMs: file.mtime ? Date.parse(file.mtime) : 0 });
      } catch (error) {
        return err(toFileError(error, resolved));
      }
    }
  }

  async listDir(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo[], FileError>> {
    if (abortSignal?.aborted) return err(new FileError("aborted", "aborted", path));
    const resolved = this.#resolve(path);
    try {
      const listing = await this.#provider.files.list({ sandbox_id: this.#sandbox.sandbox_id, path: resolved, recursive: false });
      return ok(listing.entries.map(fileInfoFromSandboxEntry));
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }

  async canonicalPath(path: string): Promise<Result<string, FileError>> {
    return this.absolutePath(path);
  }

  async exists(path: string): Promise<Result<boolean, FileError>> {
    const info = await this.fileInfo(path);
    if (info.ok) return ok(true);
    if (info.error.code === "not_found") return ok(false);
    return err(info.error);
  }

  async createDir(path: string, options: { recursive?: boolean; abortSignal?: AbortSignal } = {}): Promise<Result<void, FileError>> {
    const flag = options.recursive === false ? "" : "-p ";
    const execOptions: ShellExecOptions = {};
    if (options.abortSignal) execOptions.abortSignal = options.abortSignal;
    const result = await this.exec(`mkdir ${flag}${shellQuote(this.#resolve(path))}`, execOptions);
    return result.ok && result.value.exitCode === 0 ? ok(undefined) : err(new FileError("unknown", result.ok ? result.value.stderr : result.error.message, this.#resolve(path)));
  }

  async remove(path: string, options: { recursive?: boolean; force?: boolean; abortSignal?: AbortSignal } = {}): Promise<Result<void, FileError>> {
    const flags = `${options.recursive ? "r" : ""}${options.force ? "f" : ""}`;
    const execOptions: ShellExecOptions = {};
    if (options.abortSignal) execOptions.abortSignal = options.abortSignal;
    const result = await this.exec(`rm ${flags ? `-${flags} ` : ""}${shellQuote(this.#resolve(path))}`, execOptions);
    return result.ok && result.value.exitCode === 0 ? ok(undefined) : err(new FileError("unknown", result.ok ? result.value.stderr : result.error.message, this.#resolve(path)));
  }

  async createTempDir(prefix = "tmp-", abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
    const path = `/tmp/${prefix}${randomUUID()}`;
    const options: { recursive?: boolean; abortSignal?: AbortSignal } = { recursive: true };
    if (abortSignal) options.abortSignal = abortSignal;
    const created = await this.createDir(path, options);
    return created.ok ? ok(path) : created;
  }

  async createTempFile(options: { prefix?: string; suffix?: string; abortSignal?: AbortSignal } = {}): Promise<Result<string, FileError>> {
    const path = `/tmp/${options.prefix ?? ""}${randomUUID()}${options.suffix ?? ""}`;
    const written = await this.writeFile(path, "", options.abortSignal);
    return written.ok ? ok(path) : written;
  }

  async cleanup(): Promise<void> {}

  #resolve(path: string): string {
    const candidate = path.startsWith("/") ? path : `${this.cwd.replace(/\/$/, "")}/${path}`;
    return posixNormalize(candidate);
  }
}

export interface ArtifactStore {
  persistFile(input: {
    env: ExecutionEnv;
    path: string;
    name?: string | undefined;
    mediaType: string;
    metadata?: Record<string, string> | undefined;
  }): Promise<{
    key: string;
    url: string;
    storage: string;
    size: number;
  }>;
}

export interface ObjectPutClient {
  putObject(input: { key: string; body: Uint8Array; contentType: string; metadata?: Record<string, string> | undefined }): Promise<{ url: string }>;
  createUploadUrl?(input: { key: string; contentType: string; metadata?: Record<string, string> | undefined }): Promise<{ uploadUrl: string; url: string }>;
}

export class S3CompatibleArtifactStore implements ArtifactStore {
  readonly #bucket: string;
  readonly #prefix: string;
  readonly #client: ObjectPutClient;

  constructor(options: { bucket: string; prefix?: string | undefined; client: ObjectPutClient }) {
    this.#bucket = options.bucket;
    this.#prefix = options.prefix?.replace(/^\/+|\/+$/g, "") ?? "artifacts";
    this.#client = options.client;
  }

  async persistFile(input: { env: ExecutionEnv; path: string; name?: string | undefined; mediaType: string; metadata?: Record<string, string> | undefined }): Promise<{ key: string; url: string; storage: string; size: number }> {
    const key = `${this.#prefix}/${randomUUID()}-${safeObjectName(input.name ?? basename(input.path))}`;
    if (this.#client.createUploadUrl) {
      const info = await input.env.fileInfo(input.path);
      if (!info.ok) throw info.error;
      const signed = await this.#client.createUploadUrl({ key, contentType: input.mediaType, metadata: input.metadata });
      const uploaded = await input.env.exec(`curl --fail --silent --show-error --retry 3 --upload-file ${shellQuote(input.path)} --header ${shellQuote(`Content-Type: ${input.mediaType}`)} ${shellQuote(signed.uploadUrl)}`, { timeout: 1800 });
      if (!uploaded.ok || uploaded.value.exitCode !== 0) throw new Error(uploaded.ok ? uploaded.value.stderr || "Artifact upload failed" : uploaded.error.message);
      return { key, url: signed.url, storage: `s3://${this.#bucket}`, size: info.value.size };
    }
    const content = await input.env.readBinaryFile(input.path);
    if (!content.ok) throw content.error;
    const stored = await this.#client.putObject({
      key,
      body: content.value,
      contentType: input.mediaType,
      metadata: input.metadata,
    });
    return { key, url: stored.url, storage: `s3://${this.#bucket}`, size: content.value.byteLength };
  }
}

function fileInfoFromSandboxEntry(entry: { path: string; type: "file" | "directory" | "symlink"; size_bytes: number; mtime: string | null }): FileInfo {
  return {
    name: basename(entry.path),
    path: entry.path,
    kind: entry.type,
    size: entry.size_bytes,
    mtimeMs: entry.mtime ? Date.parse(entry.mtime) : 0,
  };
}

function toFileError(error: unknown, path: string): FileError {
  if (error instanceof FileError) return error;
  const cause = error instanceof Error ? error : new Error(String(error));
  const code = /not found|missing|enoent/i.test(cause.message) ? "not_found" : "unknown";
  return new FileError(code, cause.message, path, cause);
}

function posixNormalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "") || "/";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function safeObjectName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "artifact";
}
