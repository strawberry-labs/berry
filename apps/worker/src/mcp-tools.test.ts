import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpToolSource, type McpServerSpec } from "@berry/local-agent/mcp";
import type { ChatToolDefinition } from "@berry/router-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DurableTurnSnapshot, DurableTurnStep, DurableTurnToolExecutor } from "./turn-runner.js";
import {
  boundedMcpText,
  connectorArtifactText,
  DurableMcpToolExecutor,
  durableMcpToolPolicy,
  sanitizeMcpJournalValue,
} from "./mcp-tools.js";

describe("durable MCP tool exposure", () => {
  it("declares connector abort support, keeps discovery non-abortable, and delegates core tools", () => {
    const baseSupportsAbort = vi.fn(() => true);
    const tools = new DurableMcpToolExecutor({
      supportsAbort: baseSupportsAbort,
      execute: vi.fn(async () => ({ output: {}, summary: "base" })),
    }, connectorServers(), undefined);
    const snapshot = mcpSnapshot("List my calendar events");

    expect(tools.supportsAbort(snapshot, {
      type: "tool.mcp__Google_Calendar__list_events",
      input: { toolName: "mcp__Google_Calendar__list_events", arguments: {} },
    } as never)).toBe(false);
    expect(tools.supportsAbort(snapshot, {
      type: "tool.tool_search",
      input: { toolName: "tool_search", arguments: { query: "calendar" } },
    } as never)).toBe(false);
    expect(tools.supportsAbort(snapshot, {
      type: "tool.read",
      input: { toolName: "read", arguments: { path: "/workspace/file.txt" } },
    } as never)).toBe(true);
    expect(baseSupportsAbort).toHaveBeenCalledTimes(1);
  });

  it("declares the same tools for every request and lists only the mentioned connector's tools as ready (H-032)", async () => {
    const inherited: ChatToolDefinition = {
      type: "function",
      function: { name: "remember_memory", description: "Remember a fact", parameters: { type: "object" } },
    };
    const base: DurableTurnToolExecutor = {
      definitions: vi.fn(async () => [inherited]),
      execute: vi.fn(async () => ({ output: {}, summary: "base" })),
    };
    const tools = new DurableMcpToolExecutor(base, connectorServers(), undefined);

    const calendar = mcpSnapshot("Show my calendar events tomorrow");
    const definitions = await tools.definitions(calendar);
    expect(definitions.map((definition) => definition.function.name)).toEqual(["remember_memory", "tool_search", "use_tool"]);
    // Another request, another connector: the declared tools are byte-identical.
    expect(JSON.stringify(await tools.definitions(mcpSnapshot("Search my email")))).toBe(JSON.stringify(definitions));
    expect(Buffer.byteLength(JSON.stringify(definitions), "utf8")).toBeLessThan(4_000);

    const context = await tools.turnContext(calendar);
    expect(context).toContain("Connectors available to this task: calendar (Google Calendar), gmail (Gmail)");
    expect(context).toContain("- mcp__Google_Calendar__list_events: ");
    expect(context).toContain("input schema: ");
    expect(context).not.toContain("mcp__Gmail__");
    expect(context).not.toContain("mcp__Google_Workspace__");
    expect(context).not.toContain("mcp__BerryCrawl__");
  });

  it("recovers a semantically selected connector when the request is a paraphrase", async () => {
    const tools = new DurableMcpToolExecutor({
      execute: vi.fn(async () => ({ output: {}, summary: "base" })),
    }, connectorServers(), undefined);
    const snapshot = mcpSnapshot("What appointments do I have tomorrow?");

    const initial = await tools.definitions(snapshot);
    expect(initial.map((definition) => definition.function.name)).toEqual(["tool_search", "use_tool"]);
    // The catalog lives in the turn context, not in a tool enum that changes with it.
    expect(JSON.stringify(initial[0]?.function.parameters)).not.toContain("enum");
    expect(await tools.turnContext(snapshot)).toMatch(/calendar \(Google Calendar\).*gmail \(Gmail\).*workspace.*crawl/);

    const result = await tools.execute(snapshot, {
      id: "search-appointments",
      sequence: 1,
      type: "tool.tool_search",
      state: "pending",
      input: {
        toolName: "tool_search",
        arguments: { query: "appointments tomorrow", connector: "calendar", limit: 5 },
      },
    } as never);

    expect(result.output).toMatchObject({
      connector: "calendar",
      activatedTools: ["mcp__Google_Calendar__list_events"],
      activatedServerIds: ["calendar"],
    });
  });

  it("accepts a connector display name when the model does not return its id", async () => {
    const tools = new DurableMcpToolExecutor({
      execute: vi.fn(async () => ({ output: {}, summary: "base" })),
    }, connectorServers(), undefined);
    const snapshot = mcpSnapshot("What appointments do I have tomorrow?");

    const result = await tools.execute(snapshot, {
      id: "search-appointments-by-name",
      type: "tool.tool_search",
      input: {
        toolName: "tool_search",
        arguments: { query: "appointments tomorrow", connector: "Google Calendar", limit: 5 },
      },
    } as never);

    expect(result.output).toMatchObject({
      connector: "calendar",
      activatedTools: ["mcp__Google_Calendar__list_events"],
    });
  });

  it("prefers an exact connector id over an earlier display-name alias", async () => {
    const alias = connectorServer(
      "calendar-alias",
      "calendar",
      true,
      "wrong_events",
      "List events from the alias connector",
    );
    const exact = connectorServer(
      "calendar",
      "Exact Calendar",
      true,
      "right_events",
      "List events from the exact connector",
    );
    const tools = new DurableMcpToolExecutor({
      execute: vi.fn(async () => ({ output: {}, summary: "base" })),
    }, [alias, exact], undefined);

    const result = await tools.execute(mcpSnapshot("List my events"), {
      id: "search-exact-calendar",
      type: "tool.tool_search",
      input: {
        toolName: "tool_search",
        arguments: { query: "events", connector: "calendar", limit: 5 },
      },
    } as never);

    expect(result.output).toMatchObject({
      connector: "calendar",
      activatedTools: ["mcp__Exact_Calendar__right_events"],
    });
  });

  it("rejects ambiguous connector display-name aliases", async () => {
    const tools = new DurableMcpToolExecutor({
      execute: vi.fn(async () => ({ output: {}, summary: "base" })),
    }, [
      connectorServer("first", "Shared Calendar", true, "first_events", "List first events"),
      connectorServer("second", "Shared Calendar", true, "second_events", "List second events"),
    ], undefined);

    await expect(tools.execute(mcpSnapshot("List my events"), {
      id: "search-ambiguous-calendar",
      type: "tool.tool_search",
      input: {
        toolName: "tool_search",
        arguments: { query: "events", connector: "shared calendar", limit: 5 },
      },
    } as never)).rejects.toThrow("Ambiguous connector alias");
  });

  it("exposes configured default connector tools without requiring a mention or tool_search", async () => {
    const berryCrawl = connectorServer(
      "berrycrawl",
      "BerryCrawl",
      true,
      "berrycrawl_search_web",
      "Search the web",
    );
    berryCrawl.defaultTools = ["berrycrawl_search_web"];
    const tools = new DurableMcpToolExecutor({
      execute: vi.fn(async () => ({ output: {}, summary: "base" })),
    }, [berryCrawl], undefined);

    const snapshot = mcpSnapshot("Answer this general question");
    const definitions = await tools.definitions(snapshot);

    expect(definitions.map((definition) => definition.function.name)).toEqual(["tool_search", "use_tool"]);
    expect(await tools.turnContext(snapshot)).toContain("- mcp__BerryCrawl__berrycrawl_search_web: Search the web\n  input schema: ");
  });

  it("discovers an initially omitted authorized tool and exposes it on the next model call", async () => {
    const base: DurableTurnToolExecutor = {
      execute: vi.fn(async () => ({ output: {}, summary: "base" })),
    };
    const tools = new DurableMcpToolExecutor(base, connectorServers(), undefined);
    const snapshot = mcpSnapshot("Answer the question");
    const initial = await tools.definitions(snapshot);
    expect(initial.map((definition) => definition.function.name)).toEqual(["tool_search", "use_tool"]);

    const searchStep = {
      id: "search-gmail",
      sequence: 1,
      type: "tool.tool_search",
      state: "pending",
      input: { toolName: "tool_search", arguments: { query: "email messages", limit: 5 } },
      output: null,
      retryClass: "read_only",
      idempotencyKey: "search-gmail",
      attempt: 0,
      error: null,
    } as const;
    const result = await tools.execute(snapshot, searchStep as never);
    expect(result.output).toMatchObject({
      activatedTools: ["mcp__Gmail__search_messages"],
      activatedServerIds: ["gmail"],
    });
    // The result carries the schema and how to run it, so the declared tools never change.
    expect(String(result.output && (result.output as { content: string }).content))
      .toMatch(/use_tool[\s\S]*- mcp__Gmail__search_messages: [^\n]*\n  input schema: \{/);
    snapshot.steps = [{ ...searchStep, state: "completed", output: result.output }] as never;

    expect(JSON.stringify(await tools.definitions(snapshot))).toBe(JSON.stringify(initial));
    expect(await tools.turnContext(snapshot)).toContain("- mcp__Gmail__search_messages: ");
  });

  it("keeps a connector revealed across turns after a successful tool_search", async () => {
    const tools = new DurableMcpToolExecutor({
      execute: vi.fn(async () => ({ output: {}, summary: "base" })),
    }, connectorServers(), undefined);
    const snapshot = mcpSnapshot("d.kelly@aesg.com");
    snapshot.entries = [{
      entryId: "entry-prior-tool-search",
      parentEntryId: null,
      entryType: "message",
      sequence: 1,
      payload: {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "tool_search",
          isError: false,
          content: [{
            type: "text",
            text: "Enabled connector tools for the next model call: mcp__Gmail__search_messages",
          }],
        },
      },
    }, {
      entryId: "entry-user",
      parentEntryId: "entry-prior-tool-search",
      entryType: "message",
      sequence: 2,
      payload: { type: "message", message: { role: "user", content: "d.kelly@aesg.com" } },
    }] as never;

    expect(await tools.turnContext(snapshot)).toContain("- mcp__Gmail__search_messages: ");
  });

  it("reveals an admitted connector after its first deferred call fails", async () => {
    const tools = new DurableMcpToolExecutor({
      execute: vi.fn(async () => ({ output: {}, summary: "base" })),
    }, connectorServers(), undefined);
    const snapshot = mcpSnapshot("Find the address for this person");
    const deferredStep = {
      id: "call-deferred-gmail",
      sequence: 1,
      type: "tool.mcp__Gmail__search_messages",
      state: "pending",
      input: {
        toolName: "mcp__Gmail__search_messages",
        arguments: { query: "d.kelly@aesg.com" },
      },
      output: null,
      retryClass: "read_only",
      idempotencyKey: "call-deferred-gmail",
      attempt: 0,
      error: null,
    } as const;

    let failure = "";
    try {
      await tools.execute(snapshot, deferredStep as never);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    expect(failure).toContain("Call tool_search for it to get its input schema, then run it with use_tool");
    snapshot.steps = [{ ...deferredStep, state: "failed", error: failure }] as never;

    expect(await tools.turnContext(snapshot)).toContain("- mcp__Gmail__search_messages: ");
  });

  it("keeps unauthorized connector schemas unavailable to exposure and discovery", async () => {
    const unauthorized = connectorServer("private-mail", "Private Mail", false, "read_secret", "Read private email");
    const tools = new DurableMcpToolExecutor({
      execute: vi.fn(async () => ({ output: {}, summary: "base" })),
    }, [...connectorServers(), unauthorized], undefined);
    const snapshot = mcpSnapshot("Read private email");

    const definitions = await tools.definitions(snapshot);
    expect(definitions.map((definition) => definition.function.name).some((name) => name.includes("Private_Mail"))).toBe(false);
    const search = await tools.execute(snapshot, {
      id: "search-private",
      type: "tool.tool_search",
      input: { toolName: "tool_search", arguments: { query: "private secret" } },
    } as never);
    expect(search.output).toMatchObject({ activatedTools: [], activatedServerIds: [] });
    await expect(tools.execute(snapshot, {
      id: "search-private-by-id",
      type: "tool.tool_search",
      input: {
        toolName: "tool_search",
        arguments: { query: "private secret", connector: "private-mail" },
      },
    } as never)).rejects.toThrow("Unknown or unauthorized connector");
    await expect(tools.execute(snapshot, {
      id: "call-private",
      type: "tool.mcp__Private_Mail__read_secret",
      input: { toolName: "mcp__Private_Mail__read_secret", arguments: {} },
    } as never)).rejects.toThrow("not enabled for this turn");
  });

  it("keeps tool discovery read-only while preserving MCP approval policy", () => {
    const tools = new DurableMcpToolExecutor({
      execute: vi.fn(async () => ({ output: {}, summary: "base" })),
    }, connectorServers(), undefined);
    const snapshot = mcpSnapshot("calendar");

    expect(tools.policy(snapshot, "tool_search", "ask")).toEqual({
      retryClass: "read_only",
      repeatPolicy: "compare_result",
      requiresApproval: false,
      approvalKind: "mcp",
    });
    expect(tools.policy(snapshot, "mcp__Gmail__search_messages", "ask"))
      .toMatchObject({ retryClass: "read_only", requiresApproval: false });
  });

  it("preserves approval classification and lazily executes an exposed connector tool", async () => {
    const fixturePath = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../packages/local-agent/test/fixtures/mcp-echo-server.mjs",
    );
    const server: McpServerSpec = {
      id: "echo",
      name: "echo",
      transport: "stdio",
      command: process.execPath,
      args: [fixturePath],
      url: null,
      env: {},
      enabled: true,
      trusted: true,
      cachedTools: [{
        name: "echo",
        description: "Echo a message",
        inputSchema: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
        },
      }],
    };
    const tools = new DurableMcpToolExecutor({
      execute: vi.fn(async () => ({ output: {}, summary: "base" })),
    }, [server], undefined);
    const snapshot = mcpSnapshot("Echo this message");

    expect(await tools.turnContext(snapshot)).toContain("- mcp__echo__echo: Echo a message");
    expect(tools.policy(snapshot, "mcp__echo__echo", "ask"))
      .toMatchObject({ requiresApproval: true, approvalKind: "mcp" });
    await expect(tools.execute(snapshot, {
      id: "call-echo",
      type: "tool.mcp__echo__echo",
      input: {
        toolCallId: "call-echo",
        toolName: "mcp__echo__echo",
        arguments: { message: "berry" },
      },
    } as never)).resolves.toMatchObject({
      output: { content: "echo: berry", tool: "mcp__echo__echo" },
    });
    await tools.close();
  });

  it("keeps tool_search available and bootstraps a connector without cached schemas", async () => {
    const fixturePath = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../packages/local-agent/test/fixtures/mcp-echo-server.mjs",
    );
    const server: McpServerSpec = {
      id: "echo-live",
      name: "Live Echo",
      transport: "stdio",
      command: process.execPath,
      args: [fixturePath],
      url: null,
      env: {},
      enabled: true,
      trusted: true,
    };
    const tools = new DurableMcpToolExecutor({
      execute: vi.fn(async () => ({ output: {}, summary: "base" })),
    }, [server], undefined);
    const snapshot = mcpSnapshot("Find an echo capability");

    expect((await tools.definitions(snapshot)).map((definition) => definition.function.name))
      .toEqual(["tool_search", "use_tool"]);
    await expect(tools.execute(snapshot, {
      id: "search-live-echo",
      type: "tool.tool_search",
      input: {
        toolCallName: "tool_search",
        toolName: "tool_search",
        arguments: { query: "echo message", connector: "echo-live" },
      },
    } as never)).resolves.toMatchObject({
      output: {
        connector: "echo-live",
        activatedTools: expect.arrayContaining(["mcp__Live_Echo__echo"]),
      },
    });

    await tools.close();
  });

  it("releases admitted per-turn connector contexts without finalizing artifacts", async () => {
    const release = vi.fn(async () => undefined);
    const finalize = vi.fn(async () => []);
    const tools = new DurableMcpToolExecutor({
      execute: vi.fn(async () => ({ output: {}, summary: "base" })),
      release,
      finalize,
    }, [], undefined);
    const snapshot = mcpSnapshot("Search my workspace");
    const firstDrive = connectorServer(
      "first-drive",
      "First Drive",
      true,
      "search_first",
      "Search the first drive",
    );
    firstDrive.defaultTools = ["search_first"];
    snapshot.runtimeRequest = admittedRuntimeRequest(
      snapshot,
      firstDrive,
    );

    expect(await tools.turnContext(snapshot)).toContain("- mcp__First_Drive__search_first: ");

    await tools.release(snapshot);
    expect(release).toHaveBeenCalledOnce();
    expect(finalize).not.toHaveBeenCalled();

    const secondDrive = connectorServer(
      "second-drive",
      "Second Drive",
      true,
      "search_second",
      "Search the second drive",
    );
    secondDrive.defaultTools = ["search_second"];
    snapshot.runtimeRequest = admittedRuntimeRequest(snapshot, secondDrive);
    const refreshed = await tools.turnContext(snapshot);
    expect(refreshed).toContain("- mcp__Second_Drive__search_second: ");
    expect(refreshed).not.toContain("mcp__First_Drive__search_first");

    await tools.close();
  });
});

