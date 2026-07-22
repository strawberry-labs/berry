import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { SubagentManifest, SubagentScope } from "@berry/shared";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/** Reserved names that user/workspace agents may not shadow. */
const BUILT_IN_NAMES = new Set(["general-purpose", "explore"]);
const NAME_RE = /^[a-zA-Z0-9-]{3,50}$/;

const GENERAL_PURPOSE_SYSTEM_PROMPT = [
  "You are Berry's general-purpose sub-agent.",
  "",
  "Complete the delegated task using the tools available to you. Your parent agent only receives your final report, so do the necessary reading, searching, editing, command execution, and verification yourself when the task calls for it.",
  "",
  "Guidelines:",
  "- Treat the prompt you received as the complete task brief. Do not assume access to the parent conversation.",
  "- Search broadly first when the relevant files are not obvious, then read the specific code before making claims or changes.",
  "- Keep edits focused and consistent with the surrounding codebase.",
  "- Use `todo_write` for non-trivial multi-step tasks.",
  "- Run focused verification when feasible and include the result in your final report.",
  "- Do not create extra reports, notes, or documentation files unless the task explicitly asks for them.",
  "- Return a concise final report with file references as `path:line` where useful.",
].join("\n");

const EXPLORE_SYSTEM_PROMPT = [
  "You are Berry's read-only exploration sub-agent.",
  "",
  "Research the codebase and return findings. You must not create, modify, delete, move, copy, format, install, commit, checkpoint, or otherwise change files or external state.",
  "",
  "Allowed behavior:",
  "- Use read-only tools such as `glob`, `grep`, `read_file`, `list_dir`, `git_status`, `git_diff`, and `git_log`.",
  "- Start with broad searches when the location is unclear, then read the smallest useful set of files.",
  "- Investigate enough to answer confidently, including related call sites, tests, and type definitions when relevant.",
  "- If asked to make a change, explain what should change and where, but do not perform the edit.",
  "- Return a direct final report with the key findings, relevant paths, and `path:line` references where useful.",
].join("\n");

export function userSubagentDir(): string {
  return join(homedir(), ".berry", "agents");
}
export function workspaceSubagentDir(workspacePath: string): string {
  return join(workspacePath, ".berry", "agents");
}
function stateFile(): string {
  return join(homedir(), ".berry", "agents-state.json");
}

/** The two built-in agents, mirroring Berry's general-purpose + explore. */
export function builtInSubagents(): SubagentManifest[] {
  return [
    {
      id: "built-in:general-purpose",
      name: "general-purpose",
      description: "General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks.",
      systemPrompt: GENERAL_PURPOSE_SYSTEM_PROMPT,
      model: null,
      color: "blue",
      tools: ["*"],
      disallowedTools: [],
      skills: [],
      permissionMode: null,
      maxTurns: null,
      scope: "built-in",
      path: "built-in:general-purpose",
      enabled: true,
      readOnly: true,
    },
    {
      id: "built-in:explore",
      name: "explore",
      description: "Read-only search agent for broad fan-out searches — locates code across many files; returns findings, doesn't edit.",
      systemPrompt: EXPLORE_SYSTEM_PROMPT,
      model: "lite",
      color: "cyan",
      tools: ["read_file", "list_dir", "glob", "grep", "git_status", "git_diff", "git_log"],
      disallowedTools: [],
      skills: [],
      permissionMode: null,
      maxTurns: null,
      scope: "built-in",
      path: "built-in:explore",
      enabled: true,
      readOnly: true,
    },
  ];
}

interface Frontmatter {
  name?: string;
  description?: string;
  model?: string;
  color?: string;
  tools?: string[] | string;
  disallowedTools?: string[] | string;
  skills?: string[] | string;
  permissionMode?: string;
  maxTurns?: number;
}

const asArray = (value: string[] | string | undefined): string[] =>
  Array.isArray(value) ? value.map(String) : typeof value === "string" ? [value] : [];

/**
 * Parse a sub-agent Markdown file: `---` YAML frontmatter, then the body as the
 * system prompt. Returns null (with a reason) when invalid.
 */
export function parseSubagentMarkdown(
  content: string,
  path: string,
  scope: SubagentScope,
): { agent: SubagentManifest } | { error: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (!match) return { error: "missing YAML frontmatter" };
  let fm: Frontmatter;
  try {
    fm = (parseYaml(match[1] ?? "") ?? {}) as Frontmatter;
  } catch (error) {
    return { error: `invalid YAML: ${(error as Error).message}` };
  }
  const name = (fm.name ?? basename(path).replace(/\.(md|markdown)$/i, "")).trim();
  if (!NAME_RE.test(name)) return { error: `invalid agent name "${name}" (3-50 chars, letters/digits/hyphens)` };
  const description = (fm.description ?? "").trim();
  if (!description) return { error: "missing description" };
  const tools = asArray(fm.tools);
  return {
    agent: {
      id: `${scope}:${name}`,
      name,
      description,
      systemPrompt: (match[2] ?? "").trim(),
      model: fm.model ?? null,
      color: fm.color ?? null,
      tools: tools.length > 0 ? tools : ["*"],
      disallowedTools: asArray(fm.disallowedTools),
      skills: asArray(fm.skills),
      permissionMode: fm.permissionMode ?? null,
      maxTurns: typeof fm.maxTurns === "number" ? fm.maxTurns : null,
      scope,
      path,
      enabled: true,
      readOnly: scope !== "user",
    },
  };
}

