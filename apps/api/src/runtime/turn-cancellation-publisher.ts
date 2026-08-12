import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { TURN_CANCELLATION_CHANNEL } from "@berry/shared";
import { Redis } from "ioredis";
import { apiRuntimeMetrics } from "./runtime-metrics.js";

@Injectable()
export class TurnCancellationPublisher implements OnModuleDestroy {
  readonly #redis: Redis | null;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const redisUrl = env.BERRY_REDIS_URL?.trim() || env.REDIS_URL?.trim();
    this.#redis = redisUrl
      ? new Redis(redisUrl, {
          lazyConnect: true,
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
        })
      : null;
    this.#redis?.on("error", (error) => {
      console.warn(JSON.stringify({
        event: "berry.turn_cancellation.publisher_error",
        code: errorCode(error),
      }));
    });
  }

  async publish(tenantId: string, runId: string): Promise<void> {
    if (!this.#redis) {
      apiRuntimeMetrics.turnCancellationSignal("unconfigured");
      return;
    }
    try {
      if (this.#redis.status === "wait") await this.#redis.connect();
      await this.#redis.publish(TURN_CANCELLATION_CHANNEL, JSON.stringify({ tenantId, runId }));
      apiRuntimeMetrics.turnCancellationSignal("published");
    } catch (error) {
      // The durable database marker remains authoritative. Pub/sub only
      // shortens provider abort latency, so Redis failure must fail open.
      console.warn(JSON.stringify({
        event: "berry.turn_cancellation.publish_failed",
        runId,
        code: errorCode(error),
      }));
      apiRuntimeMetrics.turnCancellationSignal("failed");
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.#redis) return;
    if (this.#redis.status === "ready") await this.#redis.quit();
    else this.#redis.disconnect();
  }
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code.slice(0, 128) : null;
}
