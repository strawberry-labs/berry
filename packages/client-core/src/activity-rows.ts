import type { ActivityTool, ToolStatus } from "./activity.ts";

/* ------------------------------------------------------------------------ */
/* What each activity row says, independent of how it is drawn: the tool    */
/* family, the Explore grouping, the verb/label/detail of every row and the  */
/* turn and thought headers. The web/desktop rows and the native rows both   */
/* read these so a turn reads the same on every surface.                     */
/* ------------------------------------------------------------------------ */

export type ToolFamily = "file-read" | "file-write" | "shell" | "search" | "explore" | "other";

const EXACT_FAMILY: Record<string, ToolFamily> = {
  read: "file-read",
  write: "file-write",
  edit: "file-write",
  bash: "shell",
  todo_write: "other",
  grep: "search",
  find: "search",
  ls: "search",
  webfetch: "search",
  websearch: "search",
  web_search: "search",
  web_fetch: "search",
  inspect_images: "other",
};

export function familyFromTool(name: string): ToolFamily {
  const key = name.trim().toLowerCase();
  const exact = EXACT_FAMILY[key];
  if (exact) return exact;
  // Normalize dot- and dash-separated names before classifying provider tools.
  const n = key.replace(/[.-]/g, "_");
  if (/^(?:read|view|open|cat|head|tail)(?:_|$)/.test(n)) return "file-read";
  if (/(?:^|_)(?:edit|patch|replace|multi_edit|multiedit|write|create|save)(?:_|$)/.test(n)) return "file-write";
  if (/^(?:execute|run|exec|bash|shell|command|terminal)(?:_|$)/.test(n)) return "shell";
  if (/^(?:search|grep|find|fetch|web_search|web_fetch|webfetch|query|lookup|list|ls|dir|tree)(?:_|$)/.test(n)) return "search";
  if (/^(?:explore|inspect)(?:_|$)/.test(n)) return "explore";
  return "other";
}

/* ---------------------- input extraction helpers ------------------------ */

