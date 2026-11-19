// Stdio MCP server whose create_record declares an output schema, used to
// check what Berry concludes when a create fails after the server ran it.
// RECORD_WRITES names a file that gets one line per accepted create.
// RECORD_OUTPUT sets the first create's result: "valid" (default),
// "malformed" (the id is a number) or "missing" (no structured content).
// RECORD_ERROR_CODE instead makes the first create save the record and then
// return an error result with that code, from a tool without an output schema.
// RECORD_ERROR_STATUS adds a nested status; RECORD_RPC_CODE returns a JSON-RPC error.
import { appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "records", version: "1.0.0" }, { capabilities: { tools: {} } });
const errorCode = process.env.RECORD_ERROR_CODE;

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: "create_record",
    description: "Create one record",
    inputSchema: { type: "object", properties: { title: { type: "string" }, note: { type: "string" } }, required: ["title"] },
    ...(errorCode ? {} : { outputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } }),
  }],
}));

let created = 0;
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  created += 1;
  if (process.env.RECORD_WRITES) appendFileSync(process.env.RECORD_WRITES, `${JSON.stringify(request.params.arguments)}\n`);
  if (created === 1 && errorCode) {
    const message = "The record was saved, but updating its search index failed";
    if (process.env.RECORD_RPC_CODE) throw new McpError(Number(process.env.RECORD_RPC_CODE), message);
    return { isError: true, content: [{ type: "text", text: message }], structuredContent: { error: {
      code: errorCode, message,
      ...(process.env.RECORD_ERROR_STATUS ? { status: Number(process.env.RECORD_ERROR_STATUS) } : {}),
    } } };
  }
  const output = created === 1 ? process.env.RECORD_OUTPUT ?? "valid" : "valid";
  if (output === "missing") return { content: [{ type: "text", text: "Created" }] };
  return {
    content: [{ type: "text", text: "Created" }],
    structuredContent: { id: output === "malformed" ? created : `record-${created}` },
  };
});

await server.connect(new StdioServerTransport());
