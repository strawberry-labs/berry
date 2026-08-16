import { z } from "zod";
import {
  TurnExecuteReasonSchema,
  TurnResumeReasonSchema,
} from "@berry/shared";

/**
 * The original shared queue remains available only as a deployment drain path.
 * New jobs are routed to one of the two isolated queues below.
 */
export const LEGACY_WORKER_QUEUE_NAME = "berry-cloud";
export const FOREGROUND_WORKER_QUEUE_NAME = "berry-cloud-turns";
export const BACKGROUND_WORKER_QUEUE_NAME = "berry-cloud-background";
/** @deprecated Use a role-specific queue name for new producers. */
export const WORKER_QUEUE_NAME = LEGACY_WORKER_QUEUE_NAME;

export const TitleGenJobPayloadSchema = z.object({
  tenantId: z.string().uuid(),
  taskId: z.string().min(1),
  sourceText: z.string().min(1),
  fallbackTitle: z.string().trim().min(1).max(120).optional(),
  requestedByUserId: z.string().min(1).nullable().optional(),
});
export type TitleGenJobPayload = z.infer<typeof TitleGenJobPayloadSchema>;

export const CompactionJobPayloadSchema = z.object({
  runId: z.string().uuid().optional(),
  tenantId: z.string().uuid(),
  taskId: z.string().min(1),
  sessionId: z.string().min(1),
  reason: z.enum(["manual", "token-threshold", "scheduled"]).default("token-threshold"),
  maxTokens: z.number().int().positive().optional(),
  maxDurationMs: z.number().int().min(5_000).max(300_000).optional(),
  algorithmVersion: z.string().trim().min(1).max(64).default("checkpoint-v2-bounded"),
  requestedByUserId: z.string().min(1).nullable().optional(),
});
// Keep the wire schema's default while allowing existing producers and tests
// to omit the field; consumers resolve it at the execution boundary.
export type CompactionJobPayload = Omit<z.infer<typeof CompactionJobPayloadSchema>, "algorithmVersion"> & {
  algorithmVersion?: string;
};

export const TurnExecuteJobPayloadSchema = z.object({
  outboxId: z.string().uuid().optional(),
  tenantId: z.string().uuid(),
  runId: z.string().uuid(),
  reason: TurnExecuteReasonSchema.default("continue"),
});
export type TurnExecuteJobPayload = z.infer<typeof TurnExecuteJobPayloadSchema>;

export const TurnResumeJobPayloadSchema = TurnExecuteJobPayloadSchema.extend({
  reason: TurnResumeReasonSchema,
});
export type TurnResumeJobPayload = z.infer<typeof TurnResumeJobPayloadSchema>;

export const SandboxSnapshotJobPayloadSchema = z.object({
  outboxId: z.string().uuid().optional(),
  tenantId: z.string().uuid(),
  runId: z.string().uuid(),
  reason: z.enum(["interval", "before-wait", "before-finalize", "manual"]).default("interval"),
});
export type SandboxSnapshotJobPayload = z.infer<typeof SandboxSnapshotJobPayloadSchema>;

export const UsageRollupJobPayloadSchema = z.object({
  tenantId: z.string().uuid(),
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
  granularity: z.enum(["day"]).default("day"),
  requestedAt: z.string().datetime({ offset: true }).optional(),
});
export type UsageRollupJobPayload = z.infer<typeof UsageRollupJobPayloadSchema>;
export const ReportRunJobPayloadSchema=z.object({tenantId:z.string().uuid(),scheduleId:z.string().uuid(),windowKey:z.string().min(1)});export type ReportRunJobPayload=z.infer<typeof ReportRunJobPayloadSchema>;
export const AlertEvaluationJobPayloadSchema=z.object({tenantId:z.string().uuid(),from:z.string().datetime({offset:true}),to:z.string().datetime({offset:true})});export type AlertEvaluationJobPayload=z.infer<typeof AlertEvaluationJobPayloadSchema>;

export const KnowledgeRevisionJobPayloadSchema = z.object({
  tenantId: z.string().uuid(),
  sourceId: z.string().uuid(),
  revision: z.string().min(1),
});
export type KnowledgeRevisionJobPayload = z.infer<typeof KnowledgeRevisionJobPayloadSchema>;

export const KnowledgeIndexTaskJobPayloadSchema = z.object({
  tenantId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  taskId: z.string().uuid(),
  sessionId: z.string().uuid(),
  revision: z.string().min(1),
});
export type KnowledgeIndexTaskJobPayload = z.infer<typeof KnowledgeIndexTaskJobPayloadSchema>;

export const FileDeleteObjectJobPayloadSchema = z.object({
  outboxId: z.string().uuid(),
  tenantId: z.string().uuid(),
  fileId: z.string().uuid(),
  bucket: z.string().min(1).max(255),
  keys: z.array(z.string().min(1).max(2_048)).min(1).max(1_000),
});
export type FileDeleteObjectJobPayload = z.infer<typeof FileDeleteObjectJobPayloadSchema>;

export const FileBlobJobPayloadSchema = z.object({
  tenantId: z.string().uuid(),
  blobId: z.string().uuid(),
});
export type FileBlobJobPayload = z.infer<typeof FileBlobJobPayloadSchema>;

export const FileDeleteBlobJobPayloadSchema = FileBlobJobPayloadSchema.extend({
  outboxId: z.string().uuid(),
});
export type FileDeleteBlobJobPayload = z.infer<typeof FileDeleteBlobJobPayloadSchema>;

