import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import {
  BerryHostService,
  defaultHostSocketPath,
  HostSocketClient,
  hostSocketTokenPath,
  startHostSocketServer,
  type HostRpcEndpoint,
} from "@berry/host";
import type {
  AgentStreamEvent,
  AttachmentInput,
  HostPushEvent,
  JsonValue,
  Message,
  RuntimeMcpServer,
  Session,
  Task,
  Workspace,
} from "@berry/shared";

export const BERRY_ACP_VERSION = "0.1.0";
const SESSION_PAGE_SIZE = 50;

export interface BerryAcpHost extends HostRpcEndpoint {}

interface SessionBinding {
  sessionId: string;
  taskId: string;
  workspaceId: string;
  cwd: string;
  mcpServers: RuntimeMcpServer[];
  titleSet: boolean;
}

interface PromptCompletion {
  status: "completed" | "cancelled" | "failed";
}

interface ActivePrompt {
  binding: SessionBinding;
  client: acp.AgentContext;
  completion: Promise<PromptCompletion>;
  finish: (value: PromptCompletion) => void;
  delivery: Promise<void>;
  lastToolCallId: string | null;
  finished: boolean;
}

export interface RunBerryAcpOptions {
  socketPath?: string;
  tokenPath?: string;
  dbPath?: string;
  host?: BerryAcpHost;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

export class BerryAcpAdapter {
  readonly #host: BerryAcpHost;
  readonly #bindings = new Map<string, SessionBinding>();
  readonly #active = new Map<string, ActivePrompt>();
  #connectionClient: acp.AgentContext | null = null;
  #supportsElicitation = false;

  constructor(host: BerryAcpHost) {
    this.#host = host;
    this.#host.setPublisher((event) => this.#onHostEvent(event));
  }

  setClient(client: acp.AgentContext): void {
    this.#connectionClient = client;
  }

