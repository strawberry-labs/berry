import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlRpcPeer } from "@berry/local-agent-protocol";
import { createAssistantMessageEventStream, type AssistantMessage, type BerryStreamFn } from "@berry/local-agent";
import { PROTOCOL_VERSION, type HostPushEvent, type JsonValue } from "@berry/shared";
import { afterEach, describe, expect, it } from "vitest";
import { startHostSocketServer } from "./socket-server.ts";
import { BerryHostService } from "./service.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("host socket server", () => {
  it.skipIf(process.platform === "win32")("requires a token, assigns a connection owner, and removes discovery files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "berry-host-socket-"));
    tempDirs.push(dir);
    const socketPath = join(dir, "host.sock");
    const calls: Array<{ method: string; params: JsonValue | undefined }> = [];
    const server = await startHostSocketServer({
      socketPath,
      host: {
        async handle(method, params) {
          calls.push({ method, params });
          if (method === "host.handshake") {
            if ((params as { protocolVersion?: number } | undefined)?.protocolVersion === 2) {
              const error = new Error("Unsupported protocol");
              error.name = "protocol_mismatch";
              throw error;
            }
            return { ok: true, protocolVersion: PROTOCOL_VERSION, capabilities: ["jsonl-socket"] };
          }
          return { ok: true };
        },
      },
    });

    expect(statSync(server.socketPath).mode & 0o777).toBe(0o600);
    expect(statSync(server.tokenPath).mode & 0o777).toBe(0o600);

    const socket = createConnection(socketPath);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const peer = new JsonlRpcPeer(socket, socket);
    peer.start();

    await expect(peer.request("workspace.list", {})).rejects.toMatchObject({ name: "unauthorized" });
    await expect(peer.request("host.handshake", { token: "wrong", protocolVersion: PROTOCOL_VERSION })).rejects.toMatchObject({ name: "unauthorized" });
    const token = readFileSync(server.tokenPath, "utf8").trim();
    await expect(peer.request("host.handshake", { token, protocolVersion: 2 })).rejects.toMatchObject({ name: "protocol_mismatch" });
    await expect(peer.request("workspace.list", {})).rejects.toMatchObject({ name: "unauthorized" });
    await expect(peer.request("host.handshake", { token, protocolVersion: PROTOCOL_VERSION })).resolves.toMatchObject({ ok: true });
    await expect(peer.request("agent.cancel", { sessionId: "session_1", owner: "spoofed" })).resolves.toMatchObject({ ok: true });

    const cancel = calls.find((call) => call.method === "agent.cancel");
    expect(cancel?.params).toMatchObject({ sessionId: "session_1", owner: expect.stringMatching(/^app-server:/) });
    expect(cancel?.params).not.toMatchObject({ owner: "spoofed" });

    socket.destroy();
    await server.close();
    expect(existsSync(socketPath)).toBe(false);
    expect(existsSync(server.tokenPath)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("coordinates list, watch, turn, and lease takeover across two clients", async () => {
    const dir = mkdtempSync(join(tmpdir(), "berry-host-clients-"));
    tempDirs.push(dir);
    const socketPath = join(dir, "host.sock");
    const host = new BerryHostService({ dbPath: join(dir, "desktop.db"), agentStreamFn: hangingStreamFn() });
    await host.initialize();
    const server = await startHostSocketServer({ host, socketPath });
    host.setPublisher((event) => server.publish(event));
    const token = readFileSync(server.tokenPath, "utf8").trim();
    const clientAEvents: HostPushEvent[] = [];
    const clientBEvents: HostPushEvent[] = [];
    const clientA = await connectPeer(socketPath, token, clientAEvents);
    const clientB = await connectPeer(socketPath, token, clientBEvents);

    const workspace = (await clientA.peer.request("workspace.open", { path: dir, trusted: true })) as unknown as { id: string };
    const provider = (await clientA.peer.request("model.provider.save", {
      kind: "openrouter-compatible",
      name: "Socket Provider",
      baseUrl: "http://localhost/api/v1",
      defaultModel: "test-model",
      credentialRef: "socket-provider",
    })) as unknown as { id: string };
    const created = (await clientA.peer.request("task.create", { workspaceId: workspace.id, title: "Shared task" })) as unknown as {
      task: { id: string };
      session: { id: string };
    };
    await waitFor(() => clientBEvents.find((event) => event.type === "task.updated"));
    await expect(clientB.peer.request("task.list", { workspaceId: workspace.id })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: created.task.id })]),
    );

    await clientA.peer.request("agent.turn", {
      taskId: created.task.id,
      sessionId: created.session.id,
      input: "hold the lease",
      providerId: provider.id,
      apiKey: "test-key",
      permissionMode: "full-access",
    });
    await waitFor(() => clientAEvents.find((event) => event.type === "agent.event" && event.event.kind === "message.delta"));
    await expect(
      clientB.peer.request("agent.turn", {
        taskId: created.task.id,
        sessionId: created.session.id,
        input: "conflict",
        providerId: provider.id,
        apiKey: "test-key",
        permissionMode: "full-access",
      }),
    ).rejects.toMatchObject({ name: "session_lease_conflict" });
    await clientB.peer.request("agent.takeover", { sessionId: created.session.id, owner: "spoofed" });
    await waitFor(() => clientAEvents.find((event) => event.type === "session.lease.lost" && event.sessionId === created.session.id));
    await expect(clientA.peer.request("agent.cancel", { sessionId: created.session.id })).rejects.toMatchObject({ name: "session_lease_conflict" });
    await expect(clientB.peer.request("agent.cancel", { sessionId: created.session.id })).resolves.toMatchObject({ cancelled: true });

    clientA.socket.destroy();
    clientB.socket.destroy();
    await server.close();
    await host.shutdown();
  }, 10_000);
});

async function connectPeer(socketPath: string, token: string, events: HostPushEvent[]) {
  const socket = createConnection(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const peer = new JsonlRpcPeer(socket, socket, undefined, {
    onNotification(method, params) {
      if (method === "host.event") events.push(params as unknown as HostPushEvent);
    },
  });
  peer.start();
  await peer.request("host.handshake", { token, protocolVersion: PROTOCOL_VERSION });
  return { peer, socket };
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for socket event");
}

function hangingStreamFn(): BerryStreamFn {
  return (model, _context, options) => {
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: [{ type: "text", text: "holding" }],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "aborted",
      timestamp: Date.now(),
    };
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      stream.push({ type: "text_start", contentIndex: 0, partial: message });
      stream.push({ type: "text_delta", contentIndex: 0, delta: "holding", partial: message });
      options?.signal?.addEventListener("abort", () => {
        message.errorMessage = "aborted";
        stream.push({ type: "error", reason: "aborted", error: message });
      }, { once: true });
    });
    return stream;
  };
}
