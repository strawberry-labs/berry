import { PassThrough } from "node:stream";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { BerryHostService } from "@berry/host";
import { createAssistantMessageEventStream, type AssistantMessage, type BerryStreamFn } from "@berry/local-agent";
import type { ManagedPolicyBundle } from "@berry/shared";
import { CLI_VERSION, runCli } from "./runner.ts";

function textOnlyStreamFn(text: string): BerryStreamFn {
  return (model) => {
    const stream = createAssistantMessageEventStream();
    const message = fakeAssistantMessage(model, [{ type: "text", text }], "stop");
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      stream.push({ type: "text_start", contentIndex: 0, partial: message });
      stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
      stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
      stream.push({ type: "done", reason: "stop", message });
    });
    return stream;
  };
}

function fakeAssistantMessage(model: Parameters<BerryStreamFn>[0], content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content,
    usage: {
      input: 10,
      output: 8,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 18,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

function capture() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (chunk) => {
    out += chunk.toString("utf8");
  });
  stderr.on("data", (chunk) => {
    err += chunk.toString("utf8");
  });
  return { stdout, stderr, output: () => out, error: () => err };
}

function tempPaths() {
  const dir = mkdtempSync(join(tmpdir(), "berry-cli-"));
  return { dir, dbPath: join(dir, "berry.sqlite") };
}

async function waitFor(probe: () => boolean, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for condition");
}

async function seedProvider(dbPath: string) {
  const host = new BerryHostService({ dbPath, agentStreamFn: textOnlyStreamFn("seeded") });
  await host.initialize();
  try {
    await host.handle("model.provider.save", {
      kind: "openrouter-compatible",
      name: "Test Provider",
      baseUrl: "http://localhost/api/v1",
      defaultModel: "test-model",
      authType: "none",
    });
  } finally {
    await host.shutdown();
  }
}

