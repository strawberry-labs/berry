import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { S3Client } from "@aws-sdk/client-s3";
import type { SandboxProvider } from "@berry/sandbox-contract";
import { DURABLE_FILE_TOOL_MAX_CONTENT_CHARS } from "@berry/shared";
import {
  S3SandboxSnapshotObjectStore,
  SandboxContinuityManager,
  SqlSandboxSnapshotRepository,
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
      ...toolStep("read_file", { path: "/workspace/inputs/connector-download/brent.png" }),
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
    await expect(manager.execute(snapshot(), toolStep("append_file", {
      path: "/workspace/file.txt",
      content: " more",
      expected_size_bytes: 13,
    }))).resolves.toMatchObject({
      output: { path: "/workspace/file.txt", sizeBytes: 18, appendedBytes: 5 },
    });
    await expect(manager.execute(snapshot(), toolStep("edit_file", {
      path: "/workspace/file.txt",
      old_string: "file",
      new_string: "updated",
    }))).resolves.toMatchObject({
      output: { path: "/workspace/file.txt", replacements: 1 },
    });
    await expect(manager.execute(snapshot(), toolStep("apply_patch", {
      patch: [
        "*** Begin Patch",
        "*** Update File: file.txt",
        "@@",
        "-file contents",
        "+patched contents",
        "*** End Patch",
      ].join("\n"),
    }))).resolves.toMatchObject({
      output: expect.objectContaining({ updated: ["file.txt"] }),
    });
    await expect(manager.execute(snapshot(), toolStep("glob", {
      path: "/workspace",
      pattern: "**/*.ts",
    }))).resolves.toMatchObject({
      output: { path: "/workspace", pattern: "**/*.ts", files: ["command output"] },
    });
    await expect(manager.execute(snapshot(), toolStep("grep", {
      path: "/workspace",
      pattern: "needle",
    }))).resolves.toMatchObject({
      output: { path: "/workspace", pattern: "needle", matches: "command output" },
    });
    for (const toolName of ["git_status", "git_diff", "git_log", "git_checkpoint"]) {
      await expect(manager.execute(snapshot(), toolStep(toolName, {
        ...(toolName === "git_checkpoint" ? { message: "Checkpoint" } : {}),
      }))).resolves.toMatchObject({
        output: { command: toolName, output: "command output" },
      });
    }
    await expect(manager.execute(snapshot(), toolStep("run_command", {
      command: "printf done",
    }))).resolves.toMatchObject({
      output: { command: "printf done", exitCode: 0, output: "command output" },
    });
    expect(provider.files.write).toHaveBeenCalledWith(expect.objectContaining({
      path: "/workspace/file.txt",
      content: "updated contents",
    }));
  });

  it("rejects malformed raw tool wrappers with an actionable error", async () => {
    const read = vi.fn();
    const write = vi.fn();
    const manager = managerWithProvider({ read, write, list: vi.fn() });

    await expect(manager.execute(snapshot(), toolStep("run_command", {
      raw: "{\"command\":\"printf done\"",
    }))).rejects.toThrow("arguments were incomplete or invalid JSON");
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it.each([
    ["read_file", {}],
    ["list_files", { path: "   " }],
    ["write_file", { content: "x".repeat(5_500) }],
    ["append_file", { content: "x".repeat(5_500), expected_size_bytes: 0 }],
    ["edit_file", { old_string: "before", new_string: "after" }],
  ])("rejects %s before a missing path can resolve to the workspace directory", async (toolName, args) => {
    const read = vi.fn();
    const write = vi.fn();
    const manager = managerWithProvider({ read, write, list: vi.fn() });

    await expect(manager.execute(snapshot(), toolStep(toolName, args)))
      .rejects.toThrow(`${toolName} requires a non-empty path`);
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it.each([
    ["write_file", "retry write_file with the first"],
    ["append_file", "retry append_file with one chunk"],
  ])("bounds %s content so providers can preserve sibling arguments", async (toolName, recoveryInstruction) => {
    const read = vi.fn();
    const write = vi.fn();
    const manager = managerWithProvider({ read, write, list: vi.fn() });
    const args = {
      path: "/workspace/result.txt",
      content: "x".repeat(DURABLE_FILE_TOOL_MAX_CONTENT_CHARS + 1),
      ...(toolName === "append_file" ? { expected_size_bytes: 0 } : {}),
    };

    await expect(manager.execute(snapshot(), toolStep(toolName, args)))
      .rejects.toThrow(recoveryInstruction);
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("requires edit_file new_string while still permitting an intentional empty replacement", async () => {
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

    await expect(manager.execute(snapshot(), toolStep("edit_file", {
      path: "/workspace/result.txt",
      old_string: "remove me",
    }))).rejects.toThrow("edit_file requires a string new_string");
    await expect(manager.execute(snapshot(), toolStep("edit_file", {
      path: "/workspace/result.txt",
      old_string: "remove me",
      new_string: "",
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

    const result = await manager.execute(snapshot(), toolStep("list_files", {
      path: "/home/user/workspace",
      recursive: true,
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
    expect(result.output).toMatchObject({
      entries: [expect.objectContaining({ path })],
    });
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

    await expect(manager.execute(snapshot(), toolStep("list_files", {
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

    await manager.execute(snapshot(), listFilesStep());

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
    const write = vi.fn(async (input: { path: string; content: string }) => ({
      path: input.path,
      size_bytes: Buffer.from(input.content, "base64").byteLength,
      mtime: null,
    }));
    const manager = managerWithProvider({
      list: vi.fn(async () => ({ path: "/workspace", entries: [] })),
      read: vi.fn(),
      write,
    });
    const skill = (content: string, resource?: string) => [
      { path: "SKILL.md", contentBase64: Buffer.from(content).toString("base64"), mode: 0o644 },
      ...(resource ? [{ path: resource, contentBase64: Buffer.from("resource").toString("base64"), mode: 0o644 }] : []),
    ];

    const first = await manager.stageSkillPackage(snapshot(), "memo", skill("version one", "assets/old.docx"));
    const second = await manager.stageSkillPackage(snapshot(), "memo", skill("version two"));

    expect(first.filePath).not.toBe(second.filePath);
    expect(first.resources).toHaveLength(1);
    expect(second.resources).toEqual([]);
    expect(first.filePath).toMatch(/runtime-skills\/memo-[a-f0-9]{16}\/SKILL\.md$/);
    expect(second.filePath).toMatch(/runtime-skills\/memo-[a-f0-9]{16}\/SKILL\.md$/);
    expect(write).toHaveBeenCalledTimes(3);
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
