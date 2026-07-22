import { describe, expect, it } from "vitest";
import { aggregateDailyUsage, processUsageRollupJob, type UsageEventRecord } from "./usage-rollups.js";

const tenantId = "00000000-0000-7000-8000-000000000001";

const events: UsageEventRecord[] = [
  {
    tenantId,
    userId: "00000000-0000-7000-8000-000000000011",
    departmentId: "00000000-0000-7000-8000-000000000021",
    workspaceId: "00000000-0000-7000-8000-000000000031",
    agentId: "agent-code-review",
    sandboxId: null,
    feature: "model",
    provider: "openai",
    model: "gpt-test",
    status: "completed",
    tokensIn: 10,
    tokensOut: 20,
    tokensCached: 3,
    costRawMicros: "100",
    costBilledMicros: "150",
    latencyMs: 40,
    ttftMs: 10,
    ts: new Date("2026-07-10T03:15:00.000Z"),
  },
  {
    tenantId,
    userId: "00000000-0000-7000-8000-000000000011",
    departmentId: "00000000-0000-7000-8000-000000000021",
    workspaceId: "00000000-0000-7000-8000-000000000031",
    agentId: "agent-code-review",
    sandboxId: null,
    feature: "model",
    provider: "openai",
    model: "gpt-test",
    status: "completed",
    tokensIn: 5,
    tokensOut: 7,
    tokensCached: 0,
    costRawMicros: 25,
    costBilledMicros: 35n,
    latencyMs: null,
    ttftMs: 8,
    ts: new Date("2026-07-10T23:59:59.000Z"),
  },
  {
    tenantId,
    userId: null,
    departmentId: null,
    workspaceId: null,
    agentId: null,
    sandboxId: "sandbox-1",
    feature: "sandbox",
    provider: null,
    model: null,
    status: "failed",
    tokensIn: 0,
    tokensOut: 0,
    tokensCached: 0,
    costRawMicros: "0",
    costBilledMicros: "0",
    latencyMs: 300,
    ttftMs: null,
    ts: new Date("2026-07-11T00:00:00.000Z"),
  },
];

describe("usage rollups", () => {
  it("aggregates usage events into stable UTC day/dimension rows", () => {
    const rollups = aggregateDailyUsage(events);

    expect(rollups).toHaveLength(2);
    expect(rollups[0]).toMatchObject({
      tenantId,
      userId: "00000000-0000-7000-8000-000000000011",
      departmentId: "00000000-0000-7000-8000-000000000021",
      workspaceId: "00000000-0000-7000-8000-000000000031",
      agentId: "agent-code-review",
      bucketStart: new Date("2026-07-10T00:00:00.000Z"),
      bucketEnd: new Date("2026-07-11T00:00:00.000Z"),
      feature: "model",
      provider: "openai",
      model: "gpt-test",
      status: "completed",
      requestCount: 2,
      tokensIn: 15,
      tokensOut: 27,
      tokensCached: 3,
      costRawMicros: "125",
      costBilledMicros: "185",
      latencyMsTotal: 40,
      latencyMsCount: 1,
      ttftMsTotal: 18,
      ttftMsCount: 2,
      sourceEventMinTs: new Date("2026-07-10T03:15:00.000Z"),
      sourceEventMaxTs: new Date("2026-07-10T23:59:59.000Z"),
    });
    expect(rollups[1]?.feature).toBe("sandbox");
  });

  it("loads, aggregates, and persists rollups through the repository seam", async () => {
    const persisted: unknown[] = [];
    await expect(processUsageRollupJob({
      tenantId,
      from: "2026-07-10T00:00:00.000Z",
      to: "2026-07-12T00:00:00.000Z",
      granularity: "day",
    }, {
      usage: {
        async listUsageEvents(input) {
          expect(input).toEqual({
            tenantId,
            from: new Date("2026-07-10T00:00:00.000Z"),
            to: new Date("2026-07-12T00:00:00.000Z"),
          });
          return events;
        },
        async upsertUsageRollups(rollups) {
          persisted.push(...rollups);
        },
      },
    })).resolves.toEqual({ rollups: 2, events: 3 });
    expect(persisted).toHaveLength(2);
  });

  it("rejects inverted windows", async () => {
    await expect(processUsageRollupJob({
      tenantId,
      from: "2026-07-12T00:00:00.000Z",
      to: "2026-07-10T00:00:00.000Z",
      granularity: "day",
    }, {
      usage: {
        async listUsageEvents() {
          throw new Error("should not load");
        },
        async upsertUsageRollups() {},
      },
    })).rejects.toThrow("from < to");
  });
});
