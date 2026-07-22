import { posix } from "node:path";
import type { BerryDatabase } from "@berry/desktop-db";
import { canonicalizeCommand, ExecPolicyEngine, loadExecPolicy, type ExecPolicyRule, type ExecPolicyTraceStep } from "@berry/execpolicy";
import type { ApprovalKind, CommandManifest, JsonValue, NetworkPolicy, PermissionMode, SandboxPolicy } from "@berry/shared";
import { builtInCommandManifests, createId, networkDomainAllowed, nowIso } from "@berry/shared";

export type ToolRisk = "read" | "file-edit" | "shell" | "terminal" | "mcp" | "browser" | "credential" | "workspace-trust";

export interface ToolGuardRequest {
  workspaceId?: string;
  permissionMode: PermissionMode;
  risk: ToolRisk;
  toolName: string;
  summary: string;
  payload?: JsonValue;
  sandboxPolicy?: SandboxPolicy;
  workspacePath?: string;
  execPolicyRules?: ExecPolicyRule[];
  networkPolicy?: NetworkPolicy;
}

export type ToolGuardDecision =
  | { type: "allow"; reason: string; subject?: string; trace: ToolDecisionTraceStep[] }
  | { type: "block"; reason: string; trace: ToolDecisionTraceStep[] }
  | { type: "approval-required"; approvalKind: ApprovalKind; reason: string; subject: string; trace: ToolDecisionTraceStep[] };

export interface ToolDecisionTraceStep {
  stage: "execpolicy" | "sandbox" | "permission-mode" | "grant";
  decision: "allow" | "prompt" | "forbid";
  detail: string;
  ruleId?: string;
  layer?: string;
}

export type ApprovalDecisionKind = "approved_once" | "approved_for_session" | "approved_rule" | "denied" | "abort";

export class GrantStore {
  readonly #db: BerryDatabase | undefined;
  readonly #sessionGrants = new Map<string, ToolGuardRequest>();

  constructor(db?: BerryDatabase) {
    this.#db = db;
  }

  allowForSession(request: ToolGuardRequest): void {
    this.#sessionGrants.set(grantKey(request), request);
  }

  allowRule(request: ToolGuardRequest): void {
    this.allowForSession(request);
    const db = this.#db;
    if (!db) return;
    const now = nowIso();
    const command = shellCommand(request);
    if (command) {
      const canonical = canonicalizeCommand(command);
      db.db.prepare(
        `INSERT INTO execpolicy_rules (id, workspace_id, layer, kind, decision, pattern_json, description, created_at, updated_at)
         VALUES (?, NULL, 'user', 'exact', 'allow', ?, ?, ?, ?)`,
      ).run(createId("policy"), JSON.stringify(canonical.argv), `Always allow ${canonical.display}`, now, now);
      return;
    }
    db.db
      .prepare(
        `INSERT INTO permission_grants (id, workspace_id, mode, subject, decision, expires_at, created_at)
         VALUES (?, ?, ?, ?, 'allow', NULL, ?)`,
      )
      .run(createId("grant"), request.workspaceId ?? null, request.permissionMode, canonicalGrantSubject(request), now);
  }

