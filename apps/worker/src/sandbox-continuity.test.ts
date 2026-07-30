import { describe, expect, it, vi } from "vitest";
import type { SandboxProvider } from "@berry/sandbox-contract";
import {
  SandboxContinuityManager,
  type SandboxSnapshotObjectStore,
  type SandboxSnapshotRepository,
} from "./sandbox-continuity.js";
import type { DurableTurnSnapshot, DurableTurnStep } from "./turn-runner.js";

describe("SandboxContinuityManager", () => {
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
