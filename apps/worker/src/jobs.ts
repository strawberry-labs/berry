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

export const BerryWorkerJobNameSchema = z.enum(["title.generate", "session.compact", "usage.rollup", "report.run", "alerts.evaluate"]);
export type BerryWorkerJobName = z.infer<typeof BerryWorkerJobNameSchema>;

export interface BerryWorkerJobMap {
  "title.generate": TitleGenJobPayload;
  "session.compact": CompactionJobPayload;
  "usage.rollup": UsageRollupJobPayload;
  "report.run": ReportRunJobPayload;
  "alerts.evaluate": AlertEvaluationJobPayload;
}

export type BerryWorkerJobPayload = BerryWorkerJobMap[BerryWorkerJobName];

export function parseWorkerJob(name: string, data: unknown): BerryWorkerJobPayload {
  const jobName = BerryWorkerJobNameSchema.parse(name);
  if (jobName === "title.generate") return TitleGenJobPayloadSchema.parse(data);
  if (jobName === "session.compact") return CompactionJobPayloadSchema.parse(data);
  if(jobName==="usage.rollup")return UsageRollupJobPayloadSchema.parse(data);
  if(jobName==="report.run")return ReportRunJobPayloadSchema.parse(data);
  return AlertEvaluationJobPayloadSchema.parse(data);
}
