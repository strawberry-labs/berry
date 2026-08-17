import { TURN_CANCELLATION_CHANNEL } from "@berry/shared";
import { normalizeWorkerRole, sourceRevisionFromEnv } from "@berry/shared";
import { Redis } from "ioredis";
import { workerRuntimeMetrics } from "./runtime-metrics.js";
import { emitWorkerOperationalEvent } from "./operational-telemetry.js";

const RECENT_CANCELLATION_TTL_MS = 5 * 60_000;

export class DurableTurnCancellationError extends Error {
  constructor(readonly runId: string) {
    super("The turn was cancelled by the user");
    this.name = "DurableTurnCancellationError";
  }
}

export class ActiveTurnCancellationRegistry {
  readonly #active = new Map<string, Set<AbortController>>();
  readonly #recent = new Map<string, number>();

  register(runId: string, controller: AbortController): () => void {
    this.#prune();
    if ((this.#recent.get(runId) ?? 0) > Date.now()) {
      controller.abort(new DurableTurnCancellationError(runId));
      return () => undefined;
    }
    const controllers = this.#active.get(runId) ?? new Set<AbortController>();
    controllers.add(controller);
    this.#active.set(runId, controllers);
    return () => {
      controllers.delete(controller);
      if (controllers.size === 0) this.#active.delete(runId);
    };
  }

  cancel(runId: string): number {
    this.#prune();
    this.#recent.set(runId, Date.now() + RECENT_CANCELLATION_TTL_MS);
    const controllers = this.#active.get(runId);
    if (!controllers) return 0;
    let aborted = 0;
    for (const controller of controllers) {
      if (controller.signal.aborted) continue;
      controller.abort(new DurableTurnCancellationError(runId));
      aborted += 1;
    }
    return aborted;
  }

  #prune(): void {
    const now = Date.now();
    for (const [runId, expiresAt] of this.#recent) {
      if (expiresAt <= now) this.#recent.delete(runId);
    }
  }
}

export class TurnCancellationSubscriber {
  readonly #redis: Redis;
  #started = false;

  constructor(
    redisUrl: string,
    private readonly registry: ActiveTurnCancellationRegistry,
  ) {
    this.#redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: null });
    this.#redis.on("message", (channel, payload) => {
      if (channel !== TURN_CANCELLATION_CHANNEL) return;
      try {
        const parsed = JSON.parse(payload) as { runId?: unknown };
        if (typeof parsed.runId !== "string" || !parsed.runId) return;
        const abortedRequests = this.registry.cancel(parsed.runId);
        workerRuntimeMetrics.cancellationSignal("received", abortedRequests);
        emitWorkerOperationalEvent("wait.transition", normalizeWorkerRole(process.env.BERRY_WORKER_ROLE), sourceRevisionFromEnv(process.env), {
          runId: parsed.runId,
          abortedRequests,
          outcome: "cancellation_received",
        });
      } catch {
        workerRuntimeMetrics.cancellationSignal("invalid_payload");
        emitWorkerOperationalEvent("wait.transition", normalizeWorkerRole(process.env.BERRY_WORKER_ROLE), sourceRevisionFromEnv(process.env), {
          outcome: "cancellation_invalid_payload",
        });
      }
    });
    this.#redis.on("error", (_error) => {
      workerRuntimeMetrics.cancellationSignal("subscriber_error");
      emitWorkerOperationalEvent("wait.transition", normalizeWorkerRole(process.env.BERRY_WORKER_ROLE), sourceRevisionFromEnv(process.env), {
        outcome: "cancellation_subscriber_error",
      });
    });
  }

  async start(): Promise<void> {
    if (this.#started) return;
    if (this.#redis.status === "wait") await this.#redis.connect();
    await this.#redis.subscribe(TURN_CANCELLATION_CHANNEL);
    this.#started = true;
  }

  async close(): Promise<void> {
    if (!this.#started) {
      this.#redis.disconnect();
      return;
    }
    await this.#redis.unsubscribe(TURN_CANCELLATION_CHANNEL);
    await this.#redis.quit();
    this.#started = false;
  }
}
