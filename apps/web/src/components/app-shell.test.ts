import { describe, expect, it } from "vitest";
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

  it("shows the composer project switcher only when the transcript is empty", () => {
    expect(shouldShowComposerProjectSwitcher([])).toBe(true);
    expect(shouldShowComposerProjectSwitcher([{ role: "user" }])).toBe(false);
    expect(shouldShowComposerProjectSwitcher([{ role: "assistant" }])).toBe(false);
  });
});
