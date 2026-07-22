import { Buffer } from "node:buffer";
import {
  Sandbox,
  SandboxNotFoundError,
  type SandboxApiOpts,
  type SandboxConnectOpts,
  type SandboxListOpts,
  type SandboxOpts,
  type SandboxPauseOpts,
} from "e2b";
import {
  SandboxCreateInputSchema,
  SandboxDestroyInputSchema,
  SandboxDestroyResultSchema,
  SandboxExecEventSchema,
  SandboxExecInputSchema,
  SandboxExposePortInputSchema,
  SandboxExposePortResultSchema,
  SandboxFileListInputSchema,
  SandboxFileListResultSchema,
  SandboxFileReadInputSchema,
  SandboxFileReadResultSchema,
  SandboxFileWriteInputSchema,
  SandboxFileWriteResultSchema,
  SandboxHandleSchema,
  SandboxResourceLimitsSchema,
  type SandboxCreateInput,
  type SandboxDestroyInput,
  type SandboxDestroyResult,
  type SandboxExecEvent,
  type SandboxExecInput,
  type SandboxExposePortInput,
  type SandboxExposePortResult,
  type SandboxFileListInput,
  type SandboxFileListResult,
  type SandboxFileReadInput,
  type SandboxFileReadResult,
  type SandboxFileWriteInput,
  type SandboxFileWriteResult,
  type SandboxHandle,
  type SandboxResourceLimits,
} from "./schemas.js";
import type { SandboxFileApi, SandboxProvider } from "./provider.js";

type ParsedCreateInput = ReturnType<typeof SandboxCreateInputSchema.parse>;

export interface E2BCommandResultLike {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string | undefined;
}

export interface E2BCommandHandleLike {
  readonly pid: number;
  wait(): Promise<E2BCommandResultLike>;
  kill(): Promise<boolean>;
  sendStdin(data: string | Uint8Array): Promise<void>;
  closeStdin(): Promise<void>;
}

export interface E2BFileInfoLike {
  name: string;
  path: string;
  type?: "file" | "dir" | undefined;
  size?: number | undefined;
  modifiedTime?: Date | undefined;
  symlinkTarget?: string | undefined;
}

export interface E2BSandboxLike {
  readonly sandboxId: string;
  readonly trafficAccessToken?: string | undefined;
  readonly files: {
    read(path: string, options: { format: "text" | "bytes" }): Promise<string | Uint8Array>;
    write(path: string, data: string | ArrayBuffer): Promise<E2BFileInfoLike>;
    list(path: string, options?: { depth?: number | undefined }): Promise<E2BFileInfoLike[]>;
    getInfo(path: string): Promise<E2BFileInfoLike>;
  };
  readonly commands: {
    run(command: string, options?: {
      background?: boolean | undefined;
      cwd?: string | undefined;
      envs?: Record<string, string> | undefined;
      onStdout?: ((data: string) => void | Promise<void>) | undefined;
      onStderr?: ((data: string) => void | Promise<void>) | undefined;
      stdin?: boolean | undefined;
      timeoutMs?: number | undefined;
    }): Promise<E2BCommandHandleLike | E2BCommandResultLike>;
  };
  getHost(port: number): string;
  pause(options?: { keepMemory?: boolean | undefined }): Promise<boolean>;
}

export interface E2BSandboxInfoLike {
  sandboxId: string;
  templateId: string;
  metadata: Record<string, string>;
  startedAt: Date;
  endAt: Date;
  state: "running" | "paused";
  cpuCount: number;
  memoryMB: number;
}

type E2BAuthOptions = {
  apiKey: string;
  domain?: string | undefined;
  requestTimeoutMs?: number | undefined;
};

