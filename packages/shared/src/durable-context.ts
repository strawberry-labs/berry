import { z } from "zod";

const DateTimeSchema = z.string().datetime({ offset: true });
const NonEmptyIdSchema = z.string().min(1);
const JsonObjectSchema = z.record(z.unknown());

// Keep admission estimates and the worker's overview request on the same
// bounded output ceiling. Focused inspections use a smaller worker-only cap.
export const VISION_ADAPTER_MAX_OUTPUT_TOKENS = 1_536;

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

export const PersonalizationProfileSchema = z.object({
  nickname: z.string().max(80).default(""),
  occupation: z.string().max(160).default(""),
  about: z.string().max(4_000).default(""),
  customInstructions: z.string().max(12_000).default(""),
  updatedAt: DateTimeSchema.nullable().default(null),
});
export type PersonalizationProfile = z.infer<typeof PersonalizationProfileSchema>;

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

/**
 * Versioned, server-resolved capability contract consumed by the Durable
 * Worker. Secrets are represented by references or encrypted envelopes; raw
 * credentials must never be written to turn_runs.runtime_request.
 */
export const DurableSecretEnvelopeSchema = z.object({
  version: z.literal(1),
  algorithm: z.literal("AES-GCM"),
  iv: z.string().min(1),
  ciphertext: z.string().min(1),
}).strict();
export type DurableSecretEnvelope = z.infer<typeof DurableSecretEnvelopeSchema>;

/**
 * Record-bound envelope used for long-lived connector credentials. The key id
 * is not secret; it lets operators rotate the root key without guessing which
 * key can open a row. Additional authenticated data prevents ciphertext from
 * being copied to another tenant, connector, or credential purpose.
 */
export const ConnectorSecretEnvelopeSchema = z.object({
  version: z.literal(2),
  algorithm: z.literal("AES-GCM"),
  keyId: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
  iv: z.string().min(1),
  ciphertext: z.string().min(1),
}).strict();
export type ConnectorSecretEnvelope = z.infer<typeof ConnectorSecretEnvelopeSchema>;

export function isConnectorEncryptionKeyValid(encodedKey: string | undefined): boolean {
  if (!encodedKey?.trim()) return false;
  try {
    connectorKeyBytes(encodedKey);
    return true;
  } catch {
    return false;
  }
}

export async function sealConnectorSecret(
  plaintext: string,
  encodedKey: string,
  authenticatedContext: string,
): Promise<ConnectorSecretEnvelope> {
  const keyBytes = connectorKeyBytes(encodedKey);
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: new TextEncoder().encode(authenticatedContext),
    },
    key,
    new TextEncoder().encode(plaintext),
  );
  return ConnectorSecretEnvelopeSchema.parse({
    version: 2,
    algorithm: "AES-GCM",
    keyId: await connectorKeyId(keyBytes),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  });
}

export async function openConnectorSecret(
  envelope: ConnectorSecretEnvelope,
  encodedKeys: string | readonly string[],
  authenticatedContext: string,
): Promise<string> {
  const parsed = ConnectorSecretEnvelopeSchema.parse(envelope);
  const candidates = typeof encodedKeys === "string" ? [encodedKeys] : [...encodedKeys];
  for (const encodedKey of candidates) {
    const keyBytes = connectorKeyBytes(encodedKey);
    if (await connectorKeyId(keyBytes) !== parsed.keyId) continue;
    const key = await globalThis.crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "AES-GCM" },
      false,
      ["decrypt"],
    );
    try {
      const plaintext = await globalThis.crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: base64ToBytes(parsed.iv),
          additionalData: new TextEncoder().encode(authenticatedContext),
        },
        key,
        base64ToBytes(parsed.ciphertext),
      );
      return new TextDecoder().decode(plaintext);
    } catch {
      throw new Error("Connector secret authentication failed");
    }
  }
  throw new Error(`Connector encryption key ${parsed.keyId} is not configured`);
}

