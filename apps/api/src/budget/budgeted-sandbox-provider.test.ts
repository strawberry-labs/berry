import { SELF_HOST_TENANT_ID } from "@berry/db";
import type {
  SandboxCreateInput,
  SandboxDestroyResult,
  SandboxExecEvent,
  SandboxExecInput,
  SandboxExposePortResult,
  SandboxFileListResult,
  SandboxFileReadResult,
  SandboxFileWriteResult,
  SandboxHandle,
  SandboxOperationOptions,
  SandboxProvider,
} from "@berry/sandbox-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BudgetService, InMemoryBudgetHotCounters, InMemoryBudgetRepository } from "./budget.service.ts";
import { BudgetedSandboxProvider } from "./budgeted-sandbox-provider.ts";

afterEach(() => vi.restoreAllMocks());

describe("BudgetedSandboxProvider", () => {
  it("blocks sandbox creation before provider spend when the hard limit is exceeded", async () => {
    const create = vi.fn(async () => handle());
    const provider = new BudgetedSandboxProvider({
      provider: fakeProvider({ create }),
      budgets: new BudgetService({
        repository: new InMemoryBudgetRepository([limit("1")]),
        hotCounters: new InMemoryBudgetHotCounters(),
        enabled: true,
      }),
      estimates: { createMicros: 5 },
    });

    await expect(provider.create(createInput())).rejects.toMatchObject({
      status: 402,
      response: expect.objectContaining({ code: "budget_exceeded" }),
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("reserves and reconciles sandbox exec calls with provider usage", async () => {
    const budget = new BudgetService({
      repository: new InMemoryBudgetRepository([limit("100")]),
      hotCounters: new InMemoryBudgetHotCounters(),
      enabled: true,
    });
    const reconcile = vi.spyOn(budget, "reconcile");
    const provider = new BudgetedSandboxProvider({
      provider: fakeProvider(),
      budgets: budget,
      estimates: { createMicros: 5, execMicros: 5 },
    });
    const sandbox = await provider.create(createInput());
    const events: SandboxExecEvent[] = [];

    for await (const event of provider.exec({ sandbox_id: sandbox.sandbox_id, request_id: "exec_1", command: ["echo", "ok"] })) {
      events.push(event);
    }

    expect(events.map((event) => event.kind)).toEqual(["started", "usage", "exit"]);
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ requestId: "sandbox_exec_exec_1", actualCostMicros: 7n }));
  });

  it("budgets a multi-file upload as one provider operation without serializing file contents", async () => {
    const budget = new BudgetService({
      repository: new InMemoryBudgetRepository([limit("100")]),
      hotCounters: new InMemoryBudgetHotCounters(),
      enabled: true,
    });
    const reserve = vi.spyOn(budget, "reserve");
    const underlying = fakeProvider();
    const writeManyBytes = vi.fn(async (input: { files: readonly { path: string; content: Uint8Array }[] }) => (
      input.files.map((file) => ({
        path: file.path,
        size_bytes: file.content.byteLength,
        mtime: "2026-07-10T00:00:00.000Z",
      }))
    ));
    underlying.files.writeManyBytes = writeManyBytes;
    const provider = new BudgetedSandboxProvider({ provider: underlying, budgets: budget });
    const sandbox = await provider.create(createInput());

    await provider.files.writeManyBytes!({
      sandbox_id: sandbox.sandbox_id,
      files: [
        { path: "/workspace/a.bin", content: Buffer.from("abc") },
        { path: "/workspace/b.bin", content: Buffer.from("defg") },
      ],
    });

    expect(writeManyBytes).toHaveBeenCalledTimes(1);
    expect(reserve).toHaveBeenLastCalledWith(expect.objectContaining({
      feature: "sandbox.file.write",
      metadata: { sandbox_id: sandbox.sandbox_id, fileCount: 2, sizeBytes: 7 },
    }));
  });

  it("forwards operation options through lifecycle and file wrappers", async () => {
    let now = Date.parse("2026-07-10T00:00:00.000Z");
    vi.spyOn(Date, "now").mockImplementation(() => now++);
    const operationOptions: SandboxOperationOptions = { signal: new AbortController().signal };
    const create = vi.fn(async () => handle());
    const resume = vi.fn(async () => handle());
    const underlying = fakeProvider({ create, resume, supportsResume: true });
    const read = vi.spyOn(underlying.files, "read");
    const write = vi.spyOn(underlying.files, "write");
    const list = vi.spyOn(underlying.files, "list");
    const writeBytes = vi.fn(async () => ({ path: "/workspace/a.bin", size_bytes: 1, mtime: "2026-07-10T00:00:00.000Z" }));
    const writeManyBytes = vi.fn(async () => [{ path: "/workspace/a.bin", size_bytes: 1, mtime: "2026-07-10T00:00:00.000Z" }]);
    underlying.files.writeBytes = writeBytes;
    underlying.files.writeManyBytes = writeManyBytes;
    const provider = new BudgetedSandboxProvider({
      provider: underlying,
      budgets: new BudgetService({
        repository: new InMemoryBudgetRepository([limit("1000")]),
        hotCounters: new InMemoryBudgetHotCounters(),
        enabled: true,
      }),
    });

    const sandbox = await provider.create(createInput(), operationOptions);
    await provider.resume!({ sandbox_id: sandbox.sandbox_id, reason: "test" }, operationOptions);
    await provider.files.read({ sandbox_id: sandbox.sandbox_id, path: "/workspace/a.txt" }, operationOptions);
    await provider.files.write({ sandbox_id: sandbox.sandbox_id, path: "/workspace/a.txt", content: "ok" }, operationOptions);
    await provider.files.writeBytes!({ sandbox_id: sandbox.sandbox_id, path: "/workspace/a.bin", content: Buffer.from("a") }, operationOptions);
    await provider.files.writeManyBytes!({ sandbox_id: sandbox.sandbox_id, files: [{ path: "/workspace/a.bin", content: Buffer.from("a") }] }, operationOptions);
    await provider.files.list({ sandbox_id: sandbox.sandbox_id, path: "/workspace", recursive: false }, operationOptions);

    expect(create).toHaveBeenCalledWith(createInput(), operationOptions);
    expect(resume).toHaveBeenCalledWith({ sandbox_id: sandbox.sandbox_id, reason: "test" }, operationOptions);
    expect(read).toHaveBeenCalledWith(expect.anything(), operationOptions);
    expect(write).toHaveBeenCalledWith(expect.anything(), operationOptions);
    expect(writeBytes).toHaveBeenCalledWith(expect.anything(), operationOptions);
    expect(writeManyBytes).toHaveBeenCalledWith(expect.anything(), operationOptions);
    expect(list).toHaveBeenCalledWith(expect.anything(), operationOptions);
  });
});

function limit(hardLimitMicros: string) {
  return {
    tenantId: SELF_HOST_TENANT_ID,
    scopeType: "org" as const,
    scopeId: SELF_HOST_TENANT_ID,
    period: "month" as const,
    softLimitMicros: "0",
    hardLimitMicros,
    status: "active" as const,
  };
}

function createInput(): SandboxCreateInput {
  return {
    request_id: "create_1",
    tenant_id: SELF_HOST_TENANT_ID,
    task_id: "task_1",
    session_id: "session_1",
    image: "node:22",
    cwd: "/workspace",
  };
}

function handle(): SandboxHandle {
  return {
    sandbox_id: "sandbox_1",
    request_id: "create_1",
    tenant_id: SELF_HOST_TENANT_ID,
    provider: "fixture",
    provider_kind: "fixture",
    status: "running",
    image: "node:22",
    cwd: "/workspace",
    created_at: "2026-07-10T00:00:00.000Z",
    expires_at: null,
    metadata: {},
  };
}

function fakeProvider(overrides: Partial<SandboxProvider> = {}): SandboxProvider {
  return {
    kind: "fixture",
    create: async () => handle(),
    exec: async function* (input: SandboxExecInput) {
      yield { kind: "started", sandbox_id: input.sandbox_id, request_id: input.request_id, pid: 1 };
      yield {
        kind: "usage",
        event: {
          request_id: input.request_id,
          sandbox_id: input.sandbox_id,
          tenant_id: SELF_HOST_TENANT_ID,
          provider: "fixture",
          status: "completed",
          price_version: "fixture-v1",
          runtime_ms: 10,
          vcpu_seconds: 0.01,
          memory_gib_seconds: 0.01,
          storage_gib_seconds: 0,
          provider_minimum_charge: "7",
          ts: "2026-07-10T00:00:00.000Z",
          metadata: {},
        },
      };
      yield { kind: "exit", exit_code: 0, signal: null };
    },
    files: {
      read: async (): Promise<SandboxFileReadResult> => ({ path: "/workspace/a.txt", encoding: "utf8", content: "ok", size_bytes: 2, mtime: null }),
      write: async (): Promise<SandboxFileWriteResult> => ({ path: "/workspace/a.txt", size_bytes: 2, mtime: "2026-07-10T00:00:00.000Z" }),
      list: async (): Promise<SandboxFileListResult> => ({ path: "/workspace", entries: [] }),
    },
    exposePort: async (): Promise<SandboxExposePortResult> => ({ sandbox_id: "sandbox_1", port: 3000, protocol: "http", url: "https://sandbox.example.test", expires_at: null }),
    destroy: async (): Promise<SandboxDestroyResult> => ({ sandbox_id: "sandbox_1", destroyed: true, status: "stopped" }),
    ...overrides,
  };
}
