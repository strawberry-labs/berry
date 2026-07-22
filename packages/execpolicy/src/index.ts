import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export type ExecPolicyDecision = "allow" | "prompt" | "forbid";
export type ExecPolicyLayer = "managed" | "workspace" | "user" | "session" | "base";
export type ExecPolicyRuleKind = "prefix_rule" | "exact" | "regex-lite" | "network";

export interface ExecPolicyRule {
  id: string;
  kind: ExecPolicyRuleKind;
  decision: ExecPolicyDecision;
  pattern: string[] | string;
  layer: ExecPolicyLayer;
  description?: string;
}

export interface CanonicalCommand {
  raw: string;
  argv: string[];
  display: string;
  ambiguous: boolean;
  reasons: string[];
  segments: string[][];
}

export interface ExecPolicyTraceStep {
  stage: "canonicalize" | "rule" | "default";
  ruleId?: string;
  layer?: ExecPolicyLayer;
  decision?: ExecPolicyDecision;
  detail: string;
}

export interface ExecPolicyResult {
  decision: ExecPolicyDecision;
  canonical: CanonicalCommand;
  matchedRules: ExecPolicyRule[];
  trace: ExecPolicyTraceStep[];
}

export interface ExecPolicyNetworkResult {
  decision: ExecPolicyDecision;
  url: string;
  hostname: string;
  matchedRules: ExecPolicyRule[];
  trace: ExecPolicyTraceStep[];
}

export interface LoadedExecPolicy {
  rules: ExecPolicyRule[];
  diagnostics: string[];
}

const DECISION_RANK: Record<ExecPolicyDecision, number> = { allow: 0, prompt: 1, forbid: 2 };
const OPERATORS = new Set([";", "&&", "||", "|", "&", "\n"]);

export const CURATED_BASE_POLICY: ExecPolicyRule[] = [
  rule("base-rg", "prefix_rule", "allow", ["rg"]),
  rule("base-pwd", "exact", "allow", ["pwd"]),
  rule("base-git-status", "prefix_rule", "allow", ["git", "status"]),
  rule("base-git-diff", "prefix_rule", "allow", ["git", "diff"]),
  rule("base-git-log", "prefix_rule", "allow", ["git", "log"]),
  rule("base-git-show", "prefix_rule", "allow", ["git", "show"]),
  rule("base-git-branch-current", "exact", "allow", ["git", "branch", "--show-current"]),
  rule("base-gh-pr-create", "prefix_rule", "prompt", ["gh", "pr", "create"]),
  rule("base-gh-pr-comment", "prefix_rule", "prompt", ["gh", "pr", "comment"]),
  rule("base-gh-api", "prefix_rule", "prompt", ["gh", "api"]),
  rule("base-gh-pr-merge", "prefix_rule", "forbid", ["gh", "pr", "merge"]),
  rule("base-gh-api-pr-merge", "regex-lite", "forbid", String.raw`gh\s+api\s+.*pulls/[^\s]+/merge(?:\s|$)`),
  rule("base-gh-api-graphql-merge", "regex-lite", "forbid", String.raw`gh\s+api\s+graphql\s+.*mergePullRequest`),
  rule("base-sudo", "prefix_rule", "forbid", ["sudo"]),
  rule("base-doas", "prefix_rule", "forbid", ["doas"]),
  rule("base-rm-root", "regex-lite", "forbid", String.raw`rm\s+(?:-[A-Za-z]*r[A-Za-z]*f[A-Za-z]*|-[A-Za-z]*f[A-Za-z]*r[A-Za-z]*)\s+/(?:\s|$)`),
  rule("base-git-reset-hard", "prefix_rule", "forbid", ["git", "reset", "--hard"]),
  rule("base-git-clean-force", "regex-lite", "forbid", String.raw`git\s+clean\s+-[^\s]*f`),
  rule("base-system-power", "regex-lite", "forbid", String.raw`(?:shutdown|reboot|halt|poweroff)(?:\s|$)`),
  rule("base-filesystem-format", "regex-lite", "forbid", String.raw`(?:mkfs(?:\.[A-Za-z0-9_-]+)?|diskutil\s+erase|format)(?:\s|$)`),
];

export class ExecPolicyEngine {
  readonly #rules: ExecPolicyRule[];

  constructor(rules: ExecPolicyRule[] = []) {
    this.#rules = validateRules([...CURATED_BASE_POLICY, ...rules]);
  }

