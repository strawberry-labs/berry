import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CommandWrapper, LocalProcessExecutor } from "@berry/harness/node";
import { CommandHookSchema, type CommandHook, type HookLifecycle, type JsonValue } from "@berry/shared";

const MAX_OUTPUT_BYTES = 1024 * 1024;

export interface HookPayload {
  sessionId: string;
  turnId: string;
  workspacePath: string;
  toolCallId?: string;
  toolName?: string;
  input?: Record<string, unknown>;
  output?: JsonValue;
  status?: string;
}

export interface PreToolHookResult {
  block?: boolean;
  reason?: string;
  input: Record<string, unknown>;
}

export interface PostToolHookResult {
  output: JsonValue;
  isError?: boolean;
}

export interface LoadedHooks {
  hooks: CommandHook[];
  fingerprint: string;
  diagnostics: string[];
}

export function loadHookConfiguration(workspacePath: string, pluginHooks: JsonValue[] = []): LoadedHooks {
  const diagnostics: string[] = [];
  const hooks: CommandHook[] = [];
  const files = [
    { path: join(homedir(), ".berry", "hooks.json"), source: "user" as const },
    { path: join(workspacePath, ".berry", "hooks.json"), source: "workspace" as const },
  ];
  for (const file of files) {
    if (!existsSync(file.path)) continue;
    try {
      hooks.push(...parseHookConfig(JSON.parse(readFileSync(file.path, "utf8")) as unknown, file.source));
    } catch (error) {
      diagnostics.push(`${file.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const [index, value] of pluginHooks.entries()) {
    try {
      hooks.push(CommandHookSchema.parse({ ...asObject(value), source: "plugin", id: asObject(value).id ?? `plugin-hook-${index + 1}` }));
    } catch (error) {
      diagnostics.push(`plugin hook ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    hooks,
    fingerprint: createHash("sha256").update(JSON.stringify(hooks)).digest("hex"),
    diagnostics,
  };
}

export function parseHookConfig(value: unknown, source: "user" | "workspace" | "plugin" = "user"): CommandHook[] {
  const root = asObject(value);
  if (Array.isArray(root.hooks)) return root.hooks.map((hook, index) => CommandHookSchema.parse({ ...asObject(hook), source, id: asObject(hook).id ?? `${source}-${index + 1}` }));
  const grouped = asObject(root.hooks);
  const result: CommandHook[] = [];
  for (const event of ["PreToolUse", "PostToolUse", "TurnStart", "TurnEnd"] as const) {
    const groups = grouped[event];
    if (!Array.isArray(groups)) continue;
    for (const [groupIndex, rawGroup] of groups.entries()) {
      const group = asObject(rawGroup);
      const commands = Array.isArray(group.hooks) ? group.hooks : [group];
      for (const [hookIndex, rawHook] of commands.entries()) {
        const hook = asObject(rawHook);
        if (hook.type !== undefined && hook.type !== "command") continue;
        result.push(CommandHookSchema.parse({
          id: `${source}-${event}-${groupIndex + 1}-${hookIndex + 1}`,
          event,
          matcher: typeof group.matcher === "string" ? group.matcher : ".*",
          command: hook.command,
          timeoutMs: typeof hook.timeout === "number" ? hook.timeout * 1000 : hook.timeoutMs,
          failurePolicy: hook.failurePolicy ?? group.failurePolicy ?? "block",
          source,
        }));
      }
    }
  }
  return result;
}

export class HookRunner {
  readonly #hooks: CommandHook[];
  readonly #executor: LocalProcessExecutor;
  readonly #log: (level: "info" | "warn" | "error", message: string) => void;
  readonly #commandWrapper: CommandWrapper | undefined;

  constructor(hooks: CommandHook[], executor: LocalProcessExecutor, log: (level: "info" | "warn" | "error", message: string) => void = () => {}, commandWrapper?: CommandWrapper) {
    this.#hooks = hooks;
    this.#executor = executor;
    this.#log = log;
    this.#commandWrapper = commandWrapper;
  }

  async preTool(payload: HookPayload, signal?: AbortSignal): Promise<PreToolHookResult> {
    let input = payload.input ?? {};
    for (const hook of this.#matching("PreToolUse", payload.toolName)) {
      const result = await this.#invoke(hook, { ...payload, input }, signal);
      if (!result.ok) {
        if (hook.failurePolicy === "block") return { block: true, reason: result.reason, input };
        this.#log("warn", result.reason);
        continue;
      }
      const normalized = normalizeHookOutput(result.value);
      if (normalized.block) return { block: true, reason: normalized.reason || `Blocked by hook ${hook.id}`, input };
      if (normalized.input) input = normalized.input;
    }
    return { input };
  }

  async postTool(payload: HookPayload, signal?: AbortSignal): Promise<PostToolHookResult> {
    let output = payload.output ?? null;
    let isError: boolean | undefined;
    for (const hook of this.#matching("PostToolUse", payload.toolName)) {
      const result = await this.#invoke(hook, { ...payload, output }, signal);
      if (!result.ok) {
        if (hook.failurePolicy === "block") return { output: { error: result.reason }, isError: true };
        this.#log("warn", result.reason);
        continue;
      }
      const normalized = normalizeHookOutput(result.value);
      if (normalized.output !== undefined) output = normalized.output;
      if (normalized.redact.length > 0) output = redactJson(output, normalized.redact);
      if (normalized.isError !== undefined) isError = normalized.isError;
    }
    return { output, ...(isError !== undefined ? { isError } : {}) };
  }

  async lifecycle(event: "TurnStart" | "TurnEnd", payload: HookPayload, signal?: AbortSignal): Promise<void> {
    for (const hook of this.#matching(event)) {
      const result = await this.#invoke(hook, payload, signal);
      if (!result.ok && hook.failurePolicy === "block") throw new Error(result.reason);
      if (!result.ok) this.#log("warn", result.reason);
    }
  }

  #matching(event: HookLifecycle, toolName = ""): CommandHook[] {
    return this.#hooks.filter((hook) => hook.event === event && matches(hook.matcher, toolName));
  }

  async #invoke(hook: CommandHook, payload: HookPayload, signal?: AbortSignal): Promise<{ ok: true; value: unknown } | { ok: false; reason: string }> {
    let child: ChildProcess;
    try {
      const invocation = this.#commandWrapper?.({ command: hook.command, args: [], options: { cwd: payload.workspacePath, shell: true, stdio: ["pipe", "pipe", "pipe"] } })
        ?? { command: hook.command, args: [], options: { cwd: payload.workspacePath, shell: true, stdio: ["pipe", "pipe", "pipe"] } };
      child = this.#executor.spawn(invocation.command, invocation.args, invocation.options);
    } catch (error) {
      return { ok: false, reason: `Hook ${hook.id} failed to start: ${error instanceof Error ? error.message : String(error)}` };
    }
    let stdout = "";
    let stderr = "";
    let exceeded = false;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk; else exceeded = true; });
    child.stderr?.on("data", (chunk: string) => { if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk; });
    child.stdin?.end(JSON.stringify({ hookEventName: hook.event, ...payload }));
    const aborted = () => void this.#executor.terminate(child, 100);
    signal?.addEventListener("abort", aborted, { once: true });
    const timedOut = await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (timeout: boolean) => { if (!settled) { settled = true; clearTimeout(timer); resolve(timeout); } };
      const timer = setTimeout(() => { void this.#executor.terminate(child, 100); finish(true); }, hook.timeoutMs);
      timer.unref?.();
      child.once("close", () => finish(false));
      child.once("error", () => finish(false));
    });
    signal?.removeEventListener("abort", aborted);
    if (timedOut) return { ok: false, reason: `Hook ${hook.id} timed out after ${hook.timeoutMs}ms` };
    if (signal?.aborted) return { ok: false, reason: `Hook ${hook.id} was aborted` };
    if (exceeded) return { ok: false, reason: `Hook ${hook.id} exceeded the 1 MiB output limit` };
    if (child.exitCode !== 0) return { ok: false, reason: `Hook ${hook.id} exited ${child.exitCode}: ${stderr.trim().slice(0, 500)}` };
    if (!stdout.trim()) return { ok: true, value: {} };
    try {
      return { ok: true, value: JSON.parse(stdout) as unknown };
    } catch {
      return { ok: false, reason: `Hook ${hook.id} returned invalid JSON` };
    }
  }
}

