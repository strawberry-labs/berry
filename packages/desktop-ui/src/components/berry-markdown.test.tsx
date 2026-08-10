import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Markdown } from "./berry-markdown.js";

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
});