describe("berry cli", () => {
  it("prints a stable version without initializing the host", async () => {
    const io = capture();
    const code = await runCli({ argv: ["--version"], io: { stdout: io.stdout, stderr: io.stderr, isTty: false } });
    expect(code).toBe(0);
    expect(io.output()).toBe("berry 0.1.0\n");
    expect(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version).toBe(CLI_VERSION);
  });

  it("prints doctor JSON against an embedded host without a provider", async () => {
    const { dir, dbPath } = tempPaths();
    const io = capture();
    const code = await runCli({ argv: ["doctor", "--json", "--db", dbPath], cwd: dir, io: { stdout: io.stdout, stderr: io.stderr, isTty: false } });
    expect(code).toBe(2);
    expect(JSON.parse(io.output())).toMatchObject({ db: { ok: true }, providers: { ok: false, enabled: 0 } });
  });

  it("stages a signed CLI update after manifest and artifact verification", async () => {
    const { dir } = tempPaths();
    const fixture = signedUpdateFixture(dir, { version: "0.1.1" });
    const io = capture();
    const code = await runCli({
      argv: ["update", "--manifest", fixture.manifestPath, "--public-key", `test=${fixture.publicKey}`, "--stage-dir", join(dir, "stage"), "--json"],
      cwd: dir,
      io: { stdout: io.stdout, stderr: io.stderr, isTty: false },
    });
    expect(code).toBe(0);
    const result = JSON.parse(io.output());
    expect(result).toMatchObject({ status: "staged", version: "0.1.1", sha256: fixture.sha256 });
    expect(readFileSync(result.stagedPath, "utf8")).toBe("berry update fixture\n");
  });

  it("rejects a tampered CLI update manifest before downloading artifacts", async () => {
    const { dir } = tempPaths();
    const fixture = signedUpdateFixture(dir, { version: "0.1.1" });
    const manifest = JSON.parse(readFileSync(fixture.manifestPath, "utf8"));
    manifest.version = "9.9.9";
    writeFileSync(fixture.manifestPath, JSON.stringify(manifest, null, 2));
    const io = capture();
    const code = await runCli({
      argv: ["update", "--manifest", fixture.manifestPath, "--public-key", `test=${fixture.publicKey}`, "--json"],
      cwd: dir,
      io: { stdout: io.stdout, stderr: io.stderr, isTty: false },
    });
    expect(code).toBe(1);
    expect(io.error()).toContain("signature verification failed");
  });

  it("honors staged rollout percentage for CLI updates", async () => {
    const { dir } = tempPaths();
    const fixture = signedUpdateFixture(dir, { version: "0.1.1", rolloutPercentage: 0 });
    const io = capture();
    const code = await runCli({
      argv: ["update", "--manifest", fixture.manifestPath, "--public-key", `test=${fixture.publicKey}`, "--json"],
      cwd: dir,
      env: { ...process.env, BERRY_UPDATE_MACHINE_ID: "held-client" },
      io: { stdout: io.stdout, stderr: io.stderr, isTty: false },
    });
    expect(code).toBe(0);
    expect(JSON.parse(io.output())).toMatchObject({ status: "held-by-rollout", rolloutEligible: false });
  });

  it("runs platform login, status, and logout through the embedded host", async () => {
    const { dir, dbPath } = tempPaths();
    const requests: Array<{ path: string; auth: string | null; body: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requests.push({ path: url.pathname, auth: new Headers(init?.headers).get("authorization"), body: String(init?.body ?? "") });
      if (url.pathname === "/oauth/token") {
        return new Response(JSON.stringify({ access_token: "platform_cli_fixture", token_type: "Bearer", expires_in: 3600 }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/v1/me/org-session") {
        return new Response(JSON.stringify({
          tenantId: "cli-org",
          organization: { id: "cli-org", name: "CLI Org" },
          user: { id: "cli-user", email: "cli@example.test", name: "CLI User" },
          policyPublicKeys: {},
          usageSigningKeyId: "cli-usage",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    };

    const loginIo = capture();
    const loginCode = await runCli({
      argv: ["login", "--base-url", "https://platform.example.test", "--code", "fixture-code", "--json", "--db", dbPath],
      cwd: dir,
      io: { stdout: loginIo.stdout, stderr: loginIo.stderr, isTty: false },
      hostOptions: { fetchImpl },
    });
    expect(loginCode).toBe(0);
    expect(JSON.parse(loginIo.output())).toMatchObject({
      session: { state: "connected", organization: { name: "CLI Org" }, user: { email: "cli@example.test" } },
      policy: null,
      usageFlush: { uploaded: 0, failed: 0, reason: "usage signing secret not configured" },
    });
    expect(requests.find((request) => request.path === "/oauth/token")?.body).toContain("code_verifier=");

    const statusIo = capture();
    const statusCode = await runCli({
      argv: ["login", "status", "--json", "--db", dbPath],
      cwd: dir,
      io: { stdout: statusIo.stdout, stderr: statusIo.stderr, isTty: false },
    });
    expect(statusCode).toBe(0);
    expect(JSON.parse(statusIo.output())).toMatchObject({ state: "connected", tenantId: "cli-org" });

    const logoutIo = capture();
    const logoutCode = await runCli({
      argv: ["logout", "--json", "--db", dbPath],
      cwd: dir,
      io: { stdout: logoutIo.stdout, stderr: logoutIo.stderr, isTty: false },
    });
    expect(logoutCode).toBe(0);
    expect(JSON.parse(logoutIo.output())).toEqual({ ok: true });
  });

  it("reports unassociated git worktrees without removing them", async () => {
    const { dir, dbPath } = tempPaths();
    const repo = join(dir, "repo");
    const orphanPath = join(dir, "orphan");
    mkdirSync(repo);
    execFileSync("git", ["init", "-b", "trunk"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "berry@example.test"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Berry"], { cwd: repo });
    writeFileSync(join(repo, "README.md"), "berry\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: repo, stdio: "ignore" });
    const host = new BerryHostService({ dbPath });
    await host.initialize();
    await host.handle("workspace.open", { path: repo, trusted: true });
    await host.handle("model.provider.save", { kind: "openrouter-compatible", name: "Test Provider", baseUrl: "http://localhost/api/v1", defaultModel: "test-model", authType: "none" });
    await host.shutdown();
    execFileSync("git", ["worktree", "add", "-b", "berry/orphan", orphanPath, "HEAD"], { cwd: repo, stdio: "ignore" });

    const io = capture();
    const code = await runCli({ argv: ["doctor", "--json", "--db", dbPath], cwd: dir, io: { stdout: io.stdout, stderr: io.stderr, isTty: false } });
    expect(code).toBe(2);
    expect(JSON.parse(io.output())).toMatchObject({
      providers: { ok: true },
      worktrees: { ok: false, orphaned: 1, orphans: [expect.objectContaining({ path: realpathSync(orphanPath), reason: "unassociated" })] },
    });
    expect(existsSync(orphanPath)).toBe(true);
  });

  it("runs the ACP terminal-auth provider diagnostic", async () => {
    const { dir, dbPath } = tempPaths();
    const io = capture();
    const code = await runCli({ argv: ["acp", "doctor", "--json", "--db", dbPath], cwd: dir, io: { stdout: io.stdout, stderr: io.stderr, isTty: false } });
    expect(code).toBe(2);
    expect(JSON.parse(io.output())).toMatchObject({ providers: { ok: false, action: expect.stringContaining("Configure a provider") } });
  });

  it("runs a prompt against a temp workspace and streams NDJSON events", async () => {
    const { dir, dbPath } = tempPaths();
    await seedProvider(dbPath);
    const io = capture();
    const code = await runCli({
      argv: ["run", "-p", "hello cli", "--cwd", dir, "--json", "--mode", "full-access", "--db", dbPath],
      cwd: dir,
      io: { stdout: io.stdout, stderr: io.stderr, isTty: false },
      hostOptions: { agentStreamFn: textOnlyStreamFn("cli ok") },
    });
    expect(code).toBe(0);
    expect(io.output()).toContain('"kind":"message.delta"');
    expect(io.output()).toContain("cli ok");
  });

  it("persists --kind without changing permission mode", async () => {
    const { dir, dbPath } = tempPaths();
    await seedProvider(dbPath);
    const io = capture();
    const code = await runCli({
      argv: ["run", "-p", "implement this", "--cwd", dir, "--json", "--mode", "plan", "--kind", "code", "--db", dbPath],
      cwd: dir,
      io: { stdout: io.stdout, stderr: io.stderr, isTty: false },
      hostOptions: { agentStreamFn: textOnlyStreamFn("done") },
    });
    expect(code).toBe(0);
    const host = new BerryHostService({ dbPath });
    await host.initialize();
    try {
      const [workspace] = await host.handle("workspace.list", {}) as Array<{ id: string }>;
      const [task] = await host.handle("task.list", { workspaceId: workspace!.id }) as Array<{ activeSessionId: string; conversationKind: string }>;
      expect(task).toMatchObject({ conversationKind: "code" });
      await expect(host.handle("session.get", { sessionId: task!.activeSessionId })).resolves.toMatchObject({ permissionMode: "plan" });
    } finally {
      await host.shutdown();
    }
  });

  it("maps legacy Co-work to Chat with one deprecation warning", async () => {
    const { dir, dbPath } = tempPaths();
    await seedProvider(dbPath);
    const io = capture();
    const code = await runCli({
      argv: ["run", "-p", "draft a report", "--cwd", dir, "--mode", "plan", "--ui-mode", "cowork", "--db", dbPath],
      cwd: dir,
      io: { stdout: io.stdout, stderr: io.stderr, isTty: false },
      hostOptions: { agentStreamFn: textOnlyStreamFn("done") },
    });
    expect(code).toBe(0);
    expect(io.error().match(/\[deprecated\]/g)).toHaveLength(1);
    expect(io.error()).toContain("kind=chat permission=plan");
  });

  it("rejects invalid conversation kinds", async () => {
    const { dir, dbPath } = tempPaths();
    await seedProvider(dbPath);
    const io = capture();
    const code = await runCli({
      argv: ["run", "-p", "hello", "--cwd", dir, "--kind", "prose", "--db", dbPath],
      cwd: dir,
      io: { stdout: io.stdout, stderr: io.stderr, isTty: false },
      hostOptions: { agentStreamFn: textOnlyStreamFn("unused") },
    });
    expect(code).toBe(1);
    expect(io.error()).toContain("Invalid conversation kind: prose");
    const host = new BerryHostService({ dbPath });
    await host.initialize();
    try {
      await expect(host.handle("workspace.list", {})).resolves.toEqual([]);
    } finally {
      await host.shutdown();
    }
  });

  it("lists catalog shims as JSON", async () => {
    const { dir, dbPath } = tempPaths();
    const io = capture();
    const code = await runCli({ argv: ["mcp", "list", "--json", "--db", dbPath], cwd: dir, io: { stdout: io.stdout, stderr: io.stderr, isTty: false } });
    expect(code).toBe(0);
    expect(JSON.parse(io.output())).toEqual([]);
  });

  it("prints managed policy status from the host", async () => {
    const { dir, dbPath } = tempPaths();
    const io = capture();
    const code = await runCli({
      argv: ["policy", "status", "--db", dbPath],
      cwd: dir,
      io: { stdout: io.stdout, stderr: io.stderr, isTty: false },
      hostOptions: { managedPolicy: cliManagedPolicy(), managedPolicyPath: "/managed/berry-policy.json" },
    });
    expect(code).toBe(0);
    expect(io.output()).toContain("policy: active");
    expect(io.output()).toContain("organization: Acme");
    expect(io.output()).toContain("locks: models, sandbox, telemetry");
  });

  it("attaches to a socket app-server with the generated token", async () => {
    const { dir, dbPath } = tempPaths();
    const socketPath = join("/private/tmp", `berry-cli-${crypto.randomUUID()}.sock`);
    const serverIo = capture();
    const serverInput = new PassThrough();
    const server = runCli({
      argv: ["app-server", "--socket", socketPath, "--db", dbPath],
      cwd: dir,
      io: { stdin: serverInput, stdout: serverIo.stdout, stderr: serverIo.stderr, isTty: false },
    });
    await waitFor(() => serverIo.error().includes("Berry app-server listening"));

    const clientIo = capture();
    expect(statSync(`${socketPath}.token`).mode & 0o777).toBe(0o600);
    const code = await runCli({
      argv: ["doctor", "--json", "--attach-host"],
      cwd: dir,
      env: { ...process.env, BERRY_HOST_SOCKET: socketPath },
      io: { stdout: clientIo.stdout, stderr: clientIo.stderr, isTty: false },
    });
    expect(code).toBe(2);
    expect(JSON.parse(clientIo.output())).toMatchObject({ db: { ok: true }, providers: { ok: false } });

    serverInput.end();
    await expect(server).resolves.toBe(0);
    expect(existsSync(socketPath)).toBe(false);
    expect(existsSync(`${socketPath}.token`)).toBe(false);
  }, 15_000);
});

function cliManagedPolicy(): ManagedPolicyBundle {
  return {
    version: 1,
    organization: { id: "acme", name: "Acme" },
    issuedAt: "2026-07-10T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    policy: {
      execpolicy: [],
      modelAllowlist: ["router:gpt-5"],
      mcpAllowlist: [],
      pluginAllowlist: [],
      sandboxFloor: "workspace-write",
      telemetry: "required",
    },
    signature: { algorithm: "ed25519", keyId: "acme-2026", value: "verified-by-rust" },
  };
}

function signedUpdateFixture(dir: string, options: { version: string; rolloutPercentage?: number }) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const publicRaw = publicDer.subarray(-32).toString("base64");
  const artifactPath = join(dir, "berry-next");
  const artifact = Buffer.from("berry update fixture\n");
  writeFileSync(artifactPath, artifact);
  const sha256 = createHash("sha256").update(artifact).digest("hex");
  const manifest: Record<string, unknown> = {
    version: options.version,
    keyId: "test",
    notes: "fixture release",
    artifacts: {
      [`${process.platform}-${process.arch}`]: {
        url: artifactPath,
        sha256,
        size: artifact.length,
      },
    },
  };
  if (options.rolloutPercentage !== undefined) manifest.rollout = { percentage: options.rolloutPercentage, salt: "test" };
  const signature = sign(null, Buffer.from(testCanonicalJson(manifest)), privateKey).toString("base64");
  manifest.signature = signature;
  const manifestPath = join(dir, "berry-cli-update.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return { manifestPath, publicKey: publicRaw, sha256 };
}

function testCanonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(testCanonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${testCanonicalJson(item)}`).join(",")}}`;
}
