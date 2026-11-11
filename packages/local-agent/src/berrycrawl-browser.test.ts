import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { BERRYCRAWL_TOOL_CATALOG, McpToolSource, mcpServerSpecsFromJson, type McpServerSpec } from "./mcp.ts";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "../test/fixtures/mcp-browser-server.mjs");
const opened: McpToolSource[] = [];
afterEach(async () => { await Promise.all(opened.splice(0).map((source) => source.close())); });
function browserServer(): McpServerSpec {
  const [server] = mcpServerSpecsFromJson(JSON.stringify([{ id: "berrycrawl", name: "BerryCrawl", transport: "streamable-http", url: "https://api.berrycrawl.com/api/v1/mcp" }]));
  return { ...server!, transport: "stdio", command: process.execPath, args: [fixture], url: null, env: { BERRY_TEST_MCP_TOOLS: JSON.stringify(BERRYCRAWL_TOOL_CATALOG) } };
}
function source(server = browserServer()) { const value = new McpToolSource({ servers: [server] }); opened.push(value); return value; }

describe("native Berrycrawl browser contract", () => {
  it("bundles direct browser controls for Berry Chat's own agent loop", () => {
    const server = browserServer();
    expect(server.cachedTools).toHaveLength(22);
    expect(server.cachedTools?.filter((tool) => tool.name.startsWith("berrycrawl_browser_"))).toHaveLength(13);
    expect(server.defaultTools).toEqual(expect.arrayContaining(["berrycrawl_browser_open", "berrycrawl_browser_snapshot", "berrycrawl_browser_click", "berrycrawl_browser_type", "berrycrawl_browser_screenshot", "berrycrawl_browser_close"]));
    expect(server.allowedTools).not.toContain("berrycrawl_browser_run_task");
    expect(server.allowedTools).not.toContain("berrycrawl_browser_run_recording");
    expect(server.allowedTools).not.toContain("berrycrawl_browser_save_recording");
    const open = server.cachedTools?.find((tool) => tool.name === "berrycrawl_browser_open");
    expect(open?.inputSchema).toMatchObject({ type: "object", additionalProperties: false, properties: { url: { type: "string" }, timeout_seconds: { minimum: 30, maximum: 3600 } } });
    expect(server.nonReplayableTools).toEqual(expect.arrayContaining(["berrycrawl_browser_open", "berrycrawl_browser_click", "berrycrawl_browser_type", "berrycrawl_browser_act"]));
    expect(server.nonReplayableTools).not.toContain("berrycrawl_browser_snapshot");
  });

  it("executes a browser workflow through MCP and preserves screenshots as image content", async () => {
    const tools = source();
    const tool = (name: string) => tools.listTools().find((candidate) => candidate.name === `mcp__BerryCrawl__berrycrawl_${name}`)!;
    const opened = await tool("browser_open").execute("open", { url: "https://example.test" } as never);
    expect(opened.details).toMatchObject({ structuredContent: { data: { session_id: "bses_fixture" } } });
    const click = await tool("browser_click").execute("click", { session_id: "bses_fixture", ref: "e1" } as never);
    expect(click.details).toMatchObject({ structuredContent: { data: { arguments: { session_id: "bses_fixture", ref: "e1" } } } });
    const screenshot = await tool("browser_screenshot").execute("screenshot", { session_id: "bses_fixture" } as never);
    expect(screenshot.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "image", mimeType: "image/png", data: expect.any(String) })]));
    expect(tools.approvalHints(tool("browser_click").name)).toMatchObject({ readOnly: false, nonReplayable: true });
    expect(tools.approvalHints(tool("browser_snapshot").name)).toMatchObject({ readOnly: true, trustedReadOnly: true });
  });

  it("omits non-raster screenshot blocks", async () => {
    const server = browserServer();
    server.env.BERRY_TEST_IMAGE_MIME = "image/svg+xml";
    server.env.BERRY_TEST_IMAGE_DATA = "PHN2Zy8+";
    const screenshot = source(server).listTools().find((tool) => tool.name.endsWith("__berrycrawl_browser_screenshot"))!;
    const result = await screenshot.execute("invalid-image", { session_id: "bses_fixture" } as never);
    expect(result.content.filter((part) => part.type === "image")).toHaveLength(0);
    expect(JSON.stringify(result.content)).toContain("MCP image(s) omitted");
  });

  it("rejects malformed screenshot data at the MCP protocol boundary", async () => {
    const server = browserServer(); server.env.BERRY_TEST_IMAGE_DATA = "invalid base64!";
    const screenshot = source(server).listTools().find((tool) => tool.name.endsWith("__berrycrawl_browser_screenshot"))!;
    await expect(screenshot.execute("malformed-image", { session_id: "bses_fixture" } as never)).rejects.toThrow("Invalid Base64 string");
  });

  it("bounds screenshots from an MCP call to five images", async () => {
    const server = browserServer(); server.env.BERRY_TEST_IMAGE_COUNT = "6";
    const screenshot = source(server).listTools().find((tool) => tool.name.endsWith("__berrycrawl_browser_screenshot"))!;
    const result = await screenshot.execute("image-limit", { session_id: "bses_fixture" } as never);
    expect(result.content.filter((part) => part.type === "image")).toHaveLength(5);
    expect(JSON.stringify(result.content)).toContain("1 unsupported or oversized MCP image(s) omitted");
  });

  it("fails closed when a browser tool definition changes after review", async () => {
    const server = browserServer(); server.env.BERRY_TEST_CHANGED_TOOL = "berrycrawl_browser_click";
    const tools = source(server);
    const click = tools.listTools().find((tool) => tool.name.endsWith("__berrycrawl_browser_click"))!;
    await expect(click.execute("changed", { session_id: "bses_fixture", ref: "e1" } as never)).rejects.toThrow("definition changed after administrator review");
    expect(tools.listTools().some((tool) => tool.name.endsWith("__berrycrawl_browser_read"))).toBe(true);
  });

  it("honors an administrator's explicit tool restrictions", () => {
    const server = browserServer(); server.allowedTools = ["berrycrawl_browser_snapshot"];
    expect(source(server).listTools().map((tool) => tool.name)).toEqual(["mcp__BerryCrawl__berrycrawl_browser_snapshot"]);
  });
});
