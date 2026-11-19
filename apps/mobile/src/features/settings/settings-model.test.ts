import { describe, expect, it } from "vitest";
import type { Connector, MemoryItem, MobileDeviceRegistration, Task, Workspace } from "@berry/shared";
import {
  SETTINGS_TABS,
  cacheSummary,
  canOpenAdminConsole,
  connectorForServer,
  customMcpConnectors,
  describePairedDevice,
  deviceTitle,
  filterMemories,
  groupActiveMemories,
  groupArchivedTasks,
  humanTool,
  humanize,
  isHttpsUrl,
  memoryKindOptions,
  parseMemoryExpiry,
  personalMcpConnectionAction,
  personalMcpOAuthStatus,
  relativeHeights,
  requestTone,
  resolveSettingsTab,
  sameProfile,
  sortDevices,
  usageRange,
  visibleSettingsTabs,
  webUrl,
} from "./settings-model";

const NOW = "2026-10-09T12:00:00.000Z";

function device(overrides: Partial<MobileDeviceRegistration>): MobileDeviceRegistration {
  return {
    id: "d", tenantId: null, userId: null, deviceId: "device", platform: "ios", pushProvider: "none", pushTokenLast4: null,
    endpointMode: "paired", appVersion: "1.0.0", capabilities: [], status: "active", displayName: null, model: "iPhone 17",
    osVersion: "26.1", pairedAt: NOW, revokedAt: null, current: false, createdAt: NOW, updatedAt: NOW, lastSeenAt: NOW,
    ...overrides,
  } as MobileDeviceRegistration;
}

function memory(overrides: Partial<MemoryItem>): MemoryItem {
  return {
    id: "m", tenantId: "t", userId: "u", workspaceId: null, scope: "personal", kind: "preference", stableKey: "k", content: "Likes tea",
    value: {}, status: "active", explicit: true, confidence: 0.9, salience: 0.5, validFrom: null, validUntil: null, expiresAt: null,
    extractorVersion: "1", sourceTaskId: null, sourceSessionId: null, sourceMessageId: null, supersededItemId: null, lastSeenAt: null,
    lastUsedAt: null, createdAt: NOW, updatedAt: NOW,
    ...overrides,
  } as MemoryItem;
}

function task(overrides: Partial<Task>): Task {
  return {
    id: "task", workspaceId: "w1", title: "Task", status: "completed", activeSessionId: null, conversationKind: "chat", pinned: false,
    archived: true, deletedAt: null, unreadAt: null, lastReadAt: null, worktreePath: null, worktreeBranch: null, worktreeBaseRef: null,
    worktreeBaseSha: null, pullRequestUrl: null, pullRequestNumber: null, createdAt: NOW, updatedAt: NOW,
    ...overrides,
  } as Task;
}

function workspace(overrides: Partial<Workspace>): Workspace {
  return {
    id: "w1", path: "/", name: "Project", workspaceKind: "project", ownerUserId: null, trustState: "trusted", lastOpenedAt: NOW,
    indexedAt: null, createdAt: NOW, updatedAt: NOW, pinned: false,
    ...overrides,
  } as Workspace;
}

describe("settings tabs", () => {
  it("uses the web's personal tab ids in the web's order", () => {
    expect(SETTINGS_TABS.map((tab) => tab.id)).toEqual(["general", "account", "personalization", "connectors", "skills", "mcp", "schedules", "usage", "archived"]);
  });

  it("resolves route params, legacy ids and unknown tabs like the web route", () => {
    expect(resolveSettingsTab("usage")).toBe("usage");
    expect(resolveSettingsTab(["archived", "x"])).toBe("archived");
    expect(resolveSettingsTab("memory")).toBe("personalization");
    expect(resolveSettingsTab("prompts")).toBe("personalization");
    expect(resolveSettingsTab("privacy")).toBe("account");
    expect(resolveSettingsTab("providers")).toBe("general");
    expect(resolveSettingsTab("nope")).toBe("general");
    expect(resolveSettingsTab(undefined)).toBe("general");
  });

  it("hides tabs the server does not advertise, but shows all before server info loads", () => {
    expect(visibleSettingsTabs(null)).toHaveLength(SETTINGS_TABS.length);
    expect(visibleSettingsTabs(["usage"]).map((tab) => tab.id)).toEqual(["general", "account", "usage"]);
  });

  it("offers the admin console only with org:admin", () => {
    expect(canOpenAdminConsole(["org:read", "org:admin"])).toBe(true);
    expect(canOpenAdminConsole(["org:read", "members:read"])).toBe(false);
  });

  it("joins server URLs and paths without doubled slashes", () => {
    expect(webUrl("https://berry.example.com/", "/admin/overview")).toBe("https://berry.example.com/admin/overview");
    expect(webUrl("https://berry.example.com", "admin/overview")).toBe("https://berry.example.com/admin/overview");
  });
});

