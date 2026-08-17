import { z } from "zod";

export const OperationalWorkerRoleSchema = z.enum(["foreground", "background", "all", "unknown"]);
export type OperationalWorkerRole = z.infer<typeof OperationalWorkerRoleSchema>;

export const OperationalEventTypeSchema = z.enum([
  "admission.transition",
  "run.claim",
  "phase.transition",
  "turn.progress",
  "provider.attempt",
  "tool.attempt",
  "wait.transition",
  "finalization.transition",
  "usage.settlement",
  "outbox.transition",
  "tool.manifest",
]);
export type OperationalEventType = z.infer<typeof OperationalEventTypeSchema>;

export const OPERATIONAL_LOG_SCHEMA_VERSION = 1 as const;
export const DEFAULT_OPERATIONAL_LOG_RETENTION_DAYS = 14;
export const DEFAULT_OPERATIONAL_LOG_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_OPERATIONAL_LOG_MAX_FILES = 5;

const SAFE_FIELDS = new Set([
  "previousState",
  "newState",
  "preparationDurationMs",
  "attempt",
  "terminalReason",
  "claimEpoch",
  "phaseClaimCount",
  "queueWaitMs",
  "hydrationMs",
  "phase",
  "idleDeadlineMs",
  "wallDeadlineMs",
  "durationMs",
  "outcome",
  "progressKind",
  "consecutiveNoProgress",
  "budgetRemaining",
  "model",
  "physicalAttempt",
  "statusClass",
  "category",
  "retryDecision",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "toolFamily",
  "retryClass",
  "approvalClass",
  "outcomeCertainty",
  "itemCount",
  "completedCount",
  "failedCount",
  "retry",
  "eventHighWatermark",
  "adjustmentCount",
  "reconciled",
  "priority",
  "firstAvailableAt",
  "claimedAt",
  "deliveredAt",
  "receiptAt",
  "deliveryLatencyMs",
  "receiptLatencyMs",
  "deadLetterReason",
  "workflowCategory",
  "workflowCategoryVersion",
  "workerRole",
  "sourceRevision",
]);

const DURABLE_REFERENCE_FIELDS = new Set(["runId", "stepId", "outboxId"]);

export type OperationalScalar = string | number | boolean | null;

/**
 * Returns only the fields approved for low-cardinality operational telemetry.
 * Unknown keys are intentionally dropped, including request/user/tenant IDs,
 * paths, URLs, arguments, outputs, and error text.
 */
export function safeOperationalFields(fields: Record<string, unknown>): Record<string, OperationalScalar> {
  const result: Record<string, OperationalScalar> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!SAFE_FIELDS.has(key) && !DURABLE_REFERENCE_FIELDS.has(key)) continue;
    if (typeof value === "string") {
      const bounded = value.trim().slice(0, 128);
      if (!bounded) continue;
      if (key === "workerRole") {
        result[key] = normalizeWorkerRole(bounded);
      } else if (key === "sourceRevision") {
        result[key] = /^[A-Za-z0-9._/-]+$/.test(bounded) ? bounded : "unknown";
      } else {
        result[key] = bounded;
      }
    } else if (typeof value === "number" && Number.isFinite(value)) {
      result[key] = Math.max(0, Math.round(value));
    } else if (typeof value === "boolean" || value === null) {
      result[key] = value;
    }
  }
  return result;
}

export function safeOperationalLog(
  eventType: OperationalEventType,
  fields: Record<string, unknown> = {},
): Record<string, OperationalScalar> {
  return {
    event: `berry.${eventType}`,
    schemaVersion: OPERATIONAL_LOG_SCHEMA_VERSION,
    ...safeOperationalFields(fields),
  };
}

export function normalizeWorkerRole(value: unknown): OperationalWorkerRole {
  return OperationalWorkerRoleSchema.safeParse(value).success
    ? value as OperationalWorkerRole
    : "unknown";
}

export function sourceRevisionFromEnv(env: Record<string, string | undefined>): string {
  const candidate = [
    env.BERRY_BUILD_REVISION,
    env.BERRY_SOURCE_REVISION,
    env.BERRY_GIT_SHA,
    env.SOURCE_VERSION,
  ].find((value) => typeof value === "string" && value.trim());
  if (!candidate) return "unknown";
  const normalized = candidate.trim().slice(0, 128);
  return /^[A-Za-z0-9._/-]+$/.test(normalized) ? normalized : "unknown";
}

export type OperationalLogPolicy = {
  retentionDays: number;
  maxBytes: number;
  maxFiles: number;
};

export function operationalLogPolicyFromEnv(env: Record<string, string | undefined>): OperationalLogPolicy {
  return {
    retentionDays: positiveInteger(env.BERRY_LOG_RETENTION_DAYS, DEFAULT_OPERATIONAL_LOG_RETENTION_DAYS, 3_650),
    maxBytes: positiveInteger(env.BERRY_LOG_MAX_BYTES, DEFAULT_OPERATIONAL_LOG_MAX_BYTES, 1_073_741_824),
    maxFiles: positiveInteger(env.BERRY_LOG_MAX_FILES, DEFAULT_OPERATIONAL_LOG_MAX_FILES, 100),
  };
}

function positiveInteger(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}
