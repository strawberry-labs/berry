import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Inject, Param, Patch, Post, Put, Query, Req, Sse } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { SELF_HOST_TENANT_ID } from "@berry/db";
import {
  AgentStreamEventSchema,
  ApprovalDecisionSchema,
  AttachmentInputSchema,
  ConversationKindSchema,
  JsonValueSchema,
  messageAttachmentContent,
  MessagePartKindSchema,
  MessageRoleSchema,
  MobileDeviceRegistrationCreateSchema,
  PermissionModeSchema,
  QuestionAnswerSchema,
  TaskStatusSchema,
  TurnStateSchema,
  WorkspaceKindSchema,
  type AgentStreamEvent,
  type ConversationKind,
  type JsonValue,
} from "@berry/shared";
import type { ApprovalDecisionKind, StartTurnOptions } from "@berry/local-agent";
import { z } from "zod";
import { Observable } from "rxjs";
import { SessionHostService } from "../runtime/session-host.service.ts";
import { CloudRuntimeConfigService } from "../runtime/cloud-runtime-config.ts";
import type { AuthenticatedRequest } from "../auth/auth.guard.ts";
import { BUDGET_SERVICE, budgetEstimateFromRequest, usageCostMicros, type BudgetService } from "../budget/budget.service.ts";
import { MODEL_GOVERNANCE_SERVICE, type ModelGovernanceService } from "../model-governance/model-governance.service.ts";
import { CLOUD_TASK_STORE, type CloudTaskStore } from "./cloud-task-store.ts";
import { ApiEventStreamService } from "./event-stream.service.ts";
import { CompanionPushService, MOBILE_DEVICE_REGISTRY, type MobileDeviceRegistry } from "./mobile-devices.ts";
import { USAGE_REPOSITORY, type UsageRepository } from "../usage/usage.repository.ts";
import { AUDIT_SERVICE, type AuditService } from "../audit/audit.service.ts";
import { SANDBOX_WORKSPACE_SERVICE, SandboxWorkspaceService } from "./sandbox-workspace.service.ts";
import { ORGANIZATION_CAPABILITIES, OrganizationCapabilitiesService } from "./organization-capabilities.service.ts";
import { FilePlatformService } from "../files/file-platform.service.ts";

const CreateTaskRequestSchema = z.object({
  workspaceId: z.string().min(1).optional(),
  workspaceKind: WorkspaceKindSchema.default("project"),
  conversationKind: ConversationKindSchema.default("chat"),
  title: z.string().trim().min(1).optional(),
  permissionMode: PermissionModeSchema.optional(),
  modelProviderId: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
}).strict().superRefine((request, context) => {
  if (request.workspaceKind === "project" && !request.workspaceId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["workspaceId"], message: "Project tasks require a workspaceId" });
  }
});

const CreateWorkspaceRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
}).strict();

const UpdateTaskRequestSchema = z.object({
  title: z.string().trim().min(1).optional(),
  status: TaskStatusSchema.optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  conversationKind: ConversationKindSchema.optional(),
}).strict();

const CreateSessionRequestSchema = z.object({
  parentSessionId: z.string().nullable().optional(),
  permissionMode: PermissionModeSchema.optional(),
}).strict();

const AppendMessageRequestSchema = z.object({
  role: MessageRoleSchema.default("user"),
  parts: z.array(z.object({
    kind: MessagePartKindSchema,
    content: JsonValueSchema,
  })).min(1),
}).strict();

const StartTurnRequestSchema = z.object({
  input: z.string().min(1),
  workspacePath: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
  permissionMode: PermissionModeSchema.optional(),
  provider: z.any(),
  model: z.string().optional(),
  apiKey: z.string().optional(),
  reasoning: z.enum(["off", "low", "medium", "high"]).optional(),
  attachments: z.array(AttachmentInputSchema).max(100).optional(),
  // Edit-and-resubmit: rewind the session to before this user message, drop it
  // and everything after, persist the new input as the user message, and run
  // the turn from that point (mirrors the desktop host's agent.turn).
  replaceFromMessageId: z.string().min(1).optional(),
}).passthrough();

const SteerTurnRequestSchema = z.object({
  input: z.string().trim().min(1),
  attachments: z.array(AttachmentInputSchema).max(100).optional(),
}).strict();

const ReorderFollowUpsRequestSchema = z.object({
  followUpIds: z.array(z.string().min(1)).max(100),
}).strict();

const ImageGenerationRequestSchema = z.object({
  prompt: z.string().trim().min(1).max(8_000),
  size: z.enum(["512x512", "768x768", "1024x1024", "1024x1536", "1536x1024"]).optional(),
}).strict();

const ApprovalDecisionRequestSchema = ApprovalDecisionSchema.pick({ decision: true, remember: true, reason: true }).partial({
  remember: true,
  reason: true,
});

const AnswerQuestionRequestSchema = z.object({
  answer: z.string().trim().min(1),
  selectedOptions: z.array(z.string()).max(24).optional(),
  answers: z.array(QuestionAnswerSchema).min(1).max(5).optional(),
}).strict();

const WorkspaceFileRequestSchema = z.object({ path: z.string().trim().min(1).max(4_096), content: z.string().max(1_048_576) }).strict();
const TerminalCreateRequestSchema = z.object({ cols: z.number().int().min(20).max(500).default(80), rows: z.number().int().min(5).max(200).default(24) }).strict();
const TerminalInputRequestSchema = z.object({ input: z.string().min(1).max(16_384), approved: z.boolean().default(false) }).strict();
const TerminalResizeRequestSchema = z.object({ cols: z.number().int().min(20).max(500), rows: z.number().int().min(5).max(200) }).strict();
const PreviewRequestSchema = z.object({ port: z.number().int().min(1).max(65_535), approved: z.boolean().default(false) }).strict();

@Controller("/v1")
export class AgentApiController {
  readonly #projectionWrites = new Map<string, Promise<void>>();
  readonly #followUpQueueWrites = new Map<string, Promise<void>>();
  readonly #startedAt = Date.now();

