import { describe, expect, it } from "vitest";
import { advanceMarkdownStream, clearMarkdownCache, parseMarkdown, parseMarkdownUncached, type MarkdownBlock, type MarkdownStreamState } from "./parse";

/** Drops hashes so assertions read like the model. */
function shape(blocks: readonly MarkdownBlock[]): unknown {
  return JSON.parse(JSON.stringify(blocks, (key, value: unknown) => (key === "hash" ? undefined : value)));
}

function blocksOf(text: string) {
  return parseMarkdown(text).blocks;
}

describe("parseMarkdown", () => {
  it("parses headings with levels and inline content", () => {
    expect(shape(blocksOf("# Title\n\n### Sub *part*\n\nBody"))).toEqual([
      { type: "heading", level: 1, children: [{ type: "text", value: "Title" }] },
      { type: "heading", level: 3, children: [{ type: "text", value: "Sub " }, { type: "emphasis", children: [{ type: "text", value: "part" }] }] },
      { type: "paragraph", children: [{ type: "text", value: "Body" }] },
    ]);
  });

  it("parses nested and ordered lists", () => {
    const [list, ordered] = blocksOf("- one\n  - nested\n- two\n\n3. three\n4. four");
    expect(list?.type).toBe("list");
    if (list?.type !== "list") return;
    expect(list.ordered).toBe(false);
    expect(list.items).toHaveLength(2);
    const nested = list.items[0]?.children[1];
    expect(nested?.type).toBe("list");
    if (nested?.type === "list") expect(shape(nested.items[0]?.children ?? [])).toEqual([{ type: "paragraph", children: [{ type: "text", value: "nested" }] }]);
    expect(ordered).toMatchObject({ type: "list", ordered: true, start: 3 });
  });

  it("parses GFM task lists", () => {
    const [list] = blocksOf("- [x] done\n- [ ] todo\n- plain");
    expect(list?.type === "list" ? list.items.map((item) => item.checked) : null).toEqual([true, false, null]);
  });

  it("parses GFM tables with alignment and inline cells", () => {
    expect(shape(blocksOf("| Name | Size |\n|:--|--:|\n| `a.ts` | **2** |\n| b |"))).toEqual([
      {
        type: "table",
        align: ["left", "right"],
        header: [[{ type: "text", value: "Name" }], [{ type: "text", value: "Size" }]],
        rows: [
          [[{ type: "inlineCode", value: "a.ts" }], [{ type: "strong", children: [{ type: "text", value: "2" }] }]],
          [[{ type: "text", value: "b" }], []],
        ],
      },
    ]);
  });

  it("parses fenced code with a language", () => {
    expect(shape(blocksOf("```ts title=x\nconst a = 1;\n```"))).toEqual([{ type: "code", lang: "ts", meta: "title=x", value: "const a = 1;" }]);
  });

  it("parses inline code, links, images, breaks and strikethrough", () => {
    expect(shape(blocksOf("Run `pnpm i` see [docs](https://berry.dev \"Docs\") ~~old~~  \n![logo](https://x.dev/a.png)"))).toEqual([
      {
        type: "paragraph",
        children: [
          { type: "text", value: "Run " },
          { type: "inlineCode", value: "pnpm i" },
          { type: "text", value: " see " },
          { type: "link", url: "https://berry.dev", title: "Docs", children: [{ type: "text", value: "docs" }] },
          { type: "text", value: " " },
          { type: "delete", children: [{ type: "text", value: "old" }] },
          { type: "break" },
          { type: "image", url: "https://x.dev/a.png", alt: "logo", title: null },
        ],
      },
    ]);
  });

  it("resolves reference links and autolinks literals", () => {
    const [paragraph] = blocksOf("See [the guide][g] and www.example.com\n\n[g]: https://example.com/guide");
    expect(paragraph?.type === "paragraph" ? paragraph.children.filter((child) => child.type === "link").map((child) => child.type === "link" && child.url) : null)
      .toEqual(["https://example.com/guide", "http://www.example.com"]);
  });

  it("parses math, blockquotes, rules and html as text", () => {
    expect(shape(blocksOf("$$\nx^2\n$$\n\n> quote\n\n---\n\n<div>hi</div>\n\nInline $a+b$ math"))).toEqual([
      { type: "math", value: "x^2" },
      { type: "blockquote", children: [{ type: "paragraph", children: [{ type: "text", value: "quote" }] }] },
      { type: "thematicBreak" },
      { type: "html", value: "<div>hi</div>" },
      { type: "paragraph", children: [{ type: "text", value: "Inline " }, { type: "inlineMath", value: "a+b" }, { type: "text", value: " math" }] },
    ]);
  });

  it("keeps an unterminated code fence as code while streaming", () => {
    const blocks = blocksOf("Intro\n\n```python\ndef f():\n\n    return 1");
    expect(shape(blocks)).toEqual([
      { type: "paragraph", children: [{ type: "text", value: "Intro" }] },
      { type: "code", lang: "python", meta: null, value: "def f():\n\n    return 1" },
    ]);
    expect(() => blocksOf("```")).not.toThrow();
    expect(() => blocksOf("| a |\n|-")).not.toThrow();
    expect(() => blocksOf("**bold [link](http")).not.toThrow();
    expect(blocksOf("")).toEqual([]);
  });

  it("memoizes by text and keeps hashes stable across documents", () => {
    clearMarkdownCache();
    const first = parseMarkdown("# A\n\nsame");
    expect(parseMarkdown("# A\n\nsame")).toBe(first);
    const other = parseMarkdownUncached("# B\n\nsame");
    expect(other.blocks[1]?.hash).toBe(first.blocks[1]?.hash);
    expect(other.blocks[0]?.hash).not.toBe(first.blocks[0]?.hash);
  });
});

