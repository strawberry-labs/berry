import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Headers, Inject, Param, Patch, Post, Put, Query, Req, Sse } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { SELF_HOST_TENANT_ID } from "@berry/db";
import {
  AgentStreamEventSchema,
  ApprovalDecisionSchema,
  AttachmentInputSchema,
  ConversationKindSchema,
  IMAGE_ASPECT_RATIO_DIMENSIONS,
  JsonValueSchema,
  messageAttachmentContent,
  MessagePartKindSchema,
  MessageRoleSchema,
  MobileDeviceRegistrationCreateSchema,
  PermissionModeSchema,
  QuestionAnswerSchema,
  resolveModelCapabilities,
  TaskStatusSchema,
  TurnStateSchema,
  WorkspaceKindSchema,
  type AgentStreamEvent,
  type ConversationKind,
  type ImageGenerationRequest,
  type JsonValue,
  type Message,
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
import { KnowledgeService } from "../knowledge/knowledge.service.ts";
import { ContextAssemblyService } from "../memory/context-assembly.service.ts";
import { MemoryService } from "../memory/memory.service.ts";
import { DurableTurnService } from "../runtime/durable-turn.service.ts";

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

const UpdateWorkspaceRequestSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  pinned: z.boolean().optional(),
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
  messageId: z.string().uuid().optional(),
  role: MessageRoleSchema.default("user"),
  parts: z.array(z.object({
    kind: MessagePartKindSchema,
    content: JsonValueSchema,
  })).min(1),
}).strict();

function interruptedAssistantParts(events: AgentStreamEvent[]): Array<{ kind: "text" | "reasoning"; content: string }> {
  let text = "";
  let reasoning = "";
  for (const event of events) {
    if (event.kind !== "message.delta") continue;
    if (event.channel === "reasoning") reasoning += event.delta;
    else text += event.delta;
  }
  const parts: Array<{ kind: "text" | "reasoning"; content: string }> = [];
  if (reasoning.trim()) parts.push({ kind: "reasoning", content: reasoning });
  if (text.trim()) parts.push({ kind: "text", content: text });
  // Some providers do not send a partial message before acknowledging abort.
  // Keep an assistant boundary in the transcript even in that case.
  if (parts.length === 0) parts.push({ kind: "reasoning", content: "Response interrupted." });
  return parts;
}

const StartTurnRequestSchema = z.object({
  input: z.string().min(1).optional(),
  continueInterruptedTurn: z.boolean().optional(),
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
}).passthrough().superRefine((request, context) => {
  if (request.continueInterruptedTurn) {
    if (request.input !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["input"], message: "A continued turn must not include new user input" });
    }
    if (request.attachments !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["attachments"], message: "A continued turn must not include new attachments" });
    }
    if (request.replaceFromMessageId !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["replaceFromMessageId"], message: "A continued turn cannot replace an earlier message" });
    }
    return;
  }
  if (request.input === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["input"], message: "A new turn requires user input" });
  }
});

const SteerTurnRequestSchema = z.object({
  messageId: z.string().uuid(),
  input: z.string().trim().min(1),
  attachments: z.array(AttachmentInputSchema).max(100).optional(),
}).strict();