  initialize(params: acp.InitializeRequest): acp.InitializeResponse {
    this.#supportsElicitation = params.clientCapabilities?.elicitation?.form != null;
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, embeddedContext: true },
        mcpCapabilities: { sse: true },
        sessionCapabilities: { list: {} },
      },
      agentInfo: { name: "berry", title: "Berry", version: BERRY_ACP_VERSION },
      authMethods: [{
        id: "berry-provider-setup",
        name: "Configure a Berry model provider",
        description: "Run Berry provider diagnostics and configure a model provider before starting a session.",
        type: "terminal",
        args: ["doctor"],
      }],
    };
  }

  async authenticate(params: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse> {
    if (params.methodId !== "berry-provider-setup") throw new Error(`Unknown Berry authentication method ${params.methodId}`);
    const providers = await this.#host.handle("model.provider.list", {}) as unknown as Array<{ enabled?: boolean }>;
    if (!providers.some((provider) => provider.enabled)) {
      throw new Error("No Berry model provider is enabled. Configure one in Berry Desktop or set FIREWORKS_API_KEY before starting the app-server.");
    }
    return {};
  }

  async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    const cwd = resolve(params.cwd);
    const workspace = await this.#host.handle("workspace.open", { path: cwd, trusted: true }) as unknown as Workspace;
    const created = await this.#host.handle("task.create", {
      workspaceId: workspace.id,
      title: `ACP: ${basename(cwd) || cwd}`,
      permissionMode: "ask",
    }) as unknown as { task: Task; session: Session };
    this.#bindings.set(created.session.id, {
      sessionId: created.session.id,
      taskId: created.task.id,
      workspaceId: workspace.id,
      cwd: workspace.path,
      mcpServers: acpMcpServers(params.mcpServers),
      titleSet: false,
    });
    return { sessionId: created.session.id };
  }

  async loadSession(params: acp.LoadSessionRequest, client: acp.AgentContext): Promise<acp.LoadSessionResponse> {
    const binding = await this.#resolveBinding(params.sessionId, params.cwd);
    binding.mcpServers = acpMcpServers(params.mcpServers);
    this.#bindings.set(binding.sessionId, binding);
    const messages = await this.#host.handle("session.messages", { sessionId: binding.sessionId }) as unknown as Message[];
    for (const message of messages) {
      for (const content of messageContents(message)) {
        await client.notify(acp.methods.client.session.update, {
          sessionId: binding.sessionId,
          update: {
            sessionUpdate: message.role === "user" ? "user_message_chunk" : "agent_message_chunk",
            messageId: message.id,
            content,
          },
        });
      }
    }
    return {};
  }

  async listSessions(params: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse> {
    const offset = decodeCursor(params.cursor);
    const cwdFilter = params.cwd ? resolve(params.cwd) : null;
    const workspaces = await this.#host.handle("workspace.list", {}) as unknown as Workspace[];
    const sessions: acp.SessionInfo[] = [];
    for (const workspace of workspaces) {
      if (cwdFilter && resolve(workspace.path) !== cwdFilter) continue;
      const tasks = await this.#host.handle("task.list", {
        workspaceId: workspace.id,
        includeArchived: true,
        includeDeleted: false,
      }) as unknown as Task[];
      for (const task of tasks) {
        if (!task.activeSessionId) continue;
        sessions.push({
          sessionId: task.activeSessionId,
          cwd: workspace.path,
          title: task.title,
          updatedAt: task.updatedAt,
          _meta: { berryTaskId: task.id, berryStatus: task.status },
        });
      }
    }
    sessions.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
    const page = sessions.slice(offset, offset + SESSION_PAGE_SIZE);
    const nextOffset = offset + page.length;
    return {
      sessions: page,
      ...(nextOffset < sessions.length ? { nextCursor: encodeCursor(nextOffset) } : {}),
    };
  }

  async prompt(params: acp.PromptRequest, client: acp.AgentContext, signal: AbortSignal): Promise<acp.PromptResponse> {
    const binding = this.#bindings.get(params.sessionId) ?? await this.#resolveBinding(params.sessionId);
    if (this.#active.has(params.sessionId)) throw new Error(`Session ${params.sessionId} already has an active prompt`);
    const prepared = preparePrompt(params.prompt);
    if (!binding.titleSet && prepared.text.trim()) {
      const title = prepared.text.trim().replace(/\s+/g, " ").slice(0, 80);
      await this.#host.handle("task.update", { id: binding.taskId, title });
      binding.titleSet = true;
    }

    let resolveCompletion!: (value: PromptCompletion) => void;
    const completion = new Promise<PromptCompletion>((resolvePromise) => {
      resolveCompletion = resolvePromise;
    });
    const active: ActivePrompt = {
      binding,
      client,
      completion,
      finish: (value) => {
        if (active.finished) return;
        active.finished = true;
        resolveCompletion(value);
      },
      delivery: Promise.resolve(),
      lastToolCallId: null,
      finished: false,
    };
    this.#active.set(params.sessionId, active);
    const abort = () => void this.cancel({ sessionId: params.sessionId });
    signal.addEventListener("abort", abort, { once: true });
    try {
      await this.#host.handle("agent.turn", {
        taskId: binding.taskId,
        sessionId: binding.sessionId,
        input: prepared.text || "Continue with the attached context.",
        permissionMode: "ask",
        ...(prepared.attachments.length > 0 ? { attachments: prepared.attachments } : {}),
        ...(binding.mcpServers.length > 0 ? { mcpServers: binding.mcpServers } : {}),
      } as unknown as JsonValue);
      const result = await completion;
      await active.delivery;
      return { stopReason: result.status === "completed" ? "end_turn" : result.status === "cancelled" ? "cancelled" : "refusal" };
    } catch (error) {
      await client.notify(acp.methods.client.session.update, {
        sessionId: binding.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Berry error: ${errorMessage(error)}` } },
      });
      return { stopReason: signal.aborted ? "cancelled" : "refusal" };
    } finally {
      signal.removeEventListener("abort", abort);
      this.#active.delete(params.sessionId);
    }
  }

  async cancel(params: acp.CancelNotification): Promise<void> {
    const active = this.#active.get(params.sessionId);
    if (!active) return;
    try {
      await this.#host.handle("agent.cancel", { sessionId: params.sessionId });
    } finally {
      active.finish({ status: "cancelled" });
    }
  }

  #onHostEvent(push: HostPushEvent): void {
    if (push.type === "agent.event") {
      const active = this.#active.get(push.sessionId);
      if (!active) return;
      active.delivery = active.delivery
        .then(() => this.#translateAgentEvent(active, push.event))
        .catch(async (error) => {
          await active.client.notify(acp.methods.client.session.update, {
            sessionId: active.binding.sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `ACP bridge error: ${errorMessage(error)}` } },
          });
          active.finish({ status: "failed" });
        });
      return;
    }
    if (push.type === "task.updated") {
      const binding = [...this.#bindings.values()].find((candidate) => candidate.taskId === push.task.id);
      if (!binding || !this.#connectionClient) return;
      void this.#connectionClient.notify(acp.methods.client.session.update, {
        sessionId: binding.sessionId,
        update: { sessionUpdate: "session_info_update", title: push.task.title, updatedAt: push.task.updatedAt },
      });
      return;
    }
    if (push.type === "session.lease.lost") this.#active.get(push.sessionId)?.finish({ status: "cancelled" });
    if (push.type === "host.shutting_down") {
      for (const active of this.#active.values()) active.finish({ status: "cancelled" });
    }
  }

  async #translateAgentEvent(active: ActivePrompt, event: AgentStreamEvent): Promise<void> {
    const sessionId = active.binding.sessionId;
    if (event.kind === "message.delta") {
      await active.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: event.channel === "reasoning" ? "agent_thought_chunk" : "agent_message_chunk",
          messageId: event.messageId,
          content: { type: "text", text: event.delta },
        },
      });
      return;
    }
    if (event.kind === "tool.start") {
      active.lastToolCallId = event.toolCallId;
      await active.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: event.toolCallId,
          title: event.title ?? event.name,
          kind: acpToolKind(event.name),
          status: "pending",
          rawInput: event.args ?? null,
          locations: toolLocations(event.args, active.binding.cwd),
        },
      });
      return;
    }
    if (event.kind === "tool.update") {
      await active.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: event.toolCallId,
          status: "in_progress",
          ...(event.detail ? { content: [{ type: "content", content: { type: "text", text: event.detail } }] } : {}),
        },
      });
      return;
    }
    if (event.kind === "tool.end") {
      await active.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: event.toolCallId,
          status: event.status === "completed" ? "completed" : "failed",
          ...(event.summary
            ? {
                content: [{ type: "content", content: { type: "text", text: event.summary } }],
                rawOutput: { summary: event.summary, status: event.status, durationMs: event.durationMs ?? null },
              }
            : {}),
        },
      });
      return;
    }
    if (event.kind === "approval.request") {
      await this.#requestApproval(active, event);
      return;
    }
    if (event.kind === "question.request") {
      await this.#requestAnswer(active, event);
      return;
    }
    if (event.kind === "error") {
      await active.client.notify(acp.methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Error: ${event.message}` } },
      });
      return;
    }
    if (event.kind === "turn.end") active.finish({ status: event.status });
  }

  async #requestApproval(active: ActivePrompt, event: Extract<AgentStreamEvent, { kind: "approval.request" }>): Promise<void> {
    const toolCallId = active.lastToolCallId ?? `approval:${event.approvalId}`;
    if (!active.lastToolCallId) {
      await active.client.notify(acp.methods.client.session.update, {
        sessionId: active.binding.sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId,
          title: event.title,
          kind: approvalToolKind(event.approvalKind),
          status: "pending",
          rawInput: { detail: event.detail ?? null, subject: event.subject ?? null },
        },
      });
    }
    let decision: "approved_once" | "approved_for_session" | "denied" | "abort" = "abort";
    try {
      const response = await active.client.request(acp.methods.client.session.requestPermission, {
        sessionId: active.binding.sessionId,
        toolCall: {
          toolCallId,
          title: event.title,
          kind: approvalToolKind(event.approvalKind),
          status: "pending",
          rawInput: { detail: event.detail ?? null, subject: event.subject ?? null },
        },
        options: [
          { optionId: "berry-allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "berry-allow-session", name: "Allow for this session", kind: "allow_always" },
          { optionId: "berry-deny", name: "Deny", kind: "reject_once" },
          { optionId: "berry-abort", name: "Deny and stop", kind: "reject_always" },
        ],
      });
      if (response.outcome.outcome === "selected") {
        decision = response.outcome.optionId === "berry-allow-once"
          ? "approved_once"
          : response.outcome.optionId === "berry-allow-session"
            ? "approved_for_session"
            : response.outcome.optionId === "berry-deny"
              ? "denied"
              : "abort";
      }
    } finally {
      await this.#host.handle("approval.decide", { id: event.approvalId, decision });
    }
  }

  async #requestAnswer(active: ActivePrompt, event: Extract<AgentStreamEvent, { kind: "question.request" }>): Promise<void> {
    let answer = "";
    let selectedOptions: string[] = [];
    let cancelled = false;
    try {
      if (this.#supportsElicitation) {
        const property: acp.ElicitationPropertySchema = event.multi
          ? {
              type: "array",
              title: "Answer",
              items: { anyOf: event.options.map((option) => ({ const: option.label, title: option.label, ...(option.description ? { description: option.description } : {}) })) },
            }
          : event.options.length > 0
            ? {
                type: "string",
                title: "Answer",
                oneOf: event.options.map((option) => ({ const: option.label, title: option.label, ...(option.description ? { description: option.description } : {}) })),
              }
            : { type: "string", title: "Answer", minLength: 1 };
        const response = await active.client.request(acp.methods.client.elicitation.create, {
          mode: "form",
          sessionId: active.binding.sessionId,
          toolCallId: event.toolCallId,
          message: event.question,
          requestedSchema: { type: "object", properties: { answer: property }, required: ["answer"] },
        });
        if (response.action === "accept") {
          const value = (response as { content?: Record<string, acp.ElicitationContentValue> }).content?.answer;
          answer = Array.isArray(value) ? value.join(", ") : typeof value === "string" ? value : String(value ?? "");
          selectedOptions = Array.isArray(value) ? value : event.options.some((option) => option.label === value) ? [String(value)] : [];
        } else {
          cancelled = response.action === "cancel";
        }
      } else {
        const options = event.options.length > 0
          ? event.options.map((option, index) => ({ optionId: `answer:${index}`, name: option.label, kind: "allow_once" as const }))
          : [
              { optionId: "answer:blank", name: "Continue without an answer", kind: "allow_once" as const },
              { optionId: "answer:cancel", name: "Cancel turn", kind: "reject_once" as const },
            ];
        const response = await active.client.request<acp.RequestPermissionResponse, acp.RequestPermissionRequest>(acp.methods.client.session.requestPermission, {
          sessionId: active.binding.sessionId,
          toolCall: { toolCallId: event.toolCallId, title: event.question, kind: "other", status: "pending" },
          options,
        });
        if (response.outcome.outcome === "cancelled" || response.outcome.optionId === "answer:cancel") {
          cancelled = true;
        } else if (response.outcome.optionId.startsWith("answer:")) {
          const index = Number(response.outcome.optionId.slice("answer:".length));
          const selected = event.options[index];
          if (selected) {
            answer = selected.label;
            selectedOptions = [selected.label];
          }
        }
      }
    } catch {
      cancelled = true;
    }
    await this.#host.handle("question.answer", { id: event.questionId, answer, selectedOptions });
    if (cancelled) await this.cancel({ sessionId: active.binding.sessionId });
  }

  async #resolveBinding(sessionId: string, expectedCwd?: string): Promise<SessionBinding> {
    const session = await this.#host.handle("session.get", { sessionId }) as unknown as Session;
    const workspaces = await this.#host.handle("workspace.list", {}) as unknown as Workspace[];
    for (const workspace of workspaces) {
      const tasks = await this.#host.handle("task.list", {
        workspaceId: workspace.id,
        includeArchived: true,
        includeDeleted: false,
      }) as unknown as Task[];
      const task = tasks.find((candidate) => candidate.id === session.taskId);
      if (!task) continue;
      if (expectedCwd && resolve(expectedCwd) !== resolve(workspace.path)) {
        throw new Error(`Session ${sessionId} belongs to ${workspace.path}, not ${expectedCwd}`);
      }
      const binding = {
        sessionId,
        taskId: task.id,
        workspaceId: workspace.id,
        cwd: workspace.path,
        mcpServers: [] as RuntimeMcpServer[],
        titleSet: task.title !== `ACP: ${basename(workspace.path) || workspace.path}`,
      };
      this.#bindings.set(sessionId, binding);
      return binding;
    }
    throw new Error(`No Berry task owns session ${sessionId}`);
  }
}

