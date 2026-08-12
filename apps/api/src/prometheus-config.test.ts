import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const deployRoot = new URL("../../../deploy/", import.meta.url);

describe("Compose Prometheus configuration", () => {
  it("scrapes API, Mem0, and every scaled foreground/background worker", () => {
    const config = parse(readFileSync(new URL("prometheus/prometheus.yml", deployRoot), "utf8")) as {
      rule_files?: string[];
      alerting?: { alertmanagers?: Array<Record<string, unknown>> };
      scrape_configs?: Array<Record<string, unknown>>;
    };
    const jobs = new Map((config.scrape_configs ?? []).map((job) => [job.job_name, job]));

    expect(config.rule_files).toContain("/etc/prometheus/rules/*.yml");
    expect(config.alerting?.alertmanagers).toEqual([{
      scheme: "http",
      static_configs: [{ targets: ["alertmanager:9093"] }],
    }]);
    expect(jobs.get("berry-api")).toMatchObject({ static_configs: [{ targets: ["api:3000"] }] });
    expect(jobs.get("berry-mem0")).toMatchObject({ static_configs: [{ targets: ["mem0:8010"] }] });
    expect(jobs.get("berry-worker-foreground")).toMatchObject({
      dns_sd_configs: [{ names: ["worker-foreground"], type: "A", port: 3010 }],
    });
    expect(jobs.get("berry-worker-background")).toMatchObject({
      dns_sd_configs: [{ names: ["worker"], type: "A", port: 3010 }],
    });
  });

  it("defines native Compose alerts for every requested incident signal", () => {
    const rules = parse(readFileSync(new URL("prometheus/rules/berry-runtime.yml", deployRoot), "utf8")) as {
      groups?: Array<{ rules?: Array<{ expr?: string }> }>;
    };
    const expressions = (rules.groups ?? []).flatMap((group) => group.rules ?? [])
      .map((rule) => rule.expr ?? "")
      .join("\n");

    for (const metric of [
      "berry_api_turn_admission_duration_seconds_bucket",
      "berry_api_turn_cancellations_total",
      "berry_api_turn_cancellation_signals_total",
      "berry_worker_outbox_dispatch_duration_seconds_bucket",
      "berry_worker_queue_jobs",
      "berry_worker_queue_oldest_waiting_seconds",
      "berry_worker_process_capacity_slots",
      "berry_worker_provider_requests_total",
      "berry_worker_provider_request_duration_seconds_bucket",
      "berry_mem0_request_timeouts_total",
      "berry_mem0_process_start_time_seconds",
      "berry_api_personal_memory_recalls_total",
    ]) {
      expect(expressions, `missing alert expression for ${metric}`).toContain(metric);
    }
    expect(expressions).toContain('absent(up{job="berry-worker-foreground"})');
    expect(expressions).toContain('absent(up{job="berry-worker-background"})');
    expect(expressions).toContain('sum(berry_worker_process_capacity_slots{role="foreground"}) or vector(0)');
    expect(expressions).toContain('berry_worker_queue_jobs{queue="legacy",state="waiting"}');
    expect(expressions).toContain('berry_api_personal_memory_recalls_total{outcome="timeout"}');
    expect(expressions).toContain('berry_api_personal_memory_recalls_total{outcome="unavailable"}');
  });

  it("pins monitoring images and prepares the existing AWS alert topic receiver", () => {
    const compose = readFileSync(new URL("compose.yaml", deployRoot), "utf8");
    const cloudFormation = readFileSync(new URL("aws/berry-single-instance.yaml", deployRoot), "utf8");
    const snsConfig = parse(readFileSync(new URL("prometheus/alertmanager.sns.yml", deployRoot), "utf8")) as {
      receivers?: Array<{ sns_configs?: Array<Record<string, unknown>> }>;
    };

    expect(compose).toContain("prom/prometheus:v3.5.5@sha256:332c2f43e7e389d74d3893b55bb02fbbd684208e681eeb604641d5d769c0fe2a");
    expect(compose).toContain("prom/alertmanager:v0.33.1@sha256:9e082985f56f4c8c9f724e18f2288c6708f472e56a5286b8863d080434ea065d");
    expect(snsConfig.receivers?.[0]?.sns_configs?.[0]).toMatchObject({
      topic_arn: "__BERRY_ALERT_SNS_TOPIC_ARN__",
      send_resolved: true,
      sigv4: { region: "__BERRY_ALERT_SNS_REGION__" },
    });
    expect(cloudFormation).toContain("sns:Publish");
    expect(cloudFormation).toContain("Resource: !Ref AlertTopic");
  });

  it("quarantines structured compaction from the organization chat default", () => {
    const compose = readFileSync(new URL("compose.yaml", deployRoot), "utf8");
    expect(compose).toContain(
      "BERRY_COMPACTION_MODEL: ${BERRY_COMPACTION_MODEL:-canopywave/moonshotai/kimi-k2.6}",
    );
  });
});