describe("admitted connectors on runs with stored metadata", () => {
  it("keeps the admitted connector for queued, Continue and recovered runs and refuses an invalid snapshot", async () => {
    const tools = new DurableMcpToolExecutor({ execute: vi.fn(async () => ({ output: {}, summary: "base" })) }, [], undefined);
    const drive = connectorServer("org-drive", "Org Drive", true, "search_files", "Search the organization drive");
    drive.defaultTools = ["search_files"];
    const snapshot = mcpSnapshot("Search my workspace");
    snapshot.runtimeRequest = {
      ...admittedRuntimeRequest(snapshot, drive),
      queuedBudgetRequestId: "queued:browser-key",
      continuationSourceRunId: "00000000-0000-7000-8000-000000000099",
      continuationHeadEntryId: "entry-head",
      budgetBaseRequestId: "request_1",
      budgetGeneration: 1,
      budgetUsageAfterSequence: 12,
      budgetBaselineCostMicros: "5000",
    };
    expect(await tools.turnContext(snapshot)).toContain("- mcp__Org_Drive__search_files: ");
    await tools.release(snapshot);

    snapshot.runtimeRequest = { ...snapshot.runtimeRequest, unexpectedSetting: true };
    await expect(tools.turnContext(snapshot)).rejects.toThrow("admitted model configuration is invalid (unexpectedSetting)");
    await tools.close();
  });
});