export function toolStringArg(args: ActivityTool["args"], ...keys: string[]): string | undefined {
  if (!args) return undefined;
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

export function toolCommand(tool: ActivityTool): string | undefined {
  return toolStringArg(tool.args, "command", "cmd", "script") ?? (familyFromTool(tool.name) === "shell" ? tool.title : undefined);
}

export function toolFilePath(tool: ActivityTool): string | undefined {
  return toolStringArg(tool.args, "path", "file_path", "filePath", "file") ?? tool.title;
}

export function toolQuery(tool: ActivityTool): string | undefined {
  return toolStringArg(tool.args, "pattern", "query", "url", "path", "glob") ?? tool.title;
}

export function toolBrowserSession(tool: ActivityTool): string | undefined {
  return toolStringArg(tool.args, "id", "sessionId", "session_id");
}

export function toolBrowserUrl(tool: ActivityTool): string | undefined {
  const value = toolStringArg(tool.args, "url", "currentUrl", "current_url") ?? tool.title;
  return value && isLikelyUrl(value) ? value : undefined;
}

export function toolOutput(tool: ActivityTool): string | undefined {
  return tool.output ?? tool.summary;
}

export function isLikelyUrl(value: string): boolean {
  return /^(https?:|file:|about:)/i.test(value.trim());
}

/**
 * Quiet suffix after a row's label: only "truncated" when output was cut.
 * Per-call durations are left out of collapsed rows; the turn header already
 * says how long the work took.
 */
export function toolMetaText(tool: ActivityTool): string | undefined {
  const segments: string[] = [];
  const args = tool.args ?? {};
  const truncated =
    args.truncated === true ||
    args.outputTruncated === true ||
    args.output_truncated === true ||
    args.bytesTruncated === true ||
    args.linesTruncated === true ||
    /\btruncat(?:ed|ion)\b/i.test(tool.summary ?? "");
  if (truncated) segments.push("truncated");
  return segments.length > 0 ? segments.join(" · ") : undefined;
}

export function toolFailureLabel(status: ToolStatus): string | undefined {
  if (status === "failed") return "Failed";
  if (status === "denied") return "Denied";
  if (status === "cancelled") return "Cancelled";
  return undefined;
}

const CONNECTOR_NAMES: Record<string, string> = {
  gmail: "Gmail",
  google_drive: "Google Drive",
  gdrive: "Google Drive",
  google_calendar: "Google Calendar",
  google_docs: "Google Docs",
  google_sheets: "Google Sheets",
  outlook: "Outlook",
  sharepoint: "SharePoint",
  onedrive: "OneDrive",
  teams: "Teams",
  salesforce: "Salesforce",
  hubspot: "HubSpot",
  slack: "Slack",
  notion: "Notion",
  jira: "Jira",
  confluence: "Confluence",
  github: "GitHub",
  linear: "Linear",
  zendesk: "Zendesk",
};

function connectorDisplayName(raw: string): string {
  const key = raw.trim().toLowerCase().replace(/[\s.-]+/g, "_");
  return CONNECTOR_NAMES[key] ?? prettyToolKind(raw);
}

/**
 * Plain-language label for tools that are not files, commands or searches:
 * connector calls read as the app ("Salesforce · Get opportunity"), and
 * Berry's own tools say what happened ("Saved to memory"). Undefined means
 * the caller falls back to the prettified tool name.
 */
export function namedToolLabel(tool: ActivityTool): { label: string; detail?: string | undefined } | undefined {
  const name = tool.name.trim().toLowerCase().replace(/[.-]/g, "_");
  const running = tool.status === "running";
  const args = tool.args;
  const titled = tool.title && tool.title !== tool.name ? tool.title : undefined;
  if (name === "use_tool" || name === "call_tool" || name === "mcp_call" || name === "connector_call") {
    const connector = toolStringArg(args, "connector", "server", "app", "provider", "integration");
    const action = titled ?? (() => {
      const raw = toolStringArg(args, "tool", "action", "operation", "name");
      return raw ? prettyToolKind(raw) : undefined;
    })();
    return { label: connector ? connectorDisplayName(connector) : "Connector", detail: action };
  }
  if (name === "remember_memory" || name === "save_memory") {
    return { label: running ? "Saving to memory" : "Saved to memory", detail: titled ?? toolStringArg(args, "memory", "content", "text") };
  }
  if (name === "forget_memory") {
    return { label: running ? "Removing from memory" : "Removed from memory", detail: titled ?? toolStringArg(args, "memory", "query", "id") };
  }
  if (name === "memory_operations") {
    return { label: running ? "Updating memory" : "Updated memory", detail: titled };
  }
  if (name === "persist_artifact") {
    const path = toolStringArg(args, "path", "file", "filePath", "file_path") ?? titled;
    const base = path ? path.split("/").filter(Boolean).pop() : undefined;
    return { label: running ? "Saving file" : "Saved file", detail: base };
  }
  if (name === "tool_search") {
    return { label: running ? "Finding tools" : "Found tools", detail: toolStringArg(args, "query") ?? titled };
  }
  if (name === "create_image") {
    return { label: running ? "Creating image" : "Created image", detail: toolStringArg(args, "prompt") ?? titled };
  }
  if (name === "inspect_images") {
    return { label: running ? "Looking at images" : "Looked at images", detail: titled };
  }
  if (name === "save_personal_skill") {
    return { label: running ? "Saving skill" : "Saved skill", detail: toolStringArg(args, "name") ?? titled };
  }
  return undefined;
}

/** Whether a tool is Berry's skill loader (any of its historical names). */
export function isSkillTool(name: string): boolean {
  return /^(?:skill|skill[._-]invoke|invoke_skill|activate_skill|activate[._-]skill)$/i.test(name);
}

/** Fetches open one page; searches look things up. */
export function isFetchTool(tool: ActivityTool): boolean {
  return /fetch|open_url|browse_url/i.test(tool.name);
}

/** DefaultRow's label: "workspace.scan" → "Workspace Scan". */
export function prettyToolKind(name: string): string {
  return name
    .split(/[._-]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** Paths under the workspace root show relative ("apps/desktop/"). */
export function relativizeToolPath(path: string, root: string): string {
  if (root && path.startsWith(`${root}/`)) return path.slice(root.length + 1);
  if (root && path === root) return "";
  return path;
}

export function splitToolPath(path: string, root: string): { base: string; dir?: string } {
  const rel = relativizeToolPath(path, root);
  const slash = rel.lastIndexOf("/");
  if (slash === -1) return { base: rel };
  return { base: rel.slice(slash + 1), dir: rel.slice(0, slash + 1) };
}

/* --------------- Berry Explore grouping (get/CX/pet/met) ---------------- */

const READ_CMD =
  /\b(rg|grep|find|ls|cat|head|tail|wc|stat|pwd|which|readlink|tree|sed\s+-n|get-childitem|gci|dir|get-content|gc|type|select-string|sls|get-location|test-path|resolve-path)\b|^git\s+(status|log|show|diff)\b/i;
const WRITE_CMD =
  /\b(sed\s+-i|perl\s+-pi|tee|mv|cp|rm|mkdir|rmdir|touch|truncate|chmod|chown|remove-item|del|erase|set-content|add-content|clear-content|out-file|new-item|move-item|copy-item|rename-item|set-item)\b|^git\s+(add|commit|rm|mv|checkout|switch|restore|reset|clean|revert|cherry-pick|merge|rebase)\b/i;
const REDIRECT = /(^|[^\d<])>>?\s*\S|&>\s*\S/i;
const LOOP = /\b(for|while)\b/i;

export function isExploreEligible(tool: ActivityTool): boolean {
  const family = familyFromTool(tool.name);
  if (family === "file-write") return false;
  if (family === "file-read" || family === "search" || family === "explore") return true;
  if (family !== "shell") return false;
  const command = toolCommand(tool);
  if (!command) return false;
  const commands = command.split(/&&|\|\||;|\|/).map((part) => part.trim()).filter(Boolean);
  if (commands.length === 0) return false;
  if (commands.some((cmd) => WRITE_CMD.test(cmd) || REDIRECT.test(cmd))) return false;
  if (commands.some((cmd) => READ_CMD.test(cmd))) return true;
  return commands.some((cmd) => LOOP.test(cmd) && READ_CMD.test(cmd));
}

export type ExploreBucket = "search" | "list" | "file";

export function exploreBucket(tool: ActivityTool): ExploreBucket {
  // Normalize separators before deriving the compact activity bucket.
  const label = `${tool.name} ${tool.title ?? ""}`.toLowerCase().replace(/[._-]/g, " ");
  const cmd = (toolCommand(tool) ?? "").toLowerCase();
  if (/(\bgrep\b|\bsearch\b|\bfetch\b|\bweb.?search\b|\bweb.?fetch\b)/.test(label) || /(^|\s)(rg|grep|ripgrep|git\s+grep)(\s|$)/.test(cmd)) {
    return "search";
  }
  if (/(\bglob\b|\bfind\b|\blist\b|\btree\b|\bdir\b|\bls\b)/.test(label) || /(^|\s)(ls|find|tree|dir)(\s|$)/.test(cmd)) {
    return "list";
  }
  return "file";
}

/** "2 searches, 1 list, 3 files". */
export function exploreSummary(tools: ActivityTool[]): string {
  const counts: Record<ExploreBucket, number> = { search: 0, list: 0, file: 0 };
  for (const tool of tools) counts[exploreBucket(tool)] += 1;
  const label: Record<ExploreBucket, [string, string]> = {
    search: ["search", "searches"],
    list: ["list", "lists"],
    file: ["file", "files"],
  };
  const segments = (Object.keys(counts) as ExploreBucket[])
    .filter((bucket) => counts[bucket] > 0)
    .map((bucket) => `${counts[bucket]} ${label[bucket][counts[bucket] === 1 ? 0 : 1]}`);
  return segments.length > 0 ? segments.join(", ") : "0 files";
}

/** Only flag an Explore group when nothing in it succeeded; failed probes are routine. */
export function exploreGroupFailed(tools: ActivityTool[]): boolean {
  return tools.length > 0 && tools.every((tool) => tool.status === "failed" || tool.status === "denied" || tool.status === "cancelled");
}

/* ------------------------------ Todo (Jtt) ------------------------------- */

export type TodoStatus = "pending" | "in_progress" | "completed";
export interface TodoItem {
  content: string;
  status: TodoStatus;
}

/** Read the checklist off the `todo_write` call's arguments. */
export function todosFromTool(tool: ActivityTool): TodoItem[] {
  const raw = tool.args && typeof tool.args === "object" ? (tool.args as Record<string, unknown>).todos : undefined;
  if (!Array.isArray(raw)) return [];
  const items: TodoItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const content = typeof record.content === "string" ? record.content : "";
    if (!content) continue;
    const status: TodoStatus = record.status === "completed" || record.status === "in_progress" ? record.status : "pending";
    items.push({ content, status });
  }
  return items;
}

/** The current item: the in-progress one, else the first pending, else the last. */
export function currentTodo(todos: TodoItem[]): TodoItem | undefined {
  return todos.find((item) => item.status === "in_progress")
    ?? todos.find((item) => item.status !== "completed")
    ?? todos[todos.length - 1];
}

/* ----------------------------- Row descriptors ----------------------------- */

export type ToolRowIcon = "terminal" | "search" | "globe" | "pencil" | "wrench" | "rocket" | "help" | "notebook" | "book" | "todo";

export type ToolRowText = {
  text: string;
  mono?: boolean;
  /** A file the row links to (opens the file preview). */
  path?: string;
  /** A URL the row links to. */
  url?: string;
};

export type ToolRowDetail =
  | { kind: "command"; command: string; output?: string | undefined; running: boolean }
  | { kind: "output"; output: string }
  | { kind: "raw"; raw?: string | undefined; output?: string | undefined; markdown: boolean }
  | { kind: "todos"; todos: TodoItem[] }
  | { kind: "question"; question: string; options: Array<{ label: string; description?: string | undefined }>; answer?: string | undefined }
  | { kind: "context"; query: string; output?: string | undefined }
  | { kind: "markdown"; markdown: string };

export type ToolRowDescriptor = {
  /** Stable identity for remembered disclosure state. */
  id: string;
  icon: ToolRowIcon;
  label: string;
  running: boolean;
  primary?: ToolRowText | undefined;
  secondary?: ToolRowText | undefined;
  meta?: string | undefined;
  status?: string | undefined;
  detail?: ToolRowDetail | undefined;
};

/** What one tool row says (ToolRow → ShellRow/ReadRow/SearchRow/EditRow/…). */
export function describeToolRow(tool: ActivityTool, root = ""): ToolRowDescriptor {
  const running = tool.status === "running";
  const base = { id: tool.toolCallId, running, meta: toolMetaText(tool), status: toolFailureLabel(tool.status) };
  const output = toolOutput(tool);
  const raw = tool.args && Object.keys(tool.args).length > 0 ? JSON.stringify(tool.args, null, 2) : undefined;

  if (tool.name === "todo_write") {
    const todos = todosFromTool(tool);
    if (todos.length > 0) {
      const current = currentTodo(todos);
      const completed = todos.filter((item) => item.status === "completed").length;
      return {
        ...base,
        id: `${tool.toolCallId}:todo`,
        icon: "todo",
        label: "Todo",
        status: undefined,
        primary: current ? { text: current.content } : undefined,
        secondary: { text: `${completed}/${todos.length}`, mono: true },
        detail: { kind: "todos", todos },
      };
    }
    return describeDefaultRow(tool, base, output, raw);
  }
  if (isSkillTool(tool.name)) {
    const name = toolStringArg(tool.args, "skill", "skillName", "skill_name", "name", "id") ?? tool.title ?? "Skill";
    return {
      ...base,
      icon: "rocket",
      label: running ? "Running skill" : "Skill",
      primary: { text: name },
      detail: output || raw ? { kind: "raw", raw, output, markdown: true } : undefined,
    };
  }
  if (/^(?:ask_user_question|ask[._-]user[._-]question|question[._-]ask)$/i.test(tool.name)) {
    const question = toolStringArg(tool.args, "question", "prompt") ?? tool.title ?? "User input requested";
    const optionsRaw = Array.isArray(tool.args?.options) ? tool.args.options : [];
    const answer = toolStringArg(tool.args, "answer") ?? output;
    const options = optionsRaw.map((option) => {
      const record = option && typeof option === "object" ? (option as Record<string, unknown>) : {};
      return {
        label: typeof record.label === "string" ? record.label : String(option),
        description: typeof record.description === "string" ? record.description : undefined,
      };
    });
    return {
      ...base,
      icon: "help",
      label: running ? "Asking" : "Question",
      primary: { text: question },
      detail: options.length > 0 || answer ? { kind: "question", question, options, answer } : undefined,
    };
  }
  if (/^(?:goal|session[._-]target|target[._-]set|goal[._-](?:set|update))$/i.test(tool.name)) {
    const goal = toolStringArg(tool.args, "goal", "goal_text", "goalText", "target", "title") ?? tool.title ?? "Session goal";
    const status = toolStringArg(tool.args, "status");
    return {
      ...base,
      icon: "notebook",
      label: running ? "Updating goal" : "Goal",
      primary: { text: goal },
      secondary: status ? { text: status.replace(/[_-]/g, " ") } : undefined,
      detail: output ? { kind: "markdown", markdown: output } : undefined,
    };
  }
  if (/^(?:session[._-]context|read[._-]session[._-]context|context[._-]read)$/i.test(tool.name)) {
    const query = toolStringArg(tool.args, "query", "reason", "context", "summary") ?? tool.title ?? "Session context";
    return {
      ...base,
      icon: "book",
      label: running ? "Reading context" : "Session context",
      primary: { text: query },
      detail: { kind: "context", query, output },
    };
  }

  const family = familyFromTool(tool.name);
  if (family === "shell") {
    const command = toolCommand(tool);
    return {
      ...base,
      icon: "terminal",
      label: running ? "Running" : "Ran",
      secondary: command ? { text: command, mono: true } : undefined,
      detail: { kind: "command", command: command ?? tool.title ?? tool.name, output, running },
    };
  }
  if (family === "file-read") {
    const path = toolFilePath(tool);
    const { base: name, dir } = path ? splitToolPath(path, root) : { base: tool.name, dir: undefined };
    return {
      ...base,
      icon: "search",
      label: running ? "Reading" : "Read",
      primary: { text: name, ...(path ? { path } : {}) },
      secondary: dir ? { text: dir } : undefined,
    };
  }
  if (family === "file-write") {
    const normalized = tool.name.toLowerCase().replace(/[.-]/g, "_");
    const isDelete = /(?:^|_)(delete|remove|rm|unlink)(?:_|$)/.test(normalized);
    const isWrite = /(?:^|_)(write|create|save)/.test(normalized);
    const label = isDelete
      ? running ? "Deleting" : "Deleted"
      : running ? isWrite ? "Writing" : "Editing" : isWrite ? "Wrote" : "Edited";
    const path = toolFilePath(tool);
    const { base: name, dir } = path ? splitToolPath(path, root) : { base: tool.name, dir: undefined };
    return {
      ...base,
      icon: "pencil",
      label,
      primary: { text: name, ...(path ? { path } : {}) },
      secondary: dir ? { text: dir } : undefined,
      detail: output ? { kind: "output", output } : undefined,
    };
  }
  if (family === "search" || family === "explore") {
    const isWeb = /web|fetch|url/i.test(tool.name);
    const isList = exploreBucket(tool) === "list";
    const isFetch = isFetchTool(tool);
    const query = toolQuery(tool);
    const display = query && query.startsWith("/") ? relativizeToolPath(query, root) : query;
    return {
      ...base,
      icon: isWeb ? "globe" : "search",
      label: isFetch
        ? running ? "Opening" : "Opened"
        : running ? (isList ? "Listing" : "Searching") : isList ? "Listed" : "Searched",
      primary: display ? { text: display, ...(isWeb && isLikelyUrl(display) ? { url: display } : {}) } : undefined,
    };
  }
  return describeDefaultRow(tool, base, output, raw);
}

function describeDefaultRow(
  tool: ActivityTool,
  base: Pick<ToolRowDescriptor, "id" | "running" | "meta" | "status">,
  output: string | undefined,
  raw: string | undefined,
): ToolRowDescriptor {
  const browser = /^browser[._-]/i.test(tool.name);
  const browserUrl = browser ? toolBrowserUrl(tool) : undefined;
  const browserSessionId = browser ? toolBrowserSession(tool) : undefined;
  const named = namedToolLabel(tool);
  if (named) {
    return {
      ...base,
      icon: "wrench",
      label: named.label,
      primary: named.detail ? { text: named.detail } : undefined,
      detail: output || raw ? { kind: "raw", raw, output, markdown: false } : undefined,
    };
  }
  return {
    ...base,
    icon: "wrench",
    label: prettyToolKind(tool.name),
    primary: browserUrl || browserSessionId
      ? { text: browserUrl ?? browserSessionId ?? "Browser session", ...(browserUrl ? { url: browserUrl } : {}) }
      : tool.title && tool.title !== tool.name ? { text: tool.title } : undefined,
    detail: output || raw ? { kind: "raw", raw, output, markdown: false } : undefined,
  };
}

/* ------------------------ ToolFlow (the walker) ------------------------- */

export type ToolFlowSegment =
  | { kind: "explore"; tools: ActivityTool[] }
  | { kind: "single"; tool: ActivityTool }
  | { kind: "subagent"; tool: ActivityTool };

/**
 * One consecutive run of tool calls the way Berry's message walker groups
 * it: consecutive explore-eligible calls collapse into one Explore group (a
 * lone eligible call too); sub-agent dispatches and everything else render
 * as their own rows.
 */
export function toolFlowSegments(tools: ActivityTool[], showTodos = true): ToolFlowSegment[] {
  const visibleTools = showTodos ? tools : tools.filter((tool) => tool.name !== "todo_write");
  const segments: ToolFlowSegment[] = [];
  for (const tool of visibleTools) {
    if (tool.name === "task") {
      segments.push({ kind: "subagent", tool });
    } else if (isExploreEligible(tool)) {
      const last = segments[segments.length - 1];
      if (last && last.kind === "explore") last.tools.push(tool);
      else segments.push({ kind: "explore", tools: [tool] });
    } else {
      segments.push({ kind: "single", tool });
    }
  }
  return segments;
}

/** A sub-agent dispatch's header and boxes. */
export function subagentInfo(tool: ActivityTool): { agentType: string; named: boolean; description: string; prompt: string; output: string; children: ActivityTool[] } {
  const args = tool.args ?? {};
  const agentType = typeof args.subagent_type === "string" && args.subagent_type.trim() ? args.subagent_type.trim() : "general-purpose";
  return {
    agentType,
    // Berry only shows the agent-name pill for a specifically-named agent.
    named: agentType !== "general-purpose" && agentType !== "general",
    description: typeof args.description === "string" ? args.description.trim() : "",
    prompt: typeof args.prompt === "string" ? args.prompt.trim() : "",
    output: (tool.output ?? tool.summary ?? "").trim(),
    children: tool.children ?? [],
  };
}

/* --------------------------- Live action text --------------------------- */

export type ToolActionText = {
  key: string;
  /** "Explore" / "SubAgent" group prefix, shown before a "·". */
  prefix?: string | undefined;
  verb: string;
  text?: string | undefined;
  mono?: boolean | undefined;
};

/**
 * Live verb + label for one tool call (Berry `aZ`): the command for shell,
 * the file name for reads/writes, the query for searches, and a prettified
 * kind + title for everything else.
 */
export function toolActionText(active: ActivityTool, root = ""): ToolActionText {
  const family = familyFromTool(active.name);
  if (family === "shell") {
    const command = toolCommand(active);
    if (command) return { key: `shell:${active.toolCallId}:${command}`, verb: "Running", text: command, mono: true };
  }
  if (family === "file-read" || family === "file-write") {
    const path = toolFilePath(active);
    if (path) {
      const { base } = splitToolPath(path, root);
      const normalized = active.name.toLowerCase().replace(/[.-]/g, "_");
      const verb = family === "file-read"
        ? "Reading"
        : /(?:^|_)(delete|remove|rm|unlink)(?:_|$)/.test(normalized)
          ? "Deleting"
          : /(?:^|_)(write|create|save)/.test(normalized) ? "Writing" : "Editing";
      return { key: `${verb}:${active.toolCallId}:${path}`, verb, text: base };
    }
  }
  if (family === "search" || family === "explore") {
    const query = toolQuery(active);
    if (query) {
      const display = query.startsWith("/") ? relativizeToolPath(query, root) : query;
      const verb = isFetchTool(active) ? "Opening" : exploreBucket(active) === "list" ? "Listing" : "Searching";
      return { key: `${verb}:${active.toolCallId}:${display}`, verb, text: display };
    }
  }
  const named = namedToolLabel(active);
  if (named) {
    return { key: `named:${active.toolCallId}:${named.label}:${named.detail ?? ""}`, verb: named.label, text: named.detail };
  }
  return {
    key: `tool:${active.toolCallId}:${active.title ?? active.name}`,
    verb: prettyToolKind(active.name),
    text: active.title && active.title !== active.name ? active.title : undefined,
  };
}

/** The newest describable child, walking from the end. */
export function liveChildActionText(tools: ActivityTool[], root = ""): ToolActionText | null {
  const child = tools[tools.length - 1];
  return child ? toolActionText(child, root) : null;
}

/**
 * The turn's current activity for the collapsed "Working…" header: the most
 * recent running tool (drilling into a running sub-agent), prefixed with its
 * group kind — "Explore · Reading …", "SubAgent · …".
 */
export function latestTurnActionText(tools: ActivityTool[], root = ""): ToolActionText | null {
  if (tools.length === 0) return null;
  const active = [...tools].reverse().find((tool) => tool.status === "running") ?? tools[tools.length - 1]!;
  if (active.name === "task") {
    const childAction = active.status === "running" ? liveChildActionText(active.children ?? [], root) : null;
    if (childAction) return { ...childAction, key: `SubAgent:${childAction.key}`, prefix: "Agent" };
    const args = active.args ?? {};
    const description = typeof args.description === "string" ? args.description : active.title;
    return { key: `task:${active.toolCallId}`, verb: "Agent", text: description };
  }
  const action = toolActionText(active, root);
  return isExploreEligible(active) ? { ...action, key: `Explore:${action.key}`, prefix: "Explore" } : action;
}

/* ------------------------------ Headers -------------------------------- */

export function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
}

/** "Working for 12s" / "Worked for 1m 3s — read 3 files" / the durable phase. */
export function turnActivityLabel(input: { active: boolean; elapsedMs?: number | undefined; activeLabel?: string | undefined; summary?: string | undefined }): string {
  const { active, elapsedMs, activeLabel, summary } = input;
  const time = elapsedMs !== undefined && (!active || elapsedMs >= 1000) ? ` for ${formatDuration(elapsedMs)}` : "";
  const totalElapsed = elapsedMs !== undefined && elapsedMs >= 1000 ? ` · ${formatDuration(elapsedMs)} total` : "";
  if (active) return activeLabel ? `${activeLabel}${totalElapsed}` : `Working${time || "..."}`;
  return `Worked${time}${summary ? ` — ${summary}` : ""}`;
}

/** The reasoning row's suffix: nothing while thinking, else "for a few seconds" / "for 12s". */
export function thoughtSuffix(active: boolean, durationMs?: number): string {
  if (active) return "";
  return durationMs !== undefined && durationMs >= 10_000 ? `for ${formatDuration(durationMs)}` : "for a few seconds";
}
