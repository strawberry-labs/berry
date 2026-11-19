import { describe, expect, it } from "vitest";
import type { Task, Workspace } from "@berry/shared";
import { RECENT_TASK_LIMIT, buildSearchSections, highlightRanges, matchScore, normalizeSearchText, taskStateLabel, type SearchAction } from "./search-model";

const NOW = "2026-10-09T12:00:00.000Z";

function task(overrides: Partial<Task>): Task {
  return {
    id: "task", workspaceId: "general", title: "Task", status: "completed", activeSessionId: null, conversationKind: "chat", pinned: false,
    archived: false, deletedAt: null, unreadAt: null, lastReadAt: null, worktreePath: null, worktreeBranch: null, worktreeBaseRef: null,
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

const workspaces = [workspace({ id: "general", name: "General", workspaceKind: "general" }), workspace({ id: "launch", name: "Product launch" })];
const actions: SearchAction[] = [
  { id: "new-task", label: "New task", keywords: "new chat start compose", pinned: true },
  { id: "settings", label: "Settings", keywords: "settings preferences", pinned: true },
  { id: "settings:usage", label: "Usage", keywords: "settings usage spend tokens", detail: "Settings" },
];

describe("matchScore", () => {
  it("requires every word and prefers starts of the title", () => {
    expect(matchScore("launch plan", "Launch plan for Q4")).toBeGreaterThan(matchScore("plan", "Launch plan for Q4"));
    expect(matchScore("launch budget", "Launch plan")).toBe(0);
    expect(matchScore("deck", "Investor deck")).toBeGreaterThan(matchScore("eck", "Investor deck"));
  });

  it("matches secondary text weakly and ignores accents and case", () => {
    expect(matchScore("launch", "Weekly notes", "Product launch")).toBe(1);
    expect(matchScore("CAFE", "Café opening")).toBeGreaterThan(0);
    expect(normalizeSearchText("  Café   Plan ")).toBe("cafe plan");
  });

  it("falls back to a tight in-order match only for longer queries", () => {
    expect(matchScore("qtrly", "Quarterly report")).toBe(0.5);
    expect(matchScore("qr", "Quarterly report")).toBe(0);
    expect(matchScore("qrt", "Quiet afternoon at the lake with a friend")).toBe(0);
  });
});

describe("buildSearchSections", () => {
  const tasks = [
    task({ id: "old", title: "Budget review", updatedAt: "2026-01-01T00:00:00.000Z" }),
    task({ id: "new", title: "Launch email", workspaceId: "launch", updatedAt: "2026-10-01T00:00:00.000Z" }),
    task({ id: "archived", title: "Launch retro", archived: true, updatedAt: "2026-10-05T00:00:00.000Z" }),
    task({ id: "deleted", title: "Launch draft", deletedAt: NOW, updatedAt: "2026-10-06T00:00:00.000Z" }),
  ];

  it("shows pinned actions and recent active tasks before typing", () => {
    const sections = buildSearchSections({ query: "  ", tasks, workspaces, actions });
    expect(sections.map((section) => section.key)).toEqual(["actions", "recent"]);
    expect(sections[0]!.data.map((item) => item.key)).toEqual(["action:new-task", "action:settings"]);
    expect(sections[1]!.data.map((item) => item.key)).toEqual(["task:new", "task:old"]);
  });

  it("caps recent tasks", () => {
    const many = Array.from({ length: RECENT_TASK_LIMIT + 5 }, (_, index) => task({ id: `t${index}` }));
    const recent = buildSearchSections({ query: "", tasks: many, workspaces, actions: [] }).find((section) => section.key === "recent");
    expect(recent?.data).toHaveLength(RECENT_TASK_LIMIT);
  });

  it("groups matching actions, projects and tasks, active tasks first", () => {
    const sections = buildSearchSections({ query: "launch", tasks, workspaces, actions });
    expect(sections.map((section) => section.key)).toEqual(["projects", "tasks"]);
    expect(sections[0]!.data[0]).toMatchObject({ kind: "project", taskCount: 1 });
    expect(sections[1]!.data.map((item) => item.key)).toEqual(["task:new", "task:deleted", "task:archived"]);
    const first = sections[1]!.data[0];
    expect(first?.kind === "task" && [first.provenance, first.state]).toEqual(["Product launch", "Completed"]);
  });

  it("finds settings actions by keyword", () => {
    const sections = buildSearchSections({ query: "tokens", tasks, workspaces, actions });
    expect(sections[0]?.data.map((item) => item.key)).toEqual(["action:settings:usage"]);
  });

  it("returns nothing when nothing matches", () => {
    expect(buildSearchSections({ query: "zzzz", tasks, workspaces, actions })).toEqual([]);
  });
});

describe("labels and highlighting", () => {
  it("labels task state like the palette", () => {
    expect(taskStateLabel(task({ deletedAt: NOW }))).toBe("Deleted");
    expect(taskStateLabel(task({ archived: true }))).toBe("Archived");
    expect(taskStateLabel(task({ status: "waiting-for-approval" }))).toBe("Waiting for approval");
  });

  it("merges overlapping highlight ranges", () => {
    expect(highlightRanges("Launch plan", "launch lau plan")).toEqual([[0, 6], [7, 11]]);
    expect(highlightRanges("Launch plan", "")).toEqual([]);
  });
});