/** Serialize a manifest back to Markdown (frontmatter + system-prompt body). */
export function serializeSubagentMarkdown(agent: SubagentManifest): string {
  const frontmatter: Record<string, unknown> = { name: agent.name, description: agent.description };
  if (agent.model) frontmatter.model = agent.model;
  if (agent.color) frontmatter.color = agent.color;
  if (agent.tools.length > 0 && !(agent.tools.length === 1 && agent.tools[0] === "*")) frontmatter.tools = agent.tools;
  if (agent.disallowedTools.length > 0) frontmatter.disallowedTools = agent.disallowedTools;
  if (agent.skills.length > 0) frontmatter.skills = agent.skills;
  if (agent.permissionMode) frontmatter.permissionMode = agent.permissionMode;
  if (agent.maxTurns != null) frontmatter.maxTurns = agent.maxTurns;
  return `---\n${stringifyYaml(frontmatter).trimEnd()}\n---\n\n${agent.systemPrompt}\n`;
}

function readDisabledIds(): Set<string> {
  try {
    const raw = JSON.parse(readFileSync(stateFile(), "utf8")) as { disabledAgentIds?: string[] };
    return new Set(raw.disabledAgentIds ?? []);
  } catch {
    return new Set();
  }
}

function writeDisabledIds(ids: Set<string>): void {
  const dir = join(homedir(), ".berry");
  mkdirSync(dir, { recursive: true });
  writeFileSync(stateFile(), JSON.stringify({ disabledAgentIds: [...ids] }, null, 2), "utf8");
}

function discoverDir(dir: string, scope: SubagentScope, diagnostics: string[]): SubagentManifest[] {
  if (!existsSync(dir)) return [];
  const out: SubagentManifest[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((f) => /\.(md|markdown)$/i.test(f)).sort();
  } catch {
    return [];
  }
  for (const file of entries) {
    const full = join(dir, file);
    let content: string;
    try {
      content = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    const result = parseSubagentMarkdown(content, full, scope);
    if ("error" in result) {
      diagnostics.push(`${full}: ${result.error}`);
      continue;
    }
    if (scope !== "built-in" && BUILT_IN_NAMES.has(result.agent.name)) {
      diagnostics.push(`${full}: name "${result.agent.name}" is reserved by a built-in agent`);
      continue;
    }
    out.push(result.agent);
  }
  return out;
}

/**
 * Discover + merge sub-agents: built-ins, user (~/.berry/agents), workspace
 * (<ws>/.berry/agents). Later scope wins on name collision (workspace > user >
 * built-in). Disabled state (user agents only) is applied from the state file.
 */
export function loadSubagents(workspacePath: string | undefined): {
  agents: SubagentManifest[];
  diagnostics: string[];
} {
  const diagnostics: string[] = [];
  const disabled = readDisabledIds();
  const byName = new Map<string, SubagentManifest>();
  const add = (agent: SubagentManifest) => byName.set(agent.name, agent);
  builtInSubagents().forEach(add);
  discoverDir(userSubagentDir(), "user", diagnostics).forEach((agent) =>
    add({ ...agent, enabled: !disabled.has(agent.id) }),
  );
  if (workspacePath) discoverDir(workspaceSubagentDir(workspacePath), "workspace", diagnostics).forEach(add);
  return { agents: [...byName.values()], diagnostics };
}

/** Look up a single agent by name for dispatch (built-in fallback). */
export function findSubagent(name: string, workspacePath: string | undefined): SubagentManifest | undefined {
  return loadSubagents(workspacePath).agents.find((a) => a.name === name);
}

/** Write a new user agent .md file. Throws if the name already exists. */
export function createUserSubagent(agent: SubagentManifest): SubagentManifest {
  if (BUILT_IN_NAMES.has(agent.name)) throw new Error(`"${agent.name}" is a reserved built-in name`);
  if (!NAME_RE.test(agent.name)) throw new Error(`invalid agent name "${agent.name}"`);
  const dir = userSubagentDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${agent.name}.md`);
  if (existsSync(path)) throw new Error(`agent "${agent.name}" already exists`);
  const record: SubagentManifest = { ...agent, scope: "user", path, id: `user:${agent.name}`, readOnly: false };
  writeFileSync(path, serializeSubagentMarkdown(record), "utf8");
  return record;
}

/** Delete a user agent .md file and drop it from disabled state. */
export function deleteUserSubagent(name: string): void {
  const path = join(userSubagentDir(), `${name}.md`);
  if (existsSync(path)) rmSync(path);
  const disabled = readDisabledIds();
  if (disabled.delete(`user:${name}`)) writeDisabledIds(disabled);
}

/** Enable/disable a user agent (built-ins/workspace always enabled). */
export function setUserSubagentEnabled(id: string, enabled: boolean): void {
  const disabled = readDisabledIds();
  if (enabled) disabled.delete(id);
  else disabled.add(id);
  writeDisabledIds(disabled);
}
