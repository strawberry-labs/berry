import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Headers, Inject, NotFoundException, Optional, Param, Patch, Post, Query, Req, Res, ServiceUnavailableException, Sse } from "@nestjs/common";
import { SELF_HOST_TENANT_ID } from "@berry/db";
import {
  GeneratedImageContentSchema,
  TaskCollectionQuerySchema,
  WorkspaceCollectionQuerySchema,
  type JsonValue,
  type Message,
  type MessageHistoryPage,
  type OrgMembership,
  type Session,
} from "@berry/shared";
import type { ServerResponse } from "node:http";
import { z } from "zod";
import { AUDIT_SERVICE, type AuditService } from "../audit/audit.service.ts";
import type { AuthenticatedRequest } from "../auth/auth.guard.ts";
import {
  ENTERPRISE_IDENTITY_REPOSITORY,
  type EnterpriseIdentityRepository,
} from "../identity/identity.repository.ts";
import { FilePlatformService } from "../files/file-platform.service.ts";
import { CompleteSchema, InitiateSchema, PartNumbersSchema } from "../files/file-platform.controller.ts";
import { INVALID_FILE_CACHE_CONTROL } from "../files/file-response-security.ts";
import {
  CLOUD_TASK_STORE,
  InMemoryCloudTaskStore,
  MESSAGE_HISTORY_MAX_CURSOR,
  type CloudTaskStore,
} from "./cloud-task-store.ts";
import { AgentApiController } from "./agent-api.controller.ts";

const MessageHistoryCursorSchema = z.string()
  .regex(/^[1-9]\d*$/)
  .refine((value) => BigInt(value) <= BigInt(MESSAGE_HISTORY_MAX_CURSOR), "Message history cursor is too large");
const MessageHistoryRevisionSchema = z.string()
  .regex(/^\d+$/)
  .refine((value) => BigInt(value) <= BigInt(MESSAGE_HISTORY_MAX_CURSOR), "Message history revision is too large");
const MessageQuerySchema = z.object({
  limit: z.preprocess((value) => value === undefined ? undefined : Number(value), z.number().int().min(1).max(200).optional()),
  before: MessageHistoryCursorSchema.optional(),
  after: MessageHistoryCursorSchema.optional(),
  historyRevision: MessageHistoryRevisionSchema.optional(),
}).strict().refine((query) => !(query.before && query.after), {
  message: "Use either before or after, not both",
  path: ["before"],
});

const FileQuerySchema = z.object({
  taskId: z.string().uuid().optional(),
  workspaceId: z.string().uuid().optional(),
  category: z.enum(["images", "documents"]).optional(),
  search: z.string().trim().max(200).optional(),
  cursor: z.string().max(1000).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
}).strict();

const UuidSchema = z.string().uuid();
const SelfHostTaskIdSchema = z.union([UuidSchema, z.string().regex(/^task_[0-9a-f]{32}$/i)]);
const SelfHostSessionIdSchema = z.union([UuidSchema, z.string().regex(/^session_[A-Za-z0-9_-]+$/)]);
const SelfHostMessageIdSchema = z.union([UuidSchema, z.string().regex(/^msg_[A-Za-z0-9_-]+$/)]);

@Controller("/v1/orgs/:tenantId/support/users/:userId")
export class SupportViewController {
  constructor(
    @Inject(CLOUD_TASK_STORE) private readonly store: CloudTaskStore,
    @Inject(ENTERPRISE_IDENTITY_REPOSITORY) private readonly identity: EnterpriseIdentityRepository,
    @Inject(FilePlatformService) private readonly files: FilePlatformService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Optional() @Inject(AgentApiController) private readonly agentApi?: AgentApiController,
  ) {}

  @Get("/workspaces")
  async workspaceList(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Query("includeGeneral") includeGeneral?: string,
  ) {
    return this.subjectRead(request, tenantId, userId, {
      targetType: "user_workspaces",
      targetId: userId,
    }, (scoped) => this.requireAgentApi().listWorkspaces(scoped, includeGeneral));
  }

