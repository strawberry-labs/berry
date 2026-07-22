import { Buffer } from "node:buffer";
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
} from "./schemas.js";
import type { SandboxFileApi, SandboxProvider } from "./provider.js";

export interface DockerCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type DockerStreamEvent =
  | { stream: "stdout" | "stderr"; data: string }
  | { stream: "exit"; exitCode: number; signal?: string | null | undefined };

export interface DockerCommandExecutor {
  run(args: readonly string[], options?: { stdin?: string | Buffer | undefined; signal?: AbortSignal | undefined }): Promise<DockerCommandResult>;
  stream(args: readonly string[], options?: { stdin?: string | Buffer | undefined; signal?: AbortSignal | undefined }): AsyncIterable<DockerStreamEvent>;
}

export interface DockerSandboxProviderOptions {
  executor: DockerCommandExecutor;
  imageAllowlist: readonly string[];
  containerNamePrefix?: string | undefined;
  now?: () => Date;
}

export class DockerSandboxProvider implements SandboxProvider {
  readonly kind = "docker" as const;
  readonly #executor: DockerCommandExecutor;
  readonly #imageAllowlist: readonly string[];
  readonly #containerNamePrefix: string;
  readonly #now: () => Date;
  readonly #containers = new Map<string, SandboxHandle>();

  readonly files: SandboxFileApi = {
    read: async (input) => this.readFile(input),
    write: async (input) => this.writeFile(input),
    list: async (input) => this.listFiles(input),
  };

  constructor(options: DockerSandboxProviderOptions) {
    if (options.imageAllowlist.length === 0) throw new Error("DockerSandboxProvider requires at least one allowed image");
    this.#executor = options.executor;
    this.#imageAllowlist = options.imageAllowlist;
    this.#containerNamePrefix = options.containerNamePrefix ?? "berry-sandbox";
    this.#now = options.now ?? (() => new Date());
  }

  async create(input: SandboxCreateInput): Promise<SandboxHandle> {
    const parsed = SandboxCreateInputSchema.parse(input);
    if (!imageAllowed(parsed.image, this.#imageAllowlist)) {
      throw new Error(`Docker image is not allowlisted: ${parsed.image}`);
    }
    const createdAt = this.#now();
    const containerName = `${this.#containerNamePrefix}-${safeName(parsed.request_id)}`;
    const args = [
      "create",
      "--name", containerName,
      "--label", "berry.managed=true",
      "--label", `berry.request_id=${parsed.request_id}`,
      "--label", `berry.tenant_id=${parsed.tenant_id}`,
      "--workdir", parsed.cwd,
      "--cpus", String(parsed.resources.cpuCount),
      "--memory", `${parsed.resources.memoryMiB}m`,
      "--network", parsed.network_policy.egress === "off" ? "none" : "bridge",
      "--stop-timeout", "2",
      ...Object.entries(parsed.env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      ...parsed.mounts.flatMap((mount) => [
        "--mount",
        `type=bind,src=${mount.host_path},dst=${mount.sandbox_path}${mount.readonly ? ",readonly" : ""}`,
      ]),
      parsed.image,
      "sleep",
      "infinity",
    ];
    const create = await this.#executor.run(args);
    assertDockerOk(create, "create sandbox");
    await assertDockerOk(await this.#executor.run(["start", containerName]), "start sandbox");
    const sandbox = SandboxHandleSchema.parse({
      sandbox_id: create.stdout.trim() || containerName,
      request_id: parsed.request_id,
      tenant_id: parsed.tenant_id,
      provider: "docker",
      provider_kind: "docker",
      status: "running",
      image: parsed.image,
      cwd: parsed.cwd,
      created_at: createdAt.toISOString(),
      expires_at: new Date(createdAt.getTime() + parsed.ttl_seconds * 1000).toISOString(),
      metadata: {
        containerName,
        writable_roots: parsed.writable_roots,
        network_policy: parsed.network_policy,
      },
    });
    this.#containers.set(sandbox.sandbox_id, sandbox);
    return sandbox;
  }

  async *exec(input: SandboxExecInput, options: { signal?: AbortSignal | undefined } = {}): AsyncIterable<SandboxExecEvent> {
    const parsed = SandboxExecInputSchema.parse(input);
    const container = this.#containerName(parsed.sandbox_id);
    const command = parsed.command ?? ["sh", "-lc", parsed.code ?? ""];
    yield SandboxExecEventSchema.parse({
      kind: "started",
      sandbox_id: parsed.sandbox_id,
      request_id: parsed.request_id,
      pid: null,
    });
    for await (const event of this.#executor.stream([
      "exec",
      "--workdir", parsed.cwd ?? this.#handle(parsed.sandbox_id).cwd,
      ...Object.entries(parsed.env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      container,
      ...command,
    ], { stdin: parsed.stdin, signal: options.signal })) {
      if (event.stream === "stdout") yield SandboxExecEventSchema.parse({ kind: "stdout", data: event.data });
      if (event.stream === "stderr") yield SandboxExecEventSchema.parse({ kind: "stderr", data: event.data });
      if (event.stream === "exit") {
        yield SandboxExecEventSchema.parse({ kind: "exit", exit_code: event.exitCode, signal: event.signal ?? null });
      }
    }
  }

  async exposePort(input: SandboxExposePortInput): Promise<SandboxExposePortResult> {
    const parsed = SandboxExposePortInputSchema.parse(input);
    const container = this.#containerName(parsed.sandbox_id);
    const inspect = await this.#executor.run([
      "inspect",
      "-f",
      "{{range.NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
      container,
    ]);
    assertDockerOk(inspect, "inspect sandbox network");
    const host = inspect.stdout.trim() || "127.0.0.1";
    return SandboxExposePortResultSchema.parse({
      sandbox_id: parsed.sandbox_id,
      port: parsed.port,
      protocol: parsed.protocol,
      url: `${parsed.protocol === "https" ? "https" : "http"}://${host}:${parsed.port}`,
      expires_at: this.#handle(parsed.sandbox_id).expires_at,
    });
  }

