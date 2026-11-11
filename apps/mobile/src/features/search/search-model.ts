import type { Task, Workspace } from "@berry/shared";

/**
 * The web command palette (web-command-palette.tsx) as pure data: an Actions
 * group and a Tasks group whose rows read "Task · <project> · <state>". The
 * phone adds a Projects group and, before you type, your recent tasks.
 */

export type SearchAction = {
  id: string;
  label: string;
  /** Extra words the action answers to, like cmdk's `value`. */
  keywords: string;
  detail?: string;
  /** Shown before the person types. */
  pinned?: boolean;
};

export type SearchItem =
  | { kind: "action"; key: string; action: SearchAction }
  | { kind: "project"; key: string; workspace: Workspace; taskCount: number }
  | { kind: "task"; key: string; task: Task; provenance: string; state: string };

export type SearchSection = { key: "actions" | "recent" | "projects" | "tasks"; title: string; data: SearchItem[] };

export const RECENT_TASK_LIMIT = 12;
export const RESULT_LIMIT = 100;

export function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function tokenScore(token: string, text: string): number {
  const index = text.indexOf(token);
  if (index < 0) return 0;
  if (index === 0) return 4;
  return /[a-z0-9]/.test(text[index - 1] ?? "") ? 2 : 3;
}

/** True when every character of `needle` appears in order within a tight window of `text`. */
function compactSubsequence(needle: string, text: string): boolean {
  if (needle.length < 3) return false;
  for (let start = text.indexOf(needle[0]!); start >= 0; start = text.indexOf(needle[0]!, start + 1)) {
    let position = start;
    let matched = 1;
    while (matched < needle.length) {
      position = text.indexOf(needle[matched]!, position + 1);
      if (position < 0) break;
      matched += 1;
    }
    if (matched === needle.length && position - start + 1 <= needle.length * 3) return true;
  }
  return false;
}

/**
 * Scores a candidate against the query; 0 means no match. Every word must
 * appear (word starts and the primary text rank higher); a tight in-order
 * character match on the primary text is a weak fallback, like cmdk's fuzzy
 * matching but less noisy on a phone keyboard.
 */
export function matchScore(query: string, primary: string, secondary = ""): number {
  const needle = normalizeSearchText(query);
  if (!needle) return 1;
  const main = normalizeSearchText(primary);
  const extra = normalizeSearchText(secondary);
  let score = 0;
  let allTokens = true;
  for (const token of needle.split(" ")) {
    const inMain = tokenScore(token, main);
    if (inMain > 0) score += inMain;
    else if (extra.includes(token)) score += 1;
    else {
      allTokens = false;
      break;
    }
  }
  if (allTokens) {
    if (main === needle) score += 10;
    else if (main.startsWith(needle)) score += 5;
    return score;
  }
  return compactSubsequence(needle.replaceAll(" ", ""), main) ? 0.5 : 0;
}

export function workspaceNames(workspaces: readonly Workspace[]): Map<string, string> {
  return new Map(workspaces.map((workspace) => [workspace.id, workspace.workspaceKind === "general" ? "Tasks" : workspace.name]));
}

const STATUS_LABELS: Readonly<Record<Task["status"], string>> = {
  queued: "Queued",
  running: "Running",
  "waiting-for-approval": "Waiting for approval",
  cancelled: "Cancelled",
  failed: "Failed",
  completed: "Completed",
};

/** The palette's trailing state: deleted, archived, or the run status. */
export function taskStateLabel(task: Pick<Task, "deletedAt" | "archived" | "status">): string {
  if (task.deletedAt) return "Deleted";
  if (task.archived) return "Archived";
  return STATUS_LABELS[task.status] ?? task.status;
}

function isActive(task: Pick<Task, "deletedAt" | "archived">): boolean {
  return !task.deletedAt && !task.archived;
}

function taskItem(task: Task, names: Map<string, string>): SearchItem {
  return { kind: "task", key: `task:${task.id}`, task, provenance: names.get(task.workspaceId) ?? "Tasks", state: taskStateLabel(task) };
}

export function buildSearchSections(input: {
  query: string;
  tasks: readonly Task[];
  workspaces: readonly Workspace[];
  actions: readonly SearchAction[];
}): SearchSection[] {
  const names = workspaceNames(input.workspaces);
  const query = normalizeSearchText(input.query);
  const sections: SearchSection[] = [];

  if (!query) {
    const actions = input.actions.filter((action) => action.pinned);
    if (actions.length) sections.push({ key: "actions", title: "Actions", data: actions.map((action) => ({ kind: "action", key: `action:${action.id}`, action })) });
    const recent = input.tasks
      .filter(isActive)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, RECENT_TASK_LIMIT)
      .map((task) => taskItem(task, names));
    if (recent.length) sections.push({ key: "recent", title: "Recent", data: recent });
    return sections;
  }

  const actions = input.actions
    .map((action) => ({ action, score: matchScore(query, action.label, action.keywords) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .map(({ action }): SearchItem => ({ kind: "action", key: `action:${action.id}`, action }));
  if (actions.length) sections.push({ key: "actions", title: "Actions", data: actions });

  const counts = new Map<string, number>();
  for (const task of input.tasks) if (isActive(task)) counts.set(task.workspaceId, (counts.get(task.workspaceId) ?? 0) + 1);
  const projects = input.workspaces
    .filter((workspace) => workspace.workspaceKind !== "general")
    .map((workspace) => ({ workspace, score: matchScore(query, workspace.name) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.workspace.name.localeCompare(right.workspace.name))
    .map(({ workspace }): SearchItem => ({ kind: "project", key: `project:${workspace.id}`, workspace, taskCount: counts.get(workspace.id) ?? 0 }));
  if (projects.length) sections.push({ key: "projects", title: "Projects", data: projects });

  const tasks = input.tasks
    .map((task) => {
      const item = taskItem(task, names) as Extract<SearchItem, { kind: "task" }>;
      return { task, item, score: matchScore(query, task.title, `${item.provenance} ${item.state} ${task.status}`) };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) =>
      right.score - left.score
      || Number(isActive(right.task)) - Number(isActive(left.task))
      || right.task.updatedAt.localeCompare(left.task.updatedAt))
    .slice(0, RESULT_LIMIT)
    .map(({ item }) => item);
  if (tasks.length) sections.push({ key: "tasks", title: "Tasks", data: tasks });

  return sections;
}

/** Character ranges of `title` that matched the query's words, for highlighting. */
export function highlightRanges(title: string, query: string): Array<[number, number]> {
  const tokens = normalizeSearchText(query).split(" ").filter(Boolean);
  if (!tokens.length) return [];
  const lower = title.toLowerCase();
  const ranges: Array<[number, number]> = [];
  for (const token of tokens) {
    const index = lower.indexOf(token);
    if (index >= 0) ranges.push([index, index + token.length]);
  }
  ranges.sort((left, right) => left[0] - right[0]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}
