import { z } from "zod";

const DateTimeSchema = z.string().datetime({ offset: true });
const NonEmptyIdSchema = z.string().min(1);
const JsonObjectSchema = z.record(z.unknown());

export const MemoryScopeSchema = z.enum(["personal", "project"]);
export type MemoryScope = z.infer<typeof MemoryScopeSchema>;

export const MemoryStatusSchema = z.enum(["active", "superseded", "forgotten", "expired", "rejected"]);
export type MemoryStatus = z.infer<typeof MemoryStatusSchema>;

export const MemoryOperationKindSchema = z.enum(["ADD", "SUPERSEDE", "REFRESH", "NOOP"]);
export type MemoryOperationKind = z.infer<typeof MemoryOperationKindSchema>;

export const MemoryItemSchema = z.object({
  id: NonEmptyIdSchema,
  tenantId: NonEmptyIdSchema,
  userId: NonEmptyIdSchema,
  workspaceId: NonEmptyIdSchema.nullable().default(null),
  scope: MemoryScopeSchema,
  kind: z.string().min(1).max(80),
  stableKey: z.string().min(1).max(240),
  content: z.string().min(1).max(20_000),
  value: JsonObjectSchema.default({}),
  status: MemoryStatusSchema,
  explicit: z.boolean(),
  confidence: z.number().min(0).max(1),
  salience: z.number().min(0).max(1),
  validFrom: DateTimeSchema.nullable().default(null),
  validUntil: DateTimeSchema.nullable().default(null),
  expiresAt: DateTimeSchema.nullable().default(null),
  extractorVersion: z.string().min(1),
  sourceTaskId: NonEmptyIdSchema.nullable().default(null),
  sourceSessionId: NonEmptyIdSchema.nullable().default(null),
  sourceMessageId: NonEmptyIdSchema.nullable().default(null),
  supersededItemId: NonEmptyIdSchema.nullable().default(null),
  lastSeenAt: DateTimeSchema.nullable().default(null),
  lastUsedAt: DateTimeSchema.nullable().default(null),
  createdAt: DateTimeSchema,
  updatedAt: DateTimeSchema,
});
export type MemoryItem = z.infer<typeof MemoryItemSchema>;

export const MemoryOperationSchema = z.object({
  operation: MemoryOperationKindSchema,
  stableKey: z.string().min(1).max(240),
  kind: z.string().min(1).max(80),
  content: z.string().max(20_000),
  value: JsonObjectSchema.default({}),
  confidence: z.number().min(0).max(1).default(0.5),
  salience: z.number().min(0).max(1).default(0.5),
  explicit: z.boolean().default(false),
  targetItemId: NonEmptyIdSchema.nullable().default(null),
  expiresAt: DateTimeSchema.nullable().default(null),
  reason: z.string().max(2_000).default(""),
});
export type MemoryOperation = z.infer<typeof MemoryOperationSchema>;

export const KnowledgeSourceTypeSchema = z.enum(["file", "task_outcome", "message", "checkpoint", "memory"]);
export type KnowledgeSourceType = z.infer<typeof KnowledgeSourceTypeSchema>;

export const KnowledgeIndexStatusSchema = z.enum(["pending", "extracting", "chunking", "embedding", "indexed", "failed", "deleted"]);
export type KnowledgeIndexStatus = z.infer<typeof KnowledgeIndexStatusSchema>;

export const KnowledgeSourceSchema = z.object({
  id: NonEmptyIdSchema,
  tenantId: NonEmptyIdSchema,
  userId: NonEmptyIdSchema.nullable().default(null),
  workspaceId: NonEmptyIdSchema,
  sourceType: KnowledgeSourceTypeSchema,
  sourceId: NonEmptyIdSchema,
  revision: z.string().min(1),
  contentHash: z.string().min(1),
  title: z.string().min(1).max(500),
  authority: z.number().min(0).max(1).default(0.5),
  visibility: z.enum(["project", "task_only", "private"]),
  aclVersion: z.number().int().nonnegative(),
  status: KnowledgeIndexStatusSchema,
  vectorReady: z.boolean(),
  extractorVersion: z.string().min(1),
  chunkerVersion: z.string().min(1),
  failureReason: z.string().nullable().default(null),
  tombstonedAt: DateTimeSchema.nullable().default(null),
  createdAt: DateTimeSchema,
  updatedAt: DateTimeSchema,
});
export type KnowledgeSource = z.infer<typeof KnowledgeSourceSchema>;

