import { BerryApiClient } from "@berry/api-client";
import type { ApprovalRequest, JsonValue, Message, Task } from "@berry/shared";
import { NativeHostClient } from "./native-client";
import { pageContextToAttachment } from "./page-capture";
import type { BerryExtensionClient, CapturedPageContext, ExtensionConnectionConfig } from "./types";

const CONFIG_KEY = "berry.connection";
const DEFAULT_CONFIG: ExtensionConnectionConfig = {
  kind: "local",
  platformBaseUrl: "https://cloud.berry.chat",
  platformToken: "",
  workspaceId: "browser",
};

export async function loadConnectionConfig(): Promise<ExtensionConnectionConfig> {
  const stored = await chrome.storage.local.get(CONFIG_KEY);
  return { ...DEFAULT_CONFIG, ...(stored[CONFIG_KEY] ?? {}) };
}

export async function saveConnectionConfig(config: ExtensionConnectionConfig): Promise<void> {
  await chrome.storage.local.set({ [CONFIG_KEY]: config });
}

export async function createBerryClient(config?: ExtensionConnectionConfig): Promise<BerryExtensionClient> {
  config ??= await loadConnectionConfig();
  if (config.kind === "platform") return new PlatformBerryClient(config);
  const native = new NativeHostClient();
  await native.handshake();
  return new LocalBerryClient(native, config);
}

class PlatformBerryClient implements BerryExtensionClient {
  readonly #client: BerryApiClient;
  readonly #config: ExtensionConnectionConfig;
  readonly label: string;

  constructor(config: ExtensionConnectionConfig) {
    this.#config = config;
    this.label = `Platform · ${new URL(config.platformBaseUrl).host}`;
    this.#client = new BerryApiClient({
      baseUrl: config.platformBaseUrl,
      headers: config.platformToken ? { Authorization: `Bearer ${config.platformToken}` } : undefined,
    });
  }

  async listTasks(): Promise<Task[]> {
    return await this.#client.listTasks({ workspaceId: this.#config.workspaceId });
  }

  async createTask(title: string): Promise<{ task: Task; sessionId: string }> {
    const { task, session } = await this.#client.createTask({ workspaceId: this.#config.workspaceId, title, permissionMode: "ask" });
    return { task, sessionId: session.id };
  }

  async listMessages(sessionId: string): Promise<Message[]> {
    return await this.#client.listMessages(sessionId);
  }

  async sendMessage(input: { task: Task; sessionId: string; text: string; page?: CapturedPageContext | null }): Promise<void> {
    const parts = messageParts(input.text, input.page);
    await this.#client.appendMessage(input.sessionId, { role: "user", parts });
    await this.#client.startTurn(input.sessionId, {
      input: input.text,
      workspaceId: input.task.workspaceId,
      workspacePath: input.task.workspaceId,
      permissionMode: "ask",
      provider: { id: "platform" },
    });
  }

  async listApprovals(): Promise<ApprovalRequest[]> {
    return await this.#client.listApprovals();
  }

  async decideApproval(approvalId: string, decision: "approved_once" | "denied"): Promise<void> {
    await this.#client.decideApproval(approvalId, { decision });
  }
}

class LocalBerryClient implements BerryExtensionClient {
  readonly label = "Desktop host";
  readonly #native: NativeHostClient;
  readonly #config: ExtensionConnectionConfig;

  constructor(native: NativeHostClient, config: ExtensionConnectionConfig) {
    this.#native = native;
    this.#config = config;
  }

  async listTasks(): Promise<Task[]> {
    const workspaceId = await this.#workspaceId();
    if (!workspaceId) return [];
    return await this.#native.call("task.list", { workspaceId });
  }

  async createTask(title: string): Promise<{ task: Task; sessionId: string }> {
    const workspaceId = await this.#workspaceId();
    if (!workspaceId) throw new Error("Open a workspace in Berry Desktop before creating browser tasks.");
    const { task, session } = await this.#native.call("task.create", { workspaceId, title, permissionMode: "ask" });
    return { task, sessionId: session.id };
  }

  async listMessages(sessionId: string): Promise<Message[]> {
    return await this.#native.call("session.messages", { sessionId });
  }

  async sendMessage(input: { task: Task; sessionId: string; text: string; page?: CapturedPageContext | null }): Promise<void> {
    await this.#native.call("session.appendMessage", { sessionId: input.sessionId, role: "user", parts: messageParts(input.text, input.page) });
    const providers = await this.#native.call("model.provider.list", {});
    const provider = providers[0];
    if (!provider) return;
    await this.#native.call("agent.turn", {
      taskId: input.task.id,
      sessionId: input.sessionId,
      input: input.text,
      providerId: provider.id,
      model: provider.defaultModel ?? undefined,
      credentialRef: provider.credentialRef ?? undefined,
      permissionMode: "ask",
    });
  }

  async listApprovals(): Promise<ApprovalRequest[]> {
    return await this.#native.call("approval.list", {});
  }

  async decideApproval(approvalId: string, decision: "approved_once" | "denied"): Promise<void> {
    await this.#native.call("approval.decide", { id: approvalId, decision });
  }

  async #workspaceId(): Promise<string | null> {
    if (this.#config.workspaceId && this.#config.workspaceId !== "browser") return this.#config.workspaceId;
    const workspaces = await this.#native.call("workspace.list", {});
    return workspaces[0]?.id ?? null;
  }
}

function messageParts(text: string, page?: CapturedPageContext | null): Array<{ kind: string; content: JsonValue }> {
  return [
    { kind: "text", content: text },
    ...(page ? [pageContextToAttachment(page)] : []),
  ];
}
