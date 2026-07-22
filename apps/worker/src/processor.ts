import { AlertEvaluationJobPayloadSchema, BerryWorkerJobNameSchema, CompactionJobPayloadSchema, ReportRunJobPayloadSchema, TitleGenJobPayloadSchema, UsageRollupJobPayloadSchema } from "./jobs.js";
import { processAlertEvaluationJob, processReportRunJob, type ManagementJobRepository } from "./reporting-alerts.js";
import { processCompactionJob, type SessionCompactionRunner } from "./compaction.js";
import { processTitleGenerationJob, type TaskTitleRepository, type TitleGenerator } from "./title-gen.js";
import { processUsageRollupJob, type UsageRollupRepository } from "./usage-rollups.js";

export interface BerryWorkerDependencies {
  titles: TaskTitleRepository;
  compactor: SessionCompactionRunner;
  usage: UsageRollupRepository;
  management?: ManagementJobRepository | undefined;
  titleGenerator?: TitleGenerator | undefined;
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
  if(jobName==="usage.rollup"){const payload=UsageRollupJobPayloadSchema.parse(data);return processUsageRollupJob(payload,{usage:dependencies.usage});}
  if(!dependencies.management)throw new Error("Management job repository is not configured");
  if(jobName==="report.run")return processReportRunJob(ReportRunJobPayloadSchema.parse(data),{management:dependencies.management});
  return processAlertEvaluationJob(AlertEvaluationJobPayloadSchema.parse(data),{management:dependencies.management});
}
