const ADMISSION_BUCKETS_SECONDS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120] as const;
const PERSONAL_MEMORY_BUCKETS_SECONDS = [0.05, 0.1, 0.25, 0.5, 1, 1.5, 2, 5, 10, 30] as const;

export type TurnAdmissionMetricOutcome = "admitted" | "replayed" | "failed";
export type TurnCancellationMetricResult =
  | "active_run"
  | "pending_or_terminal"
  | "no_active_run";
export type TurnCancellationSignalMetricResult = "published" | "failed" | "unconfigured";
export type PersonalMemoryRecallMetricOutcome = "success" | "timeout" | "unavailable";

type Histogram = {
  count: number;
  sum: number;
  buckets: number[];
};

/** Process-local, bounded-cardinality metrics for the API runtime. */
export class ApiRuntimeMetrics {
  readonly #admissions = new Map<TurnAdmissionMetricOutcome, Histogram>();
  readonly #admissionStatuses = new Map<string, number>();
  readonly #cancellations = new Map<TurnCancellationMetricResult, number>();
  readonly #cancellationSignals = new Map<TurnCancellationSignalMetricResult, number>();
  readonly #personalMemoryRecalls = new Map<PersonalMemoryRecallMetricOutcome, Histogram>();

  turnAdmission(outcome: TurnAdmissionMetricOutcome, durationMs: number, status: number | null): void {
    observeHistogram(
      this.#admissions,
      outcome,
      Math.max(0, durationMs) / 1_000,
      ADMISSION_BUCKETS_SECONDS,
    );
    const statusLabel = status === null
      ? outcome === "failed" ? "unknown" : "200"
      : boundedStatus(status);
    increment(this.#admissionStatuses, `${outcome}\0${statusLabel}`);
  }

  turnCancellation(result: TurnCancellationMetricResult): void {
    increment(this.#cancellations, result);
  }

  turnCancellationSignal(result: TurnCancellationSignalMetricResult): void {
    increment(this.#cancellationSignals, result);
  }

  personalMemoryRecall(outcome: PersonalMemoryRecallMetricOutcome, durationMs: number): void {
    observeHistogram(
      this.#personalMemoryRecalls,
      outcome,
      Math.max(0, durationMs) / 1_000,
      PERSONAL_MEMORY_BUCKETS_SECONDS,
    );
  }

  render(): string {
    const lines = [
      "# HELP berry_api_turn_admissions_total Durable turn admission attempts by outcome and HTTP status.",
      "# TYPE berry_api_turn_admissions_total counter",
    ];
    for (const [key, count] of sortedEntries(this.#admissionStatuses)) {
      const [outcome = "unknown", status = "unknown"] = key.split("\0");
      lines.push(`berry_api_turn_admissions_total{outcome="${escapeLabel(outcome)}",status="${escapeLabel(status)}"} ${count}`);
    }
    lines.push(
      "# HELP berry_api_turn_admission_duration_seconds Time from POST /turns handling to durable admission result.",
      "# TYPE berry_api_turn_admission_duration_seconds histogram",
    );
    for (const [outcome, histogram] of sortedEntries(this.#admissions)) {
      appendHistogram(lines, "berry_api_turn_admission_duration_seconds", { outcome }, histogram, ADMISSION_BUCKETS_SECONDS);
    }
    lines.push(
      "# HELP berry_api_turn_cancellations_total Idempotent durable cancellation results.",
      "# TYPE berry_api_turn_cancellations_total counter",
    );
    for (const [result, count] of sortedEntries(this.#cancellations)) {
      lines.push(`berry_api_turn_cancellations_total{result="${escapeLabel(result)}"} ${count}`);
    }
    lines.push(
      "# HELP berry_api_turn_cancellation_signals_total Immediate Redis cancellation signal outcomes.",
      "# TYPE berry_api_turn_cancellation_signals_total counter",
    );
    for (const [result, count] of sortedEntries(this.#cancellationSignals)) {
      lines.push(`berry_api_turn_cancellation_signals_total{result="${escapeLabel(result)}"} ${count}`);
    }
    lines.push(
      "# HELP berry_api_personal_memory_recalls_total Personal-memory recall attempts by caller-observed outcome.",
      "# TYPE berry_api_personal_memory_recalls_total counter",
    );
    for (const [outcome, histogram] of sortedEntries(this.#personalMemoryRecalls)) {
      lines.push(`berry_api_personal_memory_recalls_total{outcome="${escapeLabel(outcome)}"} ${histogram.count}`);
    }
    lines.push(
      "# HELP berry_api_personal_memory_recall_duration_seconds Caller-observed personal-memory recall latency.",
      "# TYPE berry_api_personal_memory_recall_duration_seconds histogram",
    );
    for (const [outcome, histogram] of sortedEntries(this.#personalMemoryRecalls)) {
      appendHistogram(
        lines,
        "berry_api_personal_memory_recall_duration_seconds",
        { outcome },
        histogram,
        PERSONAL_MEMORY_BUCKETS_SECONDS,
      );
    }
    return `${lines.join("\n")}\n`;
  }
}

export const apiRuntimeMetrics = new ApiRuntimeMetrics();

function observeHistogram<K extends string>(
  store: Map<K, Histogram>,
  key: K,
  value: number,
  buckets: readonly number[],
): void {
  const histogram = store.get(key) ?? { count: 0, sum: 0, buckets: buckets.map(() => 0) };
  histogram.count += 1;
  histogram.sum += finiteMetric(value);
  for (let index = 0; index < buckets.length; index += 1) {
    if (value <= buckets[index]!) histogram.buckets[index] = (histogram.buckets[index] ?? 0) + 1;
  }
  store.set(key, histogram);
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

function increment<K extends string>(store: Map<K, number>, key: K): void {
  store.set(key, (store.get(key) ?? 0) + 1);
}

function sortedEntries<K extends string, V>(map: ReadonlyMap<K, V>): Array<[K, V]> {
  return [...map.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function boundedStatus(status: number): string {
  return Number.isInteger(status) && status >= 100 && status <= 599 ? String(status) : "unknown";
}

function renderLabels(labels: Record<string, string>): string {
  return Object.entries(labels).map(([name, value]) => `${name}="${escapeLabel(value)}"`).join(",");
}

function finiteMetric(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}
