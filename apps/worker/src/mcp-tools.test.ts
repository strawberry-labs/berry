import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServerSpec } from "@berry/local-agent/mcp";
import type { ChatToolDefinition } from "@berry/router-client";
import { describe, expect, it, vi } from "vitest";
import type { DurableTurnSnapshot, DurableTurnStep, DurableTurnToolExecutor } from "./turn-runner.js";
import {
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

  it("exposes only the relevant calendar connector plus core and lazy discovery tools", async () => {
    const inherited: ChatToolDefinition = {
      type: "function",
      function: { name: "remember_memory", description: "Remember a fact", parameters: { type: "object" } },
    };
    const base: DurableTurnToolExecutor = {
      definitions: vi.fn(async () => [inherited]),
      execute: vi.fn(async () => ({ output: {}, summary: "base" })),
    };
    const tools = new DurableMcpToolExecutor(base, connectorServers(), undefined);

    const definitions = await tools.definitions(mcpSnapshot("Show my calendar events tomorrow"));
    const names = definitions.map((definition) => definition.function.name);

    expect(names).toContain("remember_memory");
    expect(names).toContain("tool_search");
    expect(names).toContain("mcp__Google_Calendar__list_events");
    expect(names.some((name) => name.startsWith("mcp__Gmail__"))).toBe(false);
    expect(names.some((name) => name.startsWith("mcp__Google_Workspace__"))).toBe(false);
    expect(names.some((name) => name.startsWith("mcp__BerryCrawl__"))).toBe(false);
    expect({
      toolCount: definitions.length,
      serializedBytes: Buffer.byteLength(JSON.stringify(definitions), "utf8"),
    }).toMatchObject({ toolCount: 3, serializedBytes: expect.any(Number) });
    expect(Buffer.byteLength(JSON.stringify(definitions), "utf8")).toBeLessThan(4_000);
  });

  it("recovers a semantically selected connector when the request is a paraphrase", async () => {
    const tools = new DurableMcpToolExecutor({
      execute: vi.fn(async () => ({ output: {}, summary: "base" })),
    }, connectorServers(), undefined);
    const snapshot = mcpSnapshot("What appointments do I have tomorrow?");

    const initial = await tools.definitions(snapshot);
    expect(initial.map((definition) => definition.function.name)).toEqual(["tool_search"]);
    expect(initial[0]?.function.parameters).toMatchObject({
      properties: {
        connector: { enum: expect.arrayContaining(["calendar", "gmail", "workspace", "crawl"]) },
      },
    });

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

    const definitions = await tools.definitions(mcpSnapshot("Answer this general question"));

    expect(definitions.map((definition) => definition.function.name)).toEqual([
      "tool_search",
      "mcp__BerryCrawl__berrycrawl_search_web",
    ]);
  });

  it("discovers an initially omitted authorized tool and exposes it on the next model call", async () => {
    const base: DurableTurnToolExecutor = {
      execute: vi.fn(async () => ({ output: {}, summary: "base" })),
    };
    const tools = new DurableMcpToolExecutor(base, connectorServers(), undefined);
    const snapshot = mcpSnapshot("Answer the question");
    const initial = await tools.definitions(snapshot);
    expect(initial.map((definition) => definition.function.name)).toEqual(["tool_search"]);

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
    snapshot.steps = [{ ...searchStep, state: "completed", output: result.output }] as never;

    const revealed = await tools.definitions(snapshot);
    expect(revealed.map((definition) => definition.function.name))
      .toContain("mcp__Gmail__search_messages");
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

    const definitions = await tools.definitions(snapshot);

    expect(definitions.map((definition) => definition.function.name))
      .toContain("mcp__Gmail__search_messages");
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
    expect(failure).toContain("connector is now enabled for the next model call");
    snapshot.steps = [{ ...deferredStep, state: "failed", error: failure }] as never;

    const definitions = await tools.definitions(snapshot);
    expect(definitions.map((definition) => definition.function.name))
      .toContain("mcp__Gmail__search_messages");
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

    expect((await tools.definitions(snapshot)).map((definition) => definition.function.name))
      .toContain("mcp__echo__echo");
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
      .toEqual(["tool_search"]);
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

    expect((await tools.definitions(snapshot)).map((definition) => definition.function.name))
      .toContain("mcp__First_Drive__search_first");

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
    const refreshed = (await tools.definitions(snapshot)).map((definition) => definition.function.name);
    expect(refreshed).toContain("mcp__Second_Drive__search_second");
    expect(refreshed).not.toContain("mcp__First_Drive__search_first");

    await tools.close();
  });
});

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

  it("labels intentionally persisted Drive downloads as Library files", () => {
    const text = connectorArtifactText(
      { fileId: "file-1", name: "brief.pdf", mediaType: "application/pdf", library: true },
      { name: "brief.pdf", mediaType: "application/pdf", path: "/workspace/inputs/file-1/brief.pdf" },
    );

    expect(text).toContain("Saved brief.pdf to the Berry Library.");
    expect(text).toContain("searchable extraction is queued through Tika");
  });
});

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
