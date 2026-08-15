import { describe, expect, it } from "vitest";
import { IDLE } from "@berry/desktop-ui/components/thread-stream";
import { planProgressFromConversation, planProgressFromLiveStream } from "./plan-progress-pill";

describe("plan progress terminal state", () => {
  it("stops the active-step spinner when a todo tool is cancelled", () => {
    const plan = planProgressFromConversation([], {
      ...IDLE,
      turnActive: false,
      endStatus: "cancelled",
      timeline: [{
        kind: "tool",
        toolCallId: "todo_1",
        name: "todo_write",
        status: "cancelled",
        args: {
          todos: [
            { content: "Review the files", status: "completed" },
            { content: "Write the report", status: "in_progress" },
          ],
        },
        startedAt: 0,
      }],
    });

    expect(plan).toMatchObject({
      status: "failed",
      current: 2,
      total: 2,
      items: [
        { content: "Review the files", status: "completed" },
        { content: "Write the report", status: "failed" },
      ],
    });
  });

  it("updates a live plan without rescanning persisted history", () => {
    const fallback = { items: [{ content: "Old", status: "completed" as const }], current: 1, total: 1, status: "completed" as const };
    expect(planProgressFromLiveStream({
      ...IDLE,
      timeline: [{
        kind: "tool",
        toolCallId: "todo_live",
        name: "todo_write",
        status: "running",
        args: { todos: [{ content: "New", status: "in_progress" }] },
        startedAt: 0,
      }],
    }, fallback)).toMatchObject({ items: [{ content: "New" }] });
  });
});
