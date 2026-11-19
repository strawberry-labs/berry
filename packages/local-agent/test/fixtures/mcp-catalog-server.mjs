// Stdio MCP server whose tool catalog is read from MCP_CATALOG_FILE on every
// tools/list, so tests can add, change and remove tools while connected.
//   MCP_CATALOG_PAGE_SIZE  tools per tools/list page (default: all)
//   MCP_CATALOG_DELAY_MS   delay before answering tools/list
//   MCP_CATALOG_LOG        file that gets one line per tools/list request
// Calling the tool "notify_tools_changed" sends notifications/tools/list_changed.
import { appendFileSync, readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "catalog", version: "1.0.0" },
  { capabilities: { tools: { listChanged: true } } },
);

server.setRequestHandler(ListToolsRequestSchema, async (request) => {
  if (process.env.MCP_CATALOG_LOG) appendFileSync(process.env.MCP_CATALOG_LOG, "list\n");
  const delay = Number(process.env.MCP_CATALOG_DELAY_MS) || 0;
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  const tools = JSON.parse(readFileSync(process.env.MCP_CATALOG_FILE, "utf8"));
  const size = Number(process.env.MCP_CATALOG_PAGE_SIZE) || Math.max(tools.length, 1);
  const start = Number(request.params?.cursor ?? 0);
  const next = start + size < tools.length ? String(start + size) : undefined;
  return { tools: tools.slice(start, start + size), ...(next ? { nextCursor: next } : {}) };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "notify_tools_changed") {
    await server.sendToolListChanged();
    return { content: [{ type: "text", text: "notified" }] };
  }
  return { content: [{ type: "text", text: `${request.params.name}: ${JSON.stringify(request.params.arguments ?? {})}` }] };
});

await server.connect(new StdioServerTransport());
