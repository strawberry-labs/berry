import {
  AgentStreamEventSchema,
  ApprovalRequestSchema,
  ArtifactLibraryItemSchema,
  MultipartUploadInitiateSchema,
  MultipartUploadPartUrlsSchema,
  StoredFilePageSchema,
  StoredFileSchema,
  BillingAccountSummarySchema,
  BillingCreditGrantCreateSchema,
  BillingCreditGrantSchema,
  BillingInvoiceSchema,
  BillingMeterEventCreateSchema,
  BillingMeterEventSchema,
  BudgetLimitSchema,
  AllowanceDefaultAssignmentSchema,
  AllowanceDefaultUpsertSchema,
  AllowanceProfileSchema,
  AllowanceProfileUpsertSchema,
  BlockedRequestPageSchema,
  BulkLimitMutationSchema,
  BulkLimitResultSchema,
  EffectiveLimitSchema,
  AlertDestinationSchema,
  AlertRuleCreateSchema,
  AlertRuleSchema,
  AuthenticationPolicySchema,
  AutoRefillConfigurationSchema,
  BillingOperationsSummarySchema,
  CreditLedgerPageSchema,
  DataGovernancePolicySchema,
  DeliveryAttemptSchema,
  ExecutionNetworkPolicySchema,
  OrganizationBillingHealthSchema,
  OrganizationProfileSchema,
  PlatformOverviewSchema,
  PlatformTenantSummarySchema,
  ReportRunSchema,
  ReportScheduleCreateSchema,
  ReportScheduleSchema,
  RolloutRuleSchema,
  PlatformRolloutMutationSchema,
  PlatformTenantProvisionSchema,
  PlatformTenantLifecycleMutationSchema,
  RouterHealthSummarySchema,
  SavedAnalyticsViewCreateSchema,
  SavedAnalyticsViewSchema,
  ServiceAccountCreateSchema,
  ServiceAccountSchema,
  ServiceAccountTokenResponseSchema,
  CloudAuditEventSchema,
  CloudAuditExportConfigSchema,
  CloudAuditExportConfigUpsertSchema,
  CloudAuditIngestRequestSchema,
  CloudAuditSettingsSchema,
  CloudAuditSettingsUpdateSchema,
  CloudUsageDashboardSchema,
  CloudUsageEventRecordSchema,
  CloudUsageIngestRequestSchema,
  CloudUsageRollupSchema,
  UsageAnalyticsQuerySchema,
  UsageAnalyticsSchema,
  UsageRequestDetailSchema,
  UsageRequestPageSchema,
  CloudWorkspaceStateSchema,
  CloudWorkspaceFileEntrySchema,
  CloudTerminalEventSchema,
  CloudTerminalSessionSchema,
  CloudGitStateSchema,
  CloudPreviewSchema,
  PersonalSkillSchema,
  PersonalSkillReviewSchema,
  PersonalMcpServerSchema,
  McpOAuthFlowSchema,
  OrgCapabilitySchema,
  EffectiveCapabilitySchema,
  DepartmentSchema,
  EffectivePermissionsSchema,
  FeatureFlagSchema,
  HostPushEventSchema,
  MessageSchema,
  ModelGovernanceDecisionSchema,
  MobileDeviceRegistrationCreateSchema,
  MobileDeviceRegistrationSchema,
  ManagedPolicyBundleSchema,
  ManagedPolicyPublishRequestSchema,
  ManagedPolicyVersionSchema,
  OrganizationSchema,
  OrgMembershipSchema,
  OrgModelDefaultSchema,
  OrgModelPolicySchema,
  OrgPermissionSchema,
  PermissionModeSchema,
  ResourceAclPrincipalTypeSchema,
  ResourceAclSchema,
  RolePermissionSetSchema,
  SsoConnectionSchema,
  SsoStartResponseSchema,
  SessionSchema,
  TaskSchema,
  QueuedFollowUpSchema,
  TurnStateSchema,
  WorkspaceSchema,
  type AgentStreamEvent,
  type ApprovalRequest,
  type ArtifactLibraryItem,
  type MultipartUploadInitiate,
  type StoredFile,
  type StoredFilePage,
  type BillingAccountSummary,
  type BillingCreditGrant,
  type BillingInvoice,
  type BillingMeterEvent,
  type BudgetLimit,
  type AllowanceDefaultAssignment,
  type AllowanceDefaultUpsert,
  type AllowanceProfile,
  type AllowanceProfileUpsert,
  type BlockedRequestPage,
  type BulkLimitMutation,
  type BulkLimitResult,
  type EffectiveLimit,
  type QuotaMetric,
  type AlertDestination,
  type AlertRule,
  type AlertRuleCreate,
  type AuthenticationPolicy,
  type AutoRefillConfiguration,
  type BillingOperationsSummary,
  type DataGovernancePolicy,
  type DeliveryAttempt,
  type ExecutionNetworkPolicy,
  type OrganizationProfile,
  type PlatformOverview,
  type PlatformTenantSummary,
  type ReportRun,
  type ReportSchedule,
  type ReportScheduleCreate,
  type RolloutRule,
  type PlatformRolloutMutation,
  type PlatformTenantProvision,
  type PlatformTenantLifecycleMutation,
  type RouterHealthSummary,
  type SavedAnalyticsView,
  type SavedAnalyticsViewCreate,
  type ServiceAccount,
  type ServiceAccountCreate,
  type ServiceAccountTokenResponse,
  type BudgetScopeType,
  type CloudAuditEvent,
  type CloudAuditExportConfig,
  type CloudAuditExportConfigUpsert,
  type CloudAuditIngestRequest,
  type CloudAuditSettings,
  type CloudAuditSettingsUpdate,
  type CloudUsageDashboard,
  type CloudUsageEventRecord,
  type CloudUsageIngestRequest,
  type CloudUsageRollup,
  type UsageAnalytics,
  type UsageAnalyticsQuery,
  type UsageRequestDetail,
  type UsageRequestPage,
  type CloudWorkspaceState,
  type CloudWorkspaceFileEntry,
  type CloudTerminalEvent,
  type CloudTerminalSession,
  type CloudGitState,
  type CloudPreview,
  type PersonalSkill,
  type PersonalSkillReview,
  type PersonalMcpServer,
  type McpOAuthFlow,
  type OrgCapability,
  type EffectiveCapability,
  type Department,
  type EffectivePermissions,
  type FeatureFlag,
  type HostPushEvent,
  type Message,
  type ModelGovernanceDecision,
  type MobileDeviceRegistration,
  type MobileDeviceRegistrationCreate,
  type ManagedPolicyBundle,
  type ManagedPolicyPublishRequest,
  type ManagedPolicyVersion,
  type OrgPermission,
  type OrgModelDefault,
  type OrgModelPolicy,
  type Organization,
  type OrgMembership,
  type PermissionMode,
  type ReasoningLevel,
  type ResourceAcl,
  type ResourceAclPrincipalType,
  type RolePermissionSet,
  type Session,
  type SsoConnection,
  type SsoStartResponse,
  type Task,
  type QueuedFollowUp,
  type TurnState,
  type Workspace,
  type AttachmentInput,
} from "@berry/shared";
import { z } from "zod";

export interface BerryApiClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch | undefined;
  headers?: HeadersInit | undefined;
}

export interface CreateTaskRequest {
  workspaceId?: string | undefined;
  workspaceKind?: "project" | "general" | undefined;
  conversationKind?: "chat" | "code" | undefined;
  title?: string | undefined;
  permissionMode?: PermissionMode | undefined;
  modelProviderId?: string | null | undefined;
  model?: string | null | undefined;
}

