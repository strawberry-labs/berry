import { describe, expect, it } from "vitest";
import { ApiRuntimeMetrics } from "./runtime-metrics.js";

describe("API runtime metrics", () => {
  it("renders bounded admission and cancellation series", () => {
    const metrics = new ApiRuntimeMetrics();
    metrics.turnAdmission("admitted", 750, null);
    metrics.turnAdmission("failed", 2_500, 503);
    metrics.turnCancellation("active_run");
    metrics.turnCancellation("pending_or_terminal");
    metrics.turnCancellationSignal("published");
    metrics.turnCancellationSignal("failed");
    metrics.personalMemoryRecall("success", 120);
    metrics.personalMemoryRecall("timeout", 1_500);
    metrics.personalMemoryRecall("unavailable", 80);

    const output = metrics.render();
    expect(output).toContain('berry_api_turn_admissions_total{outcome="admitted",status="200"} 1');
    expect(output).toContain('berry_api_turn_admissions_total{outcome="failed",status="503"} 1');
    expect(output).toContain('berry_api_turn_admission_duration_seconds_bucket{outcome="admitted",le="1"} 1');
    expect(output).toContain('berry_api_turn_admission_duration_seconds_count{outcome="failed"} 1');
    expect(output).toContain('berry_api_turn_cancellations_total{result="active_run"} 1');
    expect(output).toContain('berry_api_turn_cancellation_signals_total{result="failed"} 1');
    expect(output).toContain('berry_api_personal_memory_recalls_total{outcome="timeout"} 1');
    expect(output).toContain('berry_api_personal_memory_recall_duration_seconds_bucket{outcome="timeout",le="1.5"} 1');
    expect(output).toContain('berry_api_personal_memory_recall_duration_seconds_count{outcome="unavailable"} 1');
  });
});
