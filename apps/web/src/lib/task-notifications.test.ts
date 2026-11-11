import { afterEach, describe, expect, it, vi } from "vitest";
import { BROWSER_NOTIFICATIONS_KEY, notifyBrowserNeedsHelp } from "./task-notifications";

function setup({ away = true, enabled = true, permission = "granted" } = {}) {
  const notifications: Array<{ title: string; body: string; tag: string; onclick?: () => void; close: ReturnType<typeof vi.fn> }> = [];
  const assign = vi.fn(), focus = vi.fn();
  class Notification {
    static permission = permission;
    onclick?: () => void;
    close = vi.fn();
    body: string;
    tag: string;
    constructor(public title: string, options: { body: string; tag: string }) { this.body = options.body; this.tag = options.tag; notifications.push(this); }
  }
  vi.stubGlobal("window", { Notification, localStorage: { getItem: (key: string) => key === BROWSER_NOTIFICATIONS_KEY ? enabled ? "on" : "off" : null }, focus, location: { assign } });
  vi.stubGlobal("document", { hidden: away, hasFocus: () => !away });
  return { notifications, assign, focus };
}
const handoff = { handoffId: "handoff-1", taskId: "automation-chat", taskTitle: "Weekly report", reason: "Complete sign-in" };
afterEach(() => vi.unstubAllGlobals());

describe("browser checkpoint notifications", () => {
  it("deduplicates replayed checkpoints and opens the original Automation chat", () => {
    const { notifications, assign, focus } = setup();
    notifyBrowserNeedsHelp(handoff); notifyBrowserNeedsHelp(handoff);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ title: "Browser needs your help", body: "Weekly report: Complete sign-in" });
    notifications[0]!.onclick!();
    expect(focus).toHaveBeenCalled();
    expect(assign).toHaveBeenCalledWith("/tasks/automation-chat");
  });
  it("respects notification preferences and does not request permission", () => {
    const { notifications } = setup({ enabled: false });
    notifyBrowserNeedsHelp({ ...handoff, handoffId: "disabled" });
    expect(notifications).toHaveLength(0);
    const denied = setup({ permission: "denied" });
    notifyBrowserNeedsHelp({ ...handoff, handoffId: "denied" });
    expect(denied.notifications).toHaveLength(0);
  });
  it("stays quiet while the app has focus", () => {
    const { notifications } = setup({ away: false });
    notifyBrowserNeedsHelp({ ...handoff, handoffId: "focused" });
    expect(notifications).toHaveLength(0);
  });
});
