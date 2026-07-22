import { randomUUID } from "node:crypto";
import { BadRequestException, Injectable } from "@nestjs/common";
import type {
  CloudGitState,
  CloudPreview,
  CloudTerminalEvent,
  CloudTerminalSession,
  CloudWorkspaceFileEntry,
  CloudWorkspaceState,
} from "@berry/shared";
import type { SandboxExecEvent, SandboxProvider } from "@berry/sandbox-contract";
import type { CloudDatabaseService } from "../db/cloud-database.service.ts";

export const SANDBOX_WORKSPACE_SERVICE = Symbol("SANDBOX_WORKSPACE_SERVICE");
const ROOT = "/workspace" as const;
const MAX_FILE_BYTES = 1_048_576;
const MAX_TERMINAL_INPUT = 16_384;
const MAX_TERMINAL_OUTPUT = 262_144;

type WorkspaceRecord = CloudWorkspaceState & { tenantId: string };
type TerminalRecord = CloudTerminalSession & { events: CloudTerminalEvent[]; controller: AbortController | null };

export interface SandboxWorkspaceRepository {
  get(tenantId: string, taskId: string): Promise<WorkspaceRecord | null>;
  put(record: WorkspaceRecord): Promise<void>;
}

export class InMemorySandboxWorkspaceRepository implements SandboxWorkspaceRepository {
  readonly #records = new Map<string, WorkspaceRecord>();
  get(tenantId: string, taskId: string) { return Promise.resolve(this.#records.get(`${tenantId}:${taskId}`) ?? null); }
  async put(record: WorkspaceRecord) { this.#records.set(`${record.tenantId}:${record.taskId}`, record); }
}

export class PostgresSandboxWorkspaceRepository implements SandboxWorkspaceRepository {
  constructor(private readonly database: CloudDatabaseService) {}
  async get(tenantId: string, taskId: string): Promise<WorkspaceRecord | null> {
    const rows = await this.database.withTenant(tenantId, (db) => db.query<{
      tenant_id: string; task_id: string; sandbox_id: string; status: "running" | "recovering" | "failed"; root: string; provider: string; expires_at: Date | string | null; updated_at: Date | string;
    }>("SELECT tenant_id, task_id, sandbox_id, status, root, provider, expires_at, updated_at FROM sandbox_workspaces WHERE task_id = $1", [taskId]));
    const row = rows[0];
    return row ? { tenantId: row.tenant_id, taskId: row.task_id, sandboxId: row.sandbox_id, status: row.status, root: ROOT, provider: row.provider, expiresAt: iso(row.expires_at), updatedAt: iso(row.updated_at)! } : null;
  }
  async put(record: WorkspaceRecord): Promise<void> {
    await this.database.withTenant(record.tenantId, (db) => db.execute(`
      INSERT INTO sandbox_workspaces (tenant_id, task_id, sandbox_id, status, root, provider, expires_at, updated_at)
      VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz)
      ON CONFLICT (tenant_id, task_id) DO UPDATE SET sandbox_id = EXCLUDED.sandbox_id, status = EXCLUDED.status, root = EXCLUDED.root, provider = EXCLUDED.provider, expires_at = EXCLUDED.expires_at, updated_at = EXCLUDED.updated_at
    `, [record.tenantId, record.taskId, record.sandboxId, record.status, record.root, record.provider, record.expiresAt, record.updatedAt]));
  }
}

export type SandboxWorkspaceServiceOptions = {
  provider: SandboxProvider;
  repository?: SandboxWorkspaceRepository;
  image?: string;
  ttlSeconds?: number;
};

@Injectable()
export class SandboxWorkspaceService {
  readonly #provider: SandboxProvider;
  readonly #repository: SandboxWorkspaceRepository;
  readonly #image: string;
  readonly #ttlSeconds: number;
  readonly #terminals = new Map<string, TerminalRecord>();
  readonly #previews = new Map<string, CloudPreview[]>();

  constructor(options: SandboxWorkspaceServiceOptions) {
    this.#provider = options.provider;
    this.#repository = options.repository ?? new InMemorySandboxWorkspaceRepository();
    this.#image = options.image ?? "node:22-bookworm";
    this.#ttlSeconds = options.ttlSeconds ?? 3600;
  }

  async ensure(tenantId: string, taskId: string, sessionId: string | null): Promise<CloudWorkspaceState> {
    const existing = await this.#repository.get(tenantId, taskId);
    if (existing && (!existing.expiresAt || Date.parse(existing.expiresAt) > Date.now())) return publicState(existing);
    const sandbox = await this.#provider.create({
      request_id: `web-workspace-${taskId}`,
      tenant_id: tenantId,
      task_id: taskId,
      session_id: sessionId,
      image: this.#image,
      cwd: ROOT,
      ttl_seconds: this.#ttlSeconds,
      writable_roots: [ROOT],
      network_policy: { egress: "off", allowedDomains: [] },
      metadata: { surface: "web-code-workspace" },
    });
    const record: WorkspaceRecord = {
      tenantId,
      taskId,
      sandboxId: sandbox.sandbox_id,
      status: "running",
      root: ROOT,
      provider: sandbox.provider,
      expiresAt: sandbox.expires_at,
      updatedAt: new Date().toISOString(),
    };
    await this.#repository.put(record);
    return publicState(record);
  }

  async listFiles(state: CloudWorkspaceState, path: string = ROOT): Promise<CloudWorkspaceFileEntry[]> {
    const safePath = workspacePath(path);
    const result = await this.#provider.files.list({ sandbox_id: state.sandboxId, path: safePath, recursive: false });
    return result.entries.slice(0, 2_000).map((entry) => ({ path: entry.path, type: entry.type, sizeBytes: entry.size_bytes, mtime: entry.mtime }));
  }

  async readFile(state: CloudWorkspaceState, path: string) {
    const result = await this.#provider.files.read({ sandbox_id: state.sandboxId, path: workspacePath(path), encoding: "utf8" });
    if (result.size_bytes > MAX_FILE_BYTES || Buffer.byteLength(result.content, "utf8") > MAX_FILE_BYTES) throw new Error("File exceeds the 1 MB browser editor limit");
    return { path: result.path, content: result.content, sizeBytes: result.size_bytes, mtime: result.mtime };
  }

  async writeFile(state: CloudWorkspaceState, path: string, content: string) {
    if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) throw new Error("File exceeds the 1 MB browser editor limit");
    const result = await this.#provider.files.write({ sandbox_id: state.sandboxId, path: workspacePath(path), encoding: "utf8", content });
    return { path: result.path, sizeBytes: result.size_bytes, mtime: result.mtime };
  }