export function createBerryAcpAgent(host: BerryAcpHost): acp.AgentApp {
  const adapter = new BerryAcpAdapter(host);
  return acp
    .agent({ name: "berry" })
    .onConnect((connection) => adapter.setClient(connection.client))
    .onRequest(acp.methods.agent.initialize, ({ params }) => adapter.initialize(params))
    .onRequest(acp.methods.agent.authenticate, ({ params }) => adapter.authenticate(params))
    .onRequest(acp.methods.agent.session.new, ({ params }) => adapter.newSession(params))
    .onRequest(acp.methods.agent.session.load, ({ params, client }) => adapter.loadSession(params, client))
    .onRequest(acp.methods.agent.session.list, ({ params }) => adapter.listSessions(params))
    .onRequest(acp.methods.agent.session.prompt, ({ params, client, signal }) => adapter.prompt(params, client, signal))
    .onNotification(acp.methods.agent.session.cancel, ({ params }) => adapter.cancel(params));
}

export async function runBerryAcp(options: RunBerryAcpOptions = {}): Promise<void> {
  if (options.host) {
    await serveBerryAcp(options.host, options.input ?? process.stdin, options.output ?? process.stdout);
    return;
  }
  const discoverySocket = options.socketPath ?? defaultHostSocketPath();
  const discoveryToken = options.tokenPath ?? hostSocketTokenPath(discoverySocket);
  if (existsSync(discoverySocket) && existsSync(discoveryToken)) {
    await serveBerryAcp(new HostSocketClient({ socketPath: discoverySocket, tokenPath: discoveryToken }), options.input ?? process.stdin, options.output ?? process.stdout);
    return;
  }

  const runtimeDir = mkdtempSync(join(tmpdir(), "berry-acp-"));
  const socketPath = join(runtimeDir, "host.sock");
  const embeddedHost = new BerryHostService({ ...(options.dbPath ? { dbPath: options.dbPath } : {}) });
  await embeddedHost.initialize();
  const socketServer = await startHostSocketServer({ host: embeddedHost, socketPath });
  embeddedHost.setPublisher((event) => socketServer.publish(event));
  try {
    await serveBerryAcp(
      new HostSocketClient({ socketPath, tokenPath: socketServer.tokenPath }),
      options.input ?? process.stdin,
      options.output ?? process.stdout,
    );
  } finally {
    const hostShutdown = embeddedHost.shutdown();
    await socketServer.close();
    await hostShutdown;
    rmSync(runtimeDir, { recursive: true, force: true });
  }
}

