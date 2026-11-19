import { BerryApiError, type BerryApiClient, type BerryEventStream } from "@berry/api-client";
import {
  messageAttachmentContent,
  type AgentStreamEvent,
  type AttachmentInput,
  type Message,
  type MessageHistoryPage,
  type QueuedFollowUpCreate,
  type ReasoningLevel,
  type ServerQueuedFollowUp,
  type TurnIntent,
  type TurnState,
} from "@berry/shared";
import {
  confirmOptimisticMessage,
  reconcileDurableEventCursor,
  reconcileFetchedSessionMessages,
  type DurableEventSequences,
} from "@berry/client-core/message-reconciliation";
import { sessionStreamStore } from "@berry/client-core/session-stream-store";
import {
  isLegacyMessageHistoryPage,
  mergeMessagePage,
  mergeRefreshedMessagePage,
  reconcileAcceptedTurnState,
  reduceDurableTurnState,
  replayDurableStreamState,
  shouldUpdateDurableStateForEvent,
} from "@berry/client-core/thread-history";

const PAGE_SIZE = 50;
const MAX_AFTER_PAGES = 256;
const STREAM_OPEN_TIMEOUT_MS = 4_000;
const WORKSPACE_PATH = "/workspace";

export type HistoryState = {
  messages: Message[];
  loading: boolean;
  loadingOlder: boolean;
  hasOlder: boolean;
  error: string | null;
  queued: ServerQueuedFollowUp[];
  turn: TurnState | null;
};

export type SessionClient = Pick<
  BerryApiClient,
  "listMessagePage" | "turnState" | "streamEvents" | "startTurn" | "cancelTurn" | "appendMessage" | "enqueueQueuedFollowUp" | "listQueuedFollowUps" | "cancelQueuedFollowUp" | "decideApproval" | "answerQuestion" | "recoverTurn"
>;

export type RunTurnInput = {
  input: string;
  messageInput?: string | undefined;
  intent?: TurnIntent | undefined;
  attachments?: AttachmentInput[] | undefined;
  requestMessageId: string;
  taskId: string;
  workspaceId: string;
  /** The task workspace's sandbox path; the web sends the workspace's own path. */
  workspacePath?: string | undefined;
  reasoning: ReasoningLevel;
  model?: { providerId: string; model: string } | undefined;
};

/**
 * One task session's transcript and live run, following the web shell:
 * bounded history pages, the durable SSE cursor, optimistic user messages,
 * and turn admission with an idempotent operation id.
 */
export class SessionController {
  #state: HistoryState = { messages: [], loading: true, loadingOlder: false, hasOlder: false, error: null, queued: [], turn: null };
  readonly #listeners = new Set<() => void>();
  readonly #pending = new Set<string>();
  #page: Pick<MessageHistoryPage, "oldestSequence" | "newestSequence" | "historyRevision" | "historyDeletionRevision"> = { oldestSequence: null, newestSequence: null, historyRevision: null, historyDeletionRevision: null };
  #cursor: string | null = null;
  #sequences: DurableEventSequences = {};
  #stream: BerryEventStream | null = null;
  #streamOpen: Promise<void> | null = null;
  #disposed = false;
  /** Turn submissions in flight; an idle snapshot fetched meanwhile is stale. */
  #submitting = 0;

  constructor(
    private readonly client: SessionClient,
    readonly sessionId: string,
    private readonly hooks: { onTurnEnd?: (status: string) => void; now?: () => string } = {},
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): HistoryState => this.#state;

