#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const value = inlineValue ?? (argv[index + 1]?.startsWith("--") ? "true" : argv[++index] ?? "true");
    args.set(rawKey, value);
  }
  return args;
}

function git(args, options = {}) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", options.allowFailure ? "ignore" : "pipe"] }).trim();
}

function readVersion() {
  const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
  return String(pkg.version);
}

function latestTag(to) {
  try {
    return git(["describe", "--tags", "--abbrev=0", `${to}^`], { allowFailure: true }) || null;
  } catch {
    return null;
  }
}

function commits(from, to) {
  const range = from ? `${from}..${to}` : to;
  const format = "%H%x1f%h%x1f%ad%x1f%s%x1f%b%x1e";
  const raw = git(["log", "--date=short", `--format=${format}`, range], { allowFailure: true });
  if (!raw) return [];
  return raw
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [hash, shortHash, date, subject, body = ""] = record.split("\x1f");
      return { hash, shortHash, date, subject, body };
    });
}

function groupFor(commit) {
  const subject = commit.subject;
  const phase = /^phase(\d+):\s*(.+)$/i.exec(subject);
  if (phase) return { key: `Phase ${phase[1]}`, title: `Phase ${phase[1]}` };
  if (/^fix(?:\(.+\))?:/i.test(subject)) return { key: "Fixes", title: "Fixes" };
  if (/^docs(?:\(.+\))?:/i.test(subject)) return { key: "Documentation", title: "Documentation" };
  if (/^chore(?:\(.+\))?:/i.test(subject)) return { key: "Maintenance", title: "Maintenance" };
  if (/^test(?:\(.+\))?:/i.test(subject)) return { key: "Tests", title: "Tests" };
  return { key: "Other", title: "Other" };
}

function render({ version, from, to, entries }) {
  const lines = [`# Berry ${version} Release Notes`, ""];
  lines.push(`Range: ${from ? `\`${from}..${to}\`` : `initial history through \`${to}\``}`, "");
  if (entries.length === 0) {
    lines.push("No commits found in this range.", "");
  } else {
    const groups = new Map();
    for (const entry of entries) {
      const group = groupFor(entry);
      const list = groups.get(group.key) ?? { title: group.title, commits: [] };
      list.commits.push(entry);
      groups.set(group.key, list);
    }
    for (const { title, commits: grouped } of groups.values()) {
      lines.push(`## ${title}`, "");
      for (const commit of grouped) lines.push(`- ${commit.subject} (${commit.shortHash})`);
      lines.push("");
    }
  }
  lines.push("## Verification");
  lines.push("");
  lines.push("- `CI=true corepack pnpm check`");
  lines.push("- `cargo check --locked` in `apps/desktop/src-tauri`");
  lines.push("- `cargo test` in `crates/berry-pty`");
  lines.push("- `node scripts/build-sidecars.mjs`");
  lines.push("- `corepack pnpm --dir apps/desktop exec playwright test`");
  lines.push("");
  lines.push("## Pending Human Gates");
  lines.push("");
  lines.push("Review `plans/human-blockers.md` before publishing. Do not claim signed release, store, domain, Router, provider, or outside-tester acceptance until the corresponding blocker is closed.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

const args = parseArgs(process.argv.slice(2));
const to = args.get("to") ?? "HEAD";
const from = args.get("from") ?? latestTag(to);
const version = args.get("version") ?? process.env.BERRY_RELEASE_VERSION ?? readVersion();
const output = render({ version, from, to, entries: commits(from, to) });

if (args.has("check")) {
  if (!output.includes("## Verification") || !output.includes("plans/human-blockers.md")) {
    throw new Error("release notes output is missing required sections");
  }
}

if (args.has("output")) writeFileSync(resolve(args.get("output")), output);
else process.stdout.write(output);