  evaluate(command: string): ExecPolicyResult {
    const canonical = canonicalizeCommand(command);
    const trace: ExecPolicyTraceStep[] = [{
      stage: "canonicalize",
      detail: `${canonical.display || "(empty)"}${canonical.ambiguous ? `; ambiguous: ${canonical.reasons.join(", ")}` : ""}`,
    }];
    const matchedRules = this.#rules.filter((candidate) => matchesRule(candidate, canonical));
    for (const matched of matchedRules) {
      trace.push({ stage: "rule", ruleId: matched.id, layer: matched.layer, decision: matched.decision, detail: matched.description ?? `${matched.kind} matched` });
    }
    let decision: ExecPolicyDecision = "prompt";
    if (matchedRules.length > 0) decision = matchedRules.reduce((strictest, current) => DECISION_RANK[current.decision] > DECISION_RANK[strictest] ? current.decision : strictest, "allow" as ExecPolicyDecision);
    if (canonical.ambiguous && decision === "allow") {
      decision = "prompt";
      trace.push({ stage: "default", decision, detail: "Ambiguous shell syntax cannot be auto-allowed." });
    } else if (matchedRules.length === 0) {
      trace.push({ stage: "default", decision, detail: "No rule matched; prompt by default." });
    }
    return { decision, canonical, matchedRules, trace };
  }

  evaluateNetwork(rawUrl: string): ExecPolicyNetworkResult {
    const url = new URL(rawUrl);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    const matchedRules = this.#rules.filter((candidate) => candidate.kind === "network" && domainPatternMatches(candidate.pattern as string, hostname));
    const trace: ExecPolicyTraceStep[] = matchedRules.map((matched) => ({
      stage: "rule",
      ruleId: matched.id,
      layer: matched.layer,
      decision: matched.decision,
      detail: matched.description ?? `network rule matched ${hostname}`,
    }));
    const decision = matchedRules.length === 0
      ? "prompt"
      : matchedRules.reduce((strictest, current) => DECISION_RANK[current.decision] > DECISION_RANK[strictest] ? current.decision : strictest, "allow" as ExecPolicyDecision);
    if (matchedRules.length === 0) trace.push({ stage: "default", decision, detail: `No network rule matched ${hostname}; prompt by default.` });
    return { decision, url: url.toString(), hostname, matchedRules, trace };
  }
}

export function canonicalizeCommand(raw: string): CanonicalCommand {
  const parsed = shellTokens(raw);
  const reasons = [...parsed.reasons];
  let segments = splitSegments(parsed.tokens);
  if (segments.length > 1) reasons.push("compound shell operators");
  segments = segments.map(normalizeArgv).filter((segment) => segment.length > 0);
  let argv = segments[0] ?? [];
  if ((argv[0] === "bash" || argv[0] === "sh" || argv[0] === "zsh") && (argv[1] === "-lc" || argv[1] === "-c")) {
    if (argv.length !== 3) reasons.push("shell body has positional arguments");
    const nested = canonicalizeCommand(argv[2] ?? "");
    argv = nested.argv;
    segments = nested.segments;
    reasons.push(...nested.reasons);
  }
  for (const segment of segments) reasons.push(...flagReasons(segment));
  return {
    raw,
    argv,
    display: argv.map(displayToken).join(" "),
    ambiguous: reasons.length > 0,
    reasons: [...new Set(reasons)],
    segments,
  };
}

const SAFE_FLAGS: Record<string, RegExp> = {
  "git status": /^(?:-s|-b|--short|--branch|--porcelain(?:=v[12])?|--show-stash|--ahead-behind|--no-ahead-behind|--untracked-files(?:=(?:no|normal|all))?|--ignored(?:=(?:traditional|matching|no))?|--column(?:=.*)?|--no-column|-z)$/,
  "git diff": /^(?:--cached|--staged|--stat|--numstat|--shortstat|--dirstat(?:=.*)?|--summary|--name-only|--name-status|--check|--color(?:=.*)?|--no-color|--word-diff(?:=.*)?|--no-renames|--find-renames(?:=.*)?|--relative(?:=.*)?|--src-prefix=.*|--dst-prefix=.*|--line-prefix=.*|-U\d+|--unified=\d+)$/,
  "git log": /^(?:--oneline|--decorate(?:=.*)?|--graph|--stat|--shortstat|--name-only|--name-status|--no-merges|--merges|--first-parent|--all|--branches(?:=.*)?|--tags(?:=.*)?|--remotes(?:=.*)?|--since=.*|--until=.*|--author=.*|--grep=.*|-n\d+|--max-count=\d+|--skip=\d+|--format=.*|--pretty(?:=.*)?)$/,
  "git show": /^(?:--stat|--shortstat|--summary|--name-only|--name-status|--format=.*|--pretty(?:=.*)?|--oneline|--decorate(?:=.*)?|--color(?:=.*)?|--no-color|-U\d+|--unified=\d+)$/,
  rg: /^(?:-i|-s|-S|-F|-w|-x|-v|-l|-L|-c|--count-matches|-n|-N|--column|--heading|--no-heading|-H|-h|--hidden|--no-ignore|--glob=.*|-g|--type=.*|-t|--type-not=.*|-T|--max-count=\d+|-m|--max-depth=\d+|--files|--files-with-matches|--files-without-match|--json|--stats|--sort=.*|--sortr=.*|--color(?:=.*)?|--colors=.*|-A\d+|-B\d+|-C\d+|--after-context=\d+|--before-context=\d+|--context=\d+|--)$/,
};