  @Post("/workspaces")
  async createWorkspace(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Body() body: unknown,
  ) {
    return this.subjectWrite(request, tenantId, userId, {
      targetType: "workspace",
      targetId: userId,
    }, (scoped) => this.requireAgentApi().createWorkspace(scoped, body));
  }

  @Patch("/workspaces/:workspaceId")
  async updateWorkspace(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Param("workspaceId") workspaceId: string,
    @Body() body: unknown,
  ) {
    return this.subjectWrite(request, tenantId, userId, {
      targetType: "workspace",
      targetId: workspaceId,
    }, (scoped) => this.requireAgentApi().updateWorkspace(scoped, workspaceId, body));
  }

  @Delete("/workspaces/:workspaceId")
  async deleteWorkspace(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Param("workspaceId") workspaceId: string,
  ) {
    return this.subjectWrite(request, tenantId, userId, {
      targetType: "workspace",
      targetId: workspaceId,
    }, (scoped) => this.requireAgentApi().deleteWorkspace(scoped, workspaceId));
  }

  @Get("/models/catalog")
  async modelCatalog(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
  ) {
    return this.subjectRead(request, tenantId, userId, {
      targetType: "model_catalog",
      targetId: userId,
    }, (scoped) => this.requireAgentApi().modelCatalog(scoped));
  }

  @Post("/prompts/improve")
  async improvePrompt(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Body() body: unknown,
  ) {
    return this.subjectWrite(request, tenantId, userId, {
      targetType: "prompt",
      targetId: userId,
    }, (scoped) => this.requireAgentApi().improvePrompt(scoped, body));
  }

  @Post("/images/generations")
  async generateImage(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Body() body: unknown,
  ) {
    return this.subjectWrite(request, tenantId, userId, {
      targetType: "image_generation",
      targetId: userId,
    }, (scoped) => this.requireAgentApi().generateImage(scoped, body));
  }

  @Post("/tasks")
  async createTask(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Body() body: unknown,
  ) {
    return this.subjectWrite(request, tenantId, userId, {
      targetType: "task",
      targetId: userId,
    }, (scoped) => this.requireAgentApi().createTask(scoped, body));
  }

  @Patch("/tasks/:taskId")
  async updateTask(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Param("taskId") taskId: string,
    @Body() body: unknown,
  ) {
    return this.subjectWrite(request, tenantId, userId, {
      targetType: "task",
      targetId: taskId,
      taskId,
    }, (scoped) => this.requireAgentApi().updateTask(scoped, taskId, body));
  }

  @Delete("/tasks/:taskId")
  async deleteTask(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Param("taskId") taskId: string,
  ) {
    return this.subjectWrite(request, tenantId, userId, {
      targetType: "task",
      targetId: taskId,
      taskId,
    }, (scoped) => this.requireAgentApi().deleteTask(scoped, taskId));
  }

  @Post("/tasks/:taskId/restore")
  async restoreTask(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Param("taskId") taskId: string,
  ) {
    return this.subjectWrite(request, tenantId, userId, {
      targetType: "task",
      targetId: taskId,
      taskId,
    }, (scoped) => this.requireAgentApi().restoreTask(scoped, taskId));
  }

  @Post("/tasks/:taskId/sessions")
  async createSession(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Param("taskId") taskId: string,
    @Body() body: unknown,
  ) {
    return this.subjectWrite(request, tenantId, userId, {
      targetType: "session",
      targetId: taskId,
      taskId,
    }, (scoped) => this.requireAgentApi().createSession(scoped, taskId, body));
  }

  @Get("/workspaces/page")
  async workspaces(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Query() query: unknown,
  ) {
    await this.requireAccess(request, tenantId, userId);
    const parsed = parseInput(WorkspaceCollectionQuerySchema, query ?? {});
    const result = await this.store.listWorkspacePage({ ...parsed, ownerUserId: userId });
    await this.recordRead(request, tenantId, userId, { targetType: "user_workspaces", targetId: userId });
    return result;
  }

  @Get("/projects/page")
  async projects(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Query() query: unknown,
  ) {
    return this.workspaces(request, tenantId, userId, query);
  }

