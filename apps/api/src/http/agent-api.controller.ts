import { BadGatewayException, BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, Headers, HttpException, Inject, NotFoundException, Param, Patch, Post, Put, Query, Req, RequestTimeoutException, ServiceUnavailableException, Sse } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { SELF_HOST_TENANT_ID } from "@berry/db";
import { OpenAIChatCompletionsClient, RouterClientError, type ChatCompletionUsage } from "@berry/router-client";
import {
  AgentStreamEventSchema,
  ApprovalDecisionSchema,
  AttachmentInputSchema,
  ContextStatsSchema,
  ConversationKindSchema,
  DURABLE_BASE_BUILT_IN_TOOLS,
  DurableTurnRuntimeRequestSchema,
  IMAGE_ASPECT_RATIO_DIMENSIONS,
  ISODateSchema,
  JsonValueSchema,
  messageAttachmentContent,
  MessagePartKindSchema,
  MessageRoleSchema,
  MobileDeviceRegistrationCreateSchema,
  PermissionModeSchema,
  PromptImprovementRequestSchema,
  ReasoningLevelSchema,
  resolveModelCapabilities,
  sealDurableSecret,
  TaskStatusSchema,
  TurnIntentSchema,
  TurnStateSchema,
  VISION_ADAPTER_MAX_OUTPUT_TOKENS,
  WorkspaceKindSchema,
  type AgentStreamEvent,
  type ConversationKind,
  type DurableMcpServer,
  type DurableProviderTransport,
  type ImageGenerationRequest,
  type JsonValue,
  type Message,
  type ModelGovernanceDecision,
  type TaskStatus,
} from "@berry/shared";
import type {
  ApprovalDecisionKind,
  BerryModelProviderInfo,
  McpServerSpec,
  StartTurnOptions,
} from "@berry/local-agent";
import { z } from "zod";
import { Observable } from "rxjs";
import { SessionHostService } from "../runtime/session-host.service.ts";
import { CloudRuntimeConfigService } from "../runtime/cloud-runtime-config.ts";
import type { AuthenticatedRequest } from "../auth/auth.guard.ts";
import { BUDGET_SERVICE, budgetEstimateFromRequest, modelCostSnapshot, usageCostMicros, type BudgetService } from "../budget/budget.service.ts";
import { MODEL_GOVERNANCE_SERVICE, type ModelGovernanceService } from "../model-governance/model-governance.service.ts";
import { CLOUD_TASK_STORE, type CloudTaskStore } from "./cloud-task-store.ts";
import { ApiEventStreamService } from "./event-stream.service.ts";
import { CompanionPushService, MOBILE_DEVICE_REGISTRY, type MobileDeviceRegistry } from "./mobile-devices.ts";
import { USAGE_REPOSITORY, type UsageRepository } from "../usage/usage.repository.ts";
import { AUDIT_SERVICE, type AuditService } from "../audit/audit.service.ts";
import { SANDBOX_WORKSPACE_SERVICE, SandboxWorkspaceService } from "./sandbox-workspace.service.ts";
import { ORGANIZATION_CAPABILITIES, OrganizationCapabilitiesService } from "./organization-capabilities.service.ts";
import { PERSONAL_CAPABILITIES, PersonalCapabilitiesService } from "./personal-capabilities.service.ts";
import { FilePlatformService } from "../files/file-platform.service.ts";
import { KnowledgeService } from "../knowledge/knowledge.service.ts";
import { ContextAssemblyService } from "../memory/context-assembly.service.ts";
import { MemoryService } from "../memory/memory.service.ts";
import { DurableTurnService, type DurableTaskActivity } from "../runtime/durable-turn.service.ts";
import { apiRuntimeMetrics } from "../runtime/runtime-metrics.ts";
import {
  ENTERPRISE_IDENTITY_REPOSITORY,
  type EnterpriseIdentityRepository,
} from "../identity/identity.repository.ts";
import { CONNECTORS, ConnectorsService } from "../connectors/connectors.service.ts";

export const PROMPT_IMPROVEMENT_MODEL = "canopywave/deepseek/deepseek-v4-flash";

const PROMPT_IMPROVEMENT_SYSTEM_PROMPT = `You improve a user's draft prompt for another AI assistant.

Return only the improved prompt. Do not answer or execute the prompt. Do not add an introduction, label, explanation, quotation marks, or Markdown fence.
Do not output hidden reasoning or <think> tags.

Make the prompt more effective by:
- stating the goal and requested action clearly;
- adding useful specificity, context, background, target audience, tone, output format, length, constraints, and success criteria when supported by the draft;
- organizing complex work into a clear sequence of tasks or deliverables;
- retaining examples, source references, URLs, paths, code, data, names, and other literal details;
- preserving the user's language, intent, facts, requirements, and safety constraints;
- preserving every required Berry skill token such as $research exactly once or more, unchanged, and incorporating it into the improved instruction;
- keeping it concise enough to avoid unnecessary context and token use.

Never invent facts, requirements, attachments, audiences, deadlines, examples, or preferences the user did not provide. Do not ask the downstream model to reveal hidden chain-of-thought. When reasoning matters, request a concise rationale, verification, or step-by-step result instead.`;

const PROMPT_IMPROVEMENT_TIMEOUT_MS = 30_000;
const PROMPT_IMPROVEMENT_MAX_OUTPUT_TOKENS = 4_096;
const PROMPT_IMPROVEMENT_MIN_OUTPUT_TOKENS = 1_024;
const DEFAULT_MODEL_MAX_OUTPUT_TOKENS = 16_384;
const DEFAULT_DURABLE_ADMISSION_PREPARATION_TIMEOUT_MS = 1_500;
const DURABLE_TASK_WITHOUT_ADMISSION_STALE_MS = 15_000;
const DURABLE_PREPARING_ADMISSION_STALE_MS = 120_000;

const CreateTaskRequestSchema = z.object({
  workspaceId: z.string().min(1).optional(),
  workspaceKind: WorkspaceKindSchema.default("project"),
  // Legacy clients may still send this field. It is intentionally ignored.
  conversationKind: ConversationKindSchema.optional(),
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
  read: z.boolean().optional(),
  readThrough: ISODateSchema.optional(),
}).strict().superRefine((request, context) => {
  if (request.readThrough && request.read !== true) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["readThrough"], message: "readThrough requires read=true" });
  }
});

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

const ContextStatsRequestSchema = z.object({
  model: z.string().trim().min(1).nullable().optional(),
  pendingInput: z.string().optional(),
  attachments: z.array(AttachmentInputSchema).max(100).optional(),
}).strict();

// Keep context reporting aligned with the runtime turn path when a provider
// catalog omits an explicit model context window.
const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;

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

async function retryInlineFinalization(write: () => Promise<void>): Promise<void> {
  let lastError: unknown;
  for (const delayMs of [0, 250, 1_000]) {
    if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    try {
      await write();
      return;
    } catch (cause) {
      lastError = cause;
    }
  }
  throw lastError;
}

const StartTurnRequestSchema = z.object({
  operationId: z.string().uuid().optional(),
  input: z.string().min(1).optional(),
  messageInput: z.string().min(1).optional(),
  requestMessageId: z.string().uuid().optional(),
  continueInterruptedTurn: z.boolean().optional(),
  workspacePath: z.string().min(1),
  workspaceId: z.string().min(1).optional(),
  permissionMode: PermissionModeSchema.optional(),
  provider: z.any().optional(),
  model: z.string().optional(),
  apiKey: z.string().optional(),
  reasoning: ReasoningLevelSchema.optional(),
  intent: TurnIntentSchema.optional(),
  attachments: z.array(AttachmentInputSchema).max(100).optional(),
  // Edit-and-resubmit: rewind the session to before this user message, drop it
  // and everything after, persist the new input as the user message, and run
  // the turn from that point (mirrors the desktop host's agent.turn).
  replaceFromMessageId: z.string().uuid().optional(),
}).passthrough().superRefine((request, context) => {
  if (request.continueInterruptedTurn) {
    if (request.input !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["input"], message: "A continued turn must not include new user input" });
    }
    if (request.messageInput !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["messageInput"], message: "A continued turn must not include a new visible message" });
    }
    if (request.attachments !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["attachments"], message: "A continued turn must not include new attachments" });
    }
    if (request.requestMessageId !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["requestMessageId"], message: "A continued turn must not reference a new user message" });
    }
    if (request.replaceFromMessageId !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["replaceFromMessageId"], message: "A continued turn cannot replace an earlier message" });
    }
    if (request.intent !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["intent"], message: "A continued turn must not declare a new intent" });
    }
    return;
  }
  if (request.input === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["input"], message: "A new turn requires user input" });
  }
});