export const KnowledgeChunkMetadataSchema = z.object({
  page: z.number().int().positive().nullable().default(null),
  heading: z.string().nullable().default(null),
  slide: z.number().int().positive().nullable().default(null),
  sheet: z.string().nullable().default(null),
  rowStart: z.number().int().nonnegative().nullable().default(null),
  rowEnd: z.number().int().nonnegative().nullable().default(null),
  turnId: NonEmptyIdSchema.nullable().default(null),
  sourceStart: z.number().int().nonnegative().nullable().default(null),
  sourceEnd: z.number().int().nonnegative().nullable().default(null),
}).default({});

export const KnowledgeChunkSchema = z.object({
  id: NonEmptyIdSchema,
  tenantId: NonEmptyIdSchema,
  workspaceId: NonEmptyIdSchema,
  sourceId: NonEmptyIdSchema,
  ordinal: z.number().int().nonnegative(),
  text: z.string().min(1),
  tokenEstimate: z.number().int().nonnegative(),
  metadata: KnowledgeChunkMetadataSchema,
  embeddingProfileId: z.string().nullable().default(null),
  embeddingModel: z.string().nullable().default(null),
  embeddingDimensions: z.number().int().positive().nullable().default(null),
  embeddingProfileVersion: z.number().int().positive().nullable().default(null),
  embeddingHash: z.string().nullable().default(null),
  vectorReady: z.boolean().default(false),
  createdAt: DateTimeSchema,
  updatedAt: DateTimeSchema,
});
export type KnowledgeChunk = z.infer<typeof KnowledgeChunkSchema>;

export const RetrievalCandidateSchema = z.object({
  chunkId: NonEmptyIdSchema,
  sourceId: NonEmptyIdSchema,
  sourceType: KnowledgeSourceTypeSchema,
  title: z.string(),
  text: z.string(),
  citationLabel: z.string(),
  tokenEstimate: z.number().int().nonnegative(),
  ftsRank: z.number().nullable().default(null),
  vectorRank: z.number().nullable().default(null),
  fusedScore: z.number(),
  authority: z.number().min(0).max(1),
  selected: z.boolean(),
  selectionReason: z.string(),
  metadata: KnowledgeChunkMetadataSchema,
});
export type RetrievalCandidate = z.infer<typeof RetrievalCandidateSchema>;

export const RetrievalSnapshotSchema = z.object({
  id: NonEmptyIdSchema,
  tenantId: NonEmptyIdSchema,
  workspaceId: NonEmptyIdSchema,
  taskId: NonEmptyIdSchema.nullable().default(null),
  sessionId: NonEmptyIdSchema.nullable().default(null),
  runId: NonEmptyIdSchema.nullable().default(null),
  queryHash: z.string().min(1),
  candidates: z.array(RetrievalCandidateSchema),
  selectedChunkIds: z.array(NonEmptyIdSchema),
  tokenBudget: z.number().int().nonnegative(),
  tokensSelected: z.number().int().nonnegative(),
  retrievalVersion: z.string().min(1),
  embeddingProfileId: z.string().nullable().default(null),
  createdAt: DateTimeSchema,
});
export type RetrievalSnapshot = z.infer<typeof RetrievalSnapshotSchema>;

