import { describe, expect, it } from "vitest";
import {
  E2BSandboxProvider,
  type E2BCommandHandleLike,
  type E2BCommandResultLike,
  type E2BFileInfoLike,
  type E2BSandboxClient,
  type E2BSandboxInfoLike,
  type E2BSandboxLike,
} from "./e2b-provider.js";
import { createSandboxProviderFromConfig, sandboxProviderConfigFromEnv } from "./config.js";
import { collectSandboxExecEvents, exerciseSandboxProviderContract } from "./provider.js";

const TENANT_ID = "00000000-0000-4000-8000-000000000001";

describe("E2BSandboxProvider", () => {
  it("implements the sandbox contract directly through the E2B client", async () => {
    const client = new FakeE2BClient();
    const provider = new E2BSandboxProvider({
      apiKey: "e2b_test",
      template: "berry-node",
      client,
      estimatedHourlyCostMicros: 0,
      minimumExecCostMicros: 7,
    });

    const result = await exerciseSandboxProviderContract(provider, {
      requestId: "contract-e2b",
      tenantId: TENANT_ID,
    });

    expect(result.sandbox).toMatchObject({ provider: "e2b", provider_kind: "e2b", image: "berry-node" });
    expect(result.file).toMatchObject({ content: "contract-ok", encoding: "utf8" });
    expect(result.execEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "started" }),
      expect.objectContaining({ kind: "stdout", data: "contract-ok\n" }),
      expect.objectContaining({ kind: "exit", exit_code: 0 }),
      expect.objectContaining({ kind: "usage", event: expect.objectContaining({ provider_minimum_charge: "7" }) }),
    ]));
    expect(result.port.url).toBe(`https://3000-${result.sandbox.sandbox_id}.e2b.test`);
    expect(result.destroy).toEqual({ sandbox_id: result.sandbox.sandbox_id, destroyed: true, status: "stopped" });
    expect(client.lastCreate?.options).toMatchObject({
      secure: true,
      allowInternetAccess: false,
      network: { allowPublicTraffic: false, denyOut: ["0.0.0.0/0"] },
      lifecycle: { onTimeout: { action: "pause", keepMemory: false }, autoResume: false },
    });
  });

  it("pauses on suspend and reuses the sandbox for the same tenant request", async () => {
    const client = new FakeE2BClient();
    const provider = new E2BSandboxProvider({ apiKey: "e2b_test", client });
    const input = {
      request_id: "session_project-1",
      tenant_id: TENANT_ID,
      image: "base",
      cwd: "/workspace",
      ttl_seconds: 600,
      network_policy: { egress: "on" as const, allowedDomains: ["registry.npmjs.org"] },
    };

    const first = await provider.create(input);
    await provider.files.write({ sandbox_id: first.sandbox_id, path: "/workspace/project.txt", content: "durable", encoding: "utf8" });
    await expect(provider.suspend({ sandbox_id: first.sandbox_id })).resolves.toMatchObject({ destroyed: true, status: "stopped" });
    const second = await provider.create(input);
    const file = await provider.files.read({ sandbox_id: second.sandbox_id, path: "/workspace/project.txt", encoding: "utf8" });

    expect(second.sandbox_id).toBe(first.sandbox_id);
    expect(file.content).toBe("durable");
    expect(client.connectCount).toBeGreaterThan(0);
    expect(client.lastCreate?.options.network).toEqual({ allowPublicTraffic: false, allowOut: ["registry.npmjs.org"] });
  });

  it("does not reuse a sandbox from an older template or workspace root", async () => {
    const client = new FakeE2BClient();
    const firstProvider = new E2BSandboxProvider({ apiKey: "e2b_test", template: "aesg-v5", client });
    const first = await firstProvider.create({ request_id: "session_rollout", tenant_id: TENANT_ID, image: "base", cwd: "/old-workspace" });
    await firstProvider.suspend({ sandbox_id: first.sandbox_id });

    const nextProvider = new E2BSandboxProvider({ apiKey: "e2b_test", template: "aesg-v6", client });
    const next = await nextProvider.create({ request_id: "session_rollout", tenant_id: TENANT_ID, image: "base", cwd: "/workspace" });

    expect(next.sandbox_id).not.toBe(first.sandbox_id);
    expect(next.image).toBe("aesg-v6");
    expect(next.cwd).toBe("/workspace");
  });

  it("streams a cancelled command as a killed exit", async () => {
    const client = new FakeE2BClient();
    client.blockCommands = true;
    const provider = new E2BSandboxProvider({ apiKey: "e2b_test", client });
    const sandbox = await provider.create({ request_id: "cancel", tenant_id: TENANT_ID, image: "base" });
    const abort = new AbortController();
    const eventsPromise = collectSandboxExecEvents(provider.exec({
      sandbox_id: sandbox.sandbox_id,
      request_id: "cancel-exec",
      command: ["sleep", "60"],
    }, { signal: abort.signal }));
    queueMicrotask(() => abort.abort());

    const events = await eventsPromise;
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "exit", exit_code: null, signal: "SIGKILL" }),
      expect.objectContaining({ kind: "usage", event: expect.objectContaining({ status: "cancelled" }) }),
    ]));
  });

  it("loads direct E2B configuration from server environment", () => {
    const config = sandboxProviderConfigFromEnv({
      BERRY_SANDBOX_PROVIDER: "e2b",
      E2B_API_KEY: "e2b_server_key",
      BERRY_E2B_TEMPLATE_ID: "berry-node",
      BERRY_E2B_REQUEST_TIMEOUT_MS: "45000",
      BERRY_E2B_KEEP_MEMORY_ON_PAUSE: "true",
      BERRY_E2B_ESTIMATED_HOURLY_COST_MICROS: "100000",
      BERRY_E2B_MINIMUM_EXEC_COST_MICROS: "2",
    });
    expect(config).toMatchObject({
      provider: "e2b",
      e2b: {
        apiKey: "e2b_server_key",
        template: "berry-node",
        requestTimeoutMs: 45_000,
        keepMemoryOnPause: true,
        estimatedHourlyCostMicros: 100_000,
        minimumExecCostMicros: 2,
      },
    });
    expect(createSandboxProviderFromConfig(config)).toBeInstanceOf(E2BSandboxProvider);
    expect(() => sandboxProviderConfigFromEnv({ BERRY_SANDBOX_PROVIDER: "e2b" })).toThrow("E2B_API_KEY");
  });
});

