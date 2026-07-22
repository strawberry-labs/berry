import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BerryDatabase } from "@berry/desktop-db";
import { LocalProcessExecutor } from "@berry/harness/node";
import { createId, nowIso, type HostPushEvent, type JsonValue } from "@berry/shared";
import { HostError } from "./service.ts";

export interface TerminalServiceOptions {
  db: BerryDatabase;
  processExecutor: LocalProcessExecutor;
  publish: (event: HostPushEvent) => void;
  log: (level: string, message: string) => void;
}

export interface TerminalCreateOptions {
  workspaceId: string;
  cwd: string;
  shell: string;
  executable?: string;
  args?: string[];
  cols: number;
  rows: number;
}

interface SidecarTerminal {
  backend: "sidecar";
  id: string;
  closing: boolean;
}

interface ChildTerminal {
  backend: "child";
  id: string;
  process: ChildProcess;
  closing: boolean;
}

type TrackedTerminal = SidecarTerminal | ChildTerminal;

interface SidecarState {
  child: ChildProcess;
  buffer: string;
}

interface PendingCreate {
  resolve: () => void;
  reject: (error: Error) => void;
}

const CREATE_TIMEOUT_MS = 10_000;
const SIDECAR_SHUTDOWN_GRACE_MS = 3_500;

export class TerminalService {
  readonly #db: BerryDatabase;
  readonly #processExecutor: LocalProcessExecutor;
  readonly #publish: (event: HostPushEvent) => void;
  readonly #log: (level: string, message: string) => void;
  readonly #terminals = new Map<string, TrackedTerminal>();
  readonly #childSeq = new Map<string, number>();
  readonly #pendingCreates = new Map<string, PendingCreate>();
  #sidecar: SidecarState | undefined;
  #disposed = false;

  constructor(options: TerminalServiceOptions) {
    this.#db = options.db;
    this.#processExecutor = options.processExecutor;
    this.#publish = options.publish;
    this.#log = options.log;
  }

