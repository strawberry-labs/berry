import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as nodeStdin, stdout as nodeStdout, stderr as nodeStderr } from "node:process";
import type { Readable, Writable } from "node:stream";
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { runBerryAcp } from "@berry/acp-adapter";
import { JsonlRpcPeer } from "@berry/local-agent-protocol";
import { BerryHostService, defaultHostSocketPath, HostSocketClient, hostSocketTokenPath, startHostSocketServer, type BerryHostOptions } from "@berry/host";
import { type AgentStreamEvent, type ConversationKind, type HostPushEvent, type JsonValue, type ManagedPolicyStatus, type ManagedPolicySyncResult, type Message, type ModelProvider, type PermissionMode, type PlatformLoginExchangeResult, type PlatformLoginStartResult, type PlatformOrgSession, type PlatformUsageFlushResult, type Task, type Workspace, type WorktreeOrphan } from "@berry/shared";
import { CLI_VERSION, isCliCommandName, renderCliHelp, type CommandName } from "./command-reference.ts";

export { CLI_VERSION };

export interface CliIo {
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  isTty: boolean;
}

export interface RunCliOptions {
  argv: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  io?: Partial<CliIo>;
  hostOptions?: BerryHostOptions;
  createHost?: (options: BerryHostOptions) => BerryHostService;
}

interface HostLike {
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
  handle(method: string, params: JsonValue | undefined): Promise<JsonValue | undefined>;
  setPublisher(publisher: (event: HostPushEvent) => void): void;
}

interface ParsedArgs {
  command: CommandName;
  positionals: string[];
  flags: Map<string, string | boolean | string[]>;
}

interface CliContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  io: CliIo;
  hostOptions: BerryHostOptions;
  createHost: (options: BerryHostOptions) => BerryHostService;
}

interface TurnTarget {
  taskId: string;
  sessionId: string;
}

const PERMISSION_MODES = new Set<PermissionMode>(["ask", "auto-edit", "plan", "full-access"]);
const CONVERSATION_KINDS = new Set<ConversationKind>(["chat", "code"]);
const TEXT_EXTENSIONS = new Set(["cjs", "css", "csv", "html", "ini", "js", "json", "jsx", "log", "md", "mjs", "py", "rs", "sh", "sql", "toml", "ts", "tsx", "txt", "xml", "yaml", "yml"]);

export async function runCli(options: RunCliOptions): Promise<number> {
  const io = resolveIo(options.io);
  const ctx: CliContext = {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    io,
    hostOptions: options.hostOptions ?? {},
    createHost: options.createHost ?? ((hostOptions) => new BerryHostService(hostOptions)),
  };
  const parsed = parseArgs(options.argv);
  try {
    if (parsed.command === "version" || parsed.flags.get("version") === true) return version(ctx);
    if (parsed.command === "help") return help(ctx);
    if (parsed.command === "update") return await cliUpdate(ctx, parsed);
    if (parsed.command === "login" || parsed.command === "logout") return await withHost(ctx, parsed, (host) => platformCommand(ctx, parsed, host));
    if (parsed.command === "tui") return comingSoon(ctx, "The interactive TUI is planned after v1; use `berry run`, `berry resume`, or the desktop app today.");
    if (parsed.command === "app-server") return await appServer(ctx, parsed);
    if (parsed.command === "acp") return await acpServer(ctx, parsed);
    if (parsed.command === "doctor") return await withHost(ctx, parsed, (host) => doctor(ctx, parsed, host));
    if (parsed.command === "ls") return await withHost(ctx, parsed, (host) => listTasks(ctx, parsed, host));
    if (parsed.command === "resume") return await withHost(ctx, parsed, (host) => resume(ctx, parsed, host));
    if (parsed.command === "run") return await withHost(ctx, parsed, (host) => runTurn(ctx, parsed, host));
    if (parsed.command === "policy") return await withHost(ctx, parsed, (host) => policyCommand(ctx, parsed, host));
    if (parsed.command === "skills" || parsed.command === "commands" || parsed.command === "plugins" || parsed.command === "mcp") {
      return await withHost(ctx, parsed, (host) => listCatalog(ctx, parsed, host));
    }
    return help(ctx);
  } catch (error) {
    writeLine(ctx.io.stderr, errorMessage(error));
    return 1;
  }
}

function resolveIo(io: Partial<CliIo> | undefined): CliIo {
  return {
    stdin: io?.stdin ?? nodeStdin,
    stdout: io?.stdout ?? nodeStdout,
    stderr: io?.stderr ?? nodeStderr,
    isTty: io?.isTty ?? Boolean(nodeStdin.isTTY && nodeStdout.isTTY),
  };
}

