import { readFileSync } from "node:fs";

const requiredFiles = [
  "docs/telemetry.md",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  "packages/shared/src/index.ts",
  "packages/host/src/service.ts",
  "apps/desktop/src/host-client.ts",
  "apps/desktop/src/main.tsx",
  "apps/desktop/src/components/help-menu.tsx",
];

for (const file of requiredFiles) {
  const content = readFileSync(file, "utf8");
  for (const phrase of phrasesFor(file)) {
    if (!content.includes(phrase)) throw new Error(`${file} is missing required phrase: ${phrase}`);
  }
}

console.log("[support] support bundles, crash opt-in, telemetry schema, and issue template OK");

function phrasesFor(file) {
  if (file === "docs/telemetry.md") return ["Public telemetry schema", "Crash report schema", "Support bundle schema", "prompts, assistant text, file contents"];
  if (file === ".github/ISSUE_TEMPLATE/bug_report.yml") return ["Create issue bundle", "Privacy check"];
  if (file === "packages/shared/src/index.ts") return ["support.issueReport.create", "support.crashReport.record"];
  if (file === "packages/host/src/service.ts") return ["#writeSupportIssueReport", "scrubSupportString", "#telemetryEnabled"];
  if (file === "apps/desktop/src/host-client.ts") return ["support.issueReport.create", "support.crashReport.record"];
  if (file === "apps/desktop/src/main.tsx") return ["installRendererCrashReporter", "unhandledrejection"];
  if (file === "apps/desktop/src/components/help-menu.tsx") return ["Create issue bundle", "support.issueReport.create"];
  return [];
}