async function serveBerryAcp(host: BerryAcpHost, input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Promise<void> {
  await host.initialize();
  try {
    const stream = acp.ndJsonStream(
      WritableStreamFromNode(output),
      ReadableStreamFromNode(input),
    );
    const connection = createBerryAcpAgent(host).connect(stream);
    await connection.closed;
  } finally {
    await host.shutdown();
  }
}

function WritableStreamFromNode(stream: NodeJS.WritableStream): WritableStream<Uint8Array> {
  return new WritableStream({
    write(chunk) {
      return new Promise<void>((resolvePromise, reject) => {
        stream.write(chunk, (error?: Error | null) => error ? reject(error) : resolvePromise());
      });
    },
  });
}

function ReadableStreamFromNode(stream: NodeJS.ReadableStream): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      stream.on("data", (chunk) => controller.enqueue(typeof chunk === "string" ? Buffer.from(chunk) : new Uint8Array(chunk)));
      stream.once("end", () => controller.close());
      stream.once("error", (error) => controller.error(error));
    },
    cancel() {
      (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
    },
  });
}

function preparePrompt(blocks: acp.ContentBlock[]): { text: string; attachments: AttachmentInput[] } {
  const text: string[] = [];
  const attachments: AttachmentInput[] = [];
  for (const [index, block] of blocks.entries()) {
    if (block.type === "text") {
      text.push(block.text);
    } else if (block.type === "image") {
      attachments.push({
        id: `acp-image-${index}`,
        name: resourceName(block.uri, `image-${index + 1}`),
        mediaType: block.mimeType,
        size: Buffer.byteLength(block.data, "base64"),
        dataUrl: `data:${block.mimeType};base64,${block.data}`,
        sourceKind: "acp-image",
      });
    } else if (block.type === "resource_link") {
      text.push(`[Context: ${block.name}](${block.uri})`);
    } else if (block.type === "resource") {
      if ("text" in block.resource) {
        attachments.push({
          id: `acp-resource-${index}`,
          name: resourceName(block.resource.uri, `context-${index + 1}.txt`),
          mediaType: block.resource.mimeType ?? "text/plain",
          size: Buffer.byteLength(block.resource.text),
          textContent: block.resource.text,
          sourceKind: "acp-resource",
        });
      } else if ((block.resource.mimeType ?? "").startsWith("image/")) {
        const mimeType = block.resource.mimeType ?? "application/octet-stream";
        attachments.push({
          id: `acp-resource-${index}`,
          name: resourceName(block.resource.uri, `resource-${index + 1}`),
          mediaType: mimeType,
          size: Buffer.byteLength(block.resource.blob, "base64"),
          dataUrl: `data:${mimeType};base64,${block.resource.blob}`,
          sourceKind: "acp-resource",
        });
      } else {
        text.push(`[Binary context: ${block.resource.uri}]`);
      }
    } else {
      text.push("[Audio context omitted: Berry ACP does not advertise audio input]");
    }
  }
  return { text: text.join("\n\n"), attachments };
}