describe("advanceMarkdownStream", () => {
  function stream(text: string, step = 3): MarkdownStreamState {
    let state: MarkdownStreamState | null = null;
    for (let end = 1; end <= text.length; end += step) state = advanceMarkdownStream(state, text.slice(0, end));
    return advanceMarkdownStream(state, text);
  }

  const document = [
    "# Plan",
    "",
    "Some **intro** text.",
    "",
    "- one",
    "- two",
    "",
    "```ts",
    "const a = 1;",
    "",
    "const b = 2;",
    "```",
    "",
    "$$",
    "x",
    "",
    "y",
    "$$",
    "",
    "| a | b |",
    "|---|---|",
    "| 1 | 2 |",
    "",
    "Done.",
  ].join("\n");

  it("matches a full parse once streaming finishes", () => {
    const state = stream(document);
    expect(state.blocks.map((block) => block.hash)).toEqual(parseMarkdownUncached(document).blocks.map((block) => block.hash));
    expect(state.stableEnd).toBe(document.lastIndexOf("Done."));
  });

  it("never splits inside a fenced code block", () => {
    const partial = "Intro\n\n```ts\nconst a = 1;\n\nconst b";
    const state = stream(partial, 1);
    expect(shape(state.blocks)).toEqual([
      { type: "paragraph", children: [{ type: "text", value: "Intro" }] },
      { type: "code", lang: "ts", meta: null, value: "const a = 1;\n\nconst b" },
    ]);
  });

  it("reuses settled blocks and only re-parses the tail", () => {
    const first = advanceMarkdownStream(null, "One\n\nTwo");
    const second = advanceMarkdownStream(first, "One\n\nTwo and more");
    expect(second.stableBlocks).toBe(first.stableBlocks);
    expect(second.blocks[0]).toBe(first.blocks[0]);
    expect(advanceMarkdownStream(second, second.text)).toBe(second);
  });

  it("starts over when the text is rewritten", () => {
    const first = advanceMarkdownStream(null, "Hello\n\nworld");
    const rewritten = advanceMarkdownStream(first, "Bye");
    expect(shape(rewritten.blocks)).toEqual([{ type: "paragraph", children: [{ type: "text", value: "Bye" }] }]);
  });

  it("keeps indented list continuations with their item", () => {
    const text = "1. First\n\n   continued\n2. Second";
    expect(stream(text, 1).blocks.map((block) => block.type)).toEqual(["list"]);
  });
});
