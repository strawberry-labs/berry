import { GatewayTimeoutException } from "@nestjs/common";
import { once } from "node:events";
import type { ServerResponse } from "node:http";

/** Own the S3 request and body for exactly the lifetime of the HTTP download. */
export class FileResponseTransfer {
  private readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private body: { destroy?: () => void; cancel?: () => Promise<unknown> } | undefined;
  private readonly closed = () => this.controller.abort(new Error("Download connection closed"));
  private readonly failed = (error: Error) => this.controller.abort(error);
  private readonly aborted = () => {
    const body = this.body;
    this.body = undefined;
    if (body?.destroy) body.destroy();
    else void body?.cancel?.().catch(() => undefined);
  };

  constructor(private readonly response: ServerResponse, private readonly idleMs = 60_000) {
    response.once("close", this.closed);
    response.once("error", this.failed);
    this.signal.addEventListener("abort", this.aborted, { once: true });
    this.touch();
    if (response.destroyed) this.closed();
  }

  track(body: unknown): void {
    this.body = body as typeof this.body;
    if (this.signal.aborted) this.aborted();
    this.signal.throwIfAborted();
    this.touch();
  }

  private touch(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.controller.abort(new GatewayTimeoutException("File transfer stalled. Please retry.")), this.idleMs);
    this.timer.unref();
  }

  async stream(body: AsyncIterable<Uint8Array>): Promise<void> {
    this.signal.throwIfAborted();
    this.response.flushHeaders();
    for await (const chunk of body) {
      this.signal.throwIfAborted();
      this.touch();
      if (!this.response.write(chunk)) await once(this.response, "drain", { signal: this.signal });
    }
    this.signal.throwIfAborted();
    this.response.end();
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.response.removeListener("close", this.closed);
    this.response.removeListener("error", this.failed);
    this.signal.removeEventListener("abort", this.aborted);
    this.aborted();
  }
}
