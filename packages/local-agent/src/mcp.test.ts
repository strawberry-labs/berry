import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { McpToolSource, validatedRemoteMcpUrl, type McpServerSpec } from "./mcp.ts";

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures", "mcp-echo-server.mjs");

function stdioServer(overrides: Partial<McpServerSpec> = {}): McpServerSpec {
  return {
    id: "mcp_echo",
    name: "echo",
    transport: "stdio",
    command: process.execPath,
    args: [fixturePath],
    url: null,
    env: {},
    enabled: true,
    trusted: true,
    ...overrides,
  };
}

describe("McpToolSource", () => {
  it("exposes namespaced tools from a stdio server and executes them", async () => {
    const source = new McpToolSource({ servers: [stdioServer()] });
    await source.connect();
    const tools = source.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["mcp__echo__echo", "mcp__echo__fail"]);
    const echo = tools[0]!;
    expect(echo.parameters).toMatchObject({ type: "object" });
    const result = await echo.execute("call_1", { message: "berry" } as never, undefined, undefined);
    expect(result.content).toEqual([{ type: "text", text: "echo: berry" }]);
    const fail = tools[1]!;
    await expect(fail.execute("call_2", {} as never, undefined, undefined)).rejects.toThrow("intentional failure");
    expect(source.listServers()).toEqual([{ id: "mcp_echo", name: "echo", toolCount: 2 }]);
    await source.close();
  });

  it("skips disabled servers and survives startup failures", async () => {
    const logs: string[] = [];
    const source = new McpToolSource({
      servers: [
        stdioServer({ id: "mcp_disabled", name: "disabled", enabled: false }),
        stdioServer({ id: "mcp_broken", name: "broken", args: ["-e", "process.exit(1)"] }),
      ],
      log: (level, message) => logs.push(`${level}:${message}`),
    });
    await source.connect();
    expect(source.listTools()).toEqual([]);
    expect(logs.some((line) => line.startsWith("error:") && line.includes("broken"))).toBe(true);
    await source.close();
  });

  it("skips enabled servers that are not trusted", async () => {
    const logs: string[] = [];
    const source = new McpToolSource({
      servers: [stdioServer({ trusted: false })],
      log: (level, message) => logs.push(`${level}:${message}`),
    });
    await source.connect();
    expect(source.listTools()).toEqual([]);
    expect(logs.some((line) => line.includes("not trusted"))).toBe(true);
    await source.close();
  });

  it("validates remote MCP URLs against private-network SSRF targets", () => {
    expect(validatedRemoteMcpUrl("https://mcp.example.com/sse").hostname).toBe("mcp.example.com");
    expect(() => validatedRemoteMcpUrl("http://mcp.example.com/sse")).toThrow("https");
    expect(() => validatedRemoteMcpUrl("https://127.0.0.1/sse")).toThrow("private networks");
    expect(() => validatedRemoteMcpUrl("https://localhost/sse")).toThrow("private networks");
    expect(() => validatedRemoteMcpUrl("https://user:pass@mcp.example.com/sse")).toThrow("credentials");
  });

  it("blocks remote MCP before transport connection when egress is off or outside the allowlist", async () => {
    const server = stdioServer({ transport: "http-sse", command: null, args: [], url: "https://mcp.example.com/sse" });
    const errors: string[] = [];
    const offline = new McpToolSource({ servers: [server], networkPolicy: { egress: "off", allowedDomains: [] }, onHealth: (health) => { if (health.lastError) errors.push(health.lastError); } });
    await offline.connect();
    const restricted = new McpToolSource({ servers: [server], networkPolicy: { egress: "on", allowedDomains: ["api.example.com"] }, onHealth: (health) => { if (health.lastError) errors.push(health.lastError); } });
    await restricted.connect();
    expect(errors).toEqual(expect.arrayContaining([expect.stringContaining("network egress is off"), expect.stringContaining("not in the network domain allowlist")]));
  });

  it("exposes cached schemas without waiting for a busy server", async () => {
    const health: string[] = [];
    const source = new McpToolSource({
      servers: [stdioServer({
        id: "mcp_busy",
        name: "busy",
        args: ["-e", "setTimeout(() => {}, 30_000)"],
        cachedTools: [{ name: "lookup", description: "Look up cached docs", inputSchema: { type: "object", properties: { query: { type: "string" } } } }],
      })],
      connectTimeoutMs: 25,
      onHealth: (status) => { health.push(status.status); },
    });
    const started = Date.now();
    source.connectInBackground();
    expect(source.listTools().map((tool) => tool.name)).toEqual(["mcp__busy__lookup"]);
    expect(Date.now() - started).toBeLessThan(20);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(health).toEqual(expect.arrayContaining(["connecting", "error"]));
    await source.close();
  });

  it("defers a large catalog behind tool_search and reveals matching tools", async () => {
    const source = new McpToolSource({
      servers: [stdioServer({
        cachedTools: [
          { name: "find_docs", description: "Search product documentation", inputSchema: { type: "object" } },
          { name: "create_issue", description: "Create a tracker issue", inputSchema: { type: "object" } },
        ],
      })],
    });
    let revealed: string[] = [];
    const search = source.createToolSearch(async (tools) => { revealed = tools.map((tool) => tool.name); });
    const result = await search.execute("call_search", { query: "documentation" } as never, undefined, undefined);
    expect(revealed).toEqual(["mcp__echo__find_docs"]);
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("find_docs") });
  });

  it("accepts the additive streamable HTTP transport", () => {
    const source = new McpToolSource({
      servers: [stdioServer({ id: "mcp_http", transport: "streamable-http", command: null, args: [], url: "https://mcp.example.com/mcp" })],
    });
    expect(source.listTools()).toEqual([]);
  });
});
