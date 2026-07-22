import { describe, expect, it } from "vitest";

import { dequeueRollQueue, latestTurnAction, type ActivityTool } from "./thread-activity";

const tool = (overrides: Partial<ActivityTool> & Pick<ActivityTool, "toolCallId" | "name">): ActivityTool => ({
  status: "completed",
  startedAt: 0,
  ...overrides,
});

describe("dequeueRollQueue", () => {
  it("skips a stale pending roll item when a newer item is queued", () => {
    const { next, rest } = dequeueRollQueue(
      [
        { id: "old", queuedAt: 0 },
        { id: "new", queuedAt: 200 },
      ],
      251,
    );

    expect(next?.id).toBe("new");
    expect(rest).toEqual([]);
  });

  it("keeps the pending roll item until it is stale or replaceable", () => {
    expect(dequeueRollQueue([{ id: "old", queuedAt: 0 }, { id: "new", queuedAt: 200 }], 200).next?.id).toBe("old");
    expect(dequeueRollQueue([{ id: "only", queuedAt: 0 }], 1000).next?.id).toBe("only");
  });
});

describe("latestTurnAction", () => {
  it("uses the newest subagent child action while the subagent is running", () => {
    const action = latestTurnAction([
      tool({
        toolCallId: "parent",
        name: "task",
        status: "running",
        args: { description: "Investigate the workspace" },
        children: [
          tool({
            toolCallId: "child-read",
            name: "read_file",
            args: { path: "/repo/README.md" },
          }),
        ],
      }),
    ]);

    expect(action?.key).toBe("SubAgent:Reading:child-read:/repo/README.md");
  });

  it("falls back to the subagent task description before child tools exist", () => {
    const action = latestTurnAction([
      tool({
        toolCallId: "parent",
        name: "task",
        status: "running",
        args: { description: "Investigate the workspace" },
      }),
    ]);

    expect(action?.key).toBe("task:parent");
  });
});
