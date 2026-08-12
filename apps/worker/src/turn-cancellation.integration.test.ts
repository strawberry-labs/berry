import { randomUUID } from "node:crypto";
import { TURN_CANCELLATION_CHANNEL } from "@berry/shared";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ActiveTurnCancellationRegistry,
  DurableTurnCancellationError,
  TurnCancellationSubscriber,
} from "./turn-cancellation.js";

const redisUrl = process.env.BERRY_TEST_REDIS_URL?.trim();
const integration = redisUrl ? describe : describe.skip;

integration("turn cancellation Redis signal", () => {
  const registry = new ActiveTurnCancellationRegistry();
  let subscriber: TurnCancellationSubscriber;
  let publisher: Redis;

  beforeAll(async () => {
    subscriber = new TurnCancellationSubscriber(redisUrl!, registry);
    publisher = new Redis(redisUrl!, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    await Promise.all([subscriber.start(), publisher.connect()]);
  });

  afterAll(async () => {
    await subscriber.close();
    await publisher.quit();
  });

  it("aborts a registered provider request immediately after publication", async () => {
    const runId = randomUUID();
    const controller = new AbortController();
    registry.register(runId, controller);
    const aborted = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Cancellation signal was not received")), 2_000);
      timeout.unref?.();
      controller.signal.addEventListener("abort", () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
    });

    await publisher.publish(TURN_CANCELLATION_CHANNEL, JSON.stringify({
      tenantId: "00000000-0000-7000-8000-000000000001",
      runId,
    }));
    await aborted;

    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBeInstanceOf(DurableTurnCancellationError);
    expect(controller.signal.reason).toMatchObject({ runId });
  });
});
