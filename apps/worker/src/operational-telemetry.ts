import {
  safeOperationalFields,
  safeOperationalLog,
  type OperationalEventType,
  type OperationalScalar,
  type OperationalWorkerRole,
} from "@berry/shared";
import type { SqlExecutor } from "./sql-repositories.js";

export type WorkerOperationalContext = {
  tenantId: string;
  runId?: string | null;
  sessionId?: string | null;
  eventType: OperationalEventType;
  dedupeKey: string;
  claimEpoch?: number | null;
  phaseClaimCount?: number | null;
  workerRole: OperationalWorkerRole;
  sourceRevision: string;
  fields?: Record<string, unknown>;
};

export function emitWorkerOperationalEvent(
  eventType: OperationalEventType,
  workerRole: OperationalWorkerRole,
  sourceRevision: string,
  fields: Record<string, unknown> = {},
): void {
  console.info(JSON.stringify(safeOperationalLog(eventType, {
    workerRole,
    sourceRevision,
    ...fields,
  })));
}

export async function persistWorkerOperationalEvent(
  executor: SqlExecutor,
  context: WorkerOperationalContext,
): Promise<void> {
  const payload = safeOperationalFields(context.fields ?? {});
  await executor.execute(
    `
INSERT INTO agent_operational_events (
  tenant_id,run_id,session_id,event_type,dedupe_key,claim_epoch,phase_claim_count,
  worker_role,source_revision,payload
) VALUES (
  $1::uuid,$2::uuid,$3::uuid,$4,$5,$6::bigint,$7::integer,$8,$9,$10::jsonb
)
ON CONFLICT (tenant_id,dedupe_key) DO NOTHING
    `.trim(),
    [
      context.tenantId,
      context.runId ?? null,
      context.sessionId ?? null,
      context.eventType,
      context.dedupeKey,
      context.claimEpoch ?? null,
      context.phaseClaimCount ?? null,
      context.workerRole,
      context.sourceRevision,
      JSON.stringify(payload),
    ],
  );
}

export function operationalDuration(startedAt: number, endedAt = Date.now()): OperationalScalar {
  return Math.max(0, endedAt - startedAt);
}