async function withHost(ctx: CliContext, parsed: ParsedArgs, fn: (host: HostLike) => Promise<number>): Promise<number> {
  const dbPath = stringFlag(parsed, "db") ?? ctx.env.BERRY_DESKTOP_DB;
  const host: HostLike =
    parsed.flags.get("attach-host") === true
      ? new HostSocketClient({ socketPath: socketPathFor(ctx, parsed), tokenPath: tokenPathFor(socketPathFor(ctx, parsed)) })
      : ctx.createHost({
          ...ctx.hostOptions,
          ...(dbPath ? { dbPath } : {}),
        });
  await host.initialize();
  try {
    return await fn(host);
  } finally {
    await host.shutdown();
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | boolean | string[]>();
  const positionals: string[] = [];
  let command: CommandName | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!command && !token.startsWith("-")) {
      command = normalizeCommand(token);
      continue;
    }
    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (token.startsWith("--")) {
      const [rawKey, inline] = token.slice(2).split("=", 2);
      const key = rawKey!;
      if (booleanFlag(key)) {
        flags.set(key, inline ?? true);
        continue;
      }
      const value = inline ?? argv[++index];
      if (value === undefined) throw new Error(`Missing value for --${key}`);
      appendFlag(flags, key, value);
      continue;
    }
    if (token.startsWith("-") && token.length > 1) {
      if (token === "-V") {
        flags.set("version", true);
        continue;
      }
      const key = shortFlag(token);
      if (!key) throw new Error(`Unknown flag ${token}`);
      const value = argv[++index];
      if (value === undefined) throw new Error(`Missing value for ${token}`);
      appendFlag(flags, key, value);
      continue;
    }
    positionals.push(token);
  }
  return { command: command ?? "help", positionals, flags };
}

function normalizeCommand(value: string): CommandName {
  if (isCliCommandName(value)) return value;
  throw new Error(`Unknown command: ${value}`);
}

function booleanFlag(key: string): boolean {
  return ["json", "continue", "stdio", "attach-host", "version", "skip-usage-flush", "apply", "check"].includes(key);
}

function shortFlag(token: string): string | null {
  if (token === "-p") return "prompt";
  return null;
}

function appendFlag(flags: Map<string, string | boolean | string[]>, key: string, value: string): void {
  if (key === "attach" || key === "public-key") {
    const current = flags.get(key);
    flags.set(key, Array.isArray(current) ? [...current, value] : [value]);
  } else {
    flags.set(key, value);
  }
}

