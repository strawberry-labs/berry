import { z } from "zod";

export const WORKER_QUEUE_NAME = "berry-cloud";

export const TitleGenJobPayloadSchema = z.object({
  tenantId: z.string().uuid(),
  taskId: z.string().min(1),
  sourceText: z.string().min(1),
  fallbackTitle: z.string().trim().min(1).max(120).optional(),
  requestedByUserId: z.string().min(1).nullable().optional(),
});
export type TitleGenJobPayload = z.infer<typeof TitleGenJobPayloadSchema>;

export const CompactionJobPayloadSchema = z.object({
  tenantId: z.string().uuid(),
  taskId: z.string().min(1),
  sessionId: z.string().min(1),
  reason: z.enum(["manual", "token-threshold", "scheduled"]).default("token-threshold"),
  maxTokens: z.number().int().positive().optional(),
  requestedByUserId: z.string().min(1).nullable().optional(),
});
export type CompactionJobPayload = z.infer<typeof CompactionJobPayloadSchema>;

export const TurnExecuteJobPayloadSchema = z.object({
  tenantId: z.string().uuid(),
  runId: z.string().uuid(),
  reason: z.enum(["admitted", "continue", "lease-recovery", "approval-resolved", "retry"]).default("continue"),
});
export type TurnExecuteJobPayload = z.infer<typeof TurnExecuteJobPayloadSchema>;

export const TurnResumeJobPayloadSchema = TurnExecuteJobPayloadSchema.extend({
  reason: z.enum(["approval-resolved", "user-input", "scheduled-retry", "operator-recovery"]),
});
export type TurnResumeJobPayload = z.infer<typeof TurnResumeJobPayloadSchema>;

export const SandboxSnapshotJobPayloadSchema = z.object({
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

export const ContextBackfillJobPayloadSchema = MaintenanceJobBaseSchema;
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
  "memory.extract": MemoryExtractJobPayload;
  "context.backfill": ContextBackfillJobPayload;
  "context.cleanup": RetentionCleanupJobPayload;
}

export type BerryWorkerJobPayload = BerryWorkerJobMap[BerryWorkerJobName];

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
  if(jobName==="memory.extract")return MemoryExtractJobPayloadSchema.parse(data);
  if(jobName==="context.backfill")return ContextBackfillJobPayloadSchema.parse(data);
  if(jobName==="context.cleanup")return RetentionCleanupJobPayloadSchema.parse(data);
  return KnowledgeRevisionJobPayloadSchema.parse(data);
}
