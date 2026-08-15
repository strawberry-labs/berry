import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { Markdown, scheduleIdleWork } from "./berry-markdown.js";

describe("Markdown math", () => {
  it("renders inline and display LaTeX with KaTeX", () => {
    const html = renderToStaticMarkup(
      <Markdown>{"Inline: $E = mc^2$\n\n$$\n\\int_0^1 x^2 \\, dx\n$$"}</Markdown>,
    );

    expect(html).toContain("katex");
    expect(html).toContain("katex-display");
    expect(html).toContain("<math");
    expect(html).not.toContain("$E = mc^2$");
  });

  it("leaves incomplete streamed inline math readable until its delimiter arrives", () => {
    const html = renderToStaticMarkup(<Markdown streaming>{"Calculating $E = mc"}</Markdown>);

    expect(html).toContain("Calculating $E = mc");
    expect(html).not.toContain("katex-error");
  });

  it("uses the cheap live surface and restores full markdown after settling", () => {
    const live = renderToStaticMarkup(<Markdown streaming>{"# Live answer\n\n```ts\nconst value = 1;"}</Markdown>);
    expect(live).toContain('data-markdown-live="true"');
    expect(live).toContain("# Live answer");
    expect(live).not.toContain("const value = 1;\n```");
    expect(live).not.toContain("<h1");
    expect(live).not.toContain("data-shiki-token");

    const settled = renderToStaticMarkup(<Markdown>{"# Settled answer"}</Markdown>);
    expect(settled).toContain("<h1");
    expect(settled).not.toContain('data-markdown-live="true"');
  });

  it("cancels idle highlighting work when a code revision is abandoned", () => {
    vi.useFakeTimers();
    try {
      const work = vi.fn();
      const cancel = scheduleIdleWork(work);
      cancel();
      vi.runAllTimers();
      expect(work).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
