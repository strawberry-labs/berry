import { PassThrough, Readable, Writable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import type { HostPushEvent, JsonValue, Message, Session, Task, Workspace } from "@berry/shared";
import { afterEach, describe, expect, it } from "vitest";
import { createBerryAcpAgent, runBerryAcp, type BerryAcpHost } from "./index.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

class FakeHost implements BerryAcpHost {
  readonly calls: Array<{ method: string; params: JsonValue | undefined }> = [];
  readonly workspace: Workspace = {
    id: "workspace-1",
    path: "/tmp/berry-acp-project",
    name: "berry-acp-project",
    workspaceKind: "project",
    ownerUserId: null,
    trustState: "trusted",
    lastOpenedAt: "2026-07-09T00:00:00.000Z",
    indexedAt: null,
    createdAt: "2026-07-09T00:00:00.000Z",
    updatedAt: "2026-07-09T00:00:00.000Z",
    pinned: false,
  };
  readonly task: Task = {
    id: "task-1",
    workspaceId: "workspace-1",
    title: "Existing ACP task",
    status: "completed",
    activeSessionId: "session-1",
    conversationKind: "chat",
    pinned: false,
    archived: false,
    deletedAt: null,
    unreadAt: null,
    lastReadAt: null,
    worktreePath: null,
    worktreeBranch: null,
    worktreeBaseRef: null,
    worktreeBaseSha: null,
    pullRequestUrl: null,
    pullRequestNumber: null,
    createdAt: "2026-07-09T00:00:00.000Z",
    updatedAt: "2026-07-09T01:00:00.000Z",
  };
  readonly session: Session = {
    id: "session-1",
    taskId: "task-1",
    parentSessionId: null,
    status: "active",
    modelProviderId: "provider-1",
    model: "fixture-model",
    permissionMode: "ask",
    createdAt: "2026-07-09T00:00:00.000Z",
    updatedAt: "2026-07-09T01:00:00.000Z",
  };
  messages: Message[] = [message("message-user", "user", "Earlier question"), message("message-agent", "assistant", "Earlier answer")];
  holdTurns = false;
  questionTurns = false;
  #publisher: (event: HostPushEvent) => void = () => {};

  async initialize(): Promise<void> {}

  async shutdown(): Promise<void> {}

  setPublisher(publisher: (event: HostPushEvent) => void): void {
    this.#publisher = publisher;
  }

  async handle(method: string, params: JsonValue | undefined): Promise<JsonValue | undefined> {
    this.calls.push({ method, params });
    if (method === "workspace.open") return this.workspace as unknown as JsonValue;
    if (method === "workspace.list") return [this.workspace] as unknown as JsonValue;
    if (method === "task.create") return { task: this.task, session: this.session } as unknown as JsonValue;
    if (method === "task.list") return [this.task] as unknown as JsonValue;
    if (method === "task.update") {
      const input = record(params);
      this.task.title = String(input.title ?? this.task.title);
      this.task.updatedAt = "2026-07-09T02:00:00.000Z";
      this.#publisher({ type: "task.updated", task: this.task });
      return this.task as unknown as JsonValue;
    }
    if (method === "session.get") return this.session as unknown as JsonValue;
    if (method === "session.messages") return this.messages as unknown as JsonValue;
    if (method === "model.provider.list") return [{ id: "provider-1", enabled: true }] as unknown as JsonValue;
    if (method === "agent.turn") {
      if (this.holdTurns) return { turnId: "turn-1", sessionId: "session-1" };
      if (this.questionTurns) {
        queueMicrotask(() => {
          this.emit({ kind: "tool.start", toolCallId: "question-tool", name: "ask_user_question", title: "Choose a target" });
          this.emit({
            kind: "question.request",
            questionId: "question-1",
            toolCallId: "question-tool",
            question: "Which target?",
            options: [{ label: "Web", description: "Browser target" }, { label: "Desktop", description: "Native target" }],
            multi: false,
          });
        });
        return { turnId: "turn-1", sessionId: "session-1" };
      }
      queueMicrotask(() => {
        this.emit({ kind: "turn.start", turnId: "turn-1" });
        this.emit({ kind: "tool.start", toolCallId: "tool-1", name: "bash", title: "Run tests", args: { command: "pnpm test" } });
        this.emit({
          kind: "approval.request",
          approvalId: "approval-1",
          approvalKind: "shell",
          title: "Run pnpm test",
          detail: "Execute the test suite",
        });
      });
      return { turnId: "turn-1", sessionId: "session-1" };
    }
    if (method === "approval.decide") {
      queueMicrotask(() => {
        this.emit({ kind: "tool.update", toolCallId: "tool-1", detail: "Tests are running" });
        this.emit({ kind: "tool.end", toolCallId: "tool-1", status: "completed", summary: "12 tests passed" });
        this.emit({ kind: "message.delta", messageId: "message-new", channel: "text", delta: "All tests passed." });
        this.emit({ kind: "turn.end", turnId: "turn-1", status: "completed" });
      });
      return { ok: true };
    }
    if (method === "agent.cancel") {
      this.emit({ kind: "turn.end", turnId: "turn-1", status: "cancelled" });
      return { cancelled: true };
    }
    if (method === "question.answer") {
      queueMicrotask(() => {
        this.emit({ kind: "message.delta", messageId: "message-question", channel: "text", delta: "Using that target." });
        this.emit({ kind: "turn.end", turnId: "turn-1", status: "completed" });
      });
      return { ok: true };
    }
    throw new Error(`Unexpected host method ${method}`);
  }

  emit(event: Extract<HostPushEvent, { type: "agent.event" }>["event"]): void {
    this.#publisher({ type: "agent.event", taskId: this.task.id, sessionId: this.session.id, event });
  }
}

describe("Berry ACP adapter", () => {
  it("streams prompts and translates ACP permission choices to Berry decisions", async () => {
    const host = new FakeHost();
    const updates: acp.SessionNotification[] = [];
    const permissions: acp.RequestPermissionRequest[] = [];
    const client = acp
      .client({ name: "berry-acp-test" })
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
        permissions.push(params);
        return { outcome: { outcome: "selected", optionId: "berry-allow-once" } };
      })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        updates.push(params);
      });
    const connection = client.connect(createBerryAcpAgent(host));
    try {
      const initialized = await connection.agent.request(acp.methods.agent.initialize, initializeRequest());
      expect(initialized).toMatchObject({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: { loadSession: true, promptCapabilities: { image: true, embeddedContext: true }, sessionCapabilities: { list: {} } },
        authMethods: [{ id: "berry-provider-setup", type: "terminal", args: ["doctor"] }],
      });
      await expect(connection.agent.request(acp.methods.agent.authenticate, { methodId: "berry-provider-setup" })).resolves.toEqual({});
      const created = await connection.agent.request(acp.methods.agent.session.new, {
        cwd: host.workspace.path,
        mcpServers: [{ name: "fixture", command: "/usr/bin/env", args: ["node"], env: [{ name: "FIXTURE", value: "1" }] }],
      });
      expect(created.sessionId).toBe(host.session.id);
      const result = await connection.agent.request(acp.methods.agent.session.prompt, {
        sessionId: created.sessionId,
        prompt: [
          { type: "text", text: "Run the tests" },
          { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
          { type: "resource", resource: { uri: "file:///tmp/context.txt", mimeType: "text/plain", text: "fixture context" } },
        ],
      });
      expect(result.stopReason).toBe("end_turn");
      expect(permissions).toHaveLength(1);
      expect(permissions[0]).toMatchObject({ sessionId: "session-1", toolCall: { toolCallId: "tool-1", kind: "execute" } });
      expect(host.calls.find((call) => call.method === "approval.decide")?.params).toEqual({ id: "approval-1", decision: "approved_once" });
      expect(host.calls.find((call) => call.method === "agent.turn")?.params).toMatchObject({
        input: "Run the tests",
        attachments: [
          { mediaType: "image/png", dataUrl: "data:image/png;base64,aGVsbG8=" },
          { mediaType: "text/plain", textContent: "fixture context" },
        ],
        mcpServers: [{ name: "fixture", transport: "stdio", command: "/usr/bin/env", env: { FIXTURE: "1" } }],
      });
      expect(updates.map((update) => update.update.sessionUpdate)).toEqual(expect.arrayContaining([
        "session_info_update",
        "tool_call",
        "tool_call_update",
        "agent_message_chunk",
      ]));
    } finally {
      connection.close();
    }
  });

  it("lists sessions and replays persisted messages on load", async () => {
    const host = new FakeHost();
    const updates: acp.SessionNotification[] = [];
    const client = acp
      .client({ name: "berry-acp-test" })
      .onRequest(acp.methods.client.session.requestPermission, () => ({ outcome: { outcome: "cancelled" } }))
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        updates.push(params);
      });
    const connection = client.connect(createBerryAcpAgent(host));
    try {
      await connection.agent.request(acp.methods.agent.initialize, initializeRequest());
      const listed = await connection.agent.request(acp.methods.agent.session.list, { cwd: host.workspace.path });
      expect(listed.sessions).toEqual([
        expect.objectContaining({ sessionId: "session-1", cwd: host.workspace.path, title: "Existing ACP task" }),
      ]);
      await connection.agent.request(acp.methods.agent.session.load, {
        sessionId: "session-1",
        cwd: host.workspace.path,
        mcpServers: [],
      });
      expect(updates.map((update) => update.update)).toEqual([
        expect.objectContaining({ sessionUpdate: "user_message_chunk", messageId: "message-user", content: { type: "text", text: "Earlier question" } }),
        expect.objectContaining({ sessionUpdate: "agent_message_chunk", messageId: "message-agent", content: { type: "text", text: "Earlier answer" } }),
      ]);
    } finally {
      connection.close();
    }
  });

  it("answers Berry structured questions through ACP form elicitation", async () => {
    const host = new FakeHost();
    host.questionTurns = true;
    const elicitations: acp.CreateElicitationRequest[] = [];
    const client = acp
      .client({ name: "berry-acp-elicitation-test" })
      .onRequest(acp.methods.client.session.requestPermission, () => ({ outcome: { outcome: "cancelled" } }))
      .onRequest(acp.methods.client.elicitation.create, ({ params }) => {
        elicitations.push(params);
        return { action: "accept", content: { answer: "Desktop" } };
      })
      .onNotification(acp.methods.client.session.update, () => {});
    const connection = client.connect(createBerryAcpAgent(host));
    try {
      await connection.agent.request(acp.methods.agent.initialize, {
        ...initializeRequest(),
        clientCapabilities: { elicitation: { form: {} } },
      });
      await connection.agent.request(acp.methods.agent.session.load, { sessionId: "session-1", cwd: host.workspace.path, mcpServers: [] });
      await expect(connection.agent.request(acp.methods.agent.session.prompt, {
        sessionId: "session-1",
        prompt: [{ type: "text", text: "Ask me" }],
      })).resolves.toMatchObject({ stopReason: "end_turn" });
      expect(elicitations[0]).toMatchObject({ mode: "form", message: "Which target?", requestedSchema: { required: ["answer"] } });
      expect(host.calls.find((call) => call.method === "question.answer")?.params).toEqual({
        id: "question-1",
        answer: "Desktop",
        selectedOptions: ["Desktop"],
      });
    } finally {
      connection.close();
    }
  });

  it("cancels an active Berry turn through ACP over NDJSON streams", async () => {
    const host = new FakeHost();
    host.holdTurns = true;
    const clientToAgent = new PassThrough();
    const agentToClient = new PassThrough();
    const run = runBerryAcp({ host, input: clientToAgent, output: agentToClient });
    const client = acp
      .client({ name: "berry-acp-stream-test" })
      .onRequest(acp.methods.client.session.requestPermission, () => ({ outcome: { outcome: "cancelled" } }))
      .onNotification(acp.methods.client.session.update, () => {});
    const stream = acp.ndJsonStream(
      Writable.toWeb(clientToAgent) as unknown as WritableStream<Uint8Array>,
      Readable.toWeb(agentToClient) as unknown as ReadableStream<Uint8Array>,
    );
    const connection = client.connect(stream);
    try {
      await connection.agent.request(acp.methods.agent.initialize, initializeRequest());
      await connection.agent.request(acp.methods.agent.session.load, { sessionId: "session-1", cwd: host.workspace.path, mcpServers: [] });
      const prompt = connection.agent.request(acp.methods.agent.session.prompt, {
        sessionId: "session-1",
        prompt: [{ type: "text", text: "Start long work" }],
      });
      await waitFor(() => host.calls.some((call) => call.method === "agent.turn"));
      await connection.agent.notify(acp.methods.agent.session.cancel, { sessionId: "session-1" });
      await expect(prompt).resolves.toEqual(expect.objectContaining({ stopReason: "cancelled" }));
      expect(host.calls.some((call) => call.method === "agent.cancel")).toBe(true);
    } finally {
      connection.close();
      clientToAgent.end();
      await run;
    }
  });

  it.skipIf(process.platform === "win32")("starts a private authenticated app-server when discovery is absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "berry-acp-standalone-"));
    tempDirs.push(dir);
    const clientToAgent = new PassThrough();
    const agentToClient = new PassThrough();
    const run = runBerryAcp({
      socketPath: join(dir, "missing", "host.sock"),
      tokenPath: join(dir, "missing", "host.sock.token"),
      dbPath: join(dir, "berry.sqlite"),
      input: clientToAgent,
      output: agentToClient,
    });
    const client = acp
      .client({ name: "berry-acp-standalone-test" })
      .onRequest(acp.methods.client.session.requestPermission, () => ({ outcome: { outcome: "cancelled" } }))
      .onNotification(acp.methods.client.session.update, () => {});
    const stream = acp.ndJsonStream(
      Writable.toWeb(clientToAgent) as unknown as WritableStream<Uint8Array>,
      Readable.toWeb(agentToClient) as unknown as ReadableStream<Uint8Array>,
    );
    const connection = client.connect(stream);
    try {
      await expect(connection.agent.request(acp.methods.agent.initialize, initializeRequest())).resolves.toMatchObject({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentInfo: { name: "berry" },
      });
    } finally {
      connection.close();
      clientToAgent.end();
      await run;
    }
  });
});

function initializeRequest(): acp.InitializeRequest {
  return {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    clientInfo: { name: "berry-acp-test", version: "1.0.0" },
  };
}

function message(id: string, role: "user" | "assistant", text: string): Message {
  return {
    id,
    sessionId: "session-1",
    role,
    status: "complete",
    parts: [{ id: `${id}-part`, messageId: id, kind: "text", content: text, position: 0, createdAt: "2026-07-09T00:00:00.000Z" }],
    inputTokens: 0,
    outputTokens: 0,
    generationMs: 0,
    createdAt: "2026-07-09T00:00:00.000Z",
    updatedAt: "2026-07-09T00:00:00.000Z",
  };
}

function record(value: JsonValue | undefined): Record<string, JsonValue | undefined> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue | undefined> : {};
}

async function waitFor(probe: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (probe()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error("Timed out waiting for ACP fixture state");
}
