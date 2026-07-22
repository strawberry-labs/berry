import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { docsNavigation } from "../docs.config.mjs";

const root = resolve(new URL("../../..", import.meta.url).pathname);
const dist = resolve(root, "apps/docs/dist");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const pages = docsNavigation.flatMap((section) => section.pages.map((page) => ({ ...page, section: section.section })));
for (const page of pages) {
  const sourcePath = resolve(root, page.source);
  if (!existsSync(sourcePath)) throw new Error(`Missing docs source: ${page.source}`);
  const markdown = readFileSync(sourcePath, "utf8");
  const html = renderPage(page, markdown, pages, docsNavigation);
  const outputPath = resolve(dist, page.output);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, html);
}

writeFileSync(resolve(dist, "search-index.json"), JSON.stringify(pages.map((page) => ({
  title: page.title,
  section: page.section,
  href: page.output,
  source: page.source,
})), null, 2));

console.log(`built ${pages.length} docs pages in ${relative(root, dist)}`);

function renderPage(page, markdown, pages, navigation) {
  const content = renderMarkdown(markdown);
  const nav = navigation.map((section) => [
    `<div class="nav-section">${escapeHtml(section.section)}</div>`,
    ...section.pages.map((item) => {
      const href = hrefFrom(page.output, item.output);
      const active = item.output === page.output ? " aria-current=\"page\"" : "";
      return `<a class="nav-link" href="${href}"${active}>${escapeHtml(item.title)}</a>`;
    }),
  ].join("\n")).join("\n");
  const topLinks = pages.slice(1, 6).map((item) => `<a href="${hrefFrom(page.output, item.output)}">${escapeHtml(item.title)}</a>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(page.title)} · Berry Docs</title>
  <style>${siteCss()}</style>
</head>
<body>
  <div class="shell">
    <aside class="sidebar">
      <a class="brand" href="${hrefFrom(page.output, "index.html")}" aria-label="Berry documentation home">
        <span class="brand-mark">B</span>
        <span><strong>Berry</strong><small>Docs</small></span>
      </a>
      <nav aria-label="Documentation sections">${nav}</nav>
    </aside>
    <main>
      <div class="topbar">
        <span>${escapeHtml(page.section)}</span>
        <div>${topLinks}</div>
      </div>
      <article class="doc">
        ${content}
      </article>
    </main>
  </div>
</body>
</html>
`;
}

function hrefFrom(fromOutput, toOutput) {
  const fromDir = dirname(fromOutput);
  const relativePath = fromDir === "." ? toOutput : relative(fromDir, toOutput);
  return relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
}

function renderMarkdown(markdown) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let paragraph = [];
  let list = null;
  let table = [];
  let inFence = false;
  let fenceInfo = "";
  let fenceLines = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    html.push(`<p>${inline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    html.push(`<${list.tag}>${list.items.map((item) => `<li>${inline(item)}</li>`).join("")}</${list.tag}>`);
    list = null;
  };
  const flushTable = () => {
    if (table.length < 2) {
      table = [];
      return;
    }
    const [header, separator, ...rows] = table;
    if (!separator.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))) {
      table = [];
      return;
    }
    html.push("<table><thead><tr>");
    for (const cell of header) html.push(`<th>${inline(cell.trim())}</th>`);
    html.push("</tr></thead><tbody>");
    for (const row of rows) {
      html.push("<tr>");
      for (const cell of row) html.push(`<td>${inline(cell.trim())}</td>`);
      html.push("</tr>");
    }
    html.push("</tbody></table>");
    table = [];
  };
  const flushBlocks = () => {
    flushParagraph();
    flushList();
    flushTable();
  };

  for (const line of lines) {
    const fence = line.match(/^```(.*)$/);
    if (fence) {
      if (inFence) {
        html.push(`<pre><code class="language-${escapeHtml(fenceInfo)}">${escapeHtml(fenceLines.join("\n"))}</code></pre>`);
        inFence = false;
        fenceInfo = "";
        fenceLines = [];
      } else {
        flushBlocks();
        inFence = true;
        fenceInfo = fence[1].trim();
      }
      continue;
    }
    if (inFence) {
      fenceLines.push(line);
      continue;
    }
    if (!line.trim()) {
      flushBlocks();
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      flushBlocks();
      const level = heading[1].length;
      const text = heading[2].trim();
      html.push(`<h${level} id="${slug(text)}">${inline(text)}</h${level}>`);
      continue;
    }
    if (/^\|.*\|$/.test(line.trim())) {
      flushParagraph();
      flushList();
      table.push(line.trim().slice(1, -1).split("|"));
      continue;
    }
    flushTable();
    const unordered = line.match(/^\s*[-*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      const tag = unordered ? "ul" : "ol";
      if (!list || list.tag !== tag) flushList();
      if (!list) list = { tag, items: [] };
      list.items.push((unordered ?? ordered)[1]);
      continue;
    }
    paragraph.push(line.trim());
  }
  flushBlocks();
  if (inFence) throw new Error("Unclosed markdown fence");
  return html.join("\n");
}

