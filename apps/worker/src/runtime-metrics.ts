const OUTBOX_BUCKETS_SECONDS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60] as const;
const PROVIDER_BUCKETS_SECONDS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 900, 1_800] as const;

type Histogram = { count: number; sum: number; buckets: number[] };
type ProviderSeries = {
  model: string;
  outcome: "success" | "failure" | "cancelled";
  status: string;
  histogram: Histogram;
};
type OutboxSeries = { jobName: string; count: number; histogram: Histogram };
export type WorkerCancellationSignalResult = "received" | "invalid_payload" | "subscriber_error";

/** Process-local counters complementing BullMQ's queue-level gauges. */
export class WorkerRuntimeMetrics {
  readonly #providers = new Map<string, ProviderSeries>();
  readonly #outbox = new Map<string, OutboxSeries>();
  readonly #cancellationSignals = new Map<WorkerCancellationSignalResult, number>();
  #providerRequestsAborted = 0;

  providerRequest(input: Record<string, unknown>): void {
    const model = boundedLabel(input.model, "unknown", 200);
    const outcome = input.outcome === "success" || input.outcome === "cancelled"
      ? input.outcome
      : "failure";
    const status = providerStatus(input.status);
    const key = `${model}\0${outcome}\0${status}`;
    const series = this.#providers.get(key) ?? {
      model,
      outcome,
      status,
      histogram: emptyHistogram(PROVIDER_BUCKETS_SECONDS),
    };
    observe(series.histogram, millisecondsToSeconds(input.latencyMs), PROVIDER_BUCKETS_SECONDS);
    this.#providers.set(key, series);
  }

  outboxDispatch(jobName: string, latencyMs: number | null): void {
    const normalizedName = boundedLabel(jobName, "unknown", 100);
    const series = this.#outbox.get(normalizedName) ?? {
      jobName: normalizedName,
      count: 0,
      histogram: emptyHistogram(OUTBOX_BUCKETS_SECONDS),
    };
    series.count += 1;
    if (latencyMs !== null && Number.isFinite(latencyMs)) {
      observe(series.histogram, Math.max(0, latencyMs) / 1_000, OUTBOX_BUCKETS_SECONDS);
    }
    this.#outbox.set(normalizedName, series);
  }

  cancellationSignal(result: WorkerCancellationSignalResult, abortedRequests = 0): void {
    this.#cancellationSignals.set(result, (this.#cancellationSignals.get(result) ?? 0) + 1);
    this.#providerRequestsAborted += Math.max(0, Math.floor(abortedRequests));
  }

  render(): string {
    const lines = [
      "# HELP berry_worker_outbox_dispatches_total Runtime outbox rows dispatched to BullMQ.",
      "# TYPE berry_worker_outbox_dispatches_total counter",
    ];
    for (const [, series] of sortedEntries(this.#outbox)) {
      lines.push(`berry_worker_outbox_dispatches_total{job_name="${escapeLabel(series.jobName)}"} ${series.count}`);
    }
    lines.push(
      "# HELP berry_worker_outbox_dispatch_duration_seconds Time from outbox creation to BullMQ dispatch.",
      "# TYPE berry_worker_outbox_dispatch_duration_seconds histogram",
    );
    for (const [, series] of sortedEntries(this.#outbox)) {
      appendHistogram(lines, "berry_worker_outbox_dispatch_duration_seconds", { job_name: series.jobName }, series.histogram, OUTBOX_BUCKETS_SECONDS);
    }
    lines.push(
      "# HELP berry_worker_provider_requests_total Provider model requests by model, outcome, and status.",
      "# TYPE berry_worker_provider_requests_total counter",
    );
    for (const [, series] of sortedEntries(this.#providers)) {
      const labels = providerLabels(series);
      lines.push(`berry_worker_provider_requests_total{${renderLabels(labels)}} ${series.histogram.count}`);
    }
    lines.push(
      "# HELP berry_worker_provider_request_duration_seconds Provider model request latency by model, outcome, and status.",
      "# TYPE berry_worker_provider_request_duration_seconds histogram",
    );
    for (const [, series] of sortedEntries(this.#providers)) {
      appendHistogram(lines, "berry_worker_provider_request_duration_seconds", providerLabels(series), series.histogram, PROVIDER_BUCKETS_SECONDS);
    }
    lines.push(
      "# HELP berry_worker_turn_cancellation_signals_total Redis cancellation subscriber results.",
      "# TYPE berry_worker_turn_cancellation_signals_total counter",
    );
    for (const [result, count] of sortedEntries(this.#cancellationSignals)) {
      lines.push(`berry_worker_turn_cancellation_signals_total{result="${escapeLabel(result)}"} ${count}`);
    }
    lines.push(
      "# HELP berry_worker_provider_requests_aborted_total Active provider requests immediately aborted by cancellation signals.",
      "# TYPE berry_worker_provider_requests_aborted_total counter",
      `berry_worker_provider_requests_aborted_total ${this.#providerRequestsAborted}`,
    );
    return `${lines.join("\n")}\n`;
  }
}

export const workerRuntimeMetrics = new WorkerRuntimeMetrics();

function emptyHistogram(buckets: readonly number[]): Histogram {
  return { count: 0, sum: 0, buckets: buckets.map(() => 0) };
}

function observe(histogram: Histogram, value: number, buckets: readonly number[]): void {
  histogram.count += 1;
  histogram.sum += finiteMetric(value);
  for (let index = 0; index < buckets.length; index += 1) {
    if (value <= buckets[index]!) histogram.buckets[index] = (histogram.buckets[index] ?? 0) + 1;
  }
}

function appendHistogram(
  lines: string[],
  name: string,
  labels: Record<string, string>,
  histogram: Histogram,
  buckets: readonly number[],
): void {
  for (let index = 0; index < buckets.length; index += 1) {
    lines.push(`${name}_bucket{${renderLabels({ ...labels, le: String(buckets[index]) })}} ${histogram.buckets[index] ?? 0}`);
  }
  lines.push(
    `${name}_bucket{${renderLabels({ ...labels, le: "+Inf" })}} ${histogram.count}`,
    `${name}_sum{${renderLabels(labels)}} ${finiteMetric(histogram.sum)}`,
    `${name}_count{${renderLabels(labels)}} ${histogram.count}`,
  );
}

function providerLabels(series: ProviderSeries): Record<string, string> {
  return { model: series.model, outcome: series.outcome, status: series.status };
}

function providerStatus(value: unknown): string {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 100 || value > 599) return "unknown";
  return String(value);
}

function millisecondsToSeconds(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) / 1_000 : 0;
}

function boundedLabel(value: unknown, fallback: string, maxLength: number): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, maxLength) : fallback;
}

function renderLabels(labels: Record<string, string>): string {
  return Object.entries(labels).map(([name, value]) => `${name}="${escapeLabel(value)}"`).join(",");
}

function sortedEntries<K extends string, V>(map: ReadonlyMap<K, V>): Array<[K, V]> {
  return [...map.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function finiteMetric(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}