const CancelTurnRequestSchema = z.object({
  operationId: z.string().uuid().optional(),
}).strict();

function canonicalTurnOperation(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalTurnOperation).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalTurnOperation(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function providerIdFromRequest(provider: unknown): string | undefined {
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) return undefined;
  const id = (provider as Record<string, unknown>).id;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

export function turnAdmissionFingerprint(request: z.infer<typeof StartTurnRequestSchema>): string {
  const { operationId: _operationId, ...operation } = request;
  return createHash("sha256").update(canonicalTurnOperation(operation)).digest("hex");
}

type ObservedAdmissionPreparation<T> = Promise<
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: unknown }
>;

function observeAdmissionPreparation<T>(work: Promise<T>): ObservedAdmissionPreparation<T> {
  return work.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (reason: unknown) => ({ status: "rejected" as const, reason }),
  );
}

async function resolveAdmissionPreparation<T>(work: ObservedAdmissionPreparation<T>): Promise<T> {
  const result = await work;
  if (result.status === "rejected") throw result.reason;
  return result.value;
}

async function resolveOptionalAdmissionPreparation<T>(
  work: ObservedAdmissionPreparation<T>,
  fallback: T,
  deadlineAt: number,
  label: string,
): Promise<T> {
  const remainingMs = Math.max(0, deadlineAt - Date.now());
  if (remainingMs === 0) {
    logAdmissionPreparationDegraded(label, "timeout");
    return fallback;
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    work,
    new Promise<{ status: "timeout" }>((resolve) => {
      timeout = setTimeout(() => resolve({ status: "timeout" }), remainingMs);
      timeout.unref?.();
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  if (result.status === "timeout") {
    logAdmissionPreparationDegraded(label, "timeout");
    return fallback;
  }
  if (result.status === "rejected") {
    logAdmissionPreparationDegraded(label, "unavailable");
    return fallback;
  }
  return result.value;
}

export function durableAdmissionPreparationTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.BERRY_DURABLE_ADMISSION_PREPARATION_TIMEOUT_MS?.trim();
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_DURABLE_ADMISSION_PREPARATION_TIMEOUT_MS;
  const configured = Number(raw);
  if (!Number.isSafeInteger(configured) || configured < 1) {
    return DEFAULT_DURABLE_ADMISSION_PREPARATION_TIMEOUT_MS;
  }
  // Admission is user-visible and cancellable. Configuration may tighten the
  // budget for tests or an incident, but it cannot weaken the two-second SLA.
  return Math.min(configured, DEFAULT_DURABLE_ADMISSION_PREPARATION_TIMEOUT_MS);
}

export function durableTaskReconciliationStatus(
  activity: DurableTaskActivity | undefined,
  taskUpdatedAt: string,
  nowMs = Date.now(),
): TaskStatus | null {
  const terminalRunStatus = activity?.runState === "completed"
    ? "completed"
    : activity?.runState === "cancelled"
      ? "cancelled"
      : activity?.runState === "failed" || activity?.runState === "recovery_required"
        ? "failed"
        : null;
  if (activity?.runState && !terminalRunStatus) return null;

  const admissionIsNewerThanRun = activity?.admissionCreatedAt !== null
    && activity?.admissionCreatedAt !== undefined
    && (activity.runCreatedAt === null
      || Date.parse(activity.admissionCreatedAt) > Date.parse(activity.runCreatedAt));
  if (admissionIsNewerThanRun && activity?.admissionState === "preparing") {
    const lastProgressAt = activity?.admissionUpdatedAt ?? activity?.admissionCreatedAt;
    if (lastProgressAt && nowMs - Date.parse(lastProgressAt) <= DURABLE_PREPARING_ADMISSION_STALE_MS) {
      return null;
    }
    return "failed";
  }
  if (admissionIsNewerThanRun && activity?.admissionState === "cancelled") return "cancelled";
  if (terminalRunStatus) return terminalRunStatus;
  if (!activity?.runId && activity?.admissionState === "cancelled") return "cancelled";
  if (!activity?.runId && nowMs - Date.parse(taskUpdatedAt) > DURABLE_TASK_WITHOUT_ADMISSION_STALE_MS) {
    return "failed";
  }
  return null;
}

function logAdmissionPreparationDegraded(
  label: string,
  outcome: "timeout" | "unavailable",
): void {
  console.info(JSON.stringify({
    event: "berry.turn.admission_preparation",
    outcome,
    dependency: label.slice(0, 128),
  }));
}

function logTurnAdmission(
  outcome: "admitted" | "replayed" | "failed",
  runId: string | null,
  durationMs: number,
  error?: unknown,
): void {
  const status = error instanceof HttpException ? error.getStatus() : null;
  const response = error instanceof HttpException ? error.getResponse() : null;
  const code = response && typeof response === "object" && "code" in response
    && typeof response.code === "string"
    ? response.code.slice(0, 128)
    : null;
  apiRuntimeMetrics.turnAdmission(outcome, durationMs, status);
  console.info(JSON.stringify({
    event: "berry.turn.admission",
    outcome,
    runId,
    durationMs: Math.max(0, Math.floor(durationMs)),
    status,
    code,
  }));
}

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

const ApiQuestionAnswerAttachmentSchema = z.object({
  fileId: z.string().uuid(),
  name: z.string().trim().min(1).max(240),
  mediaType: z.string().trim().min(1).max(255),
  size: z.number().int().nonnegative(),
  sourceKind: z.string().nullable().optional(),
}).strict();

const ApiQuestionAnswerSchema = z.object({
  question: z.string().trim().min(1).max(2_000),
  answer: z.string().trim().max(4_000),
  selectedOptions: z.array(z.string().trim().min(1)).max(24).default([]),
  attachments: z.array(ApiQuestionAnswerAttachmentSchema).max(100).default([]),
  skipped: z.boolean().default(false),
}).superRefine((answer, context) => {
  if (!answer.skipped && !answer.answer && answer.attachments.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["answer"], message: "Text or an attachment is required unless the question is skipped" });
  }
});

