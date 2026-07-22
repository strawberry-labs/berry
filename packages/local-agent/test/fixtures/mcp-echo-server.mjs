// Minimal stdio MCP server used by the McpToolSource unit tests.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "echo", version: "1.0.0" });

server.registerTool(
  "echo",
  {
    description: "Echo a message back",
    inputSchema: { message: z.string() },
  },
  async ({ message }) => ({ content: [{ type: "text", text: `echo: ${message}` }] }),
);

server.registerTool(
  "fail",
  {
    description: "Always fails",
    inputSchema: {},
  },
  async () => ({ isError: true, content: [{ type: "text", text: "intentional failure" }] }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
