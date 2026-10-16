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

  it("keeps a provider attempt's ID, retry layer and transport but not its route (H-033)", () => {
    expect(safeOperationalFields({
      attemptId: "6f9619ff-8b86-4d01-b42d-00cf4fc964ff",
      retryLayer: "runner_retry",
      transport: "stream",
      route: "/v1/projects/private/chat/completions",
      requestId: "provider-request",
    })).toEqual({
      attemptId: "6f9619ff-8b86-4d01-b42d-00cf4fc964ff",
      retryLayer: "runner_retry",
      transport: "stream",
    });
  });

  it("normalizes revisions and exposes bounded rotation policy defaults", () => {
    expect(sourceRevisionFromEnv({ BERRY_BUILD_REVISION: "release/2026.08" })).toBe("release/2026.08");
    expect(sourceRevisionFromEnv({ BERRY_BUILD_REVISION: "hostname with spaces" })).toBe("unknown");
    expect(sourceRevisionFromEnv({ BERRY_BUILD_REVISION: "99964f18d52a27a587c3b3880b4511cbe8b3a9cc+production-hotfixes" }))
      .toBe("99964f18d52a27a587c3b3880b4511cbe8b3a9cc+production-hotfixes");
    expect(safeOperationalLog("run.claim", { sourceRevision: "99964f1+production-hotfixes" }).sourceRevision)
      .toBe("99964f1+production-hotfixes");
    expect(sourceRevisionFromEnv({ BERRY_BUILD_REVISION: "rev;rm -rf" })).toBe("unknown");
    expect(operationalLogPolicyFromEnv({})).toEqual({
      retentionDays: 14,
      maxBytes: 10 * 1024 * 1024,
      maxFiles: 5,
    });
  });
});