  @Get("/tasks/page")
  async tasks(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Query() query: unknown,
  ) {
    await this.requireAccess(request, tenantId, userId);
    const parsed = parseInput(TaskCollectionQuerySchema, query ?? {});
    const result = await this.store.listTaskPage({ ...parsed, ownerUserId: userId });
    await this.recordRead(request, tenantId, userId, { targetType: "user_tasks", targetId: userId });
    return result;
  }

  @Get("/tasks/summary")
  async taskSummary(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
  ) {
    await this.requireAccess(request, tenantId, userId);
    const result = await this.store.taskSummary(userId);
    await this.recordRead(request, tenantId, userId, { targetType: "user_task_summary", targetId: userId });
    return result;
  }

  @Sse("/tasks/:taskId/events")
  async taskEvents(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Param("taskId") taskId: string,
  ) {
    return this.subjectRead(request, tenantId, userId, {
      targetType: "task_events",
      targetId: taskId,
      taskId,
    }, (scoped) => this.requireAgentApi().taskEvents(scoped, taskId));
  }

  @Post("/sessions/:sessionId/context-stats")
  async contextStats(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Param("sessionId") sessionId: string,
    @Body() body: unknown,
  ) {
    return this.subjectWrite(request, tenantId, userId, {
      targetType: "session_context",
      targetId: sessionId,
      sessionId,
    }, (scoped) => this.requireAgentApi().contextStats(scoped, sessionId, body));
  }

  @Post("/sessions/:sessionId/messages")
  async appendMessage(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Param("sessionId") sessionId: string,
    @Body() body: unknown,
  ) {
    return this.subjectWrite(request, tenantId, userId, {
      targetType: "message",
      targetId: sessionId,
      sessionId,
    }, (scoped) => this.requireAgentApi().appendMessage(scoped, sessionId, body));
  }

  @Post("/sessions/:sessionId/turns")
  async startTurn(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Param("sessionId") sessionId: string,
    @Body() body: unknown,
  ) {
    return this.subjectWrite(request, tenantId, userId, {
      targetType: "turn",
      targetId: sessionId,
      sessionId,
    }, (scoped) => this.requireAgentApi().startTurn(scoped, sessionId, body));
  }

  @Get("/sessions/:sessionId/turn-state")
  async turnState(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Param("sessionId") sessionId: string,
  ) {
    return this.subjectRead(request, tenantId, userId, {
      targetType: "turn_state",
      targetId: sessionId,
      sessionId,
    }, (scoped) => this.requireAgentApi().turnState(scoped, sessionId));
  }

  @Post("/sessions/:sessionId/cancel")
  async cancelTurn(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Param("sessionId") sessionId: string,
    @Body() body: unknown,
  ) {
    return this.subjectWrite(request, tenantId, userId, {
      targetType: "turn",
      targetId: sessionId,
      sessionId,
    }, (scoped) => this.requireAgentApi().cancelTurn(scoped, sessionId, body));
  }

  @Post("/sessions/:sessionId/steer")
  async steerTurn(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Param("sessionId") sessionId: string,
    @Body() body: unknown,
  ) {
    return this.subjectWrite(request, tenantId, userId, {
      targetType: "turn",
      targetId: sessionId,
      sessionId,
    }, (scoped) => this.requireAgentApi().steerTurn(scoped, sessionId, body));
  }

  @Get("/sessions/:sessionId/follow-ups")
  async listQueuedFollowUps(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Param("sessionId") sessionId: string,
    @Query() query: unknown,
  ) {
    return this.subjectRead(request, tenantId, userId, {
      targetType: "session_follow_ups",
      targetId: sessionId,
      sessionId,
    }, (scoped) => this.requireAgentApi().listQueuedFollowUps(scoped, sessionId, query));
  }

  @Post("/sessions/:sessionId/follow-ups")
  async enqueueQueuedFollowUp(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Param("sessionId") sessionId: string,
    @Body() body: unknown,
  ) {
    return this.subjectWrite(request, tenantId, userId, {
      targetType: "session_follow_up",
      targetId: sessionId,
      sessionId,
    }, (scoped) => this.requireAgentApi().enqueueQueuedFollowUp(scoped, sessionId, body));
  }

