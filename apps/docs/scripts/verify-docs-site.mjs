import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { docsNavigation, requiredDocs } from "../docs.config.mjs";

const root = resolve(new URL("../../..", import.meta.url).pathname);
const dist = resolve(root, "apps/docs/dist");
const requiredPhrases = new Map([
  ["docs/quickstarts/ollama.md", ["ollama pull", "Settings > Models", "provider test passes"]],
  ["docs/quickstarts/lm-studio.md", ["Local Server", "LM Studio", "provider test passes"]],
  ["docs/quickstarts/openrouter-router.md", ["OpenRouter", "Berry Router", "cost controls"]],
  ["docs/quickstarts/self-host-compose.md", ["docker compose", "deploy/.env", "localhost:3108"]],
  ["docs/quickstarts/helm.md", ["helm upgrade --install", "deploy/helm/berry-platform", "Ingress"]],
  ["docs/reference/cli.md", ["Generated from `apps/cli/src/command-reference.ts`", "berry run -p", "berry update"]],
  ["docs/protocol/host-methods.md", ["Generated from `packages/shared/src/index.ts`", "Protocol version: `1`", "host.handshake"]],
  ["docs/admin/policy-admin-guide.md", ["managed policy", "public-key", "confirm it works"]],
  ["docs/authoring/index.md", ["Plugin", "Skill", "MCP", "untrusted until reviewed"]],
  ["docs/migration/import-agent-configs.md", ["Claude Code", "Codex", "review each imported server"]],
]);

for (const source of requiredDocs) {
  const path = resolve(root, source);
  if (!existsSync(path)) throw new Error(`Missing required docs source: ${source}`);
  const content = readFileSync(path, "utf8");
  const lowerContent = content.toLowerCase();
  if (/\b(TODO|TBD|INSERT_|PASTE_|FIXME)\b/.test(content)) throw new Error(`${source} contains a placeholder token`);
  for (const phrase of requiredPhrases.get(source) ?? []) {
    if (!lowerContent.includes(phrase.toLowerCase())) throw new Error(`${source} is missing required phrase: ${phrase}`);
  }
}

execFileSync("corepack", ["pnpm", "exec", "tsx", "scripts/generate-cli-reference.ts", "--check"], { cwd: root, stdio: "inherit" });
execFileSync("corepack", ["pnpm", "--filter", "@berry/shared", "protocol:docs"], { cwd: root, stdio: "inherit" });
execFileSync("node", ["apps/docs/scripts/build-docs-site.mjs"], { cwd: root, stdio: "inherit" });

const pages = docsNavigation.flatMap((section) => section.pages);
for (const page of pages) {
  const htmlPath = resolve(dist, page.output);
  if (!existsSync(htmlPath)) throw new Error(`Missing built docs page: ${page.output}`);
  const html = readFileSync(htmlPath, "utf8");
  if (!html.includes("<article class=\"doc\">")) throw new Error(`${page.output} did not render docs content`);
  if (!html.includes(page.title)) throw new Error(`${page.output} is missing page title ${page.title}`);
}

const home = readFileSync(resolve(dist, "index.html"), "utf8");
for (const label of ["Ollama in 5 minutes", "CLI", "Host Protocol", "Policy and Admin", "Import Agent Configs"]) {
  if (!home.includes(label)) throw new Error(`Docs home is missing navigation label: ${label}`);
}

console.log("docs site verification passed");