  async load(): Promise<void> {
    this.#set({ loading: true, error: null });
    try {
      const [page, turn] = await Promise.all([
        this.client.listMessagePage(this.sessionId, { limit: PAGE_SIZE }),
        this.client.turnState(this.sessionId),
      ]);
      if (this.#disposed) return;
      this.#replacePage(page);
      this.#applyTurnState(turn);
      void this.refreshQueue();
    } catch (error) {
      this.#set({ loading: false, error: errorMessage(error, "Couldn't load this task.") });
    }
  }

  async loadOlder(): Promise<void> {
    if (!this.#state.hasOlder || this.#state.loadingOlder || this.#page.oldestSequence === null) return;
    this.#set({ loadingOlder: true });
    try {
      const page = await this.client.listMessagePage(this.sessionId, { limit: PAGE_SIZE, before: this.#page.oldestSequence });
      this.#page = { ...this.#page, oldestSequence: page.oldestSequence ?? this.#page.oldestSequence };
      this.#set({ messages: mergeMessagePage(this.#state.messages, page.messages, "prepend"), hasOlder: page.hasOlder, loadingOlder: false });
    } catch {
      this.#set({ loadingOlder: false });
    }
  }

  /** Incremental refresh after a run settles, falling back to the newest page when history changed. */
  async refreshMessages(): Promise<void> {
    if (this.#page.newestSequence === null) {
      this.#replacePage(await this.client.listMessagePage(this.sessionId, { limit: PAGE_SIZE }));
      return;
    }
    let after = this.#page.newestSequence;
    let messages = this.#state.messages;
    for (let request = 0; request < MAX_AFTER_PAGES; request += 1) {
      const page = await this.client.listMessagePage(this.sessionId, {
        limit: PAGE_SIZE,
        after,
        ...(this.#page.historyRevision ? { historyRevision: this.#page.historyRevision } : {}),
      });
      if (isLegacyMessageHistoryPage(page) || page.historyRevision !== this.#page.historyRevision || page.historyDeletionRevision !== this.#page.historyDeletionRevision || page.cursorPresent === false) {
        this.#replacePage(await this.client.listMessagePage(this.sessionId, { limit: PAGE_SIZE }));
        return;
      }
      const reconciled = reconcileFetchedSessionMessages(page.messages, messages, this.#pending);
      messages = mergeMessagePage(messages.filter((message) => !reconciled.some((candidate) => candidate.id === message.id)), reconciled, "append");
      for (const message of page.messages) this.#pending.delete(message.id);
      if (page.newestSequence) after = page.newestSequence;
      if (!page.hasNewer) break;
    }
    this.#page = { ...this.#page, newestSequence: after };
    this.#set({ messages });
  }

  addOptimisticUserMessage(id: string, text: string, attachments: AttachmentInput[] = []): void {
    this.#pending.add(id);
    this.#set({ messages: [...this.#state.messages, userMessage(id, this.sessionId, text, attachments, this.hooks.now?.() ?? new Date().toISOString())] });
  }

  /**
   * Starts a turn the way the web does: show the run immediately, open the
   * stream first so no early events are missed, then admit the turn.
   */
  async runTurn(input: RunTurnInput): Promise<void> {
    this.#pending.add(input.requestMessageId);
    await this.#submit(input.requestMessageId, input, {
      input: input.input,
      requestMessageId: input.requestMessageId,
      ...(input.intent ? { intent: input.intent } : {}),
      ...(input.messageInput ? { messageInput: input.messageInput } : {}),
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    }, false);
  }

  /** "Continue response": resumes the latest interrupted assistant turn in place. */
  async continueTurn(input: Omit<RunTurnInput, "input" | "messageInput" | "intent" | "attachments" | "requestMessageId">): Promise<void> {
    await this.#submit(randomId(), { ...input, input: "", requestMessageId: randomId() }, { continueInterruptedTurn: true as const }, true);
  }

  /**
   * Sends a prompt now while a run is active, the web's "steer": stop the
   * run, persist the prompt as the next user message, then start a new turn.
   */
  async steer(input: RunTurnInput): Promise<void> {
    await this.client.cancelTurn(this.sessionId).catch(() => undefined);
    this.#detach();
    this.#cursor = null;
    this.#sequences = {};
    sessionStreamStore.reset(this.sessionId);
    await this.refreshMessages().catch(() => undefined);
    const text = input.messageInput ?? input.input;
    this.addOptimisticUserMessage(input.requestMessageId, text, input.attachments ?? []);
    try {
      const persisted = await this.client.appendMessage(this.sessionId, {
        messageId: input.requestMessageId,
        role: "user",
        parts: [
          { kind: "text", content: text },
          ...(input.attachments ?? []).map((attachment) => ({ kind: "attachment" as const, content: messageAttachmentContent(attachment) })),
        ],
      });
      this.#pending.delete(input.requestMessageId);
      this.#set({ messages: confirmOptimisticMessage(this.#state.messages, input.requestMessageId, persisted) });
    } catch (error) {
      this.#pending.delete(input.requestMessageId);
      this.#set({ messages: this.#state.messages.filter((message) => message.id !== input.requestMessageId) });
      throw error;
    }
    await this.runTurn({ ...input, input: text, messageInput: undefined });
  }

  async #submit(
    operationId: string,
    input: Pick<RunTurnInput, "taskId" | "workspaceId" | "workspacePath" | "reasoning" | "model" | "intent" | "messageInput" | "attachments"> & { input: string; requestMessageId: string },
    body: Record<string, unknown>,
    continuation: boolean,
  ): Promise<void> {
    this.#submitting += 1;
    try {
      await this.#submitTurn(operationId, input, body, continuation);
    } finally {
      this.#submitting -= 1;
    }
  }

  async #submitTurn(
    operationId: string,
    input: Pick<RunTurnInput, "taskId" | "workspaceId" | "workspacePath" | "reasoning" | "model" | "intent" | "messageInput" | "attachments"> & { input: string; requestMessageId: string },
    body: Record<string, unknown>,
    continuation: boolean,
  ): Promise<void> {
    const pendingTurnId = `pending_${Date.now()}`;
    sessionStreamStore.update(this.sessionId, { kind: "turn.start", turnId: pendingTurnId, ...(continuation ? { continuation: true } : {}) } as AgentStreamEvent);
    this.#set({ turn: pendingTurnState(pendingTurnId, continuation, "queued", "Submitting the turn") });
    await this.attach();
    this.#set({ turn: pendingTurnState(pendingTurnId, continuation, "assembling_context", "Preparing context") });
    const request = {
      operationId,
      workspacePath: input.workspacePath || WORKSPACE_PATH,
      workspaceId: input.workspaceId,
      permissionMode: "full-access" as const,
      reasoning: input.reasoning,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      ...(input.model ? { provider: { id: input.model.providerId }, model: input.model.model } : {}),
      ...body,
    } as Parameters<SessionClient["startTurn"]>[1];
    const accept = (turnId: string) => this.#set({ turn: reconcileAcceptedTurnState(this.#state.turn ?? undefined, pendingTurnId, turnId, continuation) });
    try {
      accept((await this.client.startTurn(this.sessionId, request)).turnId);
    } catch (error) {
      if (!continuation && error instanceof BerryApiError && error.status === 409) {
        // A run is already active: queue this prompt on the server so it runs next.
        const state = await this.client.turnState(this.sessionId).catch(() => null);
        if (state?.active) {
          this.#applyTurnState(state);
          const followUp: QueuedFollowUpCreate = {
            taskId: input.taskId,
            workspaceId: input.workspaceId,
            input: input.messageInput ?? input.input,
            ...(input.intent ? { intent: input.intent } : {}),
            attachments: input.attachments ?? [],
            idempotencyKey: `queued_follow_up_${input.requestMessageId}`,
          };
          await this.client.enqueueQueuedFollowUp(this.sessionId, followUp).catch(() => undefined);
          await this.refreshQueue();
          return;
        }
      }
      if (isRetryable(error)) {
        try {
          // Same operation id: the server deduplicates the admission.
          accept((await this.client.startTurn(this.sessionId, request)).turnId);
          return;
        } catch (retryError) {
          const state = await this.client.turnState(this.sessionId).catch(() => null);
          if (state?.active) {
            this.#applyTurnState(state);
            return;
          }
          this.#failTurn(errorMessage(retryError, "Couldn't start the task."));
          throw retryError;
        }
      }
      this.#failTurn(errorMessage(error, "Couldn't start the task."));
      await this.refreshMessages().catch(() => undefined);
      throw error;
    }
  }

  async cancel(): Promise<void> {
    await this.client.cancelTurn(this.sessionId).catch(() => undefined);
    this.#detach();
    this.#cursor = null;
    this.#sequences = {};
    sessionStreamStore.update(this.sessionId, { kind: "turn.end", turnId: sessionStreamStore.get(this.sessionId).turnId ?? "cancelled", status: "cancelled" } as AgentStreamEvent);
    await Promise.all([this.refreshMessages().catch(() => undefined), this.refreshQueue()]);
    sessionStreamStore.reset(this.sessionId);
  }

  async queueFollowUp(input: { taskId: string; workspaceId: string; text: string; attachments?: AttachmentInput[]; intent?: TurnIntent; id: string }): Promise<void> {
    const followUp: QueuedFollowUpCreate = {
      taskId: input.taskId,
      workspaceId: input.workspaceId,
      input: input.text,
      ...(input.intent ? { intent: input.intent } : {}),
      attachments: input.attachments ?? [],
      idempotencyKey: input.id,
    };
    await this.client.enqueueQueuedFollowUp(this.sessionId, followUp);
    await this.refreshQueue();
  }

  async cancelQueued(id: string): Promise<void> {
    await this.client.cancelQueuedFollowUp(id);
    await this.refreshQueue();
  }

  async refreshQueue(): Promise<void> {
    try {
      const page = await this.client.listQueuedFollowUps(this.sessionId, { limit: 100 });
      this.#set({ queued: page.items.filter((item) => item.status === "queued" || item.status === "paused") });
    } catch {
      // Older servers without queued follow-ups simply show none.
    }
  }

  /** Opens the durable stream from the last cursor; resolves once it is open (or after a short wait). */
  attach(): Promise<void> {
    if (this.#stream && this.#streamOpen) return this.#streamOpen;
    let resolveOpen: () => void = () => undefined;
    this.#streamOpen = new Promise<void>((resolve) => {
      resolveOpen = resolve;
      setTimeout(resolve, STREAM_OPEN_TIMEOUT_MS);
    });
    this.#stream = this.client.streamEvents(this.sessionId, {
      onOpen: () => resolveOpen(),
      onEvent: (event, cursor) => this.#onEvent(event, cursor),
      onError: () => resolveOpen(),
    }, this.#cursor);
    return this.#streamOpen;
  }