function normalizeHookOutput(value: unknown): { block: boolean; reason?: string; input?: Record<string, unknown>; output?: JsonValue; redact: string[]; isError?: boolean } {
  const root = asObject(value);
  const specific = asObject(root.hookSpecificOutput);
  const decision = root.decision ?? specific.permissionDecision;
  const input = root.input ?? root.updatedInput ?? specific.updatedInput;
  return {
    block: root.block === true || decision === "block" || decision === "deny",
    ...(typeof root.reason === "string" ? { reason: root.reason } : typeof specific.permissionDecisionReason === "string" ? { reason: specific.permissionDecisionReason } : {}),
    ...(isObject(input) ? { input } : {}),
    ...(isJson(root.output) ? { output: root.output } : {}),
    redact: Array.isArray(root.redact) ? root.redact.filter((item): item is string => typeof item === "string" && item.length > 0) : [],
    ...(typeof root.isError === "boolean" ? { isError: root.isError } : {}),
  };
}

function matches(pattern: string, value: string): boolean {
  if (!pattern || pattern === ".*" || pattern === "*") return true;
  try { return new RegExp(pattern).test(value); } catch { return pattern === value; }
}

function redactJson(value: JsonValue, secrets: string[]): JsonValue {
  if (typeof value === "string") return secrets.reduce((text, secret) => text.split(secret).join("[REDACTED]"), value);
  if (Array.isArray(value)) return value.map((item) => redactJson(item, secrets));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactJson(item, secrets)]));
  return value;
}

function asObject(value: unknown): Record<string, unknown> { return isObject(value) ? value : {}; }
function isObject(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function isJson(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.every(isJson);
  return isObject(value) && Object.values(value).every(isJson);
}
