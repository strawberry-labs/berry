#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";

const root = resolve(import.meta.dirname, "..");

const STARTUP_RAW_JS_BUDGET = 1_450_000;
const STARTUP_GZIP_JS_BUDGET = 445_000;

run("corepack", ["pnpm", "--filter", "@berry/desktop", "build"]);

const manifest = JSON.parse(read("apps/desktop/dist/.vite/manifest.json"));
const entry = manifest["index.html"];
assert(entry?.isEntry, "desktop Vite manifest must expose index.html as an entry");

const initialKeys = new Set();
function visitInitial(key) {
  if (!key || initialKeys.has(key)) return;
  initialKeys.add(key);
  const item = manifest[key];
  if (!item) return;
  for (const child of item.imports ?? []) visitInitial(child);
}
visitInitial("index.html");

const initialFiles = [...initialKeys]
  .map((key) => manifest[key]?.file)
  .filter((file) => typeof file === "string");

for (const blocked of ["vendor-recharts", "vendor-xterm", "vendor-shiki", "terminal-pane"]) {
  assert(
    !initialFiles.some((file) => file.includes(blocked)),
    `${blocked} must not be part of the initial desktop import graph`,
  );
}

let startupRawJs = 0;
let startupGzipJs = 0;
for (const file of initialFiles) {
  if (!file.endsWith(".js")) continue;
  const buffer = readBuffer(`apps/desktop/dist/${file}`);
  startupRawJs += statSync(resolve(root, "apps/desktop/dist", file)).size;
  startupGzipJs += gzipSync(buffer).length;
}
assert(startupRawJs <= STARTUP_RAW_JS_BUDGET, `startup JS ${startupRawJs} exceeds raw budget ${STARTUP_RAW_JS_BUDGET}`);
assert(startupGzipJs <= STARTUP_GZIP_JS_BUDGET, `startup JS ${startupGzipJs} exceeds gzip budget ${STARTUP_GZIP_JS_BUDGET}`);

const dynamicKeys = collectDynamicKeys("index.html");
for (const expected of [
  "src/components/settings/index.tsx",
  "src/components/terminal-pane.tsx",
]) {
  assert(dynamicKeys.has(expected), `${expected} must be loaded through a dynamic import`);
}
for (const expected of [
  "src/components/settings/general.tsx",
  "src/components/settings/code-preview.tsx",
  "src/components/settings/models.tsx",
  "src/components/settings/skills.tsx",
  "src/components/settings/subagents.tsx",
  "src/components/settings/mcp.tsx",
  "src/components/settings/commands.tsx",
  "src/components/settings/plugins.tsx",
  "src/components/settings/security.tsx",
  "src/components/settings/indexing.tsx",
  "src/components/settings/usage.tsx",
  "src/components/settings/usage-recharts.tsx",
]) {
  assert(Object.prototype.hasOwnProperty.call(manifest, expected), `${expected} must be present as a split desktop chunk`);
}

const app = read("apps/desktop/src/app.tsx");
assert(app.includes('lazy(() => import("@/components/settings")'), "SettingsView must stay lazy in the app shell");

const sidebar = read("apps/desktop/src/components/app-sidebar.tsx");
assert(sidebar.includes('@/components/settings/nav'), "settings sidebar nav must not import the lazy settings view module");

const settingsIndex = read("apps/desktop/src/components/settings/index.tsx");
assert(settingsIndex.match(/lazy\(\(\) => import\("\.\/[a-z-]+"/g)?.length === 11, "every settings page must be React.lazy-loaded");

const usage = read("apps/desktop/src/components/settings/usage.tsx");
assert(!usage.includes("from \"recharts\""), "usage settings page must not import Recharts directly");
assert(!usage.includes("components/ui/chart"), "usage settings page must not import chart primitives directly");
assert(usage.includes('lazy(() => import("./usage-recharts")'), "usage chart must load through a lazy Recharts module");

const usageRecharts = read("apps/desktop/src/components/settings/usage-recharts.tsx");
assert(usageRecharts.includes("from \"recharts\""), "usage Recharts module must own the Recharts import");
assert(usageRecharts.includes("components/ui/chart"), "usage Recharts module must own chart primitive imports");

for (const file of ["apps/desktop/src/components/work-pane.tsx", "apps/desktop/src/components/task-view.tsx"]) {
  const source = read(file);
  assert(source.includes('React.lazy(() => import("@/components/terminal-pane")'), `${file} must lazy-load terminal-pane`);
  assert(!/import\s+\{\s*TerminalPane\s*\}\s+from\s+["']@\/components\/terminal-pane["']/.test(source), `${file} must not statically import terminal-pane`);
}

for (const file of ["packages/desktop-ui/src/components/berry-markdown.tsx", "apps/desktop/src/components/diff-viewer.tsx"]) {
  const source = read(file);
  assert(source.includes('import("shiki")'), `${file} must lazy-load Shiki`);
  assert(!/import\s+\{[^}]*\}\s+from\s+["']shiki["']/.test(source), `${file} must not import Shiki values statically`);
}

const thread = read("packages/desktop-ui/src/components/berry-thread-view.tsx");
const virtualizedRows = thread.match(/<MessageScrollerItem virtualize>/g)?.length ?? 0;
assert(virtualizedRows >= 2, "settled user and assistant rows must remain virtualized for 10k-message sessions");
assert(thread.includes("<MessageScrollerItem>") && thread.includes("liveVisible"), "live streaming rows must remain outside the virtualization path");

const scroller = read("packages/desktop-ui/src/components/ui/message-scroller.tsx");
for (const phrase of ["contentVisibility: \"auto\"", "containIntrinsicSize", "ResizeObserver"]) {
  assert(scroller.includes(phrase), `message scroller virtualization must keep ${phrase}`);
}

const hostTest = read("packages/host/src/service.test.ts");
for (const phrase of [
  "benchmarks large workspace index rebuild and search budgets",
  "fileCount = 1200",
  "toBeLessThan(7500)",
  "huckleberrylargeindextarget",
]) {
  assert(hostTest.includes(phrase), `large-repo index benchmark test missing ${phrase}`);
}

console.log(`[performance] desktop split chunks OK; startup JS ${startupRawJs} raw / ${startupGzipJs} gzip; index and 10k-message virtualization gates present`);

function collectDynamicKeys(rootKey, seen = new Set()) {
  const item = manifest[rootKey];
  if (!item || seen.has(rootKey)) return seen;
  seen.add(rootKey);
  for (const dynamicKey of item.dynamicImports ?? []) collectDynamicKeys(dynamicKey, seen);
  for (const importKey of item.imports ?? []) collectDynamicKeys(importKey, seen);
  return seen;
}

function read(path) {
  return readFileSync(resolve(root, path), "utf8");
}

function readBuffer(path) {
  return readFileSync(resolve(root, path));
}

function assert(condition, message) {
  if (!condition) {
    console.error(`[performance] ${message}`);
    process.exit(1);
  }
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env: process.env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