function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, href) => `<a href="${escapeHtml(href)}">${label}</a>`);
}

function slug(text) {
  return text.toLowerCase().replace(/`/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function siteCss() {
  return `
:root {
  color-scheme: light;
  --ink: #17201d;
  --muted: #607068;
  --line: #d7dfda;
  --paper: #fbfaf5;
  --panel: #ffffff;
  --green: #126b57;
  --red: #a63c30;
  --blue: #245a87;
  --code: #15201c;
}
* { box-sizing: border-box; }
body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--paper); color: var(--ink); }
a { color: var(--green); text-decoration-thickness: 1px; text-underline-offset: 3px; }
.shell { display: grid; grid-template-columns: 284px minmax(0, 1fr); min-height: 100vh; }
.sidebar { position: sticky; top: 0; height: 100vh; overflow: auto; border-right: 1px solid var(--line); background: #f4f2ea; padding: 22px 18px; }
.brand { display: flex; gap: 10px; align-items: center; margin-bottom: 26px; color: var(--ink); text-decoration: none; }
.brand-mark { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 7px; background: var(--ink); color: #fbfaf5; font-weight: 800; }
.brand small { display: block; color: var(--muted); font-size: 12px; margin-top: 1px; }
.nav-section { color: var(--red); font-size: 11px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; margin: 22px 0 8px; }
.nav-link { display: block; color: var(--ink); text-decoration: none; padding: 7px 8px; border-radius: 6px; font-size: 14px; line-height: 1.25; }
.nav-link:hover, .nav-link[aria-current="page"] { background: #e5ece7; color: var(--green); }
main { min-width: 0; }
.topbar { min-height: 54px; border-bottom: 1px solid var(--line); display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 0 34px; color: var(--muted); font-size: 13px; background: rgba(251, 250, 245, .88); position: sticky; top: 0; z-index: 2; backdrop-filter: blur(10px); }
.topbar div { display: flex; flex-wrap: wrap; gap: 12px; justify-content: flex-end; }
.doc { width: min(880px, calc(100vw - 340px)); margin: 0 auto; padding: 44px 0 88px; }
.doc h1 { font-size: clamp(34px, 5vw, 58px); line-height: .98; margin: 0 0 22px; max-width: 780px; }
.doc h2 { margin-top: 44px; padding-top: 20px; border-top: 1px solid var(--line); font-size: 25px; }
.doc h3 { margin-top: 32px; font-size: 19px; }
.doc h4 { margin-top: 26px; font-size: 16px; color: var(--blue); }
.doc p, .doc li { color: #2f3a36; line-height: 1.72; font-size: 16px; }
.doc p { margin: 16px 0; }
.doc ul, .doc ol { padding-left: 24px; }
.doc li { margin: 8px 0; }
.doc code { font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; font-size: .92em; background: #e9eee9; border: 1px solid #dce4de; border-radius: 5px; padding: 1px 5px; color: var(--code); }
.doc pre { overflow: auto; background: #101916; color: #f3f5ef; border-radius: 8px; padding: 16px; border: 1px solid #24352e; }
.doc pre code { background: transparent; border: 0; color: inherit; padding: 0; }
.doc table { width: 100%; border-collapse: collapse; margin: 20px 0; background: var(--panel); }
.doc th, .doc td { border: 1px solid var(--line); padding: 10px 12px; text-align: left; vertical-align: top; }
.doc th { background: #edf2ee; color: var(--ink); }
@media (max-width: 900px) {
  .shell { display: block; }
  .sidebar { position: relative; height: auto; border-right: 0; border-bottom: 1px solid var(--line); }
  .topbar { position: relative; padding: 12px 18px; align-items: flex-start; flex-direction: column; }
  .topbar div { justify-content: flex-start; }
  .doc { width: auto; padding: 30px 18px 64px; }
}
`;
}
