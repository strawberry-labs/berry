export class Mem0RuntimeMetrics {
  readonly #startTimeSeconds: number;
  readonly #requestErrors = new Map<string, number>();
  readonly #poolErrors = new Map<string, number>();
  #activeRequests = 0;
  #requestCount = 0;
  #requestSuccesses = 0;
  #requestTimeouts = 0;
  #requestDurationSeconds = 0;

  constructor(startedAtMs = Date.now()) {
    this.#startTimeSeconds = startedAtMs / 1_000;
  }

  requestStarted(): number {
    this.#activeRequests += 1;
    this.#requestCount += 1;
    return performance.now();
  }

  requestSucceeded(startedAt: number): void {
    this.#requestSuccesses += 1;
    this.finishRequest(startedAt);
  }

  requestFailed(error: unknown, status: number, startedAt: number): void {
    const category = requestErrorCategory(error, status);
    this.#requestErrors.set(category, (this.#requestErrors.get(category) ?? 0) + 1);
    if (category === "timeout") this.#requestTimeouts += 1;
    this.finishRequest(startedAt);
  }

  postgresPoolFailed(code: string): void {
    const safeCode = sanitizeCode(code);
    this.#poolErrors.set(safeCode, (this.#poolErrors.get(safeCode) ?? 0) + 1);
  }

  render(): string {
    const lines = [
      "# HELP berry_mem0_up Whether the Mem0 HTTP process is serving metrics.",
      "# TYPE berry_mem0_up gauge",
      "berry_mem0_up 1",
      "# HELP berry_mem0_process_start_time_seconds Unix timestamp when this Mem0 process started.",
      "# TYPE berry_mem0_process_start_time_seconds gauge",
      `berry_mem0_process_start_time_seconds ${finiteMetric(this.#startTimeSeconds)}`,
      "# HELP berry_mem0_active_requests Requests currently being handled by Mem0.",
      "# TYPE berry_mem0_active_requests gauge",
      `berry_mem0_active_requests ${this.#activeRequests}`,
      "# HELP berry_mem0_requests_total Requests handled by Mem0, excluding metrics scrapes.",
      "# TYPE berry_mem0_requests_total counter",
      `berry_mem0_requests_total ${this.#requestCount}`,
      "# HELP berry_mem0_request_successes_total Successful Mem0 requests.",
      "# TYPE berry_mem0_request_successes_total counter",
      `berry_mem0_request_successes_total ${this.#requestSuccesses}`,
      "# HELP berry_mem0_request_errors_total Failed Mem0 requests grouped into bounded categories.",
      "# TYPE berry_mem0_request_errors_total counter",
    ];
    for (const [category, count] of [...this.#requestErrors].sort(([left], [right]) => left.localeCompare(right))) {
      lines.push(`berry_mem0_request_errors_total{category="${category}"} ${count}`);
    }
    lines.push(
      "# HELP berry_mem0_request_timeouts_total Mem0 requests that failed due to a timeout.",
      "# TYPE berry_mem0_request_timeouts_total counter",
      `berry_mem0_request_timeouts_total ${this.#requestTimeouts}`,
      "# HELP berry_mem0_request_duration_seconds Aggregate duration of completed Mem0 requests.",
      "# TYPE berry_mem0_request_duration_seconds summary",
      `berry_mem0_request_duration_seconds_sum ${finiteMetric(this.#requestDurationSeconds)}`,
      `berry_mem0_request_duration_seconds_count ${this.#requestSuccesses + total(this.#requestErrors)}`,
      "# HELP berry_mem0_postgres_pool_errors_total PostgreSQL idle-client errors discarded by the Mem0 pool.",
      "# TYPE berry_mem0_postgres_pool_errors_total counter",
    );
    for (const [code, count] of [...this.#poolErrors].sort(([left], [right]) => left.localeCompare(right))) {
      lines.push(`berry_mem0_postgres_pool_errors_total{code="${code}"} ${count}`);
    }
    return `${lines.join("\n")}\n`;
  }

  private finishRequest(startedAt: number): void {
    this.#activeRequests = Math.max(0, this.#activeRequests - 1);
    this.#requestDurationSeconds += Math.max(0, performance.now() - startedAt) / 1_000;
  }
}

function requestErrorCategory(error: unknown, status: number): "timeout" | "client" | "server" | "unknown" {
  if (isTimeoutFailure(error)) return "timeout";
  if (status >= 500) return "server";
  if (status >= 400) return "client";
  return "unknown";
}

function isTimeoutFailure(error: unknown): boolean {
  const visited = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 8 && current && !visited.has(current); depth += 1) {
    visited.add(current);
    if (current instanceof Error) {
      if (/timeout/i.test(current.name) || /timed?\s*out/i.test(current.message)) return true;
    }
    if (typeof current === "object") {
      const record = current as Record<string, unknown>;
      const code = typeof record.code === "string" ? record.code.toUpperCase() : "";
      if (code === "ETIMEDOUT" || code.includes("TIMEOUT")) return true;
      current = record.cause;
      continue;
    }
    break;
  }
  return false;
}

function sanitizeCode(code: string): string {
  return code.replace(/[^A-Z0-9_-]/gi, "").slice(0, 64).toUpperCase() || "UNKNOWN";
}

function total(values: Map<string, number>): number {
  let result = 0;
  for (const value of values.values()) result += value;
  return result;
}

function finiteMetric(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}
