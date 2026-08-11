import { describe, expect, it } from "vitest";
import { connectorArtifactText, durableMcpToolPolicy, sanitizeMcpJournalValue } from "./mcp-tools.js";

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
  it("allows organization full access to suppress custom MCP approval prompts", () => {
    const policy = durableMcpToolPolicy(
      {},
      { readOnly: true, destructive: false, idempotent: true, openWorld: false },
      "full-access",
    );

    expect(policy).toMatchObject({
      retryClass: "non_idempotent_manual",
      requiresApproval: false,
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

  it("allows high-impact Berry-owned connector actions under full access", () => {
    const policy = durableMcpToolPolicy(
      { trustReadOnlyAnnotations: true },
      { readOnly: false, requiresApproval: true, destructive: false, idempotent: false, openWorld: true },
      "full-access",
    );

    expect(policy).toMatchObject({ retryClass: "non_idempotent_manual", requiresApproval: false });
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

describe("connector artifact staging", () => {
  it("labels sandbox-first Drive downloads as temporary", () => {
    const text = connectorArtifactText(
      { fileId: "file-1", name: "brief.pdf", mediaType: "application/pdf", library: false },
      { name: "brief.pdf", mediaType: "application/pdf", path: "/workspace/inputs/file-1/brief.pdf" },
    );

    expect(text).toContain("Downloaded brief.pdf for temporary use in this task.");
    expect(text).toContain("Sandbox path: /workspace/inputs/file-1/brief.pdf");
    expect(text).toContain("not added to the Berry Library or project knowledge");
    expect(text).toContain("Use read_file on the sandbox path");
    expect(text).not.toContain("Searchable extraction is queued");
  });

  it("labels intentionally persisted Drive downloads as Library files", () => {
    const text = connectorArtifactText(
      { fileId: "file-1", name: "brief.pdf", mediaType: "application/pdf", library: true },
      { name: "brief.pdf", mediaType: "application/pdf", path: "/workspace/inputs/file-1/brief.pdf" },
    );

    expect(text).toContain("Saved brief.pdf to the Berry Library.");
    expect(text).toContain("searchable extraction is queued through Tika");
  });
});
