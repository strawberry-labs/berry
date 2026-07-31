import { describe, expect, it, vi } from "vitest";
import type { SandboxProvider } from "@berry/sandbox-contract";
import {
  SandboxContinuityManager,
  type SandboxSnapshotObjectStore,
  type SandboxSnapshotRepository,
} from "./sandbox-continuity.js";
import type { DurableTurnSnapshot, DurableTurnStep } from "./turn-runner.js";

describe("SandboxContinuityManager", () => {
  it("executes every sandbox-backed durable tool contract", async () => {
    const provider = {
      kind: "e2b",
      create: vi.fn(async () => ({
        sandbox_id: "sandbox-contract",
        provider: "e2b",
        status: "running",
      })),
      exec: async function* () {
        yield { kind: "stdout", data: "command output" };
        yield { kind: "exit", exit_code: 0, signal: null };
      },
      files: {
        read: vi.fn(async (input: { path: string }) => ({
          path: input.path,
          content: "file contents",
          size_bytes: 13,
        })),
        write: vi.fn(async (input: { path: string; content: string }) => ({
          path: input.path,
          size_bytes: Buffer.byteLength(input.content),
          mtime: null,
        })),
        list: vi.fn(async (input: { path: string }) => ({
          path: input.path,
          entries: [{
            path: `${input.path}/file.txt`,
            type: "file",
            size_bytes: 13,
            mtime: null,
          }],
        })),
      },
    } as unknown as SandboxProvider;
    const repository = {
      loadRun: vi.fn(),
      latest: vi.fn(async () => null),
      inputFiles: vi.fn(async () => []),
      persist: vi.fn(),
      recordSandbox: vi.fn(async () => undefined),
    } satisfies SandboxSnapshotRepository;
    const manager = new SandboxContinuityManager(provider, repository, null, {
      image: "berry-sandbox",
    });

    await expect(manager.execute(snapshot(), toolStep("read_file", {
      path: "/workspace/file.txt",
    }))).resolves.toMatchObject({
      output: { path: "/workspace/file.txt", content: "file contents" },
    });
    await expect(manager.execute(snapshot(), toolStep("list_files", {
      path: "/workspace",
      recursive: true,
    }))).resolves.toMatchObject({
      output: { path: "/workspace", entries: [expect.objectContaining({ type: "file" })] },
    });
    await expect(manager.execute(snapshot(), toolStep("write_file", {
      path: "/workspace/result.txt",
      content: "done",
    }))).resolves.toMatchObject({
      output: { path: "/workspace/result.txt", sizeBytes: 4 },
    });
    await expect(manager.execute(snapshot(), toolStep("run_command", {
      command: "printf done",
    }))).resolves.toMatchObject({
      output: { command: "printf done", exitCode: 0, output: "command output" },
    });
  });

  it("reads managed skill references without making the managed tree writable", async () => {
    const read = vi.fn(async (input: { path: string }) => ({
      path: input.path,
      content: "# Brand system",
      size_bytes: 14,
    }));
    const manager = managerWithProvider({
      read,
      write: vi.fn(),
      list: vi.fn(async (input: { path: string }) => ({
        path: input.path,
        entries: [],
      })),
    });

    await expect(manager.execute(snapshot(), toolStep("read_file", {
      path: "/managed-skills/aesg-branding/references/brand-system.md",
    }))).resolves.toMatchObject({
      output: {
        path: "/managed-skills/aesg-branding/references/brand-system.md",
        content: "# Brand system",
      },
    });
    await expect(manager.execute(snapshot(), toolStep("list_files", {
      path: "/managed-skills/aesg-branding/references",
    }))).resolves.toMatchObject({
      output: { path: "/managed-skills/aesg-branding/references" },
    });
    await expect(manager.execute(snapshot(), toolStep("write_file", {
      path: "/managed-skills/aesg-branding/references/brand-system.md",
      content: "changed",
    }))).rejects.toThrow("Sandbox writes must remain under /workspace");
  });

  it("extracts PDF text instead of decoding PDF bytes as UTF-8", async () => {
    const read = vi.fn();
    const manager = managerWithProvider({
      read,
      write: vi.fn(),
      list: vi.fn(),
    }, async function* (input: { command: string[] }) {
      expect(input.command).toEqual([
        "pdftotext",
        "-layout",
        "/workspace/inputs/file-id/reference.pdf",
        "-",
      ]);
      yield { kind: "stdout", data: "Page one text\fPage two text" };
      yield { kind: "exit", exit_code: 0, signal: null };
    });

    await expect(manager.execute(snapshot(), toolStep("read_file", {
      path: "/workspace/inputs/file-id/reference.pdf",
    }))).resolves.toMatchObject({
      output: {
        path: "/workspace/inputs/file-id/reference.pdf",
        content: "Page one text\fPage two text",
        mediaType: "application/pdf",
        extractedText: true,
      },
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("returns binary metadata instead of sending image bytes through the UTF-8 reader", async () => {
    const read = vi.fn();
    const manager = managerWithProvider({
      read,
      write: vi.fn(),
      list: vi.fn(),
    });

    await expect(manager.execute(snapshot(), toolStep("read_file", {
      path: "/workspace/tmp/rendered/page-1.png",
    }))).resolves.toMatchObject({
      output: {
        path: "/workspace/tmp/rendered/page-1.png",
        binary: true,
        mediaType: "image/png",
      },
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("stages message-associated input files before the first tool runs", async () => {
    const staged = new Map<string, Uint8Array[]>();
    const provider = {
      kind: "e2b",
      create: vi.fn(async () => ({
        sandbox_id: "sandbox-1",
        provider: "e2b",
        status: "running",
      })),
      exec: async function* (input: { command: string[] }) {
        if (input.command[0] === "sh" && input.command[2]?.includes("base64 -d")) {
          const path = input.command[4]!;
          const chunks = staged.get(path) ?? [];
          chunks.push(Buffer.from(input.command[5]!, "base64"));
          staged.set(path, chunks);
        }
        yield { kind: "exit", exit_code: 0, signal: null };
      },
      files: {
        read: vi.fn(),
        write: vi.fn(),
        list: vi.fn(async (input: { path: string }) => ({
          path: input.path,
          entries: [...staged.entries()].map(([path, chunks]) => ({
            path,
            type: "file",
            size_bytes: chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
            mtime: null,
          })),
        })),
      },
    } as unknown as SandboxProvider;
    const repository = {
      loadRun: vi.fn(),
      latest: vi.fn(async () => null),
      inputFiles: vi.fn(async () => [{
        fileId: "00000000-0000-7000-8000-000000000099",
        name: "candidate.pdf",
        mediaType: "application/pdf",
        sizeBytes: 3,
        objectKey: "artifacts/tenants/t/files/candidate.pdf",
      }]),
      persist: vi.fn(),
      recordSandbox: vi.fn(async () => undefined),
    } satisfies SandboxSnapshotRepository;
    const objects = {
      put: vi.fn(),
      get: vi.fn(),
      getSource: vi.fn(async () => new Uint8Array([1, 2, 3])),
      streamSource: vi.fn(async function* () {
        yield new Uint8Array([1]);
        yield new Uint8Array([2, 3]);
      }),
    } satisfies SandboxSnapshotObjectStore;
    const manager = new SandboxContinuityManager(provider, repository, objects, {
      image: "berry-sandbox",
    });

    const result = await manager.execute(snapshot(), listFilesStep());

    expect(objects.streamSource).toHaveBeenCalledWith(
      "artifacts/tenants/t/files/candidate.pdf",
      100 * 1024 * 1024,
    );
    const path = "/workspace/inputs/00000000-0000-7000-8000-000000000099/candidate.pdf";
    expect(Buffer.concat(staged.get(path)!.map((chunk) => Buffer.from(chunk)))).toEqual(Buffer.from([1, 2, 3]));
    expect(result.output).toMatchObject({
      entries: [expect.objectContaining({ path })],
    });
  });
});

function snapshot(): DurableTurnSnapshot {
  return {
    id: "00000000-0000-7000-8000-000000000001",
    tenantId: "00000000-0000-7000-8000-000000000002",
    taskId: "00000000-0000-7000-8000-000000000003",
    sessionId: "00000000-0000-7000-8000-000000000004",
    runtimeRequest: {},
  } as DurableTurnSnapshot;
}

function listFilesStep(): DurableTurnStep {
  return {
    id: "00000000-0000-7000-8000-000000000005",
    sequence: 1,
    type: "tool.list_files",
    state: "pending",
    input: { toolName: "list_files", arguments: { path: "/workspace", recursive: true } },
    output: null,
    retryClass: "read_only",
    idempotencyKey: null,
    attempt: 0,
    error: null,
  };
}

function toolStep(name: string, argumentsValue: Record<string, unknown>): DurableTurnStep {
  return {
    id: "00000000-0000-7000-8000-000000000010",
    sequence: 1,
    type: `tool.${name}`,
    state: "pending",
    input: {
      toolName: name,
      arguments: argumentsValue,
    },
    output: null,
    retryClass: "read_only",
    idempotencyKey: null,
    attempt: 0,
    error: null,
  };
}

function managerWithProvider(
  files: unknown,
  exec: unknown = async function* () {
    yield { kind: "exit", exit_code: 0, signal: null };
  },
): SandboxContinuityManager {
  const provider = {
    kind: "e2b",
    create: vi.fn(async () => ({
      sandbox_id: "sandbox-contract",
      provider: "e2b",
      status: "running",
    })),
    exec,
    files,
  } as unknown as SandboxProvider;
  const repository = {
    loadRun: vi.fn(),
    latest: vi.fn(async () => null),
    inputFiles: vi.fn(async () => []),
    persist: vi.fn(),
    recordSandbox: vi.fn(async () => undefined),
  } satisfies SandboxSnapshotRepository;
  return new SandboxContinuityManager(provider, repository, null, {
    image: "berry-sandbox",
  });
}
