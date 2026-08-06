import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TaskRouteState } from "./task-route-state";

describe("TaskRouteState", () => {
  it("renders a complete recovery card for a failed task", () => {
    const html = renderToStaticMarkup(
      <TaskRouteState state="failed" onRetry={vi.fn()} onHome={vi.fn()} />,
    );

    expect(html).toContain("Conversation unavailable");
    expect(html).toContain("Retry");
    expect(html).toContain("Back to chats");
    expect(html).toContain("--berry-card-bg");
  });

  it("offers restore only for a deleted task", () => {
    const deleted = renderToStaticMarkup(
      <TaskRouteState state="deleted" onRetry={vi.fn()} onHome={vi.fn()} onRestore={vi.fn()} />,
    );
    const forbidden = renderToStaticMarkup(
      <TaskRouteState state="forbidden" onRetry={vi.fn()} onHome={vi.fn()} />,
    );

    expect(deleted).toContain("Restore conversation");
    expect(forbidden).not.toContain("Restore conversation");
  });
});
