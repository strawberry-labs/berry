import { expect, test, type Page } from "@playwright/test";

// Mixed Arabic/English rendering (H-047). Each probe names the logically first
// and last word of one sentence: in a right-to-left sentence the first word
// must be drawn to the right of the last one, and the line must hug the right
// edge. The fake API serves the synthetic answers in
// scripts/bidi-browser-server.mjs.
const settledTask = "00000000-0000-7000-8000-0000000000c1";
const streamingTask = "00000000-0000-7000-8000-0000000000c2";

// `scope` widens the block searched for the last word (a table row);
// `skipAlign` marks probes whose first word does not start the line (an
// inline list number, a code line number, a table's second column).
type Probe = { name: string; first: string; last: string; expected: "rtl" | "ltr"; scope?: string; skipAlign?: true };
type Measured = Probe & { direction: string; order: "rtl" | "ltr"; align: "left" | "right" | "other"; sameLine: boolean };

async function measure(page: Page, rootSelector: string, probes: Probe[]): Promise<Measured[]> {
  return page.evaluate(({ rootSelector, probes }) => {
    const root = document.querySelector(rootSelector);
    if (!root) throw new Error(`Missing ${rootSelector}`);
    const blockSelector = "p,li,h1,h2,h3,h4,h5,h6,td,th,blockquote,pre,[data-markdown-line],[data-markdown-live],[data-user-message-bubble-surface] span";
    const find = (scope: Node, word: string) => {
      const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const index = node.textContent!.indexOf(word);
        if (index >= 0) {
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + word.length);
          return { node, range };
        }
      }
      throw new Error(`Missing "${word}" in ${rootSelector}`);
    };
    return probes.map((probe) => {
      const first = find(root, probe.first);
      const block = (first.node.parentElement!.closest(blockSelector) ?? root) as HTMLElement;
      const last = find(probe.scope ? block.closest(probe.scope) ?? block : block, probe.last);
      const a = first.range.getBoundingClientRect();
      const b = last.range.getBoundingClientRect();
      const style = getComputedStyle(block);
      const content = block.getBoundingClientRect();
      const left = content.left + parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth);
      const right = content.right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth);
      // The first word starts its line: flush with the right edge for
      // right-to-left text, with the left edge otherwise.
      const align = Math.abs(right - a.right) <= 3 ? "right" : Math.abs(a.left - left) <= 3 ? "left" : "other";
      return {
        ...probe,
        direction: style.direction,
        order: a.left + a.width / 2 > b.left + b.width / 2 ? "rtl" : "ltr",
        align,
        sameLine: Math.abs(a.top - b.top) < 4,
      };
    });
  }, { rootSelector, probes });
}

const settledProbes: Probe[] = [
  { name: "heading", first: "ملخص", last: "Berry", expected: "rtl" },
  { name: "Arabic-first sentence", first: "تعمل", last: "الملفات", expected: "rtl" },
  { name: "sentence opening with a product name", first: "Berry Workspace", last: "المشروع", expected: "rtl" },
  { name: "bullet with file types", first: "يدعم", last: "XLSX", expected: "rtl" },
  { name: "bullet with a URL", first: "شارك", last: "الفريق", expected: "rtl" },
  { name: "numbered step", first: "افتح", last: "Settings", expected: "rtl", skipAlign: true },
  { name: "numbered step with names", first: "اختر", last: "Drive", expected: "rtl", skipAlign: true },
  { name: "quote", first: "ملاحظة", last: "شخص", expected: "rtl" },
  { name: "table header", first: "البند", last: "القيمة", expected: "rtl", scope: "tr", skipAlign: true },
  { name: "inline code sentence", first: "استخدم", last: "النهائي", expected: "rtl" },
  { name: "code block", first: "total", last: "price", expected: "ltr", skipAlign: true },
  { name: "English paragraph", first: "This", last: "once", expected: "ltr" },
];

const streamingProbes: Probe[] = [
  { name: "live Arabic-first line", first: "تعمل", last: "الملفات", expected: "rtl" },
  { name: "live line opening with a product name", first: "Berry Workspace", last: "المشروع", expected: "rtl" },
  { name: "live English line", first: "This", last: "stays", expected: "ltr" },
];