async function runTurn(ctx: CliContext, parsed: ParsedArgs, host: HostLike): Promise<number> {
  const prompt = await promptInput(ctx, parsed);
  if (!prompt.trim()) throw new Error("A prompt is required. Use `berry run -p \"...\"` or pipe stdin.");
  const requestedKind = parseConversationKind(ctx, parsed);
  const workspace = await openWorkspace(ctx, parsed, host);
  const target = await resolveRunTarget(ctx, parsed, host, workspace, prompt, requestedKind);
  const provider = await selectedProvider(host, parsed);
  const selectedPermissionMode = parsePermissionMode(parsed);
  const selectedKind = await resolveTurnConversationKind(host, requestedKind, target);
  const attachments = attachmentFlags(parsed).map((path) => attachmentFromPath(ctx, path));
  if (!jsonMode(parsed)) {
    writeLine(ctx.io.stderr, `[run] task=${target.taskId} kind=${selectedKind} permission=${selectedPermissionMode}`);
  }
  const waiter = createTurnWaiter(ctx, parsed, host, target, selectedKind);
  await host.handle("agent.turn", {
    taskId: target.taskId,
    sessionId: target.sessionId,
    input: prompt,
    permissionMode: selectedPermissionMode,
    owner: cliOwner(),
    ...(provider ? { providerId: provider.id, model: modelFlag(parsed) ?? provider.defaultModel } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
  });
  const status = await waiter;
  if (!jsonMode(parsed)) writeLine(ctx.io.stdout, "");
  return status === "completed" ? 0 : status === "cancelled" ? 130 : 1;
}

async function resolveRunTarget(ctx: CliContext, parsed: ParsedArgs, host: HostLike, workspace: Workspace, prompt: string, conversationKind: ConversationKind | undefined): Promise<TurnTarget> {
  const resumeId = stringFlag(parsed, "resume") ?? parsed.positionals[0];
  if (resumeId) return findTaskOrSession(host, resumeId);
  if (parsed.flags.get("continue") === true) {
    const tasks = await host.handle("task.list", { workspaceId: workspace.id, includeArchived: false, includeDeleted: false }) as unknown as Task[];
    const task = tasks.find((item) => item.activeSessionId);
    if (!task?.activeSessionId) throw new Error("No task is available to continue in this workspace.");
    return { taskId: task.id, sessionId: task.activeSessionId };
  }
  const createParams: Record<string, JsonValue> = {
    workspaceId: workspace.id,
    conversationKind: conversationKind ?? "chat",
    title: titleFromPrompt(prompt),
    permissionMode: parsePermissionMode(parsed),
  };
  const modelProviderId = stringFlag(parsed, "provider");
  const model = modelFlag(parsed);
  if (modelProviderId) createParams.modelProviderId = modelProviderId;
  if (model) createParams.model = model;
  const created = await host.handle("task.create", createParams) as unknown as { task: Task; session: { id: string } };
  return { taskId: created.task.id, sessionId: created.session.id };
}

async function resume(ctx: CliContext, parsed: ParsedArgs, host: HostLike): Promise<number> {
  const id = parsed.positionals[0];
  if (!id) throw new Error("Usage: berry resume <task-or-session-id> [-p prompt]");
  const requestedKind = parseConversationKind(ctx, parsed);
  const target = await findTaskOrSession(host, id);
  const selectedKind = await resolveTurnConversationKind(host, requestedKind, target);
  const prompt = await promptInput(ctx, parsed, false);
  if (prompt.trim()) {
    const waiter = createTurnWaiter(ctx, parsed, host, target, selectedKind);
    await host.handle("agent.turn", { taskId: target.taskId, sessionId: target.sessionId, input: prompt, permissionMode: parsePermissionMode(parsed), owner: cliOwner() });
    const status = await waiter;
    if (!jsonMode(parsed)) writeLine(ctx.io.stdout, "");
    return status === "completed" ? 0 : 1;
  }
  const messages = await host.handle("session.messages", { sessionId: target.sessionId }) as unknown as Message[];
  if (jsonMode(parsed)) writeJson(ctx.io.stdout, { taskId: target.taskId, sessionId: target.sessionId, messages });
  else renderMessages(ctx, messages);
  return 0;
}

async function listTasks(ctx: CliContext, parsed: ParsedArgs, host: HostLike): Promise<number> {
  const cwd = stringFlag(parsed, "cwd");
  const workspaces = cwd
    ? [await host.handle("workspace.open", { path: resolve(ctx.cwd, cwd), trusted: true }) as unknown as Workspace]
    : await host.handle("workspace.list", {}) as unknown as Workspace[];
  const rows: Array<{ workspace: Workspace; task: Task }> = [];
  for (const workspace of workspaces) {
    const tasks = await host.handle("task.list", { workspaceId: workspace.id, includeArchived: parsed.flags.get("archived") === true }) as unknown as Task[];
    rows.push(...tasks.map((task) => ({ workspace, task })));
  }
  if (jsonMode(parsed)) writeJson(ctx.io.stdout, rows.map(({ workspace, task }) => ({ workspace, task })));
  else if (rows.length === 0) writeLine(ctx.io.stdout, "No tasks.");
  else for (const { workspace, task } of rows) writeLine(ctx.io.stdout, `${task.id}\t${task.activeSessionId ?? "-"}\t${workspace.name}\t${task.status}\t${task.title}`);
  return 0;
}

async function doctor(ctx: CliContext, parsed: ParsedArgs, host: HostLike): Promise<number> {
  const workspaces = await host.handle("workspace.list", {}) as unknown as Workspace[];
  const providers = await host.handle("model.provider.list", {}) as unknown as ModelProvider[];
  const worktreeOrphans = await host.handle("worktree.orphans", {}) as unknown as WorktreeOrphan[];
  const report = {
    ok: true,
    db: { ok: true, workspaces: workspaces.length },
    providers: {
      ok: providers.some((provider) => provider.enabled),
      enabled: providers.filter((provider) => provider.enabled).length,
      total: providers.length,
      action: providers.some((provider) => provider.enabled) ? null : "Configure a provider in Desktop settings or set FIREWORKS_API_KEY for the Berry Router preset.",
    },
    worktrees: {
      ok: worktreeOrphans.length === 0,
      orphaned: worktreeOrphans.length,
      orphans: worktreeOrphans,
      action: worktreeOrphans.length === 0 ? null : "Inspect each reported path. Berry doctor never removes worktrees automatically.",
    },
    sidecars: {
      berryHost: "managed by desktop build",
      berryPty: "managed by desktop build",
    },
  };
  report.ok = report.db.ok && report.providers.ok && report.worktrees.ok;
  if (jsonMode(parsed)) writeJson(ctx.io.stdout, report);
  else {
    writeLine(ctx.io.stdout, `Database: ${report.db.ok ? "ok" : "failed"} (${report.db.workspaces} workspaces)`);
    writeLine(ctx.io.stdout, `Providers: ${report.providers.enabled}/${report.providers.total} enabled`);
    if (report.providers.action) writeLine(ctx.io.stdout, `Action: ${report.providers.action}`);
    writeLine(ctx.io.stdout, `Worktrees: ${report.worktrees.ok ? "ok" : `${report.worktrees.orphaned} orphaned`}`);
    for (const orphan of report.worktrees.orphans) writeLine(ctx.io.stdout, `  ${orphan.reason}: ${orphan.path}\n  Action: ${orphan.action}`);
    if (report.worktrees.action) writeLine(ctx.io.stdout, `Action: ${report.worktrees.action}`);
  }
  return report.ok ? 0 : 2;
}

interface CliUpdateManifest {
  version: string;
  keyId: string;
  signature: string;
  notes?: string;
  pubDate?: string;
  rollout?: { percentage?: number; salt?: string };
  artifacts: Record<string, { url: string; sha256: string; size?: number }>;
}

async function cliUpdate(ctx: CliContext, parsed: ParsedArgs): Promise<number> {
  const manifestUrl = stringFlag(parsed, "manifest") ?? ctx.env.BERRY_CLI_UPDATE_MANIFEST_URL ?? "https://github.com/berry-chat/berry-chat/releases/latest/download/berry-cli-update.json";
  const publicKeys = { ...envPublicKeys(ctx.env.BERRY_CLI_UPDATE_PUBLIC_KEYS), ...publicKeyFlags(parsed) };
  if (Object.keys(publicKeys).length === 0) throw new Error("No CLI update public key configured. Use --public-key keyId=base64 or BERRY_CLI_UPDATE_PUBLIC_KEYS.");
  const manifest = parseCliUpdateManifest(await readTextUri(manifestUrl));
  verifyCliUpdateManifest(manifest, publicKeys);
  const platform = cliUpdatePlatformKey();
  const artifact = manifest.artifacts[platform];
  const currentVersion = CLI_VERSION;
  const eligible = rolloutEligible(manifest, ctx);
  const newer = compareSemver(manifest.version, currentVersion) > 0;
  if (!newer || !eligible || parsed.flags.get("check") === true) {
    const result = {
      status: !newer ? "current" : eligible ? "available" : "held-by-rollout",
      currentVersion,
      version: manifest.version,
      platform,
      rolloutEligible: eligible,
      notes: manifest.notes ?? null,
    };
    if (jsonMode(parsed)) writeJson(ctx.io.stdout, result);
    else writeLine(ctx.io.stdout, result.status === "available" ? `Berry ${manifest.version} is available.` : result.status === "current" ? `Berry ${currentVersion} is up to date.` : "No update for this staged rollout cohort.");
    return 0;
  }
  if (!artifact) throw new Error(`No CLI update artifact for ${platform}`);
  const bytes = await readBinaryUri(artifact.url);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== artifact.sha256) throw new Error(`CLI update artifact hash mismatch for ${platform}`);
  const stageDir = stringFlag(parsed, "stage-dir") ?? ctx.env.BERRY_CLI_UPDATE_STAGE_DIR ?? join(ctx.cwd, ".berry", "updates");
  mkdirSync(stageDir, { recursive: true });
  const stagedPath = join(stageDir, process.platform === "win32" ? "berry.exe" : "berry");
  writeFileSync(stagedPath, bytes, { mode: 0o755 });
  if (process.platform !== "win32") chmodSync(stagedPath, 0o755);
  let applied = false;
  const installPath = stringFlag(parsed, "install-path") ?? ctx.env.BERRY_CLI_INSTALL_PATH ?? process.execPath;
  if (parsed.flags.get("apply") === true) {
    mkdirSync(dirname(installPath), { recursive: true });
    copyFileSync(stagedPath, installPath);
    if (process.platform !== "win32") chmodSync(installPath, 0o755);
    applied = true;
  }
  const result = { status: applied ? "installed" : "staged", currentVersion, version: manifest.version, platform, stagedPath, installPath: applied ? installPath : null, sha256 };
  if (jsonMode(parsed)) writeJson(ctx.io.stdout, result);
  else writeLine(ctx.io.stdout, applied ? `Installed Berry ${manifest.version}.` : `Staged Berry ${manifest.version} at ${stagedPath}. Re-run with --apply to replace ${installPath}.`);
  return 0;
}