  listTerminals(taskId: string): CloudTerminalSession[] {
    return [...this.#terminals.values()].filter((terminal) => terminal.taskId === taskId).map(publicTerminal);
  }

  createTerminal(taskId: string, cols: number, rows: number): CloudTerminalSession {
    const now = new Date().toISOString();
    const terminal: TerminalRecord = { id: `terminal_${randomUUID()}`, taskId, status: "running", cols, rows, createdAt: now, updatedAt: now, events: [], controller: null };
    this.#terminals.set(terminal.id, terminal);
    return publicTerminal(terminal);
  }

  resizeTerminal(taskId: string, terminalId: string, cols: number, rows: number): CloudTerminalSession {
    const terminal = this.#terminal(taskId, terminalId);
    terminal.cols = cols; terminal.rows = rows; terminal.updatedAt = new Date().toISOString();
    return publicTerminal(terminal);
  }

  closeTerminal(taskId: string, terminalId: string): CloudTerminalSession {
    const terminal = this.#terminal(taskId, terminalId);
    terminal.controller?.abort(); terminal.controller = null; terminal.status = "closed"; terminal.updatedAt = new Date().toISOString();
    return publicTerminal(terminal);
  }

  terminalEvents(taskId: string, terminalId: string, after = -1): CloudTerminalEvent[] {
    return this.#terminal(taskId, terminalId).events.filter((event) => event.ordinal > after);
  }

  async writeTerminal(state: CloudWorkspaceState, terminalId: string, input: string): Promise<CloudTerminalSession> {
    if (!input.trim() || input.length > MAX_TERMINAL_INPUT) throw new Error("Terminal input must be between 1 and 16384 characters");
    const terminal = this.#terminal(state.taskId, terminalId);
    if (terminal.status === "closed") throw new Error("Terminal is closed");
    terminal.status = "running";
    this.#push(terminal, "input", input);
    const controller = new AbortController();
    terminal.controller = controller;
    try {
      for await (const event of this.#provider.exec({ sandbox_id: state.sandboxId, request_id: `web-terminal-${randomUUID()}`, command: ["sh", "-lc", input], cwd: ROOT, timeout_ms: 120_000 }, { signal: controller.signal })) {
        this.#consumeExec(terminal, event);
      }
      if (terminal.status === "running") terminal.status = "exited";
    } catch (error) {
      terminal.status = "failed";
      this.#push(terminal, "error", error instanceof Error ? error.message : "Terminal command failed");
    } finally {
      terminal.controller = null; terminal.updatedAt = new Date().toISOString();
    }
    return publicTerminal(terminal);
  }

  queueTerminal(state: CloudWorkspaceState, terminalId: string, input: string): CloudTerminalSession {
    const terminal = this.#terminal(state.taskId, terminalId);
    void this.writeTerminal(state, terminalId, input);
    return publicTerminal(terminal);
  }

  async gitState(state: CloudWorkspaceState): Promise<CloudGitState> {
    const status = await this.#execText(state, "git status --short --branch 2>/dev/null || true", 262_144);
    const diff = await this.#execText(state, "git diff --no-ext-diff --no-color 2>/dev/null || true", 1_048_576);
    const first = status.split("\n")[0] ?? "";
    return { branch: first.startsWith("## ") ? first.slice(3).split("...")[0] || null : null, clean: status.trim() === "" || status.trim().startsWith("## ") && status.trim().split("\n").length === 1, status, diff };
  }

  async exposePreview(state: CloudWorkspaceState, port: number): Promise<CloudPreview> {
    const exposed = await this.#provider.exposePort({ sandbox_id: state.sandboxId, port, protocol: "http", visibility: "private" });
    const preview = { port: exposed.port, protocol: exposed.protocol === "https" ? "https" as const : "http" as const, url: exposed.url, expiresAt: exposed.expires_at };
    const current = this.#previews.get(state.taskId) ?? [];
    this.#previews.set(state.taskId, [...current.filter((entry) => entry.port !== port), preview]);
    return preview;
  }

  listPreviews(taskId: string): CloudPreview[] { return this.#previews.get(taskId) ?? []; }

  async #execText(state: CloudWorkspaceState, command: string, limit: number): Promise<string> {
    let output = "";
    for await (const event of this.#provider.exec({ sandbox_id: state.sandboxId, request_id: `web-workspace-${randomUUID()}`, command: ["sh", "-lc", command], cwd: ROOT, timeout_ms: 30_000 })) {
      if (event.kind === "stdout" || event.kind === "stderr") output = (output + event.data).slice(0, limit);
    }
    return output;
  }

  #consumeExec(terminal: TerminalRecord, event: SandboxExecEvent) {
    if (event.kind === "stdout" || event.kind === "stderr") this.#push(terminal, event.kind, event.data);
    else if (event.kind === "error") this.#push(terminal, "error", event.message);
    else if (event.kind === "exit") { this.#push(terminal, "exit", String(event.exit_code ?? "")); terminal.status = event.exit_code === 0 ? "exited" : "failed"; }
  }

  #push(terminal: TerminalRecord, kind: CloudTerminalEvent["kind"], data: string) {
    const used = terminal.events.reduce((sum, event) => sum + event.data.length, 0);
    if (used >= MAX_TERMINAL_OUTPUT) return;
    terminal.events.push({ ordinal: terminal.events.length, kind, data: data.slice(0, MAX_TERMINAL_OUTPUT - used) });
  }

  #terminal(taskId: string, terminalId: string): TerminalRecord {
    const terminal = this.#terminals.get(terminalId);
    if (!terminal || terminal.taskId !== taskId) throw new Error("Terminal not found");
    return terminal;
  }
}

function workspacePath(path: string): string {
  const value = path.trim().replaceAll("\\", "/");
  const absolute = value.startsWith("/") ? value : `${ROOT}/${value}`;
  const segments = absolute.split("/").filter(Boolean);
  if (segments[0] !== "workspace" || segments.some((segment) => segment === "." || segment === "..")) throw new BadRequestException("Path is outside the sandbox workspace");
  return `/${segments.join("/")}`;
}

function publicState(record: WorkspaceRecord): CloudWorkspaceState { const { tenantId: _, ...state } = record; return state; }
function publicTerminal(record: TerminalRecord): CloudTerminalSession { const { events: _, controller: __, ...session } = record; return session; }
function iso(value: Date | string | null): string | null { return value === null ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString(); }