export const GroundingContextSchema = z.object({
  personalMemory: z.array(z.object({
    memoryId: NonEmptyIdSchema,
    content: z.string(),
    label: z.string(),
    explicit: z.boolean(),
    confidence: z.number().min(0).max(1),
    sourceTaskId: NonEmptyIdSchema.nullable().default(null),
    sourceMessageId: NonEmptyIdSchema.nullable().default(null),
  })),
  projectFacts: z.array(z.object({
    sourceId: NonEmptyIdSchema,
    chunkId: NonEmptyIdSchema,
    content: z.string(),
    citationLabel: z.string(),
  })),
  citations: z.array(z.object({
    sourceId: NonEmptyIdSchema,
    chunkId: NonEmptyIdSchema.nullable().default(null),
    label: z.string(),
    href: z.string().nullable().default(null),
  })),
  retrieval: z.object({
    snapshotId: NonEmptyIdSchema.nullable().default(null),
    queryHash: z.string(),
    tokenBudget: z.number().int().nonnegative(),
    tokensSelected: z.number().int().nonnegative(),
    degradedReason: z.enum([
      "none",
      "embeddings_unavailable",
      "knowledge_disabled",
      "memory_disabled",
      "personal_memory_unavailable",
    ]).default("none"),
  }),
});
export type GroundingContext = z.infer<typeof GroundingContextSchema>;

export const EmbeddingProfileSchema = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  dimensions: z.number().int().positive(),
  version: z.number().int().positive(),
});
export type EmbeddingProfile = z.infer<typeof EmbeddingProfileSchema>;

export interface EmbeddingProvider {
  readonly profile: EmbeddingProfile;
  embed(texts: readonly string[], options?: { signal?: AbortSignal }): Promise<readonly number[][]>;
}

export const PromptCacheMissReasonSchema = z.enum([
  "provider_unsupported",
  "below_minimum_tokens",
  "first_request",
  "prefix_changed",
  "cache_expired",
  "routing_changed",
  "retention_unsupported",
  "unknown",
]);
export type PromptCacheMissReason = z.infer<typeof PromptCacheMissReasonSchema>;

export const ModelUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  totalTokens: z.number().int().nonnegative().default(0),
  cacheReadTokens: z.number().int().nonnegative().default(0),
  cacheWriteTokens: z.number().int().nonnegative().default(0),
  cacheCreationTokens1h: z.number().int().nonnegative().default(0),
  cacheCreationTokens5m: z.number().int().nonnegative().default(0),
  cacheEligible: z.boolean().default(false),
  cacheProvider: z.string().nullable().default(null),
  cacheKeyHash: z.string().nullable().default(null),
  promptManifestHash: z.string().nullable().default(null),
  cacheMissReason: PromptCacheMissReasonSchema.nullable().default(null),
});
export type ModelUsage = z.infer<typeof ModelUsageSchema>;

