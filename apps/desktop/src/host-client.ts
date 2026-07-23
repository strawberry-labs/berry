import {
  MODEL_PROVIDER_PRESETS,
  RemoteModelSchema,
  resolveModelCapabilities,
  type AgentStreamEvent,
  type HostMethod,
  type HostMethodParams,
  type HostMethodResult,
  type HostPushEvent,
  type JsonValue,
} from "@berry/shared";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";

export interface HostClient {
  call<TMethod extends HostMethod>(method: TMethod, params?: HostMethodParams<TMethod>): Promise<HostMethodResult<TMethod>>;
  call<T = JsonValue>(method: string, params?: JsonValue): Promise<T>;
  /** Subscribe to host push events (agent stream, terminal output, task updates). */
  subscribe(listener: (event: HostPushEvent) => void): () => void;
}

export class HostRpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: JsonValue | null = null,
  ) {
    super(`${code}: ${message}`);
    this.name = code;
  }
}

export function isApprovalRequiredError(error: unknown): error is HostRpcError & { details: { approvalId: string } } {
  return (
    error instanceof HostRpcError &&
    (error.code === "approval_required" || error.code === "protected_workspace_path") &&
    Boolean(error.details) &&
    typeof error.details === "object" &&
    !Array.isArray(error.details) &&
    typeof (error.details as { approvalId?: unknown }).approvalId === "string"
  );
}