type StoredSandbox = {
  sandbox: FakeSandbox;
  info: E2BSandboxInfoLike;
};

class FakeE2BClient implements E2BSandboxClient {
  readonly sandboxes = new Map<string, StoredSandbox>();
  lastCreate: Parameters<E2BSandboxClient["create"]>[0] | undefined;
  connectCount = 0;
  blockCommands = false;

  async create(input: Parameters<E2BSandboxClient["create"]>[0]): Promise<E2BSandboxLike> {
    this.lastCreate = input;
    const id = `e2b_${this.sandboxes.size + 1}`;
    const sandbox = new FakeSandbox(id, () => this.blockCommands);
    const now = new Date("2026-07-16T00:00:00.000Z");
    const info: E2BSandboxInfoLike = {
      sandboxId: id,
      templateId: input.template,
      metadata: input.options.metadata,
      startedAt: now,
      endAt: new Date(now.getTime() + input.options.timeoutMs),
      state: "running",
      cpuCount: 2,
      memoryMB: 4096,
    };
    sandbox.onPause = () => { info.state = "paused"; };
    this.sandboxes.set(id, { sandbox, info });
    return sandbox;
  }

  async connect(sandboxId: string): Promise<E2BSandboxLike> {
    this.connectCount += 1;
    const stored = this.require(sandboxId);
    stored.info.state = "running";
    return stored.sandbox;
  }