  dispose(): void {
    this.#disposed = true;
    this.#detach();
    this.#listeners.clear();
  }

  #onEvent(event: AgentStreamEvent, cursor: string | null): void {
    if (event.kind === "turn.start") this.#sequences = {};
    const reconciled = reconcileDurableEventCursor(this.#sequences, cursor);
    if (!reconciled.accepted) return;
    this.#sequences = reconciled.sequences;
    if (cursor) this.#cursor = cursor;
    sessionStreamStore.update(this.sessionId, event);
    if (shouldUpdateDurableStateForEvent(event)) {
      const turn = reduceDurableTurnState(this.#state.turn ?? undefined, event);
      if (turn) this.#set({ turn });
    }
    if (event.kind === "turn.end") void this.#afterTurnEnd(event.status);
  }

  async #afterTurnEnd(status: string): Promise<void> {
    this.#detach();
    this.hooks.onTurnEnd?.(status);
    for (const delay of [0, 500, 1_000]) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      if (this.#disposed) return;
      try {
        const [, state] = await Promise.all([this.refreshMessages(), this.client.turnState(this.sessionId)]);
        void this.refreshQueue();
        // A queued follow-up may already be running on the worker.
        if (state.active) this.#applyTurnState(state);
        else {
          this.#set({ turn: state });
          sessionStreamStore.reset(this.sessionId);
        }
        return;
      } catch {
        // Retry: the worker can lag the terminal event slightly.
      }
    }
  }