  constructor(
    @Inject(CLOUD_TASK_STORE) private readonly store: CloudTaskStore,
    @Inject(SessionHostService) private readonly sessionHost: SessionHostService,
    @Inject(ApiEventStreamService) private readonly events: ApiEventStreamService,
    @Inject(BUDGET_SERVICE) private readonly budgets: BudgetService,
    @Inject(MODEL_GOVERNANCE_SERVICE) private readonly modelGovernance: ModelGovernanceService,
    @Inject(MOBILE_DEVICE_REGISTRY) private readonly mobileDevices: MobileDeviceRegistry,
    @Inject(CompanionPushService) private readonly companionPush: CompanionPushService,
    @Inject(CloudRuntimeConfigService) private readonly runtimeConfig: CloudRuntimeConfigService,
    @Inject(USAGE_REPOSITORY) private readonly usageRepository: UsageRepository,
    @Inject(SANDBOX_WORKSPACE_SERVICE) private readonly sandboxWorkspace: SandboxWorkspaceService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(ORGANIZATION_CAPABILITIES) private readonly organizationCapabilities: OrganizationCapabilitiesService,
    @Inject(FilePlatformService) private readonly files: FilePlatformService,
  ) {}

  #queueProjectionWrite(sessionId: string, write: () => Promise<unknown>): void {
    const previous = this.#projectionWrites.get(sessionId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(write)
      .then(() => undefined, () => undefined)
      .finally(() => {
        if (this.#projectionWrites.get(sessionId) === next) this.#projectionWrites.delete(sessionId);
      });
    this.#projectionWrites.set(sessionId, next);
  }

  /**
   * The queue is edited optimistically in the browser, so several queue
   * mutations can reach the API in quick succession. Serialize runtime
   * replacement per session: every pass reads the latest persisted order,
   * rather than allowing two clear-and-rebuild operations to interleave.
   */
  async #synchronizeFollowUpQueue(httpRequest: AuthenticatedRequest, sessionId: string) {
    const previous = this.#followUpQueueWrites.get(sessionId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.#synchronizeFollowUpQueueNow(httpRequest, sessionId));
    const tracked = next.then(() => undefined, () => undefined);
    this.#followUpQueueWrites.set(sessionId, tracked);
    try {
      return await next;
    } finally {
      if (this.#followUpQueueWrites.get(sessionId) === tracked) this.#followUpQueueWrites.delete(sessionId);
    }
  }