  match(request: ToolGuardRequest): { subject: string; scope: "session" | "rule" } | undefined {
    const subject = canonicalGrantSubject(request);
    if (this.#sessionGrants.has(grantKey(request))) return { subject, scope: "session" };
    const db = this.#db;
    if (!db) return undefined;
    const row = db.db
      .prepare(
        `SELECT id FROM permission_grants
         WHERE decision = 'allow'
           AND mode = ?
           AND subject = ?
           AND (workspace_id IS NULL OR workspace_id = ?)
           AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(request.permissionMode, subject, request.workspaceId ?? null, nowIso());
    return row ? { subject, scope: "rule" } : undefined;
  }

  policyRules(request: ToolGuardRequest): ExecPolicyRule[] {
    const command = shellCommand(request);
    if (!command) return [];
    const rules: ExecPolicyRule[] = [];
    const session = this.#sessionGrants.get(grantKey(request));
    if (session) rules.push(shellGrantRule(`session-${grantKey(request)}`, session, "session"));
    const db = this.#db;
    if (!db) return rules;
    const rows = db.db.prepare(
      `SELECT id, layer, kind, decision, pattern_json, description FROM execpolicy_rules
       WHERE workspace_id IS NULL OR workspace_id = ? ORDER BY created_at`,
    ).all(request.workspaceId ?? null) as Array<{ id: string; layer: ExecPolicyRule["layer"]; kind: ExecPolicyRule["kind"]; decision: ExecPolicyRule["decision"]; pattern_json: string; description: string | null }>;
    for (const row of rows) {
      try {
        rules.push({ id: row.id, layer: row.layer, kind: row.kind, decision: row.decision, pattern: JSON.parse(row.pattern_json) as string[] | string, ...(row.description ? { description: row.description } : {}) });
      } catch { /* Invalid database rows are ignored and remain inspectable. */ }
    }
    const legacy = db.db.prepare(
      `SELECT id, subject FROM permission_grants WHERE decision = 'allow' AND mode = ?
       AND subject LIKE 'bash:%' AND (workspace_id IS NULL OR workspace_id = ?)
       AND (expires_at IS NULL OR expires_at > ?)`,
    ).all(request.permissionMode, request.workspaceId ?? null, nowIso()) as Array<{ id: string; subject: string }>;
    for (const row of legacy) {
      rules.push({ id: `legacy-${row.id}`, layer: "user", kind: "exact", decision: "allow", pattern: canonicalizeCommand(row.subject.slice(5)).argv, description: "Migrated permission grant" });
    }
    return rules;
  }
}

export class ToolGuard {
  readonly #grants: GrantStore | undefined;

  constructor(grants?: GrantStore) {
    this.#grants = grants;
  }

  decide(request: ToolGuardRequest): ToolGuardDecision {
    const trace: ToolDecisionTraceStep[] = [];
    const networkUrl = networkTarget(request);
    if (networkUrl) {
      let target: URL;
      try { target = new URL(networkUrl); }
      catch { return { type: "block", reason: `invalid network target: ${networkUrl}`, trace: [step("execpolicy", "forbid", "Network target is not a valid URL")] }; }
      if (target.protocol === "http:" || target.protocol === "https:") {
        const fileRules = request.execPolicyRules ?? (request.workspacePath ? loadExecPolicy(request.workspacePath).rules : []);
        const result = new ExecPolicyEngine(fileRules).evaluateNetwork(target.toString());
        trace.push(...policyTrace(result.trace));
        if (result.decision === "forbid") return { type: "block", reason: `execpolicy forbids network access to ${result.hostname}`, trace };
        if (request.networkPolicy?.egress === "off") return { type: "block", reason: `network egress is off for ${request.permissionMode} mode`, trace: [...trace, step("sandbox", "forbid", "Sandbox tier disables network egress")] };
        if (request.networkPolicy && !networkDomainAllowed(result.hostname, request.networkPolicy.allowedDomains)) {
          return { type: "block", reason: `${result.hostname} is not in the network domain allowlist`, trace: [...trace, step("sandbox", "forbid", `Domain allowlist does not include ${result.hostname}`)] };
        }
      }
    }
    const command = shellCommand(request);
    let policyDecision: "allow" | "prompt" | "forbid" | undefined;
    if (command) {
      const fileRules = request.execPolicyRules ?? (request.workspacePath ? loadExecPolicy(request.workspacePath).rules : []);
      const result = new ExecPolicyEngine([...fileRules, ...(this.#grants?.policyRules(request) ?? [])]).evaluate(command);
      policyDecision = result.decision;
      trace.push(...policyTrace(result.trace));
      if (result.decision === "forbid") return { type: "block", reason: `execpolicy forbids ${result.canonical.display}`, trace };
    }
    if (request.risk === "read") return { type: "allow", reason: "read-only workspace operation", trace: [...trace, step("permission-mode", "allow", "Read-only workspace operation")] };
    if (request.permissionMode === "plan") {
      return { type: "block", reason: "plan mode does not allow mutating tools or command execution", trace: [...trace, step("permission-mode", "forbid", "Plan mode blocks mutation and command execution")] };
    }
    const payload = request.payload && typeof request.payload === "object" && !Array.isArray(request.payload) ? request.payload : {};
    if (payload.sandbox_permissions === "require_escalated" && request.sandboxPolicy?.tier !== "danger-full-access") {
      return {
        type: "approval-required",
        approvalKind: approvalKindForRisk(request.risk),
        reason: `${request.toolName} requests danger-full-access for this tool call`,
        subject: `sandbox:danger-full-access:${request.toolName}`,
        trace: [...trace, step("sandbox", "prompt", "Explicit danger-full-access escalation requires approval")],
      };
    }
    trace.push(step("sandbox", "allow", "Sandbox policy permits the tool call"));
    if (request.permissionMode === "full-access") return { type: "allow", reason: "full-access mode", trace: [...trace, step("permission-mode", "allow", "Full-access mode allows non-forbidden commands")] };
    if (request.permissionMode === "auto-edit" && request.risk === "file-edit") {
      return { type: "allow", reason: "auto-edit mode allows workspace file edits", trace: [...trace, step("permission-mode", "allow", "Auto-edit mode allows workspace file edits")] };
    }
    if (policyDecision === "allow") return { type: "allow", reason: "execpolicy allow rule matched", subject: canonicalGrantSubject(request), trace };
    const grant = this.#grants?.match(request);
    if (grant) return { type: "allow", reason: `${grant.scope} grant matched ${grant.subject}`, subject: grant.subject, trace: [...trace, step("grant", "allow", `${grant.scope} grant matched ${grant.subject}`)] };
    return {
      type: "approval-required",
      approvalKind: approvalKindForRisk(request.risk),
      reason: `${request.toolName} requires approval in ${request.permissionMode} mode`,
      subject: canonicalGrantSubject(request),
      trace: [...trace, step("grant", "prompt", "No matching grant; approval required")],
    };
  }
}

export interface SlashCommandResult {
  command: CommandManifest;
  args: string[];
}

export class SlashCommandRegistry {
  readonly commands: CommandManifest[];

  constructor(now = nowIso()) {
    this.commands = builtInCommandManifests(now, "desktop");
  }

  parse(input: string): SlashCommandResult | undefined {
    const trimmed = input.trim();
    if (!trimmed.startsWith("/")) return undefined;
    const [nameWithSlash, ...args] = trimmed.split(/\s+/);
    const name = nameWithSlash?.slice(1);
    const found = this.commands.find((item) => item.name === name);
    return found ? { command: found, args } : undefined;
  }
}

export function approvalKindForRisk(risk: ToolRisk): ApprovalKind {
  if (risk === "file-edit") return "file-edit";
  if (risk === "shell") return "shell";
  if (risk === "terminal") return "terminal";
  if (risk === "mcp") return "mcp";
  if (risk === "browser") return "browser";
  if (risk === "credential") return "credential";
  return "workspace-trust";
}

export function canonicalGrantSubject(request: ToolGuardRequest): string {
  const payload = request.payload && typeof request.payload === "object" && !Array.isArray(request.payload) ? request.payload : {};
  if (payload.sandbox_permissions === "require_escalated") return `sandbox:danger-full-access:${request.toolName}`;
  if (request.toolName === "bash" && typeof payload.command === "string") {
    return `bash:${canonicalShellCommand(payload.command)}`;
  }
  if (request.risk === "file-edit") {
    const path = typeof payload.path === "string" ? canonicalWorkspacePath(payload.path) : stableJson(payload);
    return `file:${request.toolName}:${path}`;
  }
  if (request.risk === "browser") {
    const candidate = typeof payload.origin === "string" ? payload.origin : typeof payload.url === "string" ? payload.url : undefined;
    if (candidate) {
      try {
        const parsed = new URL(candidate);
        return `browser:${parsed.origin === "null" ? parsed.protocol : parsed.origin}`;
      } catch {
        return `browser:invalid-origin:${candidate.trim().toLowerCase()}`;
      }
    }
    return `browser:${request.toolName}:${stableJson(payload)}`;
  }
  if (request.risk === "terminal" || request.risk === "mcp" || request.risk === "credential") {
    return `${request.risk}:${request.toolName}:${stableJson(payload)}`;
  }
  return `${request.risk}:${request.toolName}`;
}

function grantKey(request: ToolGuardRequest): string {
  return [request.workspaceId ?? "*", request.permissionMode, canonicalGrantSubject(request)].join("\u0000");
}

function shellCommand(request: ToolGuardRequest): string | undefined {
  const payload = request.payload && typeof request.payload === "object" && !Array.isArray(request.payload) ? request.payload : {};
  return request.risk === "shell" && typeof payload.command === "string" ? payload.command : undefined;
}

function networkTarget(request: ToolGuardRequest): string | undefined {
  // Remote MCP server endpoints are validated when the trusted MCP client
  // connects. URLs in an MCP tool's arguments are data for that remote server,
  // not direct network destinations contacted by Berry's sandbox.
  if (request.risk !== "browser") return undefined;
  const payload = request.payload && typeof request.payload === "object" && !Array.isArray(request.payload) ? request.payload : {};
  return typeof payload.origin === "string" ? payload.origin : typeof payload.url === "string" ? payload.url : undefined;
}

function shellGrantRule(id: string, request: ToolGuardRequest, layer: "session" | "user"): ExecPolicyRule {
  return { id, layer, kind: "exact", decision: "allow", pattern: canonicalizeCommand(shellCommand(request) ?? "").argv, description: `${layer} approval rule` };
}

function policyTrace(trace: ExecPolicyTraceStep[]): ToolDecisionTraceStep[] {
  return trace.map((item) => ({ stage: "execpolicy", decision: item.decision ?? "prompt", detail: item.detail, ...(item.ruleId ? { ruleId: item.ruleId } : {}), ...(item.layer ? { layer: item.layer } : {}) }));
}

function step(stage: ToolDecisionTraceStep["stage"], decision: ToolDecisionTraceStep["decision"], detail: string): ToolDecisionTraceStep {
  return { stage, decision, detail };
}

function canonicalWorkspacePath(value: string): string {
  const normalized = posix.normalize(value.replace(/\\/g, "/"));
  return normalized === "." ? "." : normalized.replace(/^(\.\.\/)+/, "").replace(/^\.\//, "");
}

function canonicalShellCommand(command: string): string {
  const tokens = shellTokens(command.trim());
  while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]!)) tokens.shift();
  if (tokens[0] === "env") {
    tokens.shift();
    while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]!)) tokens.shift();
  }
  if (tokens.length === 0) return command.trim().replace(/\s+/g, " ");
  tokens[0] = tokens[0]!.split(/[\\/]/).filter(Boolean).at(-1) ?? tokens[0]!;
  return tokens.join(" ");
}

function shellTokens(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;
  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaping) current += "\\";
  if (current) tokens.push(current);
  return tokens;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}
