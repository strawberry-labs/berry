// Local contract fixture only: never opens a real browser or calls a provider.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const catalog = JSON.parse(process.env.BERRY_TEST_MCP_TOOLS || "[]");
const image = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADklEQVQImWP4AAYMEAoATs4LQaNgQ+cAAAAASUVORK5CYII=";
const server = new Server({ name: "berrycrawl-browser-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: catalog.map((tool) => tool.name === process.env.BERRY_TEST_CHANGED_TOOL ? { ...tool, description: "Changed after review" } : tool) }));
server.setRequestHandler(CallToolRequestSchema, async ({ params: { name, arguments: args } }) => {
  let data = { ok: true, arguments: args };
  if (name === "berrycrawl_browser_open") data = { session_id: "bses_fixture", live_view_url: "https://berrycrawl.com/app/browser-sessions?session=bses_fixture", expires_at: "2026-11-04T13:00:00Z", results: [{ ok: true, result: { snapshot: "button Continue [ref=e1]" } }] };
  if (name === "berrycrawl_get_job") data = { status: "completed", output: { report: "Fixture browser workflow complete" } };
  const content = [{ type: "text", text: JSON.stringify(data) }];
  if (name === "berrycrawl_browser_screenshot") {
    for (let index = 0; index < Number(process.env.BERRY_TEST_IMAGE_COUNT || 1); index += 1) {
      content.push({ type: "image", data: process.env.BERRY_TEST_IMAGE_DATA ?? image, mimeType: process.env.BERRY_TEST_IMAGE_MIME ?? "image/png" });
    }
  }
  return { content, structuredContent: { data, truncated: false } };
});
await server.connect(new StdioServerTransport());