function cliUpdatePlatformKey(): string {
  return `${process.platform}-${process.arch}`;
}

function parseCliUpdateManifest(text: string): CliUpdateManifest {
  const value = JSON.parse(text) as Partial<CliUpdateManifest>;
  if (!value || typeof value !== "object") throw new Error("CLI update manifest must be an object");
  if (typeof value.version !== "string" || !value.version.trim()) throw new Error("CLI update manifest missing version");
  if (typeof value.keyId !== "string" || !value.keyId.trim()) throw new Error("CLI update manifest missing keyId");
  if (typeof value.signature !== "string" || !value.signature.trim()) throw new Error("CLI update manifest missing signature");
  if (!value.artifacts || typeof value.artifacts !== "object") throw new Error("CLI update manifest missing artifacts");
  return value as CliUpdateManifest;
}

function envPublicKeys(value: string | undefined): Record<string, string> {
  if (!value) return {};
  return Object.fromEntries(value.split(",").filter(Boolean).map((item) => {
    const index = item.indexOf("=");
    if (index <= 0) throw new Error("BERRY_CLI_UPDATE_PUBLIC_KEYS must use keyId=base64 pairs");
    return [item.slice(0, index), item.slice(index + 1)];
  }));
}

function verifyCliUpdateManifest(manifest: CliUpdateManifest, keys: Record<string, string>): void {
  const rawPublicKey = keys[manifest.keyId];
  if (!rawPublicKey) throw new Error(`No public key configured for update key ${manifest.keyId}`);
  const unsigned = { ...manifest, signature: undefined } as Record<string, unknown>;
  delete unsigned.signature;
  const publicKey = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(rawPublicKey, "base64")]),
    format: "der",
    type: "spki",
  });
  const ok = verifySignature(null, Buffer.from(canonicalJson(unsigned)), publicKey, Buffer.from(manifest.signature, "base64"));
  if (!ok) throw new Error("CLI update manifest signature verification failed");
}

function rolloutEligible(manifest: CliUpdateManifest, ctx: CliContext): boolean {
  const percentage = manifest.rollout?.percentage ?? 100;
  if (percentage >= 100) return true;
  if (percentage <= 0) return false;
  const machine = ctx.env.BERRY_UPDATE_MACHINE_ID ?? ctx.env.HOSTNAME ?? ctx.cwd;
  const digest = createHash("sha256").update(`${manifest.rollout?.salt ?? "berry"}:${manifest.version}:${machine}`).digest();
  return digest.readUInt32BE(0) % 100 < percentage;
}