export interface E2BSandboxClient {
  create(input: {
    template: string;
    options: E2BAuthOptions & {
      timeoutMs: number;
      secure: boolean;
      envs: Record<string, string>;
      metadata: Record<string, string>;
      allowInternetAccess: boolean;
      network: {
        allowPublicTraffic: boolean;
        allowOut?: string[] | undefined;
        denyOut?: string[] | undefined;
      };
      lifecycle: {
        onTimeout: { action: "pause"; keepMemory: boolean };
        autoResume: false;
      };
    };
  }): Promise<E2BSandboxLike>;
  connect(sandboxId: string, options: E2BAuthOptions & { timeoutMs: number }): Promise<E2BSandboxLike>;
  find(metadata: Record<string, string>, options: E2BAuthOptions): Promise<E2BSandboxInfoLike | undefined>;
  getInfo(sandboxId: string, options: E2BAuthOptions): Promise<E2BSandboxInfoLike>;
  pause(sandboxId: string, options: E2BAuthOptions & { keepMemory: boolean }): Promise<boolean>;
  kill(sandboxId: string, options: E2BAuthOptions): Promise<boolean>;
}

export interface E2BSandboxProviderOptions {
  apiKey: string;
  template?: string | undefined;
  domain?: string | undefined;
  requestTimeoutMs?: number | undefined;
  keepMemoryOnPause?: boolean | undefined;
  reuseByRequestId?: boolean | undefined;
  /** Total estimated price of the selected E2B template in USD micros/hour. */
  estimatedHourlyCostMicros?: number | undefined;
  minimumExecCostMicros?: number | undefined;
  client?: E2BSandboxClient | undefined;
  now?: (() => Date) | undefined;
}

type SandboxRecord = {
  sandbox: E2BSandboxLike;
  handle: SandboxHandle;
  resources: SandboxResourceLimits;
  ttlSeconds: number;
  activeUntil: number;
};

const DEFAULT_RESOURCES = SandboxResourceLimitsSchema.parse({});
const DEFAULT_RECONNECT_TTL_SECONDS = 900;
const ACTIVE_EXPIRY_SAFETY_MS = 2_000;

/** Direct, server-side E2B implementation of Berry's provider-neutral sandbox contract. */
export class E2BSandboxProvider implements SandboxProvider {
  readonly kind = "e2b" as const;
  readonly #apiKey: string;
  readonly #template: string;
  readonly #domain: string | undefined;
  readonly #requestTimeoutMs: number | undefined;
  readonly #keepMemoryOnPause: boolean;
  readonly #reuseByRequestId: boolean;
  readonly #estimatedHourlyCostMicros: number | undefined;
  readonly #minimumExecCostMicros: number;
  readonly #client: E2BSandboxClient;
  readonly #now: () => Date;
  readonly #sandboxes = new Map<string, SandboxRecord>();

  readonly files: SandboxFileApi = {
    read: (input) => this.readFile(input),
    write: (input) => this.writeFile(input),
    list: (input) => this.listFiles(input),
  };

  constructor(options: E2BSandboxProviderOptions) {
    const apiKey = options.apiKey.trim();
    if (!apiKey) throw new Error("E2BSandboxProvider requires an E2B API key");
    this.#apiKey = apiKey;
    this.#template = options.template?.trim() || "base";
    this.#domain = options.domain?.trim() || undefined;
    this.#requestTimeoutMs = options.requestTimeoutMs;
    this.#keepMemoryOnPause = options.keepMemoryOnPause ?? false;
    this.#reuseByRequestId = options.reuseByRequestId ?? true;
    this.#estimatedHourlyCostMicros = optionalNonnegativeInteger(options.estimatedHourlyCostMicros, "estimatedHourlyCostMicros");
    this.#minimumExecCostMicros = optionalNonnegativeInteger(options.minimumExecCostMicros, "minimumExecCostMicros") ?? 0;
    this.#client = options.client ?? createE2BClient();
    this.#now = options.now ?? (() => new Date());
  }

