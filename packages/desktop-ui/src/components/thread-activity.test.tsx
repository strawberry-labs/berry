import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActivityNote, ToolFlow, type ActivityTool } from "./thread-activity";
import { settleRunningActivityTools } from "./thread-stream";

describe("compaction activity", () => {
  it("renders live compaction as an accessible shimmering status row", () => {
    const html = renderToStaticMarkup(
      <ActivityNote note="compacting">Context auto-compacting</ActivityNote>,
    );

    expect(html).toContain('data-session-note="compacting"');
    expect(html).toContain('role="status"');
    expect(html).toContain("berry-shimmer");
    expect(html).toContain("Context auto-compacting");
  });

  it("renders completed compaction as the normal timeline divider", () => {
    const html = renderToStaticMarkup(
      <ActivityNote note="compacted">Context compacted from 224792 to 16161 tokens.</ActivityNote>,
    );

    expect(html).toContain('data-session-note="compacted"');
    expect(html).not.toContain('role="status"');
    expect(html).not.toContain("berry-shimmer");
  });
});

describe("terminal tool labels", () => {
  it("removes shimmer from every shared tool-row family, including nested sub-agent tools", () => {
    const running = (name: string, args: Record<string, unknown> = {}): ActivityTool => ({
      toolCallId: `tool-${name}`,
      name,
      status: "running",
      args,
      startedAt: 0,
    });
    const tools: ActivityTool[] = [
      running("bash", { command: "printf done" }),
      running("read", { path: "/workspace/input.txt" }),
      running("write", { path: "/workspace/output.txt" }),
      running("grep", { pattern: "needle", path: "/workspace" }),
      running("skill", { name: "memo" }),
      running("ask_user_question", { question: "Continue?" }),
      running("goal", { goal: "Finish" }),
      running("session_context", { query: "Earlier work" }),
      running("todo_write", { todos: [{ content: "Finish", status: "in_progress" }] }),
      running("mcp__BerryCrawl__screenshot", { url: "https://example.com" }),
      {
        ...running("task", { description: "Inspect files" }),
        children: [running("inspect_images", { question: "What is visible?" })],
      },
    ];

    const html = renderToStaticMarkup(
      <ToolFlow tools={settleRunningActivityTools(tools, "failed")} />,
    );

    expect(html).not.toContain("berry-shimmer");
    expect(html).toContain("Failed");
  });
});