export const PromptManifestComponentSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["system", "tool_schema", "policy", "capability", "project_instruction"]),
  hash: z.string().min(1),
  tokenEstimate: z.number().int().nonnegative(),
});
export const PromptManifestSchema = z.object({
  version: z.literal(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  route: z.string().min(1),
  components: z.array(PromptManifestComponentSchema),
  cacheRetention: z.enum(["none", "short", "long"]).default("none"),
  stablePrefixTokens: z.number().int().nonnegative(),
  dynamicContextBoundary: z.number().int().nonnegative(),
  stablePrefixHash: z.string().min(1),
  manifestHash: z.string().min(1),
});
export type PromptManifest = z.infer<typeof PromptManifestSchema>;

export const ToolRetryClassSchema = z.enum(["read_only", "idempotent", "idempotent_with_key", "non_idempotent_manual"]);
export type ToolRetryClass = z.infer<typeof ToolRetryClassSchema>;

const CheckpointSourceSchema = z.object({
  entryId: NonEmptyIdSchema,
  detail: z.string(),
});

export const SessionCheckpointV2Schema = z.object({
  schema: z.literal("berry.session-checkpoint"),
  version: z.literal(2),
  generatedAt: DateTimeSchema,
  goal: z.string(),
  successCriteria: z.array(z.string()),
  constraints: z.array(z.string()),
  standingInstructions: z.array(z.string()),
  completedWork: z.array(z.string()),
  currentWork: z.array(z.string()),
  blockers: z.array(z.string()),
  waitingState: z.string().nullable().default(null),
  decisions: z.array(CheckpointSourceSchema),
  unresolvedQuestions: z.array(z.string()),
  nextAction: z.string(),
  filesRead: z.array(z.string()),
  filesModified: z.array(z.string()),
  artifacts: z.array(z.object({ id: NonEmptyIdSchema, path: z.string().nullable().default(null), label: z.string() })),
  commands: z.array(z.object({ command: z.string(), status: z.enum(["passed", "failed", "running", "unknown"]), result: z.string() })),
  toolCalls: z.array(z.object({
    toolCallId: NonEmptyIdSchema,
    toolName: z.string(),
    retryClass: ToolRetryClassSchema,
    idempotencyKey: z.string().nullable().default(null),
    outcome: z.enum(["completed", "failed", "denied", "pending", "ambiguous"]),
  })),
  approvals: z.array(z.object({
    approvalId: NonEmptyIdSchema,
    status: z.enum(["requested", "approved", "denied", "expired", "pending"]),
  })),
  promptManifestHash: z.string().nullable().default(null),
  retrievalSnapshotIds: z.array(NonEmptyIdSchema),
  coveredEntryStart: NonEmptyIdSchema.nullable().default(null),
  coveredEntryEnd: NonEmptyIdSchema.nullable().default(null),
  currentLeafId: NonEmptyIdSchema.nullable().default(null),
  narrative: z.string(),
});
export type SessionCheckpointV2 = z.infer<typeof SessionCheckpointV2Schema>;

export const TurnRunStateSchema = z.enum([
  "queued",
  "assembling_context",
  "calling_model",
  "persisting_response",
  "executing_tool",
  "compacting",
  "waiting",
  "finalizing",
  "completed",
  "failed",
  "cancelled",
  "recovery_required",
]);
export type TurnRunState = z.infer<typeof TurnRunStateSchema>;

export const TurnRunSchema = z.object({
  id: NonEmptyIdSchema,
  tenantId: NonEmptyIdSchema,
  userId: NonEmptyIdSchema,
  workspaceId: NonEmptyIdSchema,
  taskId: NonEmptyIdSchema,
  sessionId: NonEmptyIdSchema,
  state: TurnRunStateSchema,
  attempt: z.number().int().nonnegative(),
  leaseOwner: z.string().nullable().default(null),
  leaseExpiresAt: DateTimeSchema.nullable().default(null),
  nextAction: z.string().nullable().default(null),
  waitingReason: z.string().nullable().default(null),
  heartbeatAt: DateTimeSchema.nullable().default(null),
  error: z.string().nullable().default(null),
  createdAt: DateTimeSchema,
  updatedAt: DateTimeSchema,
});
export type TurnRun = z.infer<typeof TurnRunSchema>;

export const TurnStepStateSchema = z.enum(["pending", "running", "completed", "failed", "waiting", "recovery_required", "cancelled"]);
export const TurnStepSchema = z.object({
  id: NonEmptyIdSchema,
  runId: NonEmptyIdSchema,
  sequence: z.number().int().nonnegative(),
  type: z.string().min(1),
  state: TurnStepStateSchema,
  retryClass: ToolRetryClassSchema.nullable().default(null),
  idempotencyKey: z.string().nullable().default(null),
  attempt: z.number().int().nonnegative(),
  input: JsonObjectSchema.default({}),
  output: JsonObjectSchema.nullable().default(null),
  startedAt: DateTimeSchema.nullable().default(null),
  completedAt: DateTimeSchema.nullable().default(null),
});
export type TurnStep = z.infer<typeof TurnStepSchema>;

export const TurnEventSchema = z.object({
  id: NonEmptyIdSchema,
  tenantId: NonEmptyIdSchema,
  runId: NonEmptyIdSchema,
  sessionId: NonEmptyIdSchema,
  sequence: z.number().int().positive(),
  type: z.string().min(1),
  payload: JsonObjectSchema,
  createdAt: DateTimeSchema,
});
export type TurnEvent = z.infer<typeof TurnEventSchema>;

const EnvBooleanSchema = z.preprocess(
  (value) => typeof value === "string" ? value.trim().toLowerCase() : value,
  z.union([z.literal("true"), z.literal("false"), z.boolean()]),
).transform((value) => value === true || value === "true");
const EnvPositiveIntegerSchema = z.preprocess(
  (value) => typeof value === "string" && value.trim() ? Number(value) : value,
  z.number().int().positive(),
);

export const DurableContextConfigSchema = z.object({
  memoryEnabled: EnvBooleanSchema.default(true),
  implicitMemoryEnabled: EnvBooleanSchema.default(true),
  projectKnowledgeEnabled: EnvBooleanSchema.default(true),
  promptCacheEnabled: EnvBooleanSchema.default(true),
  durableRunnerEnabled: EnvBooleanSchema.default(true),
  tikaUrl: z.string().url().default("http://tika:9998"),
  embeddingProvider: z.string().min(1).default("openai-compatible"),
  embeddingModel: z.string().min(1).default("text-embedding-3-small"),
  embeddingDimensions: EnvPositiveIntegerSchema.default(1536),
  embeddingProfileVersion: EnvPositiveIntegerSchema.default(1),
  knowledgeChunkTokens: EnvPositiveIntegerSchema.default(600),
  knowledgeChunkOverlapTokens: EnvPositiveIntegerSchema.default(80),
  retrievalTokenBudget: EnvPositiveIntegerSchema.default(5000),
  compactionTriggerTokens: EnvPositiveIntegerSchema.default(120000),
  runLeaseSeconds: EnvPositiveIntegerSchema.default(90),
  sandboxSnapshotIntervalSeconds: EnvPositiveIntegerSchema.default(900),
}).superRefine((value, context) => {
  if (value.knowledgeChunkOverlapTokens >= value.knowledgeChunkTokens) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["knowledgeChunkOverlapTokens"],
      message: "Chunk overlap must be smaller than the chunk size",
    });
  }
  const expectedDimensions = value.embeddingProfileVersion === 1
    ? 1536
    : value.embeddingProfileVersion === 2
      ? 768
      : null;
  if (expectedDimensions === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["embeddingProfileVersion"],
      message: "Embedding profile version must be 1 or 2",
    });
  } else if (value.embeddingDimensions !== expectedDimensions) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["embeddingDimensions"],
      message: `Embedding profile v${value.embeddingProfileVersion} requires ${expectedDimensions} dimensions`,
    });
  }
});
export type DurableContextConfig = z.infer<typeof DurableContextConfigSchema>;