  async #synchronizeFollowUpQueueNow(httpRequest: AuthenticatedRequest, sessionId: string) {
    const session = await this.store.getSession(sessionId);
    const followUps = await this.store.listFollowUps(sessionId, httpRequest.auth?.user.id ?? null);
    const queued = followUps.filter((followUp) => followUp.status === "queued");
    const runtimeFollowUps = await Promise.all(queued.map(async (followUp) => {
      const attachments = await this.files.runtimeAttachments(
        tenantIdFromRequest(httpRequest),
        httpRequest.auth!.user.id,
        followUp.attachments,
        { taskId: session.taskId, sessionId },
      );
      const normalizedAttachments = normalizeAttachments(attachments);
      return {
        input: followUp.input,
        images: imagesFromAttachments(attachments),
        ...(normalizedAttachments ? { attachments: normalizedAttachments } : {}),
      };
    }));
    await this.sessionHost.replaceFollowUpQueue(sessionId, runtimeFollowUps);
    return followUps;
  }

  @Get("/models/catalog")
  async modelCatalog(@Req() httpRequest: AuthenticatedRequest) {
    const catalog = this.runtimeConfig.catalog();
    if (!catalog) return null;
    const effective = await this.organizationCapabilities.effective(tenantIdFromRequest(httpRequest), httpRequest.auth?.user.id ?? "");
    return { ...catalog, skills: [...catalog.skills, ...effective.skills.map((skill) => ({ id: skill.filePath, name: skill.name, description: skill.description, enabled: true }))], mcpServers: [...catalog.mcpServers, ...effective.mcpServers.flatMap((server) => server.url ? [{ id: server.id, name: server.name, url: server.url, auth: server.credential ? "bearer" as const : "none" as const, enabled: server.enabled }] : [])] };
  }

  @Post("/images/generations")
  async generateImage(@Req() httpRequest: AuthenticatedRequest, @Body() body: unknown) {
    const request = parseBody(ImageGenerationRequestSchema, body);
    const image = this.runtimeConfig.imageGenerationInfo();
    if (!image) return this.runtimeConfig.generateImage(request);
    const tenantId = tenantIdFromRequest(httpRequest);
    const requestId = `image_${randomUUID()}`;
    const actualCostMicros = BigInt(image.costMicros);
    const startedAt = Date.now();
    await this.budgets.reserve({
      tenantId,
      requestId,
      userId: httpRequest.auth?.user.id ?? null,
      departmentId: null,
      taskId: null,
      sessionId: null,
      feature: "image.generate",
      provider: image.providerId,
      model: image.model,
      estimatedCostMicros: actualCostMicros,
      metadata: { size: request.size ?? "1024x1024" },
    });
    let result: Awaited<ReturnType<CloudRuntimeConfigService["generateImage"]>>;
    try {
      result = await this.runtimeConfig.generateImage(request);
    } catch (error) {
      await Promise.all([
        this.budgets.reconcile({ tenantId, requestId, actualCostMicros: 0n }),
        this.usageRepository.ingestInternal(tenantId, imageUsageEvent({
          requestId,
          httpRequest,
          image,
          request,
          actualCostMicros: 0n,
          startedAt,
          status: "failed",
        })),
      ]).catch(() => undefined);
      throw error;
    }
    await Promise.all([
      this.budgets.reconcile({ tenantId, requestId, actualCostMicros }),
      this.usageRepository.ingestInternal(tenantId, imageUsageEvent({
        requestId,
        httpRequest,
        image,
        request,
        actualCostMicros,
        startedAt,
        status: "completed",
      })),
    ]);
    return result;
  }

  @Post("/workspaces")
  async createWorkspace(@Req() httpRequest: AuthenticatedRequest, @Body() body: unknown) {
    return this.store.createWorkspace({ ...parseBody(CreateWorkspaceRequestSchema, body), ownerUserId: httpRequest.auth?.user.id ?? null });
  }

  @Get("/workspaces")
  async listWorkspaces(@Req() httpRequest: AuthenticatedRequest, @Query("includeGeneral") includeGeneral?: string) {
    return this.store.listWorkspaces({ ownerUserId: httpRequest.auth?.user.id ?? null, includeGeneral: includeGeneral === "true" });
  }

  @Post("/tasks")
  async createTask(@Req() httpRequest: AuthenticatedRequest, @Body() body: unknown) {
    return this.store.createTask({ ...parseBody(CreateTaskRequestSchema, body), ownerUserId: httpRequest.auth?.user.id ?? null });
  }

  @Get("/tasks")
  async listTasks(
    @Req() httpRequest: AuthenticatedRequest,
    @Query("workspaceId") workspaceId?: string,
    @Query("workspaceKind") workspaceKind?: string,
    @Query("includeDeleted") includeDeleted?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ) {
    await Promise.all(this.#projectionWrites.values());
    const tasks = await this.store.listTasks({
      ...(workspaceId ? { workspaceId } : {}),
      ...(workspaceKind ? { workspaceKind: WorkspaceKindSchema.parse(workspaceKind) } : {}),
      ownerUserId: httpRequest.auth?.user.id ?? null,
      includeDeleted: includeDeleted === "true",
      ...(limit ? { limit: z.coerce.number().int().positive().max(500).parse(limit) } : {}),
      ...(offset ? { offset: z.coerce.number().int().nonnegative().parse(offset) } : {}),
    });
    return Promise.all(tasks.map(async (task) => {
      if (task.status !== "running" || !task.activeSessionId) return task;
      const state = this.sessionHost.turnState(task.activeSessionId);
      if (state.active) return task;
      const terminal = [...state.bufferedEvents].reverse().find((event) => event.kind === "turn.end");
      if (terminal?.kind === "turn.end") {
        return this.store.updateTask(task.id, { status: terminal.status }, httpRequest.auth?.user.id ?? null);
      }
      // SessionHost owns the inference process, so a task that was already
      // running before this API process started cannot still be executing.
      // Reconcile legacy/stale rows instead of leaving the sidebar on
      // "Working" forever after a restart.
      if (Date.parse(task.updatedAt) >= this.#startedAt) return task;
      const messages = await this.store.listMessages(task.activeSessionId);
      const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
      const status = lastAssistant && !lastAssistant.parts.some((part) => part.kind === "error")
        ? "completed"
        : "failed";
      return this.store.updateTask(task.id, { status }, httpRequest.auth?.user.id ?? null);
    }));
  }

  @Get("/tasks/:taskId")
  async getTask(@Req() httpRequest: AuthenticatedRequest, @Param("taskId") taskId: string) {
    return this.store.getTask(taskId, httpRequest.auth?.user.id ?? null);
  }

  @Post("/tasks/:taskId/workspace")
  async ensureSandboxWorkspace(@Req() httpRequest: AuthenticatedRequest, @Param("taskId") taskId: string) {
    const task = await this.store.getTask(taskId, httpRequest.auth?.user.id ?? null);
    return this.sandboxWorkspace.ensure(tenantIdFromRequest(httpRequest), task.id, task.activeSessionId);
  }

  @Get("/tasks/:taskId/workspace")
  async getSandboxWorkspace(@Req() httpRequest: AuthenticatedRequest, @Param("taskId") taskId: string) {
    return this.ensureSandboxWorkspace(httpRequest, taskId);
  }

  @Get("/tasks/:taskId/workspace/files")
  async sandboxFiles(@Req() httpRequest: AuthenticatedRequest, @Param("taskId") taskId: string, @Query("path") path?: string) {
    return this.sandboxWorkspace.listFiles(await this.ensureSandboxWorkspace(httpRequest, taskId), path);
  }

  @Get("/tasks/:taskId/workspace/file")
  async sandboxFile(@Req() httpRequest: AuthenticatedRequest, @Param("taskId") taskId: string, @Query("path") path?: string) {
    if (!path) throw new BadRequestException("path is required");
    return this.sandboxWorkspace.readFile(await this.ensureSandboxWorkspace(httpRequest, taskId), path);
  }

  @Put("/tasks/:taskId/workspace/file")
  async writeSandboxFile(@Req() httpRequest: AuthenticatedRequest, @Param("taskId") taskId: string, @Body() body: unknown) {
    const request = parseBody(WorkspaceFileRequestSchema, body);
    const result = await this.sandboxWorkspace.writeFile(await this.ensureSandboxWorkspace(httpRequest, taskId), request.path, request.content);
    await this.#auditWorkspace(httpRequest, taskId, "file-written", { path: result.path, sizeBytes: result.sizeBytes });
    return result;
  }

  @Get("/tasks/:taskId/workspace/terminals")
  async sandboxTerminals(@Req() httpRequest: AuthenticatedRequest, @Param("taskId") taskId: string) {
    await this.store.getTask(taskId, httpRequest.auth?.user.id ?? null);
    return this.sandboxWorkspace.listTerminals(taskId);
  }

  @Post("/tasks/:taskId/workspace/terminals")
  async createSandboxTerminal(@Req() httpRequest: AuthenticatedRequest, @Param("taskId") taskId: string, @Body() body: unknown) {
    await this.store.getTask(taskId, httpRequest.auth?.user.id ?? null);
    const request = parseBody(TerminalCreateRequestSchema, body ?? {});
    return this.sandboxWorkspace.createTerminal(taskId, request.cols, request.rows);
  }

  @Post("/tasks/:taskId/workspace/terminals/:terminalId/input")
  async writeSandboxTerminal(@Req() httpRequest: AuthenticatedRequest, @Param("taskId") taskId: string, @Param("terminalId") terminalId: string, @Body() body: unknown) {
    const task = await this.store.getTask(taskId, httpRequest.auth?.user.id ?? null);
    const request = parseBody(TerminalInputRequestSchema, body);
    const session = task.activeSessionId ? await this.store.getSession(task.activeSessionId) : null;
    if (session?.permissionMode !== "full-access" && !request.approved) throw new ForbiddenException({ code: "approval_required", message: "Terminal commands require approval in this permission mode" });
    const result = this.sandboxWorkspace.queueTerminal(await this.ensureSandboxWorkspace(httpRequest, taskId), terminalId, request.input);
    await this.#auditWorkspace(httpRequest, taskId, "terminal-command", { terminalId, approved: request.approved, permissionMode: session?.permissionMode ?? null });
    return result;
  }

  @Patch("/tasks/:taskId/workspace/terminals/:terminalId")
  async resizeSandboxTerminal(@Req() httpRequest: AuthenticatedRequest, @Param("taskId") taskId: string, @Param("terminalId") terminalId: string, @Body() body: unknown) {
    await this.store.getTask(taskId, httpRequest.auth?.user.id ?? null);
    const request = parseBody(TerminalResizeRequestSchema, body);
    return this.sandboxWorkspace.resizeTerminal(taskId, terminalId, request.cols, request.rows);
  }

  @Delete("/tasks/:taskId/workspace/terminals/:terminalId")
  async closeSandboxTerminal(@Req() httpRequest: AuthenticatedRequest, @Param("taskId") taskId: string, @Param("terminalId") terminalId: string) {
    await this.store.getTask(taskId, httpRequest.auth?.user.id ?? null);
    return this.sandboxWorkspace.closeTerminal(taskId, terminalId);
  }

  @Get("/tasks/:taskId/workspace/terminals/:terminalId/events")
  async sandboxTerminalEvents(@Req() httpRequest: AuthenticatedRequest, @Param("taskId") taskId: string, @Param("terminalId") terminalId: string, @Query("after") after?: string) {
    await this.store.getTask(taskId, httpRequest.auth?.user.id ?? null);
    return this.sandboxWorkspace.terminalEvents(taskId, terminalId, after ? z.coerce.number().int().min(-1).parse(after) : -1);
  }

  @Get("/tasks/:taskId/workspace/git")
  async sandboxGit(@Req() httpRequest: AuthenticatedRequest, @Param("taskId") taskId: string) {
    return this.sandboxWorkspace.gitState(await this.ensureSandboxWorkspace(httpRequest, taskId));
  }

  @Get("/tasks/:taskId/workspace/previews")
  async sandboxPreviews(@Req() httpRequest: AuthenticatedRequest, @Param("taskId") taskId: string) {
    await this.store.getTask(taskId, httpRequest.auth?.user.id ?? null);
    return this.sandboxWorkspace.listPreviews(taskId);
  }

  @Post("/tasks/:taskId/workspace/previews")
  async exposeSandboxPreview(@Req() httpRequest: AuthenticatedRequest, @Param("taskId") taskId: string, @Body() body: unknown) {
    const request = parseBody(PreviewRequestSchema, body);
    if (!request.approved) throw new ForbiddenException({ code: "approval_required", message: "Exposing a preview port requires approval" });
    const preview = await this.sandboxWorkspace.exposePreview(await this.ensureSandboxWorkspace(httpRequest, taskId), request.port);
    await this.#auditWorkspace(httpRequest, taskId, "preview-exposed", { port: preview.port });
    return preview;
  }

  @Get("/tasks/:taskId/workspace/capture")
  async captureSandboxWorkspace(@Req() httpRequest: AuthenticatedRequest, @Param("taskId") taskId: string) {
    const state = await this.ensureSandboxWorkspace(httpRequest, taskId);
    return { state, previews: this.sandboxWorkspace.listPreviews(taskId), terminals: this.sandboxWorkspace.listTerminals(taskId) };
  }

  async #auditWorkspace(httpRequest: AuthenticatedRequest, taskId: string, action: string, metadata: JsonValue) {
    await this.audit.append({ tenantId: tenantIdFromRequest(httpRequest), actorUserId: httpRequest.auth?.user.id ?? null, category: "sandbox", action, targetType: "task_workspace", targetId: taskId, taskId, metadata });
  }

  @Patch("/tasks/:taskId")
  async updateTask(@Req() httpRequest: AuthenticatedRequest, @Param("taskId") taskId: string, @Body() body: unknown) {
    const task = await this.store.updateTask(taskId, parseBody(UpdateTaskRequestSchema, body), httpRequest.auth?.user.id ?? null);
    this.events.publishTask(task);
    return task;
  }

  @Sse("/tasks/:taskId/events")
  async taskEvents(@Req() httpRequest: AuthenticatedRequest, @Param("taskId") taskId: string) {
    await this.store.getTask(taskId, httpRequest.auth?.user.id ?? null);
    return this.events.taskStream(taskId);
  }

  @Delete("/tasks/:taskId")
  async deleteTask(@Req() httpRequest: AuthenticatedRequest, @Param("taskId") taskId: string) {
    const task = await this.store.deleteTask(taskId, httpRequest.auth?.user.id ?? null);
    this.events.publishTask(task);
    return task;
  }

  @Post("/tasks/:taskId/restore")
  async restoreTask(@Req() httpRequest: AuthenticatedRequest, @Param("taskId") taskId: string) {
    const task = await this.store.restoreTask(taskId, httpRequest.auth?.user.id ?? null);
    this.events.publishTask(task);
    return task;
  }

  @Post("/tasks/:taskId/sessions")
  async createSession(@Param("taskId") taskId: string, @Body() body: unknown) {
    const request = parseBody(CreateSessionRequestSchema, body ?? {});
    return this.store.createSession({
      taskId,
      parentSessionId: request.parentSessionId,
      permissionMode: request.permissionMode,
    });
  }

  @Get("/sessions/:sessionId/messages")
  async listMessages(@Param("sessionId") sessionId: string) {
    await this.#projectionWrites.get(sessionId);
    return this.store.listMessages(sessionId);
  }

  @Post("/sessions/:sessionId/messages")
  async appendMessage(@Req() request: AuthenticatedRequest, @Param("sessionId") sessionId: string, @Body() body: unknown) {
    const input = parseBody(AppendMessageRequestSchema, body);
    const message = await this.store.appendMessage(sessionId, input);
    if (input.role === "user") {
      const fileIds = input.parts.flatMap((part) => {
        if (part.kind !== "attachment" || !part.content || typeof part.content !== "object" || Array.isArray(part.content)) return [];
        const fileId = (part.content as Record<string, unknown>).fileId;
        return typeof fileId === "string" ? [fileId] : [];
      });
      if (fileIds.length > 0) {
        const session = await this.store.getSession(sessionId);
        await this.files.associateInputFiles(tenantIdFromRequest(request), request.auth!.user.id, { fileIds, taskId: session.taskId, sessionId, messageId: message.id });
      }
    }
    return message;
  }

  @Post("/sessions/:sessionId/turns")
  async startTurn(@Req() httpRequest: AuthenticatedRequest, @Param("sessionId") sessionId: string, @Body() body: unknown) {
    const request = parseBody(StartTurnRequestSchema, body);
    const session = await this.store.getSession(sessionId);
    const task = await this.store.getTask(session.taskId);
    const tenantId = tenantIdFromRequest(httpRequest);
    const requestId = `model_${randomUUID()}`;
    const baseRuntime = this.runtimeConfig.resolve(request);
    const effectiveRuntime = await this.organizationCapabilities.effective(tenantId, httpRequest.auth?.user.id ?? "");
    const resolvedRuntime = { ...baseRuntime, mcpServers: [...baseRuntime.mcpServers, ...effectiveRuntime.mcpServers], extraSkills: [...baseRuntime.extraSkills, ...effectiveRuntime.skills] };
    const providerId = resolvedRuntime.provider.id;
    const mode = conversationKindFromTask(task);
    const modelDecision = await this.modelGovernance.resolve({
      tenantId,
      mode,
      providerId,
      model: request.model ?? null,
    });
    if (!modelDecision.allowed) {
      throw new ForbiddenException({
        code: "model_governance_blocked",
        message: modelGovernanceMessage(modelDecision.reason),
        decision: modelDecision,
      });
    }
    const governedRequest = {
      ...request,
      provider: resolvedRuntime.provider,
      apiKey: resolvedRuntime.apiKey,
      model: request.model ?? modelDecision.model,
      mcpServers: resolvedRuntime.mcpServers,
      extraSkills: resolvedRuntime.extraSkills,
      networkPolicy: resolvedRuntime.networkPolicy,
      maxTokens: resolvedRuntime.providerMaxOutputTokens,
      projectTrusted: true,
      ...(this.runtimeConfig.imageGenerationInfo() ? {
        imageGeneration: {
          generate: async ({ prompt, size }: { prompt: string; model?: string; size?: string; signal?: AbortSignal }) => {
            const result = await this.generateImage(httpRequest, { prompt, ...(size ? { size } : {}) });
            return imageToolResult(result);
          },
        },
      } : {}),
    };
    const reservation = await this.budgets.reserve({
      tenantId,
      requestId,
      userId: httpRequest.auth?.user.id ?? null,
      departmentId: null,
      taskId: task.id,
      sessionId,
      feature: "model",
      provider: providerId,
      model: governedRequest.model ?? null,
      estimatedCostMicros: budgetEstimateFromRequest({ provider: governedRequest.provider, model: governedRequest.model }),
      estimatedTokens: governedRequest.maxTokens ?? 4000,
      metadata: { workspaceId: request.workspaceId ?? task.workspaceId },
    });
    let actualCostMicros = reservation.reservation ? BigInt(reservation.reservation.reservedMicros) : 0n;
    const startedAt = Date.now();
    let usage: { inputTokens?: number; outputTokens?: number; provider?: string | null; model?: string | null } | undefined;
    let assistantErrorPersisted = false;
    if (request.replaceFromMessageId) {
      await this.rewindForEdit(sessionId, request.replaceFromMessageId, request.input, request.attachments);
    }
    try {
      await this.store.updateTask(task.id, { status: "running" });
      const runtimeAttachments = await this.files.runtimeAttachments(tenantId, httpRequest.auth!.user.id, governedRequest.attachments ?? [], { taskId: task.id, sessionId });
      let activeTurnId: string | undefined;
      const { turnId } = this.sessionHost.startTurn({
        ...governedRequest,
        sessionId,
        taskId: task.id,
        workspaceId: governedRequest.workspaceId ?? task.workspaceId,
        permissionMode: governedRequest.permissionMode ?? session.permissionMode,
        attachments: normalizeAttachments(runtimeAttachments),
        images: imagesFromAttachments(runtimeAttachments),
        onAssistantMessage: (message) => {
          const hasError = message.parts.some((part) => part.kind === "error");
          const parts = hasError && assistantErrorPersisted
            ? message.parts.filter((part) => part.kind !== "error")
            : message.parts;
          if (hasError) assistantErrorPersisted = true;
          if (parts.length === 0) return;
          this.#queueProjectionWrite(sessionId, () => this.store.appendMessage(sessionId, {
            role: "assistant",
            parts: parts.map((part) => ({ kind: part.kind, content: part.content })),
          }));
        },
        // Persist settled tool metadata (status/output/duration/children) as
        // tool-result parts so reloaded threads render the same grouped tool
        // activity the live stream shows — matching the desktop projection.
        onToolCall: (call) => {
          if (["persist_artifact", "browser_screenshot"].includes(call.toolName) && call.status === "completed") {
            const output = call.output && typeof call.output === "object" && !Array.isArray(call.output) ? call.output as Record<string, unknown> : null;
            const artifact = output?.artifact && typeof output.artifact === "object" && !Array.isArray(output.artifact) ? output.artifact as Record<string, unknown> : null;
            const key = typeof artifact?.key === "string" ? artifact.key : null;
            const name = typeof artifact?.name === "string" ? artifact.name : null;
            if (key && name) {
              void this.files.registerSandboxOutput(tenantId, httpRequest.auth!.user.id, {
                key,
                name,
                mediaType: typeof artifact?.mediaType === "string" ? artifact.mediaType : "application/octet-stream",
                ...(typeof artifact?.size === "number" ? { size: artifact.size } : {}),
                taskId: task.id,
                sessionId,
                ...(activeTurnId ? { turnId: activeTurnId } : {}),
                origin: call.toolName === "browser_screenshot" ? "browser_capture" : "sandbox_output",
              }).catch(() => undefined);
            }
          }
          if (call.toolName === "image_generation" && call.status === "completed") {
            const output = call.output && typeof call.output === "object" && !Array.isArray(call.output)
              ? call.output as Record<string, unknown>
              : null;
            const image = output?.image && typeof output.image === "object" && !Array.isArray(output.image)
              ? output.image as Record<string, unknown>
              : null;
            const data = typeof image?.data === "string" ? image.data : "";
            const mimeType = typeof image?.mimeType === "string" ? image.mimeType : "image/png";
            if (data) {
              this.#queueProjectionWrite(sessionId, () => this.store.appendMessage(sessionId, {
                role: "assistant",
                parts: [{ kind: "image", content: `data:${mimeType};base64,${data}` }],
              }));
            }
          }
          const durationMs = Date.parse(call.completedAt) - Date.parse(call.startedAt);
          this.#queueProjectionWrite(sessionId, () => this.store.appendMessage(sessionId, {
            role: "assistant",
            parts: [{
              kind: "tool-result",
              content: {
                toolCallId: call.toolCallId,
                name: call.toolName,
                arguments: call.input,
                status: call.status,
                ...(call.output !== null && call.output !== undefined ? { output: call.output } : {}),
                ...(Number.isFinite(durationMs) && durationMs >= 0 ? { durationMs } : {}),
                ...(call.children && call.children.length > 0 ? { children: call.children } : {}),
              } as unknown as JsonValue,
            }],
          }));
        },
        onEvent: (event: AgentStreamEvent) => {
          const parsed = AgentStreamEventSchema.parse(event);
          // A provider stream can fail before the harness produces an
          // assistant message. Persist the terminal error projection so it is
          // still visible after navigation, reload, or SSE reconnection.
          if (parsed.kind === "error" && !assistantErrorPersisted) {
            assistantErrorPersisted = true;
            this.#queueProjectionWrite(sessionId, () => this.store.appendMessage(sessionId, {
              role: "assistant",
              parts: [{ kind: "error", content: parsed.message }],
            }));
          }
          if (parsed.kind === "usage") {
            actualCostMicros = usageCostMicros(parsed, actualCostMicros, governedRequest.provider);
            usage = {
              inputTokens: parsed.inputTokens,
              outputTokens: parsed.outputTokens,
              provider: parsed.servedProvider ?? providerId,
              model: parsed.servedModel ?? parsed.model ?? governedRequest.model ?? null,
            };
          }
          this.events.publish(sessionId, parsed);
          if (parsed.kind === "turn.end") {
            this.#queueProjectionWrite(sessionId, () => this.store.updateTask(task.id, { status: parsed.status }));
            void Promise.all([
              this.budgets.reconcile({ tenantId, requestId, actualCostMicros, usage }),
              this.usageRepository.ingestInternal(tenantId, {
                requestId,
                userId: httpRequest.auth?.user.id ?? null,
                departmentId: null,
                workspaceId: governedRequest.workspaceId ?? task.workspaceId,
                taskId: task.id,
                sessionId,
                toolCallId: null,
                feature: "model.turn",
                provider: usage?.provider ?? providerId,
                model: usage?.model ?? governedRequest.model ?? null,
                tokensIn: usage?.inputTokens ?? 0,
                tokensOut: usage?.outputTokens ?? 0,
                tokensCached: 0,
                sandboxUsage: {},
                costRawMicros: actualCostMicros.toString(),
                costBilledMicros: actualCostMicros.toString(),
                latencyMs: Date.now() - startedAt,
                ttftMs: null,
                status: parsed.status,
                metadata: { mode },
                ts: new Date().toISOString(),
              }),
            ]).catch(() => undefined);
          }
        },
      } as StartTurnOptions);
      activeTurnId = turnId;
      return { turnId, sessionId };
    } catch (error) {
      await this.budgets.reconcile({ tenantId, requestId, actualCostMicros: 0n, usage });
      throw error;
    }
  }

  /**
   * Edit-and-resubmit support: rewind the runtime session tree to before the
   * edited user message, truncate the persisted projection from that message
   * on, and store the replacement user message. The caller then starts a
   * fresh turn from that point — the same flow the desktop host runs.
   */
  private async rewindForEdit(
    sessionId: string,
    replaceFromMessageId: string,
    input: string,
    attachments: z.infer<typeof AttachmentInputSchema>[] | undefined,
  ): Promise<void> {
    const messages = await this.store.listMessages(sessionId);
    const targetIndex = messages.findIndex((message) => message.id === replaceFromMessageId);
    if (targetIndex !== -1) {
      const ordinal = messages
        .slice(0, targetIndex + 1)
        .filter((message) => message.role === "user").length;
      if (ordinal > 0) {
        // The runtime session may not exist after a server restart; the turn
        // that follows starts from the truncated projection either way.
        await Promise.resolve(this.sessionHost.rewindForEdit(sessionId, ordinal)).catch(() => undefined);
      }
      await this.store.deleteMessagesFrom(sessionId, replaceFromMessageId);
    }
    await this.store.appendMessage(sessionId, {
      role: "user",
      parts: userMessageParts(input, attachments),
    });
  }

  @Post("/questions/:questionId/answer")
  answerQuestion(@Param("questionId") questionId: string, @Body() body: unknown) {
    const request = parseBody(AnswerQuestionRequestSchema, body);
    return {
      ok: this.sessionHost.resolveQuestion(questionId, {
        answer: request.answer,
        selectedOptions: request.selectedOptions ?? [],
        ...(request.answers ? { answers: request.answers } : {}),
      }),
    };
  }

  @Sse("/sessions/:sessionId/events")
  streamEvents(@Param("sessionId") sessionId: string): Observable<MessageEvent<AgentStreamEvent>> {
    const state = this.sessionHost.turnState(sessionId);
    return this.events.stream(sessionId, state.bufferedEvents);
  }

  @Get("/sessions/:sessionId/turn-state")
  turnState(@Param("sessionId") sessionId: string) {
    return TurnStateSchema.parse(this.sessionHost.turnState(sessionId));
  }

  @Post("/sessions/:sessionId/cancel")
  async cancelTurn(@Param("sessionId") sessionId: string) {
    return { ok: await this.sessionHost.cancel(sessionId) };
  }

  @Post("/sessions/:sessionId/steer")
  async steerTurn(@Req() httpRequest: AuthenticatedRequest, @Param("sessionId") sessionId: string, @Body() body: unknown) {
    const request = parseBody(SteerTurnRequestSchema, body);
    const session = await this.store.getSession(sessionId);
    const runtimeAttachments = await this.files.runtimeAttachments(tenantIdFromRequest(httpRequest), httpRequest.auth!.user.id, request.attachments ?? [], { taskId: session.taskId, sessionId });
    const message = await this.store.appendMessage(sessionId, { role: "user", parts: userMessageParts(request.input, request.attachments) });
    await this.files.associateInputFiles(tenantIdFromRequest(httpRequest), httpRequest.auth!.user.id, {
      fileIds: runtimeAttachments.flatMap((attachment) => attachment.fileId ? [attachment.fileId] : []),
      taskId: session.taskId,
      sessionId,
      messageId: message.id,
    });
    return this.sessionHost.steer(sessionId, request.input, imagesFromAttachments(runtimeAttachments), normalizeAttachments(runtimeAttachments));
  }

  @Get("/sessions/:sessionId/follow-ups")
  listFollowUps(@Req() httpRequest: AuthenticatedRequest, @Param("sessionId") sessionId: string) {
    return this.store.listFollowUps(sessionId, httpRequest.auth?.user.id ?? null);
  }

  @Post("/sessions/:sessionId/follow-ups/reorder")
  async reorderFollowUps(@Req() httpRequest: AuthenticatedRequest, @Param("sessionId") sessionId: string, @Body() body: unknown) {
    const request = parseBody(ReorderFollowUpsRequestSchema, body);
    const reordered = await this.store.reorderFollowUps(sessionId, request.followUpIds, httpRequest.auth?.user.id ?? null);
    if (this.sessionHost.turnState(sessionId).active) await this.#synchronizeFollowUpQueue(httpRequest, sessionId);
    return reordered;
  }

  @Post("/sessions/:sessionId/follow-ups")
  async followUpTurn(@Req() httpRequest: AuthenticatedRequest, @Param("sessionId") sessionId: string, @Body() body: unknown) {
    const request = parseBody(SteerTurnRequestSchema, body);
    const session = await this.store.getSession(sessionId);
    const runtimeAttachments = await this.files.runtimeAttachments(tenantIdFromRequest(httpRequest), httpRequest.auth!.user.id, request.attachments ?? [], { taskId: session.taskId, sessionId });
    const queued = await this.store.createFollowUp({ taskId: session.taskId, sessionId, input: request.input, ...(request.attachments ? { attachments: request.attachments } : {}) }, httpRequest.auth?.user.id ?? null);
    const message = await this.store.appendMessage(sessionId, { role: "user", parts: userMessageParts(request.input, request.attachments) });
    await this.files.associateInputFiles(tenantIdFromRequest(httpRequest), httpRequest.auth!.user.id, {
      fileIds: runtimeAttachments.flatMap((attachment) => attachment.fileId ? [attachment.fileId] : []),
      taskId: session.taskId,
      sessionId,
      messageId: message.id,
    });
    try {
      await this.#synchronizeFollowUpQueue(httpRequest, sessionId);
      return queued;
    } catch (cause) {
      await this.store.updateFollowUp(queued.id, { status: "failed", error: cause instanceof Error ? cause.message : "Unable to queue follow-up" }, httpRequest.auth?.user.id ?? null);
      throw cause;
    }
  }

  @Post("/follow-ups/:followUpId/steer")
  async steerFollowUp(@Req() httpRequest: AuthenticatedRequest, @Param("followUpId") followUpId: string) {
    const followUp = await this.store.updateFollowUp(followUpId, { status: "removed" }, httpRequest.auth?.user.id ?? null);
    try {
      await this.#synchronizeFollowUpQueue(httpRequest, followUp.sessionId);
      const session = await this.store.getSession(followUp.sessionId);
      const attachments = await this.files.runtimeAttachments(
        tenantIdFromRequest(httpRequest),
        httpRequest.auth!.user.id,
        followUp.attachments,
        { taskId: session.taskId, sessionId: followUp.sessionId },
      );
      return this.sessionHost.steer(followUp.sessionId, followUp.input, imagesFromAttachments(attachments), normalizeAttachments(attachments));
    } catch (cause) {
      await this.store.updateFollowUp(followUp.id, { status: "queued", error: cause instanceof Error ? cause.message : "Unable to steer this queued prompt" }, httpRequest.auth?.user.id ?? null);
      if (this.sessionHost.turnState(followUp.sessionId).active) {
        await this.#synchronizeFollowUpQueue(httpRequest, followUp.sessionId).catch(() => undefined);
      }
      throw cause;
    }
  }

  @Delete("/follow-ups/:followUpId")
  async removeFollowUp(@Req() httpRequest: AuthenticatedRequest, @Param("followUpId") followUpId: string) {
    const removed = await this.store.updateFollowUp(followUpId, { status: "removed" }, httpRequest.auth?.user.id ?? null);
    if (this.sessionHost.turnState(removed.sessionId).active) await this.#synchronizeFollowUpQueue(httpRequest, removed.sessionId);
    return removed;
  }

  @Get("/approvals")
  async listApprovals() {
    const now = new Date().toISOString();
    const detailed = this.sessionHost.pendingApprovals?.() ?? [];
    if (detailed.length > 0) {
      return Promise.all(detailed.map(async (approval) => {
        const session = await this.store.getSession(approval.sessionId);
        return {
          id: approval.id,
          taskId: session.taskId,
          toolCallId: null,
          kind: approval.kind,
          status: "pending" as const,
          request: { title: approval.title, detail: approval.detail },
          createdAt: now,
          decidedAt: null,
        };
      }));
    }
    return this.sessionHost.pendingApprovalIds().map((id) => ({
      id,
      taskId: null,
      toolCallId: null,
      kind: "shell",
      status: "pending",
      request: {
        title: "Approval required",
        detail: "Open the task thread for full approval details.",
      },
      createdAt: now,
      decidedAt: null,
    }));
  }

  @Post("/approvals/:approvalId/decision")
  decideApproval(@Param("approvalId") approvalId: string, @Body() body: unknown) {
    const request = parseBody(ApprovalDecisionRequestSchema, body);
    const decision = normalizeDecision(request.decision);
    return { ok: this.sessionHost.resolveApproval(approvalId, decision) };
  }

  @Get("/devices")
  listDevices(@Req() httpRequest: AuthenticatedRequest) {
    return this.mobileDevices.list({
      tenantId: tenantIdFromRequest(httpRequest),
      userId: httpRequest.auth?.user.id ?? null,
    });
  }

  @Post("/devices")
  registerDevice(@Req() httpRequest: AuthenticatedRequest, @Body() body: unknown) {
    const request = parseBody(MobileDeviceRegistrationCreateSchema, body);
    return this.mobileDevices.register({
      ...request,
      tenantId: tenantIdFromRequest(httpRequest),
      userId: httpRequest.auth?.user.id ?? null,
    });
  }

  @Delete("/devices/:deviceId")
  async deleteDevice(@Req() httpRequest: AuthenticatedRequest, @Param("deviceId") deviceId: string) {
    return {
      ok: await this.mobileDevices.disable({
        tenantId: tenantIdFromRequest(httpRequest),
        userId: httpRequest.auth?.user.id ?? null,
        deviceId,
      }),
    };
  }

  @Post("/approvals/:approvalId/notify-devices")
  async notifyDevices(@Req() httpRequest: AuthenticatedRequest, @Param("approvalId") approvalId: string) {
    const devices = await this.mobileDevices.list({
      tenantId: tenantIdFromRequest(httpRequest),
      userId: httpRequest.auth?.user.id ?? null,
    });
    return this.companionPush.dispatchApproval({ devices, approvalId });
  }
}

