import { describe, expect, it } from "vitest";
import { parseCloudShellLocation } from "@/lib/cloud-shell-state";
import { ADMIN_NAV, PERSONAL_NAV, visibleNavigationGroups } from "./management/management-navigation";
import { initialCloudContent, reduceDurableTurnState, shouldRefreshAdministration, shouldShowComposerProjectSwitcher, type ShellData } from "./app-shell";

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
    expect(visible.flatMap((group) => group.items.map((item) => item.id))).toEqual(["overview", "people", "ai-tools"]);
  });

  it("redirects legacy memory navigation into personalization", () => {
    expect(parseCloudShellLocation("/settings/memory")).toEqual({ kind: "settings", tab: "personalization" });
  });

  it("keeps personal settings flat and ordered by user intent", () => {
    expect(PERSONAL_NAV.map((group) => ({
      label: group.label,
      items: group.items.map((item) => [item.id, item.label]),
    }))).toEqual([
      { label: "", items: [["general", "General"], ["account", "Account"], ["personalization", "Personalization"], ["skills", "Skills"], ["mcp", "MCP servers"], ["usage", "Usage"], ["archived", "Archived chats"]] },
    ]);
  });

  it("shows the composer project switcher only when the transcript is empty", () => {
    expect(shouldShowComposerProjectSwitcher([])).toBe(true);
    expect(shouldShowComposerProjectSwitcher([{ role: "user" }])).toBe(false);
    expect(shouldShowComposerProjectSwitcher([{ role: "assistant" }])).toBe(false);
  });

  it("clears durable activity for manually terminated turns", () => {
    const active = reduceDurableTurnState(undefined, { kind: "turn.start", turnId: "turn_1" });
    expect(active).toMatchObject({ active: true, runState: "queued" });

    const cancelled = reduceDurableTurnState(
      active ?? undefined,
      { kind: "turn.end", turnId: "turn_1", status: "cancelled" },
    );
    expect(cancelled).toMatchObject({
      active: false,
      runState: "cancelled",
      waitingReason: null,
      nextAction: null,
    });
  });
});
