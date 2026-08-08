import { describe, expect, it } from "vitest";
import { durableMcpToolPolicy, sanitizeMcpJournalValue } from "./mcp-tools.js";

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

describe("durable MCP approval policy", () => {
  it("never trusts a custom server's read-only annotation", () => {
    const policy = durableMcpToolPolicy(
      {},
      { readOnly: true, destructive: false, idempotent: true, openWorld: false },
      "full-access",
    );

    expect(policy).toMatchObject({
      retryClass: "non_idempotent_manual",
      requiresApproval: true,
      approvalKind: "mcp",
    });
  });

  it("allows Berry-owned read-only adapters to run without approval", () => {
    const policy = durableMcpToolPolicy(
      { trustReadOnlyAnnotations: true },
      { readOnly: true, trustedReadOnly: true, destructive: false, idempotent: true, openWorld: false },
      "default",
    );

    expect(policy).toMatchObject({ retryClass: "read_only", requiresApproval: false });
  });

  it("always requires approval for high-impact Berry-owned connector actions", () => {
    const policy = durableMcpToolPolicy(
      { trustReadOnlyAnnotations: true },
      { readOnly: false, requiresApproval: true, destructive: false, idempotent: false, openWorld: true },
      "full-access",
    );

    expect(policy).toMatchObject({ retryClass: "non_idempotent_manual", requiresApproval: true });
  });

  it("keeps reviewable native drafts approval-free in full-access tasks", () => {
    const policy = durableMcpToolPolicy(
      { trustReadOnlyAnnotations: true },
      { readOnly: false, destructive: false, idempotent: false, openWorld: true },
      "full-access",
    );

    expect(policy).toMatchObject({ requiresApproval: false });
  });
});
