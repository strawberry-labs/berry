import { AlertEvaluationJobPayloadSchema, BerryWorkerJobNameSchema, CompactionJobPayloadSchema, ContextBackfillJobPayloadSchema, KnowledgeIndexTaskJobPayloadSchema, KnowledgeRevisionJobPayloadSchema, MemoryExtractJobPayloadSchema, ReportRunJobPayloadSchema, RetentionCleanupJobPayloadSchema, SandboxSnapshotJobPayloadSchema, TitleGenJobPayloadSchema, TurnExecuteJobPayloadSchema, TurnResumeJobPayloadSchema, UsageRollupJobPayloadSchema } from "./jobs.js";
import { processAlertEvaluationJob, processReportRunJob, type ManagementJobRepository } from "./reporting-alerts.js";
import { processCompactionJob, type SessionCompactionRunner } from "./compaction.js";
import { processTitleGenerationJob, type TaskTitleRepository, type TitleGenerator } from "./title-gen.js";
import { processUsageRollupJob, type UsageRollupRepository } from "./usage-rollups.js";
import type { KnowledgeJobName, KnowledgeProcessor } from "./knowledge/processor.js";
import type { MemoryProcessor } from "./memory/processor.js";
import type { DurableTurnRunner } from "./turn-runner.js";
import type { SandboxContinuityManager } from "./sandbox-continuity.js";
import type { MaintenanceRunner } from "./maintenance.js";

export interface BerryWorkerDependencies {
  titles: TaskTitleRepository;
  compactor: SessionCompactionRunner;
  usage: UsageRollupRepository;
  management?: ManagementJobRepository | undefined;
  titleGenerator?: TitleGenerator | undefined;
  knowledge?: KnowledgeProcessor | undefined;
  memory?: MemoryProcessor | undefined;
  turnRunner?: DurableTurnRunner | undefined;
  snapshotter?: SandboxContinuityManager | undefined;
  maintenance?: MaintenanceRunner | undefined;
}

export async function processBerryWorkerJob(
  name: string,
  data: unknown,
  dependencies: BerryWorkerDependencies,
): Promise<unknown> {
  const jobName = BerryWorkerJobNameSchema.parse(name);
  if (jobName === "title.generate") {
    const payload = TitleGenJobPayloadSchema.parse(data);
    const titleDependencies = dependencies.titleGenerator
      ? { titles: dependencies.titles, generator: dependencies.titleGenerator }
      : { titles: dependencies.titles };
    return processTitleGenerationJob(payload, titleDependencies);
  }
  if (jobName === "session.compact") {
    const payload = CompactionJobPayloadSchema.parse(data);
    return processCompactionJob(payload, { compactor: dependencies.compactor });
  }
  if (jobName === "turn.execute" || jobName === "turn.resume") {
    if (!dependencies.turnRunner) throw new Error("Durable turn runner is not configured");
    return dependencies.turnRunner.execute(
      jobName === "turn.execute"
        ? TurnExecuteJobPayloadSchema.parse(data)
        : TurnResumeJobPayloadSchema.parse(data),
    );
  }
  if (jobName === "sandbox.snapshot") {
    if (!dependencies.snapshotter) throw new Error("Sandbox snapshotter is not configured");
    return dependencies.snapshotter.snapshot(SandboxSnapshotJobPayloadSchema.parse(data));
  }
  if(jobName==="usage.rollup"){const payload=UsageRollupJobPayloadSchema.parse(data);return processUsageRollupJob(payload,{usage:dependencies.usage});}
  if (isKnowledgeJobName(jobName)) {
    if (!dependencies.knowledge) throw new Error("Knowledge processor is not configured");
    if (jobName === "knowledge.index-task") {
      return dependencies.knowledge.process(jobName, KnowledgeIndexTaskJobPayloadSchema.parse(data));
    }
    return dependencies.knowledge.process(jobName, KnowledgeRevisionJobPayloadSchema.parse(data));
  }
  if (jobName === "memory.extract") {
    if (!dependencies.memory) throw new Error("Memory processor is not configured");
    return dependencies.memory.process(MemoryExtractJobPayloadSchema.parse(data));
  }
  if (jobName === "context.backfill" || jobName === "context.cleanup") {
    if (!dependencies.maintenance) throw new Error("Maintenance runner is not configured");
    return jobName === "context.backfill"
      ? dependencies.maintenance.backfill(ContextBackfillJobPayloadSchema.parse(data))
      : dependencies.maintenance.cleanup(RetentionCleanupJobPayloadSchema.parse(data));
  }
  if(!dependencies.management)throw new Error("Management job repository is not configured");
  if(jobName==="report.run")return processReportRunJob(ReportRunJobPayloadSchema.parse(data),{management:dependencies.management});
  return processAlertEvaluationJob(AlertEvaluationJobPayloadSchema.parse(data),{management:dependencies.management});
}

function isKnowledgeJobName(value: string): value is KnowledgeJobName {
  return value === "knowledge.extract"
    || value === "knowledge.chunk"
    || value === "knowledge.embed"
    || value === "knowledge.index-task"
    || value === "knowledge.delete"
    || value === "knowledge.reindex";
}