export async function callWithApprovalRetry<T = JsonValue>(
  client: HostClient,
  method: string,
  params: Record<string, JsonValue | undefined>,
): Promise<T> {
  try {
    return await client.call<T>(method, params as JsonValue);
  } catch (error) {
    if (!isApprovalRequiredError(error)) throw error;
    return new Promise<T>((resolve, reject) => {
      toast("Approval required", {
        description: error.message,
        action: {
          label: "Allow once",
          onClick: () => {
            void client
              .call("approval.decide", { id: error.details.approvalId, decision: "approved_once" })
              .then(() =>
                client.call<T>(method, {
                  ...params,
                  approvalId: error.details.approvalId,
                  ...(error.code === "protected_workspace_path" ? { allowProtectedWrite: true } : {}),
                } as JsonValue),
              )
              .then(resolve, reject);
          },
        },
      });
    });
  }
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

/** True when running inside the Tauri desktop shell (vs. a plain dev browser). */
export function isTauri(): boolean {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}

/**
 * Opens the native OS folder picker. Resolves to the chosen absolute path, or
 * `null` when the user cancels. Throws when no native dialog is available (the
 * dev browser, or an older shell build missing the command) so callers can
 * fall back to manual path entry.
 */
export async function pickDirectory(): Promise<string | null> {
  if (!isTauri()) throw new Error("Native folder picker is unavailable");
  const path = await invoke<string | null>("pick_directory");
  return path ?? null;
}

export interface NativePickedFile {
  path: string;
  name: string;
  mediaType: string;
  size: number;
  dataUrl?: string | null;
}

export async function pickFiles(): Promise<NativePickedFile[]> {
  if (!isTauri()) throw new Error("Native file picker is unavailable");
  return await invoke<NativePickedFile[]>("pick_files");
}

/** Opens the native OS picker filtered to .skill packages. */
export async function pickSkillFile(): Promise<string | null> {
  if (!isTauri()) throw new Error("Native skill picker is unavailable");
  const path = await invoke<string | null>("pick_skill_file");
  return path ?? null;
}

export function localFilePreviewUrl(path: string): string | null {
  if (!isTauri() || path.trim().length === 0) return null;
  return convertFileSrc(path);
}

export function createHostClient(): HostClient {
  if (typeof window !== "undefined" && window.__TAURI_INTERNALS__) {
    return createTauriHostClient();
  }
  if (import.meta.env.DEV) return createDevelopmentHostClient();
  return {
    async call(): Promise<never> {
      throw new Error("Berry host is available only inside the desktop shell.");
    },
    subscribe() {
      return () => {};
    },
  };
}

function createTauriHostClient(): HostClient {
  const listeners = new Set<(event: HostPushEvent) => void>();
  let started = false;

  const ensureEventBridge = () => {
    if (started) return;
    started = true;
    listen<HostPushEvent>("berry://host-event", (message) => {
      for (const listener of listeners) listener(message.payload);
    }).catch((error: unknown) => {
      // Without this bridge the UI never sees streamed turns; allow the next
      // subscriber to retry instead of silently losing all push events.
      started = false;
      console.error("berry: failed to attach host event bridge", error);
    });
  };

  return {
    async call<T = JsonValue>(method: string, params?: JsonValue): Promise<T> {
      const input = asRecord(params);
      if (method === "credential.set") {
        await invoke("credential_set", {
          reference: stringOr(input.reference, "default"),
          secret: stringOr(input.secret, ""),
        });
        return { ok: true } as T;
      }
      if (method === "credential.status") {
        return invoke<T>("credential_status", {
          reference: stringOr(input.reference, "default"),
        });
      }
      if (method === "credential.delete") {
        await invoke("credential_delete", { reference: stringOr(input.reference, "default") });
        return { ok: true } as T;
      }
      try {
        return await invoke<T>("host_rpc", { method, params: params ?? null });
      } catch (error) {
        throw normalizeHostError(error);
      }
    },
    subscribe(listener) {
      ensureEventBridge();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function normalizeHostError(error: unknown): Error {
  const raw = typeof error === "string" ? error : error instanceof Error ? error.message : String(error);
  try {
    const parsed = JSON.parse(raw) as { code?: unknown; message?: unknown; details?: unknown };
    if (typeof parsed.code === "string" && typeof parsed.message === "string") {
      return new HostRpcError(parsed.code, parsed.message, (parsed.details ?? null) as JsonValue | null);
    }
  } catch {
    // Older shells and non-host errors still arrive as plain strings.
  }
  return new Error(raw);
}

function createDevelopmentHostClient(): HostClient {
  const storeKey = "berry.dev.host";
  const credentials = new Map<string, string>();
  const listeners = new Set<(event: HostPushEvent) => void>();
  const activeTurns = new Map<string, { turnId: string; bufferedEvents: AgentStreamEvent[]; owner: string | null; cancel?: () => void }>();
  const localModelPulls = new Map<string, { providerId: string; model: string; action: "pull" | "download"; timers: number[] }>();
  const replayLimit = 2000;
  const bufferTurnEvent = (sessionId: string, event: AgentStreamEvent) => {
    const active = activeTurns.get(sessionId);
    if (!active) return;
    active.bufferedEvents.push(event);
    if (active.bufferedEvents.length <= replayLimit + 1) return;
    const first = active.bufferedEvents[0]?.kind === "turn.start" ? active.bufferedEvents[0] : null;
    const tail = active.bufferedEvents.slice(-replayLimit);
    active.bufferedEvents = first ? [first, ...tail] : tail;
  };
  const emit = (event: HostPushEvent) => {
    for (const listener of listeners) listener(event);
  };
  const read = (): DevState => {
    const raw = localStorage.getItem(storeKey);
    const fallback: DevState = {
          workspaces: [],
          tasks: {},
          messages: {},
          sessionTargets: {},
          settings: { "permission.mode": "ask" },
          providers: [],
          terminals: [],
          terminalEvents: {},
          browsers: [],
          mcpServers: [],
          skills: [],
          commands: [],
          plugins: [],
          permissionGrants: [{ id: "dev_grant_global", workspaceId: null, mode: "ask", subject: "mcp:docs:search", decision: "allow", expiresAt: null, createdAt: new Date().toISOString() }],
          policyRules: [
            { id: "dev_policy_managed", workspaceId: null, layer: "managed", kind: "exact", decision: "forbid", pattern: ["sudo"], description: "Managed safety baseline", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
            { id: "dev_policy_user", workspaceId: null, layer: "user", kind: "exact", decision: "allow", pattern: ["pnpm", "test"], description: "Allow test suite", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
          ],
          auditEvents: [{ id: "dev_audit_1", sequence: 1, category: "policy", action: "rule-created", actor: "user", workspaceId: null, taskId: null, sessionId: null, subject: "dev_policy_user", metadata: {}, previousHash: "0".repeat(64), eventHash: "1".repeat(64), createdAt: new Date().toISOString() }],
          logs: [],
          usage: [],
          usageEvents: [],
          platformSession: null,
          gitChangedFiles: devChangedFiles(),
          reviewSessions: [],
          reviewComments: [],
          reviewFindings: [],
          gitCheckpoints: [],
        };
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<DevState>;
    const workspaces = (parsed.workspaces ?? []).map((item) => ({
      workspaceKind: "project",
      ownerUserId: null,
      ...asRecord(item),
    }));
    const tasks = Object.fromEntries(
      Object.entries(parsed.tasks ?? {}).map(([workspaceId, items]) => [
        workspaceId,
        (items ?? []).map((item) => ({
          conversationKind: asRecord(item).uiMode === "code" ? "code" : "chat",
          worktreePath: null,
          worktreeBranch: null,
          worktreeBaseRef: null,
          worktreeBaseSha: null,
          pullRequestUrl: null,
          pullRequestNumber: null,
          ...asRecord(item),
        })),
      ]),
    );
    return {
      ...fallback,
      ...parsed,
      workspaces,
      tasks,
      sessionTargets: parsed.sessionTargets ?? {},
      usageEvents: parsed.usageEvents ?? [],
      mcpServers: (parsed.mcpServers ?? []).map((server) => ({
        env: {},
        authType: "none",
        credentialRef: null,
        oauth: null,
        source: "manual",
        healthStatus: "disconnected",
        toolCount: 0,
        lastError: null,
        latencyMs: null,
        lastCheckedAt: null,
        cachedTools: [],
        ...asRecord(server),
      })),
      skills: (parsed.skills ?? []).map((skill) => ({
        originPath: null,
        version: "0.1.0",
        contentHash: "dev-hash",
        updateAvailable: false,
        pendingContentHash: null,
        shadowedBy: null,
        shadows: [],
        diagnostic: null,
        ...asRecord(skill),
      })),
      plugins: (parsed.plugins ?? []).map((plugin) => ({
        sourceKind: "manifest",
        sourceUrl: null,
        commitHash: null,
        contentHash: "",
        signatureStatus: "unsigned",
        signatureFingerprint: null,
        updateAvailable: false,
        pendingVersion: null,
        pendingContentHash: null,
        pendingCommitHash: null,
        capabilityDiff: [],
        ...asRecord(plugin),
      })),
      permissionGrants: parsed.permissionGrants ?? fallback.permissionGrants,
      policyRules: parsed.policyRules ?? fallback.policyRules,
      auditEvents: parsed.auditEvents ?? fallback.auditEvents,
      platformSession: parsed.platformSession ?? null,
      gitChangedFiles: Array.isArray(parsed.gitChangedFiles) ? parsed.gitChangedFiles : devChangedFiles(),
      reviewSessions: parsed.reviewSessions ?? [],
      reviewComments: parsed.reviewComments ?? [],
      reviewFindings: parsed.reviewFindings ?? [],
      gitCheckpoints: parsed.gitCheckpoints ?? [],
    };
  };
  const write = (state: DevState) => localStorage.setItem(storeKey, JSON.stringify(state));

  /** Find a task by id across all workspaces, apply a mutation, persist, and return the updated task. */
  const patchDevTask = (
    state: DevState,
    id: string,
    mutate: (task: Record<string, JsonValue | undefined>) => Record<string, JsonValue | undefined>,
  ): JsonValue | null => {
    for (const workspaceId of Object.keys(state.tasks)) {
      const list = state.tasks[workspaceId] ?? [];
      const index = list.findIndex((item) => recordId(item) === id);
      if (index === -1) continue;
      const current = asRecord(list[index]);
      const updated = { ...mutate(current), updatedAt: new Date().toISOString() };
      state.tasks[workspaceId] = list.map((item, i) => (i === index ? updated : item));
      write(state);
      return updated;
    }
    return null;
  };

  const updateTaskForDevMessage = (state: DevState, sessionId: string, role: string, text: string) => {
    const now = new Date().toISOString();
    for (const workspaceId of Object.keys(state.tasks)) {
      state.tasks[workspaceId] = (state.tasks[workspaceId] ?? []).map((item) => {
        const task = asRecord(item);
        if (task.activeSessionId !== sessionId) return item;
        return {
          ...task,
          searchableText: `${stringOr(task.searchableText, stringOr(task.title, ""))} ${text}`.trim(),
          unreadAt: role === "user" ? task.unreadAt ?? null : now,
        };
      });
    }
  };

  const streamDevTurn = (
    taskId: string,
    sessionId: string,
    input: string,
    owner: string | null,
    continuation = false,
  ) => {
    const turnId = `dev_turn_${crypto.randomUUID()}`;
    const messageId = `dev_msg_${crypto.randomUUID()}`;
    const readAToolCallId = `dev_tool_${crypto.randomUUID()}`;
    const readBToolCallId = `dev_tool_${crypto.randomUUID()}`;
    const scanToolCallId = `dev_tool_${crypto.randomUUID()}`;
    const shellToolCallId = `dev_tool_${crypto.randomUUID()}`;
    const testToolCallId = `dev_tool_${crypto.randomUUID()}`;
    const agentBrowserSessionId = `dev_browser_agent_${crypto.randomUUID()}`;
    const timers: number[] = [];
    const send = (event: AgentStreamEvent, delay: number) =>
      timers.push(
        window.setTimeout(() => {
          bufferTurnEvent(sessionId, event);
          emit({ type: "agent.event", taskId, sessionId, event });
        }, delay),
      );
    // Mirrors the real runtime's abort: stop the stream, persist the partial
    // assistant message with status "cancelled", then end the turn.
    const cancel = () => {
      const active = activeTurns.get(sessionId);
      if (!active) return;
      for (const timer of timers) window.clearTimeout(timer);
      const state = read();
      const now = new Date().toISOString();
      const events = active.bufferedEvents;
      const toolEnds = new Map(
        events.flatMap((event) => (event.kind === "tool.end" ? [[event.toolCallId, event] as const] : [])),
      );
      const reasoningSoFar = events
        .filter((event) => event.kind === "message.delta" && event.channel === "reasoning")
        .map((event) => (event as { delta: string }).delta)
        .join("");
      const textSoFar = events
        .filter((event) => event.kind === "message.delta" && event.channel !== "reasoning")
        .map((event) => (event as { delta: string }).delta)
        .join("");
      const parts = [
        ...events
          .filter((event) => event.kind === "tool.start")
          .map((event, index) => {
            const start = event as { toolCallId: string; name: string; title?: string };
            const end = toolEnds.get(start.toolCallId);
            return {
              id: `dev_part_${crypto.randomUUID()}`,
              messageId,
              kind: "tool-call",
              content: {
                toolCallId: start.toolCallId,
                name: start.name,
                ...(start.title ? { title: start.title } : {}),
                status: end?.status ?? "failed",
                ...(end?.summary ? { summary: end.summary } : {}),
                ...(end?.durationMs !== undefined ? { durationMs: end.durationMs } : {}),
              },
              position: index,
              createdAt: now,
            };
          }),
        ...(reasoningSoFar
          ? [{ id: `dev_part_${crypto.randomUUID()}`, messageId, kind: "reasoning", content: reasoningSoFar, position: 90, createdAt: now }]
          : []),
        ...(textSoFar
          ? [{ id: `dev_part_${crypto.randomUUID()}`, messageId, kind: "text", content: textSoFar, position: 91, createdAt: now }]
          : []),
      ];
      if (parts.length > 0) {
        state.messages[sessionId] = [
          ...(state.messages[sessionId] ?? []),
          { id: messageId, sessionId, role: "assistant", status: "cancelled", parts, createdAt: now, updatedAt: now },
        ];
        write(state);
      }
      const endEvent: AgentStreamEvent = { kind: "turn.end", turnId, status: "cancelled" };
      bufferTurnEvent(sessionId, endEvent);
      // Release the lease before publishing the terminal state so the
      // Continue affordance is usable as soon as it becomes visible.
      activeTurns.delete(sessionId);
      emit({ type: "agent.event", taskId, sessionId, event: endEvent });
      const task = patchDevTask(read(), taskId, (current) => ({ ...current, status: "cancelled" }));
      if (task) emit({ type: "task.updated", task: task as never });
    };
    activeTurns.set(sessionId, { turnId, bufferedEvents: [], owner, cancel });

    const reply = devAssistantReply(input);
    const reasoning = "I checked the workspace shape, then compared the current UI against the requested desktop shell and composer behavior.";
    send({ kind: "turn.start", turnId, ...(continuation ? { continuation: true } : {}) }, 60);
    if (/approval evidence/i.test(input)) {
      send({
        kind: "approval.request",
        approvalId: `dev_approval_${crypto.randomUUID()}`,
        approvalKind: "file-edit",
        title: "apply_patch",
        detail: "npm test",
        rawDetail: "FOO=1 /usr/bin/npm test",
        diff: "--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1,1 +1,1 @@\n-old value\n+new value",
        destructive: true,
        openWorld: true,
        subject: "file:apply_patch:src/example.ts",
      }, 120);
    }
    if (/agent browser live/i.test(input)) {
      timers.push(window.setTimeout(() => {
        const state = read();
        const task = Object.values(state.tasks).flat().map(asRecord).find((candidate) => candidate.id === taskId);
        const now = new Date().toISOString();
        const browser = {
          id: agentBrowserSessionId,
          workspaceId: stringOr(task?.workspaceId, ""),
          status: "running" as const,
          currentUrl: "https://example.test/agent-driven",
          createdAt: now,
          updatedAt: now,
        };
        state.browsers = [browser, ...state.browsers.filter((item) => recordId(item) !== browser.id)];
        write(state);
        emit({ type: "browser.session.updated", session: browser });
      }, 450));
    }
    // Two explore-eligible reads, spaced past the 800ms summary-roll pacing so
    // the Explore group's rolling header is exercisable in development.
    send({ kind: "tool.start", toolCallId: readAToolCallId, name: "read_file", args: { path: "/Users/dev/berry-chat/package.json" } }, 200);
    send({ kind: "tool.end", toolCallId: readAToolCallId, status: "completed", durationMs: 140, summary: "Read 42 lines" }, 380);
    send({ kind: "tool.start", toolCallId: readBToolCallId, name: "read_file", args: { path: "/Users/dev/berry-chat/README.md" } }, 1250);
    send({ kind: "tool.end", toolCallId: readBToolCallId, status: "completed", durationMs: 160, summary: "Read 18 lines" }, 1450);
    send({ kind: "tool.start", toolCallId: scanToolCallId, name: "workspace.scan", title: "Exploring workspace" }, 1600);
    send({ kind: "tool.end", toolCallId: scanToolCallId, status: "completed", durationMs: 640, summary: "Explored 12 files" }, 2150);
    send({ kind: "tool.start", toolCallId: shellToolCallId, name: "shell.exec", title: "Checking command policy" }, 2240);
    send({ kind: "tool.end", toolCallId: shellToolCallId, status: "denied", durationMs: 220, summary: "Command denied by policy" }, 2470);
    send({ kind: "tool.start", toolCallId: testToolCallId, name: "test.run", title: "Running focused check" }, 2550);
    send({ kind: "tool.end", toolCallId: testToolCallId, status: "failed", durationMs: 410, summary: "Mock test failed" }, 2950);
    send({ kind: "message.start", messageId, role: "assistant" }, 3020);
    const reasoningChunks = reasoning.match(/.{1,36}/gs) ?? [];
    reasoningChunks.forEach((chunk, index) => {
      send({ kind: "message.delta", messageId, delta: chunk, channel: "reasoning" }, 3060 + index * 30);
    });
    const chunks = reply.match(/.{1,24}/gs) ?? [];
    chunks.forEach((chunk, index) => {
      send({ kind: "message.delta", messageId, delta: chunk, channel: "text" }, 3260 + index * 28);
    });
    const doneAt = 3320 + chunks.length * 28;
    timers.push(window.setTimeout(() => {
      const state = read();
      const now = new Date().toISOString();
      const parts: JsonValue[] = [
        {
          id: `dev_part_${crypto.randomUUID()}`,
          messageId,
          kind: "tool-call",
          content: { toolCallId: readAToolCallId, name: "read_file", arguments: { path: "/Users/dev/berry-chat/package.json" }, status: "completed", summary: "Read 42 lines", durationMs: 140 },
          position: -2,
          createdAt: now,
        },
        {
          id: `dev_part_${crypto.randomUUID()}`,
          messageId,
          kind: "tool-call",
          content: { toolCallId: readBToolCallId, name: "read_file", arguments: { path: "/Users/dev/berry-chat/README.md" }, status: "completed", summary: "Read 18 lines", durationMs: 160 },
          position: -1,
          createdAt: now,
        },
        {
          id: `dev_part_${crypto.randomUUID()}`,
          messageId,
          kind: "tool-call",
          content: { toolCallId: scanToolCallId, name: "workspace.scan", title: "Exploring workspace", status: "completed", summary: "Explored 12 files", durationMs: 640 },
          position: 0,
          createdAt: now,
        },
        {
          id: `dev_part_${crypto.randomUUID()}`,
          messageId,
          kind: "tool-call",
          content: { toolCallId: shellToolCallId, name: "shell.exec", title: "Checking command policy", status: "denied", summary: "Command denied by policy", durationMs: 220 },
          position: 1,
          createdAt: now,
        },
        {
          id: `dev_part_${crypto.randomUUID()}`,
          messageId,
          kind: "tool-call",
          content: { toolCallId: testToolCallId, name: "test.run", title: "Running focused check", status: "failed", summary: "Mock test failed", durationMs: 410 },
          position: 2,
          createdAt: now,
        },
        { id: `dev_part_${crypto.randomUUID()}`, messageId, kind: "reasoning", content: reasoning, position: 3, createdAt: now },
        { id: `dev_part_${crypto.randomUUID()}`, messageId, kind: "text", content: reply, position: 4, createdAt: now },
      ];
      state.messages[sessionId] = [
        ...(state.messages[sessionId] ?? []),
        {
          id: messageId,
          sessionId,
          role: "assistant",
          status: "complete",
          parts,
          createdAt: now,
          updatedAt: now,
        },
      ];
      updateTaskForDevMessage(state, sessionId, "assistant", reply);
      write(state);
      emit({ type: "agent.event", taskId, sessionId, event: { kind: "message.end", messageId } });
      emit({
        type: "agent.event",
        taskId,
        sessionId,
        event: { kind: "usage", inputTokens: 420, outputTokens: reply.length / 4, model: "dev/simulator" },
      });
      const endEvent: AgentStreamEvent = { kind: "turn.end", turnId, status: "completed" };
      bufferTurnEvent(sessionId, endEvent);
      emit({ type: "agent.event", taskId, sessionId, event: endEvent });
      window.setTimeout(() => activeTurns.delete(sessionId), 500);
    }, doneAt));
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async call<T = JsonValue>(method: string, params?: JsonValue): Promise<T> {
      const state = read();
      const input = asRecord(params);
      if (method === "workspace.list") {
        return state.workspaces.filter((workspace) => input.includeGeneral === true || asRecord(workspace).workspaceKind !== "general") as T;
      }
      if (method === "workspace.get") {
        return (state.workspaces.find((workspace) => recordId(workspace) === stringOr(input.id, "")) ?? null) as T;
      }
      if (method === "workspace.update") {
        const id = stringOr(input.id, "");
        const now = new Date().toISOString();
        let updated: JsonValue | null = null;
        state.workspaces = state.workspaces.map((workspace) => {
          if (recordId(workspace) !== id) return workspace;
          const current = asRecord(workspace);
          updated = {
            ...current,
            ...(typeof input.name === "string" ? { name: input.name.trim() || current.name } : {}),
            ...(typeof input.pinned === "boolean" ? { pinned: input.pinned } : {}),
            updatedAt: now,
          } as JsonValue;
          return updated;
        });
        if (!updated) throw new Error("Workspace not found");
        write(state);
        return updated as T;
      }
      if (method === "workspace.ensureGeneral") {
        const existing = state.workspaces.find((workspace) => asRecord(workspace).workspaceKind === "general");
        if (existing) return existing as T;
        const now = new Date().toISOString();
        const workspace = {
          id: "dev_ws_general",
          path: "/tmp/berry-general",
          name: "Chats",
          workspaceKind: "general",
          ownerUserId: null,
          trustState: "trusted",
          lastOpenedAt: now,
          indexedAt: null,
          createdAt: now,
          updatedAt: now,
        };
        state.workspaces.push(workspace);
        state.tasks[workspace.id] ??= [];
        write(state);
        return workspace as T;
      }
      if (method === "workspace.open") {
        const path = stringOr(input.path, "/tmp/berry-workspace");
        const workspace = {
          id: `dev_ws_${hash(path)}`,
          path,
          name: stringOr(input.name, path.split(/[\\/]/).filter(Boolean).at(-1) ?? "Workspace"),
          workspaceKind: "project",
          ownerUserId: null,
          trustState: input.trusted === true ? "trusted" : "untrusted",
          lastOpenedAt: new Date().toISOString(),
          indexedAt: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        state.workspaces = [workspace, ...state.workspaces.filter((item) => recordId(item) !== workspace.id)];
        write(state);
        return workspace as T;
      }
      if (method === "workspace.remove") {
        const id = stringOr(input.id, "");
        const before = state.workspaces.length;
        state.workspaces = state.workspaces.filter((item) => recordId(item) !== id);
        delete state.tasks[id];
        write(state);
        return { removed: state.workspaces.length < before } as T;
      }
      if (method === "workspace.index.status") {
        const workspaceId = stringOr(input.workspaceId, "");
        const workspace = state.workspaces.find((item) => recordId(item) === workspaceId);
        return {
          id: `dev_index_${workspaceId}`,
          workspaceId,
          rootPath: stringOr(asRecord(workspace).path, "/tmp/berry-workspace"),
          status: "ready",
          watcherStatus: "watching",
          watcherPending: 0,
          watcherError: null,
          fileCount: 11,
          indexedAt: new Date().toISOString(),
          error: null,
          metadata: { development: true, watcher: { status: "watching", pending: 0, error: null } },
        } as T;
      }
      if (method === "workspace.index.rebuild") {
        const workspaceId = stringOr(input.workspaceId, "");
        return {
          id: `dev_index_${workspaceId}`,
          workspaceId,
          rootPath: "/tmp/berry-workspace",
          status: "ready",
          watcherStatus: "watching",
          watcherPending: 0,
          watcherError: null,
          fileCount: 11,
          indexedAt: new Date().toISOString(),
          error: null,
          metadata: { development: true, watcher: { status: "watching", pending: 0, error: null } },
          wiki: devWorkspaceWiki(workspaceId),
        } as T;
      }
      if (method === "workspace.wiki.get") return devWorkspaceWiki(stringOr(input.workspaceId, "")) as T;
      if (method === "workspace.index.search") {
        const q = stringOr(input.query, "").toLowerCase();
        const results = devFileEntries()
          .filter((entry) => entry.kind === "file" && entry.path.toLowerCase().includes(q))
          .slice(0, 12)
          .map((entry) => ({
            id: `dev_idx_${hash(entry.path)}`,
            workspaceId: stringOr(input.workspaceId, ""),
            path: entry.path,
            absolutePath: `/tmp/berry-workspace/${entry.path}`,
            kind: "source",
            language: entry.path.endsWith(".tsx") ? "TypeScript React" : entry.path.endsWith(".json") ? "JSON" : "Markdown",
            size: typeof entry.size === "number" ? entry.size : 0,
            updatedAt: new Date().toISOString(),
            snippet: `Development index match for ${entry.path}`,
            score: 0,
          }));
        return { results } as T;
      }
      if (method === "task.list") {
        const includeArchived = input.includeArchived === true;
        const includeDeleted = input.includeDeleted === true;
        return ((state.tasks[stringOr(input.workspaceId, "")] ?? []) as Record<string, JsonValue | undefined>[])
          .filter((task) => (includeArchived || task.archived !== true) && (includeDeleted || typeof task.deletedAt !== "string")) as T;
      }
      if (method === "task.listGeneral") {
        const generalIds = state.workspaces.filter((workspace) => asRecord(workspace).workspaceKind === "general").map(recordId);
        const includeArchived = input.includeArchived === true;
        const includeDeleted = input.includeDeleted === true;
        const limit = typeof input.limit === "number" ? Math.max(1, Math.min(500, input.limit)) : 50;
        const offset = typeof input.offset === "number" ? Math.max(0, input.offset) : 0;
        return generalIds.flatMap((id) => id ? state.tasks[id] ?? [] : [])
          .map(asRecord)
          .filter((task) => (includeArchived || task.archived !== true) && (includeDeleted || typeof task.deletedAt !== "string"))
          .sort((a, b) => stringOr(b.updatedAt, "").localeCompare(stringOr(a.updatedAt, "")))
          .slice(offset, offset + limit) as T;
      }
      if (method === "task.search") {
        const includeArchived = input.includeArchived === true;
        const includeDeleted = input.includeDeleted === true;
        const query = stringOr(input.query, "").trim().toLowerCase();
        const limit = typeof input.limit === "number" ? input.limit : 50;
        return ((state.tasks[stringOr(input.workspaceId, "")] ?? []) as Record<string, JsonValue | undefined>[])
          .filter((task) => (includeArchived || task.archived !== true) && (includeDeleted || typeof task.deletedAt !== "string"))
          .filter((task) => `${stringOr(task.title, "")} ${stringOr(task.searchableText, "")}`.toLowerCase().includes(query))
          .slice(0, limit) as T;
      }
      if (method === "task.create") {
        let workspaceId = stringOr(input.workspaceId, "");
        if (input.workspaceKind === "general" || !workspaceId) {
          let general = state.workspaces.find((workspace) => asRecord(workspace).workspaceKind === "general");
          if (!general) {
            const createdAt = new Date().toISOString();
            general = { id: "dev_ws_general", path: "/tmp/berry-general", name: "Chats", workspaceKind: "general", ownerUserId: null, trustState: "trusted", lastOpenedAt: createdAt, indexedAt: null, createdAt, updatedAt: createdAt };
            state.workspaces.push(general);
          }
          workspaceId = recordId(general) ?? "dev_ws_general";
        }
        const now = new Date().toISOString();
        const sessionId = `dev_session_${crypto.randomUUID()}`;
        const task = {
          id: `dev_task_${crypto.randomUUID()}`,
          workspaceId,
          title: stringOr(input.title, "New chat"),
          status: "running",
          activeSessionId: sessionId,
          conversationKind: input.conversationKind === "code" ? "code" : "chat",
          pinned: false,
          archived: false,
          deletedAt: null,
          unreadAt: null,
          lastReadAt: null,
          searchableText: stringOr(input.title, "New chat"),
          worktreePath: null,
          worktreeBranch: null,
          worktreeBaseRef: null,
          worktreeBaseSha: null,
          pullRequestUrl: null,
          pullRequestNumber: null,
          createdAt: now,
          updatedAt: now,
        };
        const session = {
          id: sessionId,
          taskId: task.id,
          parentSessionId: null,
          status: "active",
          modelProviderId: null,
          model: null,
          permissionMode: stringOr(input.permissionMode, "ask"),
          createdAt: now,
          updatedAt: now,
        };
        state.tasks[workspaceId] = [task, ...(state.tasks[workspaceId] ?? [])];
        state.messages[sessionId] = [];
        write(state);
        return { task, session } as T;
      }
      if (method === "task.update") {
        const id = stringOr(input.id, "");
        const title = typeof input.title === "string" ? input.title : "";
        const updated = patchDevTask(state, id, (task) => ({ ...task, title: title || (typeof task.title === "string" ? task.title : "Untitled") }));
        if (updated) emit({ type: "task.updated", task: updated as never });
        return (updated ?? null) as T;
      }
      if (method === "task.setConversationKind") {
        const id = stringOr(input.id, "");
        const conversationKind = input.conversationKind === "code" ? "code" : "chat";
        const updated = patchDevTask(state, id, (task) => ({
          ...task,
          conversationKind,
        }));
        if (updated) emit({ type: "task.updated", task: updated as never });
        return (updated ?? null) as T;
      }
      if (method === "task.setPinned") {
        const id = stringOr(input.id, "");
        const updated = patchDevTask(state, id, (task) => ({ ...task, pinned: input.pinned === true }));
        if (updated) emit({ type: "task.updated", task: updated as never });
        return (updated ?? null) as T;
      }
      if (method === "task.setArchived") {
        const id = stringOr(input.id, "");
        const updated = patchDevTask(state, id, (task) => ({ ...task, archived: input.archived === true }));
        if (updated) emit({ type: "task.updated", task: updated as never });
        return (updated ?? null) as T;
      }
      if (method === "task.markRead") {
        const id = stringOr(input.id, "");
        const now = new Date().toISOString();
        const updated = patchDevTask(state, id, (task) => ({
          ...task,
          unreadAt: input.unread === true ? now : null,
          lastReadAt: input.unread === true ? null : now,
        }));
        if (updated) emit({ type: "task.updated", task: updated as never });
        return (updated ?? null) as T;
      }
      if (method === "task.delete" || method === "task.restore") {
        const id = stringOr(input.id, "");
        const deleted = method === "task.restore" ? false : input.deleted !== false;
        const updated = patchDevTask(state, id, (task) => ({ ...task, deletedAt: deleted ? new Date().toISOString() : null }));
        if (updated) emit({ type: "task.updated", task: updated as never });
        return (updated ?? null) as T;
      }
      if (method === "system.openPath") {
        // Dev renderer cannot spawn OS processes; report success so the UI flow works.
        return { ok: true, exitCode: 0, stderr: "" } as T;
      }
      if (method === "session.messages") return (state.messages[stringOr(input.sessionId, "")] ?? []) as T;
      if (method === "session.appendMessage") {
        const sessionId = stringOr(input.sessionId, "");
        const now = new Date().toISOString();
        const message = {
          id: `dev_msg_${crypto.randomUUID()}`,
          sessionId,
          role: stringOr(input.role, "user"),
          status: "complete",
          parts: Array.isArray(input.parts)
            ? input.parts.map((part, index) => ({
                id: `dev_part_${crypto.randomUUID()}`,
                messageId: "",
                kind: asRecord(part).kind ?? "text",
                content: asRecord(part).content ?? "",
                position: index,
                createdAt: now,
              }))
            : [],
          createdAt: now,
          updatedAt: now,
        };
        state.messages[sessionId] = [...(state.messages[sessionId] ?? []), message];
        updateTaskForDevMessage(
          state,
          sessionId,
          stringOr(input.role, "user"),
          message.parts.map((part) => stringOr(asRecord(part).content, "")).join(" "),
        );
        write(state);
        return { id: message.id } as T;
      }
      if (method === "agent.turn") {
        const sessionId = stringOr(input.sessionId, "");
        const taskId = stringOr(input.taskId, "");
        const text = stringOr(input.input, "");
        const continueInterruptedTurn = input.continueInterruptedTurn === true;
        const owner = typeof input.owner === "string" && input.owner.length > 0 ? input.owner : "desktop";
        const active = activeTurns.get(sessionId);
        if (active?.owner && active.owner !== owner) {
          throw new HostRpcError("session_lease_conflict", `Session is active in another client (${active.owner}).`, { sessionId, owner: active.owner });
        }
        if (active) throw new HostRpcError("invalid_state", "Session already has an active turn");
        const now = new Date().toISOString();
        const attachments = Array.isArray(input.attachments) ? input.attachments.map(asRecord) : [];
        const replaceFromMessageId = typeof input.replaceFromMessageId === "string" ? input.replaceFromMessageId : undefined;
        const parts = devUserParts(text, attachments, now);
        if (replaceFromMessageId) {
          const current = state.messages[sessionId] ?? [];
          const cut = current.findIndex((message) => recordId(message) === replaceFromMessageId);
          if (cut !== -1) state.messages[sessionId] = current.slice(0, cut);
        }
        if (!continueInterruptedTurn) {
          state.messages[sessionId] = [
            ...(state.messages[sessionId] ?? []),
            {
              id: `dev_msg_${crypto.randomUUID()}`,
              sessionId,
              role: "user",
              status: "complete",
              parts,
              createdAt: now,
              updatedAt: now,
            },
          ];
          updateTaskForDevMessage(state, sessionId, "user", text);
        }
        write(state);
        streamDevTurn(taskId, sessionId, continueInterruptedTurn ? "Continue" : text, owner, continueInterruptedTurn);
        return { turnId: `dev_turn_pending` } as T;
      }
      if (method === "agent.turnState") {
        const active = activeTurns.get(stringOr(input.sessionId, ""));
        return {
          active: Boolean(active),
          turnId: active?.turnId ?? null,
          bufferedEvents: active?.bufferedEvents ?? [],
          owner: active?.owner ?? null,
        } as T;
      }
      if (method === "agent.takeover") {
        const sessionId = stringOr(input.sessionId, "");
        const owner = stringOr(input.owner, "desktop");
        const active = activeTurns.get(sessionId);
        if (!active) throw new HostRpcError("invalid_state", "Session is not running a turn");
        const previousOwner = active.owner;
        active.owner = owner;
        emit({ type: "session.lease.lost", sessionId, owner, previousOwner });
        return { ok: true, previousOwner } as T;
      }
      if (method === "agent.steer" || method === "agent.followUp") {
        const sessionId = stringOr(input.sessionId, "");
        const owner = stringOr(input.owner, "desktop");
        const active = activeTurns.get(sessionId);
        if (!active) throw new HostRpcError("invalid_state", "Session is not running a turn");
        if (active.owner && active.owner !== owner) {
          throw new HostRpcError("session_lease_conflict", `Session is active in another client (${active.owner}).`, { sessionId, owner: active.owner });
        }
        const taskId = stringOr(input.taskId, "");
        const now = new Date().toISOString();
        const attachments = Array.isArray(input.attachments) ? input.attachments.map(asRecord) : [];
        state.messages[sessionId] = [
          ...(state.messages[sessionId] ?? []),
          {
            id: `dev_msg_${crypto.randomUUID()}`,
            sessionId,
            role: "user",
            status: "complete",
            parts: devUserParts(stringOr(input.input, ""), attachments, now),
            createdAt: now,
            updatedAt: now,
          },
        ];
        write(state);
        if (method === "agent.followUp") {
          emit({
            type: "agent.event",
            taskId,
            sessionId,
            event: {
              kind: "session.note",
              note: "followed-up",
              detail: "Queued follow-up",
            },
          });
        }
        return { queued: true } as T;
      }
      if (method === "agent.cancel") {
        const sessionId = stringOr(input.sessionId, "");
        const owner = stringOr(input.owner, "desktop");
        const active = activeTurns.get(sessionId);
        if (active?.owner && active.owner !== owner) {
          throw new HostRpcError("session_lease_conflict", `Session is active in another client (${active.owner}).`, { sessionId, owner: active.owner });
        }
        active?.cancel?.();
        return { cancelled: Boolean(active) } as T;
      }
      if (method === "settings.get") return (state.settings[stringOr(input.key, "")] ?? null) as T;
      if (method === "settings.set") {
        state.settings[stringOr(input.key, "")] = input.value ?? null;
        write(state);
        return { ok: true } as T;
      }
      if (method === "settings.list") return state.settings as T;
      if (method === "extension.nativeMessaging.status") {
        const ids = Array.isArray(state.settings["extension.nativeMessaging.extensionIds"])
          ? state.settings["extension.nativeMessaging.extensionIds"].filter((value): value is string => typeof value === "string")
          : ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"];
        return {
          enabled: state.settings["extension.nativeMessaging.enabled"] === true,
          hostName: "com.berry.desktop_host",
          manifestPaths: ["/tmp/berry/com.berry.desktop_host.json"],
          configPath: "/tmp/berry/extension-native-host.json",
          nativeHostPath: "/tmp/berry/berry-extension-host.mjs",
          socketPath: "/tmp/berry/host.sock",
          tokenPath: "/tmp/berry/host.sock.token",
          allowedOrigins: ids.map((id) => `chrome-extension://${id}/`),
          requiresExtensionId: ids.length === 0 || ids[0] === "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        } as T;
      }
      if (method === "extension.nativeMessaging.setEnabled") {
        state.settings["extension.nativeMessaging.enabled"] = input.enabled === true;
        if (Array.isArray(input.extensionIds)) state.settings["extension.nativeMessaging.extensionIds"] = input.extensionIds.filter((value): value is string => typeof value === "string");
        write(state);
        const ids = Array.isArray(state.settings["extension.nativeMessaging.extensionIds"])
          ? state.settings["extension.nativeMessaging.extensionIds"].filter((value): value is string => typeof value === "string")
          : ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"];
        return {
          enabled: state.settings["extension.nativeMessaging.enabled"] === true,
          hostName: "com.berry.desktop_host",
          manifestPaths: ["/tmp/berry/com.berry.desktop_host.json"],
          configPath: "/tmp/berry/extension-native-host.json",
          nativeHostPath: "/tmp/berry/berry-extension-host.mjs",
          socketPath: "/tmp/berry/host.sock",
          tokenPath: "/tmp/berry/host.sock.token",
          allowedOrigins: ids.map((id) => `chrome-extension://${id}/`),
          requiresExtensionId: ids.length === 0 || ids[0] === "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        } as T;
      }
      if (method === "model.provider.list") return state.providers as T;
      if (method === "model.provider.models") {
        // Development simulator: return a small static model list so the
        // "Get models" combobox is exercisable without a live endpoint. Mirror
        // the host by caching fetched rows on saved providers.
        const models = [
          { id: "openai/gpt-4.1-mini", name: "openai/gpt-4.1-mini", ownedBy: "openai", raw: {} },
          { id: "openai/gpt-4.1", name: "openai/gpt-4.1", ownedBy: "openai", raw: {} },
          { id: "anthropic/claude-3.7-sonnet", name: "anthropic/claude-3.7-sonnet", ownedBy: "anthropic", raw: {} },
          { id: "google/gemini-2.5-flash", name: "google/gemini-2.5-flash", ownedBy: "google", raw: {} },
          { id: "deepseek/deepseek-chat", name: "deepseek/deepseek-chat", ownedBy: "deepseek", raw: {} },
        ];
        const providerId = typeof input.providerId === "string" ? input.providerId : null;
        if (providerId) {
          const now = new Date().toISOString();
          state.providers = state.providers.map((item) =>
            recordId(item) === providerId && item && typeof item === "object"
              ? { ...item, models, updatedAt: now }
              : item,
          );
          write(state);
        }
        return models as T;
      }
      if (method === "model.preset.list") return MODEL_PROVIDER_PRESETS as unknown as T;
      if (method === "model.local.discover") return [] as T;
      if (method === "model.local.pull" || method === "model.local.download") {
        const providerId = stringOr(input.providerId, "");
        const model = stringOr(input.model, "");
        const provider = state.providers.find((item) => recordId(item) === providerId);
        const action: "pull" | "download" = method === "model.local.pull" ? "pull" : "download";
        const expectedKind = action === "pull" ? "ollama" : "lm-studio";
        if (asRecord(provider).kind !== expectedKind) throw new HostRpcError("unsupported_provider", `${action} is not supported by this provider.`);
        const operationId = `dev_${action}_${crypto.randomUUID()}`;
        const operation = { providerId, model, action, timers: [] as number[] };
        localModelPulls.set(operationId, operation);
        const send = (delay: number, status: string, percent: number, done = false, after?: () => void) => {
          operation.timers.push(
            window.setTimeout(() => {
              if (!localModelPulls.has(operationId)) return;
              if (done) {
                const current = read();
                const now = new Date().toISOString();
                current.providers = current.providers.map((item) => {
                  if (recordId(item) !== providerId) return item;
                  const record = asRecord(item);
                  const models = Array.isArray(record.models) ? record.models : [];
                  return {
                    ...record,
                    models: [
                      ...models.filter((candidate) => recordId(candidate) !== model),
                      (action === "pull"
                        ? {
                            id: model,
                            name: model,
                            contextWindow: 131_072,
                            capabilities: { tools: true, vision: false, reasoning: true, json: true },
                            family: "qwen3",
                            families: ["qwen3"],
                            parameterSize: "8.2B",
                            quantization: "Q4_K_M",
                            format: "gguf",
                            sizeBytes: 5_200_000_000,
                            loaded: false,
                            raw: { engine: "ollama" },
                          }
                        : {
                            id: model,
                            name: model.split("/").at(-1) ?? model,
                            ownedBy: model.includes("/") ? model.split("/")[0] : "lmstudio-community",
                            contextWindow: 65_536,
                            capabilities: { tools: true, vision: false, reasoning: false, json: true },
                            family: "llama",
                            families: ["llama"],
                            parameterSize: "8B",
                            quantization: "Q4_K_M",
                            format: "gguf",
                            sizeBytes: 5_100_000_000,
                            loaded: false,
                            loadedInstanceIds: [],
                            raw: { engine: "lm-studio", loadedInstances: [] },
                          }) as JsonValue,
                    ],
                    updatedAt: now,
                  };
                });
                write(current);
              }
              emit({
                type: "model.local.progress",
                operationId,
                providerId,
                model,
                action,
                status,
                percent,
                done,
              });
              if (done) localModelPulls.delete(operationId);
              else after?.();
            }, delay),
          );
        };
        send(20, action === "pull" ? "pulling manifest" : "downloading", 5, false, () =>
          send(600, "downloading", 42, false, () =>
            send(600, "verifying", 88, false, () => send(400, action === "pull" ? "success" : "completed", 100, true)),
          ),
        );
        return { operationId, started: true } as T;
      }
      if (method === "model.local.load" || method === "model.local.unload") {
        const providerId = stringOr(input.providerId, "");
        const provider = state.providers.find((item) => recordId(item) === providerId);
        if (asRecord(provider).kind !== "lm-studio") throw new HostRpcError("unsupported_provider", "LM Studio lifecycle action requires an LM Studio provider.");
        const load = method === "model.local.load";
        const model = load ? stringOr(input.model, "") : stringOr(input.instanceId, "");
        const instanceId = load ? `dev_lms_${model.replace(/[^a-z0-9]+/gi, "_")}` : model;
        const now = new Date().toISOString();
        state.providers = state.providers.map((item) => {
          if (recordId(item) !== providerId) return item;
          const record = asRecord(item);
          const models = Array.isArray(record.models) ? record.models : [];
          return {
            ...record,
            models: models.map((candidate) => {
              const entry = asRecord(candidate);
              const ids = Array.isArray(entry.loadedInstanceIds) ? entry.loadedInstanceIds.filter((value): value is string => typeof value === "string") : [];
              if ((load && recordId(candidate) === model) || (!load && ids.includes(instanceId))) {
                return { ...entry, loaded: load, loadedInstanceIds: load ? [instanceId] : [] };
              }
              return candidate;
            }),
            updatedAt: now,
          };
        });
        write(state);
        emit({
          type: "model.local.progress",
          operationId: `dev_${load ? "load" : "unload"}_${crypto.randomUUID()}`,
          providerId,
          model: load ? model : instanceId,
          action: load ? "load" : "unload",
          status: load ? "loaded" : "unloaded",
          percent: 100,
          done: true,
        });
        return load ? { loaded: true, instanceId } as T : { unloaded: true, instanceId } as T;
      }
      if (method === "model.local.cancel") {
        const operationId = stringOr(input.operationId, "");
        const operation = localModelPulls.get(operationId);
        if (!operation) return { cancelled: false } as T;
        for (const timer of operation.timers) window.clearTimeout(timer);
        localModelPulls.delete(operationId);
        emit({
          type: "model.local.progress",
          operationId,
          providerId: operation.providerId,
          model: operation.model,
          action: operation.action,
          status: "cancelled",
          done: true,
          cancelled: true,
        });
        return { cancelled: true } as T;
      }
      if (method === "model.provider.check") {
        const providerId = stringOr(input.providerId, "");
        const checkedAt = new Date().toISOString();
        if (providerId.includes("auth_error")) {
          return { ok: false, status: "invalid-key", category: "auth", message: "The API key was rejected.", checkedAt, latencyMs: 12, httpStatus: 401 } as T;
        }
        if (providerId.includes("network_error")) {
          return { ok: false, status: "unreachable", category: "network", message: "The provider could not be reached.", checkedAt, latencyMs: 12 } as T;
        }
        if (providerId.includes("model_missing")) {
          return { ok: false, status: "model-missing", category: "model", message: "The configured default model is unavailable.", checkedAt, latencyMs: 12, modelCount: 5 } as T;
        }
        return { ok: true, status: "ok", category: "healthy", modelCount: 5, checkedAt, latencyMs: 12 } as T;
      }
      if (method === "model.provider.delete") {
        const id = stringOr(input.id, "");
        const before = state.providers.length;
        state.providers = state.providers.filter((item) => recordId(item) !== id);
        write(state);
        return { removed: state.providers.length < before } as T;
      }
      if (method === "model.provider.save") {
        const now = new Date().toISOString();
        const apiType = stringOr(input.apiType, "openai-chat-completions");
        const provider = {
          id: stringOr(input.id, `dev_provider_${crypto.randomUUID()}`),
          kind: stringOr(input.kind, "custom"),
          name: stringOr(input.name, "Provider"),
          apiType,
          baseUrl: stringOr(input.baseUrl, "https://openrouter.ai/api/v1/"),
          endpointPath: stringOr(
            input.endpointPath,
            apiType === "openai-responses" ? "/responses" : apiType === "anthropic-messages" ? "/messages" : "/chat/completions",
          ),
          modelsPath: input.modelsPath === null ? null : stringOr(input.modelsPath, "/models"),
          defaultModel: stringOr(input.defaultModel, "openai/gpt-4.1-mini"),
          credentialRef: typeof input.credentialRef === "string" && input.credentialRef.length > 0 ? input.credentialRef : null,
          authType: stringOr(input.authType, "bearer"),
          enabled: input.enabled !== false,
          models: Array.isArray(input.models) ? input.models : [],
          capabilities: input.capabilities ?? {},
          headers: input.headers ?? {},
          source: stringOr(input.source, "custom"),
          createdAt: now,
          updatedAt: now,
        };
        state.providers = [provider, ...state.providers.filter((item) => recordId(item) !== provider.id)];
        write(state);
        return provider as T;
      }
      if (method === "router.contract.status") {
        return { oauthAvailable: true, redirectUri: "berry://router/oauth/callback", accountPath: "/account" } as T;
      }
      if (method === "router.oauth.start") {
        const stateValue = `dev_${crypto.randomUUID()}`;
        return {
          authorizationUrl: `https://router.example.test/oauth/authorize?response_type=code&client_id=berry-desktop-fixture&redirect_uri=${encodeURIComponent("berry://router/oauth/callback")}&state=${encodeURIComponent(stateValue)}`,
          state: stateValue,
        } as T;
      }
      if (method === "router.oauth.exchange") {
        return { accessToken: "brry_dev_oauth_token", tokenType: "Bearer", expiresAt: null } as T;
      }
      if (method === "router.account.get") {
        const reference = stringOr(input.credentialRef, "berry-router");
        if (!credentials.has(reference) && typeof input.apiKey !== "string") {
          throw new HostRpcError("missing_credential", "No Berry Router credential is stored.");
        }
        return {
          id: "acct_dev_fixture",
          email: "developer@berry.test",
          displayName: "Berry Developer",
          plan: "Pro",
          quota: { limit: 100, used: 37, remaining: 63, unit: "USD", resetsAt: "2026-08-01T00:00:00.000Z" },
          aliases: ["berry/cheap", "berry/fast", "berry/flagship"],
        } as T;
      }
      if (method === "router.image.generate") {
        await new Promise((resolve) => window.setTimeout(resolve, 800));
        return {
          model: "gpt-image-2",
          created: Math.floor(Date.now() / 1000),
          data: [{
            // 1×1 transparent PNG; the development host only exercises the
            // request/result state machine, not image quality.
            b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          }],
        } as T;
      }
      if (method === "session.get") {
        const sessionId = stringOr(input.sessionId, "");
        const task = Object.values(state.tasks)
          .flat()
          .find((item) => asRecord(item).activeSessionId === sessionId);
        return {
          id: sessionId,
          taskId: stringOr(asRecord(task).id, ""),
          parentSessionId: null,
          status: "active",
          modelProviderId: null,
          model: null,
          permissionMode: "ask",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as T;
      }
      if (method === "credential.set") {
        credentials.set(stringOr(input.reference, "default"), stringOr(input.secret, ""));
        return { ok: true } as T;
      }
      if (method === "credential.delete") {
        credentials.delete(stringOr(input.reference, "default"));
        return { ok: true } as T;
      }
      if (method === "credential.status") {
        const secret = credentials.get(stringOr(input.reference, "default")) ?? null;
        const suffix = secret?.trim().slice(-4) ?? "";
        return {
          exists: secret !== null,
          hint: suffix ? `••••${suffix}` : null,
          storage: "development",
          plaintext: false,
        } as T;
      }
      if (method === "file.tree") {
        return devFileEntries() as T;
      }
      if (method === "file.read") {
        const path = stringOr(input.path, "README.md");
        const previews: Record<string, string> = {
          "src/app.tsx": "export function DesktopApp() {\n  return <BerryWorkbench />;\n}\n",
          "src/components/composer.tsx": "export function Composer() {\n  return <form className=\"berry-composer-shell\" />;\n}\n",
          "src/components/thread.tsx": "export function Thread() {\n  return <AssistantActivityStack />;\n}\n",
          "src/components/work-pane.tsx": "export function WorkPane() {\n  return <Tabs defaultValue=\"terminal\" />;\n}\n",
          "package.json": "{\n  \"name\": \"@berry/desktop\",\n  \"scripts\": { \"dev\": \"vite\" }\n}\n",
          "README.md": "# Berry\n\nDesktop coding agent workspace.\n",
        };
        return { path, content: previews[path] ?? "// development preview\n", truncated: false } as T;
      }
      if (method === "search.ripgrep") return { stdout: "", stderr: "", exitCode: 0 } as T;
      if (method === "git.status") {
        return { stdout: "## main...origin/main\n M apps/desktop/src/components/composer.tsx\n M apps/desktop/src/components/thread.tsx\n?? apps/desktop/src/components/work-pane.tsx\n", stderr: "", exitCode: 0 } as T;
      }
      if (method === "git.branch") {
        const task = typeof input.taskId === "string" ? Object.values(state.tasks).flat().find((item) => recordId(item) === input.taskId) : undefined;
        return { stdout: `${stringOr(asRecord(task).worktreeBranch, "main")}\n`, stderr: "", exitCode: 0 } as T;
      }
      if (method === "git.diff") return { stdout: stringOr(input.path, "").endsWith("work-pane.tsx") ? devLargeDiff() : devDiff(), stderr: "", exitCode: 0 } as T;
      if (method === "git.checkpoint") {
        const now = new Date().toISOString();
        const checkpoint = {
          kind: "checkpoint",
          id: `dev_checkpoint_${crypto.randomUUID()}`,
          taskId: typeof input.taskId === "string" ? input.taskId : null,
          sessionId: typeof input.sessionId === "string" ? input.sessionId : null,
          entryId: typeof input.entryId === "string" ? input.entryId : null,
          commitSha: crypto.randomUUID().replaceAll("-", "").padEnd(40, "0"),
          message: stringOr(input.message, "Berry checkpoint"),
          reason: input.reason === "auto-rewind" || input.reason === "auto-restore" || input.reason === "auto-merge" ? input.reason : "manual",
          createdAt: now,
        };
        state.gitCheckpoints = [checkpoint, ...state.gitCheckpoints];
        state.gitChangedFiles = [];
        write(state);
        return { stdout: `[main ${checkpoint.commitSha.slice(0, 7)}] ${checkpoint.message}\n`, stderr: "", exitCode: 0 } as T;
      }
      if (method === "git.info") {
        return {
          isRepo: true,
          branch: "main",
          defaultBranch: "main",
          diffBase: "devbase",
          ahead: 1,
          behind: 0,
          dirty: true,
          changedFiles: 3,
          stagedFiles: 1,
        } as T;
      }
      if (method === "git.pr.status") {
        const configured = asRecord(state.settings["git.pr.status"]);
        if (Object.keys(configured).length > 0) return configured as T;
        return { installed: true, authenticated: true, version: "2.76.1", hostname: "github.com", account: "berry-dev", error: null, setupCommands: [] } as T;
      }
      if (method === "git.pr.draft") {
        const task = Object.values(state.tasks).flat().find((item) => recordId(item) === input.taskId);
        const title = stringOr(asRecord(task).title, "Berry task");
        return { title, body: `## Summary\n\n- ${title}\n\n## Testing\n\n- pnpm check`, base: stringOr(input.base, "main"), head: stringOr(asRecord(task).worktreeBranch, "feature/context-ring") } as T;
      }
      if (method === "git.pr.create") {
        const taskId = stringOr(input.taskId, "");
        const number = 42;
        const url = `https://github.com/berry-chat/berry/pull/${number}`;
        const updated = patchDevTask(state, taskId, (task) => ({ ...task, pullRequestUrl: url, pullRequestNumber: number }));
        if (updated) emit({ type: "task.updated", task: updated as never });
        write(state);
        return { number, url, title: stringOr(input.title, "Berry task"), body: stringOr(input.body, ""), base: stringOr(input.base, "main"), head: stringOr(asRecord(updated).worktreeBranch, "feature/context-ring"), draft: input.draft === true, state: "OPEN", taskId } as T;
      }
      if (method === "git.pr.list") {
        return Object.values(state.tasks).flat().filter((item) => typeof asRecord(item).pullRequestNumber === "number").map((item) => ({ number: asRecord(item).pullRequestNumber, url: asRecord(item).pullRequestUrl, title: asRecord(item).title, body: "Development pull request", base: "main", head: stringOr(asRecord(item).worktreeBranch, "berry/task"), draft: false, state: "OPEN", taskId: recordId(item) })) as T;
      }
      if (method === "git.pr.view") {
        const number = typeof input.number === "number" ? input.number : 42;
        const task = Object.values(state.tasks).flat().find((item) => asRecord(item).pullRequestNumber === number);
        const headSha = "1".repeat(40);
        const stored = state.settings[`git.pr.comments.${number}`];
        const comments = Array.isArray(stored) ? stored : [{ id: `github-pr-${number}-comment-9001`, reviewSessionId: `github-pr-${number}`, anchor: { path: "apps/desktop/src/components/composer.tsx", oldPath: null, side: "new", line: 1, commitSha: headSha, contextHash: "dev-pr-line-1" }, body: "Keep the focus boundary when replacing this shell.", resolved: false, source: "github", author: "octo-reviewer", url: `https://github.com/berry-chat/berry/pull/${number}#discussion_r9001`, externalId: 9001, inReplyToId: null, outdated: false, createdAt: "2026-07-10T09:00:00.000Z", updatedAt: "2026-07-10T09:00:00.000Z" }, { id: `github-pr-${number}-comment-8999`, reviewSessionId: `github-pr-${number}`, anchor: { path: "apps/desktop/src/components/composer.tsx", oldPath: null, side: "new", line: 1, commitSha: "0".repeat(40), contextHash: "dev-pr-outdated" }, body: "This note belongs to the previous head.", resolved: false, source: "github", author: "old-reviewer", url: null, externalId: 8999, inReplyToId: null, outdated: true, createdAt: "2026-07-09T09:00:00.000Z", updatedAt: "2026-07-09T09:00:00.000Z" }];
        if (!Array.isArray(stored)) { state.settings[`git.pr.comments.${number}`] = comments; write(state); }
        return { number, url: stringOr(asRecord(task).pullRequestUrl, `https://github.com/berry-chat/berry/pull/${number}`), title: stringOr(asRecord(task).title, "Berry task"), body: "Development pull request", base: "main", head: stringOr(asRecord(task).worktreeBranch, "berry/task"), draft: false, state: "OPEN", taskId: task ? recordId(task) : null, headSha, mergeable: "MERGEABLE", diff: devDiff(), comments } as T;
      }
      if (method === "git.pr.comment.create" || method === "git.pr.comment.reply") {
        const number = typeof input.number === "number" ? input.number : 42;
        const key = `git.pr.comments.${number}`;
        const current = Array.isArray(state.settings[key]) ? state.settings[key] as JsonValue[] : [];
        const now = new Date().toISOString();
        const externalId = 9002 + current.length;
        const parent = method === "git.pr.comment.reply" ? current.map((item) => asRecord(item)).find((comment) => comment.externalId === input.commentId) : undefined;
        const rawAnchor = method === "git.pr.comment.create" ? asRecord(input.anchor) : asRecord(parent?.anchor);
        const anchor: JsonValue = { path: stringOr(rawAnchor.path, "apps/desktop/src/components/composer.tsx"), oldPath: typeof rawAnchor.oldPath === "string" ? rawAnchor.oldPath : null, side: rawAnchor.side === "old" ? "old" : "new", line: typeof rawAnchor.line === "number" ? rawAnchor.line : 1, commitSha: stringOr(rawAnchor.commitSha, "1".repeat(40)), contextHash: stringOr(rawAnchor.contextHash, "dev-pr-line") };
        const inReplyToId = method === "git.pr.comment.reply" && typeof input.commentId === "number" ? input.commentId : null;
        const comment = { id: `github-pr-${number}-comment-${externalId}`, reviewSessionId: `github-pr-${number}`, anchor, body: stringOr(input.body, ""), resolved: false, source: "github", author: "berry-dev", url: `https://github.com/berry-chat/berry/pull/${number}#discussion_r${externalId}`, externalId, inReplyToId, outdated: false, createdAt: now, updatedAt: now };
        state.settings[key] = [...current, comment];
        write(state);
        return comment as T;
      }
      if (method === "git.branches") {
        return { current: "main", branches: [{ name: "main", current: true }, { name: "feature/context-ring", current: false }] } as T;
      }
      if (method === "git.diffBase") return { baseBranch: "main", mergeBase: "devbase" } as T;
      if (method === "git.changedFiles") return state.gitChangedFiles as T;
      if (method === "review.session.create") {
        const now = new Date().toISOString();
        const session = { id: `dev_review_${crypto.randomUUID()}`, workspaceId: stringOr(input.workspaceId, "dev_ws_1"), taskId: typeof input.taskId === "string" ? input.taskId : null, scope: input.scope ?? { kind: "working-tree", baseBranch: "main" }, commitSha: "1".repeat(40), status: "active", createdAt: now, updatedAt: now };
        state.reviewSessions = [session, ...state.reviewSessions];
        write(state);
        return session as T;
      }
      if (method === "review.session.list") {
        const task = typeof input.taskId === "string" ? Object.values(state.tasks).flat().find((item) => recordId(item) === input.taskId) : undefined;
        return state.reviewSessions.filter((session) => {
          const record = asRecord(session);
          if (record.workspaceId !== input.workspaceId || typeof input.taskId !== "string") return record.workspaceId === input.workspaceId;
          return record.taskId === input.taskId || (typeof asRecord(task).worktreePath !== "string" && (record.taskId === null || record.taskId === undefined));
        }) as T;
      }
      if (method === "review.session.get") return state.reviewSessions.find((session) => recordId(session) === input.id) as T;
      if (method === "review.session.complete") {
        const now = new Date().toISOString();
        let updated: JsonValue | undefined;
        state.reviewSessions = state.reviewSessions.map((session) => recordId(session) === input.id ? (updated = { ...asRecord(session), status: "completed", updatedAt: now }) : session);
        write(state);
        return updated as T;
      }
      if (method === "review.comment.create") {
        const now = new Date().toISOString();
        const comment = { id: `dev_review_comment_${crypto.randomUUID()}`, reviewSessionId: stringOr(input.reviewSessionId, ""), anchor: input.anchor ?? {}, body: stringOr(input.body, ""), resolved: false, createdAt: now, updatedAt: now };
        state.reviewComments.push(comment);
        write(state);
        return comment as T;
      }
      if (method === "review.comment.list") return state.reviewComments.filter((comment) => asRecord(comment).reviewSessionId === input.reviewSessionId) as T;
      if (method === "review.comment.resolve") {
        const now = new Date().toISOString();
        let updated: JsonValue | undefined;
        state.reviewComments = state.reviewComments.map((comment) => recordId(comment) === input.id ? (updated = { ...asRecord(comment), resolved: input.resolved === true, updatedAt: now }) : comment);
        write(state);
        return updated as T;
      }
      if (method === "review.start") {
        const session = state.reviewSessions.find((candidate) => recordId(candidate) === input.reviewSessionId);
        const now = new Date().toISOString();
        const finding = {
          id: `dev_review_finding_${crypto.randomUUID()}`,
          reviewSessionId: stringOr(input.reviewSessionId, ""),
          severity: "high",
          anchor: { path: "apps/desktop/src/components/composer.tsx", oldPath: null, side: "new", line: 1, commitSha: stringOr(asRecord(session).commitSha, "1".repeat(40)), contextHash: "58c7f53f" },
          title: "Composer shell loses its focus boundary",
          rationale: "The replacement class must retain the focus ring behavior used by keyboard navigation.",
          suggestionPatch: "*** Begin Patch\n*** Update File: apps/desktop/src/components/composer.tsx\n@@\n-<div className=\"berry-composer-shell\">\n+<div className=\"berry-composer-shell focus-within:ring-2\">\n*** End Patch",
          verificationReason: "Verified against the composer focus styles and keyboard test fixture.",
          convertedCommentId: null,
          applied: false,
          createdAt: now,
          updatedAt: now,
        };
        state.reviewFindings = [finding];
        write(state);
        return { session, findings: state.reviewFindings } as T;
      }
      if (method === "review.finding.list") return state.reviewFindings.filter((finding) => asRecord(finding).reviewSessionId === input.reviewSessionId) as T;
      if (method === "review.finding.convert") {
        const finding = state.reviewFindings.find((candidate) => recordId(candidate) === input.id);
        const record = asRecord(finding);
        const now = new Date().toISOString();
        const comment = { id: `dev_review_comment_${crypto.randomUUID()}`, reviewSessionId: stringOr(record.reviewSessionId, ""), anchor: record.anchor ?? {}, body: `${stringOr(record.title, "Finding")}\n\n${stringOr(record.rationale, "")}`, resolved: false, createdAt: now, updatedAt: now };
        state.reviewComments.push(comment);
        state.reviewFindings = state.reviewFindings.map((candidate) => recordId(candidate) === input.id ? { ...asRecord(candidate), convertedCommentId: comment.id, updatedAt: now } : candidate);
        write(state);
        return comment as T;
      }
      if (method === "review.finding.apply") {
        state.reviewFindings = state.reviewFindings.map((finding) => recordId(finding) === input.id ? { ...asRecord(finding), applied: true, updatedAt: new Date().toISOString() } : finding);
        write(state);
        return { applied: true, files: ["apps/desktop/src/components/composer.tsx"] } as T;
      }
      if (method === "timeline.list") {
        const taskId = stringOr(input.taskId, "");
        const task = Object.values(state.tasks).flat().find((item) => recordId(item) === taskId);
        const sessionId = stringOr(asRecord(task).activeSessionId, "");
        const conversation = (state.messages[sessionId] ?? [])
          .filter((message) => asRecord(message).role === "user" || asRecord(message).role === "assistant")
          .map((message) => {
            const record = asRecord(message);
            const parts = Array.isArray(record.parts) ? record.parts.map(asRecord) : [];
            const summary = parts.map((part) => stringOr(part.content, "")).filter(Boolean).join(" ").slice(0, 240) || "Conversation entry";
            return {
              kind: "conversation",
              id: stringOr(record.id, ""),
              sessionId,
              entryId: stringOr(record.id, ""),
              role: record.role === "assistant" ? "assistant" : "user",
              summary,
              createdAt: stringOr(record.createdAt, new Date().toISOString()),
            };
          });
        return [...state.gitCheckpoints.filter((checkpoint) => asRecord(checkpoint).taskId === taskId), ...conversation]
          .sort((left, right) => stringOr(asRecord(right).createdAt, "").localeCompare(stringOr(asRecord(left).createdAt, ""))) as T;
      }
      if (method === "timeline.restore") {
        const taskId = stringOr(input.taskId, "");
        const task = Object.values(state.tasks).flat().find((item) => recordId(item) === taskId);
        const sessionId = typeof input.sessionId === "string" ? input.sessionId : stringOr(asRecord(task).activeSessionId, "");
        let autoCheckpointId: string | null = null;
        if (state.gitChangedFiles.length > 0) {
          const now = new Date().toISOString();
          autoCheckpointId = `dev_checkpoint_${crypto.randomUUID()}`;
          state.gitCheckpoints = [{
            kind: "checkpoint",
            id: autoCheckpointId,
            taskId,
            sessionId,
            entryId: typeof input.entryId === "string" ? input.entryId : null,
            commitSha: crypto.randomUUID().replaceAll("-", "").padEnd(40, "0"),
            message: "Berry auto-restore checkpoint",
            reason: "auto-restore",
            createdAt: now,
          }, ...state.gitCheckpoints];
          state.gitChangedFiles = [];
        }
        if (input.mode === "conversation" || input.mode === "both") {
          const entryId = stringOr(input.entryId, "");
          const messages = state.messages[sessionId] ?? [];
          const boundary = messages.findIndex((message) => recordId(message) === entryId);
          if (boundary >= 0) state.messages[sessionId] = messages.slice(0, boundary);
          emit({
            type: "agent.event",
            taskId,
            sessionId,
            event: { kind: "session.note", note: "rewound", detail: "Restored conversation from timeline" },
          });
        }
        write(state);
        return { ok: true, autoCheckpointId } as T;
      }
      if (method === "worktree.create") {
        const taskId = stringOr(input.taskId, "");
        const branch = stringOr(input.branch, `berry/task-${taskId.slice(-8)}`);
        const path = stringOr(input.path, `/Users/dev/.berry/worktrees/${taskId}`);
        const baseRef = stringOr(input.baseRef, "main");
        const updated = patchDevTask(state, taskId, (task) => ({ ...task, worktreePath: path, worktreeBranch: branch, worktreeBaseRef: baseRef, worktreeBaseSha: "1".repeat(40) }));
        if (!updated) throw new Error("Task not found");
        emit({ type: "task.updated", task: updated as never });
        return devWorktree(updated) as T;
      }
      if (method === "worktree.list") {
        const workspaceId = stringOr(input.workspaceId, "");
        const workspace = state.workspaces.find((item) => recordId(item) === workspaceId);
        const mainPath = stringOr(asRecord(workspace).path, "/Users/dev/berry-chat");
        return [
          { path: mainPath, head: "1".repeat(40), branch: "main", baseRef: null, taskId: null, main: true, locked: false, prunable: false, dirty: state.gitChangedFiles.length > 0, ahead: 0, behind: 0 },
          ...(state.tasks[workspaceId] ?? []).filter((task) => typeof asRecord(task).worktreePath === "string").map(devWorktree),
        ] as T;
      }
      if (method === "worktree.orphans") return [] as T;
      if (method === "worktree.status") {
        const task = Object.values(state.tasks).flat().find((item) => recordId(item) === input.taskId);
        if (!task || typeof asRecord(task).worktreePath !== "string") throw new Error("Worktree not found");
        return { ...asRecord(devWorktree(task)), dirty: state.gitChangedFiles.length > 0 } as T;
      }
      if (method === "worktree.applyBack.preview") {
        const taskId = stringOr(input.taskId, "");
        const task = Object.values(state.tasks).flat().find((item) => recordId(item) === taskId);
        if (!task || typeof asRecord(task).worktreePath !== "string") throw new Error("Worktree not found");
        const files = state.gitChangedFiles.length > 0 ? ["src/example.ts"] : [];
        const patch = files.length > 0
          ? "diff --git a/src/example.ts b/src/example.ts\nindex 1111111..2222222 100644\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-export const berry = 'main';\n+export const berry = 'worktree';\n"
          : "";
        return { taskId, branch: stringOr(asRecord(task).worktreeBranch, "berry/task"), baseSha: "1".repeat(40), mainSha: "2".repeat(40), patch, files, applicable: true, conflict: null } as T;
      }
      if (method === "worktree.applyBack") {
        const files = state.gitChangedFiles.length > 0 ? ["src/example.ts"] : [];
        const autoCheckpointId = state.gitChangedFiles.length > 0 ? crypto.randomUUID() : null;
        state.gitCheckpoints = autoCheckpointId ? [{
          kind: "checkpoint",
          id: autoCheckpointId,
          taskId: null,
          sessionId: null,
          entryId: null,
          commitSha: "3".repeat(40),
          message: "Berry auto-merge checkpoint",
          reason: "auto-merge",
          createdAt: new Date().toISOString(),
        }, ...state.gitCheckpoints] : state.gitCheckpoints;
        write(state);
        return { applied: true, files, autoCheckpointId } as T;
      }
      if (method === "worktree.prepareBranch") {
        const taskId = stringOr(input.taskId, "");
        const task = Object.values(state.tasks).flat().find((item) => recordId(item) === taskId);
        if (!task || typeof asRecord(task).worktreePath !== "string") throw new Error("Worktree not found");
        const worktree = asRecord(devWorktree(task));
        return { ...worktree, dirty: false, ahead: Math.max(1, Number(worktree.ahead) || 0) } as T;
      }
      if (method === "worktree.remove") {
        const taskId = stringOr(input.taskId, "");
        const task = Object.values(state.tasks).flat().find((item) => recordId(item) === taskId);
        const path = stringOr(asRecord(task).worktreePath, "");
        const updated = patchDevTask(state, taskId, (current) => ({ ...current, worktreePath: null, worktreeBranch: null, worktreeBaseRef: null, worktreeBaseSha: null }));
        if (updated) emit({ type: "task.updated", task: updated as never });
        return { ok: true, path } as T;
      }
      if (method === "git.stage" || method === "git.unstage") {
        const paths = Array.isArray(input.paths) ? input.paths.filter((path): path is string => typeof path === "string") : [];
        state.gitChangedFiles = state.gitChangedFiles.map((file) => {
          const record = asRecord(file);
          if (!paths.includes(stringOr(record.path, ""))) return file;
          return method === "git.stage"
            ? { ...record, indexStatus: "M", worktreeStatus: " ", staged: true, unstaged: false, untracked: false }
            : { ...record, indexStatus: " ", worktreeStatus: "M", staged: false, unstaged: true, untracked: false };
        });
        write(state);
        return { stdout: "OK\n", stderr: "", exitCode: 0 } as T;
      }
      if (method === "git.revertFile") {
        const path = stringOr(input.path, "");
        state.gitChangedFiles = state.gitChangedFiles.filter((file) => stringOr(asRecord(file).path, "") !== path);
        write(state);
        return { stdout: "OK\n", stderr: "", exitCode: 0 } as T;
      }
      if (method === "git.switchBranch") {
        return { stdout: "OK\n", stderr: "", exitCode: 0 } as T;
      }
      if (method === "git.copyPatch") return { patch: devDiff() } as T;
      if (method === "terminal.list") {
        if (typeof input.taskId !== "string") return state.terminals as T;
        const task = Object.values(state.tasks).flat().find((item) => recordId(item) === input.taskId);
        const rawPath = asRecord(task).worktreePath;
        const path = typeof rawPath === "string" ? rawPath : null;
        return (path ? state.terminals.filter((terminal) => stringOr(asRecord(terminal).cwd, "").startsWith(path)) : state.terminals) as T;
      }
      if (method === "sandbox.status") {
        const tier = input.permissionMode === "plan" ? "read-only" : input.permissionMode === "full-access" ? "danger-full-access" : "workspace-write";
        return {
          platform: "macos",
          tier,
          enforcement: "enforced",
          mechanism: tier === "danger-full-access" ? "none" : "seatbelt",
          network: tier === "danger-full-access" ? "unrestricted" : tier === "workspace-write" && state.settings["sandbox.workspaceWrite.network"] === true ? "on" : "off",
          reason: null,
        } as T;
      }
      if (method === "terminal.create") {
        const now = new Date().toISOString();
        const task = typeof input.taskId === "string" ? Object.values(state.tasks).flat().find((item) => recordId(item) === input.taskId) : undefined;
        const workspace = state.workspaces.find((item) => recordId(item) === input.workspaceId);
        const terminal = {
          id: `dev_term_${crypto.randomUUID()}`,
          workspaceId: stringOr(input.workspaceId, ""),
          cwd: stringOr(asRecord(task).worktreePath, stringOr(asRecord(workspace).path, "/tmp")),
          shell: "dev-shell",
          cols: 120,
          rows: 32,
          status: "running",
          createdAt: now,
          updatedAt: now,
        };
        state.terminals = [terminal, ...state.terminals];
        state.terminalEvents[terminal.id] = [];
        write(state);
        window.setTimeout(() => {
          emit({ type: "terminal.output", terminalId: terminal.id, seq: 1, data: "Berry development terminal (simulated)\r\n$ " });
        }, 120);
        return terminal as T;
      }
      if (method === "terminal.write") {
        const id = stringOr(input.id, "");
        const data = stringOr(input.data, "");
        window.setTimeout(() => {
          emit({ type: "terminal.output", terminalId: id, seq: Date.now(), data });
        }, 30);
        return { ok: true } as T;
      }
      if (method === "terminal.resize" || method === "terminal.close") return { ok: true } as T;
      if (method === "terminal.events") return (state.terminalEvents[stringOr(input.id, "")] ?? []) as T;
      if (method === "browser.session.list") {
        const workspaceId = stringOr(input.workspaceId, "");
        return (workspaceId ? state.browsers.filter((browser) => asRecord(browser).workspaceId === workspaceId) : state.browsers) as T;
      }
      if (method === "browser.session.create") {
        const now = new Date().toISOString();
        const browser = {
          id: `dev_browser_${crypto.randomUUID()}`,
          workspaceId: stringOr(input.workspaceId, ""),
          status: "running" as const,
          currentUrl: stringOr(input.url, "about:blank"),
          createdAt: now,
          updatedAt: now,
        };
        state.browsers = [browser, ...state.browsers];
        write(state);
        emit({ type: "browser.session.updated", session: browser });
        return browser as T;
      }
      if (method === "browser.navigate") {
        state.browsers = state.browsers.map((browser) =>
          recordId(browser) === input.id
            ? { ...asRecord(browser), currentUrl: stringOr(input.url, "about:blank"), updatedAt: new Date().toISOString() }
            : browser,
        );
        write(state);
        const browser = state.browsers.find((item) => recordId(item) === input.id);
        if (browser) emit({ type: "browser.session.updated", session: browser as never });
        return { stdout: `Navigated to ${stringOr(input.url, "about:blank")}`, stderr: "", exitCode: 0 } as T;
      }
      if (method === "browser.back" || method === "browser.forward" || method === "browser.reload") {
        const action = method.replace("browser.", "");
        state.browsers = state.browsers.map((browser) =>
          recordId(browser) === input.id ? { ...asRecord(browser), updatedAt: new Date().toISOString() } : browser,
        );
        write(state);
        const browser = state.browsers.find((item) => recordId(item) === input.id);
        if (browser) emit({ type: "browser.session.updated", session: browser as never });
        return { stdout: `Browser ${action}`, stderr: "", exitCode: 0 } as T;
      }
      if (method === "browser.snapshot") {
        return {
          stdout: "@e1 [heading] Berry Preview\n@e2 [textbox] Ask Berry anything\n@e3 [button] Send\n",
          stderr: "",
          exitCode: 0,
        } as T;
      }
      if (method === "browser.screenshot") {
        const dataUrl = devScreenshotDataUrl();
        return {
          stdout: "Captured development screenshot.",
          stderr: "",
          exitCode: 0,
          path: dataUrl,
          dataUrl,
          name: "berry-browser-screenshot.png",
          mediaType: "image/png",
          size: dataUrlByteSize(dataUrl),
        } as T;
      }
      if (method === "browser.close") {
        state.browsers = state.browsers.map((browser) =>
          recordId(browser) === input.id ? { ...asRecord(browser), status: "closed", updatedAt: new Date().toISOString() } : browser,
        );
        write(state);
        const browser = state.browsers.find((item) => recordId(item) === input.id);
        if (browser) emit({ type: "browser.session.updated", session: browser as never });
        return { stdout: "OK", stderr: "", exitCode: 0 } as T;
      }
      if (method === "browser.click" || method === "browser.type" || method === "browser.fill") return { stdout: "OK", stderr: "", exitCode: 0 } as T;
      if (method === "mcp.server.list") return state.mcpServers as T;
      if (method === "mcp.server.save") {
        const now = new Date().toISOString();
        const server = {
          id: stringOr(input.id, `dev_mcp_${crypto.randomUUID()}`),
          workspaceId: input.workspaceId ?? null,
          name: stringOr(input.name, "MCP"),
          transport: stringOr(input.transport, "stdio"),
          command: typeof input.command === "string" ? input.command : null,
          args: Array.isArray(input.args) ? input.args : [],
          url: typeof input.url === "string" ? input.url : null,
          env: input.env && typeof input.env === "object" && !Array.isArray(input.env) ? input.env : {},
          authType: stringOr(input.authType, "none"),
          credentialRef: typeof input.credentialRef === "string" ? input.credentialRef : null,
          oauth: input.oauth ?? null,
          source: stringOr(input.source, "manual"),
          trusted: input.trusted === true,
          enabled: input.enabled !== false,
          healthStatus: "disconnected",
          toolCount: 0,
          lastError: null,
          latencyMs: null,
          lastCheckedAt: null,
          cachedTools: [],
          createdAt: now,
          updatedAt: now,
        };
        state.mcpServers = [server, ...state.mcpServers.filter((item) => recordId(item) !== server.id)];
        write(state);
        return server as T;
      }
      if (method === "mcp.server.enable" || method === "mcp.server.trust") {
        state.mcpServers = state.mcpServers.map((server) =>
          recordId(server) === input.id
            ? { ...asRecord(server), ...(method === "mcp.server.enable" ? { enabled: input.enabled !== false } : { trusted: input.trusted === true }) }
            : server,
        );
        write(state);
        return { ok: true } as T;
      }
      if (method === "mcp.server.health" || method === "mcp.server.reconnect") {
        const now = new Date().toISOString();
        state.mcpServers = state.mcpServers.map((server) => recordId(server) === input.id
          ? { ...asRecord(server), healthStatus: "connected", toolCount: 3, latencyMs: 42, lastError: null, lastCheckedAt: now }
          : server);
        write(state);
        return state.mcpServers.find((server) => recordId(server) === input.id) as T;
      }
      if (method === "mcp.import.scan") {
        return [{ source: "codex", sourcePath: "~/.codex/config.toml", name: "docs", transport: "streamable-http", command: null, args: [], url: "https://mcp.example.test/mcp", env: {} }] as T;
      }
      if (method === "mcp.import.apply") {
        const saved = [];
        for (const raw of Array.isArray(input.servers) ? input.servers : []) {
          const candidate = asRecord(raw);
          const now = new Date().toISOString();
          const server = {
            ...candidate,
            id: `dev_mcp_${crypto.randomUUID()}`,
            workspaceId: null,
            authType: "none",
            credentialRef: null,
            oauth: null,
            source: `import:${stringOr(candidate.source, "unknown")}`,
            trusted: false,
            enabled: true,
            healthStatus: "disconnected",
            toolCount: 0,
            lastError: null,
            latencyMs: null,
            lastCheckedAt: null,
            cachedTools: [],
            createdAt: now,
            updatedAt: now,
          };
          state.mcpServers.unshift(server);
          saved.push(server);
        }
        write(state);
        return saved as T;
      }
      if (method === "mcp.oauth.start") {
        const server = state.mcpServers.find((item) => recordId(item) === input.id);
        const device = asRecord(server).authType === "oauth-device";
        return (device
          ? { flow: "device", state: "dev_mcp_device", authorizationUrl: null, verificationUri: "https://auth.example.test/device", userCode: "BERRY-123", intervalSeconds: 1 }
          : { flow: "authorization-code", state: "dev_mcp_oauth", authorizationUrl: "https://auth.example.test/authorize?state=dev_mcp_oauth", verificationUri: null, userCode: null, intervalSeconds: null }) as T;
      }
      if (method === "mcp.oauth.exchange") {
        const server = state.mcpServers.find((item) => recordId(item) === input.id);
        return { credentialRef: stringOr(asRecord(server).credentialRef, `mcp-oauth-${stringOr(input.id, "server")}`), secret: JSON.stringify({ access_token: "dev_mcp_token" }) } as T;
      }
      if (method === "mcp.oauth.poll") {
        const server = state.mcpServers.find((item) => recordId(item) === input.id);
        return { status: "complete", credentialRef: stringOr(asRecord(server).credentialRef, `mcp-oauth-${stringOr(input.id, "server")}`), secret: JSON.stringify({ access_token: "dev_mcp_device_token" }) } as T;
      }
      if (method === "skill.list") return state.skills as T;
      if (method === "skill.getUserDirectory") return { path: "/Users/dev/.agents/skills" } as T;
      if (method === "skill.inspect") {
        const path = stringOr(input.path, "/tmp/example.skill");
        const name = path.split("/").filter(Boolean).at(-1)?.replace(/\.skill$/i, "") || "example";
        const workspace = state.workspaces.find((item) => recordId(item) === input.workspaceId);
        const projectRoot = workspace ? `${stringOr(asRecord(workspace).path, "/Users/dev/berry-chat")}/.agents/skills/${name}` : null;
        const globalRoot = `/Users/dev/.agents/skills/${name}`;
        return {
          archivePath: path,
          archiveName: `${name}.skill`,
          fingerprint: `dev-${hash(path)}`,
          name,
          description: "Imported development skill",
          license: "MIT",
          compatibility: null,
          allowedTools: null,
          metadata: {},
          version: "1.0.0",
          archiveSize: 2048,
          extractedSize: 4096,
          fileCount: 3,
          rootLayout: "top-level-directory",
          sourceDirectoryName: name,
          hasScripts: true,
          scripts: ["scripts/run.sh"],
          references: ["references/guide.md"],
          assets: [],
          resources: ["references/guide.md", "scripts/run.sh"],
          projectAvailable: Boolean(workspace),
          projectTrusted: asRecord(workspace).trustState === "trusted",
          destinations: { project: projectRoot, global: globalRoot },
          conflicts: {
            project: state.skills.some((skill) => asRecord(skill).sourcePath === `${projectRoot}/SKILL.md`),
            global: state.skills.some((skill) => asRecord(skill).sourcePath === `${globalRoot}/SKILL.md`),
          },
          limits: {},
        } as T;
      }
      if (method === "skill.create") {
        const now = new Date().toISOString();
        const name = stringOr(input.name, "new-skill");
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
        const skill = {
          id: `dev_skill_${hash(slug)}`,
          workspaceId: input.scope === "project" ? input.workspaceId ?? null : null,
          name,
          description: stringOr(input.description, ""),
          sourcePath: input.scope === "project" && input.workspaceId
            ? `${stringOr(asRecord(state.workspaces.find((item) => recordId(item) === input.workspaceId)).path, "/Users/dev/berry-chat")}/.agents/skills/${slug}/SKILL.md`
            : `/Users/dev/.agents/skills/${slug}/SKILL.md`,
          originPath: null,
          version: stringOr(input.version, "0.1.0"),
          contentHash: `dev-${hash(`${name}:${String(input.description)}`)}`,
          updateAvailable: false,
          pendingContentHash: null,
          trusted: true,
          enabled: true,
          scope: input.scope === "project" ? "workspace" : "user",
          readOnly: false,
          createdAt: now,
          updatedAt: now,
        };
        state.skills = [skill, ...state.skills.filter((item) => recordId(item) !== skill.id)];
        write(state);
        return skill as T;
      }
      if (method === "skill.save") {
        const now = new Date().toISOString();
        const skill = {
          id: stringOr(input.id, `dev_skill_${crypto.randomUUID()}`),
          workspaceId: input.workspaceId ?? null,
          name: stringOr(input.name, "Skill"),
          description: stringOr(input.description, ""),
          sourcePath: stringOr(input.sourcePath, ""),
          originPath: null,
          version: stringOr(input.version, "0.1.0"),
          contentHash: stringOr(input.contentHash, "dev-hash"),
          updateAvailable: false,
          pendingContentHash: null,
          trusted: input.trusted === true,
          enabled: input.enabled !== false,
          createdAt: now,
          updatedAt: now,
        };
        state.skills = [skill, ...state.skills.filter((item) => recordId(item) !== skill.id)];
        write(state);
        return skill as T;
      }
      if (method === "skill.enable") {
        state.skills = state.skills.map((skill) =>
          recordId(skill) === input.id ? { ...asRecord(skill), enabled: input.enabled !== false } : skill,
        );
        if (!state.skills.some((skill) => recordId(skill) === input.id) && typeof input.sourcePath === "string") {
          const now = new Date().toISOString();
          state.skills = [
            {
              id: stringOr(input.id, `dev_skill_${crypto.randomUUID()}`),
              workspaceId: input.workspaceId ?? null,
              name: stringOr(input.name, "Skill"),
              description: stringOr(input.description, ""),
              sourcePath: input.sourcePath,
              trusted: input.trusted !== false,
              enabled: input.enabled !== false,
              scope: "registered",
              readOnly: false,
              createdAt: now,
              updatedAt: now,
            },
            ...state.skills,
          ];
        }
        write(state);
        return { ok: true } as T;
      }
      if (method === "skill.trust") {
        state.skills = state.skills.map((skill) => recordId(skill) === input.id ? { ...asRecord(skill), trusted: input.trusted === true } : skill);
        write(state);
        return { ok: true } as T;
      }
      if (method === "skill.import") {
        const now = new Date().toISOString();
        const path = stringOr(input.path, "");
        const name = path.split("/").filter(Boolean).at(-1)?.replace(/\.(?:skill|md)$/i, "") || "imported-skill";
        const id = `dev_skill_${hash(name)}`;
        const existing = state.skills.find((item) => recordId(item) === id);
        const workspace = state.workspaces.find((item) => recordId(item) === input.workspaceId);
        const project = input.scope !== "global" && workspace;
        const installRoot = project ? `${stringOr(asRecord(workspace).path, "/Users/dev/berry-chat")}/.agents/skills` : "/Users/dev/.agents/skills";
        const pendingHash = `dev-update-${hash(path)}`;
        if (existing && typeof input.expectedFingerprint === "string" && input.conflictAction === "keep") return [existing] as T;
        if (existing && typeof input.expectedFingerprint !== "string" && input.confirmHash !== pendingHash) {
          throw new HostRpcError("skill_update_review_required", `Review changes before updating ${name}.`, {
            id,
            name,
            currentHash: stringOr(asRecord(existing).contentHash, "dev-hash"),
            pendingHash,
            version: "0.2.0",
            diff: "~ SKILL.md\n\nSKILL.md\n- Old workflow\n+ Updated workflow",
          });
        }
        const skill = {
          id,
          workspaceId: project ? input.workspaceId ?? null : null,
          name,
          description: "Imported development skill",
          sourcePath: `${installRoot}/${name}/SKILL.md`,
          originPath: path,
          version: typeof input.expectedFingerprint === "string" ? "1.0.0" : existing ? "0.2.0" : "0.1.0",
          contentHash: typeof input.expectedFingerprint === "string" ? input.expectedFingerprint : existing ? pendingHash : `dev-${hash(path)}`,
          updateAvailable: false,
          pendingContentHash: null,
          trusted: input.trusted === true,
          enabled: true,
          scope: project ? "workspace" : "user",
          readOnly: false,
          createdAt: now,
          updatedAt: now,
        };
        state.skills = [skill, ...state.skills.filter((item) => recordId(item) !== skill.id)];
        write(state);
        return [skill] as T;
      }
      if (method === "skill.openFolder" || method === "skill.openFile") return { ok: true } as T;
      if (method === "skill.delete") {
        const before = state.skills.length;
        state.skills = state.skills.filter((skill) => recordId(skill) !== input.id);
        write(state);
        return { removed: state.skills.length !== before } as T;
      }
      if (method === "file.list") {
        return {
          root: "/Users/dev/berry-chat",
          entries: [
            { name: "README.md", path: "/Users/dev/berry-chat/README.md", relativePath: "README.md", kind: "file" },
            { name: "read-me-first.md", path: "/Users/dev/berry-chat/docs/read-me-first.md", relativePath: "docs/read-me-first.md", kind: "file" },
            { name: "package.json", path: "/Users/dev/berry-chat/package.json", relativePath: "package.json", kind: "file" },
            { name: "src", path: "/Users/dev/berry-chat/src", relativePath: "src", kind: "directory" },
          ],
          truncated: false,
        } as T;
      }
      if (method === "agent.list") {
        return { agents: [] } as T;
      }
      if (method === "command.list") {
        return [
          { id: "slash_help", name: "help", description: "Show available commands", command: "/help", args: [], trusted: true, enabled: true },
          { id: "slash_goal", name: "goal", description: "Set, pause, resume, or clear the session goal", command: "/goal", args: [], trusted: true, enabled: true },
          { id: "slash_compact", name: "compact", description: "Compact the active conversation", command: "/compact", args: [], trusted: true, enabled: true },
          { id: "slash_fork", name: "fork", description: "Fork the active conversation", command: "/fork", args: [], trusted: true, enabled: true },
          { id: "slash_rewind", name: "rewind", description: "Rewind to an earlier user message", command: "/rewind", args: [], trusted: true, enabled: true },
          { id: "slash_pr", name: "pr", description: "Create or review the task pull request", command: "/pr", args: [], trusted: true, enabled: true },
          { id: "slash_image", name: "image", description: "Generate an image from a prompt", command: "/image", args: [], trusted: true, enabled: true },
          ...state.commands,
        ] as T;
      }
      if (method === "command.save") {
        const now = new Date().toISOString();
        const command = {
          id: stringOr(input.id, `dev_command_${crypto.randomUUID()}`),
          workspaceId: input.workspaceId ?? null,
          name: stringOr(input.name, "Command"),
          description: stringOr(input.description, ""),
          command: stringOr(input.command, ""),
          args: Array.isArray(input.args) ? input.args : [],
          trusted: input.trusted === true,
          enabled: input.enabled !== false,
          createdAt: now,
          updatedAt: now,
        };
        state.commands = [command, ...state.commands.filter((item) => recordId(item) !== command.id)];
        write(state);
        return command as T;
      }
      if (method === "command.run") return { stdout: "Development command bridge: run inside Tauri for process execution.", stderr: "", exitCode: 0 } as T;
      if (method === "command.delete") {
        const before = state.commands.length;
        state.commands = state.commands.filter((command) => recordId(command) !== input.id);
        write(state);
        return { removed: state.commands.length !== before } as T;
      }
      if (method === "plugin.list") return state.plugins as T;
      if (method === "plugin.installManifest" || method === "plugin.installPath" || method === "plugin.installGit") {
        const sourceKind = method === "plugin.installGit" ? "git" : method === "plugin.installPath" ? "folder" : "manifest";
        const fixtureName = sourceKind === "git" ? "Git tools" : sourceKind === "folder" ? "Local tools" : "Plugin";
        const manifest = method === "plugin.installManifest"
          ? asRecord(input.manifest)
          : {
              name: fixtureName,
              version: "1.0.0",
              description: `Development ${sourceKind} plugin`,
              capabilities: { commands: [{ name: "plugin-command" }], skills: [{ name: "plugin-skill" }] },
            };
        const now = new Date().toISOString();
        const sourceValue = sourceKind === "git" ? stringOr(input.url, "https://example.com/plugin.git") : sourceKind === "folder" ? stringOr(input.path, "/tmp/plugin") : stringOr(input.source, "manual");
        const plugin = {
          id: stringOr(input.id, `dev_plugin_${hash(stringOr(manifest.name, crypto.randomUUID()))}`),
          workspaceId: input.workspaceId ?? null,
          name: stringOr(manifest.name, "Plugin"),
          version: stringOr(manifest.version, "0.1.0"),
          description: stringOr(manifest.description, ""),
          source: sourceValue,
          sourcePath: sourceKind === "manifest" ? (typeof input.sourcePath === "string" ? input.sourcePath : null) : `~/.berry/plugins/${hash(sourceValue)}`,
          sourceKind,
          sourceUrl: sourceKind === "manifest" ? null : sourceValue,
          commitHash: sourceKind === "git" ? "0123456789abcdef0123456789abcdef01234567" : null,
          contentHash: hash(JSON.stringify(manifest)),
          signatureStatus: "unsigned",
          signatureFingerprint: null,
          updateAvailable: false,
          pendingVersion: null,
          pendingContentHash: null,
          pendingCommitHash: null,
          capabilityDiff: [],
          manifest: manifest as JsonValue,
          trusted: input.trusted === true,
          enabled: input.enabled !== false,
          installedAt: now,
          updatedAt: now,
        };
        state.plugins = [plugin, ...state.plugins.filter((item) => recordId(item) !== plugin.id)];
        write(state);
        return plugin as T;
      }
      if (method === "plugin.checkUpdate") {
        let updated: JsonValue | null = null;
        state.plugins = state.plugins.map((plugin) => {
          if (recordId(plugin) !== input.id) return plugin;
          const current = asRecord(plugin);
          updated = {
            ...current,
            updateAvailable: true,
            pendingVersion: "2.0.0",
            pendingContentHash: "dev-plugin-update-hash",
            pendingCommitHash: current.sourceKind === "git" ? "fedcba9876543210fedcba9876543210fedcba98" : null,
            capabilityDiff: ["+ mcp:new-connector"],
            updatedAt: new Date().toISOString(),
          };
          return updated;
        });
        if (!updated) throw new Error("Plugin not found");
        write(state);
        return updated as T;
      }
      if (method === "plugin.applyUpdate") {
        if (input.confirmHash !== "dev-plugin-update-hash") throw new Error("Plugin update hash does not match the reviewed update.");
        let updated: JsonValue | null = null;
        state.plugins = state.plugins.map((plugin) => {
          if (recordId(plugin) !== input.id) return plugin;
          const current = asRecord(plugin);
          const manifest = { ...asRecord(current.manifest), version: "2.0.0", capabilities: { ...asRecord(asRecord(current.manifest).capabilities), mcpServers: [{ name: "new-connector" }] } };
          updated = {
            ...current,
            version: "2.0.0",
            manifest,
            commitHash: current.pendingCommitHash ?? current.commitHash ?? null,
            contentHash: "dev-plugin-update-hash",
            updateAvailable: false,
            pendingVersion: null,
            pendingContentHash: null,
            pendingCommitHash: null,
            capabilityDiff: [],
            updatedAt: new Date().toISOString(),
          };
          return updated;
        });
        if (!updated) throw new Error("Plugin not found");
        write(state);
        return updated as T;
      }
      if (method === "plugin.enable" || method === "plugin.trust") {
        state.plugins = state.plugins.map((plugin) =>
          recordId(plugin) === input.id
            ? { ...asRecord(plugin), ...(method === "plugin.enable" ? { enabled: input.enabled !== false } : { trusted: input.trusted === true }) }
            : plugin,
        );
        write(state);
        return { ok: true } as T;
      }
      if (method === "plugin.delete") {
        const before = state.plugins.length;
        state.plugins = state.plugins.filter((plugin) => recordId(plugin) !== input.id);
        write(state);
        return { removed: state.plugins.length < before } as T;
      }
      if (method === "approval.list") return [] as T;
      if (method === "approval.decide") return { ok: true } as T;
      if (method === "question.list") return [] as T;
      if (method === "question.answer") return { ok: true } as T;
      if (method === "session.target.get") {
        const target = state.sessionTargets[stringOr(input.sessionId, "")];
        return (target && asRecord(target).status !== "cleared" ? target : null) as T;
      }
      if (method === "session.target.set") {
        const now = new Date().toISOString();
        const sessionId = stringOr(input.sessionId, "");
        const previous = asRecord(state.sessionTargets[sessionId]);
        const target = {
          sessionId,
          goalText: stringOr(input.goalText, "Goal"),
          status: input.status === "paused" || input.status === "met" || input.status === "cleared" ? input.status : "active",
          tokenBudget: typeof input.tokenBudget === "number" ? input.tokenBudget : null,
          timeBudgetMin: typeof input.timeBudgetMin === "number" ? input.timeBudgetMin : null,
          createdAt: typeof previous.createdAt === "string" ? previous.createdAt : now,
          updatedAt: now,
        };
        state.sessionTargets[sessionId] = target;
        write(state);
        emit({ type: "session.target.updated", sessionId, target: target as never });
        return target as T;
      }
      if (method === "session.target.clear") {
        const sessionId = stringOr(input.sessionId, "");
        if (state.sessionTargets[sessionId]) {
          state.sessionTargets[sessionId] = { ...asRecord(state.sessionTargets[sessionId]), status: "cleared", updatedAt: new Date().toISOString() };
          write(state);
        }
        emit({ type: "session.target.updated", sessionId, target: null });
        return { ok: true } as T;
      }
      if (method === "session.fork") {
        const sessionId = stringOr(input.sessionId, "");
        const entryId = typeof input.entryId === "string" ? input.entryId : null;
        const task = Object.values(state.tasks)
          .flat()
          .find((item) => asRecord(item).activeSessionId === sessionId);
        const now = new Date().toISOString();
        const newSessionId = `dev_session_${crypto.randomUUID()}`;
        const sourceMessages = state.messages[sessionId] ?? [];
        const boundaryIndex = entryId ? sourceMessages.findIndex((message) => recordId(message) === entryId) : -1;
        state.messages[newSessionId] = boundaryIndex >= 0 ? sourceMessages.slice(0, boundaryIndex + 1) : [...sourceMessages];
        const target = state.sessionTargets[sessionId];
        if (target && asRecord(target).status !== "cleared") {
          const now = new Date().toISOString();
          state.sessionTargets[newSessionId] = { ...asRecord(target), sessionId: newSessionId, createdAt: now, updatedAt: now };
        }
        if (task) {
          const taskRecord = asRecord(task);
          const workspaceId = stringOr(taskRecord.workspaceId, "");
          state.tasks[workspaceId] = (state.tasks[workspaceId] ?? []).map((item) =>
            recordId(item) === taskRecord.id ? { ...asRecord(item), activeSessionId: newSessionId, updatedAt: now } : item,
          );
          emit({ type: "task.updated", task: { ...taskRecord, activeSessionId: newSessionId, updatedAt: now } as never });
        }
        emit({ type: "agent.event", taskId: stringOr(asRecord(task).id, ""), sessionId: newSessionId, event: { kind: "session.note", note: "forked" } });
        write(state);
        return { sessionId: newSessionId } as T;
      }
      if (method === "session.rewind") {
        const sessionId = stringOr(input.sessionId, "");
        const entryId = stringOr(input.entryId, "");
        const task = Object.values(state.tasks).flat().find((item) => asRecord(item).activeSessionId === sessionId);
        const taskRecord = asRecord(task);
        if (state.gitChangedFiles.length > 0) {
          state.gitCheckpoints = [{
            kind: "checkpoint",
            id: `dev_checkpoint_${crypto.randomUUID()}`,
            taskId: typeof taskRecord.id === "string" ? taskRecord.id : null,
            sessionId,
            entryId,
            commitSha: crypto.randomUUID().replaceAll("-", "").padEnd(40, "0"),
            message: "Berry auto-rewind checkpoint",
            reason: "auto-rewind",
            createdAt: new Date().toISOString(),
          }, ...state.gitCheckpoints];
          state.gitChangedFiles = [];
        }
        const sourceMessages = state.messages[sessionId] ?? [];
        const boundaryIndex = sourceMessages.findIndex((message) => recordId(message) === entryId);
        if (boundaryIndex >= 0) state.messages[sessionId] = sourceMessages.slice(0, boundaryIndex);
        emit({
          type: "agent.event",
          taskId: "",
          sessionId,
          event: { kind: "session.note", note: "rewound", detail: "Rewound conversation" },
        });
        write(state);
        return { ok: true } as T;
      }
      if (method === "session.compact") {
        const sessionId = stringOr(input.sessionId, "");
        emit({ type: "agent.event", taskId: "", sessionId, event: { kind: "session.note", note: "compacted", detail: "Compacted 420 tokens into a summary" } });
        return { summary: "Development compact summary", tokensBefore: 420 } as T;
      }
      if (method === "session.contextStats") {
        const sessionId = stringOr(input.sessionId, "");
        const pendingInput = stringOr(input.pendingInput, "");
        const attachments = Array.isArray(input.attachments) ? input.attachments.map(asRecord) : [];
        const attachmentText = attachments
          .map((attachment) => stringOr(attachment.textContent, `[attachment: ${stringOr(attachment.name, "attachment")}]`))
          .join("\n");
        const usedTokens = devContextTokens([...(state.messages[sessionId] ?? []), `${pendingInput}\n${attachmentText}`]);
        const provider = state.providers.find((item) => recordId(item) === input.providerId);
        const providerRecord = asRecord(provider);
        const models = Array.isArray(providerRecord.models) ? providerRecord.models.map(asRecord) : [];
        const modelId = stringOr(input.model, stringOr(providerRecord.defaultModel, ""));
        const selectedModel = RemoteModelSchema.safeParse(models.find((model) => model.id === modelId));
        const contextWindow = selectedModel.success
          ? resolveModelCapabilities(selectedModel.data).context?.windowTokens ?? selectedModel.data.contextWindow ?? null
          : null;
        const percentUsed = contextWindow ? Math.min(100, (usedTokens / contextWindow) * 100) : null;
        return {
          usedTokens,
          contextWindow,
          percentUsed,
          tokensLeft: contextWindow ? Math.max(0, contextWindow - usedTokens) : null,
          source: "estimated",
          thresholdState: percentUsed === null ? "unknown" : percentUsed >= 95 ? "critical" : percentUsed >= 85 ? "warning" : "normal",
        } as T;
      }
      if (method === "permission.mode.get") return (state.settings["permission.mode"] ?? "ask") as T;
      if (method === "permission.mode.set") {
        state.settings["permission.mode"] = stringOr(input.mode, "ask");
        write(state);
        return { ok: true } as T;
      }
      if (method === "permission.grant.list") {
        const workspaceId = typeof input.workspaceId === "string" ? input.workspaceId : null;
        return state.permissionGrants.filter((grant) => {
          const scope = asRecord(grant).workspaceId;
          return !workspaceId || scope === null || scope === workspaceId;
        }) as T;
      }
      if (method === "permission.grant.revoke") {
        const id = stringOr(input.id, "");
        const grant = state.permissionGrants.find((candidate) => recordId(candidate) === id);
        state.permissionGrants = state.permissionGrants.filter((candidate) => recordId(candidate) !== id);
        if (grant) appendDevAudit(state, "grant", "revoked", stringOr(asRecord(grant).subject, id), asRecord(grant).workspaceId);
        write(state);
        return { removed: Boolean(grant) } as T;
      }
      if (method === "policy.rule.list") {
        const workspaceId = typeof input.workspaceId === "string" ? input.workspaceId : null;
        return state.policyRules.filter((rule) => {
          const scope = asRecord(rule).workspaceId;
          return !workspaceId || scope === null || scope === workspaceId;
        }) as T;
      }
      if (method === "policy.get") return { state: "active", path: "/Library/Managed Preferences/com.berry.chat/berry-policy.json", organization: { id: "acme", name: "Acme" }, version: 1, keyId: "acme-2026", issuedAt: "2026-07-01T12:00:00.000Z", expiresAt: null, error: null, locks: ["execpolicy", "models", "mcp", "plugins", "sandbox", "telemetry"] } as T;
      if (method === "policy.sync") {
        const fetchedAt = new Date().toISOString();
        const bundle = {
          version: 1,
          organization: { id: "acme", name: "Acme" },
          issuedAt: "2026-07-01T12:00:00.000Z",
          expiresAt: null,
          policy: {
            execpolicy: [{ id: "dev-policy-block-sudo", kind: "prefix_rule", decision: "forbid", pattern: ["sudo"], description: "Managed safety baseline" }],
            modelAllowlist: ["router:berry/auto"],
            mcpAllowlist: ["docs"],
            pluginAllowlist: ["openai-bundled/browser"],
            sandboxFloor: "workspace-write",
            telemetry: "optional",
          },
          signature: { algorithm: "ed25519", keyId: "acme-2026", value: "development-signature" },
        };
        return {
          status: { state: "active", path: stringOr(input.url, "/v1/orgs/acme/policy/berry-policy.json"), organization: bundle.organization, version: 1, keyId: "acme-2026", issuedAt: bundle.issuedAt, expiresAt: null, error: null, locks: ["execpolicy", "models", "mcp", "plugins", "sandbox", "telemetry"] },
          bundle,
          provenance: { source: "development", url: typeof input.url === "string" ? input.url : null, fetchedAt, verifiedAt: fetchedAt, bundleHash: "dev-policy-hash" },
        } as T;
      }
      if (method === "platform.login.start") {
        const baseUrl = stringOr(input.baseUrl, "https://cloud.berry.chat");
        const redirectUri = stringOr(input.redirectUri, "berry://platform/oauth/callback");
        const stateValue = `dev_platform_${crypto.randomUUID()}`;
        return {
          authorizationUrl: `${baseUrl}/oauth/authorize?response_type=code&client_id=berry-desktop-fixture&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(stateValue)}`,
          state: stateValue,
          redirectUri,
          baseUrl,
        } as T;
      }
      if (method === "platform.login.exchange") {
        const now = new Date().toISOString();
        const baseUrl = stringOr(input.baseUrl, "https://cloud.berry.chat");
        const session = {
          state: "connected",
          baseUrl,
          tenantId: "acme",
          organization: { id: "acme", name: "Acme" },
          user: { id: "dev_user", email: "developer@berry.test", name: "Berry Developer" },
          credentialRef: "berry-platform",
          tokenType: "Bearer",
          expiresAt: null,
          policyUrl: `${baseUrl}/v1/orgs/acme/policy/berry-policy.json`,
          policyPublicKeys: { "acme-2026": "dev-public-key" },
          usageIngestUrl: `${baseUrl}/v1/orgs/acme/usage/events`,
          usageSigningKeyId: "dev-usage",
          usageUploadEnabled: true,
          connectedAt: now,
          updatedAt: now,
        };
        state.platformSession = session;
        write(state);
        const policy = {
          status: { state: "active", path: session.policyUrl, organization: session.organization, version: 1, keyId: "acme-2026", issuedAt: "2026-07-01T12:00:00.000Z", expiresAt: null, error: null, locks: ["execpolicy", "models", "mcp", "plugins", "sandbox", "telemetry"] },
          bundle: null,
          provenance: { source: "development", url: session.policyUrl, fetchedAt: now, verifiedAt: now, bundleHash: "dev-policy-hash" },
        };
        return { session, policy } as T;
      }
      if (method === "platform.session.get") {
        return (state.platformSession ?? {
          state: "signed-out",
          baseUrl: null,
          tenantId: null,
          organization: null,
          user: null,
          credentialRef: null,
          tokenType: null,
          expiresAt: null,
          policyUrl: null,
          policyPublicKeys: {},
          usageIngestUrl: null,
          usageSigningKeyId: null,
          usageUploadEnabled: false,
          connectedAt: null,
          updatedAt: null,
        }) as T;
      }
      if (method === "platform.logout") {
        state.platformSession = null;
        write(state);
        return { ok: true } as T;
      }
      if (method === "platform.usage.flush") {
        if (!state.platformSession) return { uploaded: 0, skipped: 0, failed: 0, reason: "not connected" } as T;
        return { uploaded: devUsageEvents().length, skipped: 0, failed: 0, reason: null } as T;
      }
      if (method === "policy.rule.create") {
        const now = new Date().toISOString();
        const rule = {
          id: `dev_policy_${crypto.randomUUID()}`,
          workspaceId: input.layer === "workspace" ? input.workspaceId ?? null : null,
          layer: input.layer ?? "user",
          kind: input.kind ?? "exact",
          decision: input.decision ?? "prompt",
          pattern: input.pattern ?? [],
          description: typeof input.description === "string" && input.description ? input.description : null,
          createdAt: now,
          updatedAt: now,
        } as JsonValue;
        state.policyRules.push(rule);
        appendDevAudit(state, "policy", "rule-created", recordId(rule) ?? null, asRecord(rule).workspaceId);
        write(state);
        return rule as T;
      }
      if (method === "policy.rule.update") {
        const id = stringOr(input.id, "");
        const index = state.policyRules.findIndex((rule) => recordId(rule) === id);
        if (index < 0) throw new Error("Policy rule not found");
        const current = asRecord(state.policyRules[index]);
        if (current.layer === "managed" || current.layer === "session") throw new Error("Managed policy rules are read-only");
        const updated = { ...current, kind: input.kind, decision: input.decision, pattern: input.pattern, description: input.description ?? null, updatedAt: new Date().toISOString() } as JsonValue;
        state.policyRules[index] = updated;
        appendDevAudit(state, "policy", "rule-updated", id, current.workspaceId);
        write(state);
        return updated as T;
      }
      if (method === "policy.rule.delete") {
        const id = stringOr(input.id, "");
        const rule = state.policyRules.find((candidate) => recordId(candidate) === id);
        if (asRecord(rule).layer === "managed" || asRecord(rule).layer === "session") throw new Error("Managed policy rules are read-only");
        state.policyRules = state.policyRules.filter((candidate) => recordId(candidate) !== id);
        if (rule) appendDevAudit(state, "policy", "rule-deleted", id, asRecord(rule).workspaceId);
        write(state);
        return { removed: Boolean(rule) } as T;
      }
      if (method === "audit.list") {
        const filtered = state.auditEvents.filter((event) => {
          const row = asRecord(event);
          return (!input.sessionId || row.sessionId === input.sessionId) && (!input.taskId || row.taskId === input.taskId) && (!input.category || row.category === input.category);
        });
        return filtered.reverse().slice(0, typeof input.limit === "number" ? input.limit : 200) as T;
      }
      if (method === "audit.export") {
        const filtered = state.auditEvents.filter((event) => {
          const row = asRecord(event);
          return (!input.sessionId || row.sessionId === input.sessionId) && (!input.taskId || row.taskId === input.taskId) && (!input.category || row.category === input.category);
        });
        return { path: `/tmp/berry-audit.${input.format === "csv" ? "csv" : "json"}`, count: filtered.length, format: input.format === "csv" ? "csv" : "json", chainValid: true } as T;
      }
      if (method === "logs.list") return state.logs as T;
      if (method === "logs.export") return { path: "/tmp/berry-diagnostics.json" } as T;
      if (method === "support.issueReport.create") {
        return {
          path: "/tmp/berry-issue-report.json",
          issueBodyPath: "/tmp/berry-issue-report.json.github-issue.md",
          configHash: "dev-config-hash",
          logCount: state.logs.length,
          usageEventCount: devUsageEvents().length,
          crashReportCount: state.logs.filter((row) => asRecord(row).source === "renderer-crash").length,
          telemetryEnabled: state.settings["telemetry.enabled"] === true,
          schemaVersion: 1,
        } as T;
      }
      if (method === "support.crashReport.record") {
        if (state.settings["telemetry.enabled"] !== true) return { recorded: false, id: null, reason: "telemetry disabled by policy or settings" } as T;
        const now = new Date().toISOString();
        const id = `dev_log_${crypto.randomUUID()}`;
        state.logs.unshift({
          id,
          level: input.fatal === true ? "error" : "warn",
          source: "renderer-crash",
          message: stringOr(input.message, "Renderer crash"),
          metadata: { name: stringOr(input.name, "Error"), route: stringOr(input.route, "development"), fatal: input.fatal === true },
          createdAt: now,
        });
        write(state);
        return { recorded: true, id, reason: null } as T;
      }
      if (method === "usage.list") return state.usage as T;
      if (method === "usage.summary") return devUsageSummary() as T;
      if (method === "usage.events") return devUsageEvents() as T;
      if (method === "updater.status") {
        return {
          status: "development",
          feed: "development",
          configured: false,
          signingKeyPresent: false,
          currentVersion: "0.1.0",
          rolloutEligible: false,
        } as T;
      }
      if (method === "updater.install") return { installed: false, status: "not-configured", restartRequired: false } as T;
      throw new Error(`${method} requires the native Berry host.`);
    },
  };
}

function devUserParts(text: string, attachments: Record<string, JsonValue | undefined>[], now: string) {
  const parts: Array<{ id: string; messageId: string; kind: string; content: JsonValue; position: number; createdAt: string }> = [];
  if (text.length > 0) {
    parts.push({ id: `dev_part_${crypto.randomUUID()}`, messageId: "", kind: "text", content: text, position: parts.length, createdAt: now });
  }
  for (const attachment of attachments) {
    const mediaType = stringOr(attachment.mediaType, "application/octet-stream");
    const dataUrl = typeof attachment.dataUrl === "string" ? attachment.dataUrl : null;
    const name = stringOr(attachment.name, "attachment");
    const size = typeof attachment.size === "number" ? attachment.size : 0;
    parts.push({
      id: `dev_part_${crypto.randomUUID()}`,
      messageId: "",
      kind: mediaType.startsWith("image/") && dataUrl ? "image" : "text",
      content: mediaType.startsWith("image/") && dataUrl ? dataUrl : `[attachment: ${name}, ${mediaType}, ${size} bytes, id: ${stringOr(attachment.id, "attachment")}]`,
      position: parts.length,
      createdAt: now,
    });
  }
  if (parts.length === 0) parts.push({ id: `dev_part_${crypto.randomUUID()}`, messageId: "", kind: "text", content: "", position: 0, createdAt: now });
  return parts;
}

function devAssistantReply(input: string): string {
  return [
    `Here's what I found for **${input.slice(0, 64) || "your request"}**.`,
    "",
    "The workspace is a pnpm monorepo with a Tauri desktop shell. The renderer talks to a local host process over JSON-RPC, and agent turns stream back as push events.",
    "",
    "| Layer | Technology |",
    "| --- | --- |",
    "| Shell | Tauri v2 |",
    "| Renderer | React 19 + Tailwind |",
    "| Runtime | Berry harness |",
    "",
    "```ts",
    'const turn = await host.call("agent.turn", { input });',
    "```",
    "",
    "Want me to make the change?",
  ].join("\n");
}

function devFileEntries(): Array<{ path: string; kind: "dir" | "file"; size?: number }> {
  return [
    { path: "src", kind: "dir" },
    { path: "src/components", kind: "dir" },
    { path: "src/main.tsx", kind: "file", size: 1204 },
    { path: "src/app.tsx", kind: "file", size: 5480 },
    { path: "src/components/composer.tsx", kind: "file", size: 12240 },
    { path: "src/components/thread.tsx", kind: "file", size: 16320 },
    { path: "src/components/work-pane.tsx", kind: "file", size: 14280 },
    { path: "spec", kind: "dir" },
    { path: "docs/web-tools.md", kind: "file", size: 18420 },
    { path: "package.json", kind: "file", size: 890 },
    { path: "README.md", kind: "file", size: 2048 },
  ];
}

function devWorkspaceWiki(workspaceId: string): JsonValue {
  const now = new Date().toISOString();
  return {
    workspaceId,
    generatedAt: now,
    updatedAt: now,
    overview: "Development workspace with React desktop shell, host bridge, and agent runtime packages.",
    languages: [
      { name: "TypeScript React", files: 4 },
      { name: "Markdown", files: 2 },
      { name: "JSON", files: 1 },
    ],
    topDirectories: [
      { path: "src/components", files: 3 },
      { path: "spec", files: 1 },
    ],
    entrypoints: ["src/main.tsx", "src/app.tsx", "package.json"],
  };
}

function devDiff(): string {
  return [
    "diff --git a/apps/desktop/src/components/composer.tsx b/apps/desktop/src/components/composer.tsx",
    "index 8a19d1a..0a4f8cd 100644",
    "--- a/apps/desktop/src/components/composer.tsx",
    "+++ b/apps/desktop/src/components/composer.tsx",
    "@@ -1,4 +1,4 @@",
    "-<div className=\"rounded-2xl border bg-card\">",
    "+<div className=\"berry-composer-shell\">",
    "   <textarea />",
    "diff --git a/apps/desktop/src/components/thread.tsx b/apps/desktop/src/components/thread.tsx",
    "index 2db0c11..38a8310 100644",
    "--- a/apps/desktop/src/components/thread.tsx",
    "+++ b/apps/desktop/src/components/thread.tsx",
    "@@ -20,3 +20,5 @@",
    "+<ThinkingAccordion />",
    "+<ToolAccordion />",
  ].join("\n");
}

function devLargeDiff(): string {
  return [
    "diff --git a/apps/desktop/src/components/work-pane.tsx b/apps/desktop/src/components/work-pane.tsx",
    "index 3b0f8ea..92c9d71 100644",
    "--- a/apps/desktop/src/components/work-pane.tsx",
    "+++ b/apps/desktop/src/components/work-pane.tsx",
    "@@ -1,240 +1,240 @@",
    ...Array.from({ length: 240 }, (_, index) => ` export const reviewRow${String(index).padStart(3, "0")} = ${index};`),
  ].join("\n");
}

function devChangedFiles(): JsonValue[] {
  return [
    { path: "apps/desktop/src/components/composer.tsx", indexStatus: "M", worktreeStatus: " ", staged: true, unstaged: false, untracked: false },
    { path: "apps/desktop/src/components/thread.tsx", indexStatus: " ", worktreeStatus: "M", staged: false, unstaged: true, untracked: false },
    { path: "apps/desktop/src/components/work-pane.tsx", indexStatus: "?", worktreeStatus: "?", staged: false, unstaged: false, untracked: true },
  ];
}

function devContextTokens(values: JsonValue[]): number {
  const chars = values.reduce<number>((sum, value) => {
    if (typeof value === "string") return sum + value.length;
    try {
      return sum + JSON.stringify(value).length;
    } catch {
      return sum;
    }
  }, 0);
  return Math.max(0, Math.ceil(chars / 4));
}

function devScreenshotDataUrl(): string {
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540">',
    '<rect width="960" height="540" fill="#242321"/>',
    '<rect x="28" y="28" width="904" height="484" rx="28" fill="#302f2c" stroke="rgba(255,255,255,0.14)"/>',
    '<text x="64" y="92" fill="#f0eee9" font-family="Open Sans, Arial" font-size="34" font-weight="600">Berry Preview</text>',
    '<rect x="64" y="132" width="832" height="250" rx="22" fill="#22211f" stroke="rgba(255,255,255,0.12)"/>',
    '<text x="92" y="188" fill="#b9b4ad" font-family="JetBrains Mono, monospace" font-size="22">@e1 heading Berry workspace</text>',
    '<text x="92" y="232" fill="#b9b4ad" font-family="JetBrains Mono, monospace" font-size="22">@e2 textbox Ask Berry anything</text>',
    '<text x="92" y="276" fill="#b9b4ad" font-family="JetBrains Mono, monospace" font-size="22">@e3 button Send</text>',
    '<rect x="708" y="410" width="188" height="54" rx="18" fill="#494842"/>',
    '<text x="760" y="445" fill="#f0eee9" font-family="Open Sans, Arial" font-size="20">Screenshot</text>',
    "</svg>",
  ].join("");
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function dataUrlByteSize(dataUrl: string): number {
  const [, payload = ""] = dataUrl.split(",", 2);
  if (dataUrl.includes(";base64,")) return Math.ceil((payload.length * 3) / 4);
  return new TextEncoder().encode(decodeURIComponent(payload)).length;
}

function devUsageSummary() {
  const days: Array<{ date: string; tokens: number; turns: number }> = [];
  for (let index = 89; index >= 0; index -= 1) {
    const date = new Date(Date.now() - index * 86400000).toISOString().slice(0, 10);
    const seed = hash(date);
    const value = parseInt(seed.slice(0, 4), 16) % 90000;
    days.push({ date, tokens: value, turns: value % 23 });
  }
  return {
    days,
    models: [
      { model: "berry/router-auto", inputTokens: 1_240_000, outputTokens: 320_000, requests: 154 },
      { model: "openai/gpt-4.1-mini", inputTokens: 410_000, outputTokens: 98_000, requests: 61 },
    ],
    tools: [
      { name: "file.read", calls: 210, denied: 0 },
      { name: "shell.exec", calls: 84, denied: 3 },
      { name: "file.edit", calls: 66, denied: 1 },
    ],
  };
}

function devUsageEvents(): JsonValue[] {
  return [
    {
      id: "dev_usage_event_model",
      type: "model",
      providerId: null,
      taskId: null,
      sessionId: null,
      name: "dev/simulator",
      status: "completed",
      value: {
        inputTokens: 420,
        outputTokens: 120,
        requestedModel: "berry/fast",
        servedProvider: "openai",
        servedModel: "openai/gpt-4.1-mini",
      },
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    },
    {
      id: "dev_usage_event_tool",
      type: "tool",
      providerId: null,
      taskId: null,
      sessionId: null,
      name: "file.read",
      status: "completed",
      value: { path: "src/app.tsx" },
      createdAt: new Date(Date.now() - 120_000).toISOString(),
    },
  ];
}

interface DevState {
  workspaces: JsonValue[];
  tasks: Record<string, JsonValue[]>;
  messages: Record<string, JsonValue[]>;
  sessionTargets: Record<string, JsonValue>;
  settings: Record<string, JsonValue>;
  providers: JsonValue[];
  terminals: JsonValue[];
  terminalEvents: Record<string, JsonValue[]>;
  browsers: JsonValue[];
  mcpServers: JsonValue[];
  skills: JsonValue[];
  commands: JsonValue[];
  plugins: JsonValue[];
  permissionGrants: JsonValue[];
  policyRules: JsonValue[];
  auditEvents: JsonValue[];
  logs: JsonValue[];
  usage: JsonValue[];
  usageEvents: JsonValue[];
  platformSession: JsonValue | null;
  gitChangedFiles: JsonValue[];
  reviewSessions: JsonValue[];
  reviewComments: JsonValue[];
  reviewFindings: JsonValue[];
  gitCheckpoints: JsonValue[];
}

function asRecord(value: JsonValue | undefined): Record<string, JsonValue | undefined> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, JsonValue | undefined>) : {};
}

function stringOr(value: JsonValue | undefined, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function recordId(value: JsonValue): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const id = value.id;
  return typeof id === "string" ? id : undefined;
}

function devWorktree(value: JsonValue): JsonValue {
  const task = asRecord(value);
  return {
    path: stringOr(task.worktreePath, "/Users/dev/.berry/worktrees/task"),
    head: "2".repeat(40),
    branch: typeof task.worktreeBranch === "string" ? task.worktreeBranch : null,
    baseRef: typeof task.worktreeBaseRef === "string" ? task.worktreeBaseRef : null,
    taskId: typeof task.id === "string" ? task.id : null,
    main: false,
    locked: false,
    prunable: false,
    dirty: false,
    ahead: 0,
    behind: 0,
  };
}

function hash(value: string): string {
  let output = 0;
  for (let index = 0; index < value.length; index += 1) output = (output * 31 + value.charCodeAt(index)) >>> 0;
  return output.toString(16);
}

function appendDevAudit(state: DevState, category: string, action: string, subject: string | null, workspaceId: JsonValue | undefined) {
  const previous = asRecord(state.auditEvents.at(-1));
  const previousHash = typeof previous.eventHash === "string" ? previous.eventHash : "0".repeat(64);
  const sequence = typeof previous.sequence === "number" ? previous.sequence + 1 : 1;
  const id = `dev_audit_${crypto.randomUUID()}`;
  state.auditEvents.push({
    id,
    sequence,
    category,
    action,
    actor: "user",
    workspaceId: typeof workspaceId === "string" ? workspaceId : null,
    taskId: null,
    sessionId: null,
    subject,
    metadata: {},
    previousHash,
    eventHash: hash(`${id}:${sequence}:${previousHash}`).padStart(64, "0"),
    createdAt: new Date().toISOString(),
  });
}
