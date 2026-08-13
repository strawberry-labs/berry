import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type { S3Client } from "@aws-sdk/client-s3";
import type { SandboxProvider } from "@berry/sandbox-contract";
import {
  S3SandboxSnapshotObjectStore,
  SandboxContinuityManager,
  SqlSandboxSnapshotRepository,
  PI_BASH_WRAPPER_SCRIPT,
  PI_GREP_FILTER_SCRIPT,
  PI_READ_STREAM_SCRIPT,
  piReadContent,
  type SandboxSnapshotObjectStore,
  type SandboxSnapshotRepository,
} from "./sandbox-continuity.js";
import type { DurableTurnSnapshot, DurableTurnStep } from "./turn-runner.js";
import type { SqlExecutor } from "./sql-repositories.js";

describe("SandboxContinuityManager", () => {
  it("pauses a terminal E2B sandbox after preserving its durable snapshot", async () => {
    const suspend = vi.fn(async () => ({
      sandbox_id: "sandbox-terminal",
      destroyed: true,
      status: "stopped" as const,
    }));
    const provider = {
      kind: "e2b",
      suspend,
      files: {
        list: vi.fn(async () => ({ path: "/workspace", entries: [] })),
        read: vi.fn(),
        write: vi.fn(),
      },
    } as unknown as SandboxProvider;
    const repository = {
      loadRun: vi.fn(async () => ({
        tenantId: "00000000-0000-7000-8000-000000000002",
        runId: "00000000-0000-7000-8000-000000000001",
        sessionId: "00000000-0000-7000-8000-000000000004",
        taskId: "00000000-0000-7000-8000-000000000003",
        sandboxProvider: "e2b",
        sandboxId: "sandbox-terminal",
        runState: "completed",
        sessionLeafId: null,
      })),
      continuity: vi.fn(async () => null),
      latest: vi.fn(async () => null),
      inputFiles: vi.fn(async () => []),
      persistOutput: vi.fn(),
      persist: vi.fn(async () => ({
        id: "snapshot-1",
        objectKey: "sandbox-snapshots/terminal.json",
        contentHash: "hash",
        sequence: 1,
      })),
      recordSandbox: vi.fn(async (_input: {
        tenantId: string;
        runId: string;
        provider: string;
        sandboxId: string;
        state: string;
      }) => undefined),
    } satisfies SandboxSnapshotRepository;
    const objects = {
      put: vi.fn(async () => undefined),
      putArtifact: vi.fn(),
      get: vi.fn(),
      getSource: vi.fn(),
    } satisfies SandboxSnapshotObjectStore;
    const manager = new SandboxContinuityManager(provider, repository, objects, {
      image: "berry-sandbox",
    });

    await expect(manager.snapshot({
      tenantId: "00000000-0000-7000-8000-000000000002",
      runId: "00000000-0000-7000-8000-000000000001",
      reason: "before-finalize",
    })).resolves.toMatchObject({ noOp: false, snapshotId: "snapshot-1" });

    expect(suspend).toHaveBeenCalledWith({
      sandbox_id: "sandbox-terminal",
      reason: "Terminal turn snapshot completed",
    });
    expect(repository.recordSandbox).toHaveBeenCalledWith(expect.objectContaining({
      sandboxId: "sandbox-terminal",
      state: "paused",
    }));
  });

  it("checkpoints and pauses compute while a turn waits for user input", async () => {
    const suspend = vi.fn(async () => ({
      sandbox_id: "sandbox-waiting",
      destroyed: true,
      status: "stopped" as const,
    }));
    const provider = {
      kind: "e2b",
      suspend,
      files: {
        list: vi.fn(async () => ({ path: "/workspace", entries: [] })),
        read: vi.fn(),
        write: vi.fn(),
      },
    } as unknown as SandboxProvider;
    const repository = {
      loadRun: vi.fn(async () => ({
        tenantId: "00000000-0000-7000-8000-000000000002",
        runId: "00000000-0000-7000-8000-000000000001",
        sessionId: "00000000-0000-7000-8000-000000000004",
        taskId: "00000000-0000-7000-8000-000000000003",
        sandboxProvider: "e2b",
        sandboxId: "sandbox-waiting",
        sandboxState: "running",
        runState: "waiting",
        sessionLeafId: null,
      })),
      continuity: vi.fn(async () => null),
      latest: vi.fn(async () => null),
      inputFiles: vi.fn(async () => []),
      persistOutput: vi.fn(),
      persist: vi.fn(async () => ({ id: "snapshot-wait", objectKey: "wait.json", contentHash: "hash", sequence: 1 })),
      recordSandbox: vi.fn(async (_input: {
        tenantId: string;
        runId: string;
        provider: string;
        sandboxId: string;
        state: string;
      }) => undefined),
    } satisfies SandboxSnapshotRepository;
    const objects = {
      put: vi.fn(async () => undefined),
      putArtifact: vi.fn(),
      get: vi.fn(),
      getSource: vi.fn(),
    } satisfies SandboxSnapshotObjectStore;
    const manager = new SandboxContinuityManager(provider, repository, objects, { image: "berry-sandbox" });

    await expect(manager.snapshot({
      tenantId: "00000000-0000-7000-8000-000000000002",
      runId: "00000000-0000-7000-8000-000000000001",
      reason: "before-wait",
    })).resolves.toMatchObject({ noOp: false, snapshotId: "snapshot-wait" });

    expect(suspend).toHaveBeenCalledWith({
      sandbox_id: "sandbox-waiting",
      reason: "Waiting turn snapshot completed",
    });
    expect(repository.recordSandbox).toHaveBeenCalledWith(expect.objectContaining({ state: "paused" }));
  });

  it("ignores a stale wait snapshot after the turn has already resumed", async () => {
    const provider = {
      kind: "e2b",
      suspend: vi.fn(),
      destroy: vi.fn(),
      files: { list: vi.fn(), read: vi.fn(), write: vi.fn() },
    } as unknown as SandboxProvider;
    const repository = {
      loadRun: vi.fn(async () => ({
        tenantId: "00000000-0000-7000-8000-000000000002",
        runId: "00000000-0000-7000-8000-000000000001",
        sessionId: "00000000-0000-7000-8000-000000000004",
        taskId: "00000000-0000-7000-8000-000000000003",
        sandboxProvider: "e2b",
        sandboxId: "sandbox-resumed",
        sandboxState: "running",
        runState: "calling_model",
        sessionLeafId: null,
      })),
      continuity: vi.fn(),
      latest: vi.fn(),
      inputFiles: vi.fn(),
      persistOutput: vi.fn(),
      persist: vi.fn(),
      recordSandbox: vi.fn(),
    } satisfies SandboxSnapshotRepository;
    const manager = new SandboxContinuityManager(provider, repository, null, { image: "berry-sandbox" });

    await expect(manager.snapshot({
      tenantId: "00000000-0000-7000-8000-000000000002",
      runId: "00000000-0000-7000-8000-000000000001",
      reason: "before-wait",
    })).resolves.toEqual({ noOp: true });
    expect(provider.files.list).not.toHaveBeenCalled();
    expect(provider.suspend).not.toHaveBeenCalled();
  });

  it("does not reopen a terminal sandbox that is already paused", async () => {
    const suspend = vi.fn();
    const list = vi.fn();
    const provider = {
      kind: "e2b",
      suspend,
      files: { list, read: vi.fn(), write: vi.fn() },
    } as unknown as SandboxProvider;
    const repository = {
      loadRun: vi.fn(async () => ({
        tenantId: "00000000-0000-7000-8000-000000000002",
        runId: "00000000-0000-7000-8000-000000000001",
        sessionId: "00000000-0000-7000-8000-000000000004",
        taskId: "00000000-0000-7000-8000-000000000003",
        sandboxProvider: "e2b",
        sandboxId: "sandbox-terminal",
        sandboxState: "paused",
        runState: "completed",
        sessionLeafId: null,
      })),
      continuity: vi.fn(),
      latest: vi.fn(),
      inputFiles: vi.fn(),
      persistOutput: vi.fn(),
      persist: vi.fn(),
      recordSandbox: vi.fn(),
    } satisfies SandboxSnapshotRepository;
    const manager = new SandboxContinuityManager(provider, repository, null, {
      image: "berry-sandbox",
    });

    await expect(manager.snapshot({
      tenantId: "00000000-0000-7000-8000-000000000002",
      runId: "00000000-0000-7000-8000-000000000001",
      reason: "before-finalize",
    })).resolves.toEqual({ noOp: true });
    expect(list).not.toHaveBeenCalled();
    expect(suspend).not.toHaveBeenCalled();
  });

  it("pauses a terminal sandbox even when its final snapshot exceeds the deadline", async () => {
    const suspend = vi.fn(async () => ({
      sandbox_id: "sandbox-terminal",
      destroyed: true,
      status: "stopped" as const,
    }));
    const provider = {
      kind: "e2b",
      suspend,
      files: {
        list: vi.fn(() => new Promise(() => undefined)),
        read: vi.fn(),
        write: vi.fn(),
      },
    } as unknown as SandboxProvider;
    const repository = {
      loadRun: vi.fn(async () => ({
        tenantId: "00000000-0000-7000-8000-000000000002",
        runId: "00000000-0000-7000-8000-000000000001",
        sessionId: "00000000-0000-7000-8000-000000000004",
        taskId: "00000000-0000-7000-8000-000000000003",
        sandboxProvider: "e2b",
        sandboxId: "sandbox-terminal",
        sandboxState: "pause_requested",
        runState: "completed",
        sessionLeafId: null,
      })),
      continuity: vi.fn(),
      latest: vi.fn(),
      inputFiles: vi.fn(),
      persistOutput: vi.fn(),
      persist: vi.fn(),
      recordSandbox: vi.fn(async () => undefined),
    } satisfies SandboxSnapshotRepository;
    const manager = new SandboxContinuityManager(provider, repository, null, {
      image: "berry-sandbox",
      terminalSnapshotTimeoutMs: 5,
    });

    await expect(manager.snapshot({
      tenantId: "00000000-0000-7000-8000-000000000002",
      runId: "00000000-0000-7000-8000-000000000001",
      reason: "before-finalize",
    })).rejects.toThrow("Terminal sandbox snapshot timed out after 5ms");
    expect(suspend).toHaveBeenCalledOnce();
    expect(repository.recordSandbox).toHaveBeenCalledWith(expect.objectContaining({ state: "paused" }));
  });

  it("does not let a delayed interval snapshot wake a terminal sandbox", async () => {
    const provider = {
      kind: "e2b",
      resume: vi.fn(),
      suspend: vi.fn(),
      destroy: vi.fn(),
      files: { list: vi.fn(), read: vi.fn(), write: vi.fn() },
    } as unknown as SandboxProvider;
    const repository = {
      loadRun: vi.fn(async () => ({
        tenantId: "00000000-0000-7000-8000-000000000002",
        runId: "00000000-0000-7000-8000-000000000001",
        sessionId: "00000000-0000-7000-8000-000000000004",
        taskId: "00000000-0000-7000-8000-000000000003",
        sandboxProvider: "e2b",
        sandboxId: "sandbox-terminal",
        sandboxState: "pause_requested",
        runState: "completed",
        sessionLeafId: null,
      })),
      continuity: vi.fn(),
      latest: vi.fn(),
      inputFiles: vi.fn(),
      persistOutput: vi.fn(),
      persist: vi.fn(),
      recordSandbox: vi.fn(),
    } satisfies SandboxSnapshotRepository;
    const manager = new SandboxContinuityManager(provider, repository, null, { image: "berry-sandbox" });

    await expect(manager.snapshot({
      tenantId: "00000000-0000-7000-8000-000000000002",
      runId: "00000000-0000-7000-8000-000000000001",
      reason: "interval",
    })).resolves.toEqual({ noOp: true });
    expect(provider.files.list).not.toHaveBeenCalled();
    expect(provider.resume).not.toHaveBeenCalled();
    expect(provider.suspend).not.toHaveBeenCalled();
  });

  it("skips an interval snapshot immediately when the sandbox lifecycle lock is busy", async () => {
    const provider = {
      kind: "e2b",
      files: { list: vi.fn(), read: vi.fn(), write: vi.fn() },
    } as unknown as SandboxProvider;
    const repository = {
      loadRun: vi.fn(async () => ({
        tenantId: "00000000-0000-7000-8000-000000000002",
        runId: "00000000-0000-7000-8000-000000000001",
        sessionId: "00000000-0000-7000-8000-000000000004",
        taskId: "00000000-0000-7000-8000-000000000003",
        sandboxProvider: "e2b",
        sandboxId: "sandbox-busy",
        sandboxState: "running",
        runState: "calling_model",
        sessionLeafId: null,
      })),
      continuity: vi.fn(),
      latest: vi.fn(),
      inputFiles: vi.fn(),
      persistOutput: vi.fn(),
      persist: vi.fn(),
      recordSandbox: vi.fn(),
      tryWithSandboxLifecycleLock: vi.fn(async () => null),
    } satisfies SandboxSnapshotRepository;
    const manager = new SandboxContinuityManager(provider, repository, null, { image: "berry-sandbox" });

    await expect(manager.snapshot({
      tenantId: "00000000-0000-7000-8000-000000000002",
      runId: "00000000-0000-7000-8000-000000000001",
      reason: "interval",
    })).resolves.toEqual({ noOp: true });
    expect(provider.files.list).not.toHaveBeenCalled();
  });

  it("does not persist durable inputs or disposable workspace tmp files", async () => {
    const read = vi.fn(async (input: { path: string }) => ({
      path: input.path,
      content: Buffer.from("keep").toString("base64"),
      size_bytes: 4,
    }));
    const provider = {
      kind: "e2b",
      files: {
        list: vi.fn(async () => ({
          path: "/workspace",
          entries: [
            { path: "/workspace/tmp/toolchain/file.c", type: "file", size_bytes: 4, mtime: null },
            { path: "/workspace/inputs/file-1/source.pdf", type: "file", size_bytes: 4, mtime: null },
            { path: "/workspace/notes.md", type: "file", size_bytes: 4, mtime: null },
          ],
        })),
        read,
        write: vi.fn(),
      },
    } as unknown as SandboxProvider;
    const run = {
      tenantId: "00000000-0000-7000-8000-000000000002",
      runId: "00000000-0000-7000-8000-000000000001",
      sessionId: "00000000-0000-7000-8000-000000000004",
      taskId: "00000000-0000-7000-8000-000000000003",
      sandboxProvider: "e2b",
      sandboxId: "sandbox-filtered",
      sandboxState: "running",
      runState: "calling_model",
      sessionLeafId: null,
    };
    const repository = {
      loadRun: vi.fn(async () => run),
      continuity: vi.fn(),
      latest: vi.fn(async () => null),
      inputFiles: vi.fn(),
      persistOutput: vi.fn(),
      persist: vi.fn(async () => ({ id: "snapshot-filtered", objectKey: "filtered.json", contentHash: "hash", sequence: 1 })),
      recordSandbox: vi.fn(),
    } satisfies SandboxSnapshotRepository;
    const objects = {
      put: vi.fn(async () => undefined),
      putArtifact: vi.fn(),
      get: vi.fn(),
      getSource: vi.fn(),
    } satisfies SandboxSnapshotObjectStore;
    const manager = new SandboxContinuityManager(provider, repository, objects, { image: "berry-sandbox" });

    await manager.snapshot({
      tenantId: run.tenantId,
      runId: run.runId,
      reason: "interval",
    });

    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(expect.objectContaining({ path: "/workspace/notes.md" }));
  });

  it("exposes an image read from a connector-created sandbox input path", async () => {
    const image = Buffer.from("connector-image");
    const provider = {
      kind: "e2b",
      files: {
        read: vi.fn(async (input: { path: string }) => ({
          path: input.path,
          content: image.toString("base64"),
          size_bytes: image.byteLength,
        })),
        write: vi.fn(),
        list: vi.fn(),
      },
    } as unknown as SandboxProvider;
    const repository = {
      loadRun: vi.fn(),
      continuity: vi.fn(),
      latest: vi.fn(),
      inputFiles: vi.fn(async () => []),
      persistOutput: vi.fn(),
      persist: vi.fn(),
      recordSandbox: vi.fn(),
    } satisfies SandboxSnapshotRepository;
    const manager = new SandboxContinuityManager(provider, repository, null, { image: "berry-sandbox" });
    const current = snapshot();
    current.sandboxId = "sandbox-connector-image";
    current.sandboxProvider = "e2b";
    current.steps = [{
      ...toolStep("read", { path: "/workspace/inputs/connector-download/brent.png" }),
      state: "completed",
      output: {
        path: "/workspace/inputs/connector-download/brent.png",
        binary: true,
        mediaType: "image/png",
        visionPath: "/workspace/inputs/connector-download/brent.png",
      },
    }];

    await expect(manager.modelContent(current)).resolves.toEqual([{
      type: "image_url",
      image_url: { url: `data:image/png;base64,${image.toString("base64")}` },
    }]);
    expect(provider.files.read).toHaveBeenCalledWith({
      sandbox_id: "sandbox-connector-image",
      path: "/workspace/inputs/connector-download/brent.png",
      encoding: "base64",
    });
  });

  it("loads inspect_images paths concurrently and preserves their explicit order", async () => {
    let activeReads = 0;
    let maxActiveReads = 0;
    const read = vi.fn(async (input: { path: string }) => {
      activeReads += 1;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      await Promise.resolve();
      activeReads -= 1;
      const bytes = Buffer.from(input.path.split("/").at(-1) ?? "");
      return { path: input.path, content: bytes.toString("base64"), size_bytes: bytes.byteLength, mtime: null };
    });
    const provider = {
      kind: "e2b",
      files: { read, write: vi.fn(), list: vi.fn(async () => ({ path: "/workspace", entries: [] })) },
    } as unknown as SandboxProvider;
    const repository = {
      loadRun: vi.fn(),
      continuity: vi.fn(),
      latest: vi.fn(),
      inputFiles: vi.fn(async () => []),
      persistOutput: vi.fn(),
      persist: vi.fn(),
      recordSandbox: vi.fn(),
    } satisfies SandboxSnapshotRepository;
    const manager = new SandboxContinuityManager(provider, repository, null, { image: "berry-sandbox" });
    const current = snapshot();
    current.sandboxId = "sandbox-ordered-images";
    current.sandboxProvider = "e2b";
    const paths = [
      "/workspace/rendered/page-03.png",
      "/workspace/rendered/page-01.png",
      "/workspace/rendered/page-02.png",
    ];
    current.steps = [{ ...toolStep("inspect_images", { mode: "focused", paths }), state: "running" }];

    const content = await manager.modelContent(current);

    expect(content).toEqual(paths.map((path) => ({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${Buffer.from(path.split("/").at(-1)!).toString("base64")}` },
    })));
    expect(maxActiveReads).toBe(3);
    expect(read.mock.calls.map(([input]) => input.path)).toEqual(paths);
  });

  it("backfills image slots after oversized attachment candidates are skipped", async () => {
    const inputFiles = Array.from({ length: 6 }, (_, index) => ({
      fileId: `image-${index + 1}`,
      name: `image-${index + 1}.png`,
      mediaType: "image/png",
      sizeBytes: index === 0 ? 20 * 1024 * 1024 + 1 : 1,
      objectKey: `objects/image-${index + 1}.png`,
    }));
    const provider = {
      kind: "e2b",
      files: { read: vi.fn(), write: vi.fn(), list: vi.fn() },
    } as unknown as SandboxProvider;
    const repository = {
      loadRun: vi.fn(),
      continuity: vi.fn(),
      latest: vi.fn(),
      inputFiles: vi.fn(async () => inputFiles),
      persistOutput: vi.fn(),
      persist: vi.fn(),
      recordSandbox: vi.fn(),
    } satisfies SandboxSnapshotRepository;
    const getSource = vi.fn(async (key: string) => new Uint8Array([
      Number(/image-(\d+)/.exec(key)?.[1] ?? 0),
    ]));
    const objects = {
      put: vi.fn(),
      putArtifact: vi.fn(),
      get: vi.fn(),
      getSource,
    } satisfies SandboxSnapshotObjectStore;
    const manager = new SandboxContinuityManager(provider, repository, objects, { image: "berry-sandbox" });
    const current = snapshot();
    current.steps = [];

    const content = await manager.modelContent(current);

    expect(content).toEqual([2, 3, 4, 5, 6].map((value) => ({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${Buffer.from([value]).toString("base64")}` },
    })));
    expect(getSource).toHaveBeenCalledTimes(5);
    expect(getSource).not.toHaveBeenCalledWith("objects/image-1.png", undefined);
  });

  it("does not let an older terminal cleanup pause a sandbox claimed by a follow-up run", async () => {
    const provider = {
      kind: "e2b",
      suspend: vi.fn(),
      destroy: vi.fn(),
      files: { list: vi.fn(), read: vi.fn(), write: vi.fn() },
    } as unknown as SandboxProvider;
    const repository = {
      loadRun: vi.fn(async () => ({
        tenantId: "00000000-0000-7000-8000-000000000002",
        runId: "00000000-0000-7000-8000-000000000001",
        sessionId: "00000000-0000-7000-8000-000000000004",
        taskId: "00000000-0000-7000-8000-000000000003",
        sandboxProvider: "e2b",
        sandboxId: "sandbox-shared-with-follow-up",
        sandboxState: "pause_requested",
        runState: "completed",
        sandboxClaimedByNewerRun: true,
        sessionLeafId: null,
      })),
      continuity: vi.fn(),
      latest: vi.fn(),
      inputFiles: vi.fn(),
      persistOutput: vi.fn(),
      persist: vi.fn(),
      recordSandbox: vi.fn(),
    } satisfies SandboxSnapshotRepository;
    const manager = new SandboxContinuityManager(provider, repository, null, { image: "berry-sandbox" });

    await expect(manager.snapshot({
      tenantId: "00000000-0000-7000-8000-000000000002",
      runId: "00000000-0000-7000-8000-000000000001",
      reason: "before-finalize",
    })).resolves.toEqual({ noOp: true });
    expect(provider.files.list).not.toHaveBeenCalled();
    expect(provider.suspend).not.toHaveBeenCalled();
  });

  it("destroys terminal compute when the provider cannot pause", async () => {
    const destroy = vi.fn(async () => ({
      sandbox_id: "sandbox-terminal",
      destroyed: true,
      status: "stopped" as const,
    }));
    const provider = {
      kind: "docker",
      supportsPause: false,
      suspend: vi.fn(),
      destroy,
      files: {
        list: vi.fn(async () => ({ path: "/workspace", entries: [] })),
        read: vi.fn(),
        write: vi.fn(),
      },
    } as unknown as SandboxProvider;
    const repository = {
      loadRun: vi.fn(async () => ({
        tenantId: "00000000-0000-7000-8000-000000000002",
        runId: "00000000-0000-7000-8000-000000000001",
        sessionId: "00000000-0000-7000-8000-000000000004",
        taskId: "00000000-0000-7000-8000-000000000003",
        sandboxProvider: "docker",
        sandboxId: "sandbox-terminal",
        sandboxState: "running",
        runState: "completed",
        sessionLeafId: null,
      })),
      continuity: vi.fn(async () => null),
      latest: vi.fn(async () => null),
      inputFiles: vi.fn(async () => []),
      persistOutput: vi.fn(),
      persist: vi.fn(async () => ({ id: "snapshot-1", objectKey: "snapshot.json", contentHash: "hash", sequence: 1 })),
      recordSandbox: vi.fn(async () => undefined),
    } satisfies SandboxSnapshotRepository;
    const objects = {
      put: vi.fn(async () => undefined),
      putArtifact: vi.fn(),
      get: vi.fn(),
      getSource: vi.fn(),
    } satisfies SandboxSnapshotObjectStore;
    const manager = new SandboxContinuityManager(provider, repository, objects, { image: "berry-sandbox" });

    await manager.snapshot({
      tenantId: "00000000-0000-7000-8000-000000000002",
      runId: "00000000-0000-7000-8000-000000000001",
      reason: "before-finalize",
    });

    expect(destroy).toHaveBeenCalledWith({
      sandbox_id: "sandbox-terminal",
      reason: "Terminal turn sandbox cleanup completed",
    });
    expect(provider.suspend).not.toHaveBeenCalled();
    expect(repository.recordSandbox).toHaveBeenCalledWith(expect.objectContaining({ state: "stopped" }));
  });

  it("executes every sandbox-backed durable tool contract", async () => {
    const files = {
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
    };
    const rawExec = async function* (input: { command: string[] }) {
      const isGrep = input.command[0] === "bash"
        && input.command[1] === "-c"
        && input.command[2]?.includes("--json");
      if (isGrep) {
        yield { kind: "stdout", data: "file.txt:1:needle" };
        yield {
          kind: "stderr",
          data: "__BERRY_PI_GREP_META__{\"matchCount\":1,\"limitReached\":false,\"byteLimitReached\":false,\"linesTruncated\":false}\n",
        };
      } else {
        yield { kind: "stdout", data: "command output" };
      }
      yield { kind: "exit", exit_code: 0, signal: null };
    };
    const provider = {
      kind: "e2b",
      create: vi.fn(async () => ({
        sandbox_id: "sandbox-contract",
        provider: "e2b",
        status: "running",
      })),
      exec: piReadAwareExec(files, rawExec),
      files,
    } as unknown as SandboxProvider;
    const repository = {
      loadRun: vi.fn(),
      continuity: vi.fn(async () => null),
      latest: vi.fn(async () => null),
      inputFiles: vi.fn(async () => []),
      persistOutput: vi.fn(),
      persist: vi.fn(),
      recordSandbox: vi.fn(async (_input: {
        tenantId: string;
        runId: string;
        provider: string;
        sandboxId: string;
        state: string;
      }) => undefined),
    } satisfies SandboxSnapshotRepository;
    const manager = new SandboxContinuityManager(provider, repository, null, {
      image: "berry-sandbox",
    });

    await expect(manager.execute(snapshot(), toolStep("read", {
      path: "/workspace/file.txt",
    }))).resolves.toMatchObject({
      output: { path: "/workspace/file.txt", content: "file contents" },
    });
    await expect(manager.execute(snapshot(), toolStep("write", {
      path: "/workspace/pi-result.txt",
      content: "done",
    }))).resolves.toMatchObject({
      output: { path: "/workspace/pi-result.txt", sizeBytes: 4 },
    });
    await expect(manager.execute(snapshot(), toolStep("edit", {
      path: "/workspace/file.txt",
      edits: [
        { oldText: "file", newText: "updated" },
        { oldText: "contents", newText: "body" },
      ],
    }))).resolves.toMatchObject({
      output: { path: "/workspace/file.txt", replacements: 2 },
    });
    await expect(manager.execute(snapshot(), toolStep("find", {
      path: "/workspace",
      pattern: "**/*.ts",
    }))).resolves.toMatchObject({
      output: { path: "/workspace", pattern: "**/*.ts", content: "command output" },
    });
    await expect(manager.execute(snapshot(), toolStep("ls", {
      path: "/workspace",
    }))).resolves.toMatchObject({
      output: { path: "/workspace", content: "file.txt" },
    });
    await expect(manager.execute(snapshot(), toolStep("grep", {
      path: "/workspace",
      pattern: "needle",
    }))).resolves.toMatchObject({
      output: { path: "/workspace", pattern: "needle", matches: "file.txt:1:needle", matchCount: 1 },
    });
    await expect(manager.execute(snapshot(), toolStep("bash", {
      command: "printf done",
    }))).resolves.toMatchObject({
      output: { command: "printf done", exitCode: 0, output: "command output" },
    });
    expect(files.write).toHaveBeenCalledWith(expect.objectContaining({
      path: "/workspace/file.txt",
      content: "updated body",
    }));
  });

  it("rejects malformed raw tool wrappers with an actionable error", async () => {
    const read = vi.fn();
    const write = vi.fn();
    const manager = managerWithProvider({ read, write, list: vi.fn() });

    await expect(manager.execute(snapshot(), toolStep("bash", {
      raw: "{\"command\":\"printf done\"",
    }))).rejects.toThrow("arguments were incomplete or invalid JSON");
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("repairs recognized provider argument damage only after direct validation fails", async () => {
    const read = vi.fn(async (input: { path: string }) => ({
      path: input.path,
      content: "\uFEFFfirst\r\nsecond\r\n",
      size_bytes: 17,
    }));
    const write = vi.fn(async (input: { path: string; content: string }) => ({
      path: input.path,
      size_bytes: Buffer.byteLength(input.content),
      mtime: null,
    }));
    const manager = managerWithProvider({ read, write, list: vi.fn() });

    await expect(manager.execute(snapshot(), toolStep("read", {
      raw: JSON.stringify({
        file_path: "/workspace/[notes.md](http://notes.md)",
        offset: "1",
        limit: null,
      }),
    }))).resolves.toMatchObject({
      output: {
        path: "/workspace/notes.md",
        content: "first\nsecond",
        inputRepairs: expect.arrayContaining([
          "parsed the raw JSON wrapper after direct validation failed",
          "renamed file_path to path",
          "converted numeric string offset",
          "removed null optional field limit",
          "unwrapped a markdown-autolinked path",
        ]),
      },
    });
    expect(read).toHaveBeenCalledWith(expect.objectContaining({ path: "/workspace/notes.md" }));

    const jsonLikeContent = '{"raw":"this is file content, not tool arguments"}';
    await manager.execute(snapshot(), toolStep("write", {
      path: "/workspace/result.json",
      content: jsonLikeContent,
    }));
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ content: jsonLikeContent }));
  });

  it("repairs stringified single-edit arrays without weakening the advertised schema", async () => {
    const read = vi.fn(async (input: { path: string }) => ({
      path: input.path,
      content: "before",
      size_bytes: 6,
    }));
    const write = vi.fn(async (input: { path: string; content: string }) => ({
      path: input.path,
      size_bytes: Buffer.byteLength(input.content),
      mtime: null,
    }));
    const manager = managerWithProvider({ read, write, list: vi.fn() });

    await expect(manager.execute(snapshot(), toolStep("edit", {
      path: "/workspace/result.txt",
      edits: JSON.stringify({ oldText: "before", newText: "after" }),
    }))).resolves.toMatchObject({
      output: {
        replacements: 1,
        inputRepairs: ["parsed stringified edits JSON", "wrapped one edit object as an edits array"],
      },
    });
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ content: "after" }));
  });

  it("rejects fractional and partially numeric limits instead of flooring them", async () => {
    const read = vi.fn();
    const manager = managerWithProvider({ read, write: vi.fn(), list: vi.fn() });

    await expect(manager.execute(snapshot(), toolStep("read", {
      path: "/workspace/result.txt",
      offset: 1.5,
    }))).rejects.toThrow("read offset must be an integer");
    await expect(manager.execute(snapshot(), toolStep("grep", {
      pattern: "needle",
      limit: "2abc",
    }))).rejects.toThrow("grep limit must be an integer");
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    ["read", {}],
    ["write", { content: "contents" }],
    ["edit", { edits: [{ oldText: "before", newText: "after" }] }],
  ])("rejects %s before a missing path can resolve to the workspace directory", async (toolName, args) => {
    const read = vi.fn();
    const write = vi.fn();
    const manager = managerWithProvider({ read, write, list: vi.fn() });

    await expect(manager.execute(snapshot(), toolStep(toolName, args)))
      .rejects.toThrow(`${toolName} requires a non-empty path`);
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("writes complete large content in one call", async () => {
    const content = "x".repeat(8_911);
    const write = vi.fn(async (input: { path: string; content: string }) => ({
      path: input.path,
      size_bytes: Buffer.byteLength(input.content),
      mtime: null,
    }));
    const manager = managerWithProvider({ read: vi.fn(), write, list: vi.fn() });

    await expect(manager.execute(snapshot(), toolStep("write", {
      path: "/workspace/result.json",
      content,
    }))).resolves.toMatchObject({
      output: { path: "/workspace/result.json", sizeBytes: 8_911 },
    });
    expect(write).toHaveBeenCalledWith(expect.objectContaining({
      path: "/workspace/result.json",
      content,
    }));
  });

  it("accepts large exact replacements", async () => {
    const replacement = "x".repeat(8_911);
    const read = vi.fn(async (input: { path: string }) => ({
      path: input.path,
      content: "before",
      size_bytes: 6,
    }));
    const write = vi.fn(async (input: { path: string; content: string }) => ({
      path: input.path,
      size_bytes: Buffer.byteLength(input.content),
      mtime: null,
    }));
    const manager = managerWithProvider({ read, write, list: vi.fn() });

    await expect(manager.execute(snapshot(), toolStep("edit", {
      path: "/workspace/result.txt",
      edits: [{ oldText: "before", newText: replacement }],
    }))).resolves.toMatchObject({
      output: { path: "/workspace/result.txt", sizeBytes: 8_911, replacements: 1 },
    });
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ content: replacement }));
  });

  it("applies Pi edit entries against the original file and rejects overlaps", async () => {
    const read = vi.fn(async (input: { path: string }) => ({
      path: input.path,
      content: "alpha middle omega",
      size_bytes: 18,
    }));
    const write = vi.fn(async (input: { path: string; content: string }) => ({
      path: input.path,
      size_bytes: Buffer.byteLength(input.content),
      mtime: null,
    }));
    const manager = managerWithProvider({ read, write, list: vi.fn() });

    await expect(manager.execute(snapshot(), toolStep("edit", {
      path: "/workspace/result.txt",
      edits: [
        { oldText: "alpha", newText: "first" },
        { oldText: "omega", newText: "last" },
      ],
    }))).resolves.toMatchObject({ output: { replacements: 2 } });
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ content: "first middle last" }));

    await expect(manager.execute(snapshot(), toolStep("edit", {
      path: "/workspace/result.txt",
      edits: [
        { oldText: "alpha middle", newText: "first" },
        { oldText: "middle omega", newText: "last" },
      ],
    }))).rejects.toThrow("overlap");
  });

  it("honors Pi read offsets and reports the next offset", async () => {
    const content = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n");
    const manager = managerWithProvider({
      read: vi.fn(async (input: { path: string }) => ({
        path: input.path,
        content,
        size_bytes: Buffer.byteLength(content),
      })),
      write: vi.fn(),
      list: vi.fn(),
    });

    await expect(manager.execute(snapshot(), toolStep("read", {
      path: "/workspace/result.txt",
      offset: 3,
      limit: 2,
    }))).resolves.toMatchObject({
      output: { content: "line 3\nline 4\n\n[6 more lines in file. Use offset=5 to continue.]" },
    });
  });

  it("returns explicit empty and EOF states and clamps pathological lines", async () => {
    const contents: Record<string, string> = {
      "/workspace/empty.txt": "",
      "/workspace/short.txt": "one\ntwo",
      "/workspace/long.txt": "x".repeat(2_100),
    };
    const manager = managerWithProvider({
      read: vi.fn(async (input: { path: string }) => ({
        path: input.path,
        content: contents[input.path] ?? "",
        size_bytes: Buffer.byteLength(contents[input.path] ?? ""),
      })),
      write: vi.fn(),
      list: vi.fn(),
    });

    await expect(manager.execute(snapshot(), toolStep("read", {
      path: "/workspace/empty.txt",
    }))).resolves.toMatchObject({
      output: { content: "[File is empty.]", empty: true, totalLines: 0 },
    });
    await expect(manager.execute(snapshot(), toolStep("read", {
      path: "/workspace/short.txt",
      offset: 9,
    }))).resolves.toMatchObject({
      output: {
        content: "[Offset 9 is beyond end of file (2 lines total). Retry with offset=2 or smaller.]",
        eof: true,
      },
    });
    const longLine = await manager.execute(snapshot(), toolStep("read", {
      path: "/workspace/long.txt",
    }));
    expect(longLine.output).toMatchObject({ truncated: true, linesTruncated: true });
    const firstLine = (longLine.output as { content: string }).content.split("\n")[0]!;
    expect(Array.from(firstLine)).toHaveLength(2_000);
  });

  it("reduces a multi-megabyte line inside the sandbox read helper", () => {
    const result = spawnSync(process.execPath, [
      "-e",
      PI_READ_STREAM_SCRIPT,
      "/dev/stdin",
      "1",
      "0",
      "2000",
      String(50 * 1024),
      "2000",
    ], {
      input: "x".repeat(2 * 1024 * 1024),
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });

    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as { content: string; details: Record<string, unknown> };
    expect(output.details).toMatchObject({ truncated: true, linesTruncated: true });
    expect(Array.from(output.content.split("\n")[0]!)).toHaveLength(2_000);
    expect(Buffer.byteLength(result.stdout)).toBeLessThan(10 * 1024);
  });

  it("parses a grep JSON record larger than one megabyte before bounding its rendered line", () => {
    const event = JSON.stringify({
      type: "match",
      data: {
        path: { text: "/workspace/large.txt" },
        lines: { text: `needle${"x".repeat(1_100_000)}\n` },
        line_number: 7,
      },
    });
    const result = spawnSync(process.execPath, [
      "-e",
      PI_GREP_FILTER_SCRIPT,
      "/workspace",
      "100",
      String(50 * 1024),
      "500",
    ], {
      input: `${event}\n`,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("large.txt:7:needle");
    expect(result.stdout).toContain("... [truncated]");
    expect(Buffer.byteLength(result.stdout)).toBeLessThan(1024);
    expect(result.stderr).toContain("\"matchCount\":1");
    expect(result.stderr).toContain("\"linesTruncated\":true");
  });

  it("keeps only the tail of large bash output while tee saves the full output inside the sandbox", async () => {
    const fullOutput = Array.from({ length: 2_100 }, (_, index) => `line ${index + 1}`).join("\n");
    const write = vi.fn(async (input: { path: string; content: string }) => ({
      path: input.path,
      size_bytes: Buffer.byteLength(input.content),
      mtime: null,
    }));
    const exec = vi.fn(async function* (input: { command: string[] }) {
      expect(input.command[2]).toContain("tee --");
      yield { kind: "stdout", data: fullOutput };
      yield { kind: "exit", exit_code: 0, signal: null };
    });
    const manager = managerWithProvider(
      { read: vi.fn(), write, list: vi.fn() },
      exec,
    );

    await expect(manager.execute(snapshot(), toolStep("bash", {
      command: "generate-output",
    }))).resolves.toMatchObject({
      output: {
        output: expect.stringContaining("[Showing lines 101-2100 of 2100."),
        fullOutputPath: expect.stringMatching(/^\/workspace\/\.berry-tool-output\/bash-/),
        truncated: true,
      },
    });
    expect(write).not.toHaveBeenCalled();
  });

  it("preserves command and tee exit statuses in the bash wrapper", () => {
    const success = spawnSync("bash", [
      "-c",
      PI_BASH_WRAPPER_SCRIPT,
      "berry-bash",
      "printf success",
      "/dev/null",
    ], { encoding: "utf8" });
    expect(success.status, success.stderr).toBe(0);
    expect(success.stdout).toBe("success");

    const failure = spawnSync("bash", [
      "-c",
      PI_BASH_WRAPPER_SCRIPT,
      "berry-bash",
      "printf failure; exit 7",
      "/dev/null",
    ], { encoding: "utf8" });
    expect(failure.status, failure.stderr).toBe(7);
    expect(failure.stdout).toBe("failure");
  });

  it("preserves line boundaries when the rolling bash tail spans chunks", async () => {
    const firstChunk = `${Array.from({ length: 2_001 }, (_, index) => `line ${index + 1}`).join("\n")}\n`;
    const manager = managerWithProvider(
      { read: vi.fn(), write: vi.fn(), list: vi.fn() },
      async function* () {
        yield { kind: "stdout", data: firstChunk };
        yield { kind: "stdout", data: "line 2002\n" };
        yield { kind: "exit", exit_code: 0, signal: null };
      },
    );

    const result = await manager.execute(snapshot(), toolStep("bash", { command: "generate-chunked-output" }));
    const output = (result.output as { output: string }).output;
    expect(output).toContain("line 2001\nline 2002\n");
    expect(output).not.toContain("line 2001line 2002");
    expect(output).toContain("[Showing lines 3-2002 of 2002.");
  });

  it("bounds a single oversized bash chunk while preserving its tail", async () => {
    const fullOutput = `START-${"x".repeat(2 * 1024 * 1024)}-END`;
    const manager = managerWithProvider(
      { read: vi.fn(), write: vi.fn(), list: vi.fn() },
      async function* () {
        yield { kind: "stdout", data: fullOutput };
        yield { kind: "exit", exit_code: 0, signal: null };
      },
    );

    const result = await manager.execute(snapshot(), toolStep("bash", { command: "generate-one-line" }));
    const output = result.output as { output: string; truncated: boolean };
    expect(output.truncated).toBe(true);
    expect(output.output).not.toContain("START-");
    expect(output.output).toContain("-END");
    expect(Buffer.byteLength(output.output)).toBeLessThan(55 * 1024);
  });

  it("counts grep matches rather than context output lines", async () => {
    const read = vi.fn();
    const manager = managerWithProvider({
      read,
      write: vi.fn(),
      list: vi.fn(),
    }, async function* (input: { command: string[]; timeout_ms: number }) {
      expect(input.command[0]).toBe("bash");
      expect(input.command[2]).toContain("--json");
      expect(input.timeout_ms).toBe(0);
      yield { kind: "stdout", data: "source.ts-1-one\nsource.ts:2:needle first\nsource.ts-3-three\nsource.ts:4:needle second\nsource.ts-5-five" };
      yield {
        kind: "stderr",
        data: "__BERRY_PI_GREP_META__{\"matchCount\":2,\"limitReached\":true,\"byteLimitReached\":false,\"linesTruncated\":false}\n",
      };
      yield { kind: "exit", exit_code: 0, signal: null };
    });

    await expect(manager.execute(snapshot(), toolStep("grep", {
      path: "/workspace",
      pattern: "needle",
      context: 1,
      limit: 2,
    }))).resolves.toMatchObject({
      output: {
        matchCount: 2,
        matches: expect.stringContaining("source.ts:4:needle second"),
        truncated: true,
      },
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("treats ripgrep's no-match status as a successful empty find", async () => {
    const exec = vi.fn(async function* (input: { command: string[] }) {
      expect(input.command[0]).toBe("sh");
      expect(input.command[2]).toContain('[ "$status" -eq 0 ] || [ "$status" -eq 1 ]');
      yield { kind: "exit", exit_code: 0, signal: null };
    });
    const manager = managerWithProvider(
      { read: vi.fn(), write: vi.fn(), list: vi.fn() },
      exec,
    );

    await expect(manager.execute(snapshot(), toolStep("find", {
      path: "/workspace",
      pattern: "**/__definitely_missing__.*",
    }))).resolves.toMatchObject({
      output: { content: "No files found matching pattern" },
    });
  });

  it("gives bash no command timeout unless the caller requests one", async () => {
    const exec = vi.fn(async function* (_input: { timeout_ms: number }) {
      yield { kind: "exit", exit_code: 0, signal: null };
    });
    const manager = managerWithProvider(
      { read: vi.fn(), write: vi.fn(), list: vi.fn() },
      exec,
    );

    await manager.execute(snapshot(), toolStep("bash", { command: "printf default" }));
    await manager.execute(snapshot(), toolStep("bash", { command: "printf explicit", timeout: 12.5 }));
    expect(exec.mock.calls[0]?.[0]).toMatchObject({ timeout_ms: 0 });
    expect(exec.mock.calls[1]?.[0]).toMatchObject({ timeout_ms: 12_500 });
  });

  it("requires edit newText while permitting an intentional empty replacement", async () => {
    const read = vi.fn(async (input: { path: string }) => ({
      path: input.path,
      content: "remove me",
      size_bytes: 9,
    }));
    const write = vi.fn(async (input: { path: string; content: string }) => ({
      path: input.path,
      size_bytes: Buffer.byteLength(input.content),
      mtime: null,
    }));
    const manager = managerWithProvider({ read, write, list: vi.fn() });

    await expect(manager.execute(snapshot(), toolStep("edit", {
      path: "/workspace/result.txt",
      edits: [{ oldText: "remove me" }],
    }))).rejects.toThrow("edit requires a string edits[0].newText");
    await expect(manager.execute(snapshot(), toolStep("edit", {
      path: "/workspace/result.txt",
      edits: [{ oldText: "remove me", newText: "" }],
    }))).resolves.toMatchObject({ output: { replacements: 1, sizeBytes: 0 } });
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

    await expect(manager.execute(snapshot(), toolStep("read", {
      path: "/managed-skills/aesg-branding/references/brand-system.md",
    }))).resolves.toMatchObject({
      output: {
        path: "/managed-skills/aesg-branding/references/brand-system.md",
        content: "# Brand system",
      },
    });
    await expect(manager.execute(snapshot(), toolStep("ls", {
      path: "/managed-skills/aesg-branding/references",
    }))).resolves.toMatchObject({
      output: { path: "/managed-skills/aesg-branding/references" },
    });
    await expect(manager.execute(snapshot(), toolStep("write", {
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

    await expect(manager.execute(snapshot(), toolStep("read", {
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

  it("applies Pi read pagination to extracted PDF text", async () => {
    const manager = managerWithProvider({
      read: vi.fn(),
      write: vi.fn(),
      list: vi.fn(),
    }, async function* () {
      yield { kind: "stdout", data: Array.from({ length: 10 }, (_, index) => `page line ${index + 1}`).join("\n") };
      yield { kind: "exit", exit_code: 0, signal: null };
    });

    await expect(manager.execute(snapshot(), toolStep("read", {
      path: "/workspace/inputs/file-id/reference.pdf",
      offset: 3,
      limit: 2,
    }))).resolves.toMatchObject({
      output: {
        content: "page line 3\npage line 4\n\n[6 more lines in file. Use offset=5 to continue.]",
        mediaType: "application/pdf",
        extractedText: true,
      },
    });
  });

  it("returns binary metadata instead of sending image bytes through the UTF-8 reader", async () => {
    const read = vi.fn();
    const manager = managerWithProvider({
      read,
      write: vi.fn(),
      list: vi.fn(),
    });

    await expect(manager.execute(snapshot(), toolStep("read", {
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
      exec: async function* () {
        yield { kind: "exit", exit_code: 0, signal: null };
      },
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
          objectVersionId: "reference-version-7",
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
      getSource: vi.fn(async (key: string) => key.endsWith("brief.pdf") ? new Uint8Array(5) : attached),
    } satisfies SandboxSnapshotObjectStore;
    const manager = new SandboxContinuityManager(provider, repository, objects, {
      image: "berry-sandbox",
    });
    const current = snapshot();
    current.sandboxId = "sandbox-existing";
    current.sandboxProvider = "e2b";
    current.steps = [{
      ...toolStep("read", { path: "/workspace/outputs/chart.png" }),
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
    // The existing sandbox is re-staged after a worker handoff, then the image
    // is read once more for model vision content.
    expect(objects.getSource).toHaveBeenCalledTimes(3);
    expect(objects.getSource).toHaveBeenCalledWith(
      "artifacts/tenants/t/reference.png",
      "reference-version-7",
    );
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

  it("automatically publishes unpersisted files from the output directory", async () => {
    const bytes = Buffer.from("automatic artifact");
    const provider = {
      kind: "e2b",
      create: vi.fn(),
      exec: vi.fn(),
      files: {
        read: vi.fn(async (input: { path: string }) => ({
          path: input.path,
          content: bytes.toString("base64"),
          size_bytes: bytes.byteLength,
          mtime: null,
        })),
        write: vi.fn(),
        list: vi.fn(async () => ({
          path: "/workspace/outputs",
          entries: [
            {
              path: "/workspace/outputs/first/summary.txt",
              type: "file",
              size_bytes: bytes.byteLength,
              mtime: null,
            },
            {
              path: "/workspace/outputs/second/summary.txt",
              type: "file",
              size_bytes: bytes.byteLength,
              mtime: null,
            },
          ],
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
      putArtifact: vi.fn(async (key: string) => ({ bucket: "berry", key, etag: "etag" })),
      get: vi.fn(),
      getSource: vi.fn(),
    } satisfies SandboxSnapshotObjectStore;
    const manager = new SandboxContinuityManager(provider, repository, objects, { image: "berry-sandbox" });
    const current = snapshot();
    current.sandboxId = "sandbox-artifact";
    current.sandboxProvider = "e2b";
    current.sandboxState = "running";
    current.steps = [];

    await expect(manager.finalize(current)).resolves.toEqual([
      expect.objectContaining({
        output: expect.objectContaining({
          artifact: expect.objectContaining({ name: "summary.txt", mediaType: "text/plain" }),
        }),
      }),
      expect.objectContaining({
        output: expect.objectContaining({
          artifact: expect.objectContaining({ name: "summary.txt", mediaType: "text/plain" }),
        }),
      }),
    ]);
    expect(objects.putArtifact).toHaveBeenCalledTimes(2);
    const objectKeys = objects.putArtifact.mock.calls.map(([key]) => key);
    expect(new Set(objectKeys).size).toBe(2);
    expect(objectKeys).toEqual([
      expect.stringContaining("/auto/"),
      expect.stringContaining("/auto/"),
    ]);
    expect(repository.persistOutput).toHaveBeenCalledWith(expect.objectContaining({
      sourcePath: "/workspace/outputs/first/summary.txt",
    }));
    expect(repository.persistOutput).toHaveBeenCalledWith(expect.objectContaining({
      sourcePath: "/workspace/outputs/second/summary.txt",
    }));
  });

  it("does not republish an unchanged output from an earlier turn", async () => {
    const bytes = Buffer.from("already published");
    const sourcePath = "/workspace/outputs/portrait.png";
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const provider = {
      kind: "e2b",
      create: vi.fn(),
      exec: vi.fn(),
      files: {
        read: vi.fn(async () => ({
          path: sourcePath,
          content: bytes.toString("base64"),
          size_bytes: bytes.byteLength,
          mtime: null,
        })),
        write: vi.fn(),
        list: vi.fn(async () => ({
          path: "/workspace/outputs",
          entries: [{ path: sourcePath, type: "file", size_bytes: bytes.byteLength, mtime: null }],
        })),
      },
    } as unknown as SandboxProvider;
    const repository = {
      loadRun: vi.fn(),
      continuity: vi.fn(async () => null),
      latest: vi.fn(async () => null),
      inputFiles: vi.fn(async () => []),
      publishedOutputs: vi.fn(async () => [{ sourcePath, sha256 }]),
      persistOutput: vi.fn(),
      persist: vi.fn(),
      recordSandbox: vi.fn(async () => undefined),
    } satisfies SandboxSnapshotRepository;
    const objects = {
      put: vi.fn(),
      putArtifact: vi.fn(),
      get: vi.fn(),
      getSource: vi.fn(),
    } satisfies SandboxSnapshotObjectStore;
    const manager = new SandboxContinuityManager(provider, repository, objects, { image: "berry-sandbox" });
    const current = snapshot();
    current.sandboxId = "sandbox-artifact";
    current.sandboxProvider = "e2b";
    current.sandboxState = "running";
    current.steps = [];

    await expect(manager.finalize(current)).resolves.toEqual([]);
    expect(repository.publishedOutputs).toHaveBeenCalledWith(current.tenantId, current.sessionId);
    expect(objects.putArtifact).not.toHaveBeenCalled();
    expect(repository.persistOutput).not.toHaveBeenCalled();
  });

  it("generates, stages, and registers an admitted durable image", async () => {
    const bytes = Buffer.from([137, 80, 78, 71]);
    const provider = {
      kind: "e2b",
      create: vi.fn(async () => ({
        sandbox_id: "sandbox-image",
        provider: "e2b",
        status: "running",
      })),
      exec: vi.fn(),
      files: {
        read: vi.fn(),
        write: vi.fn(async (input: { path: string; content: string }) => ({
          path: input.path,
          size_bytes: Buffer.from(input.content, "base64").byteLength,
          mtime: null,
        })),
        list: vi.fn(async (input: { path: string }) => ({ path: input.path, entries: [] })),
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
      putArtifact: vi.fn(async (key: string) => ({ bucket: "berry", key, etag: "etag" })),
      get: vi.fn(),
      getSource: vi.fn(),
    } satisfies SandboxSnapshotObjectStore;
    const manager = new SandboxContinuityManager(provider, repository, objects, {
      image: "berry-sandbox",
      imageGeneration: {
        endpoint: "https://images.example.test/v1/images/generations",
        editsEndpoint: "https://images.example.test/v1/images/edits",
        apiKey: "test-key",
        model: "gpt-image-1",
        responseFormat: "b64_json",
      },
    });
    const current = snapshot();
    current.runtimeRequest = { imageGeneration: { version: 1, model: "gpt-image-1" } };
    const originalFetch = globalThis.fetch;
    const imageFetch = vi.fn(async () => new Response(JSON.stringify({
      model: "gpt-image-1",
      data: [{ b64_json: bytes.toString("base64"), revised_prompt: "A revised prompt" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    globalThis.fetch = imageFetch;
    const imageStep = {
      ...toolStep("create_image", {
        prompt: "A berry icon",
        title: "Berry icon",
        aspect_ratio: "16:9",
      }),
      retryClass: "non_idempotent_manual" as const,
      idempotencyKey: "durable-image-step-key",
    };

    try {
      await expect(manager.execute(current, imageStep)).resolves.toMatchObject({
        output: {
          image: {
            fileId: "00000000-0000-7000-8000-000000000010",
            title: "Berry icon",
            width: 1536,
            height: 1024,
            revisedPrompt: "A revised prompt",
          },
          visionPath: "/workspace/outputs/Berry icon.png",
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(globalThis.fetch).toBe(originalFetch);
    expect(imageFetch).toHaveBeenCalledWith(
      "https://images.example.test/v1/images/generations",
      expect.objectContaining({
        headers: expect.objectContaining({ "Idempotency-Key": "durable-image-step-key" }),
      }),
    );
    expect(provider.files.write).toHaveBeenCalledWith(expect.objectContaining({
      path: "/workspace/outputs/Berry icon.png",
      content: bytes.toString("base64"),
      encoding: "base64",
    }));
    expect(objects.putArtifact).toHaveBeenCalledWith(
      expect.stringContaining("/original/Berry icon.png"),
      bytes,
      "image/png",
    );
    expect(repository.persistOutput).toHaveBeenCalledWith(expect.objectContaining({
      origin: "image_generation",
      sourcePath: "/workspace/outputs/Berry icon.png",
    }));
  });

  it("stages message-associated input files before the first tool runs", async () => {
    const staged = new Map<string, Uint8Array[]>();
    const execInputs: Array<{ command: string[]; stdin?: string; cwd?: string }> = [];
    const provider = {
      kind: "e2b",
      create: vi.fn(async () => ({
        sandbox_id: "sandbox-1",
        provider: "e2b",
        status: "running",
      })),
      exec: async function* (input: { command: string[]; stdin?: string; cwd?: string }) {
        execInputs.push(input);
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
      cwd: "/home/user/workspace",
    });

    const result = await manager.execute(snapshot(), toolStep("ls", {
      path: "/home/user/workspace",
    }));

    expect(objects.streamSource).toHaveBeenCalledWith(
      "artifacts/tenants/t/files/candidate.pdf",
      350 * 1024 * 1024,
      undefined,
    );
    const path = "/home/user/workspace/inputs/00000000-0000-7000-8000-000000000099/candidate.pdf";
    expect(execInputs[0]).toMatchObject({
      command: ["mkdir", "-p", "/home/user/workspace/inputs/00000000-0000-7000-8000-000000000099"],
      cwd: "/home/user/workspace",
    });
    const stagedBytes = Buffer.concat(staged.get(path)!.map((chunk) => Buffer.from(chunk)));
    expect(stagedBytes).toHaveLength((256 * 1024) + 2);
    expect(stagedBytes.subarray(-2)).toEqual(Buffer.from([2, 3]));
    expect(result.output).toMatchObject({ content: "candidate.pdf" });
  });

  it("preserves sandbox stderr when attachment directory preparation fails", async () => {
    const provider = {
      kind: "e2b",
      create: vi.fn(async () => ({ sandbox_id: "sandbox-1", provider: "e2b", status: "running" })),
      exec: async function* () {
        yield { kind: "stderr", data: "mkdir: cannot create directory: Permission denied\n" };
        yield { kind: "exit", exit_code: 1, signal: null };
      },
      files: { read: vi.fn(), write: vi.fn(), list: vi.fn() },
    } as unknown as SandboxProvider;
    const repository = {
      loadRun: vi.fn(),
      continuity: vi.fn(async () => null),
      latest: vi.fn(async () => null),
      inputFiles: vi.fn(async () => [{
        fileId: "00000000-0000-7000-8000-000000000099",
        name: "Pasted text.txt",
        mediaType: "text/plain",
        sizeBytes: 4,
        objectKey: "artifacts/pasted.txt",
      }]),
      persistOutput: vi.fn(),
      persist: vi.fn(),
      recordSandbox: vi.fn(),
    } satisfies SandboxSnapshotRepository;
    const objects = {
      put: vi.fn(),
      putArtifact: vi.fn(),
      get: vi.fn(),
      getSource: vi.fn(async () => new Uint8Array([1, 2, 3, 4])),
    } satisfies SandboxSnapshotObjectStore;
    const manager = new SandboxContinuityManager(provider, repository, objects, {
      image: "berry-sandbox",
      cwd: "/home/user/workspace",
    });

    await expect(manager.execute(snapshot(), toolStep("ls", {
      path: "/home/user/workspace",
    }))).rejects.toThrow(
      "Unable to prepare the sandbox directory for Pasted text.txt: mkdir: cannot create directory: Permission denied",
    );
  });

  it("reuses the previous live sandbox for a follow-up turn in the same session", async () => {
    const provider = {
      kind: "e2b",
      create: vi.fn(),
      resume: vi.fn(async () => ({ sandbox_id: "sandbox-from-previous-turn" })),
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
      recordSandbox: vi.fn(async (_input: {
        tenantId: string;
        runId: string;
        provider: string;
        sandboxId: string;
        state: string;
      }) => undefined),
    } satisfies SandboxSnapshotRepository;
    const manager = new SandboxContinuityManager(provider, repository, null, {
      image: "berry-sandbox",
    });

    await manager.execute(snapshot(), lsStep());

    expect(provider.create).not.toHaveBeenCalled();
    expect(provider.resume).toHaveBeenCalledWith({
      sandbox_id: "sandbox-from-previous-turn",
      reason: "Follow-up turn requested the prior sandbox",
    });
    expect(repository.recordSandbox.mock.calls.map(([input]) => input.state)).toEqual([
      "resume_requested",
      "running",
    ]);
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
    const versions: Array<string | undefined> = [];
    const client = {
      send: vi.fn(async (command: { input?: { Key?: string; VersionId?: string } }) => {
        keys.push(command.input?.Key ?? "");
        versions.push(command.input?.VersionId);
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
    await expect(store.getSource("artifacts/tenants/tenant/files/input.pdf", "version-7")).resolves.toEqual(new Uint8Array([1, 2]));

    expect(keys).toEqual([
      "artifacts/sandbox-snapshots/tenant/run/hash.json",
      "artifacts/sandbox-snapshots/tenant/run/hash.json",
      "artifacts/tenants/tenant/files/input.pdf",
    ]);
    expect(versions).toEqual([undefined, undefined, "version-7"]);
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
    expect(query).toContain("a.turn_id=r.id::text");
    expect(query).toContain("f.origin IN ('sandbox_output','image_generation','browser_capture','legacy_artifact','connector_import')");
    expect(query).toContain("f.origin='connector_import' AND f.status='processing'");
  });

  it("loads previously published output paths and hashes for session deduplication", async () => {
    let query = "";
    const repository = new SqlSandboxSnapshotRepository({
      query: vi.fn(async (sql: string) => {
        query = sql;
        return [{ source_path: "/workspace/outputs/report.pdf", sha256: "abc123" }];
      }),
      execute: vi.fn(),
    } as never);

    await expect(repository.publishedOutputs(
      "00000000-0000-7000-8000-000000000002",
      "00000000-0000-7000-8000-000000000004",
    )).resolves.toEqual([{ sourcePath: "/workspace/outputs/report.pdf", sha256: "abc123" }]);
    expect(query).toContain("a.session_id=$2::uuid");
    expect(query).toContain("f.metadata->>'sourcePath'");
    expect(query).toContain("COALESCE(blob.sha256, f.sha256) IS NOT NULL");
  });

  it("fails closed when a stable sandbox object key belongs to another user", async () => {
    const execute = vi.fn(async () => undefined);
    const query: SqlExecutor["query"] = async <T>(sql: string) => sql.includes("COALESCE(blob.sha256, f.sha256)")
      ? [{
          id: "00000000-0000-7000-8000-000000000020",
          owner_user_id: "00000000-0000-7000-8000-000000000021",
          object_key: "artifacts/tenants/00000000-0000-7000-8000-000000000002/users/00000000-0000-7000-8000-000000000006/files/00000000-0000-7000-8000-000000000020/digest/original/shared-output.png",
          sha256: "digest",
        }] as T[]
      : [] as T[];
    const executor: SqlExecutor = {
      execute,
      query,
    };
    executor.transaction = async <T>(callback: (transaction: SqlExecutor) => Promise<T>) => callback(executor);
    const repository = new SqlSandboxSnapshotRepository(executor);

    await expect(repository.persistOutput({
      snapshot: snapshot(),
      fileId: "00000000-0000-7000-8000-000000000020",
      name: "shared-output.png",
      mediaType: "image/png",
      sizeBytes: 4,
      sha256: "digest",
      bucket: "berry",
      objectKey: "artifacts/tenants/00000000-0000-7000-8000-000000000002/users/00000000-0000-7000-8000-000000000006/files/00000000-0000-7000-8000-000000000020/digest/original/shared-output.png",
      etag: "etag",
    })).rejects.toThrow("identity conflicts");
    expect(execute).not.toHaveBeenCalledWith(expect.stringContaining("UPDATE files"), expect.anything());
  });

  it("fails closed when a stable file id is reused for different sandbox bytes", async () => {
    const execute = vi.fn(async () => undefined);
    const query: SqlExecutor["query"] = async <T>(sql: string) => sql.includes("COALESCE(blob.sha256, f.sha256)")
      ? [{
          id: "00000000-0000-7000-8000-000000000020",
          owner_user_id: snapshot().userId,
          object_key: "artifacts/tenants/00000000-0000-7000-8000-000000000002/users/00000000-0000-7000-8000-000000000006/files/00000000-0000-7000-8000-000000000020/digest/original/shared-output.png",
          sha256: "different-digest",
        }] as T[]
      : [] as T[];
    const executor: SqlExecutor = { execute, query };
    executor.transaction = async <T>(callback: (transaction: SqlExecutor) => Promise<T>) => callback(executor);
    const repository = new SqlSandboxSnapshotRepository(executor);

    await expect(repository.persistOutput({
      snapshot: snapshot(),
      fileId: "00000000-0000-7000-8000-000000000020",
      name: "shared-output.png",
      mediaType: "image/png",
      sizeBytes: 4,
      sha256: "digest",
      bucket: "berry",
      objectKey: "artifacts/tenants/00000000-0000-7000-8000-000000000002/users/00000000-0000-7000-8000-000000000006/files/00000000-0000-7000-8000-000000000020/digest/original/shared-output.png",
      etag: "etag",
    })).rejects.toThrow("identity conflicts");
    expect(execute).not.toHaveBeenCalledWith(expect.stringContaining("INSERT INTO file_associations"), expect.anything());
  });

  it("idempotently reuses only an exact stable sandbox identity", async () => {
    const fileId = "00000000-0000-7000-8000-000000000020";
    const objectKey = "artifacts/tenants/00000000-0000-7000-8000-000000000002/users/00000000-0000-7000-8000-000000000006/files/00000000-0000-7000-8000-000000000020/digest/original/shared-output.png";
    const execute = vi.fn(async () => undefined);
    const query: SqlExecutor["query"] = async <T>(sql: string) => {
      if (sql.includes("COALESCE(blob.sha256, f.sha256)")) {
        return [{
          id: fileId,
          owner_user_id: snapshot().userId,
          object_key: objectKey,
          resolved_bucket: "berry",
          resolved_size_bytes: 4,
          sha256: "digest",
        }] as T[];
      }
      if (sql.includes("SELECT id FROM files")) return [{ id: fileId }] as T[];
      return [] as T[];
    };
    const executor: SqlExecutor = { execute, query };
    executor.transaction = async <T>(callback: (transaction: SqlExecutor) => Promise<T>) => callback(executor);
    const repository = new SqlSandboxSnapshotRepository(executor);

    await expect(repository.persistOutput({
      snapshot: snapshot(),
      fileId,
      name: "shared-output.png",
      mediaType: "image/png",
      sizeBytes: 4,
      sha256: "digest",
      bucket: "berry",
      objectKey,
      etag: "etag",
    })).resolves.toMatchObject({ fileId, objectKey });
    expect(execute).not.toHaveBeenCalledWith(expect.stringContaining("INSERT INTO file_blobs"), expect.anything());
    expect(execute).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO file_library_entries"), expect.anything());
    expect(execute).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO file_associations"), expect.anything());
  });

  it("detects newer sandbox owners and uses a transaction-scoped lifecycle lock", async () => {
    const statements: string[] = [];
    const transactionExecutor = {
      execute: vi.fn(async (sql: string) => { statements.push(sql); }),
      query: vi.fn(async () => []),
    };
    const repository = new SqlSandboxSnapshotRepository({
      execute: vi.fn(),
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        return [{
          tenant_id: "00000000-0000-7000-8000-000000000002",
          run_id: "00000000-0000-7000-8000-000000000001",
          session_id: "00000000-0000-7000-8000-000000000004",
          task_id: "00000000-0000-7000-8000-000000000003",
          sandbox_provider: "e2b",
          sandbox_id: "sandbox-shared",
          sandbox_state: "running",
          run_state: "completed",
          sandbox_claimed_by_newer_run: true,
          session_leaf_id: null,
        }];
      }),
      transaction: vi.fn(async (operation) => operation(transactionExecutor)),
    } as never);

    await expect(repository.loadRun(
      "00000000-0000-7000-8000-000000000002",
      "00000000-0000-7000-8000-000000000001",
    )).resolves.toMatchObject({ sandboxClaimedByNewerRun: true });
    await expect(repository.withSandboxLifecycleLock(
      "00000000-0000-7000-8000-000000000002",
      "sandbox-shared",
      async () => "locked",
    )).resolves.toBe("locked");

    expect(statements[0]).toContain("sandbox_claimed_by_newer_run");
    expect(statements.at(-1)).toContain("pg_advisory_xact_lock");
  });

  it("stages updated skill packages in isolated content-addressed directories", async () => {
    const stored = new Map<string, string>();
    const write = vi.fn(async (input: { path: string; content: string; encoding?: string }) => {
      stored.set(input.path, input.content);
      return {
        path: input.path,
        size_bytes: Buffer.byteLength(input.content, input.encoding === "base64" ? "base64" : "utf8"),
        mtime: null,
      };
    });
    const manager = managerWithProvider({
      list: vi.fn(async () => ({ path: "/workspace", entries: [] })),
      read: vi.fn(async (input: { path: string }) => {
        const content = stored.get(input.path);
        if (content === undefined) throw new Error("not found");
        return { path: input.path, content, encoding: "utf8", size_bytes: Buffer.byteLength(content), mtime: null };
      }),
      write,
    });
    const skill = (content: string, resource?: string) => [
      { path: "SKILL.md", contentBase64: Buffer.from(content).toString("base64"), mode: 0o644 },
      ...(resource ? [{ path: resource, contentBase64: Buffer.from("resource").toString("base64"), mode: 0o644 }] : []),
    ];

    const first = await manager.stageSkillPackage(snapshot(), "memo", skill("version one", "assets/old.docx"));
    const second = await manager.stageSkillPackage(snapshot(), "memo", skill("version two"));
    const cachedSnapshot = snapshot();
    cachedSnapshot.steps = [{
      ...toolStep("activate_skill", { name: "memo" }),
      state: "completed",
      output: {
        location: second.filePath,
        stagedResources: second.stagedResources,
        stagingSandboxId: second.stagingSandboxId,
      },
    }];
    const cached = await manager.stageSkillPackage(cachedSnapshot, "memo", skill("version two"));

    expect(first.filePath).not.toBe(second.filePath);
    expect(first.resources).toHaveLength(1);
    expect(second.resources).toEqual([]);
    expect(cached).toEqual(second);
    expect(first.filePath).toMatch(/runtime-skills\/memo-[a-f0-9]{16}\/SKILL\.md$/);
    expect(second.filePath).toMatch(/runtime-skills\/memo-[a-f0-9]{16}\/SKILL\.md$/);
    expect(write).toHaveBeenCalledTimes(5);
  });

  it("writes large organization skill resources as bytes without base64 or shell-command amplification", async () => {
    const write = vi.fn();
    const writeBytes = vi.fn(async (input: { path: string; content: Uint8Array }) => ({
      path: input.path,
      size_bytes: input.content.byteLength,
      mtime: null,
    }));
    const exec = vi.fn(async function* () {
      yield { kind: "exit", exit_code: 0, signal: null };
    });
    const manager = managerWithProvider({
      list: vi.fn(async () => ({ path: "/workspace", entries: [] })),
      read: vi.fn(async () => { throw new Error("not found"); }),
      write,
      writeBytes,
    }, exec);
    const large = Buffer.alloc(700 * 1024, 0x5a);

    const staged = await manager.stageSkillPackage(snapshot(), "branding", [
      { path: "SKILL.md", contentBytes: Buffer.from("---\nname: branding\ndescription: Brand\n---\n"), mode: 0o644 },
      { path: "assets/templates/report.docx", contentBytes: large, mode: 0o644 },
    ]);

    expect(writeBytes).toHaveBeenCalledTimes(2);
    expect(writeBytes.mock.calls[1]?.[0].content).toBe(large);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[0].path).toMatch(/\.berry-staged-files\.json$/);
    expect(staged.filePath).toMatch(/^\/workspace\/runtime-skills\//);
    expect(exec).not.toHaveBeenCalled();
  });

  it("does not load database-backed resource bytes again on a follow-up run in the same sandbox", async () => {
    const manifests = new Map<string, string>();
    const write = vi.fn(async (input: { path: string; content: string }) => {
      manifests.set(input.path, input.content);
      return { path: input.path, size_bytes: Buffer.byteLength(input.content), mtime: null };
    });
    const writeBytes = vi.fn(async (input: { path: string; content: Uint8Array }) => ({ path: input.path, size_bytes: input.content.byteLength, mtime: null }));
    const content = Buffer.from("retained-template-bytes");
    const loadContentBytes = vi.fn(async () => content);
    const fileApi = {
      list: vi.fn(async () => ({ path: "/workspace", entries: [] })),
      read: vi.fn(async (input: { path: string }) => {
        const content = manifests.get(input.path);
        if (content === undefined) throw new Error("not found");
        return { path: input.path, content, encoding: "utf8", size_bytes: Buffer.byteLength(content), mtime: null };
      }),
      write,
      writeBytes,
    };
    const manager = managerWithProvider(fileApi);
    const files = [
      { path: "SKILL.md", contentBytes: Buffer.from("---\nname: cached\ndescription: Cached\n---\n") },
      { path: "assets/template.docx", sizeBytes: content.byteLength, sha256: createHash("sha256").update(content).digest("hex"), loadContentBytes },
    ];

    const first = await manager.stageSkillPackage(snapshot(), "cached", files);
    const second = await managerWithProvider(fileApi).stageSkillPackage(snapshot(), "cached", files);

    expect(second).toEqual(first);
    expect(loadContentBytes).toHaveBeenCalledTimes(1);
    expect(writeBytes).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("restages package files when durable activation state belongs to a replaced sandbox", async () => {
    const writeManyBytes = vi.fn(async (input: { files: Array<{ path: string; content: Uint8Array }> }) => (
      input.files.map((file) => ({ path: file.path, size_bytes: file.content.byteLength, mtime: null }))
    ));
    const manager = managerWithProvider({
      list: vi.fn(async () => ({ path: "/workspace", entries: [] })),
      read: vi.fn(),
      write: vi.fn(),
      writeManyBytes,
    });
    const files = [
      { path: "SKILL.md", contentBytes: Buffer.from("---\nname: replaced\ndescription: Replaced\n---\n") },
      { path: "scripts/run.py", contentBytes: Buffer.from("print('ok')\n"), mode: 0o755 },
    ];
    const first = await manager.stageSkillPackage(snapshot(), "replaced", files);
    const recreatedSnapshot = snapshot();
    recreatedSnapshot.steps = [{
      ...toolStep("activate_skill", { name: "replaced" }),
      state: "completed",
      output: {
        location: first.filePath,
        stagedResources: first.stagedResources,
        stagingSandboxId: "sandbox-before-replacement",
      },
    }];

    await manager.stageSkillPackage(recreatedSnapshot, "replaced", files);

    expect(writeManyBytes).toHaveBeenCalledTimes(2);
    expect(writeManyBytes.mock.calls[1]?.[0].files).toHaveLength(2);
  });

  it("materializes only selected skill resources and batches each incremental upload", async () => {
    const write = vi.fn();
    const read = vi.fn(async () => { throw new Error("not found"); });
    const writeManyBytes = vi.fn(async (input: { files: Array<{ path: string; content: Uint8Array }> }) => (
      input.files.map((file) => ({ path: file.path, size_bytes: file.content.byteLength, mtime: null }))
    ));
    const manager = managerWithProvider({
      list: vi.fn(async () => ({ path: "/workspace", entries: [] })),
      read,
      write,
      writeManyBytes,
    });
    const script = Buffer.from("print('ok')\n");
    const template = Buffer.from("template-bytes");
    const files = [
      { path: "SKILL.md", contentBytes: Buffer.from("---\nname: lazy\ndescription: Lazy\n---\n") },
      { path: "scripts/build.py", sizeBytes: script.byteLength, sha256: createHash("sha256").update(script).digest("hex"), mode: 0o755 },
      { path: "assets/template.docx", sizeBytes: template.byteLength, sha256: createHash("sha256").update(template).digest("hex") },
    ];
    const loadContentBytes = vi.fn(async (paths: readonly string[]) => new Map(paths.map((path) => [
      path,
      path === "scripts/build.py" ? script : template,
    ])));

    const activated = await manager.stageSkillPackage(snapshot(), "lazy", files, {
      resourcePaths: [],
      loadContentBytes,
    });
    const activatedSnapshot = snapshot();
    activatedSnapshot.steps = [{
      ...toolStep("activate_skill", { name: "lazy" }),
      state: "completed",
      output: {
        location: activated.filePath,
        stagedResources: activated.stagedResources,
        stagingSandboxId: activated.stagingSandboxId,
      },
    }];
    const first = await manager.stageSkillPackage(activatedSnapshot, "lazy", files, {
      resourcePaths: ["scripts/build.py"],
      loadContentBytes,
    });
    const nextSnapshot = snapshot();
    nextSnapshot.steps = [{
      ...toolStep("activate_skill", { name: "lazy", resources: ["scripts/build.py"] }),
      state: "completed",
      output: {
        location: first.filePath,
        stagedResources: first.stagedResources,
        stagingSandboxId: first.stagingSandboxId,
      },
    }];
    const second = await manager.stageSkillPackage(nextSnapshot, "lazy", files, {
      resourcePaths: ["assets/template.docx"],
      loadContentBytes,
    });

    expect(activated.stagedResources).toEqual([]);
    expect(second.filePath).toBe(activated.filePath);
    expect(first.resources).toHaveLength(2);
    expect(first.stagedResources).toEqual([expect.stringMatching(/scripts\/build\.py$/)]);
    expect(second.stagedResources).toEqual([
      expect.stringMatching(/scripts\/build\.py$/),
      expect.stringMatching(/assets\/template\.docx$/),
    ]);
    expect(loadContentBytes).toHaveBeenNthCalledWith(1, ["scripts/build.py"]);
    expect(loadContentBytes).toHaveBeenNthCalledWith(2, ["assets/template.docx"]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(writeManyBytes).toHaveBeenCalledTimes(3);
    expect(writeManyBytes.mock.calls[0]?.[0].files).toHaveLength(1);
    expect(writeManyBytes.mock.calls[1]?.[0].files).toHaveLength(1);
    expect(writeManyBytes.mock.calls[2]?.[0].files).toHaveLength(1);
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

function lsStep(): DurableTurnStep {
  return {
    id: "00000000-0000-7000-8000-000000000005",
    sequence: 1,
    type: "tool.ls",
    state: "pending",
    input: { toolName: "ls", arguments: { path: "/workspace" } },
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
  options: { ttlSeconds?: number; cwd?: string } = {},
): SandboxContinuityManager {
  const provider = {
    kind: "e2b",
    create: vi.fn(async () => ({
      sandbox_id: "sandbox-contract",
      provider: "e2b",
      status: "running",
    })),
    exec: piReadAwareExec(files, exec),
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
    ...options,
  });
}

function piReadAwareExec(files: unknown, fallback: unknown): unknown {
  return async function* (input: { command: string[]; sandbox_id: string }) {
    if (input.command[0] === "node" && input.command[1] === "-e" && input.command[2] === PI_READ_STREAM_SCRIPT) {
      const reader = (files as {
        read: (readInput: { sandbox_id: string; path: string; encoding: string }) => Promise<{
          content: string;
          size_bytes: number;
        }>;
      }).read;
      const path = input.command[3]!;
      const offset = Number(input.command[4]);
      const limit = Number(input.command[5]);
      const source = await reader({ sandbox_id: input.sandbox_id, path, encoding: "utf8" });
      const formatted = piReadContent(source.content, {
        offset,
        ...(limit > 0 ? { limit } : {}),
      });
      yield {
        kind: "stdout",
        data: JSON.stringify({
          content: formatted.content,
          details: formatted.details,
          sizeBytes: source.size_bytes,
        }),
      };
      yield { kind: "exit", exit_code: 0, signal: null };
      return;
    }

    for await (const event of (fallback as (execInput: typeof input) => AsyncIterable<unknown>)(input)) {
      yield event;
    }
  };
}
