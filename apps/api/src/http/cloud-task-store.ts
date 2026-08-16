import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import {
  createId,
  MessagePartKindSchema,
  MessageRoleSchema,
  MessageSchema,
  nowIso,
  PermissionModeSchema,
  SessionStatusSchema,
  SessionSchema,
  TaskSchema,
  normalizeTaskForWeb,
  type MessageHistoryPage,
  type TaskCollectionState,
  type TaskCollectionSummary,
  type TaskPage,
  type WorkspacePage,
  TaskStatusSchema,
  type JsonValue,
  type Message,
  type MessagePart,
  type MessagePartKind,
  type MessageRole,
  type PermissionMode,
  type ConversationKind,
  type Session,
  type Task,
  type TaskStatus,
  WorkspaceSchema,
  type Workspace,
} from "@berry/shared";
import { SELF_HOST_TENANT_ID, SELF_HOST_WORKSPACE_ID } from "@berry/db";
import { CloudDatabaseService, type SqlExecutor } from "../db/cloud-database.service.ts";
import { garbageCollectFileIfUnreferenced } from "../files/file-lifecycle.ts";

export const CLOUD_TASK_STORE = Symbol("CLOUD_TASK_STORE");

export const MESSAGE_HISTORY_DEFAULT_LIMIT = 50;
export const MESSAGE_HISTORY_MAX_LIMIT = 200;
export const MESSAGE_HISTORY_MAX_CURSOR = "9223372036854775807";

export interface ListMessagesOptions {
  limit?: number | undefined;
  before?: string | undefined;
  after?: string | undefined;
  historyRevision?: string | undefined;
}

export interface CreateTaskInput {
  workspaceId?: string | undefined;
  workspaceKind?: "project" | "general" | undefined;
  conversationKind?: ConversationKind | undefined;
  ownerUserId?: string | null | undefined;
  title?: string | undefined;
  permissionMode?: PermissionMode | undefined;
  modelProviderId?: string | null | undefined;
  model?: string | null | undefined;
}

export interface UpdateTaskInput {
  title?: string | undefined;
  status?: TaskStatus | undefined;
  pinned?: boolean | undefined;
  archived?: boolean | undefined;
  conversationKind?: ConversationKind | undefined;
  read?: boolean | undefined;
  readThrough?: string | undefined;
}

export interface ListTasksFilter {
  workspaceId?: string | undefined;
  workspaceKind?: "project" | "general" | undefined;
  ownerUserId?: string | null | undefined;
  includeDeleted?: boolean | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  taskIds?: readonly string[] | undefined;
  search?: string | undefined;
  cursor?: string | undefined;
  state?: TaskCollectionState | undefined;
}

export interface ListWorkspacesOptions {
  ownerUserId?: string | null | undefined;
  includeGeneral?: boolean | undefined;
  search?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

export interface DeleteArchivedTasksInput {
  workspaceId?: string | undefined;
  search?: string | undefined;
}

export interface AppendMessageInput {
  id?: string | undefined;
  role: MessageRole;
  parts: Array<{ kind: MessagePartKind; content: JsonValue }>;
  status?: Message["status"] | undefined;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  generationMs?: number | undefined;
}

export interface CloudTaskStore {
  createWorkspace(input: { name: string; ownerUserId?: string | null }): Promise<Workspace>;
  updateWorkspace(id: string, input: { name?: string | undefined; pinned?: boolean | undefined }, ownerUserId?: string | null): Promise<Workspace>;
  removeWorkspace(id: string, ownerUserId?: string | null): Promise<{ removed: boolean }>;
  ensureGeneralWorkspace(ownerUserId: string): Promise<Workspace>;
  listWorkspaces(filter?: ListWorkspacesOptions): Promise<Workspace[]>;
  listWorkspacePage(filter?: ListWorkspacesOptions): Promise<WorkspacePage>;
  createTask(input: CreateTaskInput): Promise<{ task: Task; session: Session }>;
  listTasks(filter?: ListTasksFilter): Promise<Task[]>;
  listTaskPage(filter?: ListTasksFilter): Promise<TaskPage>;
  taskSummary(ownerUserId?: string | null): Promise<TaskCollectionSummary>;
  deleteArchivedTasks(input: DeleteArchivedTasksInput, ownerUserId?: string | null): Promise<{ deletedCount: number }>;
  getTask(taskId: string, ownerUserId?: string | null): Promise<Task>;
  updateTask(taskId: string, input: UpdateTaskInput, ownerUserId?: string | null): Promise<Task>;
  deleteTask(taskId: string, ownerUserId?: string | null): Promise<Task>;
  restoreTask(taskId: string, ownerUserId?: string | null): Promise<Task>;
  createSession(input: { taskId: string; parentSessionId?: string | null | undefined; permissionMode?: PermissionMode | undefined; modelProviderId?: string | null | undefined; model?: string | null | undefined }): Promise<Session>;
  getSession(sessionId: string): Promise<Session>;
  updateSessionModel(sessionId: string, providerId: string, model: string): Promise<Session>;
  appendMessage(sessionId: string, input: AppendMessageInput): Promise<Message>;
  listMessages(sessionId: string): Promise<Message[]>;
  listMessagePage(sessionId: string, options?: ListMessagesOptions): Promise<MessageHistoryPage>;
  getMessage(sessionId: string, messageId: string): Promise<Message>;
  getLatestUserMessage(sessionId: string): Promise<Message | null>;
  hasCancelledMessageAfter?(sessionId: string, messageId: string): Promise<boolean>;
  getMessagePosition(sessionId: string, messageId: string): Promise<{ message: Message; userOrdinal: number }>;
  /**
   * Drop the given message and every message after it in the session
   * (insertion order). Parts cascade. Used by edit-and-resubmit to truncate
   * the UI projection back to the edited turn, mirroring the desktop host.
   */
  deleteMessagesFrom(sessionId: string, messageId: string): Promise<void>;
}

@Injectable()
export class InMemoryCloudTaskStore implements CloudTaskStore {
  readonly #workspaces = new Map<string, Workspace>();
  readonly #tasks = new Map<string, Task>();
  readonly #sessions = new Map<string, Session>();
  readonly #messages = new Map<string, Message[]>();
  readonly #messageSequences = new Map<string, Map<string, number>>();
  readonly #nextMessageSequence = new Map<string, number>();
  readonly #messageHistoryRevisions = new Map<string, number>();
  readonly #messageHistoryDeletionRevisions = new Map<string, number>();
  readonly #taskOwners = new Map<string, string | null>();