function messageContents(message: Message): acp.ContentBlock[] {
  const contents: acp.ContentBlock[] = [];
  for (const part of message.parts) {
    if (part.kind === "image" && typeof part.content === "string") {
      const match = /^data:([^;,]+);base64,(.*)$/s.exec(part.content);
      if (match) {
        contents.push({ type: "image", mimeType: match[1] ?? "application/octet-stream", data: match[2] ?? "" });
        continue;
      }
    }
    const text = typeof part.content === "string" ? part.content : JSON.stringify(part.content);
    if (text) contents.push({ type: "text", text });
  }
  return contents;
}

function acpMcpServers(servers: acp.McpServer[]): RuntimeMcpServer[] {
  return servers.map((server, index) => {
    if ("command" in server) {
      return {
        id: `acp:${index}:${safeId(server.name)}`,
        name: server.name,
        transport: "stdio",
        command: server.command,
        args: server.args,
        url: null,
        env: Object.fromEntries(server.env.map((entry) => [entry.name, entry.value])),
      };
    }
    if (server.type === "sse") {
      if (server.headers.length > 0) throw new Error(`ACP MCP server ${server.name} uses headers, which Berry's SSE transport does not support yet`);
      return {
        id: `acp:${index}:${safeId(server.name)}`,
        name: server.name,
        transport: "http-sse",
        command: null,
        args: [],
        url: server.url,
        env: {},
      };
    }
    throw new Error(`ACP MCP server ${server.name} uses unsupported ${server.type} transport; configure it in Berry or use stdio/SSE`);
  });
}