  async destroy(input: SandboxDestroyInput): Promise<SandboxDestroyResult> {
    const parsed = SandboxDestroyInputSchema.parse(input);
    const sandbox = this.#containers.get(parsed.sandbox_id);
    if (!sandbox) {
      return SandboxDestroyResultSchema.parse({ sandbox_id: parsed.sandbox_id, destroyed: false, status: "missing" });
    }
    const result = await this.#executor.run(["rm", "-f", this.#containerName(parsed.sandbox_id)]);
    assertDockerOk(result, "destroy sandbox");
    this.#containers.delete(parsed.sandbox_id);
    return SandboxDestroyResultSchema.parse({ sandbox_id: parsed.sandbox_id, destroyed: true, status: "stopped" });
  }

  async dispose(): Promise<void> {
    for (const sandboxId of [...this.#containers.keys()]) {
      await this.destroy({ sandbox_id: sandboxId, reason: "provider disposed" });
    }
  }

  async readFile(input: SandboxFileReadInput): Promise<SandboxFileReadResult> {
    const parsed = SandboxFileReadInputSchema.parse(input);
    const result = await this.#executor.run(["exec", this.#containerName(parsed.sandbox_id), "cat", parsed.path]);
    assertDockerOk(result, "read sandbox file");
    const content = parsed.encoding === "base64" ? Buffer.from(result.stdout, "utf8").toString("base64") : result.stdout;
    return SandboxFileReadResultSchema.parse({
      path: parsed.path,
      encoding: parsed.encoding,
      content,
      size_bytes: Buffer.byteLength(content, parsed.encoding === "base64" ? "base64" : "utf8"),
      mtime: null,
    });
  }

  async writeFile(input: SandboxFileWriteInput): Promise<SandboxFileWriteResult> {
    const parsed = SandboxFileWriteInputSchema.parse(input);
    const content = parsed.encoding === "base64" ? Buffer.from(parsed.content, "base64") : parsed.content;
    const result = await this.#executor.run([
      "exec",
      "-i",
      this.#containerName(parsed.sandbox_id),
      "sh",
      "-lc",
      "mkdir -p \"$(dirname \"$1\")\" && cat > \"$1\"",
      "berry-write",
      parsed.path,
    ], { stdin: content });
    assertDockerOk(result, "write sandbox file");
    return SandboxFileWriteResultSchema.parse({
      path: parsed.path,
      size_bytes: Buffer.byteLength(content),
      mtime: this.#now().toISOString(),
    });
  }

  async listFiles(input: SandboxFileListInput): Promise<SandboxFileListResult> {
    const parsed = SandboxFileListInputSchema.parse(input);
    const maxDepthArgs = parsed.recursive ? [] : ["-maxdepth", "1"];
    const result = await this.#executor.run([
      "exec",
      this.#containerName(parsed.sandbox_id),
      "find",
      parsed.path,
      ...maxDepthArgs,
      "-printf",
      "%y\t%s\t%T@\t%p\n",
    ]);
    assertDockerOk(result, "list sandbox files");
    return SandboxFileListResultSchema.parse({
      path: parsed.path,
      entries: parseFindOutput(result.stdout),
    });
  }

  #handle(sandboxId: string): SandboxHandle {
    const handle = this.#containers.get(sandboxId);
    if (!handle) throw new Error(`Sandbox not found: ${sandboxId}`);
    return handle;
  }

  #containerName(sandboxId: string): string {
    const metadata = this.#handle(sandboxId).metadata;
    if (metadata && typeof metadata === "object" && !Array.isArray(metadata) && typeof metadata.containerName === "string") {
      return metadata.containerName;
    }
    return sandboxId;
  }
}

export function imageAllowed(image: string, allowlist: readonly string[]): boolean {
  return allowlist.some((pattern) => {
    if (pattern === "*") return true;
    if (pattern.endsWith("*")) return image.startsWith(pattern.slice(0, -1));
    return image === pattern;
  });
}

function assertDockerOk(result: DockerCommandResult, action: string): DockerCommandResult {
  if (result.exitCode !== 0) throw new Error(`Docker ${action} failed: ${result.stderr || result.stdout}`);
  return result;
}

function safeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "sandbox";
}

function parseFindOutput(stdout: string): Array<{ path: string; type: "file" | "directory" | "symlink"; size_bytes: number; mtime: string | null }> {
  return stdout.split("\n").filter(Boolean).map((line) => {
    const [kind, size, mtimeSeconds, path] = line.split("\t");
    const type: "file" | "directory" | "symlink" = kind === "d" ? "directory" : kind === "l" ? "symlink" : "file";
    return {
      path: path ?? "",
      type,
      size_bytes: Number(size ?? 0),
      mtime: mtimeSeconds ? new Date(Number(mtimeSeconds) * 1000).toISOString() : null,
    };
  }).filter((entry) => entry.path.length > 0);
}