  @Patch("/follow-ups/:followUpId")
  async updateQueuedFollowUp(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Param("followUpId") followUpId: string,
    @Body() body: unknown,
  ) {
    return this.subjectWrite(request, tenantId, userId, {
      targetType: "follow_up",
      targetId: followUpId,
    }, (scoped) => this.requireAgentApi().updateQueuedFollowUp(scoped, followUpId, body));
  }

  @Delete("/follow-ups/:followUpId")
  async cancelQueuedFollowUp(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Param("followUpId") followUpId: string,
  ) {
    return this.subjectWrite(request, tenantId, userId, {
      targetType: "follow_up",
      targetId: followUpId,
    }, (scoped) => this.requireAgentApi().cancelQueuedFollowUp(scoped, followUpId));
  }

  @Sse("/sessions/:sessionId/events")
  async streamEvents(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Param("sessionId") sessionId: string,
    @Headers("last-event-id") lastEventId?: string,
    @Query("cursor") cursor?: string,
  ) {
    return this.subjectRead(request, tenantId, userId, {
      targetType: "session_events",
      targetId: sessionId,
      sessionId,
    }, (scoped) => this.requireAgentApi().streamEvents(scoped, sessionId, lastEventId, cursor));
  }

  @Get("/approvals")
  async listApprovals(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
  ) {
    return this.subjectRead(request, tenantId, userId, {
      targetType: "approvals",
      targetId: userId,
    }, (scoped) => this.requireAgentApi().listApprovals(scoped));
  }

  @Post("/approvals/:approvalId/decision")
  async decideApproval(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Param("approvalId") approvalId: string,
    @Body() body: unknown,
  ) {
    return this.subjectWrite(request, tenantId, userId, {
      targetType: "approval",
      targetId: approvalId,
    }, (scoped) => this.requireAgentApi().decideApproval(scoped, approvalId, body));
  }

  @Post("/questions/:questionId/answer")
  async answerQuestion(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Param("questionId") questionId: string,
    @Body() body: unknown,
  ) {
    return this.subjectWrite(request, tenantId, userId, {
      targetType: "question",
      targetId: questionId,
    }, (scoped) => this.requireAgentApi().answerQuestion(scoped, questionId, body));
  }

  @Post("/runs/:runId/recovery")
  async recoverTurn(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Param("runId") runId: string,
    @Body() body: unknown,
  ) {
    return this.subjectWrite(request, tenantId, userId, {
      targetType: "turn_recovery",
      targetId: runId,
    }, (scoped) => this.requireAgentApi().recoverTurn(scoped, runId, body));
  }

  @Get("/tasks/:taskId")
  async task(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Param("taskId") taskId: string,
  ) {
    await this.requireAccess(request, tenantId, userId);
    const parsedTaskId = this.parseResourceId(SelfHostTaskIdSchema, taskId);
    const result = await this.store.getTask(parsedTaskId, userId);
    await this.recordRead(request, tenantId, userId, { targetType: "task", targetId: parsedTaskId, taskId: parsedTaskId });
    return result;
  }

  @Get("/sessions/:sessionId")
  async session(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Param("sessionId") sessionId: string,
  ) {
    const result = await this.requireOwnedSession(request, tenantId, userId, sessionId);
    await this.recordRead(request, tenantId, userId, { targetType: "session", targetId: result.id, sessionId: result.id });
    return result;
  }

  @Get("/sessions/:sessionId/messages")
  async messages(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Param("sessionId") sessionId: string,
    @Query() query: unknown,
  ) {
    const session = await this.requireOwnedSession(request, tenantId, userId, sessionId);
    const parsed = parseInput(MessageQuerySchema, query ?? {});
    const result = Object.keys(parsed).length === 0
      ? await this.store.listMessages(session.id)
      : await this.store.listMessagePage(session.id, parsed);
    await this.recordRead(request, tenantId, userId, { targetType: "session_messages", targetId: session.id, sessionId: session.id });
    return this.scopeMessageResult(result, tenantId, userId);
  }

