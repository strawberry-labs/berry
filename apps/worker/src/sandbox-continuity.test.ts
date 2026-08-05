import { describe, expect, it, vi } from "vitest";
import type { S3Client } from "@aws-sdk/client-s3";
import type { SandboxProvider } from "@berry/sandbox-contract";
import {
  S3SandboxSnapshotObjectStore,
  SandboxContinuityManager,
  SqlSandboxSnapshotRepository,
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
      continuity: vi.fn(async () => null),
      latest: vi.fn(async () => null),
      inputFiles: vi.fn(async () => []),
      persistOutput: vi.fn(),
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
        visionPath: "/workspace/tmp/rendered/page-1.png",
      },
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("supplies task attachments and requested sandbox images as model vision content", async () => {
    const generated = Buffer.from([9, 8, 7]);
    const attached = Buffer.from([1, 2, 3, 4]);
    const provider = {
      kind: "e2b",
      create: vi.fn(),
      exec: vi.fn(),
      files: {
        read: vi.fn(async (input: { path: string }) => ({
          path: input.path,
          content: generated.toString("base64"),
          size_bytes: generated.byteLength,
          mtime: null,
        })),
        write: vi.fn(),
        list: vi.fn(async (input: { path: string }) => ({
          path: input.path,
          entries: [],
        })),
      },
    } as unknown as SandboxProvider;
    const repository = {
      loadRun: vi.fn(),
      continuity: vi.fn(async () => null),
      latest: vi.fn(async () => null),
      inputFiles: vi.fn(async () => [
        {
          fileId: "00000000-0000-7000-8000-000000000090",
          name: "reference.png",
          mediaType: "image/png",
          sizeBytes: attached.byteLength,
          objectKey: "artifacts/tenants/t/reference.png",
        },
        {
          fileId: "00000000-0000-7000-8000-000000000091",
          name: "brief.pdf",
          mediaType: "application/pdf",
          sizeBytes: 5,
          objectKey: "artifacts/tenants/t/brief.pdf",
        },
      ]),
      persistOutput: vi.fn(),
      persist: vi.fn(),
      recordSandbox: vi.fn(async () => undefined),
    } satisfies SandboxSnapshotRepository;
    const objects = {
      put: vi.fn(),
      putArtifact: vi.fn(),
      get: vi.fn(),
      getSource: vi.fn(async () => attached),
    } satisfies SandboxSnapshotObjectStore;
    const manager = new SandboxContinuityManager(provider, repository, objects, {
      image: "berry-sandbox",
    });
    const current = snapshot();
    current.sandboxId = "sandbox-existing";
    current.sandboxProvider = "e2b";
    current.steps = [{
      ...toolStep("read_file", { path: "/workspace/outputs/chart.png" }),
      state: "completed",
      output: {
        path: "/workspace/outputs/chart.png",
        binary: true,
        mediaType: "image/png",
        visionPath: "/workspace/outputs/chart.png",
      },
    }];

    await expect(manager.modelContent(current)).resolves.toEqual([
      {
        type: "image_url",
        image_url: { url: `data:image/png;base64,${generated.toString("base64")}` },
      },
      {
        type: "image_url",
        image_url: { url: `data:image/png;base64,${attached.toString("base64")}` },
      },
    ]);
    expect(provider.files.read).toHaveBeenCalledWith({
      sandbox_id: "sandbox-existing",
      path: "/workspace/outputs/chart.png",
      encoding: "base64",
    });
    expect(objects.getSource).toHaveBeenCalledOnce();
  });

  it("publishes completed output files into durable task storage", async () => {
    const provider = {
      kind: "e2b",
      create: vi.fn(async () => ({
        sandbox_id: "sandbox-artifact",
        provider: "e2b",
        status: "running",
      })),
      exec: async function* () {
        yield { kind: "exit", exit_code: 0, signal: null };
      },
      files: {
        read: vi.fn(async (input: { path: string }) => ({
          path: input.path,
          content: "JVBERi0=",
          size_bytes: 5,
          mtime: null,
        })),
        write: vi.fn(),
        list: vi.fn(async (input: { path: string }) => ({
          path: input.path,
          entries: [],
        })),
      },
    } as unknown as SandboxProvider;
    const repository = {
      loadRun: vi.fn(),
      continuity: vi.fn(async () => null),
      latest: vi.fn(async () => null),
      inputFiles: vi.fn(async () => []),
      persistOutput: vi.fn(async (input: { fileId: string; name: string; mediaType: string; sizeBytes: number; objectKey: string }) => ({
        fileId: input.fileId,
        name: input.name,
        mediaType: input.mediaType,
        sizeBytes: input.sizeBytes,
        objectKey: input.objectKey,
      })),
      persist: vi.fn(),
      recordSandbox: vi.fn(async () => undefined),
    } satisfies SandboxSnapshotRepository;
    const objects = {
      put: vi.fn(),
      putArtifact: vi.fn(async (key: string) => ({
        bucket: "berry",
        key: `artifacts/${key}`,
        etag: "etag",
      })),
      get: vi.fn(),
      getSource: vi.fn(),
    } satisfies SandboxSnapshotObjectStore;
    const manager = new SandboxContinuityManager(provider, repository, objects, {
      image: "berry-sandbox",
    });

    await expect(manager.execute(snapshot(), toolStep("persist_artifact", {
      path: "/workspace/outputs/report.pdf",
      name: "Project report.pdf",
    }))).resolves.toMatchObject({
      output: {
        artifact: {
          name: "Project report.pdf",
          mediaType: "application/pdf",
          size: 5,
          fileId: "00000000-0000-7000-8000-000000000010",
        },
      },
    });
    expect(objects.putArtifact).toHaveBeenCalledWith(
      expect.stringContaining("/original/Project report.pdf"),
      Buffer.from("%PDF-"),
      "application/pdf",
    );
    expect(repository.persistOutput).toHaveBeenCalledOnce();
    await expect(manager.execute(snapshot(), toolStep("persist_artifact", {
      path: "/workspace/tmp/private.pdf",
    }))).rejects.toThrow("Artifacts must be created under /workspace/outputs");
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
      exec: async function* (input: { command: string[]; stdin?: string }) {
        if (input.command[0] === "sh" && input.command[2]?.includes("base64 -d")) {
          const path = input.command[4]!;
          const chunks = staged.get(path) ?? [];
          expect(input.command).toHaveLength(5);
          expect(input.stdin).toBeTypeOf("string");
          chunks.push(Buffer.from(input.stdin!, "base64"));
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
      continuity: vi.fn(async () => null),
      latest: vi.fn(async () => null),
      inputFiles: vi.fn(async () => [{
        fileId: "00000000-0000-7000-8000-000000000099",
        name: "candidate.pdf",
        mediaType: "application/pdf",
        sizeBytes: (256 * 1024) + 2,
        objectKey: "artifacts/tenants/t/files/candidate.pdf",
      }]),
      persistOutput: vi.fn(),
      persist: vi.fn(),
      recordSandbox: vi.fn(async () => undefined),
    } satisfies SandboxSnapshotRepository;
    const objects = {
      put: vi.fn(),
      putArtifact: vi.fn(),
      get: vi.fn(),
      getSource: vi.fn(async () => new Uint8Array([1, 2, 3])),
      streamSource: vi.fn(async function* () {
        yield new Uint8Array(256 * 1024).fill(1);
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
    const stagedBytes = Buffer.concat(staged.get(path)!.map((chunk) => Buffer.from(chunk)));
    expect(stagedBytes).toHaveLength((256 * 1024) + 2);
    expect(stagedBytes.subarray(-2)).toEqual(Buffer.from([2, 3]));
    expect(result.output).toMatchObject({
      entries: [expect.objectContaining({ path })],
    });
  });

  it("reuses the previous live sandbox for a follow-up turn in the same session", async () => {
    const provider = {
      kind: "e2b",
      create: vi.fn(),
      exec: vi.fn(),
      files: {
        read: vi.fn(),
        write: vi.fn(),
        list: vi.fn(async (input: { path: string }) => ({
          path: input.path,
          entries: [],
        })),
      },
    } as unknown as SandboxProvider;
    const repository = {
      loadRun: vi.fn(),
      continuity: vi.fn(async () => ({
        provider: "e2b",
        sandboxId: "sandbox-from-previous-turn",
        snapshot: null,
      })),
      latest: vi.fn(async () => null),
      inputFiles: vi.fn(async () => []),
      persistOutput: vi.fn(),
      persist: vi.fn(),
      recordSandbox: vi.fn(async () => undefined),
    } satisfies SandboxSnapshotRepository;
    const manager = new SandboxContinuityManager(provider, repository, null, {
      image: "berry-sandbox",
    });

    await manager.execute(snapshot(), listFilesStep());

    expect(provider.create).not.toHaveBeenCalled();
    expect(repository.recordSandbox).toHaveBeenCalledWith({
      tenantId: "00000000-0000-7000-8000-000000000002",
      runId: "00000000-0000-7000-8000-000000000001",
      provider: "e2b",
      sandboxId: "sandbox-from-previous-turn",
      state: "running",
    });
  });

  it("round-trips snapshot keys with the S3 prefix while preserving full input-file keys", async () => {
    const keys: string[] = [];
    const client = {
      send: vi.fn(async (command: { input?: { Key?: string } }) => {
        keys.push(command.input?.Key ?? "");
        if (command.constructor.name === "GetObjectCommand") {
          return {
            ContentLength: 2,
            Body: {
              async *[Symbol.asyncIterator]() {
                yield new Uint8Array([1, 2]);
              },
            },
          };
        }
        return {};
      }),
    } as unknown as S3Client;
    const store = new S3SandboxSnapshotObjectStore(client, "berry", "artifacts");

    await store.put("sandbox-snapshots/tenant/run/hash.json", new Uint8Array([1, 2]));
    await expect(store.get("sandbox-snapshots/tenant/run/hash.json")).resolves.toEqual(new Uint8Array([1, 2]));
    await expect(store.getSource("artifacts/tenants/tenant/files/input.pdf")).resolves.toEqual(new Uint8Array([1, 2]));

    expect(keys).toEqual([
      "artifacts/sandbox-snapshots/tenant/run/hash.json",
      "artifacts/sandbox-snapshots/tenant/run/hash.json",
      "artifacts/tenants/tenant/files/input.pdf",
    ]);
  });

  it("stages completed uploads and storage-ready generated files", async () => {
    let query = "";
    const repository = new SqlSandboxSnapshotRepository({
      query: vi.fn(async (sql: string) => {
        query = sql;
        return [];
      }),
      execute: vi.fn(),
    } as never);

    await repository.inputFiles(
      "00000000-0000-7000-8000-000000000002",
      "00000000-0000-7000-8000-000000000001",
    );

    expect(query).toContain("u.status='completed'");
    expect(query).toContain("a.session_id=r.session_id");
    expect(query).toContain("f.origin IN ('sandbox_output','image_generation','browser_capture','legacy_artifact')");
    expect(query).toContain("f.status='available'");
  });
});

function snapshot(): DurableTurnSnapshot {
  return {
    id: "00000000-0000-7000-8000-000000000001",
    createdAt: "2026-07-31T00:00:00.000Z",
    tenantId: "00000000-0000-7000-8000-000000000002",
    userId: "00000000-0000-7000-8000-000000000006",
    workspaceId: "00000000-0000-7000-8000-000000000007",
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
    continuity: vi.fn(async () => null),
    latest: vi.fn(async () => null),
    inputFiles: vi.fn(async () => []),
    persistOutput: vi.fn(),
    persist: vi.fn(),
    recordSandbox: vi.fn(async () => undefined),
  } satisfies SandboxSnapshotRepository;
  return new SandboxContinuityManager(provider, repository, null, {
    image: "berry-sandbox",
  });
}