export function durableContextConfigFromEnv(env: Record<string, string | undefined>): DurableContextConfig {
  return DurableContextConfigSchema.parse({
    memoryEnabled: env.BERRY_MEMORY_ENABLED,
    implicitMemoryEnabled: env.BERRY_IMPLICIT_MEMORY_ENABLED,
    projectKnowledgeEnabled: env.BERRY_PROJECT_KNOWLEDGE_ENABLED,
    promptCacheEnabled: env.BERRY_PROMPT_CACHE_ENABLED,
    durableRunnerEnabled: env.BERRY_DURABLE_RUNNER_ENABLED,
    tikaUrl: env.BERRY_TIKA_URL,
    embeddingProvider: env.BERRY_EMBEDDING_PROVIDER,
    embeddingModel: env.BERRY_EMBEDDING_MODEL,
    embeddingDimensions: env.BERRY_EMBEDDING_DIMENSIONS,
    embeddingProfileVersion: env.BERRY_EMBEDDING_PROFILE_VERSION,
    knowledgeChunkTokens: env.BERRY_KNOWLEDGE_CHUNK_TOKENS,
    knowledgeChunkOverlapTokens: env.BERRY_KNOWLEDGE_CHUNK_OVERLAP_TOKENS,
    retrievalTokenBudget: env.BERRY_RETRIEVAL_TOKEN_BUDGET,
    compactionTriggerTokens: env.BERRY_COMPACTION_TRIGGER_TOKENS,
    runLeaseSeconds: env.BERRY_RUN_LEASE_SECONDS,
    sandboxSnapshotIntervalSeconds: env.BERRY_SANDBOX_SNAPSHOT_INTERVAL_SECONDS,
  });
}