  #applyTurnState(turn: TurnState): void {
    // A snapshot taken before our own submission was admitted would wipe the pending run.
    if (!turn.active && this.#submitting > 0) return;
    this.#cursor = turn.lastEventId ?? this.#cursor;
    const runCursor = turn.lastEventId ? /^([0-9a-f-]{36}):(\d+)$/i.exec(turn.lastEventId) : null;
    this.#sequences = runCursor ? { [runCursor[1]!]: Number(runCursor[2]) } : {};
    this.#set({ turn });
    if (turn.active || turn.runState === "recovery_required") {
      sessionStreamStore.set(this.sessionId, replayDurableStreamState(turn));
      if (turn.active) void this.attach();
    } else {
      sessionStreamStore.reset(this.sessionId);
    }
  }

  #replacePage(page: MessageHistoryPage): void {
    const reconciled = reconcileFetchedSessionMessages(page.messages, this.#state.messages, this.#pending);
    for (const message of page.messages) this.#pending.delete(message.id);
    this.#page = {
      oldestSequence: page.oldestSequence,
      newestSequence: page.newestSequence,
      historyRevision: page.historyRevision,
      historyDeletionRevision: page.historyDeletionRevision,
    };
    this.#set({ messages: mergeRefreshedMessagePage(this.#state.messages, page.messages, reconciled), hasOlder: page.hasOlder, loading: false });
  }

  #failTurn(message: string): void {
    const turnId = sessionStreamStore.get(this.sessionId).turnId ?? "failed";
    const turn = this.#state.turn;
    if (turn) this.#set({ turn: { ...turn, active: false, runState: "failed", waitingReason: null, nextAction: null, error: message } });
    sessionStreamStore.update(this.sessionId, { kind: "error", message } as AgentStreamEvent);
    sessionStreamStore.update(this.sessionId, { kind: "turn.end", turnId, status: "failed" } as AgentStreamEvent);
    this.#detach();
  }

  #detach(): void {
    this.#stream?.close();
    this.#stream = null;
    this.#streamOpen = null;
  }

  #set(patch: Partial<HistoryState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }
}