function connectorKeyBytes(encodedKey: string): Uint8Array<ArrayBuffer> {
  const bytes = base64ToBytes(encodedKey.trim());
  if (bytes.byteLength !== 32) {
    throw new Error("BERRY_CONNECTOR_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }
  return bytes;
}

async function connectorKeyId(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return bytesToBase64(digest).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "").slice(0, 16);
}

export async function sealDurableSecret(
  plaintext: string,
  encodedKey: string,
): Promise<DurableSecretEnvelope> {
  const key = await durableSecretKey(encodedKey, ["encrypt"]);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return DurableSecretEnvelopeSchema.parse({
    version: 1,
    algorithm: "AES-GCM",
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  });
}

export async function openDurableSecret(
  envelope: DurableSecretEnvelope,
  encodedKey: string,
): Promise<string> {
  const parsed = DurableSecretEnvelopeSchema.parse(envelope);
  const key = await durableSecretKey(encodedKey, ["decrypt"]);
  const plaintext = await globalThis.crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(parsed.iv) },
    key,
    base64ToBytes(parsed.ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}

async function durableSecretKey(
  encodedKey: string,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  const bytes = base64ToBytes(encodedKey.trim());
  if (bytes.byteLength !== 32) {
    throw new Error("BERRY_DURABLE_CAPABILITY_KEY must be a base64-encoded 32-byte key");
  }
  return globalThis.crypto.subtle.importKey(
    "raw",
    bytes,
    { name: "AES-GCM" },
    false,
    usages,
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error("Durable capability secret is not valid base64");
  }
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export const DurableBuiltInToolNameSchema = z.enum([
  "ask_user_question",
  "compose_message",
  "read_file",
  "list_files",
  "write_file",
  "edit_file",
  "apply_patch",
  "glob",
  "grep",
  "run_command",
  "persist_artifact",
  "git_status",
  "git_diff",
  "git_log",
  "git_checkpoint",
  "create_image",
  "inspect_images",
  "activate_skill",
  "save_personal_skill",
]);
export type DurableBuiltInToolName = z.infer<typeof DurableBuiltInToolNameSchema>;

export const DURABLE_BASE_BUILT_IN_TOOLS: readonly DurableBuiltInToolName[] = [
  "ask_user_question",
  "compose_message",
  "read_file",
  "list_files",
  "write_file",
  "edit_file",
  "apply_patch",
  "glob",
  "grep",
  "run_command",
  "persist_artifact",
  "git_status",
  "git_diff",
  "git_log",
  "git_checkpoint",
  "save_personal_skill",
] as const;

export const DurableProviderTransportSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.string().min(1),
  baseUrl: z.string().url(),
  defaultModel: z.string().min(1),
  apiType: z.enum(["openai-chat-completions", "openai-responses", "anthropic-messages"]).default("openai-chat-completions"),
  endpointPath: z.string().nullable().optional(),
  modelsPath: z.string().nullable().optional(),
  authType: z.enum(["none", "bearer", "optional-bearer", "x-api-key"]).default("bearer"),
  headers: z.record(z.string()).optional(),
  capabilities: JsonObjectSchema.optional(),
  models: z.array(JsonObjectSchema).default([]),
  completionTransport: z.enum(["stream", "buffered"]).optional(),
  completionFallback: z.literal("buffered").optional(),
  credentialRef: z.string().min(1).optional(),
  credential: DurableSecretEnvelopeSchema.optional(),
}).strict();
export type DurableProviderTransport = z.infer<typeof DurableProviderTransportSchema>;

export const DurableMcpServerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  transport: z.enum(["stdio", "http-sse", "streamable-http"]),
  command: z.string().nullable().default(null),
  args: z.array(z.string()).default([]),
  url: z.string().url().nullable().default(null),
  env: z.record(z.string()).default({}),
  environment: DurableSecretEnvelopeSchema.optional(),
  enabled: z.boolean().default(true),
  trusted: z.boolean().default(true),
  credentialRef: z.string().min(1).nullable().default(null),
  credential: DurableSecretEnvelopeSchema.optional(),
  cachedTools: z.array(z.object({
    name: z.string().min(1),
    description: z.string().nullable().default(null),
    inputSchema: JsonObjectSchema,
    annotations: z.object({
      readOnlyHint: z.boolean().optional(),
      destructiveHint: z.boolean().optional(),
      idempotentHint: z.boolean().optional(),
      openWorldHint: z.boolean().optional(),
    }).optional(),
  })).optional(),
  allowedTools: z.array(z.string().min(1)).optional(),
  trustReadOnlyAnnotations: z.boolean().optional(),
  approvalRequiredTools: z.array(z.string().min(1)).optional(),
}).strict();
export type DurableMcpServer = z.infer<typeof DurableMcpServerSchema>;

export const DurableSkillSchema = z.object({
  name: z.string().min(1).max(128),
  description: z.string().max(2_000),
  content: z.string().max(262_144),
  filePath: z.string().max(1_000),
  disableModelInvocation: z.boolean().default(false),
  resources: z.array(z.string().max(1_000)).default([]),
}).strict();
export type DurableSkill = z.infer<typeof DurableSkillSchema>;

export const DurableImageGenerationCapabilitySchema = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1),
  costMicros: z.string().regex(/^\d+$/),
}).strict();
export type DurableImageGenerationCapability = z.infer<typeof DurableImageGenerationCapabilitySchema>;

export const DurableVisionCapabilitySchema = z.object({
  providerId: z.string().min(1),
  provider: DurableProviderTransportSchema,
  model: z.string().min(1),
  maxTokens: z.number().int().positive().max(16_384).default(2_048),
  modelPricing: JsonObjectSchema.default({}),
  estimatedCostMicros: z.string().regex(/^\d+$/),
}).strict();
export type DurableVisionCapability = z.infer<typeof DurableVisionCapabilitySchema>;

export const TurnIntentSchema = z.enum(["image_generation"]);
export type TurnIntent = z.infer<typeof TurnIntentSchema>;