function report(label: string, rows: Measured[]) {
  console.log(`\n${label}`);
  for (const row of rows) console.log(`  ${row.name.padEnd(38)} dir=${row.direction.padEnd(3)} order=${row.order} align=${row.align}${row.sameLine ? "" : " (wrapped)"} expected=${row.expected}`);
}

// The app's CSP upgrades insecure requests; WebKit applies that to the http
// dev server on 127.0.0.1 (Chromium exempts loopback), so the fake-API pages
// only load in Chromium. The static check below covers WebKit.
const servedOnlyInChromium = (browserName: string) => test.skip(browserName !== "chromium", "WebKit upgrades the http dev server to https");

test("a settled mixed Arabic/English answer reads right to left (H-047)", async ({ page, browserName }) => {
  servedOnlyInChromium(browserName);
  await page.setViewportSize({ width: 1280, height: 1600 });
  await page.goto(`/tasks/${settledTask}`);
  await expect(page.locator(".berry-assistant-message")).toContainText("Berry Workspace");
  const rows = await measure(page, ".berry-assistant-message", settledProbes);
  report("Settled answer", rows);
  const prompt = await measure(page, "[data-user-message-bubble-surface]", [{ name: "user prompt", first: "اكتب", last: "Microsoft", expected: "rtl" }]);
  report("User prompt", prompt);
  await page.screenshot({ path: "test-results/bidi-settled.png", fullPage: true });
  for (const row of [...rows, ...prompt]) {
    expect.soft(row.sameLine, `${row.name}: probe words share a line`).toBe(true);
    expect.soft(row.order, `${row.name}: visual word order`).toBe(row.expected);
    expect.soft(row.direction, `${row.name}: direction`).toBe(row.expected);
    if (!row.skipAlign) expect.soft(row.align, `${row.name}: alignment`).toBe(row.expected === "rtl" ? "right" : "left");
  }
});

test("a streaming mixed Arabic/English answer reads right to left (H-047)", async ({ page, browserName }) => {
  servedOnlyInChromium(browserName);
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto(`/tasks/${streamingTask}`);
  await expect(page.locator("[data-markdown-live]")).toContainText("Berry Workspace");
  const rows = await measure(page, "[data-markdown-live]", streamingProbes);
  report("Streaming answer", rows);
  await page.screenshot({ path: "test-results/bidi-streaming.png" });
  for (const row of rows) {
    expect.soft(row.order, `${row.name}: visual word order`).toBe(row.expected);
    expect.soft(row.align, `${row.name}: alignment`).toBe(row.expected === "rtl" ? "right" : "left");
  }
});

test("a directed prompt keeps its line clamp and per-line alignment (H-047)", async ({ page }) => {
  // Same structure as DirectedText inside CollapsibleSubmittedPrompt: block
  // lines inside a -webkit-line-clamp box (no whitespace between the spans).
  const lines = ["اكتب ملخصاً قصيراً عن منصة Berry", "Please keep it short.", "السطر الثالث", "السطر الرابع", "السطر الخامس"];
  const body = lines.map((line) => `<span class="line"${/^[A-Z]/.test(line) ? ' dir="ltr"' : ""}>${line}</span>`).join("");
  await page.setContent(`<style>body{margin:0;font:16px/24px sans-serif}.clamp{width:420px;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3}.text{display:block;white-space:pre-wrap}.line{display:block}</style><div class="clamp"><span dir="rtl" class="text">${body}</span></div>`);
  const result = await page.evaluate(() => {
    const clamp = document.querySelector(".clamp")!.getBoundingClientRect();
    const [arabic, english] = [...document.querySelectorAll<HTMLElement>(".line")];
    const range = (element: HTMLElement) => { const r = document.createRange(); r.selectNodeContents(element); return r.getBoundingClientRect(); };
    return {
      height: clamp.height,
      arabicRightGap: clamp.right - range(arabic!).right,
      englishLeftGap: range(english!).left - clamp.left,
    };
  });
  expect(result.height).toBe(72);
  expect(result.arabicRightGap).toBeLessThan(1);
  expect(result.englishLeftGap).toBeLessThan(1);
});
