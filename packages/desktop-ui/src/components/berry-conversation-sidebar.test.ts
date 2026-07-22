import { describe, expect, it } from "vitest";
import type { Task } from "@berry/shared";
import {
  INITIAL_CONVERSATION_SECTION_STATE,
  conversationSectionReducer,
  conversationsForKind,
  visibleConversationSlice,
} from "./berry-conversation-sidebar";

function task(id: string, conversationKind: "chat" | "code", overrides: Partial<Task> = {}): Task {
  return {
    id,
    workspaceId: "workspace_1",
    title: id,
    status: "completed",
    activeSessionId: `session_${id}`,
    conversationKind,
    pinned: false,
    archived: false,
    deletedAt: null,
    unreadAt: null,
    lastReadAt: null,
    worktreePath: null,
    worktreeBranch: null,
    worktreeBaseRef: null,
    worktreeBaseSha: null,
    pullRequestUrl: null,
    pullRequestNumber: null,
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
    ...overrides,
  };
}

describe("Berry conversation sidebar model", () => {
  it.each([
    [0, 0, 0],
    [1, 1, 0],
    [5, 5, 0],
    [6, 5, 1],
    [12, 5, 7],
  ])("shows five rows before a sixth-row Show more control for %i conversations", (count, visible, hidden) => {
    const tasks = Array.from({ length: count }, (_, index) => task(`task_${index}`, "chat"));
    const collapsed = visibleConversationSlice(tasks, false);
    expect(collapsed.visible).toHaveLength(visible);
    expect(collapsed.hiddenCount).toBe(hidden);
    const expanded = visibleConversationSlice(tasks, true);
    expect(expanded.visible).toHaveLength(count);
    expect(expanded.hiddenCount).toBe(0);
  });

  it("filters Chat and Code, sorts pinned conversations, and excludes duplicates", () => {
    const tasks = [
      task("chat_old", "chat"),
      task("code", "code"),
      task("chat_pinned", "chat", { pinned: true, updatedAt: "2026-07-20T01:00:00.000Z" }),
    ];
    expect(conversationsForKind(tasks, "chat").map((item) => item.id)).toEqual(["chat_pinned", "chat_old"]);
    expect(conversationsForKind(tasks, "code").map((item) => item.id)).toEqual(["code"]);
    expect(conversationsForKind(tasks, "chat", new Set(["chat_pinned"])).map((item) => item.id)).toEqual(["chat_old"]);
  });

  it("resets Show more when a project closes and reopens", () => {
    const expanded = conversationSectionReducer(INITIAL_CONVERSATION_SECTION_STATE, { type: "show-project", projectId: "project_1" });
    expect(expanded.expandedProjects.has("project_1")).toBe(true);
    const closed = conversationSectionReducer(expanded, { type: "toggle-project", projectId: "project_1" });
    expect(closed.collapsedProjects.has("project_1")).toBe(true);
    expect(closed.expandedProjects.has("project_1")).toBe(false);
    const reopened = conversationSectionReducer(closed, { type: "toggle-project", projectId: "project_1" });
    expect(reopened.collapsedProjects.has("project_1")).toBe(false);
    expect(reopened.expandedProjects.has("project_1")).toBe(false);
  });

  it("collapse all clears every project and Chats expansion", () => {
    let state = conversationSectionReducer(INITIAL_CONVERSATION_SECTION_STATE, { type: "show-project", projectId: "project_1" });
    state = conversationSectionReducer(state, { type: "show-chats" });
    state = conversationSectionReducer(state, { type: "toggle-all", projectIds: ["project_1", "project_2"] });
    expect(state.allCollapsed).toBe(true);
    expect([...state.collapsedProjects]).toEqual(["project_1", "project_2"]);
    expect(state.expandedProjects.size).toBe(0);
    expect(state.chatsCollapsed).toBe(true);
    expect(state.chatsExpanded).toBe(false);
    state = conversationSectionReducer(state, { type: "toggle-all", projectIds: ["project_1", "project_2"] });
    expect(state.allCollapsed).toBe(false);
    expect(state.collapsedProjects.size).toBe(0);
  });
});