export const DurableTurnRuntimeRequestSchema = z.object({
  capabilityVersion: z.literal(1),
  requestId: z.string().min(1).optional(),
  admissionFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  budgetReservationRequired: z.boolean().default(false),
  input: z.string().default(""),
  intent: TurnIntentSchema.optional(),
  providerId: z.string().min(1),
  provider: DurableProviderTransportSchema,
  model: z.string().min(1).nullable(),
  conversationKind: z.enum(["chat", "code"]).default("chat"),
  workspacePath: z.string().min(1),
  workspaceId: z.string().min(1),
  permissionMode: z.string().min(1),
  reasoning: z.string().min(1),
  continueInterruptedTurn: z.boolean().default(false),
  maxTokens: z.number().int().positive(),
  contextWindowTokens: z.number().int().positive(),
  modelAcceptsImages: z.boolean().default(true),
  modelPricing: JsonObjectSchema.default({}),
  networkPolicy: JsonObjectSchema.optional(),
  builtInTools: z.array(DurableBuiltInToolNameSchema),
  imageGeneration: DurableImageGenerationCapabilitySchema.optional(),
  vision: DurableVisionCapabilitySchema.optional(),
  mcpServers: z.array(DurableMcpServerSchema).default([]),
  extraSkills: z.array(DurableSkillSchema).default([]),
  attachments: z.array(z.object({
    id: z.string().optional(),
    fileId: z.string().uuid().optional(),
    name: z.string(),
    mediaType: z.string(),
    size: z.number().int().nonnegative(),
    sourceKind: z.string().nullable().optional(),
  }).strict()).default([]),
  portableCheckpoint: SessionCheckpointV2Schema.optional(),
}).strict().superRefine((request, context) => {
  const hasImageTool = request.builtInTools.includes("create_image");
  if (request.intent === "image_generation" && !hasImageTool) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["builtInTools"], message: "Image intent requires the create_image tool" });
  }
  if (request.intent === "image_generation" && !request.imageGeneration) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["imageGeneration"], message: "Image intent requires admitted image generation configuration" });
  }
  if (hasImageTool && !request.imageGeneration) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["imageGeneration"], message: "The create_image tool requires admitted image generation configuration" });
  }
  const hasVisionTool = request.builtInTools.includes("inspect_images");
  if (hasVisionTool && !request.vision) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["vision"], message: "The inspect_images tool requires admitted vision configuration" });
  }
  if (request.vision && !hasVisionTool) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["builtInTools"], message: "Admitted vision configuration requires the inspect_images tool" });
  }
  if (request.vision && request.modelAcceptsImages) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["vision"], message: "Native vision models must receive images directly without an auxiliary adapter" });
  }
});
export type DurableTurnRuntimeRequest = z.infer<typeof DurableTurnRuntimeRequestSchema>;

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

export const DEFAULT_SANDBOX_INPUT_MAX_BYTES = 350 * 1024 * 1024;

export const DurableContextConfigSchema = z.object({
  memoryEnabled: EnvBooleanSchema.default(true),
  implicitMemoryEnabled: EnvBooleanSchema.default(true),
  projectKnowledgeEnabled: EnvBooleanSchema.default(true),
  promptCacheEnabled: EnvBooleanSchema.default(true),
  durableRunnerEnabled: EnvBooleanSchema.default(true),
  tikaUrl: z.string().url().default("http://tika:9998"),
  embeddingProvider: z.string().min(1).default("openai-compatible"),
  embeddingModel: z.string().min(1).default("sentence-transformers/all-mpnet-base-v2"),
  embeddingDimensions: EnvPositiveIntegerSchema.default(768),
  embeddingProfileVersion: EnvPositiveIntegerSchema.default(2),
  knowledgeChunkTokens: EnvPositiveIntegerSchema.default(300),
  knowledgeChunkOverlapTokens: EnvPositiveIntegerSchema.default(50),
  retrievalTokenBudget: EnvPositiveIntegerSchema.default(5000),
  runLeaseSeconds: EnvPositiveIntegerSchema.default(90),
  sandboxSnapshotIntervalSeconds: EnvPositiveIntegerSchema.default(900),
  knowledgeMaxInputBytes: EnvPositiveIntegerSchema.default(104857600),
  knowledgeMaxOutputBytes: EnvPositiveIntegerSchema.default(26214400),
  sandboxInputMaxBytes: EnvPositiveIntegerSchema.default(DEFAULT_SANDBOX_INPUT_MAX_BYTES),
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
    runLeaseSeconds: env.BERRY_RUN_LEASE_SECONDS,
    sandboxSnapshotIntervalSeconds: env.BERRY_SANDBOX_SNAPSHOT_INTERVAL_SECONDS,
    knowledgeMaxInputBytes: env.BERRY_KNOWLEDGE_MAX_INPUT_BYTES,
    knowledgeMaxOutputBytes: env.BERRY_KNOWLEDGE_MAX_OUTPUT_BYTES,
    sandboxInputMaxBytes: env.BERRY_SANDBOX_INPUT_MAX_BYTES,
  });
}