  @Get("/sessions/:sessionId/messages/:messageId")
  async message(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Param("sessionId") sessionId: string,
    @Param("messageId") messageId: string,
  ) {
    const session = await this.requireOwnedSession(request, tenantId, userId, sessionId);
    const parsedMessageId = this.parseResourceId(SelfHostMessageIdSchema, messageId);
    const result = await this.store.getMessage(session.id, parsedMessageId);
    await this.recordRead(request, tenantId, userId, { targetType: "message", targetId: parsedMessageId, sessionId: session.id });
    return this.scopeMessage(result, tenantId, userId);
  }

  @Post("/files/uploads")
  async initiateFileUpload(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Body() body: unknown,
  ) {
    const input = parseInput(InitiateSchema, body);
    return this.subjectWrite(request, tenantId, userId, {
      targetType: "file_upload",
      targetId: userId,
    }, () => this.files.initiateUpload(tenantId, userId, {
      name: input.name,
      mediaType: input.mediaType,
      size: input.size,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.workspaceVisibility ? { workspaceVisibility: input.workspaceVisibility } : {}),
      ...(input.sha256 ? { sha256: input.sha256 } : {}),
      origin: input.origin,
      associationRole: input.associationRole,
    }));
  }

  @Post("/files/:fileId/uploads/:uploadId/parts")
  async presignFileParts(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Param("fileId") fileId: string,
    @Param("uploadId") uploadId: string,
    @Body() body: unknown,
  ) {
    const parsedFileId = parseInput(UuidSchema, fileId);
    const parsedUploadId = parseInput(UuidSchema, uploadId);
    const input = parseInput(PartNumbersSchema, body);
    return this.subjectWrite(request, tenantId, userId, {
      targetType: "file_upload",
      targetId: parsedFileId,
    }, () => this.files.presignParts(tenantId, userId, parsedFileId, parsedUploadId, input.partNumbers));
  }

  @Post("/files/:fileId/uploads/:uploadId/complete")
  async completeFileUpload(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Param("fileId") fileId: string,
    @Param("uploadId") uploadId: string,
    @Body() body: unknown,
  ) {
    const parsedFileId = parseInput(UuidSchema, fileId);
    const parsedUploadId = parseInput(UuidSchema, uploadId);
    const input = parseInput(CompleteSchema, body);
    return this.subjectWrite(request, tenantId, userId, {
      targetType: "file_upload",
      targetId: parsedFileId,
    }, () => this.files.completeUpload(
      tenantId,
      userId,
      parsedFileId,
      parsedUploadId,
      input.parts.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })),
    ));
  }

  @Delete("/files/:fileId/uploads/:uploadId")
  async abortFileUpload(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Param("fileId") fileId: string,
    @Param("uploadId") uploadId: string,
  ) {
    const parsedFileId = parseInput(UuidSchema, fileId);
    const parsedUploadId = parseInput(UuidSchema, uploadId);
    return this.subjectWrite(request, tenantId, userId, {
      targetType: "file_upload",
      targetId: parsedFileId,
    }, () => this.files.abortUpload(tenantId, userId, parsedFileId, parsedUploadId));
  }

  @Get("/files")
  async listFiles(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Query() query: unknown,
  ) {
    await this.requireAccess(request, tenantId, userId);
    const parsed = parseInput(FileQuerySchema, query ?? {});
    const result = await this.files.list(tenantId, userId, {
      ...(parsed.taskId ? { taskId: parsed.taskId } : {}),
      ...(parsed.workspaceId ? { workspaceId: parsed.workspaceId } : {}),
      ...(parsed.category ? { category: parsed.category } : {}),
      ...(parsed.search ? { search: parsed.search } : {}),
      ...(parsed.cursor ? { cursor: parsed.cursor } : {}),
      ...(parsed.limit ? { limit: parsed.limit } : {}),
    });
    await this.recordRead(request, tenantId, userId, {
      targetType: "user_files",
      targetId: userId,
      ...(parsed.taskId ? { taskId: parsed.taskId } : {}),
      metadata: {
        ...(parsed.workspaceId ? { workspaceId: parsed.workspaceId } : {}),
        ...(parsed.category ? { category: parsed.category } : {}),
      },
    });
    return result;
  }

  @Get("/files/:fileId")
  async file(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Param("fileId") fileId: string,
  ) {
    await this.requireAccess(request, tenantId, userId);
    const parsedFileId = parseInput(UuidSchema, fileId);
    const result = await this.files.describe(tenantId, userId, parsedFileId);
    await this.recordRead(request, tenantId, userId, { targetType: "file", targetId: parsedFileId });
    return result;
  }

  @Get("/files/:fileId/content")
  async fileContent(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Param("fileId") fileId: string,
    @Query("download") download: string | undefined,
    @Res() response: ServerResponse,
  ) {
    await this.requireAccess(request, tenantId, userId);
    const parsedFileId = parseInput(UuidSchema, fileId);
    await this.files.describe(tenantId, userId, parsedFileId);
    const isDownload = download === "1";
    await this.recordRead(request, tenantId, userId, {
      action: isDownload ? "support-view-file-download-requested" : "support-view-file-preview-requested",
      targetType: "file",
      targetId: parsedFileId,
    });
    response.setHeader("Cache-Control", INVALID_FILE_CACHE_CONTROL);
    await this.files.streamContent(
      tenantId,
      userId,
      parsedFileId,
      typeof request.headers.range === "string" ? request.headers.range : undefined,
      response,
      isDownload,
      typeof request.headers["if-none-match"] === "string" ? request.headers["if-none-match"] : undefined,
    );
    if (response.statusCode === 200 || response.statusCode === 206) {
      await this.recordRead(request, tenantId, userId, {
        action: isDownload ? "support-view-file-downloaded" : "support-view-file-previewed",
        targetType: "file",
        targetId: parsedFileId,
        metadata: {
          statusCode: response.statusCode,
          partial: response.statusCode === 206,
        },
      });
    }
  }

  @Delete("/files/:fileId")
  async removeFile(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId") userId: string,
    @Param("fileId") fileId: string,
  ) {
    const parsedFileId = parseInput(UuidSchema, fileId);
    return this.subjectWrite(request, tenantId, userId, {
      targetType: "file",
      targetId: parsedFileId,
    }, () => this.files.removeFromLibrary(tenantId, userId, parsedFileId));
  }

  private async requireOwnedSession(request: AuthenticatedRequest, tenantId: string, userId: string, sessionId: string): Promise<Session> {
    await this.requireAccess(request, tenantId, userId);
    const parsedSessionId = this.parseResourceId(SelfHostSessionIdSchema, sessionId);
    const session = await this.store.getSession(parsedSessionId);
    await this.store.getTask(session.taskId, userId);
    return session;
  }

  private parseResourceId(selfHostSchema: z.ZodType<string>, value: unknown): string {
    return this.store instanceof InMemoryCloudTaskStore
      ? parseInput(selfHostSchema, value)
      : parseInput(UuidSchema, value);
  }

  private scopeMessageResult(result: Message[] | MessageHistoryPage, tenantId: string, userId: string): Message[] | MessageHistoryPage {
    if (Array.isArray(result)) return result.map((message) => this.scopeMessage(message, tenantId, userId));
    return { ...result, messages: result.messages.map((message) => this.scopeMessage(message, tenantId, userId)) };
  }

  private scopeMessage(message: Message, tenantId: string, userId: string): Message {
    return {
      ...message,
      parts: message.parts.map((part) => {
        if (part.kind !== "image") return part;
        const image = GeneratedImageContentSchema.safeParse(part.content);
        if (!image.success || !image.data.fileId) return part;
        const contentPath = `/v1/orgs/${encodeURIComponent(tenantId)}/support/users/${encodeURIComponent(userId)}/files/${encodeURIComponent(image.data.fileId)}/content`;
        return {
          ...part,
          content: {
            ...(part.content as Record<string, JsonValue>),
            src: contentPath,
            downloadUrl: `${contentPath}?download=1`,
          },
        };
      }),
    };
  }

  private requireAgentApi(): AgentApiController {
    if (!this.agentApi) throw new ServiceUnavailableException("Support actions are not available in this deployment");
    return this.agentApi;
  }

  private async subjectRequest(
    request: AuthenticatedRequest,
    tenantId: string,
    userId: string,
    requireActiveSubject: boolean,
  ): Promise<AuthenticatedRequest> {
    const { subject } = await this.requireAccess(request, tenantId, userId);
    if (requireActiveSubject && subject.status !== "active") {
      throw new ForbiddenException("The selected user does not have an active organization membership");
    }
    const subjectUser = {
      id: subject.userId,
      email: subject.email,
      name: subject.name || null,
      image: null,
    };
    const scoped = Object.create(request) as AuthenticatedRequest;
    scoped.auth = {
      ...request.auth!,
      session: { ...request.auth!.session, userId: subject.userId },
      user: subjectUser,
    };
    scoped.user = subjectUser;
    return scoped;
  }

  private async subjectRead<T>(
    request: AuthenticatedRequest,
    tenantId: string,
    userId: string,
    target: {
      targetType: string;
      targetId: string;
      taskId?: string;
      sessionId?: string;
      metadata?: Record<string, string | number | boolean | null>;
    },
    operation: (scoped: AuthenticatedRequest) => Promise<T>,
  ): Promise<T> {
    const scoped = await this.subjectRequest(request, tenantId, userId, false);
    const result = await operation(scoped);
    await this.recordRead(request, tenantId, userId, target);
    return result;
  }

  private async subjectWrite<T>(
    request: AuthenticatedRequest,
    tenantId: string,
    userId: string,
    target: {
      targetType: string;
      targetId: string;
      taskId?: string;
      sessionId?: string;
      metadata?: Record<string, string | number | boolean | null>;
    },
    operation: (scoped: AuthenticatedRequest) => Promise<T>,
  ): Promise<T> {
    const scoped = await this.subjectRequest(request, tenantId, userId, true);
    const result = await operation(scoped);
    await this.recordWrite(request, tenantId, userId, target);
    return result;
  }

  private async requireAccess(request: AuthenticatedRequest, tenantId: string, userId: string): Promise<{ actor: OrgMembership; subject: OrgMembership }> {
    parseInput(UuidSchema, tenantId);
    parseInput(UuidSchema, userId);
    const configuredTenantId = process.env.BERRY_TENANT_ID?.trim() || SELF_HOST_TENANT_ID;
    if (tenantId !== configuredTenantId) throw new NotFoundException("Organization not found");
    const actorUserId = request.auth?.user.id;
    if (!actorUserId) throw new ForbiddenException("Authentication required");
    const [actor, subject] = await Promise.all([
      this.identity.getMembership(tenantId, actorUserId),
      this.identity.getMembership(tenantId, userId),
    ]);
    if (!actor || actor.status !== "active" || (actor.role !== "owner" && actor.role !== "admin")) {
      throw new ForbiddenException("Only active organization administrators can use support view");
    }
    if (!subject) throw new ForbiddenException("The selected user does not belong to this organization");
    return { actor, subject };
  }

  private recordRead(
    request: AuthenticatedRequest,
    tenantId: string,
    userId: string,
    input: {
      action?: string;
      targetType: string;
      targetId: string;
      taskId?: string;
      sessionId?: string;
      metadata?: Record<string, string | number | boolean | null>;
    },
  ) {
    return this.audit.append({
      tenantId,
      actorUserId: request.auth!.user.id,
      category: "support",
      action: input.action ?? "support-view-read",
      targetType: input.targetType,
      targetId: input.targetId,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      metadata: { subjectUserId: userId, ...(input.metadata ?? {}) },
    });
  }

  private recordWrite(
    request: AuthenticatedRequest,
    tenantId: string,
    userId: string,
    input: {
      targetType: string;
      targetId: string;
      taskId?: string;
      sessionId?: string;
      metadata?: Record<string, string | number | boolean | null>;
    },
  ) {
    return this.audit.append({
      tenantId,
      actorUserId: request.auth!.user.id,
      category: "support",
      action: "support-view-write",
      targetType: input.targetType,
      targetId: input.targetId,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      metadata: { subjectUserId: userId, ...(input.metadata ?? {}) },
    });
  }
}

function parseInput<TSchema extends z.ZodTypeAny>(schema: TSchema, value: unknown): z.infer<TSchema> {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException(result.error.flatten());
  return result.data;
}
