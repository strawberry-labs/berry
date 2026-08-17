import { describe, expect, it } from "vitest";
import {
  operationalLogPolicyFromEnv,
  safeOperationalLog,
  safeOperationalFields,
  sourceRevisionFromEnv,
} from "./operational-telemetry.ts";

describe("operational telemetry", () => {
  it("drops sensitive and unallowlisted fields", () => {
    const fields = safeOperationalFields({
      runId: "run-1",
      workerRole: "foreground",
      sourceRevision: "rev-1",
      durationMs: 42,
      requestId: "request-secret",
      tenantId: "tenant-secret",
      prompt: "private content",
      error: "private error",
    });
    expect(fields).toEqual({
      runId: "run-1",
      workerRole: "foreground",
      sourceRevision: "rev-1",
      durationMs: 42,
    });
    expect(safeOperationalLog("run.claim", fields)).not.toHaveProperty("requestId");
  });

  it("normalizes revisions and exposes bounded rotation policy defaults", () => {
    expect(sourceRevisionFromEnv({ BERRY_BUILD_REVISION: "release/2026.08" })).toBe("release/2026.08");
    expect(sourceRevisionFromEnv({ BERRY_BUILD_REVISION: "hostname with spaces" })).toBe("unknown");
    expect(operationalLogPolicyFromEnv({})).toEqual({
      retentionDays: 14,
      maxBytes: 10 * 1024 * 1024,
      maxFiles: 5,
    });
  });
});