  async find(metadata: Record<string, string>): Promise<E2BSandboxInfoLike | undefined> {
    return [...this.sandboxes.values()].find(({ info }) => (
      info.state === "running" || info.state === "paused"
    ) && Object.entries(metadata).every(([key, value]) => info.metadata[key] === value))?.info;
  }

  async getInfo(sandboxId: string): Promise<E2BSandboxInfoLike> {
    return this.require(sandboxId).info;
  }

  async pause(sandboxId: string): Promise<boolean> {
    const stored = this.require(sandboxId);
    stored.info.state = "paused";
    stored.sandbox.onPause?.();
    return true;
  }

  async kill(sandboxId: string): Promise<boolean> {
    return this.sandboxes.delete(sandboxId);
  }

  private require(sandboxId: string): StoredSandbox {
    const stored = this.sandboxes.get(sandboxId);
    if (!stored) throw new Error(`Sandbox not found: ${sandboxId}`);
    return stored;
  }
}

class FakeSandbox implements E2BSandboxLike {
  readonly filesByPath = new Map<string, { content: Uint8Array; modifiedTime: Date }>();
  onPause: (() => void) | undefined;
  readonly files: E2BSandboxLike["files"];
  readonly commands: E2BSandboxLike["commands"];

  constructor(readonly sandboxId: string, private readonly blockCommands: () => boolean) {
    this.files = {
      read: async (path, options) => {
        const file = this.requireFile(path);
        return options.format === "bytes" ? file.content : Buffer.from(file.content).toString("utf8");
      },
      write: async (path, data) => {
        const content = typeof data === "string" ? Buffer.from(data) : new Uint8Array(data);
        const modifiedTime = new Date("2026-07-16T00:00:01.000Z");
        this.filesByPath.set(path, { content, modifiedTime });
        return fileInfo(path, content.byteLength, modifiedTime);
      },
      list: async (path) => [...this.filesByPath.entries()]
        .filter(([candidate]) => candidate.startsWith(`${path.replace(/\/$/, "")}/`))
        .map(([candidate, file]) => fileInfo(candidate, file.content.byteLength, file.modifiedTime)),
      getInfo: async (path) => {
        const file = this.requireFile(path);
        return fileInfo(path, file.content.byteLength, file.modifiedTime);
      },
    };
    this.commands = {
      run: async (command, options) => {
        if (options?.background) return new FakeCommandHandle(command, options, this.blockCommands);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
  }

  getHost(port: number): string {
    return `${port}-${this.sandboxId}.e2b.test`;
  }

  async pause(): Promise<boolean> {
    this.onPause?.();
    return true;
  }

  private requireFile(path: string): { content: Uint8Array; modifiedTime: Date } {
    const file = this.filesByPath.get(path);
    if (!file) throw new Error(`File not found: ${path}`);
    return file;
  }
}

class FakeCommandHandle implements E2BCommandHandleLike {
  readonly pid = 42;
  #killed = false;
  #resolveKilled: (() => void) | undefined;

  constructor(
    private readonly command: string,
    private readonly options: Parameters<E2BSandboxLike["commands"]["run"]>[1],
    private readonly blocked: () => boolean,
  ) {}

  async wait(): Promise<E2BCommandResultLike> {
    if (this.blocked() && !this.#killed) await new Promise<void>((resolve) => { this.#resolveKilled = resolve; });
    if (this.#killed) throw new Error("Command killed");
    const output = this.command.includes("echo") ? "contract-ok\n" : "";
    await this.options?.onStdout?.(output);
    return { exitCode: 0, stdout: output, stderr: "" };
  }

  async kill(): Promise<boolean> {
    this.#killed = true;
    this.#resolveKilled?.();
    return true;
  }

  async sendStdin(): Promise<void> {}
  async closeStdin(): Promise<void> {}
}

function fileInfo(path: string, size: number, modifiedTime: Date): E2BFileInfoLike {
  return { name: path.split("/").at(-1) ?? path, path, type: "file", size, modifiedTime };
}