describe("mobile devices", () => {
  it("describes and names a phone like the web section", () => {
    expect(describePairedDevice({ platform: "ios", osVersion: "26.1", appVersion: "1.2.0" })).toBe("iOS 26.1 · Berry 1.2.0");
    expect(describePairedDevice({ platform: "android", osVersion: null, appVersion: null })).toBe("Android");
    expect(deviceTitle({ displayName: "Work phone", model: "Pixel" })).toBe("Work phone");
    expect(deviceTitle({ displayName: null, model: null })).toBe("Phone");
  });

  it("lists this phone first, then the most recently active", () => {
    const sorted = sortDevices([
      device({ deviceId: "old", lastSeenAt: "2026-01-01T00:00:00.000Z" }),
      device({ deviceId: "new", lastSeenAt: "2026-10-01T00:00:00.000Z" }),
      device({ deviceId: "me", current: true, lastSeenAt: "2025-01-01T00:00:00.000Z" }),
    ]);
    expect(sorted.map((item) => item.deviceId)).toEqual(["me", "new", "old"]);
  });
});

describe("personalization and memory", () => {
  it("compares profiles after trimming, like the web's dirty check", () => {
    const base = { nickname: "Ada", occupation: "", about: "", customInstructions: "" };
    expect(sameProfile(base, { ...base, nickname: " Ada " })).toBe(true);
    expect(sameProfile(base, { ...base, about: "Engineer" })).toBe(false);
  });

  it("groups active memories by kind and filters by text", () => {
    const items = [
      memory({ id: "1", kind: "preference" }),
      memory({ id: "2", kind: "profile", content: "Based in Dubai" }),
      memory({ id: "3", kind: "preference", status: "forgotten" }),
    ];
    expect(groupActiveMemories(items).map((group) => [group.kind, group.items.map((item) => item.id)])).toEqual([
      ["preference", ["1"]],
      ["profile", ["2"]],
    ]);
    expect(filterMemories(items, "dubai").map((item) => item.id)).toEqual(["2"]);
    expect(filterMemories(items, "  ")).toHaveLength(3);
  });

  it("keeps an unlisted memory kind selectable", () => {
    expect(memoryKindOptions("preference")).toHaveLength(5);
    expect(memoryKindOptions("career").at(-1)).toEqual({ value: "career", label: "Career" });
    expect(humanize("communication_style")).toBe("Communication style");
  });

  it("parses optional expiry dates and rejects impossible ones", () => {
    expect(parseMemoryExpiry("")).toEqual({ ok: true, expiresAt: null });
    const parsed = parseMemoryExpiry("2026-12-31");
    expect(parsed.ok && parsed.expiresAt && new Date(parsed.expiresAt).getDate()).toBe(31);
    expect(parseMemoryExpiry("2026-02-30")).toEqual({ ok: false });
    expect(parseMemoryExpiry("31/12/2026")).toEqual({ ok: false });
  });
});