function flagReasons(argv: string[]): string[] {
  if (argv.length === 0) return [];
  const key = argv[0] === "git" && argv[1] ? `git ${argv[1]}` : argv[0]!;
  const safe = SAFE_FLAGS[key];
  if (!safe) return [];
  const start = key.startsWith("git ") ? 2 : 1;
  const reasons: string[] = [];
  for (let index = start; index < argv.length; index += 1) {
    const candidate = argv[index]!;
    if (candidate === "--") break;
    if (!candidate.startsWith("-")) continue;
    if (!safe.test(candidate)) reasons.push(`unknown or execution-affecting flag ${candidate}`);
  }
  return reasons;
}

export function loadExecPolicy(workspacePath: string, managedRules: unknown[] = [], sessionRules: unknown[] = []): LoadedExecPolicy {
  const rules: ExecPolicyRule[] = [];
  const diagnostics: string[] = [];
  const sources = [
    { path: join(process.env.BERRY_HOME ?? join(homedir(), ".berry"), "execpolicy.json"), layer: "user" as const },
    { path: join(workspacePath, ".berry", "execpolicy.json"), layer: "workspace" as const },
  ];
  for (const source of sources) {
    if (!existsSync(source.path)) continue;
    try {
      const root = JSON.parse(readFileSync(source.path, "utf8")) as { rules?: unknown };
      if (!Array.isArray(root.rules)) throw new Error("rules must be an array");
      rules.push(...root.rules.map((candidate) => validateRule({ ...asObject(candidate), layer: source.layer })));
    } catch (error) {
      diagnostics.push(`${source.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const [layer, values] of [["managed", managedRules], ["session", sessionRules]] as const) {
    for (const value of values) {
      try { rules.push(validateRule({ ...asObject(value), layer })); }
      catch (error) { diagnostics.push(`${layer}: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }
  return { rules, diagnostics };
}

export function validateRules(rules: ExecPolicyRule[]): ExecPolicyRule[] {
  const seen = new Set<string>();
  return rules.map((candidate) => {
    const validated = validateRule(candidate);
    if (seen.has(validated.id)) throw new Error(`duplicate execpolicy rule id: ${validated.id}`);
    seen.add(validated.id);
    return validated;
  });
}

export function validateRule(value: unknown): ExecPolicyRule {
  const ruleValue = asObject(value);
  const id = stringField(ruleValue, "id");
  const kind = enumField(ruleValue, "kind", ["prefix_rule", "exact", "regex-lite", "network"] as const);
  const decision = enumField(ruleValue, "decision", ["allow", "prompt", "forbid"] as const);
  const layer = enumField(ruleValue, "layer", ["managed", "workspace", "user", "session", "base"] as const);
  const pattern = ruleValue.pattern;
  if ((kind === "prefix_rule" || kind === "exact") && (!Array.isArray(pattern) || pattern.length === 0 || !pattern.every((item) => typeof item === "string" && item.length > 0))) {
    throw new Error(`${id}: ${kind} pattern must be a non-empty string array`);
  }
  if ((kind === "regex-lite" || kind === "network") && (typeof pattern !== "string" || !pattern.trim())) throw new Error(`${id}: ${kind} pattern must be a string`);
  if (kind === "regex-lite") compileRegexLite(pattern as string);
  if (kind === "network" && !/^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(pattern as string)) throw new Error(`${id}: network pattern must be an exact domain or wildcard subdomain`);
  return { id, kind, decision, pattern: pattern as string[] | string, layer, ...(typeof ruleValue.description === "string" ? { description: ruleValue.description } : {}) };
}

function matchesRule(ruleValue: ExecPolicyRule, command: CanonicalCommand): boolean {
  if (ruleValue.kind === "network") return false;
  const segments = command.segments.length > 0 ? command.segments : [command.argv];
  return segments.some((argv) => {
    if (ruleValue.kind === "exact") return arraysEqual(argv, ruleValue.pattern as string[]);
    if (ruleValue.kind === "prefix_rule") return startsWith(argv, ruleValue.pattern as string[]);
    return compileRegexLite(ruleValue.pattern as string).test(argv.map(displayToken).join(" "));
  });
}

function domainPatternMatches(pattern: string, hostname: string): boolean {
  const normalized = pattern.trim().toLowerCase().replace(/\.$/, "");
  if (normalized.startsWith("*.")) return hostname.endsWith(normalized.slice(1)) && hostname.length > normalized.length - 1;
  return hostname === normalized;
}

function compileRegexLite(pattern: string): RegExp {
  if (pattern.length > 500 || /\(\?[=!<]|\\[1-9]|\{\d|\(\?>/.test(pattern)) throw new Error("regex-lite forbids lookaround, backreferences, atomic groups, and counted repetition");
  try { return new RegExp(`^(?:${pattern})`); }
  catch (error) { throw new Error(`invalid regex-lite: ${error instanceof Error ? error.message : String(error)}`); }
}

function shellTokens(input: string): { tokens: string[]; reasons: string[] } {
  const tokens: string[] = [];
  const reasons: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;
  const push = () => { if (current) { tokens.push(current); current = ""; } };
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    const pair = input.slice(index, index + 2);
    if (escaping) { current += char; escaping = false; continue; }
    if (char === "\\" && quote !== "'") { escaping = true; continue; }
    if (quote) {
      if (char === quote) quote = undefined;
      else { current += char; if (quote === '"' && (char === "$" || char === "`")) reasons.push("shell expansion"); }
      continue;
    }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (pair === "&&" || pair === "||") { push(); tokens.push(pair); index += 1; continue; }
    if (char === ";" || char === "|" || char === "&" || char === "\n") { push(); tokens.push(char); continue; }
    if (char === "$" || char === "`") { reasons.push("shell expansion"); current += char; continue; }
    if (/\s/.test(char)) { push(); continue; }
    current += char;
  }
  if (quote) reasons.push("unterminated quote");
  if (escaping) reasons.push("trailing escape");
  push();
  return { tokens, reasons };
}

function splitSegments(tokens: string[]): string[][] {
  const segments: string[][] = [[]];
  for (const token of tokens) {
    if (OPERATORS.has(token)) segments.push([]);
    else segments.at(-1)!.push(token);
  }
  return segments.filter((segment) => segment.length > 0);
}

function normalizeArgv(input: string[]): string[] {
  const argv = [...input];
  while (argv.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0]!)) argv.shift();
  if (argv[0] === "env") {
    const envArgv = argv.slice(1);
    while (envArgv.length > 0) {
      const candidate: string = envArgv[0]!;
      if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(candidate) && candidate !== "-i") break;
      envArgv.shift();
    }
    argv.splice(0, argv.length, ...envArgv);
  }
  if (argv[0]) argv[0] = basename(argv[0]);
  return argv;
}

function displayToken(value: string): string { return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : JSON.stringify(value); }
function startsWith(value: string[], prefix: string[]): boolean { return prefix.length <= value.length && prefix.every((item, index) => value[index] === item); }
function arraysEqual(left: string[], right: string[]): boolean { return left.length === right.length && startsWith(left, right); }
function rule(id: string, kind: ExecPolicyRuleKind, decision: ExecPolicyDecision, pattern: string[] | string): ExecPolicyRule { return { id, kind, decision, pattern, layer: "base" }; }
function asObject(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function stringField(value: Record<string, unknown>, key: string): string { if (typeof value[key] !== "string" || !value[key]) throw new Error(`${key} must be a non-empty string`); return value[key]; }
function enumField<const T extends readonly string[]>(value: Record<string, unknown>, key: string, values: T): T[number] { if (typeof value[key] !== "string" || !values.includes(value[key] as T[number])) throw new Error(`${key} must be one of ${values.join(", ")}`); return value[key] as T[number]; }
