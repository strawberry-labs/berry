import { describe, expect, it } from "vitest";
import { parseMcpImportContent } from "./mcp-import.ts";

describe("MCP import parsers", () => {
  it("parses Claude and Agents JSON maps without executing values", () => {
    const candidates = parseMcpImportContent(
      { source: "claude-code", path: "/tmp/.claude.json", format: "json" },
      JSON.stringify({ mcpServers: { files: { command: "npx", args: ["-y", "server"], env: { TOKEN: "literal" } }, docs: { url: "https://mcp.example.com/mcp" } } }),
    );
    expect(candidates).toEqual([
      expect.objectContaining({ name: "files", transport: "stdio", command: "npx", args: ["-y", "server"] }),
      expect.objectContaining({ name: "docs", transport: "streamable-http", url: "https://mcp.example.com/mcp" }),
    ]);
  });

  it("parses Codex TOML with structured TOML semantics", () => {
    const candidates = parseMcpImportContent(
      { source: "codex", path: "/tmp/config.toml", format: "toml" },
      `[mcp_servers.github]\nurl = "https://mcp.example.com/mcp"\n\n[mcp_servers.local]\ncommand = "node"\nargs = ["server.mjs"]\n`,
    );
    expect(candidates.map((item) => [item.name, item.transport])).toEqual([["github", "streamable-http"], ["local", "stdio"]]);
  });
});