describe("usage", () => {
  it("builds ranges ending at the anchor", () => {
    const anchor = Date.parse(NOW);
    expect(usageRange("1d", anchor)).toEqual({ from: "2026-10-08T12:00:00.000Z", to: NOW });
    expect(usageRange("all", anchor).from).toBe(new Date(0).toISOString());
  });

  it("summarizes prompt cache hits", () => {
    expect(cacheSummary({ cacheEligibleRequests: 4, cacheHitRequests: 3 })).toEqual({ hits: 3, misses: 1, hitRate: 0.75 });
    expect(cacheSummary({ cacheEligibleRequests: 0, cacheHitRequests: 0 }).hitRate).toBeNull();
  });

  it("maps request statuses to tones and scales bars", () => {
    expect(requestTone("completed")).toBe("good");
    expect(requestTone("failed")).toBe("danger");
    expect(requestTone("running")).toBe("neutral");
    expect(relativeHeights([0, 5, 10])).toEqual([0, 0.5, 1]);
    expect(relativeHeights([0, 0])).toEqual([0, 0]);
  });
});

describe("archived tasks", () => {
  it("groups by project name with General as Tasks, newest first", () => {
    const groups = groupArchivedTasks(
      [
        task({ id: "a", workspaceId: "w2", updatedAt: "2026-01-01T00:00:00.000Z" }),
        task({ id: "b", workspaceId: "w2", updatedAt: "2026-02-01T00:00:00.000Z" }),
        task({ id: "c", workspaceId: "general" }),
        task({ id: "d", workspaceId: "missing" }),
      ],
      [workspace({ id: "w2", name: "Zeta" }), workspace({ id: "general", name: "General", workspaceKind: "general" })],
    );
    expect(groups.map((group) => [group.title, group.items.map((item) => item.id)])).toEqual([
      ["Unknown project", ["d"]],
      ["Tasks", ["c"]],
      ["Zeta", ["b", "a"]],
    ]);
  });
});

describe("connectors and MCP", () => {
  const connector = (overrides: Partial<Connector>) => ({ id: "c", url: "https://mcp.example.com/mcp", kind: "custom_mcp", approvalStatus: "approved", connectionStatus: "not_connected", ...overrides }) as Connector;

  it("chooses the same MCP action as the web", () => {
    expect(personalMcpConnectionAction({ auth: "none", transport: "streamable-http" }, null, false).kind).toBe("test");
    expect(personalMcpConnectionAction({ auth: "oauth", transport: "http-sse" }, null, false)).toMatchObject({ kind: "unsupported", disabled: true });
    expect(personalMcpConnectionAction({ auth: "oauth", transport: "streamable-http" }, connector({ approvalStatus: "pending" }), false)).toMatchObject({ kind: "pending", disabled: true });
    expect(personalMcpConnectionAction({ auth: "oauth", transport: "streamable-http" }, connector({ connectionStatus: "connected" }), false).kind).toBe("reconnect");
    expect(personalMcpConnectionAction({ auth: "oauth", transport: "streamable-http" }, null, true).kind).toBe("connect");
    expect(personalMcpConnectionAction({ auth: "oauth", transport: "streamable-http" }, null, false).kind).toBe("request");
  });

  it("describes OAuth state and matches servers to connectors by URL", () => {
    expect(personalMcpOAuthStatus(connector({ connectionStatus: "connected" })).tone).toBe("good");
    expect(personalMcpOAuthStatus(null).approval).toBe("Not submitted");
    expect(connectorForServer([connector({})], { url: "https://MCP.example.com/mcp" })?.id).toBe("c");
    expect(connectorForServer([connector({})], { url: "https://other.example.com/mcp" })).toBeNull();
  });

  it("merges requested and available MCP connectors", () => {
    const merged = customMcpConnectors(
      [connector({ id: "a", approvalStatus: "approved" }), connector({ id: "app", kind: "app" })],
      [connector({ id: "a", approvalStatus: "pending" })],
    );
    expect(merged.map((item) => [item.id, item.approvalStatus])).toEqual([["a", "approved"]]);
  });

  it("formats tool names and validates server URLs", () => {
    expect(humanTool("google_search_files")).toBe("Search Files");
    expect(isHttpsUrl("https://mcp.example.com/mcp")).toBe(true);
    expect(isHttpsUrl("http://mcp.example.com/mcp")).toBe(false);
    expect(isHttpsUrl("not a url")).toBe(false);
  });
});