function acpToolKind(name: string): acp.ToolKind {
  const normalized = name.toLowerCase();
  if (/delete|remove|unlink/.test(normalized)) return "delete";
  if (/move|rename/.test(normalized)) return "move";
  if (/write|edit|patch|replace|create/.test(normalized)) return "edit";
  if (/grep|search|find|glob|list/.test(normalized)) return "search";
  if (/read|view|inspect|get/.test(normalized)) return "read";
  if (/bash|shell|terminal|exec|command|test|build/.test(normalized)) return "execute";
  if (/browser|web|fetch|http/.test(normalized)) return "fetch";
  if (/think|plan|goal|question/.test(normalized)) return "think";
  return "other";
}

function approvalToolKind(kind: Extract<AgentStreamEvent, { kind: "approval.request" }>["approvalKind"]): acp.ToolKind {
  if (kind === "file-edit") return "edit";
  if (kind === "shell" || kind === "terminal") return "execute";
  if (kind === "browser" || kind === "mcp") return "fetch";
  return "other";
}

function toolLocations(args: JsonValue | undefined, cwd: string): acp.ToolCallLocation[] {
  if (!args || typeof args !== "object" || Array.isArray(args)) return [];
  const record = args as Record<string, JsonValue | undefined>;
  const candidates = [record.path, record.file, record.filePath, record.cwd];
  return candidates
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map((path) => ({ path: resolve(cwd, path) }));
}

function resourceName(uri: string | null | undefined, fallback: string): string {
  if (!uri) return fallback;
  try {
    return basename(new URL(uri).pathname) || fallback;
  } catch {
    return basename(uri) || fallback;
  }
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  const value = Number(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid ACP session cursor");
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
