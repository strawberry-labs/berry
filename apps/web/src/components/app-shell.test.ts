import { describe, expect, it } from "vitest";
import { parseCloudShellLocation } from "@/lib/cloud-shell-state";
import { ADMIN_NAV, PERSONAL_NAV, visibleNavigationGroups } from "./management/management-navigation";
import { initialCloudContent, shouldRefreshAdministration, shouldShowComposerProjectSwitcher, type ShellData } from "./app-shell";

describe("cloud shell bootstrap", () => {
  it("does not issue live requests for fixture task and session identifiers", () => {
    const fixture = {
      config: { demoMode: false },
      tasks: [{ id: "task_cloud", activeSessionId: "session_cloud" }],
      messages: [{ id: "message_cloud" }],
    } as unknown as ShellData;

    expect(initialCloudContent(fixture)).toEqual({ tasks: [], messages: [] });
  });

  it("keeps fixture content in explicit demo mode", () => {
    const fixture = {
      config: { demoMode: true },
      tasks: [{ id: "task_cloud" }],
      messages: [{ id: "message_cloud" }],
    } as unknown as ShellData;

    expect(initialCloudContent(fixture)).toEqual({ tasks: fixture.tasks, messages: fixture.messages });
  });

  it("does not load organization administration data for ordinary members", () => {
    expect(shouldRefreshAdministration(["org:read", "departments:read", "sso:read"])).toBe(false);
    expect(shouldRefreshAdministration(["org:read", "org:admin"])).toBe(true);
  });

  it("shows only administration screens allowed by the active role", () => {
    const visible = visibleNavigationGroups(ADMIN_NAV, ["org:read", "members:read"]);
    expect(visible.flatMap((group) => group.items.map((item) => item.id))).toEqual(["overview", "members", "skills-mcp"]);
  });

  it("keeps memory on the personal settings surface", () => {
    expect(parseCloudShellLocation("/settings/memory")).toEqual({ kind: "settings", tab: "memory" });
  });

  it("keeps personal settings grouped and ordered by user intent", () => {
    expect(PERSONAL_NAV.map((group) => ({
      label: group.label,
      items: group.items.map((item) => [item.id, item.label]),
    }))).toEqual([
      { label: "Preferences", items: [["general", "Appearance & behavior"], ["providers", "Model defaults"]] },
      { label: "Personalization", items: [["prompts", "Instructions & prompts"], ["memory", "Memory"]] },
      { label: "Tools & connections", items: [["skills", "Skills"], ["mcp", "MCP servers"]] },
      { label: "Privacy & local data", items: [["privacy", "Privacy & local data"]] },
      { label: "Usage", items: [["usage", "Personal usage"]] },
      { label: "History", items: [["archived", "Archived chats"]] },
    ]);
  });

  it("shows the composer project switcher only when the transcript is empty", () => {
    expect(shouldShowComposerProjectSwitcher([])).toBe(true);
    expect(shouldShowComposerProjectSwitcher([{ role: "user" }])).toBe(false);
    expect(shouldShowComposerProjectSwitcher([{ role: "assistant" }])).toBe(false);
  });
});