export interface UpdateTaskRequest {
  title?: string | undefined;
  status?: "queued" | "running" | "blocked" | "completed" | "failed" | "cancelled" | undefined;
  pinned?: boolean | undefined;
  archived?: boolean | undefined;
  conversationKind?: "chat" | "code" | undefined;
}

export interface StartTurnRequest {
  input: string;
  workspacePath: string;
  workspaceId?: string | undefined;
  permissionMode?: PermissionMode | undefined;
  provider: unknown;
  model?: string | undefined;
  apiKey?: string | undefined;
  reasoning?: ReasoningLevel | undefined;
  attachments?: AttachmentInput[] | undefined;
  /** Edit-and-resubmit: rewind to before this user message and replace it. */
  replaceFromMessageId?: string | undefined;
  /** Start this turn by promoting a queued follow-up and drain later queue entries after it. */
  drainQueuedFollowUps?: boolean | undefined;
}

export const ManagedModelCatalogSchema = z.object({
  providerId: z.string(),
  name: z.string(),
  defaultModel: z.string(),
  models: z.array(z.object({
    id: z.string(),
    name: z.string().optional(),
  }).passthrough()),
  skills: z.array(z.object({ id: z.string(), name: z.string(), description: z.string(), enabled: z.boolean() })).default([]),
  mcpServers: z.array(z.object({ id: z.string(), name: z.string(), url: z.string().url(), auth: z.enum(["none", "bearer", "oauth"]), enabled: z.boolean() })).default([]),
}).nullable();
export type ManagedModelCatalog = z.output<typeof ManagedModelCatalogSchema>;

export const ImageGenerationResponseSchema = z.object({
  model: z.string().optional(),
  created: z.number().optional(),
  data: z.array(z.object({
    url: z.string().url().optional(),
    b64_json: z.string().optional(),
    revised_prompt: z.string().optional(),
  }).refine((image) => Boolean(image.url || image.b64_json), "Generated image has no payload")),
}).passthrough();
export type ImageGenerationResponse = z.output<typeof ImageGenerationResponseSchema>;

export interface ApprovalDecisionRequest {
  decision: "approved_once" | "approved_for_session" | "approved_rule" | "denied" | "abort" | "approve" | "deny";
  remember?: boolean | undefined;
  reason?: string | undefined;
}

export interface CreateDepartmentRequest {
  parentId?: string | null | undefined;
  name: string;
  slug?: string | undefined;
  externalId?: string | null | undefined;
}

export interface CreateOrgMemberRequest {
  email: string;
  name: string;
  password: string;
  role: "admin" | "member";
}

export interface CreateSsoConnectionRequest {
  kind: "saml" | "oidc";
  slug: string;
  displayName: string;
  issuer?: string | null | undefined;
  ssoUrl?: string | null | undefined;
  metadataUrl?: string | null | undefined;
  entityId?: string | null | undefined;
  clientId?: string | null | undefined;
  clientSecretRef?: string | null | undefined;
  domains?: string[] | undefined;
  scimEnabled?: boolean | undefined;
}

export interface UpdateRolePermissionsRequest {
  permissions: OrgPermission[];
  source?: string | undefined;
}

export interface UpsertFeatureFlagRequest {
  enabled: boolean;
  roleDefaults?: Record<string, OrgPermission[]> | undefined;
}

export interface UpsertResourceAclRequest {
  resourceType: string;
  resourceId: string;
  principalType: ResourceAclPrincipalType;
  principalId: string;
  allow?: OrgPermission[] | undefined;
  deny?: OrgPermission[] | undefined;
}

export interface UpsertBudgetLimitRequest {
  scopeType: BudgetScopeType;
  scopeId: string;
  period: "day" | "month";
  softLimitMicros: string;
  hardLimitMicros: string;
  requestLimit?: number | null | undefined;
  tokenLimit?: number | null | undefined;
  sandboxMinuteLimit?: number | null | undefined;
  thresholdPercentages?: number[] | undefined;
  status: "active" | "disabled";
}

export interface UsageEventFilter {
  from?: string | undefined;
  to?: string | undefined;
  feature?: string | undefined;
  userId?: string | undefined;
  departmentId?: string | undefined;
  model?: string | undefined;
  provider?: string | undefined;
  status?: string | undefined;
  workspaceId?: string | undefined;
  agentId?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

export interface UpsertOrgModelPolicyRequest {
  providerId: string;
  model: string;
  displayName?: string | null | undefined;
  presetId?: string | null | undefined;
  apiType?: "openai-chat-completions" | "openai-responses" | "anthropic-messages" | null | undefined;
  capabilities?: Record<string, unknown> | undefined;
  status?: "allowed" | "blocked" | undefined;
  enforce?: boolean | undefined;
  modeAllow?: Array<"chat" | "code"> | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface UpsertOrgModelDefaultRequest {
  providerId: string;
  model: string;
  enforce?: boolean | undefined;
}

export interface ResolveOrgModelRequest {
  mode: "chat" | "code";
  providerId?: string | null | undefined;
  model?: string | null | undefined;
}

export type PublishManagedPolicyRequest = ManagedPolicyPublishRequest;
export type UpsertAuditExportConfigRequest = CloudAuditExportConfigUpsert;
export type UpdateAuditSettingsRequest = CloudAuditSettingsUpdate;
export type CreateBillingCreditGrantRequest = z.input<typeof BillingCreditGrantCreateSchema>;
export type CreateBillingMeterEventRequest = z.input<typeof BillingMeterEventCreateSchema>;
export type RegisterMobileDeviceRequest = MobileDeviceRegistrationCreate;

export const CreateTaskResponseSchema = z.object({
  task: TaskSchema,
  session: SessionSchema,
});
export type CreateTaskResponse = z.output<typeof CreateTaskResponseSchema>;

export const StartTurnResponseSchema = z.object({
  turnId: z.string(),
  sessionId: z.string(),
});
export type StartTurnResponse = z.output<typeof StartTurnResponseSchema>;

export const ApprovalDecisionResponseSchema = z.object({ ok: z.boolean() });
export type ApprovalDecisionResponse = z.output<typeof ApprovalDecisionResponseSchema>;

export const CancelTurnResponseSchema = z.object({ ok: z.boolean() });
export type CancelTurnResponse = z.output<typeof CancelTurnResponseSchema>;

export const DeleteMobileDeviceResponseSchema = z.object({ ok: z.boolean() });
export type DeleteMobileDeviceResponse = z.output<typeof DeleteMobileDeviceResponseSchema>;

export class BerryApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "BerryApiError";
    this.status = status;
    this.body = body;
  }
}