  async create(input: SandboxCreateInput): Promise<SandboxHandle> {
    const parsed = SandboxCreateInputSchema.parse(input);
    if (parsed.mounts.length > 0) {
      throw new Error("E2B does not support host bind mounts; upload project files through the sandbox file API instead");
    }

    const template = parsed.snapshot_id ?? this.#template;
    const lookupMetadata = {
      berry_request_id: parsed.request_id,
      berry_tenant_id: parsed.tenant_id,
      // Never reconnect a session to an older image after a template rollout.
      berry_image: template,
      berry_cwd: parsed.cwd,
    };
    if (this.#reuseByRequestId) {
      const existing = await this.#client.find(lookupMetadata, this.#authOptions());
      if (existing) {
        const sandbox = await this.#client.connect(existing.sandboxId, {
          ...this.#authOptions(),
          timeoutMs: parsed.ttl_seconds * 1_000,
        });
        const handle = this.#handleFromInfo(existing, parsed);
        this.#remember(sandbox, handle, parsed.resources, parsed.ttl_seconds);
        return handle;
      }
    }

    const sandbox = await this.#client.create({
      template,
      options: {
        ...this.#authOptions(),
        timeoutMs: parsed.ttl_seconds * 1_000,
        secure: true,
        envs: parsed.env,
        metadata: sdkMetadata(parsed, template),
        allowInternetAccess: parsed.network_policy.egress !== "off",
        network: networkOptions(parsed.network_policy.egress, parsed.network_policy.allowedDomains),
        lifecycle: {
          onTimeout: { action: "pause", keepMemory: this.#keepMemoryOnPause },
          autoResume: false,
        },
      },
    });

    try {
      await runForeground(sandbox, `mkdir -p -- ${shellQuote(parsed.cwd)}`);
    } catch (error) {
      await this.#client.kill(sandbox.sandboxId, this.#authOptions()).catch(() => false);
      throw error;
    }

    const createdAt = this.#now();
    const handle = SandboxHandleSchema.parse({
      sandbox_id: sandbox.sandboxId,
      request_id: parsed.request_id,
      tenant_id: parsed.tenant_id,
      provider: "e2b",
      provider_kind: "e2b",
      status: "running",
      image: template,
      cwd: parsed.cwd,
      created_at: createdAt.toISOString(),
      expires_at: new Date(createdAt.getTime() + parsed.ttl_seconds * 1_000).toISOString(),
      metadata: {
        client: parsed.metadata,
        template,
        durable_pause: true,
        network_policy: parsed.network_policy,
        writable_roots: parsed.writable_roots,
      },
    });
    this.#remember(sandbox, handle, parsed.resources, parsed.ttl_seconds);
    return handle;
  }

  async *exec(input: SandboxExecInput, options: { signal?: AbortSignal | undefined } = {}): AsyncIterable<SandboxExecEvent> {
    const parsed = SandboxExecInputSchema.parse(input);
    const sandbox = await this.#sandbox(parsed.sandbox_id);
    const record = this.#sandboxes.get(parsed.sandbox_id);
    const command = commandString(parsed.command, parsed.code, parsed.language);
    const startedAt = this.#now();
    const channel = new EventChannel<SandboxExecEvent>();

    let handle: E2BCommandHandleLike;
    try {
      const started = await sandbox.commands.run(command, {
        background: true,
        cwd: parsed.cwd ?? record?.handle.cwd ?? "/workspace",
        envs: parsed.env,
        stdin: parsed.stdin !== undefined,
        timeoutMs: parsed.timeout_ms,
        onStdout: (data) => channel.push(SandboxExecEventSchema.parse({ kind: "stdout", data })),
        onStderr: (data) => channel.push(SandboxExecEventSchema.parse({ kind: "stderr", data })),
      });
      if (!isCommandHandle(started)) throw new Error("E2B did not return a background command handle");
      handle = started;
    } catch (error) {
      yield SandboxExecEventSchema.parse({ kind: "error", message: errorMessage(error), code: "e2b_command_start_failed" });
      return;
    }

    yield SandboxExecEventSchema.parse({
      kind: "started",
      sandbox_id: parsed.sandbox_id,
      request_id: parsed.request_id,
      pid: handle.pid,
    });

    const onAbort = () => void handle.kill().catch(() => false);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    void (async () => {
      let status: "completed" | "failed" | "cancelled" = "completed";
      try {
        if (parsed.stdin !== undefined) {
          await handle.sendStdin(parsed.stdin);
          await handle.closeStdin();
        }
        const result = await handle.wait();
        channel.push(SandboxExecEventSchema.parse({ kind: "exit", exit_code: result.exitCode, signal: null }));
        if (result.exitCode !== 0) status = "failed";
      } catch (error) {
        if (options.signal?.aborted) {
          status = "cancelled";
          channel.push(SandboxExecEventSchema.parse({ kind: "exit", exit_code: null, signal: "SIGKILL" }));
        } else if (isCommandResult(error)) {
          status = "failed";
          channel.push(SandboxExecEventSchema.parse({ kind: "exit", exit_code: error.exitCode, signal: null }));
        } else {
          status = "failed";
          channel.push(SandboxExecEventSchema.parse({ kind: "error", message: errorMessage(error), code: "e2b_command_failed" }));
        }
      } finally {
        options.signal?.removeEventListener("abort", onAbort);
        const usage = this.#usageEvent(parsed, record, startedAt, status);
        if (usage) channel.push(usage);
        channel.close();
      }
    })();

    for await (const event of channel) yield event;
  }

  async exposePort(input: SandboxExposePortInput): Promise<SandboxExposePortResult> {
    const parsed = SandboxExposePortInputSchema.parse(input);
    const sandbox = await this.#sandbox(parsed.sandbox_id);
    const record = this.#sandboxes.get(parsed.sandbox_id);
    const host = sandbox.getHost(parsed.port);
    return SandboxExposePortResultSchema.parse({
      sandbox_id: parsed.sandbox_id,
      port: parsed.port,
      protocol: parsed.protocol,
      url: `https://${host}`,
      expires_at: record?.handle.expires_at ?? null,
    });
  }

  async suspend(input: SandboxDestroyInput): Promise<SandboxDestroyResult> {
    const parsed = SandboxDestroyInputSchema.parse(input);
    try {
      await this.#client.pause(parsed.sandbox_id, {
        ...this.#authOptions(),
        keepMemory: this.#keepMemoryOnPause,
      });
      this.#sandboxes.delete(parsed.sandbox_id);
      return SandboxDestroyResultSchema.parse({ sandbox_id: parsed.sandbox_id, destroyed: true, status: "stopped" });
    } catch (error) {
      if (!isNotFound(error)) throw error;
      this.#sandboxes.delete(parsed.sandbox_id);
      return SandboxDestroyResultSchema.parse({ sandbox_id: parsed.sandbox_id, destroyed: false, status: "missing" });
    }
  }

  async destroy(input: SandboxDestroyInput): Promise<SandboxDestroyResult> {
    const parsed = SandboxDestroyInputSchema.parse(input);
    try {
      const destroyed = await this.#client.kill(parsed.sandbox_id, this.#authOptions());
      this.#sandboxes.delete(parsed.sandbox_id);
      return SandboxDestroyResultSchema.parse({
        sandbox_id: parsed.sandbox_id,
        destroyed,
        status: destroyed ? "stopped" : "missing",
      });
    } catch (error) {
      if (!isNotFound(error)) throw error;
      this.#sandboxes.delete(parsed.sandbox_id);
      return SandboxDestroyResultSchema.parse({ sandbox_id: parsed.sandbox_id, destroyed: false, status: "missing" });
    }
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([...this.#sandboxes.keys()].map((sandboxId) => this.suspend({
      sandbox_id: sandboxId,
      reason: "provider disposed",
    })));
  }

  async readFile(input: SandboxFileReadInput): Promise<SandboxFileReadResult> {
    const parsed = SandboxFileReadInputSchema.parse(input);
    const sandbox = await this.#sandbox(parsed.sandbox_id);
    const info = await sandbox.files.getInfo(parsed.path);
    if (parsed.encoding === "base64") {
      const bytes = await sandbox.files.read(parsed.path, { format: "bytes" });
      if (typeof bytes === "string") throw new Error("E2B returned text for a byte-oriented file read");
      return SandboxFileReadResultSchema.parse({
        path: parsed.path,
        encoding: "base64",
        content: Buffer.from(bytes).toString("base64"),
        size_bytes: bytes.byteLength,
        mtime: info.modifiedTime?.toISOString() ?? null,
      });
    }
    const content = await sandbox.files.read(parsed.path, { format: "text" });
    if (typeof content !== "string") throw new Error("E2B returned bytes for a text-oriented file read");
    return SandboxFileReadResultSchema.parse({
      path: parsed.path,
      encoding: "utf8",
      content,
      size_bytes: Buffer.byteLength(content),
      mtime: info.modifiedTime?.toISOString() ?? null,
    });
  }

  async writeFile(input: SandboxFileWriteInput): Promise<SandboxFileWriteResult> {
    const parsed = SandboxFileWriteInputSchema.parse(input);
    const sandbox = await this.#sandbox(parsed.sandbox_id);
    const content = parsed.encoding === "base64" ? arrayBuffer(Buffer.from(parsed.content, "base64")) : parsed.content;
    await sandbox.files.write(parsed.path, content);
    if (parsed.mode !== undefined) {
      await runForeground(sandbox, `chmod ${parsed.mode.toString(8)} -- ${shellQuote(parsed.path)}`);
    }
    const info = await sandbox.files.getInfo(parsed.path);
    return SandboxFileWriteResultSchema.parse({
      path: parsed.path,
      size_bytes: info.size ?? (typeof content === "string" ? Buffer.byteLength(content) : content.byteLength),
      mtime: info.modifiedTime?.toISOString() ?? this.#now().toISOString(),
    });
  }

  async listFiles(input: SandboxFileListInput): Promise<SandboxFileListResult> {
    const parsed = SandboxFileListInputSchema.parse(input);
    const sandbox = await this.#sandbox(parsed.sandbox_id);
    const entries = await sandbox.files.list(parsed.path, { depth: parsed.recursive ? 64 : 1 });
    return SandboxFileListResultSchema.parse({
      path: parsed.path,
      entries: entries.map((entry) => ({
        path: entry.path,
        type: entry.symlinkTarget ? "symlink" : entry.type === "dir" ? "directory" : "file",
        size_bytes: entry.size ?? 0,
        mtime: entry.modifiedTime?.toISOString() ?? null,
      })),
    });
  }

  async #sandbox(sandboxId: string): Promise<E2BSandboxLike> {
    const current = this.#sandboxes.get(sandboxId);
    if (current && this.#now().getTime() < current.activeUntil - ACTIVE_EXPIRY_SAFETY_MS) return current.sandbox;

    const info = current ? undefined : await this.#client.getInfo(sandboxId, this.#authOptions());
    const ttlSeconds = current?.ttlSeconds ?? positiveMetadataInteger(info?.metadata.berry_ttl_seconds) ?? DEFAULT_RECONNECT_TTL_SECONDS;
    const sandbox = await this.#client.connect(sandboxId, {
      ...this.#authOptions(),
      timeoutMs: ttlSeconds * 1_000,
    });
    if (current) {
      this.#remember(sandbox, current.handle, current.resources, ttlSeconds);
    } else if (info) {
      const handle = this.#handleFromStoredInfo(info);
      const resources = resourcesFromMetadata(info.metadata.berry_resources_json);
      this.#remember(sandbox, handle, resources, ttlSeconds);
    }
    return sandbox;
  }

  #remember(sandbox: E2BSandboxLike, handle: SandboxHandle, resources: SandboxResourceLimits, ttlSeconds: number): void {
    this.#sandboxes.set(sandbox.sandboxId, {
      sandbox,
      handle,
      resources,
      ttlSeconds,
      activeUntil: this.#now().getTime() + ttlSeconds * 1_000,
    });
  }

  #handleFromInfo(info: E2BSandboxInfoLike, input: ParsedCreateInput): SandboxHandle {
    return SandboxHandleSchema.parse({
      sandbox_id: info.sandboxId,
      request_id: input.request_id,
      tenant_id: input.tenant_id,
      provider: "e2b",
      provider_kind: "e2b",
      status: "running",
      image: info.templateId || input.snapshot_id || this.#template,
      cwd: input.cwd,
      created_at: info.startedAt.toISOString(),
      expires_at: info.endAt.toISOString(),
      metadata: {
        client: input.metadata,
        template: info.templateId,
        durable_pause: true,
        resumed: true,
        network_policy: input.network_policy,
        writable_roots: input.writable_roots,
      },
    });
  }

  #handleFromStoredInfo(info: E2BSandboxInfoLike): SandboxHandle {
    const metadata = info.metadata;
    return SandboxHandleSchema.parse({
      sandbox_id: info.sandboxId,
      request_id: requiredMetadata(metadata, "berry_request_id"),
      tenant_id: requiredMetadata(metadata, "berry_tenant_id"),
      provider: "e2b",
      provider_kind: "e2b",
      status: "running",
      image: metadata.berry_image ?? info.templateId,
      cwd: metadata.berry_cwd ?? "/workspace",
      created_at: info.startedAt.toISOString(),
      expires_at: info.endAt.toISOString(),
      metadata: {
        client: jsonMetadata(metadata.berry_client_metadata_json),
        template: info.templateId,
        durable_pause: true,
        resumed: true,
      },
    });
  }

  #usageEvent(
    input: ReturnType<typeof SandboxExecInputSchema.parse>,
    record: SandboxRecord | undefined,
    startedAt: Date,
    status: "completed" | "failed" | "cancelled",
  ): SandboxExecEvent | undefined {
    if (!record) return undefined;
    const endedAt = this.#now();
    const runtimeMs = Math.max(0, endedAt.getTime() - startedAt.getTime());
    const runtimeSeconds = runtimeMs / 1_000;
    const estimatedCostMicros = this.#estimatedHourlyCostMicros === undefined
      ? undefined
      : Math.max(this.#minimumExecCostMicros, Math.ceil((this.#estimatedHourlyCostMicros * runtimeMs) / 3_600_000));
    return SandboxExecEventSchema.parse({
      kind: "usage",
      event: {
        request_id: input.request_id,
        sandbox_id: input.sandbox_id,
        tenant_id: record.handle.tenant_id,
        provider: "e2b",
        status,
        price_version: "e2b-direct-v1",
        runtime_ms: runtimeMs,
        vcpu_seconds: runtimeSeconds * record.resources.cpuCount,
        memory_gib_seconds: runtimeSeconds * (record.resources.memoryMiB / 1_024),
        storage_gib_seconds: runtimeSeconds * (record.resources.storageMiB / 1_024),
        cpu_count: record.resources.cpuCount,
        ...(estimatedCostMicros === undefined ? {} : { provider_minimum_charge: String(estimatedCostMicros) }),
        ts: endedAt.toISOString(),
        metadata: {
          source: "berry-e2b-sdk",
          estimated_resources: true,
          estimated_price: estimatedCostMicros !== undefined,
          ...(this.#estimatedHourlyCostMicros === undefined ? {} : { estimated_hourly_cost_micros: this.#estimatedHourlyCostMicros }),
        },
      },
    });
  }

  #authOptions(): E2BAuthOptions {
    return {
      apiKey: this.#apiKey,
      ...(this.#domain ? { domain: this.#domain } : {}),
      ...(this.#requestTimeoutMs ? { requestTimeoutMs: this.#requestTimeoutMs } : {}),
    };
  }
}

function createE2BClient(): E2BSandboxClient {
  return {
    create: async ({ template, options }) => Sandbox.create(template, options as SandboxOpts) as unknown as Promise<E2BSandboxLike>,
    connect: async (sandboxId, options) => Sandbox.connect(sandboxId, options as SandboxConnectOpts) as unknown as Promise<E2BSandboxLike>,
    find: async (metadata, options) => {
      const paginator = Sandbox.list({
        ...options,
        query: { metadata, state: ["running", "paused"] },
        limit: 10,
      } as SandboxListOpts);
      if (!paginator.hasNext) return undefined;
      return (await paginator.nextItems())[0] as E2BSandboxInfoLike | undefined;
    },
    getInfo: async (sandboxId, options) => Sandbox.getInfo(sandboxId, options as SandboxApiOpts) as unknown as Promise<E2BSandboxInfoLike>,
    pause: (sandboxId, options) => Sandbox.pause(sandboxId, options as SandboxPauseOpts),
    kill: (sandboxId, options) => Sandbox.kill(sandboxId, options as SandboxApiOpts),
  };
}

function sdkMetadata(input: ParsedCreateInput, template: string): Record<string, string> {
  return {
    berry_request_id: input.request_id,
    berry_tenant_id: input.tenant_id,
    berry_task_id: input.task_id ?? "",
    berry_session_id: input.session_id ?? "",
    berry_cwd: input.cwd,
    berry_image: template,
    berry_ttl_seconds: String(input.ttl_seconds),
    berry_resources_json: JSON.stringify(input.resources),
    berry_client_metadata_json: JSON.stringify(input.metadata),
  };
}

function networkOptions(egress: "on" | "off" | "unrestricted", allowedDomains: string[]): {
  allowPublicTraffic: boolean;
  allowOut?: string[] | undefined;
  denyOut?: string[] | undefined;
} {
  if (egress === "off") return { allowPublicTraffic: false, denyOut: ["0.0.0.0/0"] };
  if (allowedDomains.length > 0) return { allowPublicTraffic: false, allowOut: allowedDomains };
  return { allowPublicTraffic: false };
}

function commandString(command: string[] | undefined, code: string | undefined, language: string | undefined): string {
  if (command) return command.map(shellQuote).join(" ");
  const normalized = language?.trim().toLowerCase() ?? "shell";
  if (normalized === "python" || normalized === "python3" || normalized === "py") {
    return `python3 -c ${shellQuote(code ?? "")}`;
  }
  if (normalized === "javascript" || normalized === "js" || normalized === "node") {
    return `node -e ${shellQuote(code ?? "")}`;
  }
  if (normalized === "shell" || normalized === "sh" || normalized === "bash") {
    return `sh -lc ${shellQuote(code ?? "")}`;
  }
  throw new Error(`Unsupported E2B code language: ${language}`);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function runForeground(sandbox: E2BSandboxLike, command: string): Promise<E2BCommandResultLike> {
  const result = await sandbox.commands.run(command, { background: false });
  if (isCommandHandle(result)) return result.wait();
  if (result.exitCode !== 0) throw new Error(result.error || result.stderr || `Command exited with ${result.exitCode}`);
  return result;
}

function isCommandHandle(value: E2BCommandHandleLike | E2BCommandResultLike): value is E2BCommandHandleLike {
  return "pid" in value && typeof value.wait === "function";
}

function isCommandResult(value: unknown): value is E2BCommandResultLike {
  return typeof value === "object" && value !== null && typeof (value as { exitCode?: unknown }).exitCode === "number";
}

function isNotFound(error: unknown): boolean {
  return error instanceof SandboxNotFoundError || (error instanceof Error && (error.name === "SandboxNotFoundError" || /not found/i.test(error.message)));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function arrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

function positiveMetadataInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function optionalNonnegativeInteger(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
  return value;
}

function resourcesFromMetadata(value: string | undefined): SandboxResourceLimits {
  if (!value) return DEFAULT_RESOURCES;
  try {
    return SandboxResourceLimitsSchema.parse(JSON.parse(value));
  } catch {
    return DEFAULT_RESOURCES;
  }
}

function requiredMetadata(metadata: Record<string, string>, key: string): string {
  const value = metadata[key]?.trim();
  if (!value) throw new Error(`E2B sandbox metadata is missing ${key}`);
  return value;
}

function jsonMetadata(value: string | undefined): unknown {
  if (!value) return {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

class EventChannel<T> implements AsyncIterable<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<() => void> = [];
  #closed = false;

  push(value: T): void {
    if (this.#closed) return;
    this.#values.push(value);
    this.#wake();
  }

  close(): void {
    this.#closed = true;
    this.#wake();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (!this.#closed || this.#values.length > 0) {
      if (this.#values.length === 0) await new Promise<void>((resolve) => this.#waiters.push(resolve));
      const value = this.#values.shift();
      if (value !== undefined) yield value;
    }
  }

  #wake(): void {
    for (const resolve of this.#waiters.splice(0)) resolve();
  }
}
