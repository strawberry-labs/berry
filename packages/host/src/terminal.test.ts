import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HostPushEvent } from "@berry/shared";
import { BerryDatabase } from "@berry/desktop-db";
import { afterEach, describe, expect, it } from "vitest";
import { BerryHostService } from "./service.ts";

const tempDirs: string[] = [];
const savedPtyBin = process.env.BERRY_PTY_BIN;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (savedPtyBin === undefined) delete process.env.BERRY_PTY_BIN;
  else process.env.BERRY_PTY_BIN = savedPtyBin;
});

const SIDECAR_FIXTURE = `
import { createInterface } from "node:readline";
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const seqs = new Map();
const output = (id, text) => {
  const seq = seqs.get(id) ?? 0;
  seqs.set(id, seq + 1);
  emit({ event: "output", id, dataB64: Buffer.from(text, "utf8").toString("base64"), seq });
};
createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  if (command.op === "create") {
    emit({ event: "created", id: command.id });
    output(command.id, "mock:" + command.shell + "\\n");
  } else if (command.op === "write") {
    const data = Buffer.from(command.dataB64, "base64").toString("utf8");
    if (data.includes("die")) process.exit(1);
    else if (data.includes("exit")) emit({ event: "exit", id: command.id, exitCode: 0 });
    else output(command.id, "echo:" + data);
  } else if (command.op === "resize") {
    output(command.id, "resize:" + command.cols + "x" + command.rows + "\\n");
  } else if (command.op === "kill") {
    emit({ event: "exit", id: command.id, exitCode: 143 });
  } else if (command.op === "shutdown") {
    process.exit(0);
  }
});
`;

async function sidecarHost(options: { fixture?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "berry-terminal-"));
  tempDirs.push(dir);
  if (options.fixture !== false) {
    const fixture = join(dir, "pty-fixture.mjs");
    writeFileSync(fixture, SIDECAR_FIXTURE, "utf8");
    process.env.BERRY_PTY_BIN = `${process.execPath} ${fixture}`;
  }
  const events: HostPushEvent[] = [];
  const service = new BerryHostService({ dbPath: join(dir, "desktop.db"), publisher: (event) => events.push(event) });
  await service.initialize();
  const workspace = (await service.handle("workspace.open", { path: dir, trusted: true })) as { id: string };
  return { service, dir, events, workspace };
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = probe();
    if (value !== undefined) return value;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  throw new Error("timed out waiting for condition");
}

function outputEvents(events: HostPushEvent[], terminalId: string): Array<Extract<HostPushEvent, { type: "terminal.output" }>> {
  return events.filter(
    (event): event is Extract<HostPushEvent, { type: "terminal.output" }> => event.type === "terminal.output" && event.terminalId === terminalId,
  );
}

async function terminalRow(service: BerryHostService, id: string): Promise<{ status: string; cols: number; rows: number }> {
  const rows = (await service.handle("terminal.list", {})) as Array<{ id: string; status: string; cols: number; rows: number }>;
  const row = rows.find((candidate) => candidate.id === id);
  if (!row) throw new Error(`terminal row ${id} not found`);
  return row;
}