const PublicImageGenerationRequestSchema = z.object({
  prompt: z.string().trim().min(1).max(32_000),
  size: z.string().regex(/^\d{2,5}x\d{2,5}$/).optional(),
  aspectRatio: z.enum(["1:1", "3:4", "4:3", "9:16", "16:9"]).optional(),
  transparentBackground: z.boolean().optional(),
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
const RecoveryActionSchema = z.object({
  action: z.enum(["retry", "mark-complete", "cancel"]),
}).strict();

const WorkspaceFileRequestSchema = z.object({ path: z.string().trim().min(1).max(4_096), content: z.string().max(1_048_576) }).strict();
const TerminalCreateRequestSchema = z.object({ cols: z.number().int().min(20).max(500).default(80), rows: z.number().int().min(5).max(200).default(24) }).strict();
const TerminalInputRequestSchema = z.object({ input: z.string().min(1).max(16_384), approved: z.boolean().default(false) }).strict();
const TerminalResizeRequestSchema = z.object({ cols: z.number().int().min(20).max(500), rows: z.number().int().min(5).max(200) }).strict();
const PreviewRequestSchema = z.object({ port: z.number().int().min(1).max(65_535), approved: z.boolean().default(false) }).strict();

@Controller("/v1")
export class AgentApiController {
  readonly #projectionWrites = new Map<string, Promise<void>>();
  readonly #steerWrites = new Map<string, Promise<{ queued: true; message: Message }>>();
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
    @Inject(KnowledgeService) private readonly knowledge: KnowledgeService,
    @Inject(MemoryService) private readonly memory: MemoryService,
    @Inject(ContextAssemblyService) private readonly contextAssembly: ContextAssemblyService,
    @Inject(DurableTurnService) private readonly durableTurns: DurableTurnService,
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

  @Get("/models/catalog")
  async modelCatalog(@Req() httpRequest: AuthenticatedRequest) {
    const catalog = this.runtimeConfig.catalog();
    if (!catalog) return null;
    const effective = await this.organizationCapabilities.effective(tenantIdFromRequest(httpRequest), httpRequest.auth?.user.id ?? "");
    return { ...catalog, skills: [...catalog.skills, ...effective.skills.map((skill) => ({ id: skill.filePath, name: skill.name, description: skill.description, enabled: true }))], mcpServers: [...catalog.mcpServers, ...effective.mcpServers.flatMap((server) => server.url ? [{ id: server.id, name: server.name, url: server.url, auth: server.credential ? "bearer" as const : "none" as const, enabled: server.enabled }] : [])] };
  }

  @Post("/images/generations")
  async generateImage(
    @Req() httpRequest: AuthenticatedRequest,
    @Body() body: unknown,
    onPartial?: (partial: { index: number; b64: string; mimeType: string }) => void,
  ) {
    const request = parseBody(PublicImageGenerationRequestSchema, body);
    return this.#generateImageRequest(httpRequest, request, onPartial);
  }

  async #generateImageRequest(
    httpRequest: AuthenticatedRequest,
    request: ImageGenerationRequest,
    onPartial?: (partial: { index: number; b64: string; mimeType: string }) => void,
  ) {
    const image = this.runtimeConfig.imageGenerationInfo();
    if (!image) return this.runtimeConfig.generateImage(request, onPartial);
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
      result = await this.runtimeConfig.generateImage(request, onPartial);
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

  @Patch("/workspaces/:workspaceId")
  async updateWorkspace(@Req() httpRequest: AuthenticatedRequest, @Param("workspaceId") workspaceId: string, @Body() body: unknown) {
    return this.store.updateWorkspace(workspaceId, parseBody(UpdateWorkspaceRequestSchema, body), httpRequest.auth?.user.id ?? null);
  }

  @Delete("/workspaces/:workspaceId")
  async deleteWorkspace(@Req() httpRequest: AuthenticatedRequest, @Param("workspaceId") workspaceId: string) {
    return this.store.removeWorkspace(workspaceId, httpRequest.auth?.user.id ?? null);
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
      if (this.durableTurns.enabled) {
        const durableState = await this.durableTurns.state(
          tenantIdFromRequest(httpRequest),
          task.activeSessionId,
        );
        if (durableState.active) return task;
        const durableTerminal = [...durableState.bufferedEvents].reverse()
          .find((event) => event.kind === "turn.end");
        if (durableTerminal?.kind === "turn.end") {
          return this.store.updateTask(
            task.id,
            { status: durableTerminal.status },
            httpRequest.auth?.user.id ?? null,
          );
        }
        // A missing/expired API process is not evidence that a durable worker
        // run is dead. Leave reconciliation to the persisted run lease/state.
        return task;
      }
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
  async createSession(@Req() httpRequest: AuthenticatedRequest, @Param("taskId") taskId: string, @Body() body: unknown) {
    await this.store.getTask(taskId, httpRequest.auth?.user.id ?? null);
    const request = parseBody(CreateSessionRequestSchema, body ?? {});
    return this.store.createSession({
      taskId,
      parentSessionId: request.parentSessionId,
      permissionMode: request.permissionMode,
    });
  }

  @Get("/sessions/:sessionId/messages")
  async listMessages(@Req() httpRequest: AuthenticatedRequest, @Param("sessionId") sessionId: string) {
    await this.ownedSession(httpRequest, sessionId);
    await this.#projectionWrites.get(sessionId);
    return this.store.listMessages(sessionId);
  }

  @Post("/sessions/:sessionId/messages")
  async appendMessage(@Req() request: AuthenticatedRequest, @Param("sessionId") sessionId: string, @Body() body: unknown) {
    await this.ownedSession(request, sessionId);
    const input = parseBody(AppendMessageRequestSchema, body);
    const message = await this.store.appendMessage(sessionId, {
      id: input.messageId,
      role: input.role,
      parts: input.parts,
    });
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
    const { session, task } = await this.ownedSession(httpRequest, sessionId);
    if (request.continueInterruptedTurn) {
      await this.assertContinuableTurn(sessionId);
    }
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
    const [groundingContext, portableCheckpoint] = await Promise.all([
      this.contextAssembly.assemble({
        tenantId,
        userId: httpRequest.auth!.user.id,
        workspaceId: request.workspaceId ?? task.workspaceId,
        taskId: task.id,
        sessionId,
        request: request.input ?? task.title,
        taskTitle: task.title,
      }),
      this.contextAssembly.portableCheckpoint(tenantId, sessionId),
    ]);
    let runtimeImageAttachments: RuntimeImageReference[] = [];
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
      groundingContext,
      ...(portableCheckpoint ? { portableCheckpoint } : {}),
      memory: {
        remember: async (input: {
          scope: "personal" | "project";
          kind: string;
          stableKey?: string;
          content: string;
          value?: Record<string, unknown>;
          expiresAt?: string | null;
        }) => {
          const result = await this.memory.remember({
            tenantId,
            userId: httpRequest.auth!.user.id,
            scope: input.scope,
            ...(input.scope === "project" ? { workspaceId: request.workspaceId ?? task.workspaceId } : {}),
            kind: input.kind,
            ...(input.stableKey ? { stableKey: input.stableKey } : {}),
            content: input.content,
            ...(input.value ? { value: input.value } : {}),
            ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
            source: { taskId: task.id, sessionId },
          });
          return {
            operation: result.operation,
            reason: result.reason,
            memoryId: result.item?.id ?? null,
          };
        },
        forget: async (input: {
          memoryId?: string;
          stableKey?: string;
          scope?: "personal" | "project";
        }) => {
          const forgotten = input.memoryId
            ? await this.memory.forget(tenantId, httpRequest.auth!.user.id, input.memoryId)
            : input.stableKey
              ? await this.memory.forgetMatching({
                  tenantId,
                  userId: httpRequest.auth!.user.id,
                  scope: input.scope ?? "personal",
                  ...(input.scope === "project" ? { workspaceId: request.workspaceId ?? task.workspaceId } : {}),
                  stableKey: input.stableKey,
                })
              : null;
          return { forgotten: Boolean(forgotten), memoryId: forgotten?.id ?? null };
        },
      },
      ...(this.runtimeConfig.imageGenerationInfo() ? {
        imageGeneration: {
          generate: async ({ prompt, size, aspectRatio, transparentBackground, referenceImagePaths, referencedImageIds, onPartial }: {
            prompt: string;
            model?: string;
            size?: string;
            aspectRatio?: "1:1" | "3:4" | "4:3" | "9:16" | "16:9";
            transparentBackground?: boolean;
            referenceImagePaths?: string[];
            referencedImageIds?: string[];
            onPartial?: (partial: { index: number; b64: string; mimeType: string }) => void;
            signal?: AbortSignal;
          }) => {
            const referenceImageUrls = resolveImageReferenceUrls(
              runtimeImageAttachments,
              referenceImagePaths ?? [],
              referencedImageIds ?? [],
            );
            const result = await this.#generateImageRequest(httpRequest, {
              prompt,
              ...(size ? { size } : {}),
              ...(aspectRatio ? { aspectRatio } : {}),
              ...(transparentBackground ? { transparentBackground: true } : {}),
              ...(referenceImageUrls.length > 0 ? { referenceImageUrls } : {}),
              stream: true,
              partialImages: 3,
            }, onPartial);
            return imageToolResult(result);
          },
        },
      } : {}),
    };
    const governedModel = resolvedRuntime.provider.models?.find((candidate) => candidate.id === governedRequest.model);
    const contextWindowTokens = resolveModelCapabilities(governedModel).context?.windowTokens
      ?? 200_000;
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
    let usage: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      cacheCreationTokens1h: number;
      cacheCreationTokens5m: number;
      cacheEligible: boolean;
      cacheProvider: string | null;
      cacheKeyHash: string | null;
      promptManifestHash: string | null;
      promptManifest: JsonValue | null;
      promptManifests: JsonValue[];
      cacheMissReason: string | null;
      cacheMissComponentId: string | null;
      provider: string | null;
      model: string | null;
    } | undefined;
    let assistantErrorPersisted = false;
    if (request.replaceFromMessageId) {
      await this.rewindForEdit(sessionId, request.replaceFromMessageId, request.input ?? "", request.attachments);
    }
    if (this.durableTurns.enabled) {
      try {
        const admitted = await this.durableTurns.admit({
          tenantId,
          userId: httpRequest.auth!.user.id,
          workspaceId: governedRequest.workspaceId ?? task.workspaceId,
          taskId: task.id,
          sessionId,
          requestId,
          input: request.continueInterruptedTurn ? "" : request.input ?? "",
          ...(request.attachments ? { attachments: request.attachments } : {}),
          runtimeRequest: {
            providerId,
            model: governedRequest.model ?? null,
            workspacePath: request.workspacePath,
            workspaceId: governedRequest.workspaceId ?? task.workspaceId,
            permissionMode: governedRequest.permissionMode ?? session.permissionMode,
            reasoning: governedRequest.reasoning ?? "off",
            maxTokens: governedRequest.maxTokens ?? 8_000,
            contextWindowTokens,
            networkPolicy: governedRequest.networkPolicy,
            attachments: (request.attachments ?? []).map((attachment) => ({
              id: attachment.id,
              fileId: attachment.fileId,
              name: attachment.name,
              mediaType: attachment.mediaType,
              size: attachment.size,
              sourceKind: attachment.sourceKind,
            })),
            ...(portableCheckpoint ? { portableCheckpoint } : {}),
          },
          groundingContext: groundingContext as unknown as JsonValue,
        });
        return { turnId: admitted.runId, sessionId };
      } catch (error) {
        await this.budgets.reconcile({ tenantId, requestId, actualCostMicros: 0n, usage });
        throw error;
      }
    }
    try {
      await this.store.updateTask(task.id, { status: "running" });
      const runtimeAttachments = await this.files.runtimeAttachments(tenantId, httpRequest.auth!.user.id, governedRequest.attachments ?? [], { taskId: task.id, sessionId });
      runtimeImageAttachments = runtimeAttachments;
      let activeTurnId: string | undefined;
      const { turnId } = this.sessionHost.startTurn({
        ...governedRequest,
        tenantId,
        input: request.continueInterruptedTurn ? "" : request.input ?? "",
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
            status: message.status,
            inputTokens: message.usage?.inputTokens ?? 0,
            outputTokens: message.usage?.outputTokens ?? 0,
            // Older or non-streaming providers can omit a decode duration.
            // Preserve their end-to-end turn duration so the thread can still
            // render a useful rate after the projection is reloaded.
            generationMs: message.generationMs && message.generationMs > 0
              ? message.generationMs
              : Math.max(1, Date.now() - startedAt),
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
          if (call.toolName === "create_image" && call.status === "completed") {
            const output = call.output && typeof call.output === "object" && !Array.isArray(call.output)
              ? call.output as Record<string, unknown>
              : null;
            const generatedImages = normalizedGeneratedImages(output);
            if (generatedImages.length > 0) {
              this.#queueProjectionWrite(sessionId, async () => {
                const parts = await Promise.all(generatedImages.map(async (generated, index) => {
                  const extension = generated.mimeType === "image/webp" ? "webp" : generated.mimeType === "image/jpeg" ? "jpg" : "png";
                  const title = generated.title || `image-gen-${index + 1}`;
                  try {
                    const stored = await this.files.persistGeneratedImage(tenantId, httpRequest.auth!.user.id, {
                      name: `${safeGeneratedImageName(title)}.${extension}`,
                      mediaType: generated.mimeType,
                      data: generated.data,
                      taskId: task.id,
                      sessionId,
                      ...(activeTurnId ? { turnId: activeTurnId } : {}),
                    });
                    return {
                      kind: "image" as const,
                      content: {
                        src: stored.previewUrl,
                        fileId: stored.id,
                        title,
                        prompt: generated.prompt,
                        ...(generated.revisedPrompt ? { revisedPrompt: generated.revisedPrompt } : {}),
                        aspectRatio: generated.aspectRatio,
                        width: generated.width,
                        height: generated.height,
                        mimeType: generated.mimeType,
                        sizeBytes: stored.size,
                        transparentBackground: generated.transparentBackground,
                        ...(generated.generationId ? { generationId: generated.generationId } : {}),
                        downloadUrl: stored.downloadUrl,
                      } as JsonValue,
                    };
                  } catch {
                    return {
                      kind: "image" as const,
                      content: {
                        src: `data:${generated.mimeType};base64,${generated.data}`,
                        title,
                        prompt: generated.prompt,
                        ...(generated.revisedPrompt ? { revisedPrompt: generated.revisedPrompt } : {}),
                        aspectRatio: generated.aspectRatio,
                        width: generated.width,
                        height: generated.height,
                        mimeType: generated.mimeType,
                        sizeBytes: generated.sizeBytes,
                        transparentBackground: generated.transparentBackground,
                        ...(generated.generationId ? { generationId: generated.generationId } : {}),
                      } as JsonValue,
                    };
                  }
                }));
                return this.store.appendMessage(sessionId, { role: "assistant", parts });
              });
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
              status: "failed",
              parts: [{ kind: "error", content: parsed.message }],
            }));
          }
          if (parsed.kind === "usage") {
            actualCostMicros = usageCostMicros(parsed, actualCostMicros, governedRequest.provider);
            usage = {
              inputTokens: (usage?.inputTokens ?? 0) + parsed.inputTokens,
              outputTokens: (usage?.outputTokens ?? 0) + parsed.outputTokens,
              cacheReadTokens: (usage?.cacheReadTokens ?? 0) + (parsed.cacheReadTokens ?? 0),
              cacheWriteTokens: (usage?.cacheWriteTokens ?? 0) + (parsed.cacheWriteTokens ?? 0),
              cacheCreationTokens1h: (usage?.cacheCreationTokens1h ?? 0) + (parsed.cacheCreationTokens1h ?? 0),
              cacheCreationTokens5m: (usage?.cacheCreationTokens5m ?? 0) + (parsed.cacheCreationTokens5m ?? 0),
              cacheEligible: (usage?.cacheEligible ?? false) || (parsed.cacheEligible ?? false),
              cacheProvider: parsed.cacheProvider ?? usage?.cacheProvider ?? null,
              cacheKeyHash: parsed.cacheKeyHash ?? usage?.cacheKeyHash ?? null,
              promptManifestHash: parsed.promptManifestHash ?? usage?.promptManifestHash ?? null,
              promptManifest: (parsed.promptManifest as unknown as JsonValue | undefined) ?? usage?.promptManifest ?? null,
              promptManifests: [
                ...(usage?.promptManifests ?? []),
                ...(parsed.promptManifest ? [parsed.promptManifest as unknown as JsonValue] : []),
              ].slice(-64),
              cacheMissReason: parsed.cacheReadTokens && parsed.cacheReadTokens > 0
                ? null
                : parsed.cacheMissReason ?? usage?.cacheMissReason ?? null,
              cacheMissComponentId: parsed.cacheMissComponentId ?? usage?.cacheMissComponentId ?? null,
              provider: parsed.servedProvider ?? usage?.provider ?? providerId,
              model: parsed.servedModel ?? parsed.model ?? usage?.model ?? governedRequest.model ?? null,
            };
          }
          this.events.publish(sessionId, parsed);
          if (parsed.kind === "turn.end") {
            this.#queueProjectionWrite(sessionId, async () => {
              await this.store.updateTask(task.id, { status: parsed.status });
              if (parsed.status === "completed") {
                await Promise.all([
                  this.knowledge.enqueueTaskOutcome({
                    tenantId,
                    workspaceId: governedRequest.workspaceId ?? task.workspaceId,
                    taskId: task.id,
                    sessionId,
                    revision: parsed.turnId,
                  }),
                  this.memory.enqueueExtraction({
                    tenantId,
                    userId: httpRequest.auth!.user.id,
                    workspaceId: governedRequest.workspaceId ?? task.workspaceId,
                    taskId: task.id,
                    sessionId,
                    revision: parsed.turnId,
                  }),
                ]);
              }
            });
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
                tokensCached: usage?.cacheReadTokens ?? 0,
                cacheReadTokens: usage?.cacheReadTokens ?? 0,
                cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
                cacheCreationTokens1h: usage?.cacheCreationTokens1h ?? 0,
                cacheCreationTokens5m: usage?.cacheCreationTokens5m ?? 0,
                cacheEligible: usage?.cacheEligible ?? false,
                cacheProvider: usage?.cacheProvider ?? null,
                cacheKeyHash: usage?.cacheKeyHash ?? null,
                promptManifestHash: usage?.promptManifestHash ?? null,
                cacheMissReason: usage?.cacheMissReason ?? null,
                sandboxUsage: {},
                costRawMicros: actualCostMicros.toString(),
                costBilledMicros: actualCostMicros.toString(),
                latencyMs: Date.now() - startedAt,
                ttftMs: null,
                status: parsed.status,
                metadata: {
                  mode,
                  ...(usage?.promptManifest ? { promptManifest: usage.promptManifest } : {}),
                  ...(usage?.promptManifests.length ? { promptManifests: usage.promptManifests } : {}),
                  ...(usage?.cacheMissComponentId ? { cacheMissComponentId: usage.cacheMissComponentId } : {}),
                },
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

  private async assertContinuableTurn(sessionId: string): Promise<void> {
    if (this.sessionHost.turnState(sessionId).active) {
      throw new BadRequestException("This task is already running");
    }
    await this.#projectionWrites.get(sessionId);
    const messages = await this.store.listMessages(sessionId);
    const latestMessage = messages.at(-1);
    if (!latestMessage || latestMessage.role !== "assistant" || !["failed", "cancelled"].includes(latestMessage.status)) {
      throw new BadRequestException("Only a failed or cancelled assistant turn can be continued");
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
  async answerQuestion(
    @Req() httpRequest: AuthenticatedRequest,
    @Param("questionId") questionId: string,
    @Body() body: unknown,
  ) {
    const request = parseBody(AnswerQuestionRequestSchema, body);
    if (this.durableTurns.enabled) {
      return {
        ok: await this.durableTurns.answerQuestion(
          tenantIdFromRequest(httpRequest),
          httpRequest.auth!.user.id,
          questionId,
          request,
        ),
      };
    }
    return {
      ok: this.sessionHost.resolveQuestion(questionId, {
        answer: request.answer,
        selectedOptions: request.selectedOptions ?? [],
        ...(request.answers ? { answers: request.answers } : {}),
      }),
    };
  }

  @Sse("/sessions/:sessionId/events")
  async streamEvents(
    @Req() httpRequest: AuthenticatedRequest,
    @Param("sessionId") sessionId: string,
    @Headers("last-event-id") lastEventId?: string,
    @Query("cursor") cursor?: string,
  ): Promise<Observable<MessageEvent<AgentStreamEvent>>> {
    await this.ownedSession(httpRequest, sessionId);
    if (this.durableTurns.enabled) {
      return this.events.streamDurable(
        tenantIdFromRequest(httpRequest),
        sessionId,
        cursor ?? lastEventId ?? null,
      );
    }
    const state = this.sessionHost.turnState(sessionId);
    return this.events.stream(sessionId, state.bufferedEvents);
  }

  @Get("/sessions/:sessionId/turn-state")
  async turnState(@Req() httpRequest: AuthenticatedRequest, @Param("sessionId") sessionId: string) {
    await this.ownedSession(httpRequest, sessionId);
    if (this.durableTurns.enabled) {
      return this.durableTurns.state(tenantIdFromRequest(httpRequest), sessionId);
    }
    return TurnStateSchema.parse(this.sessionHost.turnState(sessionId));
  }

  @Post("/sessions/:sessionId/cancel")
  async cancelTurn(@Req() httpRequest: AuthenticatedRequest, @Param("sessionId") sessionId: string) {
    await this.ownedSession(httpRequest, sessionId);
    if (this.durableTurns.enabled) {
      return { ok: await this.durableTurns.cancel(tenantIdFromRequest(httpRequest), sessionId) };
    }
    const turn = this.sessionHost.turnState(sessionId);
    const ok = await this.sessionHost.cancel(sessionId);
    await this.#projectionWrites.get(sessionId);
    if (ok && turn.active) {
      const messages = await this.store.listMessages(sessionId);
      let latestUserIndex = -1;
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index]?.role !== "user") continue;
        latestUserIndex = index;
        break;
      }
      const interruptedAssistants = latestUserIndex === -1
        ? []
        : messages.slice(latestUserIndex + 1).filter((message) => message.role === "assistant");
      // A provider can abort without producing a final assistant message.
      // Persist a cancelled boundary before the next user prompt. If earlier
      // assistant/tool projections exist, the boundary also marks their whole
      // turn as cancelled in the settled UI.
      if (latestUserIndex !== -1 && !interruptedAssistants.some((message) => message.status === "cancelled")) {
        await this.store.appendMessage(sessionId, {
          role: "assistant",
          status: "cancelled",
          parts: interruptedAssistants.length === 0
            ? interruptedAssistantParts(turn.bufferedEvents)
            : [{ kind: "reasoning", content: "Response interrupted." }],
        });
      }
    }
    return { ok };
  }

  @Post("/sessions/:sessionId/steer")
  async steerTurn(@Req() httpRequest: AuthenticatedRequest, @Param("sessionId") sessionId: string, @Body() body: unknown) {
    const request = parseBody(SteerTurnRequestSchema, body);
    const { session } = await this.ownedSession(httpRequest, sessionId);
    const steeringKey = `${sessionId}:${request.messageId}`;
    const inFlight = this.#steerWrites.get(steeringKey);
    if (inFlight) return inFlight;
    const pending = (async (): Promise<{ queued: true; message: Message }> => {
      const existingMessage = (await this.store.listMessages(sessionId)).find((message) => message.id === request.messageId);
      if (existingMessage) return { queued: true, message: existingMessage };
      const runtimeAttachments = await this.files.runtimeAttachments(tenantIdFromRequest(httpRequest), httpRequest.auth!.user.id, request.attachments ?? [], { taskId: session.taskId, sessionId });
      // Only persist the user message after the active runtime accepts it. That
      // keeps a rejected steer recoverable instead of leaving a phantom message
      // in the conversation history.
      const result = await this.sessionHost.steer(sessionId, request.input, imagesFromAttachments(runtimeAttachments), normalizeAttachments(runtimeAttachments));
      const message = await this.store.appendMessage(sessionId, {
        id: request.messageId,
        role: "user",
        parts: userMessageParts(request.input, request.attachments),
      });
      await this.files.associateInputFiles(tenantIdFromRequest(httpRequest), httpRequest.auth!.user.id, {
        fileIds: runtimeAttachments.flatMap((attachment) => attachment.fileId ? [attachment.fileId] : []),
        taskId: session.taskId,
        sessionId,
        messageId: message.id,
      });
      return { ...result, message };
    })().finally(() => {
      if (this.#steerWrites.get(steeringKey) === pending) this.#steerWrites.delete(steeringKey);
    });
    this.#steerWrites.set(steeringKey, pending);
    return pending;
  }

  private async ownedSession(httpRequest: AuthenticatedRequest, sessionId: string) {
    const session = await this.store.getSession(sessionId);
    const task = await this.store.getTask(session.taskId, httpRequest.auth?.user.id ?? null);
    return { session, task };
  }

  @Get("/approvals")
  async listApprovals(@Req() httpRequest: AuthenticatedRequest) {
    if (this.durableTurns.enabled) {
      return this.durableTurns.listApprovals(
        tenantIdFromRequest(httpRequest),
        httpRequest.auth!.user.id,
      );
    }
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
  async decideApproval(
    @Req() httpRequest: AuthenticatedRequest,
    @Param("approvalId") approvalId: string,
    @Body() body: unknown,
  ) {
    const request = parseBody(ApprovalDecisionRequestSchema, body);
    const decision = normalizeDecision(request.decision);
    if (this.durableTurns.enabled) {
      return {
        ok: await this.durableTurns.decideApproval(
          tenantIdFromRequest(httpRequest),
          httpRequest.auth!.user.id,
          approvalId,
          {
            decision: request.decision,
            ...(request.remember !== undefined ? { remember: request.remember } : {}),
            ...(request.reason !== undefined ? { reason: request.reason } : {}),
          },
        ),
      };
    }
    return { ok: this.sessionHost.resolveApproval(approvalId, decision) };
  }

  @Post("/runs/:runId/recovery")
  async recoverTurn(
    @Req() httpRequest: AuthenticatedRequest,
    @Param("runId") runId: string,
    @Body() body: unknown,
  ) {
    const request = parseBody(RecoveryActionSchema, body);
    return {
      ok: await this.durableTurns.recover(
        tenantIdFromRequest(httpRequest),
        httpRequest.auth!.user.id,
        runId,
        request.action,
      ),
    };
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

function normalizedGeneratedImages(output: Record<string, unknown> | null): Array<{
  data: string;
  mimeType: string;
  title: string;
  prompt: string;
  revisedPrompt?: string;
  aspectRatio: "1:1" | "3:4" | "4:3" | "9:16" | "16:9";
  width: number;
  height: number;
  sizeBytes?: number;
  transparentBackground: boolean;
  generationId?: string;
}> {
  const rawItems = Array.isArray(output?.images) ? output.images : [];
  return rawItems.flatMap((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const item = value as Record<string, unknown>;
    const image = item.image && typeof item.image === "object" && !Array.isArray(item.image)
      ? item.image as Record<string, unknown>
      : null;
    const data = typeof image?.data === "string" ? image.data : "";
    if (!data) return [];
    const aspectRatio = item.aspectRatio === "3:4" || item.aspectRatio === "4:3" || item.aspectRatio === "9:16" || item.aspectRatio === "16:9"
      ? item.aspectRatio
      : "1:1";
    const fallbackDimensions = IMAGE_ASPECT_RATIO_DIMENSIONS[aspectRatio];
    return [{
      data,
      mimeType: typeof image?.mimeType === "string" ? image.mimeType : "image/png",
      title: typeof item.title === "string" && item.title.trim() ? item.title.trim() : `image-gen-${index + 1}`,
      prompt: typeof item.prompt === "string" ? item.prompt : "",
      ...(typeof item.revisedPrompt === "string" ? { revisedPrompt: item.revisedPrompt } : {}),
      aspectRatio,
      width: typeof image?.width === "number" ? image.width : fallbackDimensions.width,
      height: typeof image?.height === "number" ? image.height : fallbackDimensions.height,
      ...(typeof image?.sizeBytes === "number" ? { sizeBytes: image.sizeBytes } : {}),
      transparentBackground: item.transparentBackground === true,
      ...(typeof image?.generationId === "string" ? { generationId: image.generationId } : {}),
    }];
  });
}

function safeGeneratedImageName(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\\/\0]/g, "-")
    .replace(/[^\p{L}\p{N}._() -]+/gu, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.(?:png|jpe?g|webp)$/i, "")
    .slice(0, 120) || "generated-image";
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

interface RuntimeImageReference {
  id?: string | undefined;
  fileId?: string | undefined;
  name: string;
  mediaType: string;
  dataUrl?: string | null | undefined;
  remoteUrl?: string | null | undefined;
}

function resolveImageReferenceUrls(
  attachments: RuntimeImageReference[],
  referencePaths: string[],
  referenceIds: string[],
): string[] {
  if (referencePaths.length === 0 && referenceIds.length === 0) return [];
  const ids = new Set(referenceIds.map((id) => id.toLowerCase()));
  const pathHints = referencePaths.map((path) => path.toLowerCase());
  const images = attachments.filter((attachment) => attachment.mediaType.startsWith("image/"));
  const matches = images.filter((attachment) => {
    const attachmentIds = [attachment.id, attachment.fileId].filter((id): id is string => Boolean(id)).map((id) => id.toLowerCase());
    if (attachmentIds.some((id) => ids.has(id))) return true;
    const name = attachment.name.toLowerCase();
    return pathHints.some((path) => attachmentIds.some((id) => path.includes(id)) || path.endsWith(`/${name}`) || path.endsWith(`\\${name}`));
  });
  const selected = matches.length > 0 ? matches : images.length === 1 ? images : [];
  const urls = selected.flatMap((attachment) => attachment.dataUrl
    ? [attachment.dataUrl]
    : attachment.remoteUrl
      ? [attachment.remoteUrl]
      : []);
  if (urls.length === 0) {
    throw new BadRequestException("The referenced image is not attached to this turn or is no longer available");
  }
  return [...new Set(urls)].slice(0, 16);
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
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheCreationTokens1h: 0,
    cacheCreationTokens5m: 0,
    cacheEligible: false,
    cacheProvider: null,
    cacheKeyHash: null,
    promptManifestHash: null,
    cacheMissReason: null,
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
