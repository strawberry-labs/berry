import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActivityNote } from "./thread-activity";

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
