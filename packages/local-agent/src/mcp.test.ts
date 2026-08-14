import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  McpToolSource,
  mcpServerSpecsFromJson,
  validatedRemoteMcpUrl,
  type McpServerSpec,
} from "./mcp.ts";

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

  it("disables an approved tool when its live definition changed after review", async () => {
    const logs: string[] = [];
    const source = new McpToolSource({
      servers: [stdioServer({
        allowedTools: ["echo"],
        cachedTools: [{
          name: "echo",
          description: "Administrator-reviewed echo",
          inputSchema: { type: "object", properties: { message: { type: "integer" } }, required: ["message"] },
        }],
      })],
      log: (level, message) => logs.push(`${level}:${message}`),
    });
    const reviewedTool = source.listTools()[0]!;

    await expect(reviewedTool.execute("call_changed", { message: 42 } as never, undefined, undefined))
      .rejects.toThrow("definition changed after administrator review");
    expect(source.listTools()).toEqual([]);
    expect(logs).toContainEqual(expect.stringContaining("disabling it until republished"));
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

  it("resolves deploy credentials locally and preserves MCP safety annotations", () => {
    const servers = mcpServerSpecsFromJson(JSON.stringify([{
      id: "berrycrawl",
      name: "BerryCrawl",
      transport: "streamable-http",
      url: "https://crawl.example.com/mcp",
      credentialEnv: "BERRYCRAWL_API_KEY",
      cachedTools: [{
        name: "search",
        description: "Search the web",
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: true, openWorldHint: true },
      }],
      approvalRequiredTools: ["write"],
    }]), { BERRYCRAWL_API_KEY: "secret-from-worker" });
    const source = new McpToolSource({ servers });

    expect(servers[0]).toMatchObject({
      credential: "secret-from-worker",
      credentialKey: "env:BERRYCRAWL_API_KEY",
      approvalRequiredTools: ["write"],
    });
    expect(source.approvalHints("mcp__BerryCrawl__search")).toEqual({
      readOnly: true,
      requiresApproval: true,
      destructive: false,
      idempotent: false,
      openWorld: true,
    });
  });

  it("installs the reviewed catalog and core defaults for the official BerryCrawl adapter", () => {
    const servers = mcpServerSpecsFromJson(JSON.stringify([{
      id: "berrycrawl",
      name: "BerryCrawl",
      transport: "streamable-http",
      url: "https://api.berrycrawl.com/api/v1/mcp",
      credentialEnv: "BERRYCRAWL_API_KEY",
      enabled: true,
      trusted: true,
    }]), { BERRYCRAWL_API_KEY: "secret-from-worker" });
    const server = servers[0]!;
    const source = new McpToolSource({ servers });

    expect(server.cachedTools?.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "berrycrawl_search_web",
      "berrycrawl_scrape_url",
      "berrycrawl_get_brand",
      "berrycrawl_start_crawl",
      "berrycrawl_get_job",
      "berrycrawl_capture_screenshot",
      "berrycrawl_map_site",
      "berrycrawl_start_extract",
      "berrycrawl_get_credit_balance",
    ]));
    expect(server.allowedTools).toEqual(server.cachedTools?.map((tool) => tool.name));
    expect(server.defaultTools).toEqual([
      "berrycrawl_search_web",
      "berrycrawl_scrape_url",
      "berrycrawl_get_brand",
      "berrycrawl_start_crawl",
      "berrycrawl_get_job",
    ]);
    expect(server.nonReplayableTools).toEqual([
      "berrycrawl_scrape_url",
      "berrycrawl_capture_screenshot",
      "berrycrawl_map_site",
      "berrycrawl_search_web",
      "berrycrawl_get_brand",
    ]);
    expect(server.trustReadOnlyAnnotations).toBe(true);
    expect(source.approvalHints("mcp__BerryCrawl__berrycrawl_search_web"))
      .toMatchObject({ trustedReadOnly: true, nonReplayable: true });
    expect(source.approvalHints("mcp__BerryCrawl__berrycrawl_get_job"))
      .not.toHaveProperty("nonReplayable");
    expect(source.listDefaultTools().map((tool) => tool.name)).toEqual([
      "mcp__BerryCrawl__berrycrawl_scrape_url",
      "mcp__BerryCrawl__berrycrawl_search_web",
      "mcp__BerryCrawl__berrycrawl_get_brand",
      "mcp__BerryCrawl__berrycrawl_start_crawl",
      "mcp__BerryCrawl__berrycrawl_get_job",
    ]);
  });

  it("does not elevate a BerryCrawl lookalike on another host", () => {
    const [server] = mcpServerSpecsFromJson(JSON.stringify([{
      id: "berrycrawl",
      name: "BerryCrawl",
      transport: "streamable-http",
      url: "https://crawl.example.test/api/v1/mcp",
      enabled: true,
      trusted: true,
    }]));

    expect(server).not.toHaveProperty("cachedTools");
    expect(server).not.toHaveProperty("allowedTools");
    expect(server).not.toHaveProperty("defaultTools");
    expect(server).not.toHaveProperty("nonReplayableTools");
    expect(server).not.toHaveProperty("trustReadOnlyAnnotations");
  });

  it("trusts read-only annotations only for an explicitly Berry-owned adapter", () => {
    const untrusted = new McpToolSource({ servers: [stdioServer({ name: "Remote", cachedTools: [{ name: "read", description: null, inputSchema: {}, annotations: { readOnlyHint: true } }] })] });
    const native = new McpToolSource({ servers: [stdioServer({ name: "Native", trustReadOnlyAnnotations: true, cachedTools: [{ name: "read", description: null, inputSchema: {}, annotations: { readOnlyHint: true } }] })] });
    expect(untrusted.approvalHints("mcp__Remote__read")).not.toHaveProperty("trustedReadOnly");
    expect(untrusted.approvalHints("mcp__Remote__read")).toMatchObject({ requiresApproval: true });
    expect(native.approvalHints("mcp__Native__read")).toMatchObject({ readOnly: true, trustedReadOnly: true });
  });

  it("reports immutable approval requirements from Berry-owned server policy", () => {
    const source = new McpToolSource({ servers: [stdioServer({
      name: "Native",
      approvalRequiredTools: ["write"],
      cachedTools: [{ name: "write", description: null, inputSchema: {} }],
    })] });

    expect(source.approvalHints("mcp__Native__write")).toMatchObject({ requiresApproval: true });
  });
});