export const MemoryExtractJobPayloadSchema = z.object({
  tenantId: z.string().uuid(),
  userId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  taskId: z.string().uuid(),
  sessionId: z.string().uuid(),
  userMessageId: z.string().uuid(),
  assistantMessageId: z.string().uuid(),
  revision: z.string().min(1),
  extractorVersion: z.string().min(1),
  userText: z.string().max(16_000),
  assistantText: z.string().max(16_000),
});
export type MemoryExtractJobPayload = z.infer<typeof MemoryExtractJobPayloadSchema>;

const MaintenanceJobBaseSchema = z.object({
  tenantId: z.string().uuid(),
  runId: z.string().uuid(),
  generation: z.number().int().nonnegative().default(0),
  batchSize: z.number().int().min(10).max(500).default(100),
  requestedByUserId: z.string().uuid().nullable().optional(),
});

export const ContextBackfillJobPayloadSchema = MaintenanceJobBaseSchema.extend({
  phase: z.enum(["workspace_files", "file_sources", "task_outcomes", "verify_file_blobs"]).optional(),
});
export type ContextBackfillJobPayload = z.infer<typeof ContextBackfillJobPayloadSchema>;

export const RetentionCleanupJobPayloadSchema = MaintenanceJobBaseSchema.extend({
  eventRetentionDays: z.number().int().min(1).max(3_650).default(30),
  diagnosticRetentionDays: z.number().int().min(1).max(3_650).default(30),
  outboxRetentionDays: z.number().int().min(1).max(3_650).default(7),
});
export type RetentionCleanupJobPayload = z.infer<typeof RetentionCleanupJobPayloadSchema>;

export const BerryWorkerJobNameSchema = z.enum([
  "title.generate",
  "session.compact",
  "turn.execute",
  "turn.resume",
  "sandbox.snapshot",
  "usage.rollup",
  "report.run",
  "alerts.evaluate",
  "knowledge.extract",
  "knowledge.chunk",
  "knowledge.embed",
  "knowledge.index-task",
  "knowledge.delete",
  "knowledge.reindex",
  "file.delete-object",
  "file.delete-blob",
  "file.verify-blob",
  "memory.extract",
  "context.backfill",
  "context.cleanup",
]);
export type BerryWorkerJobName = z.infer<typeof BerryWorkerJobNameSchema>;

export interface BerryWorkerJobMap {
  "title.generate": TitleGenJobPayload;
  "session.compact": CompactionJobPayload;
  "turn.execute": TurnExecuteJobPayload;
  "turn.resume": TurnResumeJobPayload;
  "sandbox.snapshot": SandboxSnapshotJobPayload;
  "usage.rollup": UsageRollupJobPayload;
  "report.run": ReportRunJobPayload;
  "alerts.evaluate": AlertEvaluationJobPayload;
  "knowledge.extract": KnowledgeRevisionJobPayload;
  "knowledge.chunk": KnowledgeRevisionJobPayload;
  "knowledge.embed": KnowledgeRevisionJobPayload;
  "knowledge.index-task": KnowledgeIndexTaskJobPayload;
  "knowledge.delete": KnowledgeRevisionJobPayload;
  "knowledge.reindex": KnowledgeRevisionJobPayload;
  "file.delete-object": FileDeleteObjectJobPayload;
  "file.delete-blob": FileDeleteBlobJobPayload;
  "file.verify-blob": FileBlobJobPayload;
  "memory.extract": MemoryExtractJobPayload;
  "context.backfill": ContextBackfillJobPayload;
  "context.cleanup": RetentionCleanupJobPayload;
}

export type BerryWorkerJobPayload = BerryWorkerJobMap[BerryWorkerJobName];

export type BerryWorkerQueueKind = "foreground" | "background";

export function workerQueueKind(name: BerryWorkerJobName): BerryWorkerQueueKind {
  return name === "turn.execute" || name === "turn.resume" ? "foreground" : "background";
}

export function parseWorkerJob(name: string, data: unknown): BerryWorkerJobPayload {
  const jobName = BerryWorkerJobNameSchema.parse(name);
  if (jobName === "title.generate") return TitleGenJobPayloadSchema.parse(data);
  if (jobName === "session.compact") return CompactionJobPayloadSchema.parse(data);
  if (jobName === "turn.execute") return TurnExecuteJobPayloadSchema.parse(data);
  if (jobName === "turn.resume") return TurnResumeJobPayloadSchema.parse(data);
  if (jobName === "sandbox.snapshot") return SandboxSnapshotJobPayloadSchema.parse(data);
  if(jobName==="usage.rollup")return UsageRollupJobPayloadSchema.parse(data);
  if(jobName==="report.run")return ReportRunJobPayloadSchema.parse(data);
  if(jobName==="alerts.evaluate")return AlertEvaluationJobPayloadSchema.parse(data);
  if(jobName==="knowledge.index-task")return KnowledgeIndexTaskJobPayloadSchema.parse(data);
  if(jobName==="file.delete-object")return FileDeleteObjectJobPayloadSchema.parse(data);
  if(jobName==="file.delete-blob")return FileDeleteBlobJobPayloadSchema.parse(data);
  if(jobName==="file.verify-blob")return FileBlobJobPayloadSchema.parse(data);
  if(jobName==="memory.extract")return MemoryExtractJobPayloadSchema.parse(data);
  if(jobName==="context.backfill")return ContextBackfillJobPayloadSchema.parse(data);
  if(jobName==="context.cleanup")return RetentionCleanupJobPayloadSchema.parse(data);
  return KnowledgeRevisionJobPayloadSchema.parse(data);
}