  async create(options: TerminalCreateOptions): Promise<JsonValue> {
    const id = createId("term");
    const now = nowIso();
    const sidecar = this.#ensureSidecar();
    if (sidecar) {
      this.#terminals.set(id, { backend: "sidecar", id, closing: false });
      this.#insertRow(id, options, now);
      try {
        await this.#createOnSidecar(sidecar, id, options);
      } catch (error) {
        this.#terminals.delete(id);
        this.#setStatus(id, "exited");
        throw error;
      }
      return this.#snapshot(id, options, now);
    }
    const child = this.#processExecutor.spawn(options.executable ?? options.shell, options.args ?? [], { cwd: options.cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    this.#terminals.set(id, { backend: "child", id, process: child, closing: false });
    this.#childSeq.set(id, 0);
    this.#insertRow(id, options, now);
    const pushOutput = (data: string) => {
      const seq = this.#childSeq.get(id) ?? 0;
      this.#childSeq.set(id, seq + 1);
      this.#publish({ type: "terminal.output", terminalId: id, seq, data });
    };
    child.stdout?.on("data", (data) => {
      if (this.#disposed) return;
      const text = data.toString("utf8");
      this.#event(id, "stdout", text);
      pushOutput(text);
    });
    child.stderr?.on("data", (data) => {
      if (this.#disposed) return;
      const text = data.toString("utf8");
      this.#event(id, "stderr", text);
      pushOutput(text);
    });
    child.on("exit", (code, signal) => {
      if (this.#disposed) return;
      this.#event(id, "exit", { code: code ?? null, signal: signal ?? null });
      const terminal = this.#terminals.get(id);
      this.#setStatus(id, terminal?.backend === "child" && terminal.closing ? "killed" : "exited");
      this.#terminals.delete(id);
      this.#childSeq.delete(id);
      this.#publish({ type: "terminal.exit", terminalId: id, exitCode: code ?? null });
    });
    return this.#snapshot(id, options, now);
  }

  write(id: string, data: string): JsonValue {
    const terminal = this.#terminals.get(id);
    if (!terminal) throw new HostError("not_found", "Terminal session not found");
    if (terminal.backend === "sidecar") {
      if (!this.#sidecar) throw new HostError("not_found", "Terminal session not found");
      this.#send(this.#sidecar, { op: "write", id, dataB64: Buffer.from(data, "utf8").toString("base64") });
    } else {
      terminal.process.stdin?.write(data);
    }
    return { ok: true };
  }

  resize(id: string, cols: number, rows: number): JsonValue {
    this.#db.db.prepare("UPDATE terminals SET cols = ?, rows = ?, updated_at = ? WHERE id = ?").run(cols, rows, nowIso(), id);
    const terminal = this.#terminals.get(id);
    if (terminal?.backend === "sidecar" && this.#sidecar) this.#send(this.#sidecar, { op: "resize", id, cols, rows });
    return { ok: true };
  }

  async close(id: string): Promise<JsonValue> {
    const terminal = this.#terminals.get(id);
    if (terminal?.backend === "sidecar") {
      terminal.closing = true;
      if (this.#sidecar) this.#send(this.#sidecar, { op: "kill", id });
    } else if (terminal) {
      terminal.closing = true;
      await this.#processExecutor.terminate(terminal.process);
    }
    return { ok: true };
  }

  events(id: string, limit: number): JsonValue {
    return (
      this.#db.db
        .prepare("SELECT id, terminal_id, kind, payload_json, created_at FROM terminal_events WHERE terminal_id = ? ORDER BY created_at ASC LIMIT ?")
        .all(id, limit) as Array<{
        id: string;
        terminal_id: string;
        kind: string;
        payload_json: string;
        created_at: string;
      }>
    ).map((event) => ({
      id: event.id,
      terminalId: event.terminal_id,
      kind: event.kind,
      payload: JSON.parse(event.payload_json) as JsonValue,
      createdAt: event.created_at,
    })) as JsonValue;
  }

  list(): JsonValue {
    return (
      this.#db.db.prepare("SELECT * FROM terminals ORDER BY updated_at DESC").all() as Array<{
        id: string;
        workspace_id: string;
        cwd: string;
        shell: string;
        cols: number;
        rows: number;
        status: string;
        created_at: string;
        updated_at: string;
      }>
    ).map((terminal) => ({
      id: terminal.id,
      workspaceId: terminal.workspace_id,
      cwd: terminal.cwd,
      shell: terminal.shell,
      cols: terminal.cols,
      rows: terminal.rows,
      status: terminal.status,
      createdAt: terminal.created_at,
      updatedAt: terminal.updated_at,
    })) as JsonValue;
  }

  markOrphansLost(): void {
    const rows = this.#db.db
      .prepare("SELECT id FROM terminals WHERE status IN ('starting', 'running', 'reattached')")
      .all() as Array<{ id: string }>;
    for (const row of rows) {
      this.#event(row.id, "exit", { code: null, signal: "host_restarted" });
      this.#setStatus(row.id, "lost");
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const childProcesses: ChildProcess[] = [];
    for (const terminal of this.#terminals.values()) {
      if (terminal.backend === "child") childProcesses.push(terminal.process);
      try {
        this.#event(terminal.id, "exit", { code: null, signal: "host_shutdown" });
        this.#setStatus(terminal.id, "killed");
        this.#publish({ type: "terminal.exit", terminalId: terminal.id, exitCode: null });
      } catch (error) {
        this.#log("error", `terminal shutdown persistence failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.#terminals.clear();
    this.#childSeq.clear();
    for (const pending of this.#pendingCreates.values()) pending.reject(new HostError("terminal_lost", "Terminal service disposed"));
    this.#pendingCreates.clear();
    const sidecar = this.#sidecar;
    this.#sidecar = undefined;
    await Promise.allSettled(childProcesses.map((child) => this.#processExecutor.terminate(child)));
    if (sidecar) {
      try {
        sidecar.child.stdin?.write(`${JSON.stringify({ op: "shutdown" })}\n`);
        sidecar.child.stdin?.end();
      } catch {
        // The executor below still enforces process-group cleanup.
      }
      if (!(await this.#processExecutor.waitForExit(sidecar.child, SIDECAR_SHUTDOWN_GRACE_MS))) {
        await this.#processExecutor.terminate(sidecar.child);
      }
      sidecar.child.stdout?.destroy();
      sidecar.child.stderr?.destroy();
    }
  }

  #snapshot(id: string, options: TerminalCreateOptions, now: string): JsonValue {
    return {
      id,
      workspaceId: options.workspaceId,
      cwd: options.cwd,
      shell: options.shell,
      cols: options.cols,
      rows: options.rows,
      status: "running",
      createdAt: now,
      updatedAt: now,
    };
  }

  #insertRow(id: string, options: TerminalCreateOptions, now: string): void {
    this.#db.db
      .prepare("INSERT INTO terminals (id, workspace_id, cwd, shell, cols, rows, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, options.workspaceId, options.cwd, options.shell, options.cols, options.rows, "running", now, now);
  }

  #setStatus(id: string, status: string): void {
    this.#db.db.prepare("UPDATE terminals SET status = ?, updated_at = ? WHERE id = ?").run(status, nowIso(), id);
  }

  #event(terminalId: string, kind: string, payload: JsonValue): void {
    this.#db.db
      .prepare("INSERT INTO terminal_events (id, terminal_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(createId("tevt"), terminalId, kind, JSON.stringify(payload), nowIso());
  }

  #createOnSidecar(sidecar: SidecarState, id: string, options: TerminalCreateOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingCreates.delete(id);
        reject(new HostError("terminal_spawn_failed", "PTY sidecar did not acknowledge create"));
      }, CREATE_TIMEOUT_MS);
      timer.unref();
      this.#pendingCreates.set(id, {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.#send(sidecar, { op: "create", id, shell: options.executable ?? options.shell, args: options.args ?? [], cwd: options.cwd, cols: options.cols, rows: options.rows, env: {} });
    });
  }

  #send(sidecar: SidecarState, command: Record<string, JsonValue>): void {
    try {
      sidecar.child.stdin?.write(`${JSON.stringify(command)}\n`);
    } catch (error) {
      this.#log("error", `berry-pty write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  #ensureSidecar(): SidecarState | undefined {
    if (this.#disposed) return undefined;
    if (this.#sidecar) return this.#sidecar;
    const resolved = resolvePtyCommand();
    if (!resolved) return undefined;
    const child = this.#processExecutor.spawn(resolved.command, resolved.args, { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    const state: SidecarState = { child, buffer: "" };
    child.stdin?.on("error", (error) => this.#log("error", `berry-pty stdin: ${error.message}`));
    child.stdout?.on("data", (chunk) => {
      state.buffer += chunk.toString("utf8");
      let index = state.buffer.indexOf("\n");
      while (index >= 0) {
        const line = state.buffer.slice(0, index).trim();
        state.buffer = state.buffer.slice(index + 1);
        index = state.buffer.indexOf("\n");
        if (!line) continue;
        try {
          this.#onSidecarEvent(JSON.parse(line) as Record<string, JsonValue>);
        } catch (error) {
          this.#log("error", `berry-pty event parse failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    });
    child.stderr?.on("data", (chunk) => this.#log("error", `berry-pty: ${String(chunk).trim()}`));
    child.on("error", (error) => {
      if (this.#sidecar === state) this.#onSidecarGone(`PTY sidecar failed: ${error.message}`);
    });
    child.on("exit", (code) => {
      if (this.#sidecar === state) this.#onSidecarGone(`PTY sidecar exited with code ${code ?? "null"}`);
    });
    this.#sidecar = state;
    return state;
  }

  #onSidecarEvent(event: Record<string, JsonValue>): void {
    if (this.#disposed) return;
    const id = typeof event.id === "string" ? event.id : "";
    if (event.event === "created") {
      const pending = this.#pendingCreates.get(id);
      this.#pendingCreates.delete(id);
      pending?.resolve();
      return;
    }
    if (event.event === "output") {
      const data = Buffer.from(typeof event.dataB64 === "string" ? event.dataB64 : "", "base64").toString("utf8");
      const seq = typeof event.seq === "number" ? event.seq : 0;
      this.#event(id, "stdout", data);
      this.#publish({ type: "terminal.output", terminalId: id, seq, data });
      return;
    }
    if (event.event === "exit") {
      const terminal = this.#terminals.get(id);
      const exitCode = typeof event.exitCode === "number" ? event.exitCode : null;
      this.#event(id, "exit", { code: exitCode, signal: null });
      this.#setStatus(id, terminal?.backend === "sidecar" && terminal.closing ? "killed" : "exited");
      this.#terminals.delete(id);
      this.#publish({ type: "terminal.exit", terminalId: id, exitCode });
      return;
    }
    if (event.event === "error") {
      const message = typeof event.message === "string" ? event.message : "unknown sidecar error";
      const pending = this.#pendingCreates.get(id);
      if (pending) {
        this.#pendingCreates.delete(id);
        pending.reject(new HostError("terminal_spawn_failed", message));
        return;
      }
      this.#log("error", `berry-pty: ${message}`);
    }
  }

  #onSidecarGone(reason: string): void {
    if (this.#disposed) return;
    this.#sidecar = undefined;
    this.#log("error", reason);
    for (const pending of this.#pendingCreates.values()) pending.reject(new HostError("terminal_lost", reason));
    this.#pendingCreates.clear();
    for (const terminal of [...this.#terminals.values()]) {
      if (terminal.backend !== "sidecar") continue;
      this.#terminals.delete(terminal.id);
      this.#event(terminal.id, "exit", { code: null, signal: "lost" });
      this.#setStatus(terminal.id, "lost");
      this.#publish({ type: "terminal.exit", terminalId: terminal.id, exitCode: null });
    }
  }
}

function resolvePtyCommand(): { command: string; args: string[] } | undefined {
  const fromEnv = process.env.BERRY_PTY_BIN;
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    const value = fromEnv.trim();
    if (["off", "0", "false", "disabled"].includes(value.toLowerCase())) return undefined;
    if (existsSync(value)) return { command: value, args: [] };
    const [command, ...args] = value.split(/\s+/);
    return command ? { command, args } : undefined;
  }
  const binary = process.platform === "win32" ? "berry-pty.exe" : "berry-pty";
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, binary),
    join(here, "..", binary),
    ...(process.env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((dir) => join(dir, binary)),
    join(here, "..", "..", "..", "crates", "berry-pty", "target", "release", binary),
    join(here, "..", "..", "..", "crates", "berry-pty", "target", "debug", binary),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  return found ? { command: found, args: [] } : undefined;
}