function userMessage(id: string, sessionId: string, text: string, attachments: AttachmentInput[], now: string): Message {
  return {
    id,
    sessionId,
    role: "user",
    status: "complete",
    parts: [
      { id: `${id}_part`, messageId: id, kind: "text", content: text, position: 0, createdAt: now },
      ...attachments.map((attachment, index) => ({
        id: `${id}_attachment_${index}`,
        messageId: id,
        kind: "attachment" as const,
        content: messageAttachmentContent(attachment),
        position: index + 1,
        createdAt: now,
      })),
    ],
    inputTokens: 0,
    outputTokens: 0,
    generationMs: 0,
    createdAt: now,
    updatedAt: now,
  } as Message;
}

function pendingTurnState(turnId: string, continuation: boolean, runState: "queued" | "assembling_context", nextAction: string): TurnState {
  return { active: true, turnId, continuation, bufferedEvents: [], replayOnly: false, owner: null, runState, waitingReason: null, nextAction, error: null };
}

function randomId(): string {
  return globalThis.crypto.randomUUID();
}

function isRetryable(error: unknown): boolean {
  return !(error instanceof BerryApiError) || error.status === 408 || error.status === 429 || error.status >= 500;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof BerryApiError && typeof error.body === "object" && error.body && typeof (error.body as { message?: unknown }).message === "string") {
    return (error.body as { message: string }).message;
  }
  return fallback;
}