describe("durable MCP journal serialization", () => {
  it("says what it left out when a value exceeds the journal limits (H-070)", () => {
    const fields = Object.fromEntries(Array.from({ length: 130 }, (_, index) => [`field${index}`, index]));
    const value = sanitizeMcpJournalValue({
      text: "x".repeat(120_005),
      files: Array.from({ length: 260 }, (_, index) => ({ id: `file-${index}` })),
      fields,
    }) as { text: string; files: unknown[]; fields: Record<string, unknown> };

    expect(value.text).toHaveLength(120_000 + "…[Berry kept 120,000 of 120,005 characters]".length);
    expect(value.text.endsWith("…[Berry kept 120,000 of 120,005 characters]")).toBe(true);
    expect(value.files).toHaveLength(257);
    expect(value.files.at(-1)).toBe("[Berry omitted 4 more of 260 items]");
    expect(Object.keys(value.fields)).toHaveLength(129);
    expect(value.fields.berryOmittedFields).toBe("2 more of 130 fields");

    const small = { text: "ok", files: [{ id: "a" }], fields: { a: 1 } };
    expect(sanitizeMcpJournalValue(small)).toEqual(small);
  });

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

  it("does not replay billed Berry-owned reads after an ambiguous interruption", () => {
    const policy = durableMcpToolPolicy(
      { trustReadOnlyAnnotations: true },
      {
        readOnly: true,
        trustedReadOnly: true,
        nonReplayable: true,
        destructive: false,
        idempotent: true,
        openWorld: true,
      },
      "full-access",
    );

    expect(policy).toMatchObject({
      retryClass: "non_idempotent_manual",
      requiresApproval: false,
    });
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
    expect(text).toContain("Use read on the sandbox path");
    expect(text).not.toContain("Searchable extraction is queued");
  });

  it("says a just-imported file is still verifying instead of implying a usable path", () => {
    const text = connectorArtifactText(
      { fileId: "file-1", name: "rfp.pdf", mediaType: "application/pdf", library: false },
      undefined,
    );

    expect(text).toContain("Berry is still verifying rfp.pdf (Berry file file-1), so it is not in the sandbox yet");
    expect(text).toContain("Call this tool again with the same arguments");
    expect(text).toContain("does not download it again");
    expect(text).toContain("Do not search the filesystem");
    expect(text).not.toContain("Sandbox path");
  });

  it("keeps the artifact wording where sandbox staging is not available", () => {
    const text = connectorArtifactText({ fileId: "file-1", name: "rfp.pdf", mediaType: "application/pdf", library: false }, undefined, false);
    expect(text).toContain("The file is stored as a task-scoped Berry artifact.");
    expect(text).not.toContain("still verifying");
  });

  it("states the stored file's exact size and SHA-256 when the connector supplies them", () => {
    const sha256 = "9f".repeat(32);
    const sha256Base64 = Buffer.from(sha256, "hex").toString("base64");
    const text = connectorArtifactText(
      { fileId: "file-1", name: "RFP.pdf", mediaType: "application/pdf", library: false, size: 48231, sha256, sha256Base64 },
      { name: "RFP.pdf", mediaType: "application/pdf", path: "/workspace/inputs/file-1/RFP.pdf" },
    );

    expect(text).toContain("Sandbox path: /workspace/inputs/file-1/RFP.pdf");
    expect(text).toContain(`Media type: application/pdf. Size: 48231 bytes. SHA-256 (hex): ${sha256}. SHA-256 (base64): ${sha256Base64}.`);
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

describe("connector import readiness receipts (H-068)", () => {
  const toolName = "mcp__Google_Workspace__drive_read_file";
  const fileId = "e18d2b46-19de-8e63-9d14-13045a8abb6f";
  const path = `/workspace/inputs/${fileId}/site photo.png`;
  const artifact = {
    fileId, name: "site photo.png", mediaType: "image/png", size: 425382, origin: "connector_import",
    reused: false, status: "available", library: false, sourceFileId: "drive-source-1",
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // One Drive tool whose remote call returns a connector receipt like task
  // 2743dd77's: a Berry file id and metadata, but no sandbox path.
  function readinessExecutor(stage: NonNullable<DurableTurnToolExecutor["stageAssociatedInputFiles"]>, receipt: Record<string, unknown> = artifact) {
    const remote = vi.fn(async () => ({
      content: [{ type: "text" as const, text: JSON.stringify({ artifact: receipt }) }],
      details: { structuredContent: { artifact: receipt } },
    }));
    const listTools = McpToolSource.prototype.listTools;
    vi.spyOn(McpToolSource.prototype, "listTools").mockImplementation(function (this: McpToolSource) {
      return listTools.call(this).map((tool) => (tool.name === toolName ? { ...tool, execute: remote } : tool));
    });
    const stageAssociatedInputFiles = vi.fn(stage);
    const tools = new DurableMcpToolExecutor({
      execute: vi.fn(async () => ({ output: {}, summary: "base" })),
      stageAssociatedInputFiles,
    }, [connectorServer("workspace", "Google Workspace", true, "drive_read_file", "Read a Google Drive file and download it")], undefined);
    return { tools, remote, stageAssociatedInputFiles };
  }

  function driveStep(sequence: number, args: Record<string, unknown> = { fileId: "drive-source-1" }) {
    return {
      id: `drive-read-${sequence}`,
      sequence,
      type: `tool.${toolName}`,
      state: "running",
      input: { toolName, toolCallId: `call-${sequence}`, arguments: args },
    } as unknown as DurableTurnStep;
  }

  function driveSnapshot() {
    return mcpSnapshot("Open the Google Drive file site photo.png and read it");
  }

  it("returns a readable path with the original file identity once staging succeeds", async () => {
    const { tools, remote } = readinessExecutor(async () => [{ fileId, name: artifact.name, mediaType: artifact.mediaType, path }]);
    const snapshot = driveSnapshot();
    const step = driveStep(1);
    snapshot.steps.push(step);

    const result = await tools.execute(snapshot, step);

    expect(remote).toHaveBeenCalledTimes(1);
    expect(result.output).toMatchObject({
      stagingStatus: "ready",
      artifacts: [{ fileId, name: "site photo.png", mediaType: "image/png", path }],
    });
    expect(String(record(result.output)?.content)).toContain(`Sandbox path: ${path}`);
  });

  it("passes the connector's size and SHA-256 to the model", async () => {
    const sha256 = "ab".repeat(32);
    const sha256Base64 = Buffer.from(sha256, "hex").toString("base64");
    const { tools } = readinessExecutor(async () => [{ fileId, name: artifact.name, mediaType: artifact.mediaType, path }], { ...artifact, sha256, sha256Base64 });
    const snapshot = driveSnapshot();
    const step = driveStep(1);
    snapshot.steps.push(step);

    const text = String(record((await tools.execute(snapshot, step)).output)?.content);

    expect(text).toContain(`Size: 425382 bytes. SHA-256 (hex): ${sha256}. SHA-256 (base64): ${sha256Base64}.`);
  });

  it("leaves out a digest that is not a SHA-256", async () => {
    const { tools } = readinessExecutor(async () => [{ fileId, name: artifact.name, mediaType: artifact.mediaType, path }], { ...artifact, sha256: "not-a-digest", sha256Base64: "short" });
    const snapshot = driveSnapshot();
    const step = driveStep(1);
    snapshot.steps.push(step);

    const text = String(record((await tools.execute(snapshot, step)).output)?.content);

    expect(text).toContain("Size: 425382 bytes.");
    expect(text).not.toContain("SHA-256");
  });

  it("reports pending verification, then resumes staging without a second remote download", async () => {
    let verified = false;
    const { tools, remote, stageAssociatedInputFiles } = readinessExecutor(async () => (
      verified ? [{ fileId, name: artifact.name, mediaType: artifact.mediaType, path }] : []
    ));
    const snapshot = driveSnapshot();
    const first = driveStep(1);
    snapshot.steps.push(first);

    const pending = await tools.execute(snapshot, first);

    expect(pending.output).toMatchObject({ stagingStatus: "pending_verification" });
    expect(record(pending.output)?.artifacts).toBeUndefined();
    const pendingText = String(record(pending.output)?.content);
    expect(pendingText).toContain(`Berry file ${fileId}`);
    expect(pendingText).toContain("does not download it again");
    expect(pendingText).not.toContain("Sandbox path");

    Object.assign(first, { state: "completed", output: pending.output });
    verified = true;
    const retry = driveStep(2);
    snapshot.steps.push(retry);
    const resumed = await tools.execute(snapshot, retry);

    expect(remote).toHaveBeenCalledTimes(1);
    expect(stageAssociatedInputFiles).toHaveBeenCalledTimes(2);
    expect(stageAssociatedInputFiles.mock.calls[1]?.[1]).toEqual([fileId]);
    expect(resumed.output).toMatchObject({ stagingStatus: "ready", resumedFromStep: first.id, artifacts: [{ fileId, path }] });
    expect(String(record(resumed.output)?.content)).toContain("It was not added to the Berry Library");
  });

  it("turns a staging failure of a verified file into an actionable receipt and retries without downloading", async () => {
    let attempts = 0;
    const { tools, remote } = readinessExecutor(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("NoSuchKey: The specified key does not exist.");
      return [{ fileId, name: artifact.name, mediaType: artifact.mediaType, path }];
    });
    const snapshot = driveSnapshot();
    const first = driveStep(1);
    snapshot.steps.push(first);

    const failed = await tools.execute(snapshot, first);

    expect(failed.output).toMatchObject({ stagingStatus: "failed", stagingError: "NoSuchKey: The specified key does not exist." });
    const failedText = String(record(failed.output)?.content);
    expect(failedText).toContain("could not copy site photo.png");
    expect(failedText).toContain("It is not at any sandbox path");
    expect(failedText).not.toContain("Sandbox path:");

    Object.assign(first, { state: "completed", output: failed.output });
    const retry = driveStep(2);
    snapshot.steps.push(retry);
    const recovered = await tools.execute(snapshot, retry);

    expect(remote).toHaveBeenCalledTimes(1);
    expect(recovered.output).toMatchObject({ stagingStatus: "ready", resumedFromStep: first.id });
  });

  it("calls the remote tool again when the arguments name a different file", async () => {
    const { tools, remote } = readinessExecutor(async () => []);
    const snapshot = driveSnapshot();
    const first = driveStep(1);
    snapshot.steps.push(first);
    const pending = await tools.execute(snapshot, first);
    Object.assign(first, { state: "completed", output: pending.output });

    const other = driveStep(2, { fileId: "drive-source-2" });
    snapshot.steps.push(other);
    await tools.execute(snapshot, other);

    expect(remote).toHaveBeenCalledTimes(2);
  });

  it("propagates cancellation instead of returning a receipt", async () => {
    let staging!: () => void;
    const stagingStarted = new Promise<void>((resolve) => { staging = resolve; });
    // Like the manager's wait: settles only through the signal.
    const { tools } = readinessExecutor(async (_snapshot, _fileIds, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
      staging();
    }));
    const snapshot = driveSnapshot();
    const step = driveStep(1);
    snapshot.steps.push(step);
    const controller = new AbortController();

    const pending = tools.execute(snapshot, step, controller.signal);
    await stagingStarted;
    controller.abort(new Error("Task cancelled"));

    await expect(pending).rejects.toThrow("Task cancelled");
  });
});

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function connectorServers(): McpServerSpec[] {
  return [
    connectorServer("calendar", "Google Calendar", true, "list_events", "List calendar events and meetings"),
    connectorServer("gmail", "Gmail", true, "search_messages", "Search email messages"),
    connectorServer("workspace", "Google Workspace", true, "search_drive", "Search Drive files and documents"),
    connectorServer("crawl", "BerryCrawl", true, "search_web", "Search and crawl websites"),
  ];
}

function connectorServer(
  id: string,
  name: string,
  trusted: boolean,
  toolName: string,
  description: string,
): McpServerSpec {
  return {
    id,
    name,
    transport: "streamable-http",
    command: null,
    args: [],
    url: `https://${id}.example.test/mcp`,
    env: {},
    enabled: true,
    trusted,
    cachedTools: [{
      name: toolName,
      description,
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true, idempotentHint: true },
    }],
    trustReadOnlyAnnotations: true,
  };
}

function mcpSnapshot(input: string): DurableTurnSnapshot & { steps: DurableTurnStep[] } {
  return {
    id: "00000000-0000-7000-8000-000000000901",
    tenantId: "00000000-0000-7000-8000-000000000001",
    userId: "user-1",
    runtimeRequest: { input, permissionMode: "ask" },
    steps: [],
    entries: [{
      entryId: "entry-user",
      parentEntryId: null,
      entryType: "message",
      sequence: 1,
      payload: { type: "message", message: { role: "user", content: input } },
    }],
    approvals: [],
  } as unknown as DurableTurnSnapshot & { steps: DurableTurnStep[] };
}

function admittedRuntimeRequest(
  snapshot: DurableTurnSnapshot,
  server: McpServerSpec,
): DurableTurnSnapshot["runtimeRequest"] {
  return {
    capabilityVersion: 1,
    input: "Search my workspace",
    providerId: "router",
    provider: {
      id: "router",
      name: "Berry Router",
      kind: "berry-router",
      baseUrl: "https://router.example.test/v1",
      defaultModel: "test-model",
      apiType: "openai-chat-completions",
      authType: "none",
      models: [],
    },
    model: "test-model",
    conversationKind: "chat",
    workspacePath: "/workspace",
    workspaceId: snapshot.workspaceId ?? "workspace-1",
    permissionMode: "ask",
    reasoning: "off",
    maxTokens: 1_000,
    contextWindowTokens: 16_000,
    modelAcceptsImages: false,
    modelPricing: {},
    builtInTools: [],
    mcpServers: [server],
    extraSkills: [],
    attachments: [],
  } as DurableTurnSnapshot["runtimeRequest"];
}

describe("bounded MCP results", () => {
  const cursor = `~!!~${"A".repeat(440)}`;
  const files = Array.from({ length: 100 }, (_, index) => ({
    id: `file-${index}`,
    name: `Tender appendix ${index}.pdf`,
    mimeType: "application/pdf",
    capabilities: Object.fromEntries(Array.from({ length: 40 }, (_unused, key) => [`canDoThing${key}`, key % 2 === 0])),
    contentRestrictions: [{ readOnly: false, reason: "x".repeat(1_300) }],
    owners: [{ displayName: "Owner", emailAddress: "owner@example.com" }],
  }));
  const listing = JSON.stringify({ files, nextPageToken: cursor, incompleteSearch: false });

  it("keeps a metadata-heavy Drive page valid JSON with its exact cursor and a disclosed cut", () => {
    expect(listing.length).toBeGreaterThan(200_000);
    const bounded = boundedMcpText(listing, { files, nextPageToken: cursor });
    expect(bounded.length).toBeLessThanOrEqual(120_000);
    const parsed = JSON.parse(bounded) as { files: Array<{ id: string }>; nextPageToken: string; berryTruncation: { returnedItems: number; totalItems: number; field: string } };
    expect(parsed.nextPageToken).toBe(cursor);
    expect(parsed.berryTruncation).toMatchObject({ field: "files", totalItems: 100 });
    expect(parsed.berryTruncation.returnedItems).toBe(parsed.files.length);
    expect(parsed.files.map((file) => file.id)).toEqual(files.slice(0, parsed.files.length).map((file) => file.id));
  });

  it("restores a cursor that exists only in structured metadata", () => {
    const withoutCursor = JSON.stringify({ files });
    const parsed = JSON.parse(boundedMcpText(withoutCursor, { files, nextPageToken: cursor })) as { nextPageToken: string };
    expect(parsed.nextPageToken).toBe(cursor);
  });

  it("marks a cut in non-JSON text with counts and the exact cursor", () => {
    const bounded = boundedMcpText("line\n".repeat(40_000), { nextCursor: "cursor-2" });
    expect(bounded.length).toBeLessThanOrEqual(120_000);
    expect(bounded).toContain("[Berry truncated this tool result: showing 120,000 of 200,000 characters.");
    expect(bounded).toContain("Exact next-page cursor: cursor-2]");
  });

  it("leaves results within the limit unchanged", () => {
    expect(boundedMcpText(JSON.stringify({ files: files.slice(0, 2), nextPageToken: cursor }))).toBe(JSON.stringify({ files: files.slice(0, 2), nextPageToken: cursor }));
  });
});
