import { describe, expect, it } from "vitest";
import { IDLE } from "@berry/desktop-ui/components/thread-stream";
import { planProgressFromConversation } from "./plan-progress-pill";

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
});
