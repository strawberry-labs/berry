/**
 * Match DeepSeek Harness session-stats: request time includes TTFT, decoding
 * runs from the first nonempty output delta to request completion. Tool
 * execution happens outside this timer. Only successful calls publish it.
 */
export class ModelOutputTimer {
  private readonly startedAt: number;
  private firstOutputAt: number | undefined;
  private outputEvents = 0;

  constructor(private readonly now: () => number = () => performance.now()) {
    this.startedAt = this.now();
  }

  output(nonempty: boolean): void {
    if (!nonempty) return;
    this.outputEvents += 1;
    if (this.firstOutputAt === undefined) this.firstOutputAt = this.now();
  }

  finish(): { requestMs: number; firstTokenMs?: number; decodeMs?: number } {
    const endedAt = this.now();
    const requestMs = Math.max(0, endedAt - this.startedAt);
    if (this.firstOutputAt === undefined) return { requestMs };
    const firstTokenMs = Math.max(0, this.firstOutputAt - this.startedAt);
    const decodeMs = Math.max(0, endedAt - this.firstOutputAt);
    return { requestMs, firstTokenMs, ...(decodeMs > 0 && this.outputEvents > 1 ? { decodeMs } : {}) };
  }
}
