import { describe, expect, it } from "vitest";
import { WorkerRuntimeMetrics } from "./runtime-metrics.js";

describe("worker runtime metrics", () => {
  it("renders success and failure provider, outbox, and cancellation series", () => {
    const metrics = new WorkerRuntimeMetrics();
    metrics.providerRequest({ model: "kimi-k2.6", outcome: "success", status: 200, latencyMs: 800 });
    metrics.providerRequest({ model: "deepseek-v4-flash", outcome: "failure", status: 400, latencyMs: 2_500 });
    metrics.outboxDispatch("turn.execute", 125);
    metrics.cancellationSignal("received", 1);

    const output = metrics.render();
    expect(output).toContain('berry_worker_provider_requests_total{model="kimi-k2.6",outcome="success",status="200"} 1');
    expect(output).toContain('berry_worker_provider_request_duration_seconds_bucket{model="deepseek-v4-flash",outcome="failure",status="400",le="5"} 1');
    expect(output).toContain('berry_worker_outbox_dispatches_total{job_name="turn.execute"} 1');
    expect(output).toContain('berry_worker_outbox_dispatch_duration_seconds_bucket{job_name="turn.execute",le="0.25"} 1');
    expect(output).toContain('berry_worker_turn_cancellation_signals_total{result="received"} 1');
    expect(output).toContain("berry_worker_provider_requests_aborted_total 1");
  });

  it("records time to first token and preparation steps (H-013)", () => {
    const metrics = new WorkerRuntimeMetrics();
    metrics.providerRequest({ model: "glm-5.3", outcome: "success", status: 200, latencyMs: 9_000, firstTokenMs: 1_800 });
    metrics.providerRequest({ model: "glm-5.3", outcome: "failure", status: 500, latencyMs: 300, firstTokenMs: 100 });
    metrics.preparationStep("skill.stage", "success", 420);
    metrics.preparationStep("snapshot.capture", "failure", 31_000);

    const output = metrics.render();
    expect(output).toContain('berry_worker_provider_first_token_seconds_bucket{model="glm-5.3",le="2"} 1');
    expect(output).toContain('berry_worker_provider_first_token_seconds_count{model="glm-5.3"} 1');
    expect(output).toContain('berry_worker_preparation_duration_seconds_bucket{operation="skill.stage",outcome="success",le="0.5"} 1');
    expect(output).toContain('berry_worker_preparation_duration_seconds_bucket{operation="snapshot.capture",outcome="failure",le="30"} 0');
    expect(output).toContain('berry_worker_preparation_duration_seconds_count{operation="snapshot.capture",outcome="failure"} 1');
  });

  it("bounds provider label values", () => {
    const metrics = new WorkerRuntimeMetrics();
    metrics.providerRequest({ model: "x".repeat(500), outcome: "other", status: 999, latencyMs: null });

    const output = metrics.render();
    expect(output).toContain(`model="${"x".repeat(200)}",outcome="failure",status="unknown"`);
    expect(output).not.toContain("x".repeat(201));
  });
});
