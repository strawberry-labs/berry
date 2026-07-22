import { describe, expect, it } from "vitest";
import { getWebConfig } from "./env.server";
import { filterItems } from "./mentions";
import { IDLE, reduceStream } from "@berry/desktop-ui/components/thread-stream";

describe("web shell state helpers", () => {
  it("filters composer mention rows by value or label", () => {
    const rows = filterItems([
      { id: "skill:review", category: "skills", label: "review", value: "review" },
      { id: "skill:research", category: "skills", label: "research", value: "research" },
    ], "res");
    expect(rows.map((row) => row.id)).toEqual(["skill:research"]);
  });

  it("folds shared AgentStreamEvent deltas into a live assistant message", () => {
    const state = ([
      { kind: "turn.start", turnId: "turn_1" },
      { kind: "message.start", messageId: "msg_1", role: "assistant" },
      { kind: "message.delta", messageId: "msg_1", delta: "Hello", channel: "text" },
      { kind: "tool.start", toolCallId: "tool_1", name: "bash", title: "npm test" },
      { kind: "tool.end", toolCallId: "tool_1", status: "completed", summary: "ok" },
      { kind: "turn.end", turnId: "turn_1", status: "completed" },
    ] as const).reduce(reduceStream, IDLE);

    expect(state.turnActive).toBe(false);
    expect(state.text).toBe("");
    expect(state.timeline[0]).toMatchObject({ kind: "text", text: "Hello" });
    expect(state.timeline[1]).toMatchObject({ kind: "tool", name: "bash", status: "completed", summary: "ok" });
  });

  it("parses deployment mode and platform super-admin fixtures", () => {
    const previous = process.env.DEPLOYMENT_MODE;
    process.env.DEPLOYMENT_MODE = "managed";
    try {
      const config = getWebConfig();
      expect(config.deploymentMode).toBe("managed");
      expect(config.platformTenants.map((tenant) => tenant.name)).toContain("Acme Dedicated");
      expect(config.platformUsage.totalUsageEvents).toBe(493);
    } finally {
      if (previous === undefined) delete process.env.DEPLOYMENT_MODE;
      else process.env.DEPLOYMENT_MODE = previous;
    }
  });
});