async function imageToolResult(result: {
  model?: string | undefined;
  data: Array<{ url?: string | undefined; b64_json?: string | undefined; revised_prompt?: string | undefined }>;
}) {
  const data = await Promise.all(result.data.map(async (item) => {
    if (item.b64_json) return { data: item.b64_json, mimeType: "image/png" };
    if (!item.url) throw new Error("The image provider returned no image data");
    const response = await fetch(item.url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Unable to download generated image (${response.status})`);
    const mimeType = response.headers.get("content-type")?.split(";", 1)[0]?.trim() || "image/png";
    return { data: Buffer.from(await response.arrayBuffer()).toString("base64"), mimeType };
  }));
  const revisedPrompt = result.data.find((item) => item.revised_prompt)?.revised_prompt;
  return {
    ...(result.model ? { model: result.model } : {}),
    ...(revisedPrompt ? { revisedPrompt } : {}),
    data,
  };
}

function normalizeDecision(decision: z.infer<typeof ApprovalDecisionSchema>["decision"]): ApprovalDecisionKind {
  if (decision === "approve") return "approved_once";
  if (decision === "deny") return "denied";
  return decision;
}

function parseBody<TSchema extends z.ZodTypeAny>(schema: TSchema, body: unknown): z.infer<TSchema> {
  const result = schema.safeParse(body);
  if (!result.success) throw new BadRequestException(result.error.flatten());
  return result.data;
}

function tenantIdFromRequest(_request: AuthenticatedRequest): string {
  // This distribution is a dedicated, single-organization deployment. Never
  // trust a browser-supplied tenant header as a budget or audit boundary.
  return process.env.BERRY_TENANT_ID?.trim() || SELF_HOST_TENANT_ID;
}

function userMessageParts(input: string, attachments: z.infer<typeof AttachmentInputSchema>[] | undefined) {
  return [
    { kind: "text" as const, content: input as JsonValue },
    ...(attachments ?? []).map((attachment) => ({
      kind: "attachment" as const,
      content: messageAttachmentContent(attachment) as JsonValue,
    })),
  ];
}

function normalizeAttachments(attachments: Array<z.infer<typeof AttachmentInputSchema> & { remoteUrl?: string | null }> | undefined) {
  return attachments?.map((attachment) => ({
    id: attachment.id ?? `attachment_${randomUUID()}`,
    ...(attachment.fileId ? { fileId: attachment.fileId } : {}),
    name: attachment.name,
    mediaType: attachment.mediaType,
    size: attachment.size,
    dataUrl: attachment.dataUrl ?? null,
    textContent: attachment.textContent ?? null,
    localPath: null,
    remoteUrl: attachment.remoteUrl ?? null,
    sourceKind: attachment.sourceKind ?? "web-upload",
  }));
}

function imagesFromAttachments(attachments: z.infer<typeof AttachmentInputSchema>[] | undefined) {
  return (attachments ?? []).flatMap((attachment) => {
    if (!attachment.mediaType.startsWith("image/") || !attachment.dataUrl) return [];
    const match = /^data:([^;,]+);base64,(.+)$/s.exec(attachment.dataUrl);
    if (!match) return [];
    return [{ type: "image" as const, data: match[2]!, mimeType: match[1] ?? attachment.mediaType }];
  });
}

function conversationKindFromTask(task: { conversationKind: ConversationKind }): ConversationKind {
  return task.conversationKind;
}

function modelGovernanceMessage(reason: string): string {
  if (reason === "mode_default_enforced") return "The organization enforces a different default model for this mode.";
  if (reason === "model_blocked") return "The requested model is blocked by organization policy.";
  if (reason === "mode_not_allowed") return "The requested model is not allowed for this mode.";
  if (reason === "not_in_enforced_allowlist") return "The requested model is not in the organization allow-list.";
  return "The requested model is not allowed by organization policy.";
}

function imageUsageEvent(input: {
  requestId: string;
  httpRequest: AuthenticatedRequest;
  image: { providerId: string; model: string };
  request: { prompt: string; size?: string | undefined };
  actualCostMicros: bigint;
  startedAt: number;
  status: "completed" | "failed";
}) {
  return {
    requestId: input.requestId,
    userId: input.httpRequest.auth?.user.id ?? null,
    departmentId: null,
    workspaceId: null,
    taskId: null,
    sessionId: null,
    toolCallId: null,
    feature: "image.generate",
    provider: input.image.providerId,
    model: input.image.model,
    tokensIn: 0,
    tokensOut: 0,
    tokensCached: 0,
    sandboxUsage: {},
    costRawMicros: input.actualCostMicros.toString(),
    costBilledMicros: input.actualCostMicros.toString(),
    latencyMs: Date.now() - input.startedAt,
    ttftMs: null,
    status: input.status,
    metadata: { size: input.request.size ?? "1024x1024", promptLength: input.request.prompt.length },
    ts: new Date().toISOString(),
  };
}