const AnswerQuestionRequestSchema = z.object({
  answer: z.string().trim().max(20_000),
  answerMessageId: z.string().uuid().optional(),
  selectedOptions: z.array(z.string()).max(24).optional(),
  answers: z.array(ApiQuestionAnswerSchema).min(1).max(5).optional(),
}).strict().superRefine((request, context) => {
  if (!request.answer && !request.answers?.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["answer"], message: "An answer or attachment is required" });
  }
});
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
    @Inject(PERSONAL_CAPABILITIES) private readonly personalCapabilities: PersonalCapabilitiesService,
    @Inject(FilePlatformService) private readonly files: FilePlatformService,
    @Inject(KnowledgeService) private readonly knowledge: KnowledgeService,
    @Inject(MemoryService) private readonly memory: MemoryService,
    @Inject(ContextAssemblyService) private readonly contextAssembly: ContextAssemblyService,
    @Inject(DurableTurnService) private readonly durableTurns: DurableTurnService,
    @Inject(ENTERPRISE_IDENTITY_REPOSITORY) private readonly identity: EnterpriseIdentityRepository,
    @Inject(CONNECTORS) private readonly connectors: ConnectorsService,
  ) {}

  async #primaryDepartmentId(tenantId: string, userId: string | null): Promise<string | null> {
    if (!userId) return null;
    const membership = await this.identity.getMembership(tenantId, userId);
    return membership?.primaryDepartmentId ?? membership?.departmentIds[0] ?? null;
  }

  async #resolveImageGenerationAccess(
    tenantId: string,
    userId: string | null,
    departmentId: string | null,
    mode: ConversationKind,
  ): Promise<{
    image: ReturnType<CloudRuntimeConfigService["imageGenerationInfo"]>;
    decision: ModelGovernanceDecision | null;
  }> {
    const image = this.runtimeConfig.imageGenerationInfo();
    if (!image) return { image: null, decision: null };
    const decision = await this.modelGovernance.resolve({
      tenantId,
      mode,
      providerId: image.providerId,
      model: image.model,
      userId,
      departmentId,
    });
    return { image, decision };
  }

  async #resolveVisionAdapter(
    tenantId: string,
    userId: string | null,
    departmentId: string | null,
    mode: ConversationKind,
  ) {
    const decision = await this.modelGovernance.resolveAuxiliary({
      tenantId,
      purpose: "vision",
      mode,
      userId,
      departmentId,
    });
    if (!decision?.allowed || decision.policy?.capabilities.vision !== true) return null;
    const runtime = await this.runtimeConfig.resolve(tenantId, {
      provider: { id: decision.providerId },
      model: decision.model,
    });
    const model = runtime.provider.models?.find((candidate) => candidate.id === decision.model);
    if (resolveModelCapabilities(model).vision !== true) return null;
    const maxTokens = Math.min(
      resolveModelCapabilities(model).context?.maxOutputTokens ?? 2_048,
      VISION_ADAPTER_MAX_OUTPUT_TOKENS,
    );
    return {
      providerId: decision.providerId,
      provider: await durableProviderTransport(runtime.provider, runtime.apiKey, runtime.credentialRef),
      model: decision.model,
      maxTokens,
      modelPricing: modelCostSnapshot(runtime.provider, decision.model),
      estimatedCostMicros: budgetEstimateFromRequest({
        provider: runtime.provider,
        model: decision.model,
        estimatedInputTokens: 12_000,
        estimatedOutputTokens: maxTokens,
      }).toString(),
    };
  }

  #assertImageGenerationAvailable(access: {
    image: ReturnType<CloudRuntimeConfigService["imageGenerationInfo"]>;
    decision: ModelGovernanceDecision | null;
  }) {
    if (!access.image) {
      throw new ServiceUnavailableException({
        code: "image_generation_unavailable",
        message: "Image generation is not configured for this deployment.",
      });
    }
    if (!access.decision?.allowed) {
      throw new ForbiddenException({
        code: "image_generation_governance_blocked",
        message: modelGovernanceMessage(access.decision?.reason ?? "model_blocked"),
        decision: access.decision,
      });
    }
    return access.image;
  }

  #queueProjectionWrite(
    sessionId: string,
    write: () => Promise<unknown>,
    onFailure?: (cause: unknown) => Promise<unknown>,
  ): void {
    const previous = this.#projectionWrites.get(sessionId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(write)
      .then(() => undefined, (cause) => onFailure?.(cause).then(() => undefined, () => undefined))
      .finally(() => {
        if (this.#projectionWrites.get(sessionId) === next) this.#projectionWrites.delete(sessionId);
      });
    this.#projectionWrites.set(sessionId, next);
  }

  @Get("/models/catalog")
  async modelCatalog(@Req() httpRequest: AuthenticatedRequest) {
    const tenantId = tenantIdFromRequest(httpRequest);
    const userId = httpRequest.auth?.user.id ?? null;
    const [initialCatalog, effective, connectorRuntime, departmentId] = await Promise.all([
      this.runtimeConfig.catalog(tenantId),
      this.organizationCapabilities.effective(tenantId, userId ?? ""),
      userId ? this.connectors.runtime(tenantId, userId) : Promise.resolve([]),
      this.#primaryDepartmentId(tenantId, userId),
    ]);
    if (!initialCatalog) return null;
    let catalog = initialCatalog;
    let runtime = await this.runtimeConfig.resolve(tenantId, {});
    await this.modelGovernance.synchronizeRuntimeCatalog(tenantId, runtime.provider);
    const organizationDefault = await this.modelGovernance.resolve({
      tenantId,
      mode: "chat",
      userId,
      departmentId,
    });
    if (organizationDefault.allowed && organizationDefault.providerId !== catalog.providerId) {
      runtime = await this.runtimeConfig.resolve(tenantId, {
        provider: { id: organizationDefault.providerId },
        model: organizationDefault.model,
      });
      await this.modelGovernance.synchronizeRuntimeCatalog(tenantId, runtime.provider);
      catalog = {
        ...catalog,
        providerId: runtime.provider.id,
        name: runtime.provider.name,
        defaultModel: organizationDefault.model,
        models: runtime.provider.models ?? [],
      };
    }
    const modelDecisions = await Promise.all(catalog.models.map((model) => this.modelGovernance.resolve({
      tenantId,
      mode: "chat",
      providerId: catalog.providerId,
      model: model.id,
      userId,
      departmentId,
    })));
    const visibleModels = catalog.models.filter((_, index) => modelDecisions[index]?.allowed === true);
    const preferredDefault = organizationDefault.allowed
      && organizationDefault.providerId === catalog.providerId
      ? organizationDefault.model
      : catalog.defaultModel;
    const visibleDefault = visibleModels.some((model) => model.id === preferredDefault)
      ? preferredDefault
      : visibleModels[0]?.id ?? catalog.defaultModel;
    const imageAccess = await this.#resolveImageGenerationAccess(tenantId, userId, departmentId, "chat");
    return {
      ...catalog,
      defaultModel: visibleDefault,
      models: visibleModels,
      skills: [...catalog.skills, ...effective.skills.map((skill) => ({ id: skill.filePath, name: skill.name, description: skill.description, enabled: true }))],
      mcpServers: [
        ...catalog.mcpServers,
        ...effective.mcpServers.flatMap((server) => server.url ? [{ id: server.id, name: server.name, url: server.url, auth: server.credential ? "bearer" as const : "none" as const, enabled: server.enabled }] : []),
        ...connectorRuntime.flatMap((server) => server.url ? [{ id: server.id, name: server.name, url: server.url, auth: server.credential ? "bearer" as const : "none" as const, enabled: server.enabled }] : []),
      ],
      capabilities: {
        imageGeneration: imageAccess.image && imageAccess.decision?.allowed
          ? { available: true, model: imageAccess.image.model, reason: null, message: null }
          : {
              available: false,
              model: imageAccess.image?.model ?? null,
              reason: imageAccess.decision?.reason ?? "not_configured",
              message: imageAccess.decision
                ? modelGovernanceMessage(imageAccess.decision.reason)
                : "Image generation is not configured for this deployment.",
            },
      },
    };
  }

  @Post("/prompts/improve")
  async improvePrompt(@Req() httpRequest: AuthenticatedRequest, @Body() body: unknown) {
    const request = parseBody(PromptImprovementRequestSchema, body);
    const tenantId = tenantIdFromRequest(httpRequest);
    const userId = httpRequest.auth?.user.id ?? null;
    const departmentId = await this.#primaryDepartmentId(tenantId, userId);
    const runtime = await this.runtimeConfig.resolve(tenantId, {
      provider: { id: "router" },
      model: PROMPT_IMPROVEMENT_MODEL,
    });
    const model = runtime.provider.models?.find((candidate) => candidate.id === PROMPT_IMPROVEMENT_MODEL);
    if (!model) {
      throw new ServiceUnavailableException({
        code: "prompt_improvement_model_unavailable",
        message: "Prompt improvement is not configured for this deployment.",
      });
    }
    await this.modelGovernance.synchronizeRuntimeCatalog(tenantId, runtime.provider);
    const decision = await this.modelGovernance.resolve({
      tenantId,
      mode: "chat",
      providerId: runtime.provider.id,
      model: PROMPT_IMPROVEMENT_MODEL,
      userId,
      departmentId,
    });
    if (!decision.allowed) {
      throw new ForbiddenException({
        code: "prompt_improvement_model_blocked",
        message: modelGovernanceMessage(decision.reason),
        decision,
      });
    }

    const requestId = `prompt_improve_${randomUUID()}`;
    const startedAt = Date.now();
    const requiredSkills = promptImprovementSkills(request.prompt, request.skills);
    const modelInput = promptImprovementModelInput(request.prompt, requiredSkills);
    const estimatedInputTokens = estimatePromptTokens(`${PROMPT_IMPROVEMENT_SYSTEM_PROMPT}\n${modelInput}`);
    const maxOutputTokens = Math.min(
      runtime.providerMaxOutputTokens ?? PROMPT_IMPROVEMENT_MAX_OUTPUT_TOKENS,
      PROMPT_IMPROVEMENT_MAX_OUTPUT_TOKENS,
      Math.max(PROMPT_IMPROVEMENT_MIN_OUTPUT_TOKENS, estimatePromptTokens(request.prompt) * 2),
    );
    const estimatedOutputTokens = maxOutputTokens;
    const estimatedCostMicros = budgetEstimateFromRequest({
      provider: runtime.provider,
      model: PROMPT_IMPROVEMENT_MODEL,
      estimatedInputTokens,
      estimatedOutputTokens,
    });
    await this.budgets.reserve({
      tenantId,
      requestId,
      userId,
      departmentId,
      taskId: null,
      sessionId: null,
      feature: "prompt.improve",
      provider: runtime.provider.id,
      model: PROMPT_IMPROVEMENT_MODEL,
      estimatedCostMicros,
      estimatedTokens: estimatedInputTokens + estimatedOutputTokens,
      metadata: { promptLength: request.prompt.length },
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROMPT_IMPROVEMENT_TIMEOUT_MS);
    let result: Awaited<ReturnType<OpenAIChatCompletionsClient["complete"]>>;
    try {
      result = await new OpenAIChatCompletionsClient({
        provider: runtime.provider,
        apiKey: runtime.apiKey,
        appName: "Berry Prompt Improver",
      }).complete({
        model: PROMPT_IMPROVEMENT_MODEL,
        messages: [
          { role: "system", content: PROMPT_IMPROVEMENT_SYSTEM_PROMPT },
          { role: "user", content: modelInput },
        ],
        temperature: 0.2,
        maxTokens: maxOutputTokens,
        reasoningEffort: "minimal",
        signal: controller.signal,
      });
    } catch (error) {
      await Promise.all([
        this.budgets.reconcile({ tenantId, requestId, actualCostMicros: 0n }),
        this.usageRepository.ingestInternal(tenantId, promptImprovementUsageEvent({
          requestId,
          userId,
          departmentId,
          provider: runtime.provider.id,
          model: PROMPT_IMPROVEMENT_MODEL,
          requestedModel: PROMPT_IMPROVEMENT_MODEL,
          promptLength: request.prompt.length,
          resultLength: 0,
          usage: estimatedPromptImprovementUsage(0, 0),
          actualCostMicros: 0n,
          pricingSource: "estimated",
          finishReason: null,
          startedAt,
          status: "failed",
        })),
      ]).catch(() => undefined);
      if (controller.signal.aborted) {
        throw new RequestTimeoutException({
          code: "prompt_improvement_timeout",
          message: "Prompt improvement took too long. Please try again.",
        });
      }
      if (error instanceof RouterClientError && error.status === 429) {
        throw new HttpException({
          code: "prompt_improvement_rate_limited",
          message: "Prompt improvement is busy right now. Please try again shortly.",
        }, 429);
      }
      throw new BadGatewayException({
        code: "prompt_improvement_failed",
        message: "Berry could not improve this prompt. Please try again.",
      });
    } finally {
      clearTimeout(timeout);
    }

    const recordResultUsage = async (status: "completed" | "failed", resultLength: number) => {
      const usage = result.usage ?? estimatedPromptImprovementUsage(
        estimatedInputTokens,
        resultLength > 0 ? estimatePromptTokens(result.content) : 0,
      );
      const usageEvent: AgentStreamEvent = {
        kind: "usage",
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        cacheReadTokens: usage.cacheReadTokens ?? 0,
        cacheWriteTokens: usage.cacheWriteTokens ?? 0,
        cacheCreationTokens1h: usage.cacheCreationTokens1h ?? 0,
        cacheCreationTokens5m: usage.cacheCreationTokens5m ?? 0,
        requestedModel: PROMPT_IMPROVEMENT_MODEL,
        model: result.model,
        servedProvider: result.attribution?.servedProvider ?? runtime.provider.id,
        servedModel: result.attribution?.servedModel ?? result.model,
        pricingSource: result.usage ? "measured" : "estimated",
      };
      const actualCostMicros = usageCostMicros(usageEvent, estimatedCostMicros, runtime.provider);
      await Promise.all([
        this.budgets.reconcile({
          tenantId,
          requestId,
          actualCostMicros,
          usage: {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            provider: usageEvent.servedProvider ?? runtime.provider.id,
            model: usageEvent.servedModel ?? result.model,
          },
        }),
        this.usageRepository.ingestInternal(tenantId, promptImprovementUsageEvent({
          requestId,
          userId,
          departmentId,
          provider: usageEvent.servedProvider ?? runtime.provider.id,
          model: usageEvent.servedModel ?? result.model,
          requestedModel: PROMPT_IMPROVEMENT_MODEL,
          promptLength: request.prompt.length,
          resultLength,
          usage,
          actualCostMicros,
          pricingSource: result.usage ? "measured" : "estimated",
          finishReason: result.finishReason,
          startedAt,
          status,
        })),
      ]);
    };

    let improvedPrompt: string;
    try {
      improvedPrompt = preservePromptSkillTokens(
        normalizeImprovedPrompt(result.content),
        requiredSkills,
      );
    } catch (error) {
      await recordResultUsage("failed", 0);
      throw error;
    }
    await recordResultUsage("completed", improvedPrompt.length);
    return { prompt: improvedPrompt, model: PROMPT_IMPROVEMENT_MODEL };
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
    const tenantId = tenantIdFromRequest(httpRequest);
    const requestId = `image_${randomUUID()}`;
    const startedAt = Date.now();
    const userId = httpRequest.auth?.user.id ?? null;
    const departmentId = await this.#primaryDepartmentId(
      tenantId,
      userId,
    );
    const imageAccess = await this.#resolveImageGenerationAccess(tenantId, userId, departmentId, "chat");
    const image = this.#assertImageGenerationAvailable(imageAccess);
    const actualCostMicros = BigInt(image.costMicros);
    await this.budgets.reserve({
      tenantId,
      requestId,
      userId,
      departmentId,
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
          departmentId,
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
        departmentId,
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
    const request = parseBody(CreateTaskRequestSchema, body);
    const tenantId = tenantIdFromRequest(httpRequest);
    const userId = httpRequest.auth?.user.id ?? null;
    // `conversationKind` is accepted only as a legacy input. Web tasks use one
    // normal assistant flow, so model routing never branches on that value.
    const mode = "chat" as const;
    const { conversationKind: _legacyConversationKind, ...taskRequest } = request;
    const explicitModel = request.model ?? null;
    const requestedProviderId = explicitModel ? request.modelProviderId ?? null : null;
    const catalog = await this.runtimeConfig.catalog(tenantId);
    if (!catalog) {
      return this.store.createTask({
        ...taskRequest,
        permissionMode: "full-access",
        ownerUserId: userId,
      });
    }
    const runtime = await this.runtimeConfig.resolve(tenantId, {
      ...(requestedProviderId ? { provider: { id: requestedProviderId } } : {}),
      ...(explicitModel ? { model: explicitModel } : {}),
    });
    await this.modelGovernance.synchronizeRuntimeCatalog(tenantId, runtime.provider);
    const departmentId = await this.#primaryDepartmentId(tenantId, userId);
    let modelDecision = await this.modelGovernance.resolve({
      tenantId,
      mode,
      providerId: explicitModel ? requestedProviderId ?? runtime.provider.id : null,
      model: explicitModel,
      userId,
      departmentId,
    });
    if (!explicitModel && modelDecision.reason === "no_model_selected") {
      modelDecision = await this.modelGovernance.resolve({
        tenantId,
        mode,
        providerId: runtime.provider.id,
        model: runtime.provider.defaultModel,
        userId,
        departmentId,
      });
    }
    if (!modelDecision.allowed) {
      throw new ForbiddenException({
        code: "model_governance_blocked",
        message: modelGovernanceMessage(modelDecision.reason),
        decision: modelDecision,
      });
    }
    if (runtime.provider.id !== modelDecision.providerId) {
      await this.runtimeConfig.resolve(tenantId, {
        provider: { id: modelDecision.providerId },
        model: modelDecision.model,
      });
    }
    return this.store.createTask({
      ...taskRequest,
      permissionMode: "full-access",
      modelProviderId: modelDecision.providerId,
      model: modelDecision.model,
      ownerUserId: userId,
    });
  }

  @Get("/tasks")
  async listTasks(
    @Req() httpRequest: AuthenticatedRequest,
    @Query("workspaceId") workspaceId?: string,
    @Query("workspaceKind") workspaceKind?: string,
    @Query("includeDeleted") includeDeleted?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
    @Query("taskIds") taskIds?: string,
  ) {
    await Promise.all(this.#projectionWrites.values());
    const requestedTaskIds = taskIds
      ? z.array(z.string().trim().min(1).max(128)).max(100).parse(taskIds.split(",").filter(Boolean))
      : undefined;
    const tasks = await this.store.listTasks({
      ...(workspaceId ? { workspaceId } : {}),
      ...(workspaceKind ? { workspaceKind: WorkspaceKindSchema.parse(workspaceKind) } : {}),
      ownerUserId: httpRequest.auth?.user.id ?? null,
      includeDeleted: includeDeleted === "true",
      ...(limit ? { limit: z.coerce.number().int().positive().max(500).parse(limit) } : {}),
      ...(offset ? { offset: z.coerce.number().int().nonnegative().parse(offset) } : {}),
      ...(requestedTaskIds ? { taskIds: requestedTaskIds } : {}),
    });
    const tenantId = tenantIdFromRequest(httpRequest);
    const activeSessionIds = tasks.flatMap((task) => (
      (task.status === "queued" || task.status === "running" || task.status === "waiting-for-approval")
        && task.activeSessionId
        ? [task.activeSessionId]
        : []
    ));
    const durableActivity = this.durableTurns.enabled
      ? await this.durableTurns.taskActivity(tenantId, activeSessionIds)
      : new Map<string, DurableTaskActivity>();
    return Promise.all(tasks.map(async (task) => {
      const taskClaimsActivity = task.status === "queued"
        || task.status === "running"
        || task.status === "waiting-for-approval";
      if (!taskClaimsActivity || !task.activeSessionId) return task;
      if (this.durableTurns.enabled) {
        const reconciledStatus = durableTaskReconciliationStatus(
          durableActivity.get(task.activeSessionId),
          task.updatedAt,
        );
        if (reconciledStatus && reconciledStatus !== task.status) {
          return this.store.updateTask(
            task.id,
            { status: reconciledStatus },
            httpRequest.auth?.user.id ?? null,
          );
        }
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
      // An API restart discards the in-memory terminal receipt. Persisted
      // assistant content alone cannot prove that accounting and projections
      // finished, so never infer success from a partial transcript.
      return this.store.updateTask(task.id, { status: "failed" }, httpRequest.auth?.user.id ?? null);
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
    const task = await this.store.getTask(taskId, httpRequest.auth?.user.id ?? null);
    return this.sandboxWorkspace.state(tenantIdFromRequest(httpRequest), task.id);
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
    const task = await this.store.getTask(taskId, httpRequest.auth?.user.id ?? null);
    const state = await this.sandboxWorkspace.state(tenantIdFromRequest(httpRequest), task.id);
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
    const userId = httpRequest.auth?.user.id ?? null;
    const current = await this.store.getTask(taskId, userId);
    let task;
    if (this.durableTurns.enabled && userId) {
      const deleted = await this.durableTurns.deleteTask(tenantIdFromRequest(httpRequest), userId, taskId);
      if (!deleted) throw new NotFoundException(`Task not found: ${taskId}`);
      task = await this.store.getTask(taskId, userId);
    } else {
      if (current.activeSessionId && this.sessionHost.turnState(current.activeSessionId).active) {
        await this.sessionHost.cancel(current.activeSessionId);
      }
      if (current.activeSessionId) await this.#projectionWrites.get(current.activeSessionId);
      task = await this.store.deleteTask(taskId, userId);
    }
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
      permissionMode: "full-access",
    });
  }

  @Get("/sessions/:sessionId")
  async getSession(@Req() httpRequest: AuthenticatedRequest, @Param("sessionId") sessionId: string) {
    return (await this.ownedSession(httpRequest, sessionId)).session;
  }

  @Get("/sessions/:sessionId/messages")
  async listMessages(@Req() httpRequest: AuthenticatedRequest, @Param("sessionId") sessionId: string) {
    await this.ownedSession(httpRequest, sessionId);
    await this.#projectionWrites.get(sessionId);
    return this.store.listMessages(sessionId);
  }

  @Post("/sessions/:sessionId/context-stats")
  async contextStats(@Req() httpRequest: AuthenticatedRequest, @Param("sessionId") sessionId: string, @Body() body: unknown) {
    const request = parseBody(ContextStatsRequestSchema, body);
    const { session } = await this.ownedSession(httpRequest, sessionId);
    const model = request.model ?? session.model ?? undefined;
    const catalog = await this.runtimeConfig.catalog(tenantIdFromRequest(httpRequest));
    const selectedModel = model ?? catalog?.defaultModel;
    const modelMetadata = catalog?.models.find((candidate) => candidate.id === selectedModel);
    const contextWindow = resolveModelCapabilities(modelMetadata).context?.windowTokens
      ?? modelMetadata?.contextWindow
      ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
    const runtimeStats = this.durableTurns.enabled
      ? await this.durableTurns.contextStats(tenantIdFromRequest(httpRequest), sessionId, {
          ...(request.pendingInput !== undefined ? { pendingInput: request.pendingInput } : {}),
          ...(request.attachments ? { attachments: request.attachments } : {}),
        })
      : await this.sessionHost.contextStats(sessionId, {
          ...(request.pendingInput !== undefined ? { pendingInput: request.pendingInput } : {}),
          ...(request.attachments ? { attachments: contextStatsAttachments(request.attachments) } : {}),
        });
    const percentUsed = contextWindow
      ? Math.min(100, Math.max(0, (runtimeStats.usedTokens / contextWindow) * 100))
      : null;
    return ContextStatsSchema.parse({
      usedTokens: runtimeStats.usedTokens,
      contextWindow,
      percentUsed,
      tokensLeft: contextWindow ? Math.max(0, contextWindow - runtimeStats.usedTokens) : null,
      source: runtimeStats.source,
      thresholdState: contextThresholdState(percentUsed),
    });
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
    const admissionStartedAt = Date.now();
    try {
      return await this.startTurnRequest(httpRequest, sessionId, body, admissionStartedAt);
    } catch (error) {
      if (this.durableTurns.enabled) {
        logTurnAdmission("failed", null, Date.now() - admissionStartedAt, error);
      }
      throw error;
    }
  }

  private async startTurnRequest(
    httpRequest: AuthenticatedRequest,
    sessionId: string,
    body: unknown,
    admissionStartedAt: number,
  ) {
    const optionalPreparationDeadlineAt = admissionStartedAt + durableAdmissionPreparationTimeoutMs();
    const request = parseBody(StartTurnRequestSchema, body);
    const { session, task } = await this.ownedSession(httpRequest, sessionId);
    const tenantId = tenantIdFromRequest(httpRequest);
    const userId = httpRequest.auth!.user.id;
    const requestId = `model_${request.operationId ?? request.requestMessageId ?? randomUUID()}`;
    const operationFingerprint = turnAdmissionFingerprint(request);
    if (this.durableTurns.enabled) {
      const replayed = await this.durableTurns.replayAdmission({
        tenantId,
        userId,
        workspaceId: request.workspaceId ?? task.workspaceId,
        taskId: task.id,
        sessionId,
        requestId,
        operationFingerprint,
      });
      if (replayed) {
        logTurnAdmission("replayed", replayed.runId, Date.now() - admissionStartedAt);
        return { turnId: replayed.runId, sessionId };
      }
      const preparing = await this.durableTurns.beginAdmission({
        tenantId,
        sessionId,
        requestId,
        operationFingerprint,
      });
      if (preparing) {
        logTurnAdmission("replayed", preparing.runId, Date.now() - admissionStartedAt);
        return { turnId: preparing.runId, sessionId };
      }
      await this.store.updateTask(task.id, { status: "running" }, userId);
    }
    if (request.continueInterruptedTurn) {
      await this.assertContinuableTurn(sessionId);
    }
    const requestProviderId = providerIdFromRequest(request.provider);
    const selectedModel = request.model ?? session.model ?? undefined;
    const selectedProviderId = request.model
      ? requestProviderId ?? session.modelProviderId ?? undefined
      : session.modelProviderId ?? requestProviderId;
    const selectedProvider = selectedProviderId && selectedProviderId !== requestProviderId
      ? { id: selectedProviderId }
      : request.provider;
    const baseRuntimeWork = this.runtimeConfig.resolve(tenantId, {
      ...request,
      ...(selectedProvider ? { provider: selectedProvider } : {}),
      ...(selectedModel ? { model: selectedModel } : {}),
    });
    const effectiveRuntimeWork = observeAdmissionPreparation(
      this.organizationCapabilities.effective(tenantId, userId),
    );
    const connectorRuntimeWork = observeAdmissionPreparation(
      this.connectors.runtime(tenantId, userId, { taskId: task.id, sessionId }),
    );
    const departmentIdWork = observeAdmissionPreparation(
      this.#primaryDepartmentId(tenantId, userId),
    );
    let baseRuntime = await baseRuntimeWork;
    const [effectiveRuntime, connectorRuntime, departmentId] = await Promise.all([
      this.durableTurns.enabled
        ? resolveOptionalAdmissionPreparation(
            effectiveRuntimeWork,
            { rows: [], skills: [], mcpServers: [] },
            optionalPreparationDeadlineAt,
            "organization_capabilities",
          )
        : resolveAdmissionPreparation(effectiveRuntimeWork),
      this.durableTurns.enabled
        ? resolveOptionalAdmissionPreparation(
            connectorRuntimeWork,
            [],
            optionalPreparationDeadlineAt,
            "connector_runtime",
          )
        : resolveAdmissionPreparation(connectorRuntimeWork),
      resolveAdmissionPreparation(departmentIdWork),
    ]);
    await this.modelGovernance.synchronizeRuntimeCatalog(tenantId, baseRuntime.provider);
    const mode = "chat" as const;
    const modelDecision = await this.modelGovernance.resolve({
      tenantId,
      mode,
      providerId: selectedProviderId ?? null,
      model: selectedModel ?? null,
      userId,
      departmentId,
    });
    if (!modelDecision.allowed) {
      throw new ForbiddenException({
        code: "model_governance_blocked",
        message: modelGovernanceMessage(modelDecision.reason),
        decision: modelDecision,
      });
    }
    if (baseRuntime.provider.id !== modelDecision.providerId) {
      baseRuntime = await this.runtimeConfig.resolve(tenantId, {
        provider: { id: modelDecision.providerId },
        model: modelDecision.model,
      });
      await this.modelGovernance.synchronizeRuntimeCatalog(tenantId, baseRuntime.provider);
    }
    const resolvedRuntime = { ...baseRuntime, mcpServers: [...baseRuntime.mcpServers, ...effectiveRuntime.mcpServers, ...connectorRuntime], extraSkills: [...baseRuntime.extraSkills, ...effectiveRuntime.skills] };
    const providerId = modelDecision.providerId;
    const governedModelId = modelDecision.model;
    if (session.modelProviderId !== modelDecision.providerId || session.model !== governedModelId) {
      await this.store.updateSessionModel(sessionId, modelDecision.providerId, governedModelId);
    }
    const governedModel = resolvedRuntime.provider.models?.find((candidate) => candidate.id === governedModelId);
    const governedCapabilities = resolveModelCapabilities(governedModel);
    const advertisedMaxOutputTokens = governedCapabilities.context?.maxOutputTokens;
    const configuredMaxOutputTokens = resolvedRuntime.providerMaxOutputTokens;
    const modelMaxOutputTokens = advertisedMaxOutputTokens ?? DEFAULT_MODEL_MAX_OUTPUT_TOKENS;
    const governedMaxOutputTokens = configuredMaxOutputTokens
      ? Math.min(modelMaxOutputTokens, configuredMaxOutputTokens)
      : modelMaxOutputTokens;
    const imageAccess = await this.#resolveImageGenerationAccess(tenantId, userId, departmentId, mode);
    if (request.intent === "image_generation") this.#assertImageGenerationAvailable(imageAccess);
    const contextInput = {
      tenantId,
      userId: httpRequest.auth!.user.id,
      workspaceId: request.workspaceId ?? task.workspaceId,
      taskId: task.id,
      sessionId,
      request: request.input ?? task.title,
      taskTitle: task.title,
    };
    const groundingContextWork = observeAdmissionPreparation(this.contextAssembly.assemble(
      contextInput,
      this.durableTurns.enabled
        ? { timeoutMs: Math.max(1, optionalPreparationDeadlineAt - Date.now()) }
        : {},
    ));
    const portableCheckpointWork = observeAdmissionPreparation(
      this.contextAssembly.portableCheckpoint(tenantId, sessionId),
    );
    const [groundingContext, portableCheckpoint] = await Promise.all([
      this.durableTurns.enabled
        ? resolveOptionalAdmissionPreparation(
            groundingContextWork,
            unavailableAdmissionGroundingContext(contextInput),
            optionalPreparationDeadlineAt,
            "grounding_context",
          )
        : resolveAdmissionPreparation(groundingContextWork),
      this.durableTurns.enabled
        ? resolveOptionalAdmissionPreparation(
            portableCheckpointWork,
            undefined,
            optionalPreparationDeadlineAt,
            "portable_checkpoint",
          )
        : resolveAdmissionPreparation(portableCheckpointWork),
    ]);
    let runtimeImageAttachments: RuntimeImageReference[] = [];
    const governedRequest = {
      ...request,
      provider: resolvedRuntime.provider,
      apiKey: resolvedRuntime.apiKey,
      model: governedModelId,
      mcpServers: resolvedRuntime.mcpServers,
      extraSkills: resolvedRuntime.extraSkills,
      networkPolicy: resolvedRuntime.networkPolicy,
      maxTokens: governedMaxOutputTokens,
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
      personalSkills: {
        save: ({ content }: { content: string }) => this.personalCapabilities.saveSkill(tenantId, userId, {
          content,
          source: "text",
          enabled: true,
        }),
      },
      ...(imageAccess.image && imageAccess.decision?.allowed ? {
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
    const contextWindowTokens = governedCapabilities.context?.windowTokens
      ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
    const pricingSnapshot = modelCostSnapshot(governedRequest.provider, governedRequest.model);
    const hasModelPricing = Object.values(pricingSnapshot).some((value) => typeof value === "number");
    const reserveModelBudget = () => this.budgets.reserve({
      tenantId,
      requestId,
      userId,
      departmentId,
      taskId: task.id,
      sessionId,
      feature: "model",
      provider: providerId,
      model: governedRequest.model ?? null,
      estimatedCostMicros: budgetEstimateFromRequest({
        provider: governedRequest.provider,
        model: governedRequest.model,
        estimatedInputTokens: Math.min(contextWindowTokens, 12_000),
        estimatedOutputTokens: governedRequest.maxTokens ?? 8_000,
      }),
      estimatedTokens: governedRequest.maxTokens ?? 4000,
      metadata: { workspaceId: request.workspaceId ?? task.workspaceId },
    });
    const inlineBudgetCheck = this.durableTurns.enabled ? null : await reserveModelBudget();
    const reservedCostMicros = BigInt(inlineBudgetCheck?.reservation?.reservedMicros ?? "0");
    let actualCostMicros = 0n;
    let usagePricingComplete = true;
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
    if (!this.durableTurns.enabled && request.replaceFromMessageId) {
      await this.rewindForEdit(
        tenantId,
        sessionId,
        request.replaceFromMessageId,
        request.messageInput ?? request.input ?? "",
        request.attachments,
        request.requestMessageId,
      );
    } else if (!this.durableTurns.enabled && !request.continueInterruptedTurn && request.requestMessageId) {
      await this.store.appendMessage(sessionId, {
        id: request.requestMessageId,
        role: "user",
        parts: userMessageParts(request.messageInput ?? request.input ?? "", request.attachments),
      });
    }
    if (this.durableTurns.enabled) {
      try {
        const imageInfo = imageAccess.image;
        const imageDecision = imageAccess.decision;
        const providerWork = durableProviderTransport(
          governedRequest.provider,
          resolvedRuntime.apiKey,
          resolvedRuntime.credentialRef,
        );
        const mcpServersWork = observeAdmissionPreparation(Promise.all(governedRequest.mcpServers
          .filter((server) => server.enabled && server.trusted)
          .map((server) => durableMcpServer(server))));
        const visionWork = observeAdmissionPreparation(governedCapabilities.vision === true
          ? Promise.resolve(null)
          : this.#resolveVisionAdapter(tenantId, userId, departmentId, mode));
        const [provider, mcpServers, vision] = await Promise.all([
          providerWork,
          resolveOptionalAdmissionPreparation(
            mcpServersWork,
            [],
            optionalPreparationDeadlineAt,
            "mcp_runtime",
          ),
          resolveOptionalAdmissionPreparation(
            visionWork,
            null,
            optionalPreparationDeadlineAt,
            "vision_runtime",
          ),
        ]);
        const builtInTools = [
          ...DURABLE_BASE_BUILT_IN_TOOLS,
          ...(imageInfo && imageDecision?.allowed ? ["create_image" as const] : []),
          ...(vision ? ["inspect_images" as const] : []),
          ...(governedRequest.extraSkills.some((skill) => !skill.disableModelInvocation)
            ? ["activate_skill" as const]
            : []),
        ];
        const runtimeRequest = DurableTurnRuntimeRequestSchema.parse({
          capabilityVersion: 1,
          admissionFingerprint: operationFingerprint,
          ...(request.intent ? { intent: request.intent } : {}),
          providerId,
          provider,
          model: governedRequest.model ?? null,
          conversationKind: mode,
          // The sandbox root is deployment infrastructure, not a client
          // preference. Keep model-visible paths aligned with the provider's
          // actual writable root for new and resumed durable runs.
          workspacePath: this.runtimeConfig.config.workspacePath,
          workspaceId: governedRequest.workspaceId ?? task.workspaceId,
          permissionMode: "full-access",
          reasoning: governedRequest.reasoning ?? "off",
          continueInterruptedTurn: request.continueInterruptedTurn === true,
          maxTokens: governedRequest.maxTokens ?? 8_000,
          contextWindowTokens,
          modelAcceptsImages: governedCapabilities.vision === true,
          modelPricing: pricingSnapshot,
          networkPolicy: governedRequest.networkPolicy,
          builtInTools,
          ...(imageInfo && imageDecision?.allowed ? { imageGeneration: imageInfo } : {}),
          ...(vision ? { vision } : {}),
          mcpServers,
          extraSkills: governedRequest.extraSkills.map((skill) => ({
            name: skill.name,
            description: skill.description,
            content: skill.content,
            filePath: skill.filePath,
            disableModelInvocation: skill.disableModelInvocation,
            resources: skill.resources ?? [],
          })),
          attachments: (request.attachments ?? []).map((attachment) => ({
            ...(attachment.id ? { id: attachment.id } : {}),
            ...(attachment.fileId ? { fileId: attachment.fileId } : {}),
            name: attachment.name,
            mediaType: attachment.mediaType,
            size: attachment.size,
            ...(attachment.sourceKind !== undefined ? { sourceKind: attachment.sourceKind } : {}),
          })),
          ...(portableCheckpoint ? { portableCheckpoint } : {}),
        });
        const durableBudgetCheck = await reserveModelBudget();
        const budgetReservationRequired = Boolean(durableBudgetCheck.reservation);
        const admitted = await this.durableTurns.admit({
          tenantId,
          userId,
          workspaceId: governedRequest.workspaceId ?? task.workspaceId,
          taskId: task.id,
          sessionId,
          requestId,
          operationFingerprint,
          budgetReservationRequired,
          ...(request.requestMessageId ? { requestMessageId: request.requestMessageId } : {}),
          ...(request.replaceFromMessageId ? { replaceFromMessageId: request.replaceFromMessageId } : {}),
          input: request.continueInterruptedTurn ? "" : request.input ?? "",
          ...(request.messageInput ? { messageInput: request.messageInput } : {}),
          ...(request.attachments ? { attachments: request.attachments } : {}),
          ...(request.continueInterruptedTurn ? { continueInterruptedTurn: true } : {}),
          runtimeRequest: { ...runtimeRequest, budgetReservationRequired },
          groundingContext: groundingContext as unknown as JsonValue,
        });
        logTurnAdmission("admitted", admitted.runId, Date.now() - admissionStartedAt);
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
        permissionMode: "full-access",
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
            if (parsed.costRawMicros === undefined && !hasModelPricing) usagePricingComplete = false;
            actualCostMicros += usageCostMicros(parsed, 0n, governedRequest.provider);
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
          if (parsed.kind === "turn.end") {
            const terminalCostMicros = usage && !usagePricingComplete ? reservedCostMicros : actualCostMicros;
            const terminalUsage = {
                requestId,
                userId: httpRequest.auth?.user.id ?? null,
                departmentId,
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
                costRawMicros: terminalCostMicros.toString(),
                costBilledMicros: terminalCostMicros.toString(),
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
              };
            this.#queueProjectionWrite(
              sessionId,
              () => retryInlineFinalization(async () => {
                await Promise.all([
                  this.budgets.reconcile({ tenantId, requestId, actualCostMicros: terminalCostMicros, usage }),
                  this.usageRepository.ingestInternal(tenantId, terminalUsage),
                  ...(parsed.status === "completed" ? [
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
                  ] : []),
                ]);
                await this.store.updateTask(task.id, { status: parsed.status });
              }).then(() => {
                // The browser may only observe a terminal event after every
                // earlier projection, accounting write, and completion
                // trigger has settled successfully.
                this.events.publish(sessionId, parsed);
              }),
              async (cause) => {
                const message = cause instanceof Error ? cause.message : "Inline turn finalization failed";
                try {
                  await Promise.all([
                    this.budgets.reconcile({ tenantId, requestId, actualCostMicros: terminalCostMicros, usage }),
                    this.usageRepository.ingestInternal(tenantId, { ...terminalUsage, status: "failed" }),
                  ]).catch(() => undefined);
                  await this.store.updateTask(task.id, { status: "failed" }).catch(() => undefined);
                } finally {
                  this.events.publish(sessionId, { kind: "error", message });
                  this.events.publish(sessionId, { kind: "turn.end", turnId: parsed.turnId, status: "failed" });
                }
              },
            );
            return;
          }
          this.events.publish(sessionId, parsed);
        },
      } as StartTurnOptions);
      activeTurnId = turnId;
      return { turnId, sessionId };
    } catch (error) {
      const terminalCostMicros = usage && !usagePricingComplete ? reservedCostMicros : actualCostMicros;
      await this.budgets.reconcile({ tenantId, requestId, actualCostMicros: terminalCostMicros, usage });
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
    tenantId: string,
    sessionId: string,
    replaceFromMessageId: string,
    input: string,
    attachments: z.infer<typeof AttachmentInputSchema>[] | undefined,
    replacementMessageId?: string,
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
      if (this.durableTurns.enabled) {
        await this.durableTurns.rewindJournalBefore(tenantId, sessionId, replaceFromMessageId);
      }
      await this.store.deleteMessagesFrom(sessionId, replaceFromMessageId);
    } else {
      throw new ConflictException("The message being edited is stale or no longer exists");
    }
    await this.store.appendMessage(sessionId, {
      ...(replacementMessageId ? { id: replacementMessageId } : {}),
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
      const tenantId = tenantIdFromRequest(httpRequest);
      const userId = httpRequest.auth!.user.id;
      const context = await this.durableTurns.questionContext(tenantId, userId, questionId);
      if (!context) throw new NotFoundException("Question not found");
      const ok = await this.durableTurns.answerQuestion(
        tenantId,
        userId,
        questionId,
        request,
      );
      const message = ok && request.answerMessageId
        ? (await this.store.listMessages(context.sessionId)).find(
            (candidate) => candidate.id === request.answerMessageId,
          )
        : undefined;
      return { ok, ...(message ? { message } : {}) };
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
  async cancelTurn(
    @Req() httpRequest: AuthenticatedRequest,
    @Param("sessionId") sessionId: string,
    @Body() body: unknown,
  ) {
    await this.ownedSession(httpRequest, sessionId);
    const request = parseBody(CancelTurnRequestSchema, body ?? {});
    if (this.durableTurns.enabled) {
      return {
        ok: await this.durableTurns.cancel(
          tenantIdFromRequest(httpRequest),
          sessionId,
          request.operationId ? `model_${request.operationId}` : undefined,
        ),
      };
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
    if (this.durableTurns.enabled) {
      throw new ConflictException("Steering is unavailable for durable turns; cancel the active turn and submit a new prompt instead");
    }
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

async function durableProviderTransport(
  provider: BerryModelProviderInfo,
  apiKey: string | undefined,
  credentialRef: string | undefined,
): Promise<DurableProviderTransport> {
  const secret = await durableCredential(apiKey, credentialRef);
  const safeHeaders = provider.headers
    ? Object.fromEntries(Object.entries(provider.headers).filter(([name]) =>
        !["authorization", "proxy-authorization", "x-api-key"].includes(name.toLowerCase())
      ))
    : undefined;
  return {
    id: provider.id,
    name: provider.name,
    kind: provider.kind,
    baseUrl: provider.baseUrl,
    defaultModel: provider.defaultModel,
    apiType: provider.apiType ?? "openai-chat-completions",
    ...(provider.endpointPath !== undefined ? { endpointPath: provider.endpointPath } : {}),
    ...(provider.modelsPath !== undefined ? { modelsPath: provider.modelsPath } : {}),
    authType: provider.authType ?? "bearer",
    ...(safeHeaders && Object.keys(safeHeaders).length > 0 ? { headers: safeHeaders } : {}),
    ...(provider.capabilities ? { capabilities: provider.capabilities as unknown as Record<string, unknown> } : {}),
    models: (provider.models ?? []) as unknown as Record<string, unknown>[],
    ...(provider.completionTransport ? { completionTransport: provider.completionTransport } : {}),
    ...(provider.completionFallback ? { completionFallback: provider.completionFallback } : {}),
    ...secret,
  };
}

async function durableMcpServer(server: McpServerSpec): Promise<DurableMcpServer> {
  const secret = await durableCredential(server.credential ?? undefined, server.credentialKey ?? undefined);
  const environment = server.transport === "stdio" && Object.keys(server.env).length > 0
    ? await durableEncryptedSecret(JSON.stringify(server.env), "stdio MCP environment")
    : undefined;
  return {
    id: server.id,
    name: server.name,
    transport: server.transport,
    command: server.command,
    args: server.args,
    url: server.url,
    // Stdio values frequently contain secrets, so only their encrypted
    // envelope may cross the API/Worker durability boundary.
    env: {},
    ...(environment ? { environment } : {}),
    enabled: server.enabled,
    trusted: server.trusted,
    credentialRef: secret.credentialRef ?? null,
    ...(server.cachedTools ? { cachedTools: server.cachedTools } : {}),
    ...(server.allowedTools ? { allowedTools: server.allowedTools } : {}),
    ...(server.defaultTools ? { defaultTools: server.defaultTools } : {}),
    ...(server.nonReplayableTools ? { nonReplayableTools: server.nonReplayableTools } : {}),
    ...(server.trustReadOnlyAnnotations ? { trustReadOnlyAnnotations: true } : {}),
    ...(server.approvalRequiredTools ? { approvalRequiredTools: server.approvalRequiredTools } : {}),
    ...(secret.credential ? { credential: secret.credential } : {}),
  };
}

async function durableCredential(
  secret: string | undefined,
  credentialRef: string | undefined,
): Promise<{ credentialRef?: string; credential?: Awaited<ReturnType<typeof sealDurableSecret>> }> {
  if (!secret) return credentialRef ? { credentialRef } : {};
  const encryptionKey = process.env.BERRY_DURABLE_CAPABILITY_KEY?.trim();
  if (encryptionKey) {
    return {
      ...(credentialRef ? { credentialRef } : {}),
      credential: await sealDurableSecret(secret, encryptionKey),
    };
  }
  if (credentialRef) return { credentialRef };
  throw new BadRequestException(
    "Durable custom credentials require BERRY_DURABLE_CAPABILITY_KEY or a server-owned credential reference",
  );
}

async function durableEncryptedSecret(secret: string, label: string) {
  const encryptionKey = process.env.BERRY_DURABLE_CAPABILITY_KEY?.trim();
  if (!encryptionKey) {
    throw new BadRequestException(`Durable ${label} requires BERRY_DURABLE_CAPABILITY_KEY`);
  }
  return sealDurableSecret(secret, encryptionKey);
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

function modelGovernanceMessage(reason: string): string {
  if (reason === "mode_default_enforced") return "The organization enforces a different default model for this task.";
  if (reason === "model_blocked") return "The requested model is blocked by organization policy.";
  if (reason === "mode_not_allowed") return "The requested model is not allowed by organization policy.";
  if (reason === "not_in_enforced_allowlist") return "The requested model is not in the organization allow-list.";
  if (reason === "blocked_by_organization_rule") return "The requested model is blocked for this organization.";
  if (reason === "blocked_by_department_rule") return "The requested model is blocked for your department.";
  if (reason === "blocked_by_user_rule") return "The requested model is blocked for your account.";
  return "The requested model is not allowed by organization policy.";
}

function unavailableAdmissionGroundingContext(input: {
  request: string;
  taskTitle?: string | undefined;
}): JsonValue {
  const query = [input.request, input.taskTitle]
    .filter((value): value is string => Boolean(value?.trim()))
    .join("\n");
  return {
    personalMemory: [],
    projectFacts: [],
    citations: [],
    retrieval: {
      snapshotId: null,
      queryHash: createHash("sha256").update(query).digest("hex"),
      tokenBudget: 0,
      tokensSelected: 0,
      degradedReason: "context_timeout",
    },
  };
}

function contextThresholdState(percentUsed: number | null): "unknown" | "normal" | "warning" | "critical" {
  if (percentUsed === null) return "unknown";
  if (percentUsed >= 95) return "critical";
  if (percentUsed >= 85) return "warning";
  return "normal";
}

function contextStatsAttachments(attachments: z.infer<typeof AttachmentInputSchema>[]) {
  return attachments.map((attachment, index) => ({
    id: attachment.id ?? `context-attachment-${index}`,
    name: attachment.name,
    mediaType: attachment.mediaType,
    size: attachment.size,
    ...(attachment.fileId !== undefined ? { fileId: attachment.fileId } : {}),
    ...(attachment.dataUrl !== undefined ? { dataUrl: attachment.dataUrl } : {}),
    ...(attachment.textContent !== undefined ? { textContent: attachment.textContent } : {}),
    ...(attachment.localPath !== undefined ? { localPath: attachment.localPath } : {}),
    ...(attachment.sourceKind !== undefined ? { sourceKind: attachment.sourceKind } : {}),
  }));
}

function estimatePromptTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

function estimatedPromptImprovementUsage(inputTokens: number, outputTokens: number): ChatCompletionUsage {
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheCreationTokens1h: 0,
    cacheCreationTokens5m: 0,
  };
}

export function normalizeImprovedPrompt(raw: string): string {
  let prompt = raw.trim();
  prompt = prompt.replace(/^<think>[\s\S]*?<\/think>\s*/i, "").trim();
  const fenced = prompt.match(/^```(?:[\w-]+)?\s*\n?([\s\S]*?)\n?```$/);
  if (fenced?.[1]) prompt = fenced[1].trim();
  prompt = prompt.replace(/^(?:(?:here(?:'s| is)\s+)?(?:the\s+)?(?:improved|rewritten|revised|enhanced)\s+prompt\s*:\s*)/i, "").trim();
  if (!prompt) {
    throw new BadGatewayException({
      code: "prompt_improvement_empty",
      message: "The prompt improvement model returned an empty prompt. Please try again.",
    });
  }
  return prompt;
}

export function promptImprovementSkills(prompt: string, requested: readonly string[]): string[] {
  return [...new Set(requested)].filter((name) =>
    new RegExp(`\\$${escapeRegExp(name)}(?![a-z0-9-])`).test(prompt)
  );
}

export function promptImprovementModelInput(prompt: string, skills: readonly string[]): string {
  if (skills.length === 0) return prompt;
  return [
    `Required Berry skill tokens (preserve verbatim and incorporate into the rewritten prompt): ${skills.map((name) => `$${name}`).join(", ")}`,
    "",
    "Draft prompt:",
    prompt,
  ].join("\n");
}

export function preservePromptSkillTokens(prompt: string, skills: readonly string[]): string {
  const missing = skills.filter((name) =>
    !new RegExp(`\\$${escapeRegExp(name)}(?![a-z0-9-])`).test(prompt)
  );
  return missing.length > 0
    ? `${missing.map((name) => `$${name}`).join(" ")}\n\n${prompt}`
    : prompt;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function promptImprovementUsageEvent(input: {
  requestId: string;
  userId: string | null;
  departmentId: string | null;
  provider: string;
  model: string;
  requestedModel: string;
  promptLength: number;
  resultLength: number;
  usage: ChatCompletionUsage;
  actualCostMicros: bigint;
  pricingSource: "measured" | "estimated";
  finishReason: string | null;
  startedAt: number;
  status: "completed" | "failed";
}) {
  const cacheReadTokens = input.usage.cacheReadTokens ?? 0;
  return {
    requestId: input.requestId,
    userId: input.userId,
    departmentId: input.departmentId,
    workspaceId: null,
    taskId: null,
    sessionId: null,
    toolCallId: null,
    feature: "prompt.improve",
    provider: input.provider,
    model: input.model,
    tokensIn: input.usage.inputTokens,
    tokensOut: input.usage.outputTokens,
    tokensCached: cacheReadTokens,
    cacheReadTokens,
    cacheWriteTokens: input.usage.cacheWriteTokens ?? 0,
    cacheCreationTokens1h: input.usage.cacheCreationTokens1h ?? 0,
    cacheCreationTokens5m: input.usage.cacheCreationTokens5m ?? 0,
    cacheEligible: cacheReadTokens > 0,
    cacheProvider: cacheReadTokens > 0 ? input.provider : null,
    cacheKeyHash: null,
    promptManifestHash: null,
    cacheMissReason: null,
    sandboxUsage: {},
    costRawMicros: input.actualCostMicros.toString(),
    costBilledMicros: input.actualCostMicros.toString(),
    latencyMs: Date.now() - input.startedAt,
    ttftMs: null,
    status: input.status,
    metadata: {
      requestedModel: input.requestedModel,
      promptLength: input.promptLength,
      resultLength: input.resultLength,
      pricingSource: input.pricingSource,
      finishReason: input.finishReason,
    },
    ts: new Date().toISOString(),
  };
}

function imageUsageEvent(input: {
  requestId: string;
  httpRequest: AuthenticatedRequest;
  image: { providerId: string; model: string };
  request: { prompt: string; size?: string | undefined };
  actualCostMicros: bigint;
  departmentId: string | null;
  startedAt: number;
  status: "completed" | "failed";
}) {
  return {
    requestId: input.requestId,
    userId: input.httpRequest.auth?.user.id ?? null,
    departmentId: input.departmentId,
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
