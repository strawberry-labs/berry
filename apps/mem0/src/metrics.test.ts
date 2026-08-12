import { describe, expect, it } from "vitest";
import { Mem0RuntimeMetrics } from "./metrics.js";

describe("Mem0RuntimeMetrics", () => {
  it("exposes bounded request, timeout, pool, and process-start metrics", () => {
    const metrics = new Mem0RuntimeMetrics(1_500);
    const success = metrics.requestStarted();
    metrics.requestSucceeded(success);
    const timeout = metrics.requestStarted();
    metrics.requestFailed(Object.assign(new Error("read ETIMEDOUT"), { code: "ETIMEDOUT" }), 500, timeout);
    const serverError = metrics.requestStarted();
    metrics.requestFailed(new Error("database unavailable"), 500, serverError);
    metrics.postgresPoolFailed("57P01");
    metrics.postgresPoolFailed("unsafe\nvalue");
    metrics.requestStarted();

    const output = metrics.render();
    expect(output).toContain("berry_mem0_process_start_time_seconds 1.5");
    expect(output).toContain("berry_mem0_active_requests 1");
    expect(output).toContain("berry_mem0_requests_total 4");
    expect(output).toContain("berry_mem0_request_successes_total 1");
    expect(output).toContain('berry_mem0_request_errors_total{category="timeout"} 1');
    expect(output).toContain('berry_mem0_request_errors_total{category="server"} 1');
    expect(output).toContain("berry_mem0_request_timeouts_total 1");
    expect(output).toContain("berry_mem0_request_duration_seconds_count 3");
    expect(output).toContain('berry_mem0_postgres_pool_errors_total{code="57P01"} 1');
    expect(output).toContain('berry_mem0_postgres_pool_errors_total{code="UNSAFEVALUE"} 1');
  });

  it("detects nested timeout causes without exposing their messages", () => {
    const metrics = new Mem0RuntimeMetrics();
    const startedAt = metrics.requestStarted();
    metrics.requestFailed(new Error("provider failed", {
      cause: Object.assign(new Error("private connection detail"), { code: "UND_ERR_CONNECT_TIMEOUT" }),
    }), 500, startedAt);

    const output = metrics.render();
    expect(output).toContain('berry_mem0_request_errors_total{category="timeout"} 1');
    expect(output).not.toContain("private connection detail");
  });
});