export class BerryApiClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #headers: HeadersInit | undefined;

  constructor(options: BerryApiClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    // Calling a stored native browser fetch as `this.#fetch(...)` supplies the
    // client instance as its receiver. Chromium rejects that as an illegal
    // invocation, so normalize every implementation through a bare call.
    this.#fetch = (...args) => fetchImpl(...args);
    this.#headers = options.headers;
  }

  async createWorkspace(input: { name: string }): Promise<Workspace> {
    return this.#request("/v1/workspaces", WorkspaceSchema, {
      method: "POST",
      body: input,
    });
  }

  async listWorkspaces(options: { includeGeneral?: boolean } = {}): Promise<Workspace[]> {
    return this.#request(`/v1/workspaces${options.includeGeneral ? "?includeGeneral=true" : ""}`, z.array(WorkspaceSchema));
  }

  async modelCatalog(): Promise<ManagedModelCatalog> {
    return this.#request("/v1/models/catalog", ManagedModelCatalogSchema);
  }

  async listPersonalSkills(): Promise<PersonalSkill[]> { return this.#request("/v1/me/skills", z.array(PersonalSkillSchema)); }
  async reviewPersonalSkill(input: { name?: string; description?: string; content?: string; source?: "text" | "upload" | "git"; sourceUrl?: string | null; version?: string | null; packageFiles?: string[] }): Promise<PersonalSkillReview> { return this.#request("/v1/me/skills/review", PersonalSkillReviewSchema, { method: "POST", body: input }); }
  async savePersonalSkill(input: { name?: string; description?: string; content?: string; source?: "text" | "upload" | "git"; sourceUrl?: string | null; version?: string | null; packageFiles?: string[]; enabled?: boolean; trusted?: boolean; confirmedHash: string }): Promise<PersonalSkill> { return this.#request("/v1/me/skills", PersonalSkillSchema, { method: "POST", body: input }); }
  async updatePersonalSkill(id: string, input: { enabled?: boolean; trusted?: boolean }): Promise<PersonalSkill> { return this.#request(`/v1/me/skills/${encodeURIComponent(id)}`, PersonalSkillSchema, { method: "PATCH", body: input }); }
  async deletePersonalSkill(id: string): Promise<{ ok: boolean }> { return this.#request(`/v1/me/skills/${encodeURIComponent(id)}`, z.object({ ok: z.boolean() }), { method: "DELETE" }); }

  async listPersonalMcpServers(): Promise<PersonalMcpServer[]> { return this.#request("/v1/me/mcp", z.array(PersonalMcpServerSchema)); }
  async savePersonalMcpServer(input: { name: string; url: string; transport: "http-sse" | "streamable-http"; auth: "none" | "bearer" | "oauth"; credential?: string; enabled?: boolean; trusted?: boolean }): Promise<PersonalMcpServer> { return this.#request("/v1/me/mcp", PersonalMcpServerSchema, { method: "POST", body: input }); }
  async updatePersonalMcpServer(id: string, input: { enabled?: boolean; trusted?: boolean }): Promise<PersonalMcpServer> { return this.#request(`/v1/me/mcp/${encodeURIComponent(id)}`, PersonalMcpServerSchema, { method: "PATCH", body: input }); }
  async deletePersonalMcpServer(id: string): Promise<{ ok: boolean }> { return this.#request(`/v1/me/mcp/${encodeURIComponent(id)}`, z.object({ ok: z.boolean() }), { method: "DELETE" }); }
  async testPersonalMcpServer(id: string): Promise<PersonalMcpServer> { return this.#request(`/v1/me/mcp/${encodeURIComponent(id)}/health`, PersonalMcpServerSchema, { method: "POST" }); }
  async reconnectPersonalMcpServer(id: string): Promise<PersonalMcpServer> { return this.#request(`/v1/me/mcp/${encodeURIComponent(id)}/reconnect`, PersonalMcpServerSchema, { method: "POST" }); }
  async startPersonalMcpOAuth(id: string, redirectUri: string): Promise<McpOAuthFlow> { return this.#request(`/v1/me/mcp/${encodeURIComponent(id)}/oauth/start`, McpOAuthFlowSchema, { method: "POST", body: { redirectUri } }); }
  async completePersonalMcpOAuth(state: string, code: string): Promise<PersonalMcpServer> { return this.#request("/v1/me/mcp/oauth/complete", PersonalMcpServerSchema, { method: "POST", body: { state, code } }); }
  async pollPersonalMcpOAuth(state: string): Promise<{ status: "pending" | "complete"; serverId: string | null }> { return this.#request("/v1/me/mcp/oauth/poll", z.object({ status: z.enum(["pending", "complete"]), serverId: z.string().nullable() }), { method: "POST", body: { state } }); }
  async listOrganizationCapabilities(tenantId: string): Promise<OrgCapability[]> { return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/capabilities`, z.array(OrgCapabilitySchema)); }
  async upsertOrganizationCapability(tenantId: string, input: { kind: "skill" | "mcp"; capabilityId: string; name: string; description?: string; assignment: "required" | "default-on" | "available" | "blocked"; allowUserDisable?: boolean; contentHash?: string | null; config?: Record<string, unknown> }): Promise<OrgCapability> { return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/capabilities`, OrgCapabilitySchema, { method: "POST", body: input }); }
  async reviewOrganizationSkill(tenantId: string, input: { content?: string; source?: "text" | "upload" | "git"; sourceUrl?: string | null; packageFiles?: string[] }): Promise<PersonalSkillReview> { return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/capabilities/skills/review`, PersonalSkillReviewSchema, { method: "POST", body: input }); }
  async deleteOrganizationCapability(tenantId: string, id: string): Promise<{ ok: boolean }> { return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/capabilities/${encodeURIComponent(id)}`, z.object({ ok: z.boolean() }), { method: "DELETE" }); }
  async effectiveCapabilities(tenantId: string): Promise<EffectiveCapability[]> { return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/capabilities/effective/me`, z.array(EffectiveCapabilitySchema)); }
  async setCapabilityOverride(tenantId: string, kind: "skill" | "mcp", capabilityId: string, enabled: boolean): Promise<unknown> { return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/capabilities/effective/me/${kind}/${encodeURIComponent(capabilityId)}`, z.unknown(), { method: "PATCH", body: { enabled } }); }
  async organizationCapabilitySettings(tenantId: string): Promise<{ skills: boolean; mcp: boolean }> { return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/capabilities/settings/personal-additions`, z.object({ skills: z.boolean(), mcp: z.boolean() })); }
  async updateOrganizationCapabilitySettings(tenantId: string, input: { skills: boolean; mcp: boolean }): Promise<{ skills: boolean; mcp: boolean }> { return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/capabilities/settings/personal-additions`, z.object({ skills: z.boolean(), mcp: z.boolean() }), { method: "PATCH", body: input }); }

  async generateImage(input: { prompt: string; model?: string | undefined; size?: string | undefined }): Promise<ImageGenerationResponse> {
    return this.#request("/v1/images/generations", ImageGenerationResponseSchema, {
      method: "POST",
      body: input,
    });
  }

  async createTask(input: CreateTaskRequest): Promise<CreateTaskResponse> {
    PermissionModeSchema.optional().parse(input.permissionMode);
    return this.#request("/v1/tasks", CreateTaskResponseSchema, {
      method: "POST",
      body: input,
    });
  }

  async listTasks(filter: { workspaceId?: string | undefined; workspaceKind?: "project" | "general" | undefined; includeDeleted?: boolean | undefined; limit?: number | undefined; offset?: number | undefined } = {}): Promise<Task[]> {
    const params = new URLSearchParams();
    if (filter.workspaceId) params.set("workspaceId", filter.workspaceId);
    if (filter.workspaceKind) params.set("workspaceKind", filter.workspaceKind);
    if (filter.includeDeleted) params.set("includeDeleted", "true");
    if (filter.limit !== undefined) params.set("limit", String(filter.limit));
    if (filter.offset !== undefined) params.set("offset", String(filter.offset));
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return this.#request(`/v1/tasks${suffix}`, z.array(TaskSchema));
  }

  async getTask(taskId: string): Promise<Task> {
    return this.#request(`/v1/tasks/${encodeURIComponent(taskId)}`, TaskSchema);
  }

  async ensureTaskWorkspace(taskId: string): Promise<CloudWorkspaceState> {
    return this.#request(`/v1/tasks/${encodeURIComponent(taskId)}/workspace`, CloudWorkspaceStateSchema, { method: "POST" });
  }

  async taskWorkspace(taskId: string): Promise<CloudWorkspaceState> {
    return this.#request(`/v1/tasks/${encodeURIComponent(taskId)}/workspace`, CloudWorkspaceStateSchema);
  }

  async listWorkspaceFiles(taskId: string, path = "/workspace"): Promise<CloudWorkspaceFileEntry[]> {
    return this.#request(`/v1/tasks/${encodeURIComponent(taskId)}/workspace/files?path=${encodeURIComponent(path)}`, z.array(CloudWorkspaceFileEntrySchema));
  }

  async readWorkspaceFile(taskId: string, path: string): Promise<{ path: string; content: string; sizeBytes: number; mtime: string | null }> {
    return this.#request(`/v1/tasks/${encodeURIComponent(taskId)}/workspace/file?path=${encodeURIComponent(path)}`, z.object({ path: z.string(), content: z.string(), sizeBytes: z.number(), mtime: z.string().nullable() }));
  }

  async writeWorkspaceFile(taskId: string, path: string, content: string): Promise<{ path: string; sizeBytes: number; mtime: string }> {
    return this.#request(`/v1/tasks/${encodeURIComponent(taskId)}/workspace/file`, z.object({ path: z.string(), sizeBytes: z.number(), mtime: z.string() }), { method: "PUT", body: { path, content } });
  }

  async listWorkspaceTerminals(taskId: string): Promise<CloudTerminalSession[]> {
    return this.#request(`/v1/tasks/${encodeURIComponent(taskId)}/workspace/terminals`, z.array(CloudTerminalSessionSchema));
  }

  async createWorkspaceTerminal(taskId: string, input: { cols?: number; rows?: number } = {}): Promise<CloudTerminalSession> {
    return this.#request(`/v1/tasks/${encodeURIComponent(taskId)}/workspace/terminals`, CloudTerminalSessionSchema, { method: "POST", body: input });
  }

  async writeWorkspaceTerminal(taskId: string, terminalId: string, input: string, approved = false): Promise<CloudTerminalSession> {
    return this.#request(`/v1/tasks/${encodeURIComponent(taskId)}/workspace/terminals/${encodeURIComponent(terminalId)}/input`, CloudTerminalSessionSchema, { method: "POST", body: { input, approved } });
  }

  async resizeWorkspaceTerminal(taskId: string, terminalId: string, cols: number, rows: number): Promise<CloudTerminalSession> {
    return this.#request(`/v1/tasks/${encodeURIComponent(taskId)}/workspace/terminals/${encodeURIComponent(terminalId)}`, CloudTerminalSessionSchema, { method: "PATCH", body: { cols, rows } });
  }

  async closeWorkspaceTerminal(taskId: string, terminalId: string): Promise<CloudTerminalSession> {
    return this.#request(`/v1/tasks/${encodeURIComponent(taskId)}/workspace/terminals/${encodeURIComponent(terminalId)}`, CloudTerminalSessionSchema, { method: "DELETE" });
  }

  async workspaceTerminalEvents(taskId: string, terminalId: string, after = -1): Promise<CloudTerminalEvent[]> {
    return this.#request(`/v1/tasks/${encodeURIComponent(taskId)}/workspace/terminals/${encodeURIComponent(terminalId)}/events?after=${after}`, z.array(CloudTerminalEventSchema));
  }

  subscribeWorkspaceTerminal(taskId: string, terminalId: string, callbacks: { onEvents: (events: CloudTerminalEvent[]) => void; onError?: (error: Error) => void }, pollMs = 350): { close: () => void } {
    let closed = false;
    let after = -1;
    const poll = async () => {
      try {
        const events = await this.workspaceTerminalEvents(taskId, terminalId, after);
        if (events.length > 0) {
          after = events.at(-1)!.ordinal;
          callbacks.onEvents(events);
        }
      } catch (cause) {
        callbacks.onError?.(cause instanceof Error ? cause : new Error("Terminal stream failed"));
      }
      if (!closed) globalThis.setTimeout(() => void poll(), pollMs);
    };
    void poll();
    return { close: () => { closed = true; } };
  }

  async workspaceGit(taskId: string): Promise<CloudGitState> {
    return this.#request(`/v1/tasks/${encodeURIComponent(taskId)}/workspace/git`, CloudGitStateSchema);
  }

  async listWorkspacePreviews(taskId: string): Promise<CloudPreview[]> {
    return this.#request(`/v1/tasks/${encodeURIComponent(taskId)}/workspace/previews`, z.array(CloudPreviewSchema));
  }

  async exposeWorkspacePreview(taskId: string, port: number, approved = false): Promise<CloudPreview> {
    return this.#request(`/v1/tasks/${encodeURIComponent(taskId)}/workspace/previews`, CloudPreviewSchema, { method: "POST", body: { port, approved } });
  }

  async captureWorkspace(taskId: string): Promise<{ state: CloudWorkspaceState; previews: CloudPreview[]; terminals: CloudTerminalSession[] }> {
    return this.#request(`/v1/tasks/${encodeURIComponent(taskId)}/workspace/capture`, z.object({ state: CloudWorkspaceStateSchema, previews: z.array(CloudPreviewSchema), terminals: z.array(CloudTerminalSessionSchema) }));
  }

  async listArtifacts(): Promise<ArtifactLibraryItem[]> {
    return this.#request("/v1/artifacts", z.array(ArtifactLibraryItemSchema));
  }

  async uploadArtifact(input: { name: string; mediaType: string; dataUrl: string }): Promise<ArtifactLibraryItem> {
    return this.#request("/v1/artifacts", ArtifactLibraryItemSchema, {
      method: "POST",
      body: input,
    });
  }

  async listFiles(input: { taskId?: string; category?: "images" | "documents"; search?: string; cursor?: string; limit?: number } = {}): Promise<StoredFilePage> {
    const page = await this.#request(`/v1/files${usageQuery(input)}`, StoredFilePageSchema);
    return { ...page, items: page.items.map((file) => this.#resolveFileUrls(file)) };
  }

  async getFile(fileId: string): Promise<StoredFile> {
    return this.#resolveFileUrls(await this.#request(`/v1/files/${encodeURIComponent(fileId)}`, StoredFileSchema));
  }

  async initiateFileUpload(input: { name: string; mediaType: string; size: number; taskId?: string; sessionId?: string; sha256?: string; origin?: "user_upload" | "image_generation" | "browser_capture"; associationRole?: "input" | "output" | "reference" }): Promise<MultipartUploadInitiate> {
    return this.#request("/v1/files/uploads", MultipartUploadInitiateSchema, { method: "POST", body: input });
  }

  async uploadFile(file: File, input: { taskId?: string; sessionId?: string; origin?: "user_upload" | "image_generation" | "browser_capture"; associationRole?: "input" | "output" | "reference"; concurrency?: number; onProgress?: (progress: { uploadedBytes: number; totalBytes: number; ratio: number }) => void; signal?: AbortSignal } = {}): Promise<StoredFile> {
    const upload = await this.initiateFileUpload({
      name: file.name,
      mediaType: file.type || "application/octet-stream",
      size: file.size,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.associationRole ? { associationRole: input.associationRole } : {}),
    });
    const partNumbers = Array.from({ length: upload.partCount }, (_, index) => index + 1);
    const signedBatches = await Promise.all(chunk(partNumbers, 100).map((batch) => this.#request(
      `/v1/files/${encodeURIComponent(upload.fileId)}/uploads/${encodeURIComponent(upload.uploadId)}/parts`,
      MultipartUploadPartUrlsSchema,
      { method: "POST", body: { partNumbers: batch } },
    )));
    const urls = new Map(signedBatches.flatMap((signed) => signed.parts).map((part) => [part.partNumber, part.url]));
    const completed: Array<{ partNumber: number; etag: string }> = [];
    let uploadedBytes = 0;
    let cursor = 0;
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", abortFromCaller, { once: true });
    if (input.signal?.aborted) abortFromCaller();
    const worker = async () => {
      while (cursor < partNumbers.length) {
        const partNumber = partNumbers[cursor++]!;
        if (controller.signal.aborted) throw new DOMException("Upload aborted", "AbortError");
        const start = (partNumber - 1) * upload.partSize;
        const end = Math.min(file.size, start + upload.partSize);
        const response = await this.#fetch(urls.get(partNumber)!, { method: "PUT", body: file.slice(start, end), signal: controller.signal });
        if (!response.ok) throw new BerryApiError(`File part ${partNumber} failed with ${response.status}`, response.status, await response.text());
        const etag = response.headers.get("etag");
        if (!etag) throw new Error("Object storage did not expose the ETag response header");
        completed.push({ partNumber, etag });
        uploadedBytes += end - start;
        input.onProgress?.({ uploadedBytes, totalBytes: file.size, ratio: file.size === 0 ? 1 : uploadedBytes / file.size });
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(Math.max(1, input.concurrency ?? 4), upload.partCount) }, worker));
      return this.#resolveFileUrls(await this.#request(
        `/v1/files/${encodeURIComponent(upload.fileId)}/uploads/${encodeURIComponent(upload.uploadId)}/complete`,
        StoredFileSchema,
        { method: "POST", body: { parts: completed.sort((left, right) => left.partNumber - right.partNumber) } },
      ));
    } catch (error) {
      controller.abort(error);
      await this.#rawRequest(`/v1/files/${encodeURIComponent(upload.fileId)}/uploads/${encodeURIComponent(upload.uploadId)}`, { method: "DELETE" }).catch(() => undefined);
      throw error;
    } finally {
      input.signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  async updateTask(taskId: string, input: UpdateTaskRequest): Promise<Task> {
    return this.#request(`/v1/tasks/${encodeURIComponent(taskId)}`, TaskSchema, {
      method: "PATCH",
      body: input,
    });
  }

  async deleteTask(taskId: string): Promise<Task> {
    return this.#request(`/v1/tasks/${encodeURIComponent(taskId)}`, TaskSchema, { method: "DELETE" });
  }

  async restoreTask(taskId: string): Promise<Task> {
    return this.#request(`/v1/tasks/${encodeURIComponent(taskId)}/restore`, TaskSchema, { method: "POST" });
  }

  async createSession(taskId: string, input: { parentSessionId?: string | null | undefined; permissionMode?: PermissionMode | undefined } = {}): Promise<Session> {
    return this.#request(`/v1/tasks/${encodeURIComponent(taskId)}/sessions`, SessionSchema, {
      method: "POST",
      body: input,
    });
  }

  async listMessages(sessionId: string): Promise<Message[]> {
    return this.#request(`/v1/sessions/${encodeURIComponent(sessionId)}/messages`, z.array(MessageSchema));
  }

  async turnState(sessionId: string): Promise<TurnState> {
    return this.#request(`/v1/sessions/${encodeURIComponent(sessionId)}/turn-state`, TurnStateSchema);
  }

  async appendMessage(sessionId: string, input: { role?: "system" | "user" | "assistant" | "tool" | undefined; parts: Array<{ kind: string; content: unknown }> }): Promise<Message> {
    return this.#request(`/v1/sessions/${encodeURIComponent(sessionId)}/messages`, MessageSchema, {
      method: "POST",
      body: input,
    });
  }

  async startTurn(sessionId: string, input: StartTurnRequest): Promise<StartTurnResponse> {
    return this.#request(`/v1/sessions/${encodeURIComponent(sessionId)}/turns`, StartTurnResponseSchema, {
      method: "POST",
      body: input,
    });
  }

  async cancelTurn(sessionId: string): Promise<CancelTurnResponse> {
    return this.#request(`/v1/sessions/${encodeURIComponent(sessionId)}/cancel`, CancelTurnResponseSchema, {
      method: "POST",
    });
  }

  async steerTurn(sessionId: string, input: { input: string; attachments?: AttachmentInput[] | undefined }): Promise<{ queued: true }> {
    return this.#request(`/v1/sessions/${encodeURIComponent(sessionId)}/steer`, z.object({ queued: z.literal(true) }), {
      method: "POST",
      body: input,
    });
  }

  async listFollowUps(sessionId: string): Promise<QueuedFollowUp[]> {
    return this.#request(`/v1/sessions/${encodeURIComponent(sessionId)}/follow-ups`, z.array(QueuedFollowUpSchema));
  }

  async followUpTurn(sessionId: string, input: { input: string; attachments?: AttachmentInput[] | undefined }): Promise<QueuedFollowUp> {
    return this.#request(`/v1/sessions/${encodeURIComponent(sessionId)}/follow-ups`, QueuedFollowUpSchema, { method: "POST", body: input });
  }

  async reorderFollowUps(sessionId: string, followUpIds: string[]): Promise<QueuedFollowUp[]> {
    return this.#request(`/v1/sessions/${encodeURIComponent(sessionId)}/follow-ups/reorder`, z.array(QueuedFollowUpSchema), {
      method: "POST",
      body: { followUpIds },
    });
  }

  async resumeFollowUps(sessionId: string): Promise<QueuedFollowUp[]> {
    return this.#request(`/v1/sessions/${encodeURIComponent(sessionId)}/follow-ups/resume`, z.array(QueuedFollowUpSchema), { method: "POST" });
  }

  async updateFollowUp(followUpId: string, input: Partial<Pick<QueuedFollowUp, "input" | "attachments" | "status" | "error" | "pausedReason">>): Promise<QueuedFollowUp> {
    return this.#request(`/v1/follow-ups/${encodeURIComponent(followUpId)}`, QueuedFollowUpSchema, { method: "PATCH", body: input });
  }

  async steerFollowUp(followUpId: string): Promise<{ queued: true }> {
    return this.#request(`/v1/follow-ups/${encodeURIComponent(followUpId)}/steer`, z.object({ queued: z.literal(true) }), {
      method: "POST",
    });
  }

  async removeFollowUp(followUpId: string): Promise<QueuedFollowUp> {
    return this.#request(`/v1/follow-ups/${encodeURIComponent(followUpId)}`, QueuedFollowUpSchema, { method: "DELETE" });
  }

  async answerQuestion(
    questionId: string,
    input: {
      answer: string;
      selectedOptions?: string[] | undefined;
      answers?: Array<{ question: string; answer: string; selectedOptions?: string[] | undefined; skipped?: boolean | undefined }> | undefined;
    },
  ): Promise<{ ok: boolean }> {
    return this.#request(`/v1/questions/${encodeURIComponent(questionId)}/answer`, z.object({ ok: z.boolean() }), {
      method: "POST",
      body: input,
    });
  }

  async decideApproval(approvalId: string, input: ApprovalDecisionRequest): Promise<ApprovalDecisionResponse> {
    return this.#request(`/v1/approvals/${encodeURIComponent(approvalId)}/decision`, ApprovalDecisionResponseSchema, {
      method: "POST",
      body: input,
    });
  }

  async listApprovals(): Promise<ApprovalRequest[]> {
    return this.#request("/v1/approvals", z.array(ApprovalRequestSchema));
  }

  async registerMobileDevice(input: RegisterMobileDeviceRequest): Promise<MobileDeviceRegistration> {
    MobileDeviceRegistrationCreateSchema.parse(input);
    return this.#request("/v1/devices", MobileDeviceRegistrationSchema, {
      method: "POST",
      body: input,
    });
  }

  async listMobileDevices(): Promise<MobileDeviceRegistration[]> {
    return this.#request("/v1/devices", z.array(MobileDeviceRegistrationSchema));
  }

  async deleteMobileDevice(deviceId: string): Promise<DeleteMobileDeviceResponse> {
    return this.#request(`/v1/devices/${encodeURIComponent(deviceId)}`, DeleteMobileDeviceResponseSchema, {
      method: "DELETE",
    });
  }

  async listOrganizations(host?: string | undefined): Promise<Organization[]> {
    const suffix = host ? `?host=${encodeURIComponent(host)}` : "";
    return this.#request(`/v1/orgs${suffix}`, z.array(OrganizationSchema));
  }

  async currentOrganization(host?: string | undefined): Promise<Organization> {
    const suffix = host ? `?host=${encodeURIComponent(host)}` : "";
    return this.#request(`/v1/orgs/current${suffix}`, OrganizationSchema);
  }

  async listOrgMembers(tenantId: string): Promise<OrgMembership[]> {
    return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/members`, z.array(OrgMembershipSchema));
  }

  async createOrgMember(tenantId: string, input: CreateOrgMemberRequest): Promise<OrgMembership> {
    return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/members`, OrgMembershipSchema, {
      method: "POST",
      body: input,
    });
  }

  async listDepartments(tenantId: string): Promise<Department[]> {
    return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/departments`, z.array(DepartmentSchema));
  }

  async createDepartment(tenantId: string, input: CreateDepartmentRequest): Promise<Department> {
    return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/departments`, DepartmentSchema, {
      method: "POST",
      body: input,
    });
  }

  async effectivePermissions(tenantId: string): Promise<EffectivePermissions> {
    return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/permissions/me`, EffectivePermissionsSchema);
  }

  async listRolePermissions(tenantId: string): Promise<RolePermissionSet[]> {
    return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/roles`, z.array(RolePermissionSetSchema));
  }

  async updateRolePermissions(tenantId: string, role: string, input: UpdateRolePermissionsRequest): Promise<RolePermissionSet> {
    z.array(OrgPermissionSchema).parse(input.permissions);
    return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/roles/${encodeURIComponent(role)}/permissions`, RolePermissionSetSchema, {
      method: "PUT",
      body: input,
    });
  }

  async listFeatureFlags(tenantId: string): Promise<FeatureFlag[]> {
    return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/feature-flags`, z.array(FeatureFlagSchema));
  }

  async upsertFeatureFlag(tenantId: string, flag: string, input: UpsertFeatureFlagRequest): Promise<FeatureFlag> {
    return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/feature-flags/${encodeURIComponent(flag)}`, FeatureFlagSchema, {
      method: "PUT",
      body: input,
    });
  }

  async listResourceAcls(tenantId: string, resource?: { resourceType: string; resourceId: string } | undefined): Promise<ResourceAcl[]> {
    const params = new URLSearchParams();
    if (resource) {
      params.set("resourceType", resource.resourceType);
      params.set("resourceId", resource.resourceId);
    }
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/acls${suffix}`, z.array(ResourceAclSchema));
  }

  async upsertResourceAcl(tenantId: string, input: UpsertResourceAclRequest): Promise<ResourceAcl> {
    ResourceAclPrincipalTypeSchema.parse(input.principalType);
    return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/acls`, ResourceAclSchema, {
      method: "PUT",
      body: input,
    });
  }

  async listBudgetLimits(tenantId: string): Promise<BudgetLimit[]> {
    return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/budgets/limits`, z.array(BudgetLimitSchema));
  }

  async upsertBudgetLimit(tenantId: string, input: UpsertBudgetLimitRequest): Promise<BudgetLimit> {
    return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/budgets/limits`, BudgetLimitSchema, {
      method: "PUT",
      body: input,
    });
  }

  async listAllowanceProfiles(tenantId: string): Promise<AllowanceProfile[]> {
    return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/allowances/profiles`, z.array(AllowanceProfileSchema));
  }

  async upsertAllowanceProfile(tenantId: string, input: AllowanceProfileUpsert, id?: string): Promise<AllowanceProfile> {
    AllowanceProfileUpsertSchema.parse(input);
    return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/allowances/profiles${id ? `/${encodeURIComponent(id)}` : ""}`, AllowanceProfileSchema, { method: id ? "PUT" : "POST", body: input });
  }

  async listAllowanceDefaults(tenantId: string): Promise<AllowanceDefaultAssignment[]> {
    return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/allowances/defaults`, z.array(AllowanceDefaultAssignmentSchema));
  }

  async upsertAllowanceDefault(tenantId: string, input: AllowanceDefaultUpsert): Promise<AllowanceDefaultAssignment> {
    AllowanceDefaultUpsertSchema.parse(input);
    return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/allowances/defaults`, AllowanceDefaultAssignmentSchema, { method: "PUT", body: input });
  }

  async bulkUpsertAllowanceLimits(tenantId: string, input: BulkLimitMutation): Promise<BulkLimitResult> {
    BulkLimitMutationSchema.parse(input);
    return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/allowances/limits/bulk`, BulkLimitResultSchema, { method: "POST", body: input });
  }

  async effectiveAllowance(tenantId: string, userId: string, metric: QuotaMetric = "cost", period: "day" | "month" = "month"): Promise<EffectiveLimit> {
    const params = new URLSearchParams({ metric, period });
    return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/allowances/effective/${encodeURIComponent(userId)}?${params}`, EffectiveLimitSchema);
  }

  async blockedAllowanceRequests(tenantId: string, input: { cursor?: string; limit?: number } = {}): Promise<BlockedRequestPage> {
    return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/allowances/blocked${usageQuery(input)}`, BlockedRequestPageSchema);
  }

  async ingestUsageEvent(tenantId: string, input: CloudUsageIngestRequest): Promise<CloudUsageEventRecord> {
    CloudUsageIngestRequestSchema.parse(input);
    return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/usage/events`, CloudUsageEventRecordSchema, {
      method: "POST",
      body: input,
    });
  }

  async listUsageEvents(tenantId: string, filter: UsageEventFilter = {}): Promise<CloudUsageEventRecord[]> {
    return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/usage/events${usageQuery(filter)}`, z.array(CloudUsageEventRecordSchema));
  }

  async listUsageRollups(tenantId: string, filter: UsageEventFilter = {}): Promise<CloudUsageRollup[]> {
    return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/usage/rollups${usageQuery(filter)}`, z.array(CloudUsageRollupSchema));
  }

  async usageDashboard(tenantId: string, filter: UsageEventFilter = {}): Promise<CloudUsageDashboard> {
    return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/usage/dashboard${usageQuery(filter)}`, CloudUsageDashboardSchema);
  }

  async usageAnalytics(tenantId: string, query: UsageAnalyticsQuery): Promise<UsageAnalytics> {
    const parsed = UsageAnalyticsQuerySchema.parse(query);
    return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/usage/analytics${usageQuery(parsed)}`, UsageAnalyticsSchema);
  }

  async usageRequests(tenantId: string, query: UsageAnalyticsQuery): Promise<UsageRequestPage> {
    const parsed = UsageAnalyticsQuerySchema.parse(query);
    return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/usage/requests${usageQuery(parsed)}`, UsageRequestPageSchema);
  }

  async usageRequestDetail(tenantId: string, requestId: string): Promise<UsageRequestDetail> {
    return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/usage/requests/${encodeURIComponent(requestId)}`, UsageRequestDetailSchema);
  }

  async myUsage(tenantId: string, query: UsageAnalyticsQuery): Promise<UsageAnalytics> {
    const parsed = UsageAnalyticsQuerySchema.parse(query);
    return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/usage/me${usageQuery(parsed)}`, UsageAnalyticsSchema);
  }

  async exportMyUsageCsv(tenantId: string, filter: UsageEventFilter = {}): Promise<string> {
    return this.#textRequest(`/v1/orgs/${encodeURIComponent(tenantId)}/usage/me/export.csv${usageQuery(filter)}`);
  }

  async exportUsageCsv(tenantId: string, filter: UsageEventFilter = {}): Promise<string> {
    return this.#textRequest(`/v1/orgs/${encodeURIComponent(tenantId)}/usage/export.csv${usageQuery(filter)}`);
  }

  async billingSummary(tenantId: string): Promise<BillingAccountSummary> {
    return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/billing`, BillingAccountSummarySchema);
  }

  async createBillingCreditGrant(tenantId: string, input: CreateBillingCreditGrantRequest): Promise<BillingCreditGrant> {
    BillingCreditGrantCreateSchema.parse(input);
    return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/billing/credits`, BillingCreditGrantSchema, {
      method: "POST",
      body: input,
    });
  }

  async reportBillingMeterEvent(tenantId: string, input: CreateBillingMeterEventRequest): Promise<BillingMeterEvent> {
    BillingMeterEventCreateSchema.parse(input);
    return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/billing/meter-events`, BillingMeterEventSchema, {
      method: "POST",
      body: input,
    });
  }

  async listBillingInvoices(tenantId: string): Promise<BillingInvoice[]> {
    return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/billing/invoices`, z.array(BillingInvoiceSchema));
  }

  async billingHealth(tenantId:string){return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/billing/health`,OrganizationBillingHealthSchema);}
  async billingLedger(tenantId:string){return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/billing/ledger`,CreditLedgerPageSchema);}
  async autoRefill(tenantId:string){return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/billing/auto-refill`,AutoRefillConfigurationSchema);}
  async updateAutoRefill(tenantId:string,input:Omit<AutoRefillConfiguration,"supported">&{reason:string;confirmation:true;idempotencyKey:string}){return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/billing/auto-refill`,AutoRefillConfigurationSchema,{method:"POST",body:input});}

  async savedAnalyticsViews(tenantId:string):Promise<SavedAnalyticsView[]>{return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/analytics/views`,z.array(SavedAnalyticsViewSchema));}
  async createSavedAnalyticsView(tenantId:string,input:SavedAnalyticsViewCreate):Promise<SavedAnalyticsView>{SavedAnalyticsViewCreateSchema.parse(input);return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/analytics/views`,SavedAnalyticsViewSchema,{method:"POST",body:input});}
  async reportSchedules(tenantId:string):Promise<ReportSchedule[]>{return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/reports/schedules`,z.array(ReportScheduleSchema));}
  async createReportSchedule(tenantId:string,input:ReportScheduleCreate):Promise<ReportSchedule>{ReportScheduleCreateSchema.parse(input);return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/reports/schedules`,ReportScheduleSchema,{method:"POST",body:input});}
  async reportRuns(tenantId:string):Promise<ReportRun[]>{return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/reports/runs`,z.array(ReportRunSchema));}
  async alertDestinations(tenantId:string):Promise<AlertDestination[]>{return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/alerts/destinations`,z.array(AlertDestinationSchema));}
  async createAlertDestination(tenantId:string,input:{kind:"email"|"webhook";label:string;emailRecipients:string[];secret?:string}):Promise<AlertDestination>{return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/alerts/destinations`,AlertDestinationSchema,{method:"POST",body:input});}
  async alertRules(tenantId:string):Promise<AlertRule[]>{return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/alerts/rules`,z.array(AlertRuleSchema));}
  async createAlertRule(tenantId:string,input:AlertRuleCreate):Promise<AlertRule>{AlertRuleCreateSchema.parse(input);return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/alerts/rules`,AlertRuleSchema,{method:"POST",body:input});}
  async alertDeliveries(tenantId:string):Promise<DeliveryAttempt[]>{return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/alerts/deliveries`,z.array(DeliveryAttemptSchema));}
  async executionPolicy(tenantId:string):Promise<ExecutionNetworkPolicy>{return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/policies/execution`,ExecutionNetworkPolicySchema);}
  async updateExecutionPolicy(tenantId:string,input:Omit<ExecutionNetworkPolicy,"tenantId"|"updatedAt">):Promise<ExecutionNetworkPolicy>{return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/policies/execution`,ExecutionNetworkPolicySchema,{method:"PUT",body:input});}
  async authenticationPolicy(tenantId:string):Promise<AuthenticationPolicy>{return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/policies/authentication`,AuthenticationPolicySchema);}
  async updateAuthenticationPolicy(tenantId:string,input:Omit<AuthenticationPolicy,"tenantId"|"updatedAt">):Promise<AuthenticationPolicy>{return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/policies/authentication`,AuthenticationPolicySchema,{method:"PUT",body:input});}
  async dataGovernancePolicy(tenantId:string):Promise<DataGovernancePolicy>{return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/policies/data`,DataGovernancePolicySchema);}
  async updateDataGovernancePolicy(tenantId:string,input:Omit<DataGovernancePolicy,"tenantId"|"updatedAt">):Promise<DataGovernancePolicy>{return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/policies/data`,DataGovernancePolicySchema,{method:"PUT",body:input});}
  async organizationProfile(tenantId:string):Promise<OrganizationProfile>{return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/profile`,OrganizationProfileSchema);}
  async updateOrganizationProfile(tenantId:string,input:Omit<OrganizationProfile,"tenantId"|"domains"|"updatedAt">):Promise<OrganizationProfile>{return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/profile`,OrganizationProfileSchema,{method:"PUT",body:input});}
  async serviceAccounts(tenantId:string):Promise<ServiceAccount[]>{return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/service-accounts`,z.array(ServiceAccountSchema));}
  async createServiceAccount(tenantId:string,input:ServiceAccountCreate):Promise<ServiceAccountTokenResponse>{ServiceAccountCreateSchema.parse(input);return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/service-accounts`,ServiceAccountTokenResponseSchema,{method:"POST",body:input});}
  async revokeServiceAccount(tenantId:string,id:string):Promise<ServiceAccount>{return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/service-accounts/${encodeURIComponent(id)}/revoke`,ServiceAccountSchema,{method:"POST"});}
  async platformOverview():Promise<PlatformOverview>{return this.#request("/v1/platform/overview",PlatformOverviewSchema);}
  async platformOrganizations():Promise<PlatformTenantSummary[]>{return this.#request("/v1/platform/organizations",z.array(PlatformTenantSummarySchema));}
  async provisionPlatformOrganization(input:PlatformTenantProvision):Promise<PlatformTenantSummary>{PlatformTenantProvisionSchema.parse(input);return this.#request("/v1/platform/organizations",PlatformTenantSummarySchema,{method:"POST",body:input});}
  async updatePlatformOrganizationLifecycle(tenantId:string,input:PlatformTenantLifecycleMutation):Promise<PlatformTenantSummary>{PlatformTenantLifecycleMutationSchema.parse(input);return this.#request(`/v1/platform/organizations/${encodeURIComponent(tenantId)}/lifecycle`,PlatformTenantSummarySchema,{method:"POST",body:input});}
  async platformRouterHealth():Promise<RouterHealthSummary>{return this.#request("/v1/platform/router-health",RouterHealthSummarySchema);}
  async platformBilling():Promise<BillingOperationsSummary>{return this.#request("/v1/platform/billing",BillingOperationsSummarySchema);}
  async platformRollouts():Promise<RolloutRule[]>{return this.#request("/v1/platform/rollouts",z.array(RolloutRuleSchema));}
  async upsertPlatformRollout(input:PlatformRolloutMutation):Promise<RolloutRule>{PlatformRolloutMutationSchema.parse(input);return this.#request("/v1/platform/rollouts",RolloutRuleSchema,{method:"POST",body:input});}

  async listOrgModels(tenantId: string, filter: { mode?: "chat" | "code" | undefined; includeBlocked?: boolean | undefined } = {}): Promise<OrgModelPolicy[]> {
    const params = new URLSearchParams();
    if (filter.mode) params.set("mode", filter.mode);
    if (filter.includeBlocked) params.set("includeBlocked", "true");
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/models${suffix}`, z.array(OrgModelPolicySchema));
  }

  async upsertOrgModelPolicy(tenantId: string, input: UpsertOrgModelPolicyRequest): Promise<OrgModelPolicy> {
    return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/models/policies`, OrgModelPolicySchema, {
      method: "PUT",
      body: input,
    });
  }

  async listOrgModelDefaults(tenantId: string): Promise<OrgModelDefault[]> {
    return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/models/defaults`, z.array(OrgModelDefaultSchema));
  }

  async upsertOrgModelDefault(tenantId: string, mode: "chat" | "code", input: UpsertOrgModelDefaultRequest): Promise<OrgModelDefault> {
    return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/models/defaults/${encodeURIComponent(mode)}`, OrgModelDefaultSchema, {
      method: "PUT",
      body: input,
    });
  }

  async resolveOrgModel(tenantId: string, input: ResolveOrgModelRequest): Promise<ModelGovernanceDecision> {
    return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/models/resolve`, ModelGovernanceDecisionSchema, {
      method: "POST",
      body: input,
    });
  }

  async listPolicyVersions(tenantId: string): Promise<ManagedPolicyVersion[]> {
    return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/policy/versions`, z.array(ManagedPolicyVersionSchema));
  }

  async activePolicyVersion(tenantId: string): Promise<ManagedPolicyVersion | null> {
    return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/policy`, ManagedPolicyVersionSchema.nullable());
  }

  async activePolicyBundle(tenantId: string): Promise<ManagedPolicyBundle | null> {
    return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/policy/berry-policy.json`, ManagedPolicyBundleSchema.nullable());
  }

  async publishManagedPolicy(tenantId: string, input: PublishManagedPolicyRequest): Promise<ManagedPolicyVersion> {
    ManagedPolicyPublishRequestSchema.parse(input);
    return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/policy`, ManagedPolicyVersionSchema, {
      method: "PUT",
      body: input,
    });
  }

  async auditSettings(tenantId: string): Promise<CloudAuditSettings> {
    return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/audit/settings`, CloudAuditSettingsSchema);
  }

  async updateAuditSettings(tenantId: string, input: UpdateAuditSettingsRequest): Promise<CloudAuditSettings> {
    CloudAuditSettingsUpdateSchema.parse(input);
    return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/audit/settings`, CloudAuditSettingsSchema, {
      method: "PUT",
      body: input,
    });
  }

  async ingestAuditEvents(tenantId: string, input: CloudAuditIngestRequest): Promise<CloudAuditEvent[]> {
    CloudAuditIngestRequestSchema.parse(input);
    return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/audit/events`, z.array(CloudAuditEventSchema), {
      method: "POST",
      body: input,
    });
  }

  async listAuditEvents(tenantId: string, filter: { category?: string | undefined; action?: string | undefined; sessionId?: string | undefined; limit?: number | undefined } = {}): Promise<CloudAuditEvent[]> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filter)) {
      if (value !== undefined) params.set(key, String(value));
    }
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/audit/events${suffix}`, z.array(CloudAuditEventSchema));
  }

  async listAuditExportConfigs(tenantId: string): Promise<CloudAuditExportConfig[]> {
    return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/audit/exports`, z.array(CloudAuditExportConfigSchema));
  }

  async upsertAuditExportConfig(tenantId: string, input: UpsertAuditExportConfigRequest): Promise<CloudAuditExportConfig> {
    CloudAuditExportConfigUpsertSchema.parse(input);
    return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/audit/exports`, CloudAuditExportConfigSchema, {
      method: "PUT",
      body: input,
    });
  }

  async listSsoConnections(tenantId: string): Promise<SsoConnection[]> {
    return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/sso/connections`, z.array(SsoConnectionSchema));
  }

  async createSsoConnection(tenantId: string, input: CreateSsoConnectionRequest): Promise<SsoConnection> {
    return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/sso/connections`, SsoConnectionSchema, {
      method: "POST",
      body: input,
    });
  }

  async startSso(tenantId: string, connection: string, redirectUri?: string | undefined): Promise<SsoStartResponse> {
    const params = new URLSearchParams({ connection });
    if (redirectUri) params.set("redirectUri", redirectUri);
    return this.#request(`/v1/orgs/${encodeURIComponent(tenantId)}/sso/start?${params.toString()}`, SsoStartResponseSchema);
  }

  streamEvents(sessionId: string, callbacks: {
    onEvent: (event: AgentStreamEvent) => void;
    onError?: (error: unknown) => void;
    onOpen?: () => void;
  }): EventSource {
    const source = new EventSource(`${this.#baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/events`);
    source.onopen = () => callbacks.onOpen?.();
    source.onerror = (event) => callbacks.onError?.(event);
    source.onmessage = (event) => {
      try {
        const parsed = AgentStreamEventSchema.parse(JSON.parse(event.data));
        callbacks.onEvent(parsed);
        if (parsed.kind === "turn.end") source.close();
      } catch (error) {
        callbacks.onError?.(error);
      }
    };
    return source;
  }

  streamTaskEvents(taskId: string, callbacks: {
    onEvent: (event: HostPushEvent) => void;
    onError?: (error: unknown) => void;
    onOpen?: () => void;
  }): EventSource {
    const source = new EventSource(`${this.#baseUrl}/v1/tasks/${encodeURIComponent(taskId)}/events`);
    source.onopen = () => callbacks.onOpen?.();
    source.onerror = (event) => callbacks.onError?.(event);
    source.onmessage = (event) => {
      try {
        callbacks.onEvent(HostPushEventSchema.parse(JSON.parse(event.data)));
      } catch (error) {
        callbacks.onError?.(error);
      }
    };
    return source;
  }

  async #request<TSchema extends z.ZodTypeAny>(path: string, schema: TSchema, init: { method?: string | undefined; body?: unknown } = {}): Promise<z.output<TSchema>> {
    const { response, body } = await this.#rawRequest(path, init);
    if (!response.ok) {
      throw new BerryApiError(`Berry API request failed with ${response.status}`, response.status, body);
    }
    return schema.parse(body);
  }

  #resolveFileUrls(file: StoredFile): StoredFile {
    if (!this.#baseUrl) return file;
    const base = `${this.#baseUrl}/`;
    return {
      ...file,
      previewUrl: new URL(file.previewUrl, base).toString(),
      downloadUrl: new URL(file.downloadUrl, base).toString(),
    };
  }

  async #textRequest(path: string): Promise<string> {
    const { response, body } = await this.#rawRequest(path);
    if (!response.ok) {
      throw new BerryApiError(`Berry API request failed with ${response.status}`, response.status, body);
    }
    return typeof body === "string" ? body : JSON.stringify(body);
  }

  async #rawRequest(path: string, init: { method?: string | undefined; body?: unknown } = {}): Promise<{ response: Response; body: unknown }> {
    const headers = new Headers(this.#headers);
    headers.set("Accept", "application/json");
    const request: RequestInit = { method: init.method ?? "GET", headers, credentials: "include" };
    if (init.body !== undefined) {
      headers.set("Content-Type", "application/json");
      request.body = JSON.stringify(init.body);
    }
    const response = await this.#fetch(`${this.#baseUrl}${path}`, request);
    const contentType = response.headers.get("content-type") ?? "";
    const body = contentType.includes("application/json") ? await response.json() : await response.text();
    return { response, body };
  }
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function usageQuery<TFilter extends object>(filter: TFilter): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) {
    if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  }
  return params.size > 0 ? `?${params.toString()}` : "";
}
