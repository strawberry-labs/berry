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

export class FixtureSandboxProvider implements SandboxProvider {
  readonly kind = "fixture" as const;
  readonly #sandboxes = new Map<string, SandboxHandle>();
  readonly #files = new Map<string, Map<string, { content: string; encoding: "utf8" | "base64"; mtime: string }>>();

  readonly files: SandboxFileApi = {
    read: async (input) => this.readFile(input),
    write: async (input) => this.writeFile(input),
    list: async (input) => this.listFiles(input),
  };

  async create(input: SandboxCreateInput): Promise<SandboxHandle> {
    const parsed = SandboxCreateInputSchema.parse(input);
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + parsed.ttl_seconds * 1000);
    const sandbox = SandboxHandleSchema.parse({
      sandbox_id: `fixture_${this.#sandboxes.size + 1}`,
      request_id: parsed.request_id,
      tenant_id: parsed.tenant_id,
      provider: "fixture",
      provider_kind: "fixture",
      status: "running",
      image: parsed.image,
      cwd: parsed.cwd,
      created_at: createdAt.toISOString(),
      expires_at: expiresAt.toISOString(),
      metadata: parsed.metadata,
    });
    this.#sandboxes.set(sandbox.sandbox_id, sandbox);
    this.#files.set(sandbox.sandbox_id, new Map());
    return sandbox;
  }

  async *exec(input: SandboxExecInput): AsyncIterable<SandboxExecEvent> {
    const parsed = SandboxExecInputSchema.parse(input);
    this.#requireSandbox(parsed.sandbox_id);
    yield SandboxExecEventSchema.parse({
      kind: "started",
      sandbox_id: parsed.sandbox_id,
      request_id: parsed.request_id,
      pid: 1,
    });
    if (parsed.command) {
      yield SandboxExecEventSchema.parse({ kind: "stdout", data: parsed.command.join(" ") });
    } else {
      yield SandboxExecEventSchema.parse({ kind: "stdout", data: parsed.code ?? "" });
    }
    yield SandboxExecEventSchema.parse({ kind: "exit", exit_code: 0, signal: null });
  }

  async exposePort(input: SandboxExposePortInput): Promise<SandboxExposePortResult> {
    const parsed = SandboxExposePortInputSchema.parse(input);
    this.#requireSandbox(parsed.sandbox_id);
    return SandboxExposePortResultSchema.parse({
      sandbox_id: parsed.sandbox_id,
      port: parsed.port,
      protocol: parsed.protocol,
      url: `https://${parsed.sandbox_id}-${parsed.port}.sandbox.invalid`,
      expires_at: null,
    });
  }

  async destroy(input: SandboxDestroyInput): Promise<SandboxDestroyResult> {
    const parsed = SandboxDestroyInputSchema.parse(input);
    const existed = this.#sandboxes.delete(parsed.sandbox_id);
    this.#files.delete(parsed.sandbox_id);
    return SandboxDestroyResultSchema.parse({
      sandbox_id: parsed.sandbox_id,
      destroyed: existed,
      status: existed ? "stopped" : "missing",
    });
  }

  async dispose(): Promise<void> {
    this.#sandboxes.clear();
    this.#files.clear();
  }

  async readFile(input: SandboxFileReadInput): Promise<SandboxFileReadResult> {
    const parsed = SandboxFileReadInputSchema.parse(input);
    const files = this.#requireFiles(parsed.sandbox_id);
    const file = files.get(parsed.path);
    if (!file) throw new Error(`File not found in sandbox ${parsed.sandbox_id}: ${parsed.path}`);
    const content = parsed.encoding === file.encoding ? file.content : transcode(file.content, file.encoding, parsed.encoding);
    return SandboxFileReadResultSchema.parse({
      path: parsed.path,
      encoding: parsed.encoding,
      content,
      size_bytes: Buffer.byteLength(content, parsed.encoding === "base64" ? "base64" : "utf8"),
      mtime: file.mtime,
    });
  }

  async writeFile(input: SandboxFileWriteInput): Promise<SandboxFileWriteResult> {
    const parsed = SandboxFileWriteInputSchema.parse(input);
    const files = this.#requireFiles(parsed.sandbox_id);
    const mtime = new Date().toISOString();
    files.set(parsed.path, { content: parsed.content, encoding: parsed.encoding, mtime });
    return SandboxFileWriteResultSchema.parse({
      path: parsed.path,
      size_bytes: Buffer.byteLength(parsed.content, parsed.encoding === "base64" ? "base64" : "utf8"),
      mtime,
    });
  }

  async listFiles(input: SandboxFileListInput): Promise<SandboxFileListResult> {
    const parsed = SandboxFileListInputSchema.parse(input);
    const files = this.#requireFiles(parsed.sandbox_id);
    const prefix = parsed.path.replace(/\/$/, "");
    const entries = [...files.entries()]
      .filter(([path]) => path === prefix || path.startsWith(`${prefix}/`))
      .filter(([path]) => parsed.recursive || path.slice(prefix.length + 1).includes("/") === false)
      .map(([path, file]) => ({
        path,
        type: "file" as const,
        size_bytes: Buffer.byteLength(file.content, file.encoding === "base64" ? "base64" : "utf8"),
        mtime: file.mtime,
      }))
      .sort((left, right) => left.path.localeCompare(right.path));
    return SandboxFileListResultSchema.parse({ path: parsed.path, entries });
  }

  #requireSandbox(sandboxId: string): SandboxHandle {
    const sandbox = this.#sandboxes.get(sandboxId);
    if (!sandbox) throw new Error(`Sandbox not found: ${sandboxId}`);
    return sandbox;
  }

  #requireFiles(sandboxId: string): Map<string, { content: string; encoding: "utf8" | "base64"; mtime: string }> {
    this.#requireSandbox(sandboxId);
    return this.#files.get(sandboxId)!;
  }
}

function transcode(content: string, from: "utf8" | "base64", to: "utf8" | "base64"): string {
  const buffer = Buffer.from(content, from === "base64" ? "base64" : "utf8");
  return buffer.toString(to === "base64" ? "base64" : "utf8");
}
