import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { McpImportCandidate } from "@berry/shared";

type ImportSource = McpImportCandidate["source"];

export interface McpImportLocation {
  source: ImportSource;
  path: string;
  format: "json" | "toml";
}

export function defaultMcpImportLocations(home = homedir()): McpImportLocation[] {
  return [
    { source: "claude-code", path: resolve(home, ".claude.json"), format: "json" },
    { source: "claude-code", path: resolve(home, ".claude", "settings.json"), format: "json" },
    { source: "codex", path: resolve(home, ".codex", "config.toml"), format: "toml" },
    { source: "zcode", path: resolve(home, ".zcode", "mcp.json"), format: "json" },
    { source: "zcode", path: resolve(home, ".config", "zcode", "mcp.json"), format: "json" },
    { source: "agents", path: resolve(home, ".agents", "mcp.json"), format: "json" },
  ];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringRecord(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(record(value)).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function candidate(source: ImportSource, sourcePath: string, name: string, value: unknown): McpImportCandidate | null {
  const input = record(value);
  const command = typeof input.command === "string" && input.command.trim() ? input.command.trim() : null;
  const url = typeof input.url === "string" && input.url.trim() ? input.url.trim() : null;
  if (!command && !url) return null;
  const rawType = typeof input.type === "string" ? input.type : typeof input.transport === "string" ? input.transport : "";
  const transport = command
    ? "stdio"
    : rawType === "sse" || rawType === "http-sse"
      ? "http-sse"
      : "streamable-http";
  return {
    source,
    sourcePath,
    name,
    transport,
    command,
    args: strings(input.args),
    url,
    env: stringRecord(input.env),
  };
}

function serverMaps(source: ImportSource, parsed: unknown): Array<Record<string, unknown>> {
  const root = record(parsed);
  const maps = [record(root.mcpServers), record(root.mcp_servers), record(root.servers)];
  if (source === "claude-code") {
    for (const project of Object.values(record(root.projects))) maps.push(record(record(project).mcpServers));
  }
  return maps;
}

export function parseMcpImportContent(location: McpImportLocation, content: string): McpImportCandidate[] {
  const parsed = location.format === "toml" ? parseToml(content) : JSON.parse(content) as unknown;
  const seen = new Set<string>();
  const candidates: McpImportCandidate[] = [];
  for (const map of serverMaps(location.source, parsed)) {
    for (const [name, value] of Object.entries(map)) {
      const item = candidate(location.source, location.path, name, value);
      const key = item ? `${item.name}\0${item.command ?? item.url}` : "";
      if (item && !seen.has(key)) {
        seen.add(key);
        candidates.push(item);
      }
    }
  }
  return candidates;
}

export function scanMcpImports(locations: McpImportLocation[]): McpImportCandidate[] {
  return locations.flatMap((location) => {
    if (!existsSync(location.path)) return [];
    try {
      return parseMcpImportContent(location, readFileSync(location.path, "utf8"));
    } catch {
      return [];
    }
  });
}
