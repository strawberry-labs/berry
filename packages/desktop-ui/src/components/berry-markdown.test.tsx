import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { DirectedText, Markdown, scheduleIdleWork } from "./berry-markdown.js";

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

describe("Markdown direction (H-047)", () => {
  /** The opening tag of the element whose text starts with `text`. */
  const tagBefore = (html: string, text: string) => {
    const at = html.indexOf(`>${text}`);
    if (at < 0) throw new Error(`Missing ${text}`);
    return html.slice(html.lastIndexOf("<", at), at + 1);
  };
  const arabic = [
    "تعمل منصة Berry مع Microsoft 365 لتلخيص الملفات.",
    "",
    "- يدعم ملفات PDF وDOCX وXLSX",
    "- Microsoft Teams and SharePoint",
    "",
    "> ملاحظة: لا تشارك مفتاح API مع أي شخص.",
    "",
    "استخدم الأداة `persist_artifact` لحفظ الملف [هنا](https://example.com/help).",
    "",
    "```python",
    "total = price * 2",
    "```",
    "",
    "This English paragraph mentions منصة Berry once and stays left-to-right.",
  ].join("\n");

  it("sets the message direction and marks only blocks that differ from it", () => {
    const html = renderToStaticMarkup(<Markdown>{arabic}</Markdown>);
    expect(html).toMatch(/^<div dir="rtl"/);
    expect(tagBefore(html, "This English paragraph")).toMatch(/^<p .*dir="ltr"/);
    expect(tagBefore(html, "Microsoft Teams")).toMatch(/^<li (?=.*dir="ltr")(?=.*list-inside)/);
    expect(tagBefore(html, "يدعم")).not.toContain("dir=");
    expect(tagBefore(html, "تعمل منصة")).not.toContain("dir=");
    expect(tagBefore(html, "persist_artifact")).toMatch(/^<code dir="ltr"/);
    expect(html).toMatch(/<div dir="ltr" class="group relative my-4/);
    expect(html).toContain('dir="auto" target="_blank"');
    expect(html).toContain("border-s-2");
    expect(html).not.toMatch(/\b(?:pl-[0-9]|border-l-2|text-left)\b/);
  });

  it("leaves an English answer left-to-right without per-block attributes", () => {
    const html = renderToStaticMarkup(<Markdown>{"Plain answer with a list:\n\n- one\n- two"}</Markdown>);
    expect(html).toMatch(/^<div dir="ltr"/);
    expect(html).not.toMatch(/<(?:p|li|ul) dir=/);
  });

  it("directs each line of the live surface the same way", () => {
    const live = renderToStaticMarkup(<Markdown streaming>{[
      "تعمل منصة Berry مع Microsoft 365 لتلخيص الملفات.",
      "",
      "Berry Workspace هو المكان الذي تُحفظ فيه ملفات المشروع.",
      "",
      "This English line stays left-to-right.",
    ].join("\n")}</Markdown>);
    expect(live).toMatch(/<div data-markdown-live="true" dir="rtl"/);
    expect(live).toContain('<div data-markdown-line="">Berry Workspace');
    expect(live).toContain('<div data-markdown-line="" dir="ltr">This English line');
    // Mostly English overall: the message turns left-to-right and the Arabic
    // line keeps its own direction.
    const english = renderToStaticMarkup(<Markdown streaming>{"Berry Workspace هو المكان الذي تُحفظ فيه ملفات المشروع.\n\nThis English line stays left-to-right, as written."}</Markdown>);
    expect(english).toMatch(/<div data-markdown-live="true" dir="ltr"/);
    expect(english).toContain('<div data-markdown-line="" dir="rtl">Berry Workspace');
  });

  it("directs submitted prompts line by line", () => {
    const html = renderToStaticMarkup(<DirectedText text={"اكتب ملخصاً قصيراً عن منصة Berry\nPlease keep it short."} />);
    expect(html).toMatch(/^<span dir="rtl" class="block whitespace-pre-wrap">/);
    expect(html).toContain('<span dir="ltr" class="block">Please keep it short.</span>');
  });
});
