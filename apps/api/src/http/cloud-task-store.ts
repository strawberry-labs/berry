import { Injectable, NotFoundException } from "@nestjs/common";
import {
  createId,
  ConversationKindSchema,
  MessagePartKindSchema,
  MessageRoleSchema,
  MessageSchema,
  nowIso,
  PermissionModeSchema,
  QueuedFollowUpSchema,
  SessionStatusSchema,
  SessionSchema,
  TaskSchema,
  TaskStatusSchema,
  type JsonValue,
  type Message,
  type MessagePart,
  type MessagePartKind,
  type MessageRole,
  type PermissionMode,
  type AttachmentInput,
  type QueuedFollowUp,
  type ConversationKind,
  type Session,
  type Task,
  type TaskStatus,
  WorkspaceSchema,
  type Workspace,
} from "@berry/shared";
import { SELF_HOST_TENANT_ID, SELF_HOST_WORKSPACE_ID } from "@berry/db";
import { CloudDatabaseService, type SqlExecutor } from "../db/cloud-database.service.ts";

export const CLOUD_TASK_STORE = Symbol("CLOUD_TASK_STORE");

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
}

export interface AppendMessageInput {
  role: MessageRole;
  parts: Array<{ kind: MessagePartKind; content: JsonValue }>;
}

export interface CloudTaskStore {
  createWorkspace(input: { name: string; ownerUserId?: string | null }): Promise<Workspace>;
  ensureGeneralWorkspace(ownerUserId: string): Promise<Workspace>;
  listWorkspaces(filter?: { ownerUserId?: string | null; includeGeneral?: boolean }): Promise<Workspace[]>;
  createTask(input: CreateTaskInput): Promise<{ task: Task; session: Session }>;
  listTasks(filter?: { workspaceId?: string; workspaceKind?: "project" | "general"; ownerUserId?: string | null; includeDeleted?: boolean; limit?: number; offset?: number }): Promise<Task[]>;
  getTask(taskId: string, ownerUserId?: string | null): Promise<Task>;
  updateTask(taskId: string, input: UpdateTaskInput, ownerUserId?: string | null): Promise<Task>;
  deleteTask(taskId: string, ownerUserId?: string | null): Promise<Task>;
  restoreTask(taskId: string, ownerUserId?: string | null): Promise<Task>;
  createFollowUp(input: { taskId: string; sessionId: string; input: string; attachments?: AttachmentInput[] }, ownerUserId?: string | null): Promise<QueuedFollowUp>;
  listFollowUps(sessionId: string, ownerUserId?: string | null): Promise<QueuedFollowUp[]>;
  updateFollowUp(id: string, input: { status: QueuedFollowUp["status"]; error?: string | null }, ownerUserId?: string | null): Promise<QueuedFollowUp>;
  createSession(input: { taskId: string; parentSessionId?: string | null | undefined; permissionMode?: PermissionMode | undefined }): Promise<Session>;
  getSession(sessionId: string): Promise<Session>;
  appendMessage(sessionId: string, input: AppendMessageInput): Promise<Message>;
  listMessages(sessionId: string): Promise<Message[]>;
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
  readonly #taskOwners = new Map<string, string | null>();
  readonly #followUps = new Map<string, QueuedFollowUp>();

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

