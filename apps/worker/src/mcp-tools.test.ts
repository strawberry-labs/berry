import { describe, expect, it } from "vitest";
import { sanitizeMcpJournalValue } from "./mcp-tools.js";

describe("durable MCP journal serialization", () => {
  it("redacts binary content from both parts and raw result details", () => {
    const binary = "a".repeat(32_000);

    const value = sanitizeMcpJournalValue({
      raw: [
        { type: "text", text: "Visible result" },
        { type: "image", data: binary, mimeType: "image/png" },
        { type: "resource", resource: { blob: binary, mimeType: "application/pdf" } },
      ],
      nested: { data: binary },
    });

    expect(JSON.stringify(value)).not.toContain(binary);
    expect(value).toMatchObject({
      raw: [
        { type: "text", text: "Visible result" },
        {
          type: "image",
          mimeType: "image/png",
          omitted: "binary MCP content is not stored in the journal",
        },
        {
          type: "resource",
          omitted: "binary MCP content is not stored in the journal",
        },
      ],
      nested: {
        data: "[omitted: binary MCP content is not stored in the journal]",
      },
    });
  });
});