describe("TerminalService sidecar path", () => {
  it("creates via the sidecar, forwards writes as base64, and persists output and exit", async () => {
    const { service, events, workspace } = await sidecarHost();
    const terminal = (await service.handle("terminal.create", {
      workspaceId: workspace.id,
      permissionMode: "full-access",
      shell: "/bin/zsh",
      cols: 120,
      rows: 32,
    })) as { id: string; status: string };
    expect(terminal.status).toBe("running");
    await expect(terminalRow(service, terminal.id)).resolves.toMatchObject({ status: "running" });

    const banner = await waitFor(() => outputEvents(events, terminal.id).find((event) => event.data === "mock:/bin/zsh\n"));
    expect(banner.seq).toBe(0);

    await service.handle("terminal.write", { id: terminal.id, data: "hello base64\n" });
    const echoed = await waitFor(() => outputEvents(events, terminal.id).find((event) => event.data === "echo:hello base64\n"));
    expect(echoed.seq).toBe(1);

    await service.handle("terminal.resize", { id: terminal.id, cols: 80, rows: 24 });
    const resized = await waitFor(() => outputEvents(events, terminal.id).find((event) => event.data === "resize:80x24\n"));
    expect(resized.seq).toBe(2);
    await expect(terminalRow(service, terminal.id)).resolves.toMatchObject({ cols: 80, rows: 24 });

    await service.handle("terminal.write", { id: terminal.id, data: "exit\n" });
    const exit = await waitFor(() =>
      events.find((event): event is Extract<HostPushEvent, { type: "terminal.exit" }> => event.type === "terminal.exit" && event.terminalId === terminal.id),
    );
    expect(exit.exitCode).toBe(0);
    await expect(terminalRow(service, terminal.id)).resolves.toMatchObject({ status: "exited" });

    const seqs = outputEvents(events, terminal.id).map((event) => event.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));

    const replay = (await service.handle("terminal.events", { id: terminal.id })) as Array<{ kind: string; payload: unknown }>;
    expect(replay.some((event) => event.kind === "stdout" && event.payload === "echo:hello base64\n")).toBe(true);
    expect(replay.some((event) => event.kind === "exit")).toBe(true);

    await expect(service.handle("terminal.write", { id: terminal.id, data: "late\n" })).rejects.toMatchObject({ code: "not_found" });
    await service.shutdown();
  });

  it("marks terminals killed when closed through the sidecar", async () => {
    const { service, events, workspace } = await sidecarHost();
    const terminal = (await service.handle("terminal.create", {
      workspaceId: workspace.id,
      permissionMode: "full-access",
      shell: "/bin/zsh",
    })) as { id: string };
    await service.handle("terminal.close", { id: terminal.id });
    const exit = await waitFor(() =>
      events.find((event): event is Extract<HostPushEvent, { type: "terminal.exit" }> => event.type === "terminal.exit" && event.terminalId === terminal.id),
    );
    expect(exit.exitCode).toBe(143);
    await expect(terminalRow(service, terminal.id)).resolves.toMatchObject({ status: "killed" });
    await service.shutdown();
  });

  it("marks terminals lost when the sidecar dies and restarts it for new terminals", async () => {
    const { service, events, workspace } = await sidecarHost();
    const first = (await service.handle("terminal.create", {
      workspaceId: workspace.id,
      permissionMode: "full-access",
      shell: "/bin/zsh",
    })) as { id: string };
    await waitFor(() => outputEvents(events, first.id).find((event) => event.data.startsWith("mock:")));

    await service.handle("terminal.write", { id: first.id, data: "die\n" });
    const lostExit = await waitFor(() =>
      events.find((event): event is Extract<HostPushEvent, { type: "terminal.exit" }> => event.type === "terminal.exit" && event.terminalId === first.id),
    );
    expect(lostExit.exitCode).toBeNull();
    await expect(terminalRow(service, first.id)).resolves.toMatchObject({ status: "lost" });

    const second = (await service.handle("terminal.create", {
      workspaceId: workspace.id,
      permissionMode: "full-access",
      shell: "/bin/zsh",
    })) as { id: string; status: string };
    expect(second.status).toBe("running");
    await waitFor(() => outputEvents(events, second.id).find((event) => event.data.startsWith("mock:")));
    await service.shutdown();
  });

  it("records active terminals as killed during graceful host shutdown", async () => {
    const { service, dir, workspace } = await sidecarHost();
    const terminal = (await service.handle("terminal.create", {
      workspaceId: workspace.id,
      permissionMode: "full-access",
      shell: "/bin/zsh",
    })) as { id: string };
    await service.shutdown();

    const reopened = new BerryDatabase(join(dir, "desktop.db"));
    reopened.migrate();
    expect(reopened.db.prepare("SELECT status FROM terminals WHERE id = ?").get(terminal.id)).toMatchObject({ status: "killed" });
    expect(reopened.db.prepare("SELECT payload_json FROM terminal_events WHERE terminal_id = ? ORDER BY created_at DESC LIMIT 1").get(terminal.id)).toMatchObject({
      payload_json: expect.stringContaining("host_shutdown"),
    });
    reopened.close();
  });

  it("falls back to child_process shells when the sidecar is disabled", async () => {
    process.env.BERRY_PTY_BIN = "off";
    const { service, events, workspace } = await sidecarHost({ fixture: false });
    const terminal = (await service.handle("terminal.create", {
      workspaceId: workspace.id,
      permissionMode: "full-access",
      shell: "bash",
    })) as { id: string; status: string };
    expect(terminal.status).toBe("running");
    await service.handle("terminal.write", { id: terminal.id, data: "echo fallback-out\nexit\n" });
    const output = await waitFor(() => outputEvents(events, terminal.id).find((event) => event.data.includes("fallback-out")));
    expect(typeof output.seq).toBe("number");
    await waitFor(() => events.find((event) => event.type === "terminal.exit" && event.terminalId === terminal.id));
    await expect(terminalRow(service, terminal.id)).resolves.toMatchObject({ status: "exited" });
    const replay = (await service.handle("terminal.events", { id: terminal.id })) as Array<{ kind: string }>;
    expect(replay.some((event) => event.kind === "stdout")).toBe(true);
    await service.shutdown();
  });

  const realSidecar = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "crates", "berry-pty", "target", "debug", "berry-pty");
  it.runIf(process.env.BERRY_PTY_E2E === "1" && existsSync(realSidecar))("drives a real PTY through the compiled sidecar", async () => {
    process.env.BERRY_PTY_BIN = realSidecar;
    const { service, events, workspace } = await sidecarHost({ fixture: false });
    const terminal = (await service.handle("terminal.create", {
      workspaceId: workspace.id,
      permissionMode: "full-access",
      shell: "/bin/sh",
    })) as { id: string };
    await service.handle("terminal.write", { id: terminal.id, data: "echo real-pty-out\nexit\n" });
    await waitFor(() => outputEvents(events, terminal.id).find((event) => event.data.includes("real-pty-out")), 15_000);
    await waitFor(
      () => events.find((event) => event.type === "terminal.exit" && event.terminalId === terminal.id),
      15_000,
    );
    await expect(terminalRow(service, terminal.id)).resolves.toMatchObject({ status: "exited" });
    await service.shutdown();
  });
});