  async ensureGeneralWorkspace(ownerUserId: string): Promise<Workspace> {
    const existing = [...this.#workspaces.values()].find((workspace) => workspace.workspaceKind === "general" && workspace.ownerUserId === ownerUserId);
    if (existing) return existing;
    const now = nowIso();
    const workspace = WorkspaceSchema.parse({
      id: randomUuid(),
      path: "/workspace/general",
      name: "Chats",
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

  async listWorkspaces(filter: { ownerUserId?: string | null; includeGeneral?: boolean } = {}): Promise<Workspace[]> {
    return [...this.#workspaces.values()]
      .filter((workspace) => workspace.workspaceKind === "project" || (filter.includeGeneral === true && workspace.ownerUserId === filter.ownerUserId))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async createTask(input: CreateTaskInput): Promise<{ task: Task; session: Session }> {
    const now = nowIso();
    const workspace = input.workspaceKind === "general"
      ? await this.ensureGeneralWorkspace(requiredOwner(input.ownerUserId))
      : this.#workspaces.get(input.workspaceId ?? "");
    const workspaceId = workspace?.id ?? input.workspaceId;
    if (!workspaceId) throw new NotFoundException("Task workspace not found");
    if (workspace?.workspaceKind === "general" && workspace.ownerUserId !== input.ownerUserId) throw new NotFoundException("Task workspace not found");
    const task = TaskSchema.parse({
      id: createId("task"),
      workspaceId,
      title: input.title?.trim() || "Untitled task",
      status: "queued",
      activeSessionId: null,
      conversationKind: input.conversationKind ?? "chat",
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
      permissionMode: input.permissionMode ?? "ask",
    });
    const updatedTask = { ...task, activeSessionId: session.id, updatedAt: nowIso() };
    this.#tasks.set(task.id, TaskSchema.parse(updatedTask));
    return { task: this.#tasks.get(task.id)!, session };
  }

  async listTasks(filter: { workspaceId?: string; workspaceKind?: "project" | "general"; ownerUserId?: string | null; includeDeleted?: boolean; limit?: number; offset?: number } = {}): Promise<Task[]> {
    const limit = Math.max(1, Math.min(500, filter.limit ?? 500));
    const offset = Math.max(0, filter.offset ?? 0);
    return [...this.#tasks.values()]
      .filter((task) => (filter.workspaceId ? task.workspaceId === filter.workspaceId : true))
      .filter((task) => {
        const workspace = this.#workspaces.get(task.workspaceId);
        if (filter.workspaceKind && workspace?.workspaceKind !== filter.workspaceKind) return false;
        return workspace?.workspaceKind !== "general" || workspace.ownerUserId === filter.ownerUserId;
      })
      .filter((task) => filter.includeDeleted === true || task.deletedAt === null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
      .slice(offset, offset + limit);
  }

  async getTask(taskId: string, ownerUserId?: string | null): Promise<Task> {
    const task = this.#tasks.get(taskId);
    if (!task) throw new NotFoundException(`Task not found: ${taskId}`);
    const workspace = this.#workspaces.get(task.workspaceId);
    const taskOwner = this.#taskOwners.get(taskId) ?? null;
    if (ownerUserId !== undefined && ((taskOwner !== null && taskOwner !== ownerUserId) || (workspace?.workspaceKind === "general" && workspace.ownerUserId !== ownerUserId))) {
      throw new NotFoundException(`Task not found: ${taskId}`);
    }
    return task;
  }

  async updateTask(taskId: string, input: UpdateTaskInput, ownerUserId?: string | null): Promise<Task> {
    const current = await this.getTask(taskId, ownerUserId);
    const next = TaskSchema.parse({
      ...current,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.status !== undefined ? { status: TaskStatusSchema.parse(input.status) } : {}),
      ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
      ...(input.archived !== undefined ? { archived: input.archived } : {}),
      ...(input.conversationKind !== undefined ? {
        conversationKind: ConversationKindSchema.parse(input.conversationKind),
      } : {}),
      updatedAt: nowIso(),
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


  async createFollowUp(input: { taskId: string; sessionId: string; input: string; attachments?: AttachmentInput[] }, ownerUserId?: string | null): Promise<QueuedFollowUp> {
    await this.getTask(input.taskId, ownerUserId);
    const now = nowIso();
    const ordinal = [...this.#followUps.values()].filter((item) => item.sessionId === input.sessionId).length;
    const followUp = QueuedFollowUpSchema.parse({ id: randomUuid(), ...input, attachments: input.attachments ?? [], ordinal, status: "queued", error: null, createdAt: now, updatedAt: now });
    this.#followUps.set(followUp.id, followUp);
    return followUp;
  }

  async listFollowUps(sessionId: string, ownerUserId?: string | null): Promise<QueuedFollowUp[]> {
    const session = await this.getSession(sessionId);
    await this.getTask(session.taskId, ownerUserId);
    return [...this.#followUps.values()].filter((item) => item.sessionId === sessionId && item.status !== "removed").sort((a, b) => a.ordinal - b.ordinal);
  }

  async updateFollowUp(id: string, input: { status: QueuedFollowUp["status"]; error?: string | null }, ownerUserId?: string | null): Promise<QueuedFollowUp> {
    const current = this.#followUps.get(id);
    if (!current) throw new NotFoundException(`Queued follow-up not found: ${id}`);
    await this.getTask(current.taskId, ownerUserId);
    const next = QueuedFollowUpSchema.parse({ ...current, ...input, updatedAt: nowIso() });
    this.#followUps.set(id, next);
    return next;
  }

  async createSession(input: { taskId: string; parentSessionId?: string | null | undefined; permissionMode?: PermissionMode | undefined }): Promise<Session> {
    const task = await this.getTask(input.taskId);
    const now = nowIso();
    const session = SessionSchema.parse({
      id: createId("session"),
      taskId: task.id,
      parentSessionId: input.parentSessionId ?? null,
      status: "active",
      modelProviderId: null,
      model: null,
      permissionMode: PermissionModeSchema.parse(input.permissionMode ?? "ask"),
      createdAt: now,
      updatedAt: now,
    });
    this.#sessions.set(session.id, session);
    this.#messages.set(session.id, []);
    this.#tasks.set(task.id, TaskSchema.parse({ ...task, activeSessionId: session.id, updatedAt: now }));
    return session;
  }

  async getSession(sessionId: string): Promise<Session> {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new NotFoundException(`Session not found: ${sessionId}`);
    return session;
  }

  async appendMessage(sessionId: string, input: AppendMessageInput): Promise<Message> {
    await this.getSession(sessionId);
    const now = nowIso();
    const messageId = createId("msg");
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
      status: "complete",
      parts,
      inputTokens: 0,
      outputTokens: 0,
      generationMs: 0,
      createdAt: now,
      updatedAt: now,
    });
    this.#messages.set(sessionId, [...(this.#messages.get(sessionId) ?? []), message]);
    return message;
  }

  async listMessages(sessionId: string): Promise<Message[]> {
    await this.getSession(sessionId);
    return [...(this.#messages.get(sessionId) ?? [])];
  }

  async deleteMessagesFrom(sessionId: string, messageId: string): Promise<void> {
    await this.getSession(sessionId);
    const messages = this.#messages.get(sessionId) ?? [];
    const index = messages.findIndex((message) => message.id === messageId);
    if (index === -1) return;
    this.#messages.set(sessionId, messages.slice(0, index));
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
         VALUES ($1::uuid, $2::uuid, 'general', 'Chats', $3, 'trusted', '{"cloud":true,"scratch":true}'::jsonb, now(), now())
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

  async listWorkspaces(filter: { ownerUserId?: string | null; includeGeneral?: boolean } = {}): Promise<Workspace[]> {
    return this.database.withTenant(this.tenantId, async (executor) => {
      const rows = await executor.query<WorkspaceRow>(
        `
SELECT id, owner_id, workspace_kind, name, trust_state, created_at, updated_at
FROM workspaces
WHERE tenant_id = $1::uuid AND deleted_at IS NULL
  AND (workspace_kind = 'project' OR ($2::boolean = true AND owner_id = $3::uuid))
ORDER BY updated_at DESC
        `.trim(),
        [this.tenantId, filter.includeGeneral === true, filter.ownerUserId ?? null],
      );
      return rows.map(workspaceFromRow);
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
           AND (workspace_kind = 'project' OR owner_id = $3::uuid)`,
        [this.tenantId, workspaceId, input.ownerUserId ?? null],
      );
      if (!workspace) throw new NotFoundException(`Workspace not found: ${workspaceId}`);
      const conversationKind = ConversationKindSchema.parse(input.conversationKind ?? "chat");
      await executor.execute(
        `
INSERT INTO tasks (id, tenant_id, workspace_id, user_id, title, status, conversation_kind, created_at, updated_at)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'queued', $6::conversation_kind, $7, $7)
        `.trim(),
        [taskId, this.tenantId, workspaceId, input.ownerUserId ?? null, input.title?.trim() || "Untitled task", conversationKind, now],
      );
      const session = await this.createSessionInTenant(executor, {
        taskId,
        permissionMode: input.permissionMode ?? "ask",
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

  async listTasks(filter: { workspaceId?: string; workspaceKind?: "project" | "general"; ownerUserId?: string | null; includeDeleted?: boolean; limit?: number; offset?: number } = {}): Promise<Task[]> {
    return this.database.withTenant(this.tenantId, async (executor) => {
      const workspaceId = filter.workspaceId ? normalizeWorkspaceId(filter.workspaceId) : null;
      const rows = await executor.query<TaskRow>(
        `
SELECT t.id, t.workspace_id, t.title, t.status, t.active_session_id, t.conversation_kind,
       t.pinned, t.archived, t.deleted_at, t.unread_at, t.last_read_at, t.worktree_path, t.worktree_branch,
       t.worktree_base_ref, t.worktree_base_sha, t.pull_request_url, t.pull_request_number, t.created_at, t.updated_at
FROM tasks t
JOIN workspaces w ON w.id = t.workspace_id AND w.tenant_id = t.tenant_id
WHERE t.tenant_id = $1::uuid
  AND ($2::uuid IS NULL OR t.workspace_id = $2::uuid)
  AND ($3::boolean = true OR t.deleted_at IS NULL)
  AND ($4::workspace_kind IS NULL OR w.workspace_kind = $4::workspace_kind)
  AND (w.workspace_kind = 'project' OR ($5::uuid IS NOT NULL AND w.owner_id = $5::uuid))
  AND ($5::uuid IS NULL OR t.user_id IS NULL OR t.user_id = $5::uuid)
ORDER BY t.updated_at DESC, t.id ASC
LIMIT $6 OFFSET $7
        `.trim(),
        [this.tenantId, workspaceId, filter.includeDeleted === true, filter.workspaceKind ?? null, filter.ownerUserId ?? null, Math.max(1, Math.min(500, filter.limit ?? 500)), Math.max(0, filter.offset ?? 0)],
      );
      return rows.map(taskFromRow);
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
    conversation_kind = COALESCE($7::conversation_kind, conversation_kind),
    updated_at = $8
WHERE tenant_id = $1::uuid AND id = $2::uuid AND ($9::uuid IS NULL OR user_id IS NULL OR user_id = $9::uuid)
        `.trim(),
        [this.tenantId, taskId, input.title, input.status, input.pinned, input.archived, input.conversationKind, nowIso(), ownerUserId ?? null],
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

  async createFollowUp(input: { taskId: string; sessionId: string; input: string; attachments?: AttachmentInput[] }, ownerUserId?: string | null): Promise<QueuedFollowUp> {
    return this.database.withTenant(this.tenantId, async (executor) => {
      await this.getTaskInTenant(executor, input.taskId, ownerUserId);
      const rows = await executor.query<QueuedFollowUpRow>(
        `INSERT INTO queued_follow_ups (tenant_id, task_id, session_id, ordinal, input, attachments, status, created_at, updated_at)
         SELECT $1::uuid, $2::uuid, $3::uuid, COALESCE(MAX(ordinal) + 1, 0), $4, $5::jsonb, 'queued', $6, $6
         FROM queued_follow_ups WHERE tenant_id = $1::uuid AND session_id = $3::uuid
         RETURNING id, task_id, session_id, ordinal, input, attachments, status, error, created_at, updated_at`,
        [this.tenantId, input.taskId, input.sessionId, input.input, JSON.stringify(input.attachments ?? []), nowIso()],
      );
      return followUpFromRow(rows[0]!);
    });
  }

  async listFollowUps(sessionId: string, ownerUserId?: string | null): Promise<QueuedFollowUp[]> {
    return this.database.withTenant(this.tenantId, async (executor) => {
      const session = await this.getSessionInTenant(executor, sessionId);
      await this.getTaskInTenant(executor, session.taskId, ownerUserId);
      const rows = await executor.query<QueuedFollowUpRow>(
        `SELECT id, task_id, session_id, ordinal, input, attachments, status, error, created_at, updated_at
         FROM queued_follow_ups WHERE tenant_id = $1::uuid AND session_id = $2::uuid AND status <> 'removed' ORDER BY ordinal`,
        [this.tenantId, sessionId],
      );
      return rows.map(followUpFromRow);
    });
  }

  async updateFollowUp(id: string, input: { status: QueuedFollowUp["status"]; error?: string | null }, ownerUserId?: string | null): Promise<QueuedFollowUp> {
    return this.database.withTenant(this.tenantId, async (executor) => {
      const existing = await executor.query<QueuedFollowUpRow>(
        `SELECT id, task_id, session_id, ordinal, input, attachments, status, error, created_at, updated_at FROM queued_follow_ups WHERE tenant_id = $1::uuid AND id = $2::uuid`,
        [this.tenantId, id],
      );
      if (!existing[0]) throw new NotFoundException(`Queued follow-up not found: ${id}`);
      await this.getTaskInTenant(executor, existing[0].task_id, ownerUserId);
      const rows = await executor.query<QueuedFollowUpRow>(
        `UPDATE queued_follow_ups SET status = $3, error = $4, updated_at = $5 WHERE tenant_id = $1::uuid AND id = $2::uuid
         RETURNING id, task_id, session_id, ordinal, input, attachments, status, error, created_at, updated_at`,
        [this.tenantId, id, input.status, input.error ?? null, nowIso()],
      );
      return followUpFromRow(rows[0]!);
    });
  }

  async createSession(input: { taskId: string; parentSessionId?: string | null | undefined; permissionMode?: PermissionMode | undefined }): Promise<Session> {
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

  async appendMessage(sessionId: string, input: AppendMessageInput): Promise<Message> {
    return this.database.withTenant(this.tenantId, async (executor) => {
      const session = await this.getSessionInTenant(executor, sessionId);
      const now = nowIso();
      const messageId = randomUuid();
      await executor.execute(
        `
INSERT INTO messages (id, tenant_id, session_id, task_id, role, status, input_tokens, output_tokens, generation_ms, created_at, updated_at)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::message_role, 'complete', 0, 0, 0, $6, $6)
        `.trim(),
        [messageId, this.tenantId, sessionId, session.taskId, MessageRoleSchema.parse(input.role), now],
      );
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
SELECT id, session_id, role, status, input_tokens, output_tokens, generation_ms, created_at, updated_at
FROM messages
WHERE tenant_id = $1::uuid AND session_id = $2::uuid
ORDER BY created_at ASC
        `.trim(),
        [this.tenantId, sessionId],
      );
      return Promise.all(rows.map((row) => this.messageFromRow(executor, row)));
    });
  }

  async deleteMessagesFrom(sessionId: string, messageId: string): Promise<void> {
    await this.database.withTenant(this.tenantId, async (executor) => {
      await this.getSessionInTenant(executor, sessionId);
      // Messages carry no monotonic sequence column, so order by creation time
      // with the id as tie-break — matching listMessages' ORDER BY created_at.
      await executor.execute(
        `
DELETE FROM messages
WHERE tenant_id = $1::uuid AND session_id = $2::uuid
  AND (created_at, id) >= (
    SELECT created_at, id FROM messages
    WHERE tenant_id = $1::uuid AND session_id = $2::uuid AND id = $3::uuid
  )
        `.trim(),
        [this.tenantId, sessionId, messageId],
      );
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
  AND ($3::uuid IS NULL OR t.user_id IS NULL OR t.user_id = $3::uuid)
  AND (w.workspace_kind = 'project' OR ($3::uuid IS NOT NULL AND w.owner_id = $3::uuid))
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
      [sessionId, this.tenantId, input.taskId, input.parentSessionId ?? null, input.ownerUserId ?? null, input.modelProviderId ?? null, input.model ?? null, PermissionModeSchema.parse(input.permissionMode ?? "ask"), now],
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
SELECT id, session_id, role, status, input_tokens, output_tokens, generation_ms, created_at, updated_at
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

interface QueuedFollowUpRow {
  id: string;
  task_id: string;
  session_id: string;
  ordinal: number;
  input: string;
  attachments: unknown;
  status: string;
  error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function followUpFromRow(row: QueuedFollowUpRow): QueuedFollowUp {
  return QueuedFollowUpSchema.parse({
    id: row.id,
    taskId: row.task_id,
    sessionId: row.session_id,
    ordinal: row.ordinal,
    input: row.input,
    attachments: row.attachments,
    status: row.status,
    error: row.error,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

function taskFromRow(row: TaskRow): Task {
  return TaskSchema.parse({
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
  if (!ownerUserId) throw new NotFoundException("A signed-in user is required for General chats");
  return ownerUserId;
}