function compareSemver(left: string, right: string): number {
  const a = left.replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const b = right.replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

async function readTextUri(uri: string): Promise<string> {
  const bytes = await readBinaryUri(uri);
  return Buffer.from(bytes).toString("utf8");
}

async function readBinaryUri(uri: string): Promise<Buffer> {
  if (uri.startsWith("file://")) return readFileSync(new URL(uri));
  if (!/^https?:\/\//i.test(uri)) return readFileSync(resolve(uri));
  const response = await fetch(uri);
  if (!response.ok) throw new Error(`Failed to fetch ${uri}: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function listCatalog(ctx: CliContext, parsed: ParsedArgs, host: HostLike): Promise<number> {
  if (parsed.positionals[0] && parsed.positionals[0] !== "list") throw new Error(`Usage: berry ${parsed.command} list`);
  const method = parsed.command === "mcp" ? "mcp.server.list" : parsed.command === "skills" ? "skill.list" : parsed.command === "commands" ? "command.list" : "plugin.list";
  const workspaceId = stringFlag(parsed, "workspace-id");
  const rows = await host.handle(method, workspaceId ? { workspaceId } : {}) as unknown as Array<Record<string, unknown>>;
  if (jsonMode(parsed)) writeJson(ctx.io.stdout, rows);
  else for (const row of rows) writeLine(ctx.io.stdout, `${String(row.name ?? row.id ?? "item")}\t${String(row.enabled ?? row.trusted ?? "")}`);
  return 0;
}

async function appServer(ctx: CliContext, parsed: ParsedArgs): Promise<number> {
  const socketPath = stringFlag(parsed, "socket");
  const dbPath = stringFlag(parsed, "db") ?? ctx.env.BERRY_DESKTOP_DB;
  const host = ctx.createHost({ ...ctx.hostOptions, ...(dbPath ? { dbPath } : {}) });
  await host.initialize();
  try {
    if (socketPath) {
      const socketServer = await startHostSocketServer({
        host,
        socketPath,
        log: (message) => writeLine(ctx.io.stderr, message),
      });
      host.setPublisher((event) => socketServer.publish(event));
      writeLine(ctx.io.stderr, `Berry app-server listening on ${socketServer.socketPath}`);
      writeLine(ctx.io.stderr, `Token: ${socketServer.tokenPath}`);
      await new Promise<void>((resolve) => {
        ctx.io.stdin.once("end", resolve);
        ctx.io.stdin.resume();
      });
      const hostShutdown = host.shutdown();
      await socketServer.close();
      await hostShutdown;
      return 0;
    }
    const peer = new JsonlRpcPeer(ctx.io.stdin, ctx.io.stdout, async (method, params) => host.handle(method, params), {
      onError(error) {
        writeLine(ctx.io.stderr, error.message);
      },
    });
    host.setPublisher((event) => peer.notify("host.event", event as unknown as JsonValue));
    peer.start();
    await new Promise<void>((resolve) => ctx.io.stdin.once("end", resolve));
    return 0;
  } finally {
    await host.shutdown();
  }
}

async function acpServer(ctx: CliContext, parsed: ParsedArgs): Promise<number> {
  const socketPath = socketPathFor(ctx, parsed);
  if (parsed.positionals[0] === "doctor") {
    if (existsSync(socketPath) && existsSync(ctx.env.BERRY_HOST_TOKEN ?? tokenPathFor(socketPath))) parsed.flags.set("attach-host", true);
    return withHost(ctx, parsed, (host) => doctor(ctx, parsed, host));
  }
  if (parsed.positionals.length > 0) throw new Error("Usage: berry acp [doctor] [--socket <path>]");
  await runBerryAcp({
    socketPath,
    tokenPath: ctx.env.BERRY_HOST_TOKEN ?? tokenPathFor(socketPath),
    ...(ctx.env.BERRY_DESKTOP_DB ? { dbPath: ctx.env.BERRY_DESKTOP_DB } : {}),
    input: ctx.io.stdin,
    output: ctx.io.stdout,
  });
  return 0;
}

function createTurnWaiter(
  ctx: CliContext,
  parsed: ParsedArgs,
  host: HostLike,
  target: TurnTarget,
  conversationKind: ConversationKind,
): Promise<"completed" | "cancelled" | "failed"> {
  return new Promise((resolve) => {
    host.setPublisher((push) => {
      if (push.type === "approval.updated" || push.type === "question.updated") return;
      if (push.type === "task.updated" && push.task.id === target.taskId) return;
      if (push.type !== "agent.event" || push.sessionId !== target.sessionId) return;
      void handleAgentEvent(ctx, parsed, host, push, conversationKind, resolve);
    });
  });
}

async function handleAgentEvent(
  ctx: CliContext,
  parsed: ParsedArgs,
  host: HostLike,
  push: Extract<HostPushEvent, { type: "agent.event" }>,
  conversationKind: ConversationKind,
  resolve: (status: "completed" | "cancelled" | "failed") => void,
): Promise<void> {
  const event = push.event;
  if (jsonMode(parsed)) writeJson(ctx.io.stdout, { type: "agent.event", taskId: push.taskId, sessionId: push.sessionId, event });
  else renderAgentEvent(ctx, event, conversationKind);
  if (event.kind === "approval.request") await decideApproval(ctx, host, event);
  if (event.kind === "question.request") await answerQuestion(ctx, host, event);
  if (event.kind === "turn.end") resolve(event.status);
}

function renderAgentEvent(ctx: CliContext, event: AgentStreamEvent, conversationKind: ConversationKind): void {
  if (event.kind === "message.delta" && event.channel === "text") {
    ctx.io.stdout.write(event.delta);
  } else if (event.kind === "tool.start" && conversationKind === "code") {
    writeLine(ctx.io.stderr, `\n[tool] ${event.title ?? event.name}`);
  } else if (event.kind === "tool.end") {
    writeLine(ctx.io.stderr, `[tool:${event.status}] ${event.summary ?? event.toolCallId}`);
  } else if (event.kind === "approval.request") {
    writeLine(ctx.io.stderr, `\n[approval] ${event.title}${event.detail ? ` — ${event.detail}` : ""}`);
  } else if (event.kind === "question.request") {
    writeLine(ctx.io.stderr, `\n[question] ${event.question}`);
  } else if (event.kind === "error") {
    writeLine(ctx.io.stderr, `\n[error] ${event.message}`);
  }
}

async function decideApproval(ctx: CliContext, host: HostLike, event: Extract<AgentStreamEvent, { kind: "approval.request" }>): Promise<void> {
  if (!ctx.io.isTty) {
    writeLine(ctx.io.stderr, "[approval] denied because stdin/stdout is non-interactive");
    await host.handle("approval.decide", { id: event.approvalId, decision: "denied" });
    return;
  }
  const answer = await ask(ctx, "Approve? [o]nce, [s]ession, [r]ule, [d]eny, [a]bort: ");
  const decision = answer.toLowerCase().startsWith("s")
    ? "approved_for_session"
    : answer.toLowerCase().startsWith("r")
      ? "approved_rule"
      : answer.toLowerCase().startsWith("a")
        ? "abort"
        : answer.toLowerCase().startsWith("d")
          ? "denied"
          : "approved_once";
  await host.handle("approval.decide", { id: event.approvalId, decision });
}

async function answerQuestion(ctx: CliContext, host: HostLike, event: Extract<AgentStreamEvent, { kind: "question.request" }>): Promise<void> {
  if (!ctx.io.isTty) {
    await host.handle("question.answer", { id: event.questionId, answer: "", selectedOptions: [] });
    return;
  }
  event.options.forEach((option, index) => writeLine(ctx.io.stderr, `${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`));
  const answer = await ask(ctx, "Answer: ");
  const selected = Number(answer);
  const selectedOptions = Number.isInteger(selected) && event.options[selected - 1] ? [event.options[selected - 1]!.label] : [];
  await host.handle("question.answer", { id: event.questionId, answer, selectedOptions });
}

async function ask(ctx: CliContext, prompt: string): Promise<string> {
  const readline = createInterface({ input: ctx.io.stdin, output: ctx.io.stderr });
  try {
    return await readline.question(prompt);
  } finally {
    readline.close();
  }
}

async function openWorkspace(ctx: CliContext, parsed: ParsedArgs, host: HostLike): Promise<Workspace> {
  const cwd = resolve(ctx.cwd, stringFlag(parsed, "cwd") ?? ctx.cwd);
  return await host.handle("workspace.open", { path: cwd, trusted: true }) as unknown as Workspace;
}

async function findTaskOrSession(host: HostLike, id: string): Promise<TurnTarget> {
  try {
    const session = await host.handle("session.get", { sessionId: id }) as unknown as { id: string; taskId: string };
    return { taskId: session.taskId, sessionId: session.id };
  } catch {
    const workspaces = await host.handle("workspace.list", {}) as unknown as Workspace[];
    for (const workspace of workspaces) {
      const tasks = await host.handle("task.list", { workspaceId: workspace.id, includeArchived: true, includeDeleted: false }) as unknown as Task[];
      const task = tasks.find((candidate) => candidate.id === id);
      if (task?.activeSessionId) return { taskId: task.id, sessionId: task.activeSessionId };
    }
  }
  throw new Error(`No task or session found for ${id}`);
}

async function selectedProvider(host: HostLike, parsed: ParsedArgs): Promise<ModelProvider | null> {
  const providers = await host.handle("model.provider.list", {}) as unknown as ModelProvider[];
  const providerId = stringFlag(parsed, "provider");
  return providerId ? providers.find((provider) => provider.id === providerId || provider.name === providerId) ?? null : providers.find((provider) => provider.enabled) ?? null;
}

async function promptInput(ctx: CliContext, parsed: ParsedArgs, required = true): Promise<string> {
  const prompt = stringFlag(parsed, "prompt") ?? parsed.positionals.join(" ");
  if (prompt.trim()) return prompt;
  if (!ctx.io.isTty) return await readAll(ctx.io.stdin);
  if (required) return ask(ctx, "Prompt: ");
  return "";
}

function attachmentFromPath(ctx: CliContext, path: string): Record<string, JsonValue> {
  const absolute = resolve(ctx.cwd, path);
  if (!existsSync(absolute)) throw new Error(`Attachment not found: ${path}`);
  const mediaType = inferMediaType(absolute);
  const size = statSync(absolute).size;
  const base = {
    id: crypto.randomUUID(),
    name: basename(absolute),
    mediaType,
    size,
    localPath: absolute,
    sourceKind: "native-path",
  };
  if (mediaType.startsWith("image/")) return { ...base, dataUrl: `data:${mediaType};base64,${readFileSync(absolute).toString("base64")}` };
  if (isTextLike(absolute, mediaType)) return { ...base, textContent: readFileSync(absolute, "utf8").slice(0, 64 * 1024) };
  return base;
}

function inferMediaType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  if (ext === "json") return "application/json";
  if (ext === "md") return "text/markdown";
  if (TEXT_EXTENSIONS.has(ext)) return "text/plain";
  return "application/octet-stream";
}

function isTextLike(path: string, mediaType: string): boolean {
  return mediaType.startsWith("text/") || TEXT_EXTENSIONS.has(path.split(".").pop()?.toLowerCase() ?? "");
}

function parsePermissionMode(parsed: ParsedArgs): PermissionMode {
  const raw = stringFlag(parsed, "mode") ?? "ask";
  if (!PERMISSION_MODES.has(raw as PermissionMode)) throw new Error(`Invalid permission mode: ${raw}`);
  return raw as PermissionMode;
}

function parseConversationKind(ctx: CliContext, parsed: ParsedArgs): ConversationKind | undefined {
  const kind = stringFlag(parsed, "kind");
  const legacyMode = stringFlag(parsed, "ui-mode");
  if (kind !== undefined && legacyMode !== undefined) throw new Error("Use either --kind or deprecated --ui-mode, not both.");
  if (kind !== undefined) {
    if (!CONVERSATION_KINDS.has(kind as ConversationKind)) throw new Error(`Invalid conversation kind: ${kind}`);
    return kind as ConversationKind;
  }
  if (legacyMode === undefined) return undefined;
  if (legacyMode !== "chat" && legacyMode !== "code" && legacyMode !== "cowork") throw new Error(`Invalid legacy UI mode: ${legacyMode}`);
  writeLine(ctx.io.stderr, "[deprecated] --ui-mode is deprecated; use --kind chat|code. Co-work maps to Chat.");
  return legacyMode === "code" ? "code" : "chat";
}

async function resolveTurnConversationKind(host: HostLike, override: ConversationKind | undefined, target: TurnTarget): Promise<ConversationKind> {
  if (override) {
    const updated = await host.handle("task.setConversationKind", { id: target.taskId, conversationKind: override }) as unknown as Task;
    return updated.conversationKind;
  }
  const task = await findTask(host, target.taskId);
  return task?.conversationKind ?? "chat";
}

async function findTask(host: HostLike, taskId: string): Promise<Task | null> {
  const workspaces = await host.handle("workspace.list", {}) as unknown as Workspace[];
  for (const workspace of workspaces) {
    const tasks = await host.handle("task.list", { workspaceId: workspace.id, includeArchived: true, includeDeleted: false }) as unknown as Task[];
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (task) return task;
  }
  return null;
}

function renderMessages(ctx: CliContext, messages: Message[]): void {
  for (const message of messages) {
    const content = message.parts.map((part) => (typeof part.content === "string" ? part.content : JSON.stringify(part.content))).join("");
    writeLine(ctx.io.stdout, `${message.role}: ${content}`);
  }
}

async function policyCommand(ctx: CliContext, parsed: ParsedArgs, host: HostLike): Promise<number> {
  const action = parsed.positionals[0] ?? "status";
  if (action !== "status" && action !== "sync") throw new Error(`Unknown policy action: ${action}`);
  if (action === "sync") {
    const url = stringFlag(parsed, "url");
    if (!url) throw new Error("policy sync requires --url");
    const result = await host.handle("policy.sync", {
      url,
      ...(stringFlag(parsed, "tenant") ? { tenantId: stringFlag(parsed, "tenant") } : {}),
      ...(stringFlag(parsed, "token") ? { accessToken: stringFlag(parsed, "token") } : {}),
      publicKeys: publicKeyFlags(parsed),
    } as unknown as JsonValue) as unknown as ManagedPolicySyncResult;
    if (jsonMode(parsed)) writeLine(ctx.io.stdout, JSON.stringify(result, null, 2));
    else renderPolicySync(ctx, result);
    return result.status.state === "active" ? 0 : 2;
  }
  const status = await host.handle("policy.get", {}) as unknown as ManagedPolicyStatus;
  if (jsonMode(parsed)) writeLine(ctx.io.stdout, JSON.stringify(status, null, 2));
  else renderPolicyStatus(ctx, status);
  return status.state === "rejected" ? 2 : 0;
}

async function platformCommand(ctx: CliContext, parsed: ParsedArgs, host: HostLike): Promise<number> {
  if (parsed.command === "logout") {
    await host.handle("platform.logout", {});
    if (jsonMode(parsed)) writeLine(ctx.io.stdout, JSON.stringify({ ok: true }, null, 2));
    else writeLine(ctx.io.stdout, "Signed out of Berry platform.");
    return 0;
  }
  const existing = await host.handle("platform.session.get", {}) as unknown as PlatformOrgSession;
  if (parsed.positionals[0] === "status") {
    if (jsonMode(parsed)) writeLine(ctx.io.stdout, JSON.stringify(existing, null, 2));
    else renderPlatformSession(ctx, existing);
    return existing.state === "connected" ? 0 : 2;
  }
  const start = await host.handle("platform.login.start", {
    ...(stringFlag(parsed, "base-url") ? { baseUrl: stringFlag(parsed, "base-url") } : {}),
    ...(stringFlag(parsed, "redirect-uri") ? { redirectUri: stringFlag(parsed, "redirect-uri") } : {}),
  } as unknown as JsonValue) as unknown as PlatformLoginStartResult;
  if (!jsonMode(parsed)) {
    writeLine(ctx.io.stdout, "Open this URL to sign in:");
    writeLine(ctx.io.stdout, start.authorizationUrl);
  }
  const code = stringFlag(parsed, "code") ?? await promptForLoginCode(ctx);
  if (!code) {
    if (jsonMode(parsed)) writeLine(ctx.io.stdout, JSON.stringify(start, null, 2));
    else writeLine(ctx.io.stderr, "No OAuth code was provided; rerun with --code after completing sign-in.");
    return 2;
  }
  const result = await host.handle("platform.login.exchange", {
    code,
    state: start.state,
    baseUrl: start.baseUrl,
    redirectUri: start.redirectUri,
    publicKeys: publicKeyFlags(parsed),
  } as unknown as JsonValue) as unknown as PlatformLoginExchangeResult;
  const usageFlush = parsed.flags.get("skip-usage-flush") === true
    ? { uploaded: 0, skipped: 0, failed: 0, reason: "skipped by CLI flag" }
    : await host.handle("platform.usage.flush", {
        ...(stringFlag(parsed, "usage-limit") ? { limit: Number(stringFlag(parsed, "usage-limit")) } : {}),
      } as unknown as JsonValue) as unknown as PlatformUsageFlushResult;
  if (jsonMode(parsed)) {
    writeLine(ctx.io.stdout, JSON.stringify({ ...result, usageFlush }, null, 2));
  } else {
    renderPlatformSession(ctx, result.session);
    if (result.policy) renderPolicySync(ctx, result.policy);
    writeLine(ctx.io.stdout, `usage upload: ${usageFlush.uploaded} uploaded, ${usageFlush.failed} failed${usageFlush.reason ? ` (${usageFlush.reason})` : ""}`);
  }
  return result.session.state === "connected" && usageFlush.failed === 0 ? 0 : 2;
}

async function promptForLoginCode(ctx: CliContext): Promise<string | null> {
  if (!ctx.io.isTty) return null;
  const rl = createInterface({ input: ctx.io.stdin, output: ctx.io.stdout });
  try {
    const code = await rl.question("Paste the OAuth code from the browser: ");
    return code.trim() || null;
  } finally {
    rl.close();
  }
}

function renderPlatformSession(ctx: CliContext, session: PlatformOrgSession): void {
  writeLine(ctx.io.stdout, `platform: ${session.state}`);
  if (session.organization) writeLine(ctx.io.stdout, `organization: ${session.organization.name} (${session.organization.id})`);
  if (session.user) writeLine(ctx.io.stdout, `user: ${session.user.email ?? session.user.id}`);
  if (session.baseUrl) writeLine(ctx.io.stdout, `base URL: ${session.baseUrl}`);
  if (session.policyUrl) writeLine(ctx.io.stdout, `policy: ${session.policyUrl}`);
  if (session.usageIngestUrl) writeLine(ctx.io.stdout, `usage ingest: ${session.usageIngestUrl}`);
}

function renderPolicyStatus(ctx: CliContext, status: ManagedPolicyStatus): void {
  writeLine(ctx.io.stdout, `policy: ${status.state}`);
  if (status.organization) writeLine(ctx.io.stdout, `organization: ${status.organization.name} (${status.organization.id})`);
  if (status.version) writeLine(ctx.io.stdout, `version: ${status.version}`);
  if (status.keyId) writeLine(ctx.io.stdout, `key: ${status.keyId}`);
  if (status.path) writeLine(ctx.io.stdout, `source: ${status.path}`);
  if (status.locks.length) writeLine(ctx.io.stdout, `locks: ${status.locks.join(", ")}`);
  if (status.error) writeLine(ctx.io.stdout, `error: ${status.error}`);
}

function renderPolicySync(ctx: CliContext, result: ManagedPolicySyncResult): void {
  renderPolicyStatus(ctx, result.status);
  writeLine(ctx.io.stdout, `provenance: ${result.provenance.source}${result.provenance.url ? ` ${result.provenance.url}` : ""}`);
  if (result.provenance.bundleHash) writeLine(ctx.io.stdout, `bundle-sha256: ${result.provenance.bundleHash}`);
}

function help(ctx: CliContext): number {
  writeLine(ctx.io.stdout, renderCliHelp());
  return 0;
}

function version(ctx: CliContext): number {
  writeLine(ctx.io.stdout, `berry ${CLI_VERSION}`);
  return 0;
}

function comingSoon(ctx: CliContext, message: string): number {
  writeLine(ctx.io.stdout, message);
  return 0;
}

function stringFlag(parsed: ParsedArgs, key: string): string | undefined {
  const value = parsed.flags.get(key);
  return typeof value === "string" ? value : undefined;
}

function modelFlag(parsed: ParsedArgs): string | undefined {
  return stringFlag(parsed, "model");
}

function attachmentFlags(parsed: ParsedArgs): string[] {
  const value = parsed.flags.get("attach");
  return Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
}

function publicKeyFlags(parsed: ParsedArgs): Record<string, string> {
  const value = parsed.flags.get("public-key");
  const items = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return Object.fromEntries(items.map((item) => {
    const index = item.indexOf("=");
    if (index <= 0) throw new Error("--public-key must use keyId=base64");
    return [item.slice(0, index), item.slice(index + 1)];
  }));
}

function jsonMode(parsed: ParsedArgs): boolean {
  return parsed.flags.get("json") === true;
}

function cliOwner(): string {
  return `cli:${process.pid}`;
}

function socketPathFor(ctx: CliContext, parsed: ParsedArgs): string {
  return stringFlag(parsed, "socket") ?? ctx.env.BERRY_HOST_SOCKET ?? defaultHostSocketPath(ctx.env);
}

function tokenPathFor(socketPath: string): string {
  return hostSocketTokenPath(socketPath);
}

function recordParam(value: JsonValue | undefined): Record<string, JsonValue | undefined> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, JsonValue | undefined>) : {};
}

function titleFromPrompt(prompt: string): string {
  return prompt.trim().replace(/\s+/g, " ").slice(0, 80) || "CLI task";
}

async function readAll(input: Readable): Promise<string> {
  let output = "";
  for await (const chunk of input) output += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
  return output;
}

function writeJson(output: Writable, value: unknown): void {
  writeLine(output, JSON.stringify(value));
}

function writeLine(output: Writable, value: string): void {
  output.write(`${value}\n`);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
