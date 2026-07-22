import { describe, expect, it } from "vitest";
import { BullMqBerryQueueClient } from "./bullmq.js";

describe("BullMqBerryQueueClient", () => {
  it("enqueues typed jobs with retry defaults", async () => {
    const added: unknown[] = [];
    const queue = {
      async add(name: string, payload: unknown, options: unknown) {
        added.push({ name, payload, options });
        return { id: "job_1" };
      },
      async close() {},
    };
    const client = new BullMqBerryQueueClient(queue as never);

    await expect(client.enqueue("usage.rollup", {
      tenantId: "00000000-0000-7000-8000-000000000001",
      from: "2026-07-10T00:00:00.000Z",
      to: "2026-07-11T00:00:00.000Z",
      granularity: "day",
    })).resolves.toEqual({ id: "job_1", name: "usage.rollup" });

    expect(added).toEqual([
      {
        name: "usage.rollup",
        payload: {
          tenantId: "00000000-0000-7000-8000-000000000001",
          from: "2026-07-10T00:00:00.000Z",
          to: "2026-07-11T00:00:00.000Z",
          granularity: "day",
        },
        options: expect.objectContaining({ attempts: 3, removeOnComplete: 1_000, removeOnFail: 5_000 }),
      },
    ]);
  });
});