  constructor() {
    const now = nowIso();
    this.#workspaces.set(SELF_HOST_WORKSPACE_ID, WorkspaceSchema.parse({
      id: SELF_HOST_WORKSPACE_ID,
      path: "/workspace",
      name: "Default Workspace",
      workspaceKind: "project",
      ownerUserId: null,
      trustState: "trusted",
      lastOpenedAt: now,
      indexedAt: null,
      createdAt: now,
      updatedAt: now,
    }));
  }

  async createWorkspace(input: { name: string; ownerUserId?: string | null }): Promise<Workspace> {
    const now = nowIso();
    const workspace = WorkspaceSchema.parse({
      id: randomUuid(),
      path: "/workspace",
      name: input.name.trim(),
      workspaceKind: "project",
      ownerUserId: input.ownerUserId ?? null,
      trustState: "trusted",
      lastOpenedAt: now,
      indexedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    this.#workspaces.set(workspace.id, workspace);
    return workspace;
  }

  async updateWorkspace(id: string, input: { name?: string | undefined; pinned?: boolean | undefined }, ownerUserId?: string | null): Promise<Workspace> {
    const workspace = this.#workspaces.get(id);
    if (!workspace || workspace.workspaceKind !== "project" || workspace.ownerUserId !== (ownerUserId ?? null)) throw new NotFoundException(`Workspace not found: ${id}`);
    const updated = WorkspaceSchema.parse({ ...workspace, ...input, updatedAt: nowIso() });
    this.#workspaces.set(id, updated);
    return updated;
  }

  async removeWorkspace(id: string, ownerUserId?: string | null): Promise<{ removed: boolean }> {
    const workspace = this.#workspaces.get(id);
    if (!workspace || workspace.workspaceKind !== "project" || workspace.ownerUserId !== (ownerUserId ?? null)) throw new NotFoundException(`Workspace not found: ${id}`);
    this.#workspaces.delete(id);
    for (const [taskId, task] of this.#tasks) {
      if (task.workspaceId === id) this.#tasks.delete(taskId);
    }
    return { removed: true };
  }

  async ensureGeneralWorkspace(ownerUserId: string): Promise<Workspace> {
    const existing = [...this.#workspaces.values()].find((workspace) => workspace.workspaceKind === "general" && workspace.ownerUserId === ownerUserId);
    if (existing) return existing;
    const now = nowIso();
    const workspace = WorkspaceSchema.parse({
      id: randomUuid(),
      path: "/workspace/general",
      name: "Tasks",
      workspaceKind: "general",
      ownerUserId,
      trustState: "trusted",
      lastOpenedAt: now,
      indexedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    this.#workspaces.set(workspace.id, workspace);
    return workspace;
  }

  async listWorkspaces(filter: ListWorkspacesOptions = {}): Promise<Workspace[]> {
    const page = await this.listWorkspacePage({ ...filter, limit: filter.limit ?? 100 });
    const all = [...page.items];
    let cursor = page.nextCursor;
    while (cursor) {
      const next = await this.listWorkspacePage({ ...filter, cursor, limit: filter.limit ?? 100 });
      all.push(...next.items);
      cursor = next.nextCursor;
    }
    return all;
  }

  async listWorkspacePage(filter: ListWorkspacesOptions = {}): Promise<WorkspacePage> {
    const limit = boundedCollectionLimit(filter.limit);
    const cursor = parseCollectionCursor(filter.cursor);
    const rows = [...this.#workspaces.values()]
      .filter((workspace) => workspace.ownerUserId === (filter.ownerUserId ?? null))
      .filter((workspace) => workspace.workspaceKind === "project" || filter.includeGeneral === true)
      .filter((workspace) => !filter.search || workspace.name.toLocaleLowerCase().includes(filter.search.trim().toLocaleLowerCase()))
      .sort(collectionSort)
      .filter((workspace) => !cursor || isAfterCollectionCursor(workspace.updatedAt, workspace.id, cursor));
    const items = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    return { items, hasMore, nextCursor: hasMore ? encodeCollectionCursor(items.at(-1)!.updatedAt, items.at(-1)!.id) : null };
  }

  async createTask(input: CreateTaskInput): Promise<{ task: Task; session: Session }> {
    const now = nowIso();
    const workspace = input.workspaceKind === "general"
      ? await this.ensureGeneralWorkspace(requiredOwner(input.ownerUserId))
      : this.#workspaces.get(input.workspaceId ?? "");
    const workspaceId = workspace?.id ?? input.workspaceId;
    if (!workspaceId) throw new NotFoundException("Task workspace not found");
    if (workspace && workspace.ownerUserId !== input.ownerUserId) throw new NotFoundException("Task workspace not found");
    const task = TaskSchema.parse({
      id: createId("task"),
      workspaceId,
      title: input.title?.trim() || "Untitled task",
      status: "queued",
      activeSessionId: null,
      // Persist the single web task experience. The optional input remains in
      // the compatibility type so older callers can be upgraded safely.
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
      createdAt: now,
      updatedAt: now,
    });
    this.#tasks.set(task.id, task);
    this.#taskOwners.set(task.id, input.ownerUserId ?? null);
    const session = await this.createSession({
      taskId: task.id,
      permissionMode: "full-access",
      modelProviderId: input.modelProviderId ?? null,
      model: input.model ?? null,
    });
    const updatedTask = { ...task, activeSessionId: session.id, updatedAt: nowIso() };
    this.#tasks.set(task.id, TaskSchema.parse(updatedTask));
    return { task: this.#tasks.get(task.id)!, session };
  }

  async listTasks(filter: ListTasksFilter = {}): Promise<Task[]> {
    const page = await this.listTaskPage(filter);
    const all = [...page.items];
    let cursor = page.nextCursor;
    while (cursor) {
      const next = await this.listTaskPage({ ...filter, cursor });
      all.push(...next.items);
      cursor = next.nextCursor;
    }
    const offset = Math.max(0, filter.offset ?? 0);
    return all.slice(offset, filter.limit === undefined ? undefined : offset + Math.max(1, Math.min(100, filter.limit)));
  }

  async listTaskPage(filter: ListTasksFilter = {}): Promise<TaskPage> {
    const limit = boundedCollectionLimit(filter.limit);
    const cursor = parseCollectionCursor(filter.cursor);
    const state = filter.state;
    const rows = [...this.#tasks.values()]
      .filter((task) => (filter.workspaceId ? task.workspaceId === filter.workspaceId : true))
      .filter((task) => {
        const workspace = this.#workspaces.get(task.workspaceId);
        if (!workspace) return false;
        if (filter.workspaceKind && workspace?.workspaceKind !== filter.workspaceKind) return false;
        return filter.ownerUserId === undefined || workspace.ownerUserId === filter.ownerUserId;
      })
      .filter((task) => filter.ownerUserId === undefined || this.#taskOwners.get(task.id) === filter.ownerUserId)
      .filter((task) => !filter.taskIds || filter.taskIds.includes(task.id))
      .filter((task) => state === "active" ? !task.archived && task.deletedAt === null
        : state === "archived" ? task.archived && task.deletedAt === null
          : state === "deleted" ? task.deletedAt !== null
            : state === "all" ? true
              : filter.includeDeleted === true || task.deletedAt === null)
      .filter((task) => !filter.search || task.title.toLocaleLowerCase().includes(filter.search.trim().toLocaleLowerCase()))
      .sort(collectionSort)
      .filter((task) => !cursor || isAfterCollectionCursor(task.updatedAt, task.id, cursor));
    const items = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    return { items, hasMore, nextCursor: hasMore ? encodeCollectionCursor(items.at(-1)!.updatedAt, items.at(-1)!.id) : null };
  }

  async taskSummary(ownerUserId?: string | null): Promise<TaskCollectionSummary> {
    const rows = [...this.#tasks.values()].filter((task) => {
      const workspace = this.#workspaces.get(task.workspaceId);
      if (!workspace) return false;
      return (ownerUserId === undefined || this.#taskOwners.get(task.id) === ownerUserId)
        && (ownerUserId === undefined || workspace.ownerUserId === ownerUserId);
    });
    return {
      active: rows.filter((task) => !task.archived && task.deletedAt === null).length,
      archived: rows.filter((task) => task.archived && task.deletedAt === null).length,
      deleted: rows.filter((task) => task.deletedAt !== null).length,
      total: rows.length,
    };
  }

  async deleteArchivedTasks(input: DeleteArchivedTasksInput, ownerUserId?: string | null): Promise<{ deletedCount: number }> {
    const now = nowIso();
    let deletedCount = 0;
    for (const [id, task] of this.#tasks) {
      const workspace = this.#workspaces.get(task.workspaceId);
      if (!workspace) continue;
      if (!task.archived || task.deletedAt !== null) continue;
      if (ownerUserId !== undefined && this.#taskOwners.get(id) !== ownerUserId) continue;
      if (ownerUserId !== undefined && workspace.ownerUserId !== ownerUserId) continue;
      if (input.workspaceId && task.workspaceId !== input.workspaceId) continue;
      if (input.search && !task.title.toLocaleLowerCase().includes(input.search.trim().toLocaleLowerCase())) continue;
      this.#tasks.set(id, TaskSchema.parse({ ...task, deletedAt: now, updatedAt: now }));
      deletedCount += 1;
    }
    return { deletedCount };
  }

  async getTask(taskId: string, ownerUserId?: string | null): Promise<Task> {
    const task = this.#tasks.get(taskId);
    if (!task) throw new NotFoundException(`Task not found: ${taskId}`);
    const workspace = this.#workspaces.get(task.workspaceId);
    const taskOwner = this.#taskOwners.get(taskId) ?? null;
    if (ownerUserId !== undefined && (taskOwner !== ownerUserId || (workspace && workspace.ownerUserId !== ownerUserId))) {
      throw new NotFoundException(`Task not found: ${taskId}`);
    }
    return task;
  }

  async updateTask(taskId: string, input: UpdateTaskInput, ownerUserId?: string | null): Promise<Task> {
    const current = await this.getTask(taskId, ownerUserId);
    const readAt = nowIso();
    const taskMetadataChanged = input.title !== undefined
      || input.status !== undefined
      || input.pinned !== undefined
      || input.archived !== undefined;
    const updatedAt = taskMetadataChanged ? readAt : current.updatedAt;
    const becameUnread = input.status !== undefined
      && input.status !== current.status
      && (input.status === "completed" || input.status === "failed");
    const canMarkRead = input.read === true
      && (!input.readThrough || !current.unreadAt || Date.parse(current.unreadAt) <= Date.parse(input.readThrough));
    const next = TaskSchema.parse({
      ...current,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.status !== undefined ? { status: TaskStatusSchema.parse(input.status) } : {}),
      ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
      ...(input.archived !== undefined ? { archived: input.archived } : {}),
      ...(canMarkRead
        ? { unreadAt: null, lastReadAt: readAt }
        : becameUnread ? { unreadAt: readAt } : {}),
      updatedAt,
    });
    this.#tasks.set(taskId, next);
    return next;
  }

  async deleteTask(taskId: string, ownerUserId?: string | null): Promise<Task> {
    const current = await this.getTask(taskId, ownerUserId);
    const next = TaskSchema.parse({ ...current, deletedAt: nowIso(), updatedAt: nowIso() });
    this.#tasks.set(taskId, next);
    return next;
  }

  async restoreTask(taskId: string, ownerUserId?: string | null): Promise<Task> {
    const current = await this.getTask(taskId, ownerUserId);
    const next = TaskSchema.parse({ ...current, deletedAt: null, updatedAt: nowIso() });
    this.#tasks.set(taskId, next);
    return next;
  }
  async createSession(input: { taskId: string; parentSessionId?: string | null | undefined; permissionMode?: PermissionMode | undefined; modelProviderId?: string | null | undefined; model?: string | null | undefined }): Promise<Session> {
    const task = await this.getTask(input.taskId);
    const now = nowIso();
    const session = SessionSchema.parse({
      id: createId("session"),
      taskId: task.id,
      parentSessionId: input.parentSessionId ?? null,
      status: "active",
      modelProviderId: input.modelProviderId ?? null,
      model: input.model ?? null,
      permissionMode: PermissionModeSchema.parse("full-access"),
      createdAt: now,
      updatedAt: now,
    });
    this.#sessions.set(session.id, session);
    this.#messages.set(session.id, []);
    this.#messageHistoryRevisions.set(session.id, 0);
    this.#messageHistoryDeletionRevisions.set(session.id, 0);
    this.#tasks.set(task.id, TaskSchema.parse({ ...task, activeSessionId: session.id, updatedAt: now }));
    return session;
  }

  async getSession(sessionId: string): Promise<Session> {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new NotFoundException(`Session not found: ${sessionId}`);
    return session;
  }

  async updateSessionModel(sessionId: string, providerId: string, model: string): Promise<Session> {
    const current = await this.getSession(sessionId);
    const next = SessionSchema.parse({
      ...current,
      modelProviderId: providerId,
      model,
      updatedAt: nowIso(),
    });
    this.#sessions.set(sessionId, next);
    return next;
  }

  async appendMessage(sessionId: string, input: AppendMessageInput): Promise<Message> {
    await this.getSession(sessionId);
    const existing = input.id
      ? [...this.#messages.values()].flat().find((message) => message.id === input.id)
      : undefined;
    if (existing) {
      if (existing.sessionId !== sessionId) throw new ConflictException(`Message id already belongs to another session: ${input.id}`);
      return existing;
    }
    const now = nowIso();
    const messageId = input.id ?? createId("msg");
    const parts: MessagePart[] = input.parts.map((part, position) => ({
      id: createId("part"),
      messageId,
      kind: MessagePartKindSchema.parse(part.kind),
      content: part.content,
      position,
      createdAt: now,
    }));
    const message = MessageSchema.parse({
      id: messageId,
      sessionId,
      role: MessageRoleSchema.parse(input.role),
      status: input.status ?? "complete",
      parts,
      inputTokens: input.inputTokens ?? 0,
      outputTokens: input.outputTokens ?? 0,
      generationMs: input.generationMs ?? 0,
      createdAt: now,
      updatedAt: now,
    });
    this.#messages.set(sessionId, [...(this.#messages.get(sessionId) ?? []), message]);
    const sequences = this.#messageSequences.get(sessionId) ?? new Map<string, number>();
    sequences.set(messageId, this.#nextMessageSequence.get(sessionId) ?? 1);
    this.#messageSequences.set(sessionId, sequences);
    this.#nextMessageSequence.set(sessionId, (this.#nextMessageSequence.get(sessionId) ?? 1) + 1);
    return message;
  }

  async listMessages(sessionId: string): Promise<Message[]> {
    await this.getSession(sessionId);
    return [...(this.#messages.get(sessionId) ?? [])];
  }

  async getMessage(sessionId: string, messageId: string): Promise<Message> {
    await this.getSession(sessionId);
    const message = (this.#messages.get(sessionId) ?? []).find((candidate) => candidate.id === messageId);
    if (!message) throw new NotFoundException(`Message not found: ${messageId}`);
    return message;
  }

  async hasCancelledMessageAfter(sessionId: string, messageId: string): Promise<boolean> {
    await this.getSession(sessionId);
    const messages = this.#messages.get(sessionId) ?? [];
    const sequences = this.#messageSequences.get(sessionId) ?? new Map<string, number>();
    const anchor = sequences.get(messageId);
    if (anchor === undefined) return false;
    return messages.some((message) => (
      message.role !== "user"
      && message.status === "cancelled"
      && (sequences.get(message.id) ?? 0) > anchor
    ));
  }

  async getLatestUserMessage(sessionId: string): Promise<Message | null> {
    await this.getSession(sessionId);
    return [...(this.#messages.get(sessionId) ?? [])].reverse().find((message) => message.role === "user") ?? null;
  }

  async getMessagePosition(sessionId: string, messageId: string): Promise<{ message: Message; userOrdinal: number }> {
    await this.getSession(sessionId);
    const messages = this.#messages.get(sessionId) ?? [];
    const index = messages.findIndex((candidate) => candidate.id === messageId);
    if (index < 0) throw new NotFoundException(`Message not found: ${messageId}`);
    return {
      message: messages[index]!,
      userOrdinal: messages.slice(0, index + 1).filter((candidate) => candidate.role === "user").length,
    };
  }

  async listMessagePage(sessionId: string, options: ListMessagesOptions = {}): Promise<MessageHistoryPage> {
    await this.getSession(sessionId);
    if (options.before && options.after) throw new ConflictException("Only one message history cursor may be used");
    const messages = [...(this.#messages.get(sessionId) ?? [])];
    const limit = boundedMessageLimit(options.limit);
    const before = parseMessageCursor(options.before);
    const after = parseMessageCursor(options.after);
    const sequences = this.#messageSequences.get(sessionId) ?? new Map<string, number>();
    const indexed = messages.map((message, index) => ({
      message,
      sequence: BigInt(sequences.get(message.id) ?? index + 1),
    }));
    const filtered = indexed.filter(({ sequence }) =>
      (before === null || sequence < before) && (after === null || sequence > after));
    // The initial page and `before` pages are taken from the newest end;
    // `after` pages move forward from a known sequence.
    const descending = after === null;
    const selected = descending ? filtered.slice(-limit - 1).reverse() : filtered.slice(0, limit + 1);
    const page = selected.slice(0, limit);
    if (descending) page.reverse();
    const oldest = page[0]?.sequence ?? null;
    const newest = page.at(-1)?.sequence ?? null;
    // Existence is based on the retained sequence set, not on the next
    // sequence counter. Deletes leave gaps, so comparing against that counter
    // would claim that a deleted row still exists. Cursor-only empty pages also
    // need directional flags so callers can distinguish a boundary from an
    // empty session.
    const hasOlder = oldest !== null
      ? indexed.some(({ sequence }) => sequence < oldest)
      : before !== null
        ? indexed.some(({ sequence }) => sequence < before)
        : after !== null
          ? indexed.some(({ sequence }) => sequence <= after)
          : false;
    const hasNewer = newest !== null
      ? indexed.some(({ sequence }) => sequence > newest)
      : after !== null
        ? indexed.some(({ sequence }) => sequence > after)
        : before !== null
          ? indexed.some(({ sequence }) => sequence >= before)
          : false;
    const cursorPresent = before !== null
      ? indexed.some(({ sequence }) => sequence === before)
      : after !== null
        ? indexed.some(({ sequence }) => sequence === after)
        : null;
    return {
      messages: page.map(({ message }) => message),
      hasOlder,
      hasNewer,
      oldestSequence: oldest === null ? null : oldest.toString(),
      newestSequence: newest === null ? null : newest.toString(),
      cursorPresent,
      historyRevision: String(this.#messageHistoryRevisions.get(sessionId) ?? 0),
      historyDeletionRevision: String(this.#messageHistoryDeletionRevisions.get(sessionId) ?? 0),
    };
  }

  async deleteMessagesFrom(sessionId: string, messageId: string): Promise<void> {
    await this.getSession(sessionId);
    const messages = this.#messages.get(sessionId) ?? [];
    const index = messages.findIndex((message) => message.id === messageId);
    if (index === -1) return;
    this.#messages.set(sessionId, messages.slice(0, index));
    const sequences = this.#messageSequences.get(sessionId);
    if (sequences) {
      for (const message of messages.slice(index)) sequences.delete(message.id);
      this.#messageSequences.set(sessionId, sequences);
    }
    this.#messageHistoryRevisions.set(sessionId, (this.#messageHistoryRevisions.get(sessionId) ?? 0) + 1);
    this.#messageHistoryDeletionRevisions.set(sessionId, (this.#messageHistoryDeletionRevisions.get(sessionId) ?? 0) + 1);
  }
}

export class PostgresCloudTaskStore implements CloudTaskStore {
  constructor(
    private readonly database: CloudDatabaseService,
    private readonly tenantId = SELF_HOST_TENANT_ID,
  ) {}

  async createWorkspace(input: { name: string; ownerUserId?: string | null }): Promise<Workspace> {
    return this.database.withTenant(this.tenantId, async (executor) => {
      const name = input.name.trim();
      const rows = await executor.query<WorkspaceRow>(
        `
INSERT INTO workspaces (tenant_id, owner_id, workspace_kind, name, slug, trust_state, settings, created_at, updated_at)
VALUES ($1::uuid, $2::uuid, 'project', $3, $4, 'trusted', '{"cloud":true}'::jsonb, now(), now())
RETURNING id, owner_id, workspace_kind, name, trust_state, created_at, updated_at
        `.trim(),
        [this.tenantId, input.ownerUserId ?? null, name, await uniqueWorkspaceSlug(executor, this.tenantId, name)],
      );
      return workspaceFromRow(rows[0]!);
    });
  }

  async updateWorkspace(id: string, input: { name?: string | undefined; pinned?: boolean | undefined }, ownerUserId?: string | null): Promise<Workspace> {
    return this.database.withTenant(this.tenantId, async (executor) => {
      const rows = await executor.query<WorkspaceRow>(
        `
UPDATE workspaces
SET name = COALESCE($4, name),
    settings = CASE WHEN $5::boolean IS NULL THEN settings ELSE jsonb_set(settings, '{pinned}', to_jsonb($5::boolean), true) END,
    updated_at = now()
WHERE tenant_id = $1::uuid AND id = $2::uuid AND owner_id = $3::uuid
  AND workspace_kind = 'project' AND deleted_at IS NULL
RETURNING id, owner_id, workspace_kind, name, trust_state, created_at, updated_at,
          COALESCE((settings ->> 'pinned')::boolean, false) AS pinned
        `.trim(),
        [this.tenantId, id, ownerUserId ?? null, input.name, input.pinned],
      );
      if (!rows[0]) throw new NotFoundException(`Workspace not found: ${id}`);
      return workspaceFromRow(rows[0]);
    });
  }

  async removeWorkspace(id: string, ownerUserId?: string | null): Promise<{ removed: boolean }> {
    return this.database.withTenant(this.tenantId, async (executor) => {
      const rows = await executor.query<{ id: string }>(
        `UPDATE workspaces SET deleted_at = now(), updated_at = now()
         WHERE tenant_id = $1::uuid AND id = $2::uuid AND owner_id = $3::uuid
           AND workspace_kind = 'project' AND deleted_at IS NULL
         RETURNING id`,
        [this.tenantId, id, ownerUserId ?? null],
      );
      if (!rows[0]) throw new NotFoundException(`Workspace not found: ${id}`);
      await executor.execute(
        "UPDATE tasks SET deleted_at = now(), updated_at = now() WHERE tenant_id = $1::uuid AND workspace_id = $2::uuid AND user_id = $3::uuid AND deleted_at IS NULL",
        [this.tenantId, id, ownerUserId ?? null],
      );
      return { removed: true };
    });
  }

  async ensureGeneralWorkspace(ownerUserId: string): Promise<Workspace> {
    return this.database.withTenant(this.tenantId, async (executor) => {
      const existing = await executor.query<WorkspaceRow>(
        `SELECT id, owner_id, workspace_kind, name, trust_state, created_at, updated_at
         FROM workspaces
         WHERE tenant_id = $1::uuid AND owner_id = $2::uuid AND workspace_kind = 'general' AND deleted_at IS NULL
         LIMIT 1`,
        [this.tenantId, ownerUserId],
      );
      if (existing[0]) return workspaceFromRow(existing[0]);
      const rows = await executor.query<WorkspaceRow>(
        `INSERT INTO workspaces (tenant_id, owner_id, workspace_kind, name, slug, trust_state, settings, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, 'general', 'Tasks', $3, 'trusted', '{"cloud":true,"scratch":true}'::jsonb, now(), now())
         ON CONFLICT DO NOTHING
         RETURNING id, owner_id, workspace_kind, name, trust_state, created_at, updated_at`,
        [this.tenantId, ownerUserId, `general-${ownerUserId}`],
      );
      if (rows[0]) return workspaceFromRow(rows[0]);
      const [concurrent] = await executor.query<WorkspaceRow>(
        `SELECT id, owner_id, workspace_kind, name, trust_state, created_at, updated_at
         FROM workspaces
         WHERE tenant_id = $1::uuid AND owner_id = $2::uuid AND workspace_kind = 'general' AND deleted_at IS NULL
         LIMIT 1`,
        [this.tenantId, ownerUserId],
      );
      if (!concurrent) throw new NotFoundException("General workspace could not be created");
      return workspaceFromRow(concurrent);
    });
  }

  async listWorkspaces(filter: ListWorkspacesOptions = {}): Promise<Workspace[]> {
    const page = await this.listWorkspacePage({ ...filter, limit: filter.limit ?? 100 });
    const all = [...page.items];
    let cursor = page.nextCursor;
    while (cursor) {
      const next = await this.listWorkspacePage({ ...filter, cursor, limit: filter.limit ?? 100 });
      all.push(...next.items);
      cursor = next.nextCursor;
    }
    return all;
  }

  async listWorkspacePage(filter: ListWorkspacesOptions = {}): Promise<WorkspacePage> {
    return this.database.withTenant(this.tenantId, async (executor) => {
      const cursor = parseCollectionCursor(filter.cursor);
      if (cursor && !isUuid(cursor.id)) throw new ConflictException("Invalid collection cursor");
      const limit = boundedCollectionLimit(filter.limit);
      const rows = await executor.query<WorkspaceRow>(
        `
SELECT id, owner_id, workspace_kind, name, trust_state, created_at, updated_at,
       COALESCE((settings ->> 'pinned')::boolean, false) AS pinned
FROM workspaces
WHERE tenant_id = $1::uuid AND deleted_at IS NULL
  AND owner_id = $2::uuid
  AND (workspace_kind = 'project' OR $3::boolean = true)
  AND ($4::text IS NULL OR strpos(lower(name), lower($4::text)) > 0)
  AND ($5::timestamptz IS NULL OR updated_at < $5::timestamptz
       OR (updated_at = $5::timestamptz AND id > $6::uuid))
ORDER BY updated_at DESC, id ASC
LIMIT $7
        `.trim(),
        [this.tenantId, filter.ownerUserId ?? null, filter.includeGeneral === true, filter.search?.trim() || null, cursor?.updatedAt ?? null, cursor?.id ?? null, limit + 1],
      );
      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit).map(workspaceFromRow);
      return { items, hasMore, nextCursor: hasMore ? encodeCollectionCursor(items.at(-1)!.updatedAt, items.at(-1)!.id) : null };
    });
  }

  async createTask(input: CreateTaskInput): Promise<{ task: Task; session: Session }> {
    return this.database.withTenant(this.tenantId, async (executor) => {
      const now = nowIso();
      const taskId = randomUuid();
      const workspaceId = input.workspaceKind === "general"
        ? (await this.ensureGeneralWorkspace(requiredOwner(input.ownerUserId))).id
        : normalizeWorkspaceId(input.workspaceId ?? SELF_HOST_WORKSPACE_ID);
      const [workspace] = await executor.query<{ id: string }>(
        `SELECT id FROM workspaces
         WHERE tenant_id = $1::uuid AND id = $2::uuid AND deleted_at IS NULL
           AND owner_id = $3::uuid`,
        [this.tenantId, workspaceId, input.ownerUserId ?? null],
      );
      if (!workspace) throw new NotFoundException(`Workspace not found: ${workspaceId}`);
      await executor.execute(
        `
INSERT INTO tasks (id, tenant_id, workspace_id, user_id, title, status, conversation_kind, created_at, updated_at)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'queued', $6::conversation_kind, $7, $7)
        `.trim(),
        [taskId, this.tenantId, workspaceId, input.ownerUserId ?? null, input.title?.trim() || "Untitled task", "chat", now],
      );
      const session = await this.createSessionInTenant(executor, {
        taskId,
        permissionMode: "full-access",
        modelProviderId: input.modelProviderId ?? null,
        model: input.model ?? null,
        ownerUserId: input.ownerUserId ?? null,
      });
      await executor.execute(
        "UPDATE tasks SET active_session_id = $2::uuid, updated_at = $3 WHERE tenant_id = $1::uuid AND id = $4::uuid",
        [this.tenantId, session.id, nowIso(), taskId],
      );
      return { task: await this.getTaskInTenant(executor, taskId, input.ownerUserId), session };
    });
  }

  async listTasks(filter: ListTasksFilter = {}): Promise<Task[]> {
    const page = await this.listTaskPage(filter);
    const all = [...page.items];
    let cursor = page.nextCursor;
    while (cursor) {
      const next = await this.listTaskPage({ ...filter, cursor });
      all.push(...next.items);
      cursor = next.nextCursor;
    }
    const offset = Math.max(0, filter.offset ?? 0);
    return all.slice(offset, filter.limit === undefined ? undefined : offset + Math.max(1, Math.min(100, filter.limit)));
  }

  async listTaskPage(filter: ListTasksFilter = {}): Promise<TaskPage> {
    return this.database.withTenant(this.tenantId, async (executor) => {
      const workspaceId = filter.workspaceId ? normalizeWorkspaceId(filter.workspaceId) : null;
      const cursor = parseCollectionCursor(filter.cursor);
      if (cursor && !isUuid(cursor.id)) throw new ConflictException("Invalid collection cursor");
      const limit = boundedCollectionLimit(filter.limit);
      const rows = await executor.query<TaskRow>(
        `
SELECT t.id, t.workspace_id, t.title, t.status, t.active_session_id, t.conversation_kind,
       t.pinned, t.archived, t.deleted_at, t.unread_at, t.last_read_at, t.worktree_path, t.worktree_branch,
       t.worktree_base_ref, t.worktree_base_sha, t.pull_request_url, t.pull_request_number, t.created_at, t.updated_at
FROM tasks t
JOIN workspaces w ON w.id = t.workspace_id AND w.tenant_id = t.tenant_id
WHERE t.tenant_id = $1::uuid
  AND ($2::uuid IS NULL OR t.workspace_id = $2::uuid)
  AND ($3::workspace_kind IS NULL OR w.workspace_kind = $3::workspace_kind)
  AND w.owner_id = $4::uuid
  AND t.user_id = $4::uuid
  AND ($5::text[] IS NULL OR t.id::text = ANY($5::text[]))
  AND ($6::text IS NULL OR strpos(lower(t.title), lower($6::text)) > 0)
  AND (
    $7::text IS NULL AND ($8::boolean = true OR t.deleted_at IS NULL)
    OR $7::text = 'active' AND t.archived = false AND t.deleted_at IS NULL
    OR $7::text = 'archived' AND t.archived = true AND t.deleted_at IS NULL
    OR $7::text = 'deleted' AND t.deleted_at IS NOT NULL
    OR $7::text = 'all'
  )
  AND ($9::timestamptz IS NULL OR t.updated_at < $9::timestamptz
       OR (t.updated_at = $9::timestamptz AND t.id > $10::uuid))
ORDER BY t.updated_at DESC, t.id ASC
LIMIT $11
        `.trim(),
        [this.tenantId, workspaceId, filter.workspaceKind ?? null, filter.ownerUserId ?? null, filter.taskIds ? [...new Set(filter.taskIds)] : null, filter.search?.trim() || null, filter.state ?? null, filter.includeDeleted === true, cursor?.updatedAt ?? null, cursor?.id ?? null, limit + 1],
      );
      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit).map(taskFromRow);
      return { items, hasMore, nextCursor: hasMore ? encodeCollectionCursor(items.at(-1)!.updatedAt, items.at(-1)!.id) : null };
    });
  }

  async taskSummary(ownerUserId?: string | null): Promise<TaskCollectionSummary> {
    return this.database.withTenant(this.tenantId, async (executor) => {
      const [row] = await executor.query<{ active: number | string; archived: number | string; deleted: number | string; total: number | string }>(
        `SELECT
          count(*) FILTER (WHERE t.archived = false AND t.deleted_at IS NULL) AS active,
          count(*) FILTER (WHERE t.archived = true AND t.deleted_at IS NULL) AS archived,
          count(*) FILTER (WHERE t.deleted_at IS NOT NULL) AS deleted,
          count(*) AS total
         FROM tasks t JOIN workspaces w ON w.id = t.workspace_id AND w.tenant_id = t.tenant_id
         WHERE t.tenant_id = $1::uuid AND w.owner_id = $2::uuid AND t.user_id = $2::uuid`,
        [this.tenantId, ownerUserId ?? null],
      );
      return { active: Number(row?.active ?? 0), archived: Number(row?.archived ?? 0), deleted: Number(row?.deleted ?? 0), total: Number(row?.total ?? 0) };
    });
  }

  async deleteArchivedTasks(input: DeleteArchivedTasksInput, ownerUserId?: string | null): Promise<{ deletedCount: number }> {
    return this.database.withTenant(this.tenantId, async (executor) => {
      const workspaceId = input.workspaceId ? normalizeWorkspaceId(input.workspaceId) : null;
      const rows = await executor.query<{ id: string }>(
        `UPDATE tasks t
         SET deleted_at = now(), updated_at = now()
         FROM workspaces w
         WHERE t.tenant_id = $1::uuid AND t.workspace_id = w.id AND w.tenant_id = t.tenant_id
           AND w.owner_id = $2::uuid AND t.user_id = $2::uuid
           AND t.archived = true AND t.deleted_at IS NULL
           AND ($3::uuid IS NULL OR t.workspace_id = $3::uuid)
           AND ($4::text IS NULL OR strpos(lower(t.title), lower($4::text)) > 0)
         RETURNING t.id`,
        [this.tenantId, ownerUserId ?? null, workspaceId, input.search?.trim() || null],
      );
      return { deletedCount: rows.length };
    });
  }

  async getTask(taskId: string, ownerUserId?: string | null): Promise<Task> {
    return this.database.withTenant(this.tenantId, (executor) => this.getTaskInTenant(executor, taskId, ownerUserId));
  }

  async updateTask(taskId: string, input: UpdateTaskInput, ownerUserId?: string | null): Promise<Task> {
    return this.database.withTenant(this.tenantId, async (executor) => {
      await this.getTaskInTenant(executor, taskId, ownerUserId);
      await executor.execute(
        `
UPDATE tasks
SET title = COALESCE($3, title),
    status = COALESCE($4::task_status, status),
    pinned = COALESCE($5, pinned),
    archived = COALESCE($6, archived),
    unread_at = CASE
      WHEN $7::boolean AND ($8::timestamptz IS NULL OR unread_at IS NULL OR unread_at <= $8::timestamptz) THEN NULL
      WHEN $4::task_status IN ('completed', 'failed') AND status IS DISTINCT FROM $4::task_status THEN $9
      ELSE unread_at
    END,
    last_read_at = CASE
      WHEN $7::boolean AND ($8::timestamptz IS NULL OR unread_at IS NULL OR unread_at <= $8::timestamptz) THEN $9
      ELSE last_read_at
    END,
    updated_at = CASE
      WHEN $3 IS NOT NULL OR $4 IS NOT NULL OR $5 IS NOT NULL OR $6 IS NOT NULL THEN $9
      ELSE updated_at
    END
WHERE tenant_id = $1::uuid AND id = $2::uuid AND ($10::uuid IS NULL OR user_id IS NULL OR user_id = $10::uuid)
        `.trim(),
        [this.tenantId, taskId, input.title, input.status, input.pinned, input.archived, input.read === true, input.readThrough ?? null, nowIso(), ownerUserId ?? null],
      );
      return this.getTaskInTenant(executor, taskId, ownerUserId);
    });
  }

  async deleteTask(taskId: string, ownerUserId?: string | null): Promise<Task> {
    return this.database.withTenant(this.tenantId, async (executor) => {
      await this.getTaskInTenant(executor, taskId, ownerUserId);
      await executor.execute(
        "UPDATE tasks SET deleted_at = $3, updated_at = $3 WHERE tenant_id = $1::uuid AND id = $2::uuid AND ($4::uuid IS NULL OR user_id IS NULL OR user_id = $4::uuid)",
        [this.tenantId, taskId, nowIso(), ownerUserId ?? null],
      );
      return this.getTaskInTenant(executor, taskId, ownerUserId);
    });
  }

  async restoreTask(taskId: string, ownerUserId?: string | null): Promise<Task> {
    return this.database.withTenant(this.tenantId, async (executor) => {
      await this.getTaskInTenant(executor, taskId, ownerUserId);
      await executor.execute(
        "UPDATE tasks SET deleted_at = NULL, updated_at = $3 WHERE tenant_id = $1::uuid AND id = $2::uuid AND ($4::uuid IS NULL OR user_id IS NULL OR user_id = $4::uuid)",
        [this.tenantId, taskId, nowIso(), ownerUserId ?? null],
      );
      return this.getTaskInTenant(executor, taskId, ownerUserId);
    });
  }

  async createSession(input: { taskId: string; parentSessionId?: string | null | undefined; permissionMode?: PermissionMode | undefined; modelProviderId?: string | null | undefined; model?: string | null | undefined }): Promise<Session> {
    return this.database.withTenant(this.tenantId, async (executor) => {
      const session = await this.createSessionInTenant(executor, input);
      await executor.execute(
        "UPDATE tasks SET active_session_id = $3::uuid, updated_at = $4 WHERE tenant_id = $1::uuid AND id = $2::uuid",
        [this.tenantId, input.taskId, session.id, nowIso()],
      );
      return session;
    });
  }

  async getSession(sessionId: string): Promise<Session> {
    return this.database.withTenant(this.tenantId, (executor) => this.getSessionInTenant(executor, sessionId));
  }

  async updateSessionModel(sessionId: string, providerId: string, model: string): Promise<Session> {
    return this.database.withTenant(this.tenantId, async (executor) => {
      const rows = await executor.query<SessionRow>(
        `UPDATE sessions
         SET model_provider_id=$3,model=$4,updated_at=now()
         WHERE tenant_id=$1::uuid AND id=$2::uuid
         RETURNING id,task_id,parent_session_id,status,model_provider_id,model,permission_mode,created_at,updated_at`,
        [this.tenantId, sessionId, providerId, model],
      );
      if (!rows[0]) throw new NotFoundException(`Session not found: ${sessionId}`);
      return sessionFromRow(rows[0]);
    });
  }

  async appendMessage(sessionId: string, input: AppendMessageInput): Promise<Message> {
    return this.database.withTenant(this.tenantId, async (executor) => {
      const session = await this.getSessionInTenant(executor, sessionId);
      const now = nowIso();
      const messageId = input.id ?? randomUuid();
      const inserted = await executor.query<{ id: string }>(
        `
INSERT INTO messages (id, tenant_id, session_id, task_id, role, status, input_tokens, output_tokens, generation_ms, created_at, updated_at)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::message_role, $6::message_status, $7, $8, $9, $10, $10)
ON CONFLICT (id) DO NOTHING
RETURNING id
        `.trim(),
        [
          messageId,
          this.tenantId,
          sessionId,
          session.taskId,
          MessageRoleSchema.parse(input.role),
          input.status ?? "complete",
          input.inputTokens ?? 0,
          input.outputTokens ?? 0,
          input.generationMs ?? 0,
          now,
        ],
      );
      if (inserted.length === 0) {
        const existing = await this.getMessageInTenant(executor, messageId);
        if (existing.sessionId !== sessionId) throw new ConflictException(`Message id already belongs to another session: ${messageId}`);
        return existing;
      }
      for (const [position, part] of input.parts.entries()) {
        await executor.execute(
          `
INSERT INTO message_parts (id, tenant_id, message_id, type, content, ordinal, created_at)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4::message_part_kind, $5::jsonb, $6, $7)
          `.trim(),
          [randomUuid(), this.tenantId, messageId, MessagePartKindSchema.parse(part.kind), JSON.stringify(part.content), position, now],
        );
      }
      return this.getMessageInTenant(executor, messageId);
    });
  }

  async listMessages(sessionId: string): Promise<Message[]> {
    return this.database.withTenant(this.tenantId, async (executor) => {
      await this.getSessionInTenant(executor, sessionId);
      const rows = await executor.query<MessageRow>(
        `
SELECT id, session_id, sequence_id, role, status, input_tokens, output_tokens, generation_ms, created_at, updated_at
FROM messages
WHERE tenant_id = $1::uuid AND session_id = $2::uuid
ORDER BY sequence_id ASC
        `.trim(),
        [this.tenantId, sessionId],
      );
      return this.messagesFromRows(executor, rows);
    });
  }

  async getMessage(sessionId: string, messageId: string): Promise<Message> {
    return this.database.withTenant(this.tenantId, async (executor) => {
      await this.getSessionInTenant(executor, sessionId);
      const [row] = await executor.query<MessageRow>(
        `
SELECT id, session_id, sequence_id, role, status, input_tokens, output_tokens, generation_ms, created_at, updated_at
FROM messages
WHERE tenant_id = $1::uuid AND session_id = $2::uuid AND id = $3::uuid
        `.trim(),
        [this.tenantId, sessionId, messageId],
      );
      if (!row) throw new NotFoundException(`Message not found: ${messageId}`);
      return this.messageFromRow(executor, row);
    });
  }

  async hasCancelledMessageAfter(sessionId: string, messageId: string): Promise<boolean> {
    return this.database.withTenant(this.tenantId, async (executor) => {
      await this.getSessionInTenant(executor, sessionId);
      const [row] = await executor.query<{ exists: boolean }>(
        `SELECT EXISTS(
           SELECT 1
           FROM messages anchor
           JOIN messages cancelled
             ON cancelled.tenant_id = anchor.tenant_id
            AND cancelled.session_id = anchor.session_id
            AND cancelled.sequence_id > anchor.sequence_id
           WHERE anchor.tenant_id = $1::uuid AND anchor.session_id = $2::uuid
             AND anchor.id = $3::uuid
             AND cancelled.role <> 'user'::message_role
             AND cancelled.status = 'cancelled'::message_status
         ) AS exists`,
        [this.tenantId, sessionId, messageId],
      );
      return Boolean(row?.exists);
    });
  }

  async getLatestUserMessage(sessionId: string): Promise<Message | null> {
    return this.database.withTenant(this.tenantId, async (executor) => {
      await this.getSessionInTenant(executor, sessionId);
      const [row] = await executor.query<MessageRow>(
        `
SELECT id, session_id, sequence_id, role, status, input_tokens, output_tokens, generation_ms, created_at, updated_at
FROM messages
WHERE tenant_id = $1::uuid AND session_id = $2::uuid AND role = 'user'::message_role
ORDER BY sequence_id DESC
LIMIT 1
        `.trim(),
        [this.tenantId, sessionId],
      );
      return row ? this.messageFromRow(executor, row) : null;
    });
  }

  async getMessagePosition(sessionId: string, messageId: string): Promise<{ message: Message; userOrdinal: number }> {
    return this.database.withTenant(this.tenantId, async (executor) => {
      await this.getSessionInTenant(executor, sessionId);
      const [row] = await executor.query<MessageRow & { user_ordinal: string | number }>(
        `
SELECT m.id, m.session_id, m.sequence_id, m.role, m.status, m.input_tokens, m.output_tokens, m.generation_ms, m.created_at, m.updated_at,
       (SELECT COUNT(*) FROM messages prior
        WHERE prior.tenant_id = m.tenant_id AND prior.session_id = m.session_id
          AND prior.role = 'user'::message_role AND prior.sequence_id <= m.sequence_id) AS user_ordinal
FROM messages m
WHERE m.tenant_id = $1::uuid AND m.session_id = $2::uuid AND m.id = $3::uuid
        `.trim(),
        [this.tenantId, sessionId, messageId],
      );
      if (!row) throw new NotFoundException(`Message not found: ${messageId}`);
      return { message: await this.messageFromRow(executor, row), userOrdinal: Number(row.user_ordinal) };
    });
  }

  async listMessagePage(sessionId: string, options: ListMessagesOptions = {}): Promise<MessageHistoryPage> {
    return this.database.withTenant(this.tenantId, async (executor) => {
      await this.getSessionInTenant(executor, sessionId);
      if (options.before !== undefined && options.after !== undefined) {
        throw new ConflictException("Only one message history cursor may be used");
      }
      const limit = boundedMessageLimit(options.limit);
      const before = validateMessageCursor(options.before);
      const after = validateMessageCursor(options.after);
      const descending = after === null;
      const rows = await executor.query<MessageRow>(
        `
SELECT id, session_id, sequence_id, role, status, input_tokens, output_tokens, generation_ms, created_at, updated_at
FROM messages
WHERE tenant_id = $1::uuid AND session_id = $2::uuid
  AND ($3::bigint IS NULL OR sequence_id < $3::bigint)
  AND ($4::bigint IS NULL OR sequence_id > $4::bigint)
ORDER BY sequence_id ${descending ? "DESC" : "ASC"}
LIMIT $5
FOR SHARE
        `.trim(),
        [this.tenantId, sessionId, before, after, limit + 1],
      );
      const hasMoreInDirection = rows.length > limit;
      const pageRows = rows.slice(0, limit);
      if (descending) pageRows.reverse();
      const messages = await this.messagesFromRows(executor, pageRows);
      // Read the revision after the locked rows and their batched parts. A
      // concurrent delete therefore either waits on FOR SHARE or is reflected
      // in the revision returned to the client.
      const [sessionRevision] = await executor.query<{ message_history_revision: string; message_history_deletion_revision: string }>(
        `SELECT message_history_revision, message_history_deletion_revision
         FROM sessions
         WHERE tenant_id = $1::uuid AND id = $2::uuid`,
        [this.tenantId, sessionId],
      );
      const oldest = pageRows[0]?.sequence_id;
      const newest = pageRows.at(-1)?.sequence_id;
      const newerAnchor = newest ?? (before === null ? null : before);
      const olderAnchor = oldest ?? (after === null ? null : after);
      const newerOperator = newest === undefined && before !== null ? ">=" : ">";
      const olderOperator = oldest === undefined && after !== null ? "<=" : "<";
      const [newerCheck, olderCheck] = await Promise.all([
        newerAnchor === null ? Promise.resolve([{ exists: false }]) : executor.query<{ exists: boolean }>(
          `SELECT EXISTS(
             SELECT 1 FROM messages
             WHERE tenant_id = $1::uuid AND session_id = $2::uuid AND sequence_id ${newerOperator} $3::bigint
           ) AS exists`,
          [this.tenantId, sessionId, newerAnchor],
        ),
        olderAnchor === null ? Promise.resolve([{ exists: false }]) : executor.query<{ exists: boolean }>(
          `SELECT EXISTS(
             SELECT 1 FROM messages
             WHERE tenant_id = $1::uuid AND session_id = $2::uuid AND sequence_id ${olderOperator} $3::bigint
           ) AS exists`,
          [this.tenantId, sessionId, olderAnchor],
        ),
      ]);
      const [cursorCheck] = after === null && before === null
        ? [{ exists: false }]
        : await executor.query<{ exists: boolean }>(
          `SELECT EXISTS(
             SELECT 1 FROM messages
             WHERE tenant_id = $1::uuid AND session_id = $2::uuid AND sequence_id = $3::bigint
           ) AS exists`,
          [this.tenantId, sessionId, before ?? after],
        );
      return {
        messages,
        hasOlder: Boolean(olderCheck[0]?.exists) || (descending && hasMoreInDirection),
        hasNewer: Boolean(newerCheck[0]?.exists) || (!descending && hasMoreInDirection),
        oldestSequence: oldest === undefined ? null : String(oldest),
        newestSequence: newest === undefined ? null : String(newest),
        cursorPresent: before === null && after === null ? null : Boolean(cursorCheck?.exists),
        historyRevision: sessionRevision?.message_history_revision == null ? "0" : String(sessionRevision.message_history_revision),
        historyDeletionRevision: sessionRevision?.message_history_deletion_revision == null ? "0" : String(sessionRevision.message_history_deletion_revision),
      };
    });
  }

  async deleteMessagesFrom(sessionId: string, messageId: string): Promise<void> {
    await this.database.withTenant(this.tenantId, async (executor) => {
      await this.getSessionInTenant(executor, sessionId);
      const affectedFiles = await executor.query<{ file_id: string }>(`
        SELECT DISTINCT association.file_id
        FROM file_associations association
        JOIN messages message
          ON message.tenant_id = association.tenant_id
         AND message.id = association.message_id
        WHERE message.tenant_id = $1::uuid AND message.session_id = $2::uuid
          AND message.sequence_id >= (
            SELECT sequence_id FROM messages
            WHERE tenant_id = $1::uuid AND session_id = $2::uuid AND id = $3::uuid
          )
        ORDER BY association.file_id
      `, [this.tenantId, sessionId, messageId]);
      // sequence_id is the canonical insertion order, including messages
      // written within the same timestamp millisecond.
      await executor.execute(
        `
DELETE FROM messages
WHERE tenant_id = $1::uuid AND session_id = $2::uuid
  AND sequence_id >= (
    SELECT sequence_id FROM messages
    WHERE tenant_id = $1::uuid AND session_id = $2::uuid AND id = $3::uuid
  )
        `.trim(),
        [this.tenantId, sessionId, messageId],
      );
      for (const { file_id: fileId } of affectedFiles) {
        await garbageCollectFileIfUnreferenced(executor, this.tenantId, fileId);
      }
    });
  }

  private async getTaskInTenant(executor: SqlExecutor, taskId: string, ownerUserId?: string | null): Promise<Task> {
    const [row] = await executor.query<TaskRow>(
      `
SELECT t.id, t.workspace_id, t.title, t.status, t.active_session_id, t.conversation_kind,
       t.pinned, t.archived, t.deleted_at, t.unread_at, t.last_read_at, t.worktree_path, t.worktree_branch,
       t.worktree_base_ref, t.worktree_base_sha, t.pull_request_url, t.pull_request_number, t.created_at, t.updated_at
FROM tasks t
JOIN workspaces w ON w.id = t.workspace_id AND w.tenant_id = t.tenant_id
WHERE t.tenant_id = $1::uuid AND t.id = $2::uuid
  AND ($3::uuid IS NULL OR (t.user_id = $3::uuid AND w.owner_id = $3::uuid))
      `.trim(),
      [this.tenantId, taskId, ownerUserId ?? null],
    );
    if (!row) throw new NotFoundException(`Task not found: ${taskId}`);
    return taskFromRow(row);
  }

  private async createSessionInTenant(executor: SqlExecutor, input: { taskId: string; parentSessionId?: string | null | undefined; permissionMode?: PermissionMode | undefined; modelProviderId?: string | null | undefined; model?: string | null | undefined; ownerUserId?: string | null | undefined }): Promise<Session> {
    await this.getTaskInTenant(executor, input.taskId, input.ownerUserId);
    const now = nowIso();
    const sessionId = randomUuid();
    await executor.execute(
      `
INSERT INTO sessions (id, tenant_id, task_id, parent_session_id, user_id, status, model_provider_id, model, permission_mode, created_at, updated_at)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'active', $6, $7, $8::permission_mode, $9, $9)
      `.trim(),
      [sessionId, this.tenantId, input.taskId, input.parentSessionId ?? null, input.ownerUserId ?? null, input.modelProviderId ?? null, input.model ?? null, PermissionModeSchema.parse("full-access"), now],
    );
    return this.getSessionInTenant(executor, sessionId);
  }

  private async getSessionInTenant(executor: SqlExecutor, sessionId: string): Promise<Session> {
    const [row] = await executor.query<SessionRow>(
      `
SELECT id, task_id, parent_session_id, status, model_provider_id, model, permission_mode, created_at, updated_at
FROM sessions
WHERE tenant_id = $1::uuid AND id = $2::uuid
      `.trim(),
      [this.tenantId, sessionId],
    );
    if (!row) throw new NotFoundException(`Session not found: ${sessionId}`);
    return sessionFromRow(row);
  }

  private async getMessageInTenant(executor: SqlExecutor, messageId: string): Promise<Message> {
    const [row] = await executor.query<MessageRow>(
      `
SELECT id, session_id, sequence_id, role, status, input_tokens, output_tokens, generation_ms, created_at, updated_at
FROM messages
WHERE tenant_id = $1::uuid AND id = $2::uuid
      `.trim(),
      [this.tenantId, messageId],
    );
    if (!row) throw new NotFoundException(`Message not found: ${messageId}`);
    return this.messageFromRow(executor, row);
  }

  private async messageFromRow(executor: SqlExecutor, row: MessageRow): Promise<Message> {
    const parts = await executor.query<MessagePartRow>(
      `
SELECT id, message_id, type, content, ordinal, created_at
FROM message_parts
WHERE tenant_id = $1::uuid AND message_id = $2::uuid
ORDER BY ordinal ASC
      `.trim(),
      [this.tenantId, row.id],
    );
    return MessageSchema.parse({
      id: row.id,
      sessionId: row.session_id,
      role: row.role,
      status: row.status,
      parts: parts.map((part) => ({
        id: part.id,
        messageId: part.message_id,
        kind: part.type,
        content: part.content as JsonValue,
        position: part.ordinal,
        createdAt: iso(part.created_at),
      })),
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      generationMs: row.generation_ms,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    });
  }

  private async messagesFromRows(executor: SqlExecutor, rows: readonly MessageRow[]): Promise<Message[]> {
    if (rows.length === 0) return [];
    const messageIds = rows.map((row) => row.id);
    const parts = await executor.query<MessagePartRow>(
      `
SELECT id, message_id, type, content, ordinal, created_at
FROM message_parts
WHERE tenant_id = $1::uuid AND message_id = ANY($2::uuid[])
ORDER BY message_id ASC, ordinal ASC
      `.trim(),
      [this.tenantId, messageIds],
    );
    const partsByMessage = new Map<string, MessagePartRow[]>();
    for (const part of parts) {
      const messageParts = partsByMessage.get(part.message_id) ?? [];
      messageParts.push(part);
      partsByMessage.set(part.message_id, messageParts);
    }
    return rows.map((row) => messageFromRowParts(row, partsByMessage.get(row.id) ?? []));
  }
}

function boundedMessageLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return MESSAGE_HISTORY_DEFAULT_LIMIT;
  return Math.max(1, Math.min(MESSAGE_HISTORY_MAX_LIMIT, Math.floor(limit!)));
}

const COLLECTION_MAX_LIMIT = 100;
type CollectionCursor = { updatedAt: string; id: string };

function boundedCollectionLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return 50;
  return Math.max(1, Math.min(COLLECTION_MAX_LIMIT, Math.floor(limit!)));
}

function encodeCollectionCursor(updatedAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ updatedAt, id }), "utf8").toString("base64url");
}

function parseCollectionCursor(cursor: string | undefined): CollectionCursor | null {
  if (cursor === undefined) return null;
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(cursor)) throw new ConflictException("Invalid collection cursor");
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<CollectionCursor>;
    if (typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt)) || typeof value.id !== "string" || value.id.length < 1 || value.id.length > 128) {
      throw new Error("invalid cursor payload");
    }
    return { updatedAt: new Date(value.updatedAt).toISOString(), id: value.id };
  } catch {
    throw new ConflictException("Invalid collection cursor");
  }
}

function isAfterCollectionCursor(updatedAt: string, id: string, cursor: CollectionCursor): boolean {
  return updatedAt < cursor.updatedAt || (updatedAt === cursor.updatedAt && id > cursor.id);
}

function collectionSort<T extends { updatedAt: string; id: string }>(left: T, right: T): number {
  return right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id);
}

function parseMessageCursor(cursor: string | undefined): bigint | null {
  if (cursor === undefined) return null;
  if (!/^[1-9]\d*$/.test(cursor)) throw new ConflictException("Invalid message history cursor");
  const value = BigInt(cursor);
  if (value > BigInt(MESSAGE_HISTORY_MAX_CURSOR)) throw new ConflictException("Message history cursor is too large");
  return value;
}

function validateMessageCursor(cursor: string | undefined): string | null {
  if (cursor === undefined) return null;
  if (!/^[1-9]\d*$/.test(cursor)) throw new ConflictException("Invalid message history cursor");
  if (BigInt(cursor) > BigInt(MESSAGE_HISTORY_MAX_CURSOR)) {
    throw new ConflictException("Message history cursor is too large");
  }
  return cursor;
}

interface TaskRow {
  id: string;
  workspace_id: string;
  title: string;
  status: string;
  active_session_id: string | null;
  conversation_kind: string;
  pinned: boolean;
  archived: boolean;
  deleted_at: Date | string | null;
  unread_at: Date | string | null;
  last_read_at: Date | string | null;
  worktree_path: string | null;
  worktree_branch: string | null;
  worktree_base_ref: string | null;
  worktree_base_sha: string | null;
  pull_request_url: string | null;
  pull_request_number: number | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface WorkspaceRow {
  id: string;
  owner_id: string | null;
  workspace_kind: string;
  name: string;
  trust_state: string;
  created_at: Date | string;
  updated_at: Date | string;
  pinned?: boolean;
}

interface SessionRow {
  id: string;
  task_id: string;
  parent_session_id: string | null;
  status: string;
  model_provider_id: string | null;
  model: string | null;
  permission_mode: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface MessageRow {
  id: string;
  session_id: string;
  sequence_id: number | string;
  role: string;
  status: string;
  input_tokens: number;
  output_tokens: number;
  generation_ms: number;
  created_at: Date | string;
  updated_at: Date | string;
}

interface MessagePartRow {
  id: string;
  message_id: string;
  type: string;
  content: unknown;
  ordinal: number;
  created_at: Date | string;
}

function messageFromRowParts(row: MessageRow, parts: MessagePartRow[]): Message {
  return MessageSchema.parse({
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    status: row.status,
    parts: parts.map((part) => ({
      id: part.id,
      messageId: part.message_id,
      kind: part.type,
      content: part.content as JsonValue,
      position: part.ordinal,
      createdAt: iso(part.created_at),
    })),
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    generationMs: row.generation_ms,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

function taskFromRow(row: TaskRow): Task {
  return normalizeTaskForWeb({
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    status: TaskStatusSchema.parse(row.status),
    activeSessionId: row.active_session_id,
    conversationKind: row.conversation_kind,
    pinned: row.pinned,
    archived: row.archived,
    deletedAt: isoNullable(row.deleted_at),
    unreadAt: isoNullable(row.unread_at),
    lastReadAt: isoNullable(row.last_read_at),
    worktreePath: row.worktree_path,
    worktreeBranch: row.worktree_branch,
    worktreeBaseRef: row.worktree_base_ref,
    worktreeBaseSha: row.worktree_base_sha,
    pullRequestUrl: row.pull_request_url,
    pullRequestNumber: row.pull_request_number,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

function workspaceFromRow(row: WorkspaceRow): Workspace {
  return WorkspaceSchema.parse({
    id: row.id,
    path: "/workspace",
    name: row.name,
    workspaceKind: row.workspace_kind,
    ownerUserId: row.owner_id,
    trustState: row.trust_state,
    lastOpenedAt: iso(row.updated_at),
    indexedAt: null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    pinned: row.pinned ?? false,
  });
}

async function uniqueWorkspaceSlug(executor: SqlExecutor, tenantId: string, name: string): Promise<string> {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "project";
  const rows = await executor.query<{ slug: string }>("SELECT slug FROM workspaces WHERE tenant_id = $1::uuid AND slug LIKE $2", [tenantId, `${base}%`]);
  const existing = new Set(rows.map((row) => row.slug));
  if (!existing.has(base)) return base;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${base}-${randomUuid().slice(0, 8)}`;
}

function sessionFromRow(row: SessionRow): Session {
  return SessionSchema.parse({
    id: row.id,
    taskId: row.task_id,
    parentSessionId: row.parent_session_id,
    status: SessionStatusSchema.parse(row.status),
    modelProviderId: row.model_provider_id,
    model: row.model,
    permissionMode: PermissionModeSchema.parse(row.permission_mode),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

export function normalizeWorkspaceId(workspaceId: string): string {
  return isUuid(workspaceId) ? workspaceId : SELF_HOST_WORKSPACE_ID;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function randomUuid(): string {
  return crypto.randomUUID();
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isoNullable(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

function requiredOwner(ownerUserId: string | null | undefined): string {
  if (!ownerUserId) throw new NotFoundException("A signed-in user is required for General tasks");
  return ownerUserId;
}
