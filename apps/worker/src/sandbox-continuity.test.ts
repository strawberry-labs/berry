import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { MODEL_IMAGE_LIMITS } from "./model-image.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { S3Client } from "@aws-sdk/client-s3";
import { SandboxNetworkPolicyUpdateError, type SandboxProvider } from "@berry/sandbox-contract";
import {
  S3SandboxSnapshotObjectStore,
  SandboxContinuityManager,
  SqlSandboxSnapshotRepository,
  exposedSandboxImages,
  classifySandboxLifecycleFailure,
  PI_BASH_WRAPPER_SCRIPT,
  PI_GREP_FILTER_SCRIPT,
  PI_READ_STREAM_SCRIPT,
  piReadContent,
  sandboxNetworkFailureHint,
  sandboxPythonFailureHint,
  piReadPdfContent,
  type PreparationTiming,
  type SandboxSnapshotObjectStore,
  type SandboxSnapshotRepository,
} from "./sandbox-continuity.js";
import { DurableTurnRetryableError, type DurableTurnSnapshot, type DurableTurnStep, type TurnToolResult } from "./turn-runner.js";
import type { SqlExecutor } from "./sql-repositories.js";
import { classifyToolFailure } from "./tool-failures.js";

async function testPng(seed: number): Promise<Buffer> {
  return sharp({ create: { width: 2, height: 1, channels: 3, background: { r: seed, g: 40, b: 70 } } }).png().toBuffer();
}

describe("sandbox lifecycle failures (H-009)", () => {
  it.each([
    [Object.assign(new Error("Sandbox abc was not found"), { name: "SandboxNotFoundError" }), "missing"],
    [new Error("502: The sandbox is probably not running anymore"), "missing"],
    [new Error("connect ETIMEDOUT 10.0.0.1:443"), "transient"],
    [new Error("Request timed out after 30000ms"), "transient"],
    [new Error("503 Service Unavailable"), "transient"],
    [new Error("401: Invalid API key"), "denied"],
    [Object.assign(new Error("path not found: /workspace/a.txt"), { name: "FileNotFoundError" }), "unknown"],
    [new Error("Unexpected provider response"), "unknown"],
  ] as const)("classifies %s as %s", (error, expected) => {
    expect(classifySandboxLifecycleFailure(error)).toBe(expected);
  });

  const lifecycleManager = (resume: () => Promise<unknown>) => {
    const provider = {
      kind: "e2b",
      create: vi.fn(async () => ({ sandbox_id: "sandbox-new", provider: "e2b", status: "running" })),
      resume: vi.fn(resume),
      exec: vi.fn(),
      files: { read: vi.fn(), write: vi.fn(), list: vi.fn(async (input: { path: string }) => ({ path: input.path, entries: [] })) },
    } as unknown as SandboxProvider;
    const repository = {
      loadRun: vi.fn(),
      continuity: vi.fn(async () => null),
      latest: vi.fn(async () => null),
      inputFiles: vi.fn(async () => []),
      persistOutput: vi.fn(),
      persist: vi.fn(),
      recordSandbox: vi.fn(async () => undefined),
      recordTiming: vi.fn(async () => undefined),
    } satisfies SandboxSnapshotRepository;
    const manager = new SandboxContinuityManager(provider, repository, null, { image: "berry-sandbox", resumeRetryDelayMs: 1 });
    const current = snapshot();
    current.sandboxId = "sandbox-existing";
    current.sandboxProvider = "e2b";
    current.sandboxState = "running";
    return { provider, repository, manager, current };
  };

  it("retries a timed-out resume once with a fresh connection instead of replacing the workspace", async () => {
    let attempts = 0;
    const { provider, manager, current } = lifecycleManager(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("connect ETIMEDOUT 10.0.0.1:443");
      return { sandbox_id: "sandbox-existing", provider: "e2b", status: "running" };
    });

    await manager.execute(current, lsStep());
    expect(provider.create).not.toHaveBeenCalled();
    expect(provider.resume).toHaveBeenCalledTimes(2);
    expect(vi.mocked(provider.resume!).mock.calls[1]![0]).toMatchObject({ sandbox_id: "sandbox-existing", force_reconnect: true });
  });

  it.each([
    ["connect ETIMEDOUT 10.0.0.1:443", "temporarily unreachable", "failure:transient"],
    ["401: Invalid API key", "An administrator must check the sandbox provider configuration", "failure:denied"],
  ])("reports %s with its class and keeps the workspace", async (message, expected, outcome) => {
    const { provider, repository, manager, current } = lifecycleManager(async () => { throw new Error(message); });

    await expect(manager.execute(current, lsStep())).rejects.toThrow(expected);
    expect(provider.create).not.toHaveBeenCalled();
    expect(repository.recordTiming).toHaveBeenCalledWith(expect.objectContaining({ operation: "sandbox.resume", outcome }));
  });

  it("still replaces a sandbox that is gone", async () => {
    const { provider, manager, current } = lifecycleManager(async () => {
      throw Object.assign(new Error("Sandbox sandbox-existing was not found"), { name: "SandboxNotFoundError" });
    });

    await manager.execute(current, lsStep());
    expect(provider.resume).toHaveBeenCalledTimes(1);
    expect(provider.create).toHaveBeenCalledTimes(1);
  });

  it("releases preparation for a later attempt while the workspace is unreachable", async () => {
    const { manager, current } = lifecycleManager(async () => { throw new Error("503 Service Unavailable"); });
    const staged = manager.stageAssociatedInputFiles(current, ["00000000-0000-7000-8000-000000000090"]);

    await expect(staged).rejects.toBeInstanceOf(DurableTurnRetryableError);
    await expect(staged).rejects.toThrow("Berry will retry");
  });
});

describe("partial output publication (H-014)", () => {
  const publication = (
    files: Record<string, string | null>,
    options: { upload?: (key: string) => Promise<{ bucket: string; key: string; etag: string }>; published?: Array<{ sourcePath: string; sha256: string }> } = {},
  ) => {
    const provider = {
      kind: "e2b",
      create: vi.fn(),
      resume: vi.fn(async () => ({ sandbox_id: "sandbox-publish", provider: "e2b", status: "running" })),
      exec: vi.fn(),
      files: {
        read: vi.fn(async (input: { path: string }) => {
          const content = files[input.path];
          if (content === null || content === undefined) throw Object.assign(new Error(`path not found: ${input.path}`), { name: "FileNotFoundError" });
          return { path: input.path, content: Buffer.from(content).toString("base64"), size_bytes: content.length, mtime: null };
        }),
        write: vi.fn(),
        list: vi.fn(async () => ({
          path: "/workspace/outputs",
          entries: Object.keys(files).map((path) => ({ path, type: "file", size_bytes: 5, mtime: null })),
        })),
      },
    } as unknown as SandboxProvider;
    const repository = {
      loadRun: vi.fn(),
      continuity: vi.fn(async () => null),
      latest: vi.fn(async () => null),
      inputFiles: vi.fn(async () => []),
      publishedOutputs: vi.fn(async () => options.published ?? []),
      persistOutput: vi.fn(async (input: { fileId: string; name: string; mediaType: string; sizeBytes: number; objectKey: string }) => ({ ...input })),
      recordArtifactOperationStart: vi.fn(async () => undefined),
      recordArtifactOperationStorage: vi.fn(async () => undefined),
      completeArtifactOperation: vi.fn(async () => undefined),
      failArtifactOperation: vi.fn(async () => undefined),
      persist: vi.fn(),
      recordSandbox: vi.fn(async () => undefined),
    } satisfies SandboxSnapshotRepository;
    const objects = {
      put: vi.fn(),
      putArtifact: vi.fn(options.upload ?? (async (key: string) => ({ bucket: "berry", key, etag: "etag" }))),
      get: vi.fn(),
      getSource: vi.fn(),
    } satisfies SandboxSnapshotObjectStore;
    const manager = new SandboxContinuityManager(provider, repository, objects, { image: "berry-sandbox", preparationRetryDelayMs: 1 });
    const current = snapshot();
    current.sandboxId = "sandbox-publish";
    current.sandboxProvider = "e2b";
    current.sandboxState = "running";
    current.steps = [{ ...toolStep("bash", { command: "make files" }), state: "completed" }];
    return { manager, repository, objects, current, provider };
  };
  const failures = (results: readonly TurnToolResult[]) => results.filter((result) => (result.output as { publication?: string }).publication === "failed");
  const receipts = (results: readonly TurnToolResult[]) => results.filter((result) => (result.output as { artifact?: unknown }).artifact);
  const receiptNames = (results: readonly TurnToolResult[]) => receipts(results).map((result) => (result.output as { artifact: { name: string } }).artifact.name);

  describe("with a draft image in the run (H-065)", () => {
    // create_image purpose=draft keeps its base under drafts/, unpublished.
    const draftImage = (path = "/workspace/drafts/background.png") => ({
      ...toolStep("create_image", { prompt: "a working background", purpose: "draft" }),
      id: `draft-${path}`,
      state: "completed" as const,
      output: { text: "Generated a draft image", visionPath: path, draft: { path, width: 2, height: 1, mimeType: "image/png" } },
    });

    it("publishes the final output and keeps the draft private", async () => {
      const { manager, objects, current } = publication({ "/workspace/outputs/final.txt": "final deliverable" });
      current.steps = [...current.steps, draftImage()];

      const results = await manager.finalize(current);
      expect(failures(results)).toEqual([]);
      expect(receiptNames(results)).toEqual(["final.txt"]);
      expect(objects.putArtifact).toHaveBeenCalledTimes(1);
      expect(objects.putArtifact.mock.calls.map(([key]) => key).join(" ")).not.toContain("drafts");
    });

    it("reports nothing when the run made only a draft", async () => {
      const { manager, objects, current } = publication({});
      current.steps = [...current.steps, draftImage()];

      expect(await manager.finalize(current)).toEqual([]);
      expect(objects.putArtifact).not.toHaveBeenCalled();
    });

    it("does not upload a final that persist_artifact already published", async () => {
      const { manager, objects, current } = publication({ "/workspace/outputs/final.png": "composited" });
      current.steps = [...current.steps, draftImage(), {
        ...toolStep("persist_artifact", { path: "outputs/final.png" }),
        id: "persist-final",
        state: "completed",
        output: { artifact: { kind: "file", fileId: "file-final", name: "final.png" } },
      }];

      expect(await manager.finalize(current)).toEqual([]);
      expect(objects.putArtifact).not.toHaveBeenCalled();
    });

    it("keeps the other receipts when one upload fails, and the failure stays repairable", async () => {
      const { manager, current } = publication(
        { "/workspace/outputs/a.txt": "alpha", "/workspace/outputs/b.txt": "bravo", "/workspace/outputs/c.txt": "charlie" },
        { upload: async (key) => { if (key.endsWith("/b.txt")) throw new Error("access denied by storage policy"); return { bucket: "berry", key, etag: "etag" }; } },
      );
      current.steps = [...current.steps, draftImage()];

      const results = await manager.finalize(current);
      expect(receiptNames(results)).toEqual(["a.txt", "c.txt"]);
      expect(failures(results)).toEqual([expect.objectContaining({
        output: expect.objectContaining({ path: "/workspace/outputs/b.txt", reason: expect.stringContaining("access denied") }),
      })]);
      // The runner gives the model a repair turn only for failures without this flag (H-014).
      expect((failures(results)[0]?.output as { workspaceUnavailable?: boolean }).workspaceUnavailable).toBeUndefined();
    });

    it("publishes once when finalization runs again", async () => {
      const sha = (value: string) => createHash("sha256").update(Buffer.from(value)).digest("hex");
      const first = publication({ "/workspace/outputs/final.txt": "final deliverable" });
      first.current.steps = [...first.current.steps, draftImage()];
      expect(receiptNames(await first.manager.finalize(first.current))).toEqual(["final.txt"]);

      const again = publication({ "/workspace/outputs/final.txt": "final deliverable" }, { published: [{ sourcePath: "/workspace/outputs/final.txt", sha256: sha("final deliverable") }] });
      again.current.steps = [...again.current.steps, draftImage()];
      expect(await again.manager.finalize(again.current)).toEqual([]);
      expect(again.objects.putArtifact).not.toHaveBeenCalled();
    });
  });

  it("does not let a malformed earlier receipt stop valid files from publishing", async () => {
    const { manager, current } = publication({ "/workspace/outputs/report.txt": "report" });
    current.steps = [...current.steps, {
      ...toolStep("persist_artifact", { path: "../outside/legacy.txt" }),
      id: "legacy-persist",
      state: "completed",
      output: { artifact: { kind: "file", fileId: "file-legacy", name: "legacy.txt" } },
    }];

    const results = await manager.finalize(current);
    expect(failures(results)).toEqual([]);
    expect(receiptNames(results)).toEqual(["report.txt"]);
  });

  it("does not describe a local publication error as an unreachable workspace", async () => {
    const { manager, repository, current } = publication({ "/workspace/outputs/report.txt": "report" });
    repository.publishedOutputs.mockRejectedValueOnce(new Error("Published output metadata is malformed"));

    const [failure, ...rest] = await manager.finalize(current);
    expect(rest).toEqual([]);
    expect(failure?.output).toMatchObject({ publication: "failed", reason: expect.stringContaining("Published output metadata is malformed") });
    expect(String((failure?.output as { reason: string }).reason)).not.toContain("could not be reached");
    expect((failure?.output as { workspaceUnavailable?: boolean }).workspaceUnavailable).toBeUndefined();
  });

  // Only the sandbox can make the workspace unreachable. A database or object
  // storage failure leaves the files repairable, so the runner still offers
  // its publication repair turn (H-014).
  it.each(["database", "object storage"])("keeps a reachable workspace repairable when %s fails, and the next scan publishes once", async (layer) => {
    let uploads = 0;
    const fixture = publication({ "/workspace/outputs/report.txt": "finished report" }, layer === "object storage" ? {
      upload: async (key) => {
        uploads += 1;
        // The bounded retry fails too.
        if (uploads <= 2) throw new Error("503 Service Unavailable");
        return { bucket: "berry", key, etag: "etag" };
      },
    } : {});
    if (layer === "database") fixture.repository.publishedOutputs.mockRejectedValueOnce(new Error("read ECONNRESET"));

    const first = await fixture.manager.finalize(fixture.current);
    expect(failures(first)).toHaveLength(1);
    expect((failures(first)[0]?.output as { workspaceUnavailable?: boolean }).workspaceUnavailable).toBeUndefined();
    expect(String((failures(first)[0]?.output as { reason: string }).reason)).not.toContain("could not be reached");

    const second = await fixture.manager.finalize(fixture.current);
    expect(receiptNames(second)).toEqual(["report.txt"]);
    // Every attempt wrote the same object.
    expect(new Set(fixture.objects.putArtifact.mock.calls.map(([key]) => key)).size).toBe(1);
  });

  it.each([
    ["listing outputs", "list", "connect ETIMEDOUT 10.0.0.1:443"],
    ["reading a file", "read", "502: The sandbox is probably not running anymore"],
  ] as const)("still reports an unreachable workspace when %s fails", async (_label, operation, message) => {
    const fixture = publication({ "/workspace/outputs/report.txt": "finished report" });
    (fixture.provider.files[operation] as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error(message));

    const results = await fixture.manager.finalize(fixture.current);
    expect(failures(results)).toEqual([expect.objectContaining({ output: expect.objectContaining({ workspaceUnavailable: true }) })]);
  });

  it("keeps the first file's receipt when the second upload fails", async () => {
    const { manager, repository, current } = publication(
      { "/workspace/outputs/a.txt": "alpha", "/workspace/outputs/b.txt": "bravo" },
      { upload: async (key) => { if (key.endsWith("/b.txt")) throw new Error("access denied by storage policy"); return { bucket: "berry", key, etag: "etag" }; } },
    );

    const results = await manager.finalize(current);
    expect(receipts(results).map((result) => (result.output as { artifact: { name: string } }).artifact.name)).toEqual(["a.txt"]);
    expect(failures(results)).toEqual([expect.objectContaining({
      output: expect.objectContaining({ path: "/workspace/outputs/b.txt", reason: expect.stringContaining("access denied") }),
    })]);
    expect(repository.completeArtifactOperation).toHaveBeenCalledTimes(1);
    expect(repository.failArtifactOperation).toHaveBeenCalledTimes(1);
  });

  it("reports a file that disappeared after listing and still publishes its peer", async () => {
    const { manager, current } = publication({ "/workspace/outputs/a.txt": "alpha", "/workspace/outputs/gone.txt": null });

    const results = await manager.finalize(current);
    expect(receipts(results)).toHaveLength(1);
    expect(failures(results)[0]?.output).toMatchObject({ name: "gone.txt", reason: "the file no longer exists at this path" });
  });

  it("retries a temporary upload failure once with the same object key", async () => {
    let attempts = 0;
    const { manager, objects, current } = publication(
      { "/workspace/outputs/a.txt": "alpha" },
      { upload: async (key) => { attempts += 1; if (attempts === 1) throw new Error("503 Service Unavailable"); return { bucket: "berry", key, etag: "etag" }; } },
    );

    const results = await manager.finalize(current);
    expect(receipts(results)).toHaveLength(1);
    expect(failures(results)).toHaveLength(0);
    expect(objects.putArtifact).toHaveBeenCalledTimes(2);
    expect(objects.putArtifact.mock.calls[0]![0]).toBe(objects.putArtifact.mock.calls[1]![0]);
  });

  it("publishes only the unpublished file on a later scan and versions changed content", async () => {
    const sha = (value: string) => createHash("sha256").update(Buffer.from(value)).digest("hex");
    const { manager, objects, current } = publication(
      { "/workspace/outputs/a.txt": "alpha", "/workspace/outputs/b.txt": "bravo-2" },
      { published: [{ sourcePath: "/workspace/outputs/a.txt", sha256: sha("alpha") }, { sourcePath: "/workspace/outputs/b.txt", sha256: sha("bravo") }] },
    );

    const results = await manager.finalize(current);
    // a.txt is unchanged and already published; b.txt changed, so it is a new version.
    expect(objects.putArtifact).toHaveBeenCalledTimes(1);
    expect(objects.putArtifact.mock.calls[0]![0]).toContain(`/${sha("bravo-2")}/b.txt`);
    expect(receipts(results)).toHaveLength(1);
  });
});

describe("SandboxContinuityManager", () => {
  it("identifies blocked S3 downloads without exposing signed URL credentials", () => {
    const command = 'curl -s "https://s3.eu-west-1.amazonaws.com/bucket/book.xlsx?X-Amz-Signature=secret"';
    const policy = { egress: "on" as const, allowedDomains: ["connect.aesg.com"] };
    const hint = sandboxNetworkFailureHint(command, policy, 35, "");
    expect(hint).toContain("s3.eu-west-1.amazonaws.com is blocked");
    expect(hint).not.toContain("secret");
    expect(sandboxNetworkFailureHint(command, { ...policy, allowedDomains: ["s3.eu-west-1.amazonaws.com"] }, 35, "")).toBeNull();
    expect(sandboxNetworkFailureHint(command, policy, 0, "download complete")).toBeNull();
    expect(sandboxNetworkFailureHint(command, policy, 0, "FAILED: [SSL: UNEXPECTED_EOF_WHILE_READING]")).toContain("is blocked");
  });
  it("keeps core reads non-abortable while repository and object-store seams lack signals", () => {
    const manager = new SandboxContinuityManager({ kind: "e2b" } as SandboxProvider, {} as SandboxSnapshotRepository, null, { image: "berry-sandbox" });

    expect(manager.supportsAbort(snapshot(), lsStep())).toBe(false);
    expect(manager.supportsAbort(snapshot(), toolStep("grep", { path: "/workspace", pattern: "result" }))).toBe(false);
    expect(manager.supportsAbort(snapshot(), toolStep("write", { path: "/workspace/file.txt", content: "x" }))).toBe(false);
    expect(manager.supportsAbort(snapshot(), toolStep("bash", { command: "sleep 1" }))).toBe(false);
  });

  it("does not claim settlement while a repository read remains blocked after abort", async () => {
    let releaseLatest!: () => void;
    const latest = vi.fn(() => new Promise<null>((resolve) => {
      releaseLatest = () => resolve(null);
    }));
    const provider = {
      kind: "e2b",
      create: vi.fn(async (_input: unknown, options?: { signal?: AbortSignal | undefined }) => {
        options?.signal?.throwIfAborted();
        return { sandbox_id: "sandbox-repository-blocked", provider: "e2b", status: "running" as const };
      }),
      files: {
        list: vi.fn(),
        read: vi.fn(),
        write: vi.fn(),
      },
    } as unknown as SandboxProvider;
    const repository = {
      loadRun: vi.fn(),
      continuity: vi.fn(async () => null),
      latest,
      inputFiles: vi.fn(async () => []),
      persistOutput: vi.fn(),
      persist: vi.fn(),
      recordSandbox: vi.fn(async () => undefined),
    } satisfies SandboxSnapshotRepository;
    const manager = new SandboxContinuityManager(provider, repository, null, { image: "berry-sandbox" });
    const controller = new AbortController();
    let settled = false;
    const execution = manager.execute(snapshot(), lsStep(), controller.signal);
    void execution.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await vi.waitFor(() => expect(latest).toHaveBeenCalledTimes(1));

    controller.abort(new Error("cancel blocked repository read"));
    await Promise.resolve();
    await Promise.resolve();

    expect(settled).toBe(false);
    releaseLatest();
    await expect(execution).rejects.toThrow("cancel blocked repository read");
  });

  it("does not claim settlement while snapshot-object loading remains blocked after abort", async () => {
    let releaseObject!: () => void;
    const get = vi.fn(() => new Promise<Uint8Array>((resolve) => {
      releaseObject = () => resolve(Buffer.from(JSON.stringify({
        version: 1,
        createdAt: new Date().toISOString(),
        files: [],
      })));
    }));
    const provider = {
      kind: "e2b",
      create: vi.fn(async () => ({
        sandbox_id: "sandbox-object-blocked",
        provider: "e2b",
        status: "running" as const,
      })),
      files: {
        list: vi.fn(),
        read: vi.fn(),
        write: vi.fn(),
      },
    } as unknown as SandboxProvider;
    const repository = {
      loadRun: vi.fn(),
      continuity: vi.fn(async () => null),
      latest: vi.fn(async () => ({
        id: "snapshot-object-blocked",
        objectKey: "snapshot-object-blocked.json",
        contentHash: "hash",
        sequence: 1,
      })),
      inputFiles: vi.fn(async () => []),
      persistOutput: vi.fn(),
      persist: vi.fn(),
      recordSandbox: vi.fn(async () => undefined),
    } satisfies SandboxSnapshotRepository;
    const objects = {
      put: vi.fn(),
      putArtifact: vi.fn(),
      get,
      getSource: vi.fn(),
    } satisfies SandboxSnapshotObjectStore;
    const manager = new SandboxContinuityManager(provider, repository, objects, { image: "berry-sandbox" });
    const controller = new AbortController();
    let settled = false;
    const execution = manager.execute(snapshot(), lsStep(), controller.signal);
    void execution.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));

    controller.abort(new Error("cancel blocked object read"));
    await Promise.resolve();
    await Promise.resolve();

    expect(settled).toBe(false);
    releaseObject();
    await expect(execution).rejects.toThrow("cancel blocked object read");
  });

  it("restores a durable workspace through one native batch write", async () => {
    const write = vi.fn();
    const writeManyBytes = vi.fn(async (input: { files: Array<{ path: string; content: Uint8Array; mode?: number }> }) => (
      input.files.map((file) => ({ path: file.path, size_bytes: file.content.byteLength, mtime: null }))
    ));
    const provider = {
      kind: "e2b",
      create: vi.fn(async () => ({
        sandbox_id: "sandbox-restored",
        provider: "e2b",
        status: "running" as const,
      })),
      files: {
        list: vi.fn(async (input: { path: string }) => ({ path: input.path, entries: [] })),
        read: vi.fn(),
        write,
        writeManyBytes,
      },
    } as unknown as SandboxProvider;
    const repository = {
      loadRun: vi.fn(),
      continuity: vi.fn(async () => null),
      latest: vi.fn(async () => ({
        id: "snapshot-restored",
        objectKey: "snapshot-restored.json",
        contentHash: "hash",
        sequence: 1,
      })),
      inputFiles: vi.fn(async () => []),
      persistOutput: vi.fn(),
      persist: vi.fn(),
      recordSandbox: vi.fn(async () => undefined),
    } satisfies SandboxSnapshotRepository;
    const objects = {
      put: vi.fn(),
      putArtifact: vi.fn(),
      get: vi.fn(async () => Buffer.from(JSON.stringify({
        version: 1,
        createdAt: new Date().toISOString(),
        files: [
          { path: "/workspace/report.txt", content: Buffer.from("report").toString("base64"), encoding: "base64" },
          { path: "/workspace/script.sh", content: Buffer.from("echo ok\n").toString("base64"), encoding: "base64", mode: 0o755 },
        ],
      }))),
      getSource: vi.fn(),
    } satisfies SandboxSnapshotObjectStore;
    const manager = new SandboxContinuityManager(provider, repository, objects, { image: "berry-sandbox" });

    await manager.execute(snapshot(), lsStep());

    expect(writeManyBytes).toHaveBeenCalledTimes(1);
    expect(writeManyBytes).toHaveBeenCalledWith({
      sandbox_id: "sandbox-restored",
      files: [
        { path: "/workspace/report.txt", content: Buffer.from("report") },
        { path: "/workspace/script.sh", content: Buffer.from("echo ok\n"), mode: 0o755 },
      ],
    }, { signal: undefined });
    expect(write).not.toHaveBeenCalled();
  });

  it("creates one sandbox when independent first-use reads start concurrently", async () => {
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
    const create = vi.fn(async () => {
      await createGate;
      return { sandbox_id: "sandbox-shared", provider: "e2b", status: "running" as const };
    });
    const provider = {
      kind: "e2b",
      create,
      files: {
        list: vi.fn(async (input: { path: string }) => ({ path: input.path, entries: [] })),
        read: vi.fn(),
        write: vi.fn(),
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
    const manager = new SandboxContinuityManager(provider, repository, null, { image: "berry-sandbox" });

    const first = manager.execute(snapshot(), lsStep());
    const second = manager.execute(snapshot(), { ...lsStep(), id: "00000000-0000-7000-8000-000000000006" });
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    releaseCreate();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("forwards cancellation to first-use sandbox creation", async () => {
    const create = vi.fn(async (
      _input: unknown,
      options?: { signal?: AbortSignal | undefined },
    ) => new Promise<never>((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
    }));
    const provider = {
      kind: "e2b",
      create,
      files: {
        list: vi.fn(),
        read: vi.fn(),
        write: vi.fn(),
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
    const manager = new SandboxContinuityManager(provider, repository, null, { image: "berry-sandbox" });
    const controller = new AbortController();
    const execution = manager.execute(snapshot(), lsStep(), controller.signal);
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));

    controller.abort(new Error("cancel first-use creation"));

    await expect(execution).rejects.toThrow("cancel first-use creation");
    expect(create.mock.calls[0]?.[1]).toEqual({ signal: controller.signal });
  });

  it("records an explicitly recovered sandbox after an ambiguous first-use create", async () => {
    const create = vi.fn(async () => { throw new Error("remote create response was lost"); });
    const recoverCreate = vi.fn(async () => ({
      sandbox_id: "sandbox-recovered",
      request_id: snapshot().id,
      tenant_id: snapshot().tenantId,
      provider: "e2b",
      provider_kind: "e2b" as const,
      status: "running" as const,
      image: "berry-sandbox",
      cwd: "/workspace",
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      metadata: {},
    }));
    const recordSandbox = vi.fn(async () => undefined);
    const provider = {
      kind: "e2b",
      create,
      recoverCreate,
      files: { list: vi.fn(), read: vi.fn(), write: vi.fn() },
    } as unknown as SandboxProvider;
    const repository = {
      loadRun: vi.fn(),
      continuity: vi.fn(async () => null),
      latest: vi.fn(async () => null),
      inputFiles: vi.fn(async () => []),
      persistOutput: vi.fn(),
      persist: vi.fn(),
      recordSandbox,
    } satisfies SandboxSnapshotRepository;
    const manager = new SandboxContinuityManager(provider, repository, null, { image: "berry-sandbox" });

    await expect(manager.execute(snapshot(), lsStep())).rejects.toThrow("remote create response was lost");
    expect(recoverCreate).toHaveBeenCalledOnce();
    expect(recordSandbox).toHaveBeenCalledWith(expect.objectContaining({
      sandboxId: "sandbox-recovered",
      state: "running",
    }));
  });

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
    const skipFinalization = vi.fn(async () => undefined);
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
      skipFinalization,
    } satisfies SandboxSnapshotRepository;
    const manager = new SandboxContinuityManager(provider, repository, null, {
      image: "berry-sandbox",
      enableTerminalFinalization: true,
    });

    await expect(manager.snapshot({
      tenantId: "00000000-0000-7000-8000-000000000002",
      runId: "00000000-0000-7000-8000-000000000001",
      reason: "before-finalize",
    })).resolves.toEqual({ noOp: true });
    expect(list).not.toHaveBeenCalled();
    expect(suspend).not.toHaveBeenCalled();
    expect(skipFinalization).toHaveBeenCalledWith(expect.objectContaining({
      reason: "sandbox_paused",
    }));
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

  it("does not store a terminal snapshot that finishes after its deadline (H-010)", async () => {
    let finishCapture: (value: { path: string; entries: [] }) => void = () => undefined;
    const suspend = vi.fn(async () => ({ sandbox_id: "sandbox-late", destroyed: true, status: "stopped" as const }));
    const provider = {
      kind: "e2b",
      suspend,
      files: {
        list: vi.fn(() => new Promise((resolve) => { finishCapture = resolve; })),
        read: vi.fn(),
        write: vi.fn(),
      },
    } as unknown as SandboxProvider;
    const run = {
      tenantId: "00000000-0000-7000-8000-000000000002",
      runId: "00000000-0000-7000-8000-000000000001",
      sessionId: "00000000-0000-7000-8000-000000000004",
      taskId: "00000000-0000-7000-8000-000000000003",
      sandboxProvider: "e2b",
      sandboxId: "sandbox-late",
      sandboxState: "pause_requested",
      runState: "completed",
      sessionLeafId: null,
    };
    const repository = {
      loadRun: vi.fn(async () => run),
      continuity: vi.fn(),
      latest: vi.fn(async () => null),
      inputFiles: vi.fn(),
      persistOutput: vi.fn(),
      persist: vi.fn(),
      recordSandbox: vi.fn(async () => undefined),
    } satisfies SandboxSnapshotRepository;
    const objects = { put: vi.fn(), putArtifact: vi.fn(), get: vi.fn(), getSource: vi.fn() } satisfies SandboxSnapshotObjectStore;
    const manager = new SandboxContinuityManager(provider, repository, objects, { image: "berry-sandbox", terminalSnapshotTimeoutMs: 5 });

    await expect(manager.snapshot({ tenantId: run.tenantId, runId: run.runId, reason: "before-finalize" }))
      .rejects.toThrow("Terminal sandbox snapshot timed out after 5ms");
    expect(suspend).toHaveBeenCalledOnce();
    // The capture completes after cleanup; nothing may be stored from it.
    finishCapture({ path: "/workspace", entries: [] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(objects.put).not.toHaveBeenCalled();
    expect(repository.persist).not.toHaveBeenCalled();
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
    const image = await testPng(1);
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

    await expect(manager.modelContent(current)).resolves.toEqual([{ type: "text", text: 'Workspace image "/workspace/inputs/connector-download/brent.png"' }, {
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
      const bytes = await testPng(Number(/page-(\d+)/.exec(input.path)?.[1] ?? 0));
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

    const images = await Promise.all(paths.map((path) => testPng(Number(/page-(\d+)/.exec(path)?.[1] ?? 0))));
    expect(content).toEqual(paths.flatMap((path, index) => [
      { type: "text", text: `Workspace image ${JSON.stringify(path)}` },
      { type: "image_url", image_url: { url: `data:image/png;base64,${images[index]!.toString("base64")}` } },
    ]));
    expect(maxActiveReads).toBe(3);
    expect(read.mock.calls.map(([input]) => input.path)).toEqual(paths);
  });

  it("backfills image slots after oversized attachment candidates are skipped", async () => {
    const images = await Promise.all([1, 2, 3, 4, 5, 6].map(testPng));
    const inputFiles = Array.from({ length: 6 }, (_, index) => ({
      fileId: `image-${index + 1}`,
      name: `image-${index + 1}.png`,
      mediaType: "image/png",
      sizeBytes: index === 0 ? 20 * 1024 * 1024 + 1 : images[index]!.byteLength,
      objectKey: `objects/image-${index + 1}.png`,
    }));
    const writeStream = vi.fn(async (input: { path: string; content: ReadableStream<Uint8Array> }) => {
      const reader = input.content.getReader();
      let size = 0;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
      }
      return { path: input.path, size_bytes: size, mtime: null };
    });
    const provider = {
      kind: "e2b",
      create: vi.fn(async () => ({ sandbox_id: "sandbox-images", provider: "e2b", status: "running" })),
      files: { read: vi.fn(), write: vi.fn(), writeStream, list: vi.fn() },
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
    const getSource = vi.fn(async (key: string) => images[Number(/image-(\d+)/.exec(key)?.[1] ?? 0) - 1]!);
    const objects = {
      put: vi.fn(),
      putArtifact: vi.fn(),
      get: vi.fn(),
      getSource,
      streamSource: vi.fn(async function* (key: string) {
        const index = Number(/image-(\d+)/.exec(key)?.[1] ?? 0) - 1;
        yield new Uint8Array(inputFiles[index]!.sizeBytes);
      }),
    } satisfies SandboxSnapshotObjectStore;
    const manager = new SandboxContinuityManager(provider, repository, objects, { image: "berry-sandbox" });
    const current = snapshot();
    current.steps = [];

    const content = await manager.modelContent(current);

    expect(content[0]).toEqual({ type: "text", text: expect.stringContaining("Image not sent:") });
    expect(content.slice(1)).toEqual([2, 3, 4, 5, 6].flatMap((value, index) => [
      { type: "text", text: `Workspace image "/workspace/inputs/image-${value}/image-${value}.png"` },
      { type: "image_url", image_url: { url: `data:image/png;base64,${images[value - 1]!.toString("base64")}` } },
    ]));
    expect(getSource).toHaveBeenCalledTimes(5);
    expect(getSource).not.toHaveBeenCalledWith("objects/image-1.png", undefined);
    expect(writeStream).toHaveBeenCalledTimes(6);
  });

  it("compresses image batches before sending pixels and gives recoverable notices for corrupt files", async () => {
    const image = await sharp({ create: { width: 4_000, height: 3_000, channels: 3, background: "white" } }).png().toBuffer();
    const paths = ["/workspace/one.png", "/workspace/broken.png", "/workspace/three.png", "/workspace/four.png", "/workspace/five.png"];
    const provider = { kind: "e2b", files: {
      read: vi.fn(async ({ path }: { path: string }) => ({ path, content: (path.includes("broken") ? Buffer.from("broken") : image).toString("base64") })),
    } } as unknown as SandboxProvider;
    const repository = { inputFiles: vi.fn(async () => []), latest: vi.fn(), continuity: vi.fn(), recordSandbox: vi.fn() } as unknown as SandboxSnapshotRepository;
    const manager = new SandboxContinuityManager(provider, repository, null, { image: "berry-sandbox" });
    const current = snapshot();
    current.sandboxId = "sandbox-image-budget";
    current.sandboxProvider = "e2b";
    current.steps = [{ ...toolStep("inspect_images", { paths }), state: "running" }];
    const content = await manager.modelContent(current);
    const pixels = content.flatMap((part) => part.type === "image_url" ? [part.image_url.url] : []);
    expect(pixels).toHaveLength(4);
    expect(pixels.reduce((total, url) => total + url.split(",")[1]!.length, 0)).toBeLessThanOrEqual(MODEL_IMAGE_LIMITS.maxTotalBase64Bytes);
    for (const url of pixels) {
      const meta = await sharp(Buffer.from(url.split(",")[1]!, "base64")).metadata();
      expect(meta.width).toBe(2_000);
      expect(meta.height).toBe(1_500);
    }
    expect(content).toContainEqual({ type: "text", text: expect.stringContaining("Use bash to create a smaller PNG/JPEG copy") });
    expect(content).toContainEqual({ type: "text", text: expect.stringContaining("4000x3000 to 2000x1500") });
  });

  it("does not let an older terminal cleanup pause a sandbox claimed by a follow-up run", async () => {
    const skipFinalization = vi.fn(async () => undefined);
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
      skipFinalization,
    } satisfies SandboxSnapshotRepository;
    const manager = new SandboxContinuityManager(provider, repository, null, {
      image: "berry-sandbox",
      enableTerminalFinalization: true,
    });

    await expect(manager.snapshot({
      tenantId: "00000000-0000-7000-8000-000000000002",
      runId: "00000000-0000-7000-8000-000000000001",
      reason: "before-finalize",
    })).resolves.toEqual({ noOp: true });
    expect(provider.files.list).not.toHaveBeenCalled();
    expect(provider.suspend).not.toHaveBeenCalled();
    expect(skipFinalization).toHaveBeenCalledWith(expect.objectContaining({
      reason: "sandbox_claimed_by_newer_run",
    }));
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

  it("classifies successful empty bash output separately from returned content", async () => {
    const manager = managerWithProvider(
      { read: vi.fn(), write: vi.fn(), list: vi.fn() },
      async function* () {
        yield { kind: "exit", exit_code: 0, signal: null };
      },
    );

    await expect(manager.execute(snapshot(), toolStep("bash", {
      command: "printf '' | grep never",
    }))).resolves.toMatchObject({
      output: {
        hasMeaningfulOutput: false,
        outcome: "empty",
        output: expect.stringContaining("produced no output"),
      },
      progress: {
        outcome: "empty",
        fingerprintBasis: { exitCode: 0, output: "", truncated: false },
      },
    });
  });

  describe("Python failure hints (H-008)", () => {
    const python = (args: string[], cwd?: string) => {
      const result = spawnSync("python3", args, { encoding: "utf8", ...(cwd ? { cwd } : {}) });
      expect(result.status).not.toBe(0);
      return `${result.stdout}${result.stderr}`;
    };
    const offline = { egress: "off" as const, allowedDomains: [] };
    const options = { policy: offline, workspaceRoot: "/workspace" };

    it("names a package that is not installed and says whether pip can reach PyPI", () => {
      const output = python(["-c", "import berry_h008_missing.sub"]);
      expect(output).toContain("ModuleNotFoundError");
      const hint = sandboxPythonFailureHint(output, options);
      expect(hint).toContain("the module 'berry_h008_missing' is not installed in this sandbox");
      expect(hint).toContain("python -m pip list");
      expect(hint).toContain("no network access");
      expect(sandboxPythonFailureHint(output, { ...options, policy: { egress: "on", allowedDomains: ["example.com"] } }))
        .toContain("pypi.org and files.pythonhosted.org are not allowed");
      expect(sandboxPythonFailureHint(output, { ...options, policy: { egress: "on", allowedDomains: ["pypi.org", "files.pythonhosted.org"] } }))
        .toContain("Installing may work: python -m pip install --target /workspace/tmp/pylib");
    });

    it("says when skill files are not at the path used and how to stage them", () => {
      const root = mkdtempSync(join(tmpdir(), "berry-h008-"));
      try {
        const missing = python([join(root, "skills", "pdf", "scripts", "fill.py")]);
        expect(missing).toContain("can't open file");
        const hint = sandboxPythonFailureHint(missing, options);
        expect(hint).toContain("the skill's files are not at that path");
        expect(hint).toContain("activate_skill");
        expect(hint).toContain("No skill has been activated");
        // A staged script whose sibling helper was not staged.
        const skillRoot = join(root, "runtime-skills", "pdf-0123456789abcdef");
        const scripts = join(skillRoot, "scripts");
        spawnSync("mkdir", ["-p", scripts]);
        writeFileSync(join(scripts, "fill.py"), "import pdf_helpers\n");
        const helperOutput = python([join(scripts, "fill.py")], root);
        const helper = sandboxPythonFailureHint(helperOutput, {
          ...options,
          skills: [{ root: skillRoot, files: [join(scripts, "fill.py"), join(scripts, "pdf_helpers.py")] }],
        });
        expect(helper).toContain(`'pdf_helpers' is a helper module of the skill in ${skillRoot}`);
        expect(helper).toContain(`PYTHONPATH=${scripts}`);
        expect(helper).toContain("installing packages will not help");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("points at the script's own line for syntax errors and errors in its code", () => {
      const root = mkdtempSync(join(tmpdir(), "berry-h008-"));
      try {
        writeFileSync(join(root, "broken.py"), "def main(:\n    pass\n");
        writeFileSync(join(root, "divide.py"), "total = 0\nprint(10 / total)\n");
        const syntax = sandboxPythonFailureHint(python([join(root, "broken.py")]), options);
        expect(syntax).toContain(`SyntaxError in the script at ${join(root, "broken.py")}:1`);
        expect(syntax).toContain("installing packages or retrying will not fix it");
        const runtime = sandboxPythonFailureHint(python([join(root, "divide.py")]), options);
        expect(runtime).toContain(`ZeroDivisionError raised by the script's own code at ${join(root, "divide.py")}:2`);
        expect(runtime).toContain("installing packages will not fix it");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("adds nothing to failures that match none of these cases", () => {
      expect(sandboxPythonFailureHint("ls: cannot access 'missing': No such file or directory\n", options)).toBeNull();
      // Raised inside the standard library, not the script's own code.
      const library = python(["-c", "import json; json.loads('{')"]);
      expect(library).toContain("JSONDecodeError");
      expect(sandboxPythonFailureHint(library, options)).toBeNull();
      // A data file the script could not open is not a skill path or a code bug.
      expect(sandboxPythonFailureHint(python(["-c", "open('/workspace/inputs/missing.csv')"]), options)).toBeNull();
    });

    it("appends the hint to a failed bash result and keeps the original error", async () => {
      const traceback = "Traceback (most recent call last):\n  File \"/workspace/make_doc.py\", line 1, in <module>\n    import docx\nModuleNotFoundError: No module named 'docx'\n";
      const manager = managerWithProvider(
        { read: vi.fn(), write: vi.fn(), list: vi.fn() },
        async function* () {
          yield { kind: "stderr", data: traceback };
          yield { kind: "exit", exit_code: 1, signal: null };
        },
      );
      await expect(manager.execute(snapshot(), toolStep("bash", { command: "python make_doc.py" })))
        .rejects.toThrow(`${traceback}\n\n[Berry: the module 'docx' is not installed in this sandbox.`);
    });
  });

  it("does not describe a failed empty bash command as successful", async () => {
    const manager = managerWithProvider(
      { read: vi.fn(), write: vi.fn(), list: vi.fn() },
      async function* () {
        yield { kind: "exit", exit_code: 2, signal: null };
      },
    );

    await expect(manager.execute(snapshot(), toolStep("bash", {
      command: "grep never missing.txt",
    }))).rejects.toThrow("Command produced no output.\n\nCommand exited with code 2");
  });

  // A shell command that was sent may have run, and an earlier part of it
  // (a POST) may have taken effect, whatever failed later (H-003).
  describe("a shell failure after the command was sent", () => {
    const post = "curl -X POST https://records.example.test/create -d title=TenderA";
    const failure = async (exec: unknown, command = post) => {
      const current = snapshot();
      current.runtimeRequest = { networkPolicy: { egress: "on", allowedDomains: ["records.example.test"] } } as DurableTurnSnapshot["runtimeRequest"];
      const manager = managerWithProvider({ read: vi.fn(), write: vi.fn(), list: vi.fn() }, exec);
      return manager.execute(current, toolStep("bash", { command })).then(
        () => { throw new Error("The command was expected to fail"); },
        (error: unknown) => error,
      );
    };

    it("keeps the exit status when a network hint replaces the output", async () => {
      const error = await failure(async function* () {
        yield { kind: "stdout", data: "create" };
        yield { kind: "stderr", data: "curl: (35) LibreSSL SSL_connect: SSL_ERROR_SYSCALL in connection to blocked.example.test:443" };
        yield { kind: "exit", exit_code: 35, signal: null };
      }, `${post} && curl https://blocked.example.test/notify`);

      expect((error as Error).message).toMatch(/^Network access to blocked\.example\.test is blocked by this task's sandbox policy\.[\s\S]*\n\nCommand exited with code 35$/);
      expect(classifyToolFailure(error, { changesState: true }).outcome).toBe("unknown");
    });

    it.each([
      ["an error event", async function* () {
        yield { kind: "stdout", data: "create" };
        yield { kind: "error", message: "invalid schema in post-processing" };
      }],
      ["a stream that broke", async function* () {
        yield { kind: "stdout", data: "create" };
        throw new Error("invalid response from the sandbox");
      }],
    ])("treats %s as a command that may have run", async (_label, exec) => {
      const error = await failure(exec);

      expect(error).toMatchObject({ toolCallPhase: "dispatched" });
      expect(classifyToolFailure(error, { changesState: true }).outcome).toBe("unknown");
    });

    it("still tells failures from before the command was sent apart", async () => {
      // Arguments refused (H-011).
      const exec = vi.fn();
      const refused = await failure(exec, "");
      expect((refused as Error).message).toContain("bash was not run");
      expect(classifyToolFailure(refused, { changesState: true }).outcome).toBe("not_applied");
      expect(exec).not.toHaveBeenCalled();

      // A workspace that could not be reached (H-009).
      const provider = {
        kind: "e2b",
        create: vi.fn(),
        resume: vi.fn(async () => { throw new Error("connect ETIMEDOUT 10.0.0.1:443"); }),
        exec: vi.fn(),
        files: { read: vi.fn(), write: vi.fn(), list: vi.fn() },
      } as unknown as SandboxProvider;
      const repository = {
        loadRun: vi.fn(),
        continuity: vi.fn(async () => null),
        latest: vi.fn(async () => null),
        inputFiles: vi.fn(async () => []),
        persistOutput: vi.fn(),
        persist: vi.fn(),
        recordSandbox: vi.fn(async () => undefined),
        recordTiming: vi.fn(async () => undefined),
      } satisfies SandboxSnapshotRepository;
      const current = snapshot();
      current.sandboxId = "sandbox-existing";
      current.sandboxProvider = "e2b";
      current.sandboxState = "running";
      const manager = new SandboxContinuityManager(provider, repository, null, { image: "berry-sandbox", resumeRetryDelayMs: 1 });
      const unreachable = await manager.execute(current, toolStep("bash", { command: post })).catch((error: unknown) => error);
      expect((unreachable as Error).message).toContain("Nothing was run");
      expect(classifyToolFailure(unreachable, { changesState: true }).outcome).toBe("not_applied");
      expect(provider.exec).not.toHaveBeenCalled();
    });
  });

  it("rejects malformed raw tool wrappers with an actionable error", async () => {
    const read = vi.fn();
    const write = vi.fn();
    const manager = managerWithProvider({ read, write, list: vi.fn() });

    await expect(manager.execute(snapshot(), toolStep("bash", {
      raw: "{\"command\":\"printf done\"",
    }))).rejects.toThrow('bash was not run: its arguments are invalid JSON: the text ends inside an object, before its closing "}", after the last of its 24 characters (line 1, column 25), near {"command":"printf done"⟨HERE⟩. The arguments look cut off');
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("says a core tool was not run and why when its edits are not valid (H-011)", async () => {
    const write = vi.fn();
    const manager = managerWithProvider({ read: vi.fn(), write, list: vi.fn() });
    await expect(manager.execute(snapshot(), toolStep("edit", {
      path: "/workspace/a.ts",
      edits: '[{"oldText": "a", "newText": "\\q"}]',
    }))).rejects.toThrow('edit was not run: edit edits must be an array of {oldText, newText} objects; a string was sent whose JSON is invalid: bad escape "\\q"');
    await expect(manager.execute(snapshot(), toolStep("write", { path: "/workspace/a.ts" })))
      .rejects.toThrow("write was not run: write requires a string content. Correct the arguments and call it again.");
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

  it("decodes UTF-16LE text and reports binary data inside the sandbox read helper (H-011)", () => {
    const directory = mkdtempSync(join(tmpdir(), "berry-read-"));
    try {
      const read = (name: string, bytes: Buffer, offset = 1) => {
        const path = join(directory, name);
        writeFileSync(path, bytes);
        const result = spawnSync(process.execPath, ["-e", PI_READ_STREAM_SCRIPT, path, String(offset), "0", "2000", String(50 * 1024), "2000"], {
          encoding: "utf8",
        });
        expect(result.status, result.stderr).toBe(0);
        return JSON.parse(result.stdout) as Record<string, unknown>;
      };
      const csv = "Name,Total\r\nAlpha,12\r\nBeta,7\r\n";
      expect(read("bom.csv", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(csv, "utf16le")]))).toMatchObject({
        content: "Name,Total\nAlpha,12\nBeta,7",
        details: { encoding: "utf-16le" },
      });
      expect(read("export.csv", Buffer.from(csv, "utf16le"), 2)).toMatchObject({
        content: "Alpha,12\nBeta,7",
        details: { encoding: "utf-16le" },
      });
      const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00]), Buffer.from("SKILL.md")]);
      expect(read("bundle.dat", zip)).toEqual({ binary: true, sizeBytes: zip.byteLength });
      const text = Buffer.from("café\r\nnaïve\n");
      expect(read("notes.txt", text)).toEqual({ content: "café\nnaïve", details: {}, sizeBytes: text.byteLength });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  describe("sandbox read helper encodings (H-011)", () => {
    let directory = "";
    beforeAll(() => { directory = mkdtempSync(join(tmpdir(), "berry-encoding-")); });
    afterAll(() => rmSync(directory, { recursive: true, force: true }));
    const read = (name: string, bytes: Buffer) => {
      const path = join(directory, name);
      writeFileSync(path, bytes);
      const result = spawnSync(process.execPath, ["-e", PI_READ_STREAM_SCRIPT, path, "1", "0", "2000", String(50 * 1024), "2000"], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(result.stdout) as Record<string, unknown>;
    };
    const utf16be = (text: string) => Buffer.from(text, "utf16le").swap16();
    const csv = "Name,Total\r\nAlpha,12\r\nBeta,7\r\n";
    const chinese = "第一章 总则\n第一条 为了规范合同管理，保护当事人的合法权益，制定本办法。\n第二条 本办法适用于公司及所属单位签订的各类合同。\n";
    const arabic = "نص حكيم له سر قاطع وذو شأن عظيم مكتوب على ثوب أخضر.\nالتقرير السنوي لعام 2024\n";
    const russian = "Съешь же ещё этих мягких французских булок, да выпей чаю.\nОтчёт за 2024 год.\n";

    it("decodes UTF-16BE with and without a byte-order mark", () => {
      expect(read("bom-be.csv", Buffer.concat([Buffer.from([0xfe, 0xff]), utf16be(csv)])))
        .toMatchObject({ content: "Name,Total\nAlpha,12\nBeta,7", details: { encoding: "utf-16be" } });
      expect(read("plain-be.csv", utf16be(csv)))
        .toMatchObject({ content: "Name,Total\nAlpha,12\nBeta,7", details: { encoding: "utf-16be" } });
      expect(read("chinese-be.txt", utf16be(chinese.repeat(3))))
        .toMatchObject({ content: chinese.repeat(3).trimEnd(), details: { encoding: "utf-16be" } });
    });

    it.each([["chinese", chinese], ["arabic", arabic], ["russian", russian]])(
      "decodes BOM-less UTF-16LE %s text whose bytes are rarely NUL",
      (name, text) => {
        expect(read(`${name}.txt`, Buffer.from(text.repeat(3), "utf16le")))
          .toMatchObject({ content: text.repeat(3).trimEnd(), details: { encoding: "utf-16le" } });
      },
    );

    it("decodes UTF-32 in both byte orders", () => {
      const le = Buffer.alloc(csv.length * 4);
      Array.from(csv).forEach((character, index) => le.writeUInt32LE(character.codePointAt(0)!, index * 4));
      const be = Buffer.alloc(csv.length * 4);
      Array.from(csv).forEach((character, index) => be.writeUInt32BE(character.codePointAt(0)!, index * 4));
      expect(read("le.csv", le)).toMatchObject({ content: "Name,Total\nAlpha,12\nBeta,7", details: { encoding: "utf-32le" } });
      expect(read("be.csv", Buffer.concat([Buffer.from([0, 0, 0xfe, 0xff]), be])))
        .toMatchObject({ content: "Name,Total\nAlpha,12\nBeta,7", details: { encoding: "utf-32be" } });
    });

    it("still reports random binary and text with stray NULs as binary", () => {
      let seed = 0x9e3779b9;
      const next = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed & 0xff; };
      for (let round = 0; round < 25; round += 1) {
        const bytes = Buffer.from(Array.from({ length: 512 + round * 300 }, next));
        bytes[100] = 0;
        expect(read(`random-${round}.bin`, bytes)).toEqual({ binary: true, sizeBytes: bytes.byteLength });
      }
      const stray = (text: Buffer) => Buffer.concat([text.subarray(0, 40), Buffer.from([0]), text.subarray(40)]);
      // UTF-8 Cyrillic with a NUL reads as plausible UTF-16BE Hangul; it must stay binary.
      expect(read("russian-nul.txt", stray(Buffer.from(russian.repeat(3))))).toMatchObject({ binary: true });
      expect(read("latin1-nul.txt", stray(Buffer.from("Le café est très bon à Genève.\n".repeat(20), "latin1")))).toMatchObject({ binary: true });
      const tsv = Buffer.from(Array.from({ length: 200 }, (_, row) => `${row}\t${row * 7 % 13}\n`).join(""));
      expect(read("numbers-nul.tsv", stray(tsv))).toMatchObject({ binary: true });
      // Binary records after an ASCII header (a PostScript CIDFont).
      const records = Buffer.from(Array.from({ length: 400 }, (_, index) => [0x00, 0x91, (index * 7) & 0xff, 0x03]).flat());
      expect(read("font.ps", Buffer.concat([Buffer.from("%!PS-Adobe-3.0 Resource-CIDFont\n".repeat(150)), records]))).toMatchObject({ binary: true });
    });
  });

  describe("Office files routed by content (H-011)", () => {
    let directory = "";
    beforeAll(() => { directory = mkdtempSync(join(tmpdir(), "berry-office-")); });
    afterAll(() => rmSync(directory, { recursive: true, force: true }));
    const local = (path: string) => join(directory, path.split("/").at(-1)!);
    // A real sandbox: files and the read helper run against local files.
    const manager = (documentTextExtractor: (input: { bytes: Uint8Array; mediaType: string }) => Promise<string>) => new SandboxContinuityManager({
      kind: "e2b",
      create: vi.fn(async () => ({ sandbox_id: "sandbox-contract", provider: "e2b", status: "running" })),
      exec: async function* (input: { command: string[] }) {
        if (input.command[2] === PI_READ_STREAM_SCRIPT) {
          const result = spawnSync(process.execPath, ["-e", PI_READ_STREAM_SCRIPT, local(input.command[3]!), ...input.command.slice(4)], { encoding: "utf8" });
          yield { kind: "stdout", data: result.stdout };
        }
        yield { kind: "exit", exit_code: 0, signal: null };
      },
      files: {
        read: vi.fn(async (input: { path: string }) => {
          const bytes = readFileSync(local(input.path));
          return { path: input.path, encoding: "base64" as const, content: bytes.toString("base64"), size_bytes: bytes.byteLength, mtime: null };
        }),
        write: vi.fn(),
        list: vi.fn(),
      },
    } as unknown as SandboxProvider, {
      loadRun: vi.fn(),
      continuity: vi.fn(async () => null),
      latest: vi.fn(async () => null),
      inputFiles: vi.fn(async () => []),
      persistOutput: vi.fn(),
      persist: vi.fn(),
      recordSandbox: vi.fn(async () => undefined),
    }, null, { image: "berry-sandbox", documentTextExtractor });
    const readFile = async (name: string, bytes: Buffer, extract: (input: { bytes: Uint8Array; mediaType: string }) => Promise<string>) => {
      writeFileSync(join(directory, name), bytes);
      return (await manager(extract).execute(snapshot(), toolStep("read", { path: `/workspace/inputs/file-id/${name}` }))).output as Record<string, unknown>;
    };

    it("detects an OLE2 Excel workbook by its streams inside the read helper", () => {
      const run = (name: string, bytes: Buffer) => {
        writeFileSync(join(directory, name), bytes);
        return JSON.parse(spawnSync(process.execPath, ["-e", PI_READ_STREAM_SCRIPT, join(directory, name), "1", "0", "2000", "51200", "2000"], { encoding: "utf8" }).stdout) as Record<string, unknown>;
      };
      expect(run("report.csv", ole2File(["Workbook", "\u0005SummaryInformation"]))).toMatchObject({ binary: true, mediaType: "application/vnd.ms-excel" });
      expect(run("old", ole2File(["Book"]))).toMatchObject({ binary: true, mediaType: "application/vnd.ms-excel" });
      expect(run("letter.txt", ole2File(["WordDocument", "1Table"]))).toMatchObject({ binary: true, mediaType: "application/msword" });
      expect(run("message.dat", ole2File(["__properties_version1.0"]))).toEqual({ binary: true, sizeBytes: 1536 });
    });

    it("extracts an .xls saved with a .csv name or no extension as a spreadsheet", async () => {
      const extract = vi.fn(async () => "Sheet1\nName\tTotal\nAlpha\t12");
      for (const name of ["export.csv", "export"]) {
        await expect(readFile(name, ole2File(["Workbook"]), extract)).resolves.toMatchObject({
          mediaType: "application/vnd.ms-excel",
          extractedText: true,
          detectedFromContent: true,
          content: expect.stringContaining("Alpha\t12\n\n[Read by content: this file is a legacy Excel workbook (.xls)"),
        });
      }
      expect(extract).toHaveBeenCalledTimes(2);
      expect(extract).toHaveBeenCalledWith(expect.objectContaining({ mediaType: "application/vnd.ms-excel" }));
    });

    it("reads HTML, XML Spreadsheet 2003 and CSV named .xls as text instead of failing in the xls extractor", async () => {
      const extract = vi.fn(async () => { throw new Error("Tika extraction failed with 422"); });
      const html = '<html xmlns:x="urn:schemas-microsoft-com:office:excel">\n<table><tr><td>Name</td><td>Total</td></tr><tr><td>Alpha</td><td>12</td></tr></table>\n</html>\n';
      await expect(readFile("report.xls", Buffer.from(html), extract)).resolves.toMatchObject({
        mediaType: "text/html",
        declaredMediaType: "application/vnd.ms-excel",
        content: expect.stringMatching(/<td>Alpha<\/td>[\s\S]*this file is HTML, not a binary Excel workbook[\s\S]*pandas\.read_html/),
      });
      const xml = '<?xml version="1.0"?>\n<?mso-application progid="Excel.Sheet"?>\n<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet">\n</Workbook>\n';
      await expect(readFile("sheet.xls", Buffer.from(xml), extract)).resolves.toMatchObject({
        mediaType: "application/xml",
        content: expect.stringContaining("XML Spreadsheet 2003 markup"),
      });
      const csv = "Name\tTotal\r\nAlpha\t12\r\n";
      await expect(readFile("unicode.xls", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(csv, "utf16le")]), extract)).resolves.toMatchObject({
        mediaType: "text/plain",
        encoding: "utf-16le",
        content: expect.stringContaining("Alpha\t12\n\n[Read by content"),
      });
      expect(extract).not.toHaveBeenCalled();
    });

    it("keeps extracting a correctly named .xls with the spreadsheet extractor", async () => {
      const extract = vi.fn(async () => "Sheet1\nAlpha\t12");
      await expect(readFile("real.xls", ole2File(["Workbook"]), extract)).resolves.toEqual(expect.objectContaining({
        mediaType: "application/vnd.ms-excel",
        content: "Sheet1\nAlpha\t12",
      }));
      expect(extract).toHaveBeenCalledWith(expect.objectContaining({ mediaType: "application/vnd.ms-excel" }));
    });
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

  it("lists commands that failed before a final success without changing the status (H-016)", () => {
    const run = (command: string) => spawnSync("bash", ["-c", PI_BASH_WRAPPER_SCRIPT, "berry-bash", command, "/dev/null"], { encoding: "utf8" });
    // Task 48f28292: curl failed (exit 35) and a trailing echo made the call look successful.
    const masked = run("printf downloading; false; echo done");
    expect(masked.status, masked.stderr).toBe(0);
    expect(masked.stdout).toContain("done");
    expect(masked.stdout).toContain("but these commands exited non-zero");
    expect(masked.stdout).toContain("exit 1: false");
    // The status the command reports, conditionals and successful runs are unchanged.
    expect(run('false; echo "status=$?"').stdout).toContain("status=1");
    for (const command of ["printf success", "if false; then :; fi; printf ok", "grep -q missing /dev/null || printf none"]) {
      const result = run(command);
      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain("exited non-zero");
    }
    const failed = run("false; exit 9");
    expect(failed.status).toBe(9);
    expect(failed.stdout).not.toContain("exited non-zero");
  });

  it("reports pipeline members that failed before a successful last member (H-016)", () => {
    const run = (command: string) => spawnSync("bash", ["-c", PI_BASH_WRAPPER_SCRIPT, "berry-bash", command, "/dev/null"], { encoding: "utf8" });
    // bash 3.2 (macOS) reports positions only; the sandboxes run bash 5, which also names the member.
    const named = Number(spawnSync("bash", ["-c", "echo ${BASH_VERSINFO[0]}"], { encoding: "utf8" }).stdout) >= 4;
    const expectReported = (command: string, status: string, member: string, position: string) => {
      const result = run(command);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("but these commands exited non-zero");
      expect(result.stdout).toContain(named ? `exit ${status}: ${member} (${position})` : `exit ${status}: ${position}`);
      return result.stdout;
    };
    const clean = (command: string) => {
      const result = run(command);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout, command).not.toContain("exited non-zero");
      return result.stdout;
    };
    // curl failing (exit 35) into tail, a Python crash into tail, and the same inside a function.
    expect(expectReported("sh -c 'echo partial; exit 35' | tail -5", "35", "sh -c 'echo partial; exit 35'", "pipeline member 1 of 2")).toContain("partial");
    expectReported("printf 'print(1)\\nraise SystemExit(1)\\n' > /tmp/berry-h016.py; python3 /tmp/berry-h016.py | tail -5", "1", "python3 /tmp/berry-h016.py", "pipeline member 1 of 2");
    expectReported("f() { false | cat; }; f; echo after", "1", "false", "pipeline member 1 of 2");
    // A multi-line script under set -e: both masked failures are listed and the script still runs on.
    const script = expectReported("set -e\ncd /\nfalse | cat\necho middle\nsh -c 'exit 9' | cat > /dev/null\necho end", "9", "sh -c 'exit 9'", "pipeline member 1 of 2");
    expect(script).toContain("middle\nend");
    expect(script).toContain(named ? "exit 1: false (pipeline member 1 of 2)" : "exit 1: pipeline member 1 of 2");
    // Normal idioms: SIGPIPE upstream of head or grep -q, yes | head, grep finding nothing mid-pipe.
    expect(clean("yes | head -1")).toBe("y\n");
    clean("seq 1 200000 | head -1; seq 1 200000 | grep -q 5; echo ok");
    if (named) clean("printf 'a\\n' | grep zzz | wc -l");
    // A failing last member is already reported by the ERR trap, once.
    const last = run("true | false; echo after");
    expect(last.stdout.match(/exit 1:/g)).toHaveLength(1);
    // Statuses, $? and PIPESTATUS are what the command would see without the traps, and pipefail is not imposed.
    expect(run("false | true").status).toBe(0);
    expect(run("false | true; echo \"status=$?\"").stdout).toContain("status=0");
    if (named) expect(run("false | (exit 3); echo \"ps=${PIPESTATUS[*]}\"").stdout).toContain("ps=1 3");
    expect(run("mkdir -p /tmp/berry-h016 && echo \"last=$_\"").stdout).toContain("last=/tmp/berry-h016");
    const failed = run("false | cat; exit 4");
    expect(failed.status).toBe(4);
    expect(failed.stdout).not.toContain("exited non-zero");
    // set -x output does not show the traps' own commands after the first one.
    expect(run("set -x; echo one; echo two").stderr).not.toMatch(/two[\s\S]*__berry/);
  });

  it("creates the workspace outputs and tmp directories before a command runs (H-008)", () => {
    const root = mkdtempSync(join(tmpdir(), "berry-workspace-"));
    try {
      const result = spawnSync("bash", ["-c", PI_BASH_WRAPPER_SCRIPT, "berry-bash", "test -d outputs && test -d tmp && printf ready", join(root, ".berry-tool-output", "bash-1.log")], {
        cwd: root,
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("ready");
      // Only the conventional log location implies a workspace root.
      const other = join(root, "other");
      const elsewhere = spawnSync("bash", ["-c", PI_BASH_WRAPPER_SCRIPT, "berry-bash", "printf ok", join(other, "logs", "bash-2.log")], { cwd: root, encoding: "utf8" });
      expect(elsewhere.status).toBe(0);
      expect(spawnSync("test", ["-e", join(other, "outputs")]).status).not.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
      if (input.command[0] === "pdfinfo") {
        expect(input.command).toEqual(["pdfinfo", "/workspace/inputs/file-id/reference.pdf"]);
        yield { kind: "stdout", data: "Pages:           2\n" };
      } else {
        expect(input.command).toEqual([
          "pdftotext",
          "-layout",
          "-f",
          "1",
          "-l",
          "2",
          "/workspace/inputs/file-id/reference.pdf",
          "-",
        ]);
        yield { kind: "stdout", data: "Page one text\fPage two text" };
      }
      yield { kind: "exit", exit_code: 0, signal: null };
    });

    await expect(manager.execute(snapshot(), toolStep("read", {
      path: "/workspace/inputs/file-id/reference.pdf",
    }))).resolves.toMatchObject({
      output: {
        path: "/workspace/inputs/file-id/reference.pdf",
        content: expect.stringContaining("--- Page 1 of 2 ---\nPage one text"),
        mediaType: "application/pdf",
        extractedText: true,
        totalPages: 2,
      },
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("extracts only the requested PDF pages even when the document is much larger", async () => {
    const commands: string[][] = [];
    const manager = managerWithProvider({
      read: vi.fn(),
      write: vi.fn(),
      list: vi.fn(),
    }, async function* (input: { command: string[] }) {
      commands.push(input.command);
      if (input.command[0] === "pdfinfo") yield { kind: "stdout", data: "Pages: 2000\n" };
      if (input.command[0] === "pdftotext") yield { kind: "stdout", data: "Page 1900 text" };
      yield { kind: "exit", exit_code: 0, signal: null };
    });

    await expect(manager.execute(snapshot(), toolStep("read", {
      path: "/workspace/inputs/file-id/large.pdf",
      page_start: 1900,
      page_end: 1900,
    }))).resolves.toMatchObject({
      output: {
        content: expect.stringContaining("--- Page 1900 of 2000 ---\nPage 1900 text"),
        totalPages: 2000,
        pageStart: 1900,
        pageEnd: 1900,
      },
    });
    expect(commands).toContainEqual([
      "pdftotext",
      "-layout",
      "-f",
      "1900",
      "-l",
      "1900",
      "/workspace/inputs/file-id/large.pdf",
      "-",
    ]);
  });

  it("shows one PDF page as an image when the model asks for it (H-049)", async () => {
    const commands: string[][] = [];
    const manager = managerWithProvider({
      read: vi.fn(),
      write: vi.fn(),
      list: vi.fn(),
    }, async function* (input: { command: string[] }) {
      commands.push(input.command);
      if (input.command[0] === "pdfinfo") yield { kind: "stdout", data: "Pages: 10\n" };
      yield { kind: "exit", exit_code: 0, signal: null };
    });

    const result = await manager.execute(snapshot(), toolStep("read", {
      path: "/workspace/inputs/file-id/rfp.pdf",
      page_start: 7,
      as_image: true,
    }));
    const imagePath = String((result.output as { visionPath?: unknown }).visionPath);
    expect(imagePath).toMatch(/^\/workspace\/tmp\/pdf-pages\/rfp-[0-9a-f]{8}-page-7\.png$/);
    expect(result.output).toMatchObject({
      path: imagePath,
      sourcePath: "/workspace/inputs/file-id/rfp.pdf",
      page: 7,
      totalPages: 10,
      binary: true,
      mediaType: "image/png",
      content: expect.stringContaining("will be attached to the next model request"),
    });
    expect(commands.at(-1)).toEqual([
      "sh",
      "-c",
      expect.stringContaining("pdftoppm -f \"$2\" -l \"$2\" -scale-to 2000 -png -singlefile"),
      "render-pdf-page",
      "/workspace/tmp/pdf-pages",
      "7",
      "/workspace/inputs/file-id/rfp.pdf",
      imagePath.replace(/\.png$/, ""),
    ]);
    expect(commands.some((command) => command[0] === "pdftotext")).toBe(false);

    await expect(manager.execute(snapshot(), toolStep("read", { path: "/workspace/inputs/file-id/rfp.pdf", page_start: 12, as_image: true })))
      .rejects.toThrow("Page 12 is beyond the end of this PDF (10 pages total).");
    await expect(manager.execute(snapshot(), toolStep("read", { path: "/workspace/inputs/file-id/rfp.pdf", page_start: 2, page_end: 4, as_image: true })))
      .rejects.toThrow("one PDF page per call");
    await expect(manager.execute(snapshot(), toolStep("read", { path: "/workspace/inputs/file-id/brief.docx", as_image: true })))
      .rejects.toThrow("as_image works only for PDF pages");
  });

  it("marks PDF pages without a text layer as not reviewed (H-049)", () => {
    // Task 383: the scope extract on page 7 of the RFP was an image.
    const pages = Array.from({ length: 10 }, (_, index) => index === 6 ? "" : `Section ${index + 1} requirements`);
    const result = piReadPdfContent(pages.join("\f"), {});
    expect(result.details).toMatchObject({ outputPages: 10, textCoverage: "partial", pagesWithoutText: [7] });
    expect(result.content).toContain("--- Page 7 of 10 ---\n[No extractable text on this page.]");
    expect(result.content).toContain("Page 7 has no extractable text");
    expect(result.content).toContain("Decide from the task whether it may matter");
    expect(result.content).toContain("read with page_start=7 and as_image=true");
    expect(result.content).toContain("Do not say information is missing from this document while relevant pages are unreviewed");

    const complete = piReadPdfContent("Intro\fScope\fFees", {});
    expect(complete.details).not.toHaveProperty("textCoverage");
    expect(complete.details).not.toHaveProperty("pagesWithoutText");
    expect(complete.content).not.toContain("not reviewed");
  });

  it("reads a requested PDF page range without making the model guess line offsets", () => {
    const result = piReadPdfContent("Page one\fPage two\fPage three", {
      page_start: 2,
      page_end: 2,
    });

    expect(result.content).toContain("--- Page 2 of 3 ---\nPage two");
    expect(result.content).not.toContain("Page one");
    expect(result.content).not.toContain("Page three");
    expect(result.details).toMatchObject({ totalPages: 3, pageStart: 2, pageEnd: 2, outputPages: 1, nextPageStart: 3 });
  });

  it("defaults large PDFs to a bounded page window with an exact continuation", () => {
    const source = Array.from({ length: 12 }, (_, index) => `Page ${index + 1}`).join("\f");
    const result = piReadPdfContent(source, {});

    expect(result.content).toContain("--- Page 1 of 12 ---");
    expect(result.content).toContain("--- Page 10 of 12 ---");
    expect(result.content).not.toContain("--- Page 11 of 12 ---");
    expect(result.content).toContain("Use page_start=11 and page_end=12 to continue");
    expect(result.details).toMatchObject({
      totalPages: 12,
      pageStart: 1,
      pageEnd: 10,
      nextPageStart: 11,
      nextPageEnd: 12,
    });
  });

  it("continues large PDFs in bounded multi-page windows", () => {
    const source = Array.from({ length: 25 }, (_, index) => `Page ${index + 1}`).join("\f");
    const result = piReadPdfContent(source, {});

    expect(result.content).toContain("Use page_start=11 and page_end=20 to continue");
    expect(result.details).toMatchObject({ nextPageStart: 11, nextPageEnd: 20 });
  });

  it("keeps page markers when continuing inside a PDF page range", () => {
    const result = piReadPdfContent("First line\nSecond line\nThird line", {
      page_start: 1,
      page_end: 1,
      offset: 2,
      limit: 2,
    });

    expect(result.content).toContain("First line\nSecond line");
    expect(result.content).toContain("Use offset=4 to continue");
    expect(result.details).toMatchObject({ totalPages: 1, pageStart: 1, pageEnd: 1 });
  });

  it("returns the next offset when a selected PDF range exceeds the read limit", () => {
    const largePage = Array.from({ length: 2_000 }, (_, index) => `Line ${index + 1} ${"x".repeat(40)}`).join("\n");
    const result = piReadPdfContent(`${largePage}\fSecond page`, {
      page_start: 1,
      page_end: 2,
    });

    expect(result.details).toMatchObject({
      truncated: true,
      nextOffset: expect.any(Number),
      pageStart: 1,
      pageEnd: 2,
    });
    expect(result.content).toMatch(/Continue with page_start=1, page_end=2, offset=\d+/);
  });

  it("extracts Office document text through the shared document extractor", async () => {
    const bytes = Buffer.from("PK\u0003\u0004binary docx bytes", "latin1");
    const read = vi.fn(async () => ({
      path: "/workspace/inputs/file-id/requirements.docx",
      encoding: "base64" as const,
      content: bytes.toString("base64"),
      size_bytes: bytes.byteLength,
      mtime: null,
    }));
    const documentTextExtractor = vi.fn(async () => "Award requirements\nMaximum 1,500 words");
    const manager = managerWithProvider({ read, write: vi.fn(), list: vi.fn() }, undefined, {
      documentTextExtractor,
    });

    await expect(manager.execute(snapshot(), toolStep("read", {
      path: "/workspace/inputs/file-id/requirements.docx",
    }))).resolves.toMatchObject({
      output: {
        content: "Award requirements\nMaximum 1,500 words",
        mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        extractedText: true,
      },
    });
    expect(documentTextExtractor).toHaveBeenCalledWith(expect.objectContaining({
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }));
  });

  it("reuses one Office extraction across paginated reads of unchanged bytes (H-067)", async () => {
    let bytes = Buffer.from("PK\u0003\u0004docx bytes v1", "latin1");
    const read = vi.fn(async (input: { path: string }) => ({
      path: input.path, encoding: "base64" as const, content: bytes.toString("base64"), size_bytes: bytes.byteLength, mtime: null,
    }));
    let failNext = false;
    const documentTextExtractor = vi.fn(async (input: { bytes: Uint8Array }) => {
      if (failNext) { failNext = false; throw new Error("Tika timed out"); }
      return Array.from({ length: 40 }, (_, index) => `Line ${index + 1} of ${Buffer.from(input.bytes).subarray(4).toString()}`).join("\n");
    });
    const manager = managerWithProvider({ read, write: vi.fn(), list: vi.fn() }, undefined, { documentTextExtractor });
    const page = (offset: number) => manager.execute(snapshot(), toolStep("read", { path: "/workspace/inputs/file-id/spec.docx", offset, limit: 10 }));

    await expect(page(1)).resolves.toMatchObject({ output: { content: expect.stringContaining("Line 1 of docx bytes v1") } });
    await expect(page(11)).resolves.toMatchObject({ output: { content: expect.stringContaining("Line 11 of docx bytes v1") } });
    expect(documentTextExtractor).toHaveBeenCalledTimes(1);

    bytes = Buffer.from("PK\u0003\u0004docx bytes v2", "latin1");
    failNext = true;
    await expect(page(1)).rejects.toThrow("Tika timed out");
    await expect(page(1)).resolves.toMatchObject({ output: { content: expect.stringContaining("Line 1 of docx bytes v2") } });
    expect(documentTextExtractor).toHaveBeenCalledTimes(3);
  });

  it("extracts macro-enabled Excel through the shared document extractor", async () => {
    const bytes = Buffer.from("PK\u0003\u0004binary xlsm bytes", "latin1");
    const read = vi.fn(async () => ({
      path: "/workspace/inputs/file-id/forecast.xlsm",
      encoding: "base64" as const,
      content: bytes.toString("base64"),
      size_bytes: bytes.byteLength,
      mtime: null,
    }));
    const documentTextExtractor = vi.fn(async () => "Forecast assumptions\nRevenue plan");
    const manager = managerWithProvider({ read, write: vi.fn(), list: vi.fn() }, undefined, {
      documentTextExtractor,
    });

    await expect(manager.execute(snapshot(), toolStep("read", {
      path: "/workspace/inputs/file-id/forecast.xlsm",
    }))).resolves.toMatchObject({
      output: {
        content: "Forecast assumptions\nRevenue plan",
        mediaType: "application/vnd.ms-excel.sheet.macroEnabled.12",
        extractedText: true,
      },
    });
    expect(documentTextExtractor).toHaveBeenCalledWith(expect.objectContaining({
      mediaType: "application/vnd.ms-excel.sheet.macroEnabled.12",
    }));
  });

  it("safely extracts ZIP attachments and exposes exact nested document paths", async () => {
    const read = vi.fn();
    const list = vi.fn(async (input: { path: string }) => input.path.includes("/tmp/archives/")
      ? {
          path: input.path,
          entries: [
            { path: `${input.path}/brief.pdf`, type: "file", size_bytes: 123 },
            { path: `${input.path}/notes.txt`, type: "file", size_bytes: 45 },
          ],
        }
      : { path: input.path, entries: [] });
    const commands: string[][] = [];
    const manager = managerWithProvider({ read, write: vi.fn(), list }, async function* (input: { command: string[] }) {
      commands.push(input.command);
      if (input.command[0] === "python" && input.command[1] === "-c") {
        yield {
          kind: "stdout",
          data: JSON.stringify({
            entryCount: 2,
            totalBytes: 168,
          }),
        };
      }
      yield { kind: "exit", exit_code: 0, signal: null };
    });

    await expect(manager.execute(snapshot(), toolStep("read", {
      path: "/workspace/inputs/file-id/evidence.zip",
    }))).resolves.toMatchObject({
      output: {
        mediaType: "application/zip",
        extractedArchive: true,
        entryCount: 2,
        entriesShown: 2,
        inventoryTruncated: false,
        content: expect.stringContaining("/tmp/archives/"),
      },
    });
    expect(commands.some((command) => command[0] === "mkdir" && command[1] === "-p")).toBe(true);
    expect(commands.some((command) => command[0] === "python" && command[1] === "-c")).toBe(true);
    expect(commands.some((command) => command[0] === "unzip" && command.includes("-d"))).toBe(true);
  });

  it("returns a binary receipt instead of NUL text when the read helper reports binary data (H-011)", async () => {
    const manager = new SandboxContinuityManager({
      kind: "e2b",
      create: vi.fn(async () => ({ sandbox_id: "sandbox-contract", provider: "e2b", status: "running" })),
      exec: async function* (input: { command: string[] }) {
        if (input.command[2] === PI_READ_STREAM_SCRIPT) yield { kind: "stdout", data: JSON.stringify({ binary: true, sizeBytes: 18 }) };
        yield { kind: "exit", exit_code: 0, signal: null };
      },
      files: { read: vi.fn(), write: vi.fn(), list: vi.fn() },
    } as unknown as SandboxProvider, {
      loadRun: vi.fn(),
      continuity: vi.fn(async () => null),
      latest: vi.fn(async () => null),
      inputFiles: vi.fn(async () => []),
      persistOutput: vi.fn(),
      persist: vi.fn(),
      recordSandbox: vi.fn(async () => undefined),
    }, null, { image: "berry-sandbox" });

    const result = await manager.execute(snapshot(), toolStep("read", { path: "/workspace/inputs/file-id/bundle.dat" }));
    expect(result.output).toMatchObject({ binary: true, mediaType: "application/octet-stream", sizeBytes: 18 });
    expect(JSON.stringify(result.output)).not.toContain("\\u0000");
  });

  it("routes skill packages to safe ZIP extraction and slideshows to the document extractor (H-011)", async () => {
    const list = vi.fn(async (input: { path: string }) => ({
      path: input.path,
      entries: input.path.includes("/tmp/archives/") ? [{ path: `${input.path}/SKILL.md`, type: "file", size_bytes: 120 }] : [],
    }));
    const bytes = Buffer.from("PK\u0003\u0004binary ppsx bytes", "latin1");
    const read = vi.fn(async (input: { path: string }) => ({
      path: input.path,
      encoding: "base64" as const,
      content: bytes.toString("base64"),
      size_bytes: bytes.byteLength,
      mtime: null,
    }));
    const documentTextExtractor = vi.fn(async () => "Quarterly review\nSlide 2: Risks");
    const manager = managerWithProvider({ read, write: vi.fn(), list }, async function* (input: { command: string[] }) {
      if (input.command[0] === "python" && input.command[1] === "-c") {
        yield { kind: "stdout", data: JSON.stringify({ entryCount: 1, totalBytes: 120 }) };
      }
      yield { kind: "exit", exit_code: 0, signal: null };
    }, { documentTextExtractor });

    await expect(manager.execute(snapshot(), toolStep("read", {
      path: "/workspace/inputs/file-id/bundle.skill",
    }))).resolves.toMatchObject({
      output: { mediaType: "application/zip", extractedArchive: true, entryCount: 1, content: expect.stringContaining("SKILL.md") },
    });
    await expect(manager.execute(snapshot(), toolStep("read", {
      path: "/workspace/inputs/file-id/review.ppsx",
    }))).resolves.toMatchObject({
      output: {
        content: "Quarterly review\nSlide 2: Risks",
        mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        extractedText: true,
      },
    });
  });

  it("applies bounded pagination to page-numbered PDF text", async () => {
    const manager = managerWithProvider({
      read: vi.fn(),
      write: vi.fn(),
      list: vi.fn(),
    }, async function* (input: { command: string[] }) {
      yield {
        kind: "stdout",
        data: input.command[0] === "pdfinfo"
          ? "Pages: 1\n"
          : Array.from({ length: 10 }, (_, index) => `page line ${index + 1}`).join("\n"),
      };
      yield { kind: "exit", exit_code: 0, signal: null };
    });

    await expect(manager.execute(snapshot(), toolStep("read", {
      path: "/workspace/inputs/file-id/reference.pdf",
      offset: 3,
      limit: 2,
    }))).resolves.toMatchObject({
      output: {
        content: expect.stringContaining("page line 2\npage line 3"),
        mediaType: "application/pdf",
        extractedText: true,
        totalPages: 1,
      },
    });
  });

  it("returns binary metadata instead of sending image bytes through the UTF-8 reader", async () => {
    const read = vi.fn();
    const manager = managerWithProvider({
      read,
      write: vi.fn(),
      list: vi.fn(async () => ({
        path: "/workspace/tmp/rendered",
        entries: [{ path: "/workspace/tmp/rendered/page-1.png", type: "file", size_bytes: 68, mtime: null }],
      })),
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

  it("rejects reading an image path that does not exist instead of promising its pixels", async () => {
    const list = vi.fn(async () => ({ path: "/workspace/outputs", entries: [{ path: "/workspace/outputs/contact-sheet.png", type: "file", size_bytes: 10, mtime: null }] }));
    const manager = managerWithProvider({ read: vi.fn(), write: vi.fn(), list });

    await expect(manager.execute(snapshot(), toolStep("read", { path: "/workspace/outputs/contact_sheet.png" })))
      .rejects.toThrow("File not found: /workspace/outputs/contact_sheet.png");
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ path: "/workspace/outputs", recursive: false }));
  });

  describe("images read earlier in the turn", () => {
    const completedRead = (path: string, sequence: number): DurableTurnStep => ({
      ...toolStep("read", { path }),
      id: `00000000-0000-7000-8000-${String(100 + sequence).padStart(12, "0")}`,
      sequence,
      state: "completed",
      output: { path, binary: true, mediaType: "image/png", visionPath: path },
    });
    const managerFor = async (missing: ReadonlySet<string>) => {
      const png = await testPng(7);
      const read = vi.fn(async (input: { path: string }) => {
        if (missing.has(input.path)) {
          throw Object.assign(new Error(`path not found: ${input.path}`), { name: "FileNotFoundError" });
        }
        return { path: input.path, content: png.toString("base64"), size_bytes: png.byteLength, mtime: null };
      });
      const provider = {
        kind: "e2b",
        create: vi.fn(),
        resume: vi.fn(async () => ({ sandbox_id: "sandbox-images", provider: "e2b", status: "running" })),
        files: { read, write: vi.fn(), list: vi.fn() },
      } as unknown as SandboxProvider;
      const repository = {
        loadRun: vi.fn(), continuity: vi.fn(), latest: vi.fn(), inputFiles: vi.fn(async () => []),
        persistOutput: vi.fn(), persist: vi.fn(), recordSandbox: vi.fn(),
      } satisfies SandboxSnapshotRepository;
      return { manager: new SandboxContinuityManager(provider, repository, null, { image: "berry-sandbox" }), read };
    };
    const current = (steps: DurableTurnStep[]) => {
      const value = snapshot();
      value.sandboxId = "sandbox-images";
      value.sandboxProvider = "e2b";
      value.sandboxState = "running";
      value.steps = steps;
      return value;
    };

    it("turns a moved or deleted earlier image into a notice instead of failing model preparation", async () => {
      const { manager } = await managerFor(new Set(["/workspace/tmp/contact-sheet.png"]));
      const content = await manager.modelContent(current([
        completedRead("/workspace/tmp/contact-sheet.png", 1),
        completedRead("/workspace/outputs/final.png", 2),
      ]));

      expect(content[0]).toEqual({ type: "text", text: expect.stringContaining("no longer exists at this path") });
      expect(content[0]).toEqual({ type: "text", text: expect.stringContaining("/workspace/tmp/contact-sheet.png") });
      expect(content.filter((part) => part.type === "image_url")).toHaveLength(1);
      expect(content).toContainEqual({ type: "text", text: 'Workspace image "/workspace/outputs/final.png"' });
    });

    it("makes a re-read older image eligible for the next request", async () => {
      const { manager, read } = await managerFor(new Set());
      const paths = [1, 2, 3, 4, 5, 6].map((index) => `/workspace/photos/candidate-${index}.png`);
      await manager.modelContent(current([
        ...paths.map((path, index) => completedRead(path, index + 1)),
        completedRead(paths[0]!, 7),
      ]));

      expect(read.mock.calls.map(([input]) => input.path)).toEqual([...paths.slice(2), paths[0]]);
    });

    it("discloses images from the latest batch that do not fit the five-image window", async () => {
      const { manager, read } = await managerFor(new Set());
      const delivered = completedRead("/workspace/pages/cover.png", 1);
      const modelCall = { ...toolStep("unused", {}), id: "00000000-0000-7000-8000-000000000150", sequence: 2, type: "model.call", state: "completed" } as DurableTurnStep;
      const batch = [1, 2, 3, 4, 5, 6, 7].map((page) => completedRead(`/workspace/pages/page-${page}.png`, page + 2));
      const content = await manager.modelContent(current([delivered, modelCall, ...batch]));

      expect(read.mock.calls.map(([input]) => input.path)).toEqual([3, 4, 5, 6, 7].map((page) => `/workspace/pages/page-${page}.png`));
      const notices = content.flatMap((part) => part.type === "text" && part.text.startsWith("[Image not sent:") ? [part.text] : []);
      expect(notices).toHaveLength(2);
      expect(notices[0]).toContain("/workspace/pages/page-1.png");
      expect(notices[1]).toContain("/workspace/pages/page-2.png");
      expect(notices.join("\n")).not.toContain("cover.png");
    });

    it("keeps whole batches in place and starts a new block only when a batch does not fit", () => {
      const modelCall = (sequence: number) => ({
        ...toolStep("unused", {}),
        id: `00000000-0000-7000-8000-${String(300 + sequence).padStart(12, "0")}`,
        sequence,
        type: "model.call",
        state: "completed",
      }) as DurableTurnStep;
      const first = [1, 2, 3].map((page) => completedRead(`/workspace/pages/a-${page}.png`, page));
      const second = [5, 6].map((sequence, index) => completedRead(`/workspace/pages/b-${index + 1}.png`, sequence));
      const third = completedRead("/workspace/pages/c-1.png", 8);
      const paths = (steps: DurableTurnStep[]) => steps.map((step) => String((step.output as { visionPath: string }).visionPath));

      // Each request extends the previous one: images already sent stay where they were.
      expect(exposedSandboxImages({ steps: first })).toEqual({ selected: paths(first), withheld: [], attachments: [] });
      expect(exposedSandboxImages({ steps: [...first, modelCall(4), ...second] }))
        .toEqual({ selected: paths([...first, ...second]), withheld: [], attachments: [] });
      // The next batch does not fit, so the earlier block is dropped as a whole once.
      expect(exposedSandboxImages({ steps: [...first, modelCall(4), ...second, modelCall(7), third] }))
        .toEqual({ selected: paths([third]), withheld: [], attachments: [] });
    });

    it("keeps the newest images of a batch larger than the window and discloses the rest", () => {
      const batch = [1, 2, 3].map((page) => completedRead(`/workspace/pages/page-${page}.png`, page));

      expect(exposedSandboxImages({ steps: batch }, 2)).toEqual({
        selected: ["/workspace/pages/page-2.png", "/workspace/pages/page-3.png"],
        withheld: ["/workspace/pages/page-1.png"],
        attachments: [],
      });
      expect(exposedSandboxImages({ steps: batch }, 0)).toEqual({
        selected: [],
        withheld: batch.map((step) => String((step.output as { visionPath: string }).visionPath)),
        attachments: [],
      });
    });

    it("prepares once more after the sandbox disappears mid-preparation (H-009)", async () => {
      const { manager, read } = await managerFor(new Set());
      const original = read.getMockImplementation()!;
      read.mockImplementationOnce(async () => {
        throw Object.assign(new Error("The sandbox was not found"), { name: "SandboxNotFoundError" });
      });
      read.mockImplementation(original);

      const content = await manager.modelContent(current([completedRead("/workspace/outputs/final.png", 1)]));
      expect(content.filter((part) => part.type === "image_url")).toHaveLength(1);
      expect(read).toHaveBeenCalledTimes(2);
    });

    it("still reports an explicitly requested missing image as an inspection error", async () => {
      const { manager } = await managerFor(new Set(["/workspace/tmp/missing.png"]));
      await expect(manager.modelContent(current([
        { ...toolStep("inspect_images", { mode: "focused", paths: ["/workspace/tmp/missing.png"], question: "What is shown?" }), state: "running" },
      ]))).rejects.toThrow("inspect_images could not load the exact requested image path: /workspace/tmp/missing.png");
    });
  });

  it("supplies task attachments and requested sandbox images as model vision content", async () => {
    const generated = await testPng(9);
    const attached = await testPng(1);
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
      streamSource: vi.fn(async function* (key: string) {
        yield key.endsWith("brief.pdf") ? new Uint8Array(5) : attached;
      }),
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

    // Attachments take their slots first (H-032); each image is placed by its label.
    await expect(manager.modelContent(current)).resolves.toEqual([
      { type: "text", text: 'Workspace image "/workspace/inputs/00000000-0000-7000-8000-000000000090/reference.png"' },
      {
        type: "image_url",
        image_url: { url: `data:image/png;base64,${attached.toString("base64")}` },
      },
      { type: "text", text: 'Workspace image "/workspace/outputs/chart.png"' },
      {
        type: "image_url",
        image_url: { url: `data:image/png;base64,${generated.toString("base64")}` },
      },
    ]);
    expect(provider.files.read).toHaveBeenCalledWith({
      sandbox_id: "sandbox-existing",
      path: "/workspace/outputs/chart.png",
      encoding: "base64",
    });
    // All inputs are staged, while only the selected image is loaded into the
    // model's vision content.
    expect(provider.files.write).toHaveBeenCalledTimes(2);
    expect(objects.getSource).toHaveBeenCalledTimes(1);
    expect(objects.getSource).toHaveBeenCalledWith(
      "artifacts/tenants/t/reference.png",
      "reference-version-7",
      undefined,
    );
  });

  describe("attachments and images read later in the turn", () => {
    const fileId = (index: number) => `00000000-0000-7000-8000-${String(100 + index).padStart(12, "0")}`;
    const attachmentPath = (index: number) => `/workspace/inputs/${fileId(index)}/reference-${index}.png`;
    const crop = "/workspace/outputs/cropped-detail.png";
    const modelCall = (sequence: number) => ({
      ...toolStep("unused", {}),
      id: `00000000-0000-7000-8000-${String(400 + sequence).padStart(12, "0")}`,
      sequence,
      type: "model.call",
      state: "completed",
    }) as DurableTurnStep;
    const completedRead = (path: string, sequence: number): DurableTurnStep => ({
      ...toolStep("read", { path }),
      id: `00000000-0000-7000-8000-${String(500 + sequence).padStart(12, "0")}`,
      sequence,
      state: "completed",
      output: { path, binary: true, mediaType: "image/png", visionPath: path },
    });
    const setup = async (attachmentCount: number, oversized: ReadonlySet<number> = new Set()) => {
      const attached = await testPng(1);
      const generated = await testPng(2);
      const read = vi.fn(async (input: { path: string }) => ({ path: input.path, content: generated.toString("base64"), size_bytes: generated.length, mtime: null }));
      const provider = {
        kind: "e2b",
        create: vi.fn(),
        resume: vi.fn(async () => ({ sandbox_id: "existing", provider: "e2b", status: "running" })),
        exec: async function* () { yield { kind: "exit", exit_code: 0, signal: null }; },
        files: { read, write: vi.fn(), list: vi.fn(async (input: { path: string }) => ({ path: input.path, entries: [] })) },
      } as unknown as SandboxProvider;
      const repository = {
        loadRun: vi.fn(), continuity: vi.fn(async () => null), latest: vi.fn(async () => null),
        inputFiles: vi.fn(async () => Array.from({ length: attachmentCount }, (_, index) => ({
          fileId: fileId(index + 1), name: `reference-${index + 1}.png`, mediaType: "image/png",
          sizeBytes: oversized.has(index + 1) ? MODEL_IMAGE_LIMITS.maxSourceBytes + 1 : attached.length, objectKey: `reference-${index + 1}`,
        }))),
        persistOutput: vi.fn(), persist: vi.fn(), recordSandbox: vi.fn(),
      } satisfies SandboxSnapshotRepository;
      const objects = {
        put: vi.fn(), putArtifact: vi.fn(), get: vi.fn(), getSource: vi.fn(async () => attached),
        streamSource: vi.fn(async function* (key: string) {
          yield oversized.has(Number(/reference-(\d+)/.exec(key)?.[1])) ? new Uint8Array(MODEL_IMAGE_LIMITS.maxSourceBytes + 1) : attached;
        }),
      } satisfies SandboxSnapshotObjectStore;
      const manager = new SandboxContinuityManager(provider, repository, objects, { image: "berry" });
      const current = (steps: DurableTurnStep[]) => {
        const value = snapshot();
        value.sandboxId = "existing";
        value.sandboxProvider = "e2b";
        value.sandboxState = "running";
        value.steps = steps;
        return value;
      };
      // The image each label names, as the model receives it.
      const shown = (content: readonly { type: string; text?: string; image_url?: { url: string } }[]) => content.flatMap((part, index) => {
        const next = content[index + 1];
        const match = part.type === "text" ? /^Workspace image ("[^"]+")/.exec(part.text ?? "") : null;
        return match && next?.type === "image_url" ? [{ path: JSON.parse(match[1]!) as string, url: next.image_url!.url }] : [];
      });
      const notices = (content: readonly { type: string; text?: string }[]) =>
        content.flatMap((part) => part.type === "text" && part.text?.startsWith("[Image not sent:") ? [part.text] : []);
      return { manager, current, read, objects, shown, notices, attached, generated };
    };

    it("sends a newly read image to the model when five attachments filled the window, and keeps sending it", async () => {
      const { manager, current, read, objects, shown, notices, generated } = await setup(5);
      const before = await manager.modelContent(current([]));
      expect(shown(before).map((image) => image.path)).toEqual([1, 2, 3, 4, 5].map(attachmentPath));

      const steps = [modelCall(1), completedRead(crop, 2)];
      const first = await manager.modelContent(current(steps));
      expect(shown(first)).toEqual([{ path: crop, url: `data:image/png;base64,${generated.toString("base64")}` }]);
      expect(read.mock.calls.map(([input]) => input.path)).toEqual([crop]);
      // The attachments gave up their slots; each one says so and how to see it again.
      expect(notices(first)).toHaveLength(5);
      for (const [index, notice] of notices(first).entries()) {
        expect(notice).toContain(JSON.stringify(attachmentPath(index + 1)));
        expect(notice).toContain("newer images took its place");
        expect(notice).not.toContain("Do not repeat read");
      }
      expect(objects.getSource).toHaveBeenCalledTimes(5);

      // A reread of the same image keeps its pixels in the request.
      const reread = await manager.modelContent(current([...steps, modelCall(3), completedRead(crop, 4)]));
      expect(shown(reread).map((image) => image.path)).toEqual([crop]);
      // The attachments do not come back on later calls, so the request only grows.
      const later = await manager.modelContent(current([...steps, modelCall(3), completedRead(crop, 4), modelCall(5)]));
      expect(shown(later).map((image) => image.path)).toEqual([crop]);
      expect(objects.getSource).toHaveBeenCalledTimes(5);
    });

    it("shows an attachment again when the model reads its path after it gave up its slot", async () => {
      const { manager, current, read, shown, notices } = await setup(5);
      const content = await manager.modelContent(current([modelCall(1), completedRead(crop, 2), modelCall(3), completedRead(attachmentPath(2), 4)]));

      expect(shown(content).map((image) => image.path)).toEqual([crop, attachmentPath(2)]);
      expect(read.mock.calls.map(([input]) => input.path)).toEqual([crop, attachmentPath(2)]);
      expect(notices(content).map((notice) => notice.includes(JSON.stringify(attachmentPath(2))))).not.toContain(true);
      expect(notices(content)).toHaveLength(4);
    });

    it("keeps attachments in place while later images still fit beside them", async () => {
      const { manager, current, read, shown, notices } = await setup(3);
      const content = await manager.modelContent(current([modelCall(1), completedRead(crop, 2)]));

      expect(shown(content).map((image) => image.path)).toEqual([...[1, 2, 3].map(attachmentPath), crop]);
      expect(read.mock.calls.map(([input]) => input.path)).toEqual([crop]);
      expect(notices(content)).toEqual([]);
    });

    it("does not move a shown attachment when the model reads it again", async () => {
      const { manager, current, read, shown } = await setup(5);
      const content = await manager.modelContent(current([modelCall(1), completedRead(attachmentPath(1), 2)]));

      expect(shown(content).map((image) => image.path)).toEqual([1, 2, 3, 4, 5].map(attachmentPath));
      expect(read).not.toHaveBeenCalled();
    });

    it("does not give up attachment slots for an attachment that cannot be shown", async () => {
      const { manager, current, read, shown, notices } = await setup(6, new Set([6]));
      const content = await manager.modelContent(current([modelCall(1), completedRead(attachmentPath(6), 2)]));

      expect(shown(content).map((image) => image.path)).toEqual([1, 2, 3, 4, 5].map(attachmentPath));
      expect(read).not.toHaveBeenCalled();
      expect(notices(content)).toEqual([expect.stringContaining("exceeds the 20 MiB image inspection limit")]);
    });

    it("says when an attachment beyond the first five is not shown, and shows it when read", async () => {
      const { manager, current, shown, notices } = await setup(6);
      const before = await manager.modelContent(current([]));
      expect(shown(before).map((image) => image.path)).toEqual([1, 2, 3, 4, 5].map(attachmentPath));
      expect(notices(before)).toEqual([expect.stringContaining(JSON.stringify(attachmentPath(6)))]);

      const content = await manager.modelContent(current([modelCall(1), completedRead(attachmentPath(6), 2)]));
      expect(shown(content).map((image) => image.path)).toEqual([attachmentPath(6)]);
      expect(notices(content)).toHaveLength(5);
      expect(notices(content).join("\n")).not.toContain(JSON.stringify(attachmentPath(6)));
    });

    it("selects whole batches and lets attachments yield only once", () => {
      const attachments = [1, 2, 3].map(attachmentPath);
      const first = [completedRead("/workspace/pages/a-1.png", 2), completedRead("/workspace/pages/a-2.png", 3)];
      const second = completedRead("/workspace/pages/b-1.png", 5);
      const third = completedRead("/workspace/pages/c-1.png", 7);

      expect(exposedSandboxImages({ steps: [modelCall(1), ...first] }, 5, attachments))
        .toEqual({ selected: ["/workspace/pages/a-1.png", "/workspace/pages/a-2.png"], withheld: [], attachments });
      // The next batch does not fit beside the attachments: they yield, and
      // the earlier batch keeps its place.
      expect(exposedSandboxImages({ steps: [modelCall(1), ...first, modelCall(4), second] }, 5, attachments))
        .toEqual({ selected: ["/workspace/pages/a-1.png", "/workspace/pages/a-2.png", "/workspace/pages/b-1.png"], withheld: [], attachments: [] });
      // Later batches never bring them back, even when the window has room.
      expect(exposedSandboxImages({ steps: [modelCall(1), ...first, modelCall(4), second, modelCall(6), third] }, 5, attachments).attachments)
        .toEqual([]);
    });
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
      recordArtifactOperationStart: vi.fn(async (_input: { operationKey: string }) => undefined),
      recordArtifactOperationStorage: vi.fn(async () => undefined),
      completeArtifactOperation: vi.fn(async () => undefined),
      failArtifactOperation: vi.fn(async () => undefined),
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
      name: "Project report",
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
    expect(repository.persistOutput).toHaveBeenCalledWith(expect.objectContaining({
      name: "Project report.pdf",
      mediaType: "application/pdf",
    }));
    await expect(manager.execute(snapshot(), toolStep("persist_artifact", {
      path: "/workspace/tmp/private.pdf",
    }))).rejects.toThrow("Artifacts must be created under /workspace/outputs");
  });

  it("returns the earlier receipt for identical bytes and publishes changed bytes (H-028)", async () => {
    let content = Buffer.from("schedule v1");
    const provider = {
      kind: "e2b",
      create: vi.fn(async () => ({ sandbox_id: "sandbox-publish", provider: "e2b", status: "running" })),
      exec: vi.fn(),
      files: {
        read: vi.fn(async (input: { path: string }) => ({ path: input.path, content: content.toString("base64"), size_bytes: content.byteLength, mtime: null })),
        write: vi.fn(),
        list: vi.fn(async (input: { path: string }) => ({ path: input.path, entries: [] })),
      },
    } as unknown as SandboxProvider;
    const repository = {
      loadRun: vi.fn(),
      continuity: vi.fn(async () => null),
      latest: vi.fn(async () => null),
      inputFiles: vi.fn(async () => []),
      persistOutput: vi.fn(async (input: { fileId: string; name: string; mediaType: string; sizeBytes: number; objectKey: string }) => ({
        fileId: input.fileId, name: input.name, mediaType: input.mediaType, sizeBytes: input.sizeBytes, objectKey: input.objectKey,
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
    const publish = (sequence: number) => ({ ...toolStep("persist_artifact", { path: "/workspace/outputs/schedule.txt" }), id: `publish-${sequence}`, sequence });

    const first = await manager.execute(current, publish(1));
    current.steps = [{ ...publish(1), state: "completed", output: first.output }];
    const repeated = await manager.execute(current, publish(3));
    expect(repeated.output).toMatchObject({ unchanged: true, artifact: (first.output as { artifact: unknown }).artifact });
    expect(objects.putArtifact).toHaveBeenCalledTimes(1);

    content = Buffer.from("schedule v2");
    const changed = await manager.execute(current, publish(5));
    expect(changed.output).not.toHaveProperty("unchanged");
    expect((changed.output as { sha256: string }).sha256).not.toBe((first.output as { sha256: string }).sha256);
    expect(objects.putArtifact).toHaveBeenCalledTimes(2);
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
      recordArtifactOperationStart: vi.fn(async (_input: { operationKey: string }) => undefined),
      recordArtifactOperationStorage: vi.fn(async () => undefined),
      completeArtifactOperation: vi.fn(async () => undefined),
      failArtifactOperation: vi.fn(async () => undefined),
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
    expect(repository.recordArtifactOperationStart).toHaveBeenCalledTimes(2);
    expect(repository.recordArtifactOperationStorage).toHaveBeenCalledTimes(2);
    expect(repository.completeArtifactOperation).toHaveBeenCalledTimes(2);
    expect(new Set(repository.recordArtifactOperationStart.mock.calls.map(([input]) => input.operationKey)).size).toBe(2);
  });

  it("treats an absent optional output directory as an empty finalization", async () => {
    const missing = new Error("[not_found] path not found: no such file or directory");
    missing.name = "FileNotFoundError";
    const provider = {
      kind: "e2b",
      create: vi.fn(),
      exec: vi.fn(),
      files: {
        read: vi.fn(),
        write: vi.fn(),
        list: vi.fn(async (input: { path: string }) => {
          if (input.path.endsWith("/outputs")) throw missing;
          return { path: input.path, entries: [] };
        }),
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
    const objects = {
      put: vi.fn(),
      putArtifact: vi.fn(),
      get: vi.fn(),
      getSource: vi.fn(),
    } satisfies SandboxSnapshotObjectStore;
    const manager = new SandboxContinuityManager(provider, repository, objects, { image: "berry-sandbox" });
    const current = snapshot();
    current.sandboxId = "sandbox-no-outputs";
    current.sandboxProvider = "e2b";
    current.sandboxState = "running";
    current.steps = [];

    await expect(manager.finalize(current)).resolves.toEqual([]);
    expect(objects.putArtifact).not.toHaveBeenCalled();
    expect(repository.persistOutput).not.toHaveBeenCalled();
  });

  it.each([
    ["a text-only answer", [] as string[], "completes"],
    ["a run that only read and drafted", ["read", "compose_message"], "completes"],
    ["a run that executed bash", ["read", "bash"], "reports unpublished outputs"],
  ] as const)("finalizes %s when its sandbox can no longer be resumed", async (_label, tools, expected) => {
    const unavailable = Object.assign(new Error("The sandbox was not found"), { name: "SandboxNotFoundError" });
    const provider = {
      kind: "e2b",
      create: vi.fn(async () => { throw new Error("Sandbox capacity is unavailable"); }),
      resume: vi.fn(async () => { throw unavailable; }),
      exec: vi.fn(),
      files: { read: vi.fn(), write: vi.fn(), list: vi.fn() },
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
    const objects = { put: vi.fn(), putArtifact: vi.fn(), get: vi.fn(), getSource: vi.fn() } satisfies SandboxSnapshotObjectStore;
    const manager = new SandboxContinuityManager(provider, repository, objects, { image: "berry-sandbox" });
    const current = snapshot();
    current.sandboxId = "sandbox-gone";
    current.sandboxProvider = "e2b";
    current.sandboxState = "paused";
    current.steps = tools.map((name, index) => ({
      ...toolStep(name, {}),
      id: `00000000-0000-7000-8000-${String(200 + index).padStart(12, "0")}`,
      sequence: index + 1,
      state: "completed" as const,
    }));

    if (expected === "completes") {
      await expect(manager.finalize(current)).resolves.toEqual([]);
    } else {
      // The answer stays delivered; the outputs are reported as not yet published (H-014).
      await expect(manager.finalize(current)).resolves.toEqual([{
        output: expect.objectContaining({ publication: "failed", path: "/workspace/outputs", workspaceUnavailable: true }),
        summary: expect.stringContaining("Not published: files in outputs/"),
      }]);
    }
    expect(objects.putArtifact).not.toHaveBeenCalled();
  });

  it("surfaces terminal output listing failures and records finalization failure", async () => {
    const base = snapshot();
    const provider = {
      kind: "e2b",
      create: vi.fn(),
      exec: vi.fn(),
      destroy: vi.fn(async () => ({ status: "stopped" })),
      files: {
        read: vi.fn(),
        write: vi.fn(),
        list: vi.fn(async (input: { path: string }) => {
          if (input.path.endsWith("/outputs")) throw new Error("provider_listing_unavailable");
          return { path: input.path, entries: [] };
        }),
      },
    } as unknown as SandboxProvider;
    const run = {
      tenantId: base.tenantId,
      userId: base.userId,
      workspaceId: base.workspaceId,
      runId: base.id,
      sessionId: base.sessionId,
      taskId: base.taskId,
      sandboxProvider: "e2b",
      sandboxId: "sandbox-terminal-finalizer",
      sandboxState: "running",
      runState: "failed",
      sandboxClaimedByNewerRun: false,
      sessionLeafId: null,
    };
    const repository = {
      loadRun: vi.fn(async () => run),
      continuity: vi.fn(async () => null),
      latest: vi.fn(async () => null),
      inputFiles: vi.fn(async () => []),
      beginFinalization: vi.fn(async () => ({ id: "finalization-id", attempt: 1 })),
      finishFinalization: vi.fn(async () => undefined),
      failFinalization: vi.fn(async () => undefined),
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
    const manager = new SandboxContinuityManager(provider, repository, objects, {
      image: "berry-sandbox",
      enableTerminalFinalization: true,
    });

    await expect(manager.snapshot({ tenantId: base.tenantId, runId: base.id, reason: "before-finalize" }))
      .rejects.toThrow("provider_listing_unavailable");
    expect(repository.failFinalization).toHaveBeenCalledWith(expect.objectContaining({
      runId: base.id,
      errorClass: "Error",
    }));
    expect(repository.finishFinalization).not.toHaveBeenCalled();
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

  it("resumes the sandbox after image generation before registering the image", async () => {
    const bytes = await sharp({ create: { width: 1_536, height: 1_024, channels: 3, background: "purple" } }).png().toBuffer();
    let paused = false;
    let resumeCount = 0;
    const provider = {
      kind: "e2b",
      supportsResume: true,
      create: vi.fn(async () => ({
        sandbox_id: "sandbox-image-restored",
        provider: "e2b",
        status: "running",
      })),
      resume: vi.fn(async () => {
        resumeCount += 1;
        if (resumeCount === 1) throw new Error("sandbox expired");
        paused = false;
        return { sandbox_id: "sandbox-image-final", provider: "e2b", status: "running" };
      }),
      exec: vi.fn(),
      files: {
        read: vi.fn(),
        write: vi.fn(async (input: { path: string; content: string }) => {
          if (paused) throw new Error("sandbox paused");
          return {
            path: input.path,
            size_bytes: Buffer.from(input.content, "base64").byteLength,
            mtime: null,
          };
        }),
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
    current.sandboxId = "sandbox-image";
    current.sandboxProvider = "e2b";
    current.runtimeRequest = { imageGeneration: { version: 1, model: "gpt-image-1" } };
    const originalFetch = globalThis.fetch;
    const imageFetch = vi.fn(async () => {
      paused = true;
      return new Response(JSON.stringify({
        model: "gpt-image-1",
        data: [{ b64_json: bytes.toString("base64"), revised_prompt: "A revised prompt" }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
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
        sandbox: {
          id: "sandbox-image-final",
        },
        output: {
          image: {
            fileId: "00000000-0000-7000-8000-000000000010",
            title: "Berry icon",
            width: 1536,
            height: 1024,
            // 16:9 was requested; 4:3 is the preset nearest the returned 3:2 (H-041).
            aspectRatio: "4:3",
            mimeType: "image/png",
            revisedPrompt: "A revised prompt",
          },
          text: expect.stringContaining("16:9 was requested"),
          visionPath: "/workspace/outputs/Berry icon.png",
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(globalThis.fetch).toBe(originalFetch);
    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(imageFetch).toHaveBeenCalledWith(
      "https://images.example.test/v1/images/generations",
      expect.objectContaining({
        headers: expect.objectContaining({ "Idempotency-Key": "durable-image-step-key" }),
      }),
    );
    expect(provider.resume).toHaveBeenCalledTimes(2);
    expect(provider.files.write).toHaveBeenCalledWith(expect.objectContaining({
      sandbox_id: "sandbox-image-final",
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

  describe("image generation outcome survives delivery errors", () => {
    it.each([
      ["workspace", "unknown", 1], ["write", "unknown", 1],
      ["storage", "unknown", 1], ["database", "unknown", 1],
      ["download", "unknown", 1], ["pixels", "unknown", 1],
      ["empty", "unknown", 1], ["json", "unknown", 1],
      ["response", "unknown", 1], ["dispatch", "unknown", 1],
      ["http408", "unknown", 1], ["http429", "not_applied", 1],
      ["http402", "not_applied", 1], ["before-workspace", "not_applied", 0],
      ["before-arguments", "not_applied", 0],
    ] as const)("keeps the correct outcome after %s fails", async (stage, outcome, calls) => {
      const bytes = await testPng(80);
      let resumes = 0;
      const provider = {
        kind: "e2b", supportsResume: true,
        resume: vi.fn(async () => {
          resumes += 1;
          if (stage === "before-workspace" || (stage === "workspace" && resumes > 1)) throw new Error("read ECONNRESET");
          return { sandbox_id: "sandbox-image", provider: "e2b", status: "running" };
        }),
        files: {
          read: vi.fn(),
          write: vi.fn(async () => {
            if (stage === "write") throw Object.assign(new Error("Path not found"), { status: 404 });
            return { path: "/workspace/outputs/Berry.png", size_bytes: bytes.length, mtime: null };
          }),
          list: vi.fn(async (input: { path: string }) => ({ path: input.path, entries: [] })),
        },
      } as unknown as SandboxProvider;
      const repository = {
        recordSandbox: vi.fn(async () => undefined), recordTiming: vi.fn(async () => undefined),
        persistOutput: vi.fn(async () => {
          if (stage === "database") throw Object.assign(new Error("invalid schema"), { status: 422 });
          return { fileId: "image", name: "Berry.png", mediaType: "image/png", sizeBytes: bytes.length };
        }),
      } as unknown as SandboxSnapshotRepository;
      const objects = {
        putArtifact: vi.fn(async () => {
          if (stage === "storage") throw Object.assign(new Error("Invalid credentials"), { status: 401 });
          return { bucket: "berry", key: "image", etag: "etag" };
        }),
      } as unknown as SandboxSnapshotObjectStore;
      const manager = new SandboxContinuityManager(provider, repository, objects, {
        image: "berry-sandbox", resumeRetryDelayMs: 0,
        imageGeneration: {
          endpoint: "https://images.example.test/generations", editsEndpoint: "https://images.example.test/edits",
          model: "gpt-image-1", responseFormat: "b64_json",
        },
      });
      const current = snapshot();
      current.sandboxId = "sandbox-image";
      current.sandboxProvider = "e2b";
      current.sandboxState = "running";
      current.runtimeRequest = { imageGeneration: { version: 1, model: "gpt-image-1" } };
      let generations = 0;
      const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
        if (init?.method !== "POST") return new Response("Download not found", { status: 404 });
        generations += 1;
        if (stage === "dispatch") throw Object.assign(new Error("Invalid response"), { status: 400 });
        if (stage.startsWith("http")) return new Response("Request refused", { status: Number(stage.slice(4)) });
        if (stage === "json") return new Response("{invalid", { status: 200 });
        return new Response(JSON.stringify({
          data: stage === "response" ? [] : [stage === "download"
            ? { url: "https://images.example.test/image.png" }
            : { b64_json: stage === "empty" ? "" : stage === "pixels" ? Buffer.from("invalid pixels").toString("base64") : bytes.toString("base64") }],
        }), { status: 200 });
      });
      vi.stubGlobal("fetch", fetch);
      try {
        const error = await manager.execute(current, {
          ...toolStep("create_image", { prompt: stage === "before-arguments" ? "" : "A berry icon", title: "Berry" }),
          retryClass: "non_idempotent_manual",
        }).then(() => null, (error: unknown) => error);
        expect(error).toBeInstanceOf(Error);
        expect(generations).toBe(calls);
        expect(classifyToolFailure(error, { changesState: true }).outcome).toBe(outcome);
        if (["workspace", "write", "storage", "database", "download", "pixels", "empty", "json", "response"].includes(stage)) {
          expect(error).toMatchObject({ toolCallPhase: "dispatched", message: expect.stringContaining("could not deliver the image") });
          expect((error as Error).message).not.toContain("Nothing was run");
        }
        if (stage === "http402") expect(classifyToolFailure(error, { changesState: true }).category).toBe("credit_exhausted");
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  describe("generated image metadata comes from the returned bytes (H-041)", () => {
    const generate = async (returned: Buffer, argumentsValue: Record<string, unknown>) => {
      const provider = {
        kind: "e2b",
        create: vi.fn(async () => ({ sandbox_id: "sandbox-image", provider: "e2b", status: "running" })),
        exec: vi.fn(),
        files: {
          read: vi.fn(),
          write: vi.fn(async (input: { path: string; content: string }) => ({ path: input.path, size_bytes: Buffer.from(input.content, "base64").byteLength, mtime: null })),
          list: vi.fn(async (input: { path: string }) => ({ path: input.path, entries: [] })),
        },
      } as unknown as SandboxProvider;
      const repository = {
        loadRun: vi.fn(),
        continuity: vi.fn(async () => null),
        latest: vi.fn(async () => null),
        inputFiles: vi.fn(async () => []),
        persistOutput: vi.fn(async (input: { fileId: string; name: string; mediaType: string; sizeBytes: number; objectKey: string }) => ({
          fileId: input.fileId, name: input.name, mediaType: input.mediaType, sizeBytes: input.sizeBytes, objectKey: input.objectKey,
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
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ model: "gpt-image-1", data: [{ b64_json: returned.toString("base64") }] }), {
        status: 200, headers: { "content-type": "application/json" },
      })));
      try {
        const result = await manager.execute(current, { ...toolStep("create_image", { prompt: "A site logo", title: "Site logo", ...argumentsValue }), retryClass: "non_idempotent_manual" as const });
        return { result, repository, objects };
      } finally {
        vi.unstubAllGlobals();
      }
    };

    it("labels a JPEG as JPEG and reports a missed ratio and transparency", async () => {
      const jpeg = await sharp({ create: { width: 1_024, height: 1_024, channels: 3, background: "white" } }).jpeg().toBuffer();
      const { result, repository, objects } = await generate(jpeg, { aspect_ratio: "16:9", transparent_background: true });
      expect(result.output).toMatchObject({
        image: { width: 1024, height: 1024, aspectRatio: "1:1", mimeType: "image/jpeg", transparentBackground: false },
        visionPath: "/workspace/outputs/Site logo.jpg",
      });
      const text = (result.output as { text: string }).text;
      expect(text).toContain("(1024x1024, 1:1)");
      expect(text).toContain("16:9 was requested");
      expect(text).toContain("no transparent pixels");
      expect(objects.putArtifact).toHaveBeenCalledWith(expect.stringContaining("/original/Site logo.jpg"), jpeg, "image/jpeg");
      expect(repository.persistOutput).toHaveBeenCalledWith(expect.objectContaining({ name: "Site logo.jpg", mediaType: "image/jpeg" }));
    });

    it("adds no mismatch note when the returned image matches the request", async () => {
      const png = await sharp({ create: { width: 1_024, height: 1_024, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
      const { result } = await generate(png, { aspect_ratio: "1:1", transparent_background: true });
      expect(result.output).toMatchObject({ image: { aspectRatio: "1:1", mimeType: "image/png", transparentBackground: true } });
      expect((result.output as { text: string }).text).toBe("Generated Site logo.png (1024x1024, 1:1).");
    });

    it("keeps a draft base in the workspace without publishing it (H-065)", async () => {
      // Task 715: each base was published next to its finished composite (six images for three versions).
      const png = await sharp({ create: { width: 1_024, height: 1_024, channels: 3, background: "white" } }).png().toBuffer();
      const { result, repository, objects } = await generate(png, { purpose: "draft", aspect_ratio: "1:1" });
      expect(result.output).toMatchObject({
        visionPath: "/workspace/drafts/Site logo.png",
        draft: { path: "/workspace/drafts/Site logo.png", width: 1024, height: 1024, mimeType: "image/png" },
      });
      expect(result.output).not.toHaveProperty("image");
      expect(result.output).not.toHaveProperty("artifact");
      expect((result.output as { text: string }).text).toContain("It is not published");
      expect(objects.putArtifact).not.toHaveBeenCalled();
      expect(repository.persistOutput).not.toHaveBeenCalled();
    });

    it("rejects provider data that is not a readable image instead of publishing it", async () => {
      await expect(generate(Buffer.from([137, 80, 78, 71]), {})).rejects.toThrow("not a readable");
    });
  });

  it("names an exhausted image provider account and stops calling it in the same run (H-005)", async () => {
    const provider = {
      kind: "e2b",
      create: vi.fn(async () => ({ sandbox_id: "sandbox-credit", provider: "e2b", status: "running" })),
      exec: vi.fn(),
      files: { read: vi.fn(), write: vi.fn(), list: vi.fn(async (input: { path: string }) => ({ path: input.path, entries: [] })) },
    } as unknown as SandboxProvider;
    const repository = {
      loadRun: vi.fn(), continuity: vi.fn(async () => null), latest: vi.fn(async () => null), inputFiles: vi.fn(async () => []),
      persistOutput: vi.fn(), persist: vi.fn(), recordSandbox: vi.fn(async () => undefined),
    } satisfies SandboxSnapshotRepository;
    const objects = { put: vi.fn(), putArtifact: vi.fn(), get: vi.fn(), getSource: vi.fn() } satisfies SandboxSnapshotObjectStore;
    const raise = vi.fn(async () => undefined);
    const manager = new SandboxContinuityManager(provider, repository, objects, {
      image: "berry-sandbox",
      imageGeneration: {
        endpoint: "https://images.example.test/v1/images/generations",
        editsEndpoint: "https://images.example.test/v1/images/edits",
        apiKey: "test-key",
        model: "gpt-image-1",
        responseFormat: "b64_json",
      },
      providerCreditAlerts: { raise },
    });
    const current = snapshot();
    current.runtimeRequest = { imageGeneration: { version: 1, model: "gpt-image-1", providerId: "router" } };
    const step = (sequence: number) => ({ ...toolStep("create_image", { prompt: "A site logo", title: "Site logo" }), id: `image-${sequence}`, sequence, retryClass: "non_idempotent_manual" as const });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { code: "insufficient_quota", message: "You exceeded your current quota, please check your plan and billing details." } }), { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const failure = await manager.execute(current, step(1)).then(() => null, (error: Error) => error.message);
      expect(failure).toContain("Image generation is unavailable because the AI provider is out of credit");
      expect(failure).toContain("contact support or their administrator");
      expect(failure).toContain("HTTP 429");
      expect(failure).not.toContain("change the image provider");
      expect(raise).toHaveBeenCalledTimes(1);
      expect(raise).toHaveBeenCalledWith(expect.objectContaining({
        tenantId: current.tenantId, event: "exhausted", surface: "image", providerId: "router", providerHost: "images.example.test", status: 429,
      }));
      current.steps = [{ ...step(1), state: "failed", error: `Tool failed (repair attempt 1/3). ${failure}` }];
      await expect(manager.execute(current, step(3))).rejects.toThrow("the provider was not called again");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // A step recorded with earlier wording is recognised by its stored failure class.
      current.steps = [{
        ...step(1),
        state: "failed",
        error: "Tool failed (repair attempt 1/3). Image generation is unavailable: the image provider reports that its credit or quota is exhausted.",
        output: { failure: { category: "credit_exhausted", deterministic: true, outcome: "not_applied", action: "" } },
      }];
      await expect(manager.execute(current, step(3))).rejects.toThrow("the provider was not called again");
      expect(fetchMock).toHaveBeenCalledTimes(1);

      fetchMock.mockImplementation(async () => new Response("Payment Required", { status: 402 }));
      current.steps = [];
      await expect(manager.execute(current, step(5))).rejects.toThrow("the AI provider is out of credit");
      // The fast-failed calls did not reach the provider and raised nothing; the 402 raised once more.
      expect(raise).toHaveBeenCalledTimes(2);
      expect(raise).toHaveBeenLastCalledWith(expect.objectContaining({ surface: "image", status: 402 }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("streams only the attachment referenced by the current tool through one native file write", async () => {
    const staged = new Map<string, Uint8Array>();
    const writeStream = vi.fn(async (input: { path: string; content: ReadableStream<Uint8Array>; size_bytes: number }) => {
      const reader = input.content.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        chunks.push(next.value);
        total += next.value.byteLength;
      }
      const content = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        content.set(chunk, offset);
        offset += chunk.byteLength;
      }
      staged.set(input.path, content);
      return { path: input.path, size_bytes: total, mtime: null };
    });
    const provider = {
      kind: "e2b",
      create: vi.fn(async () => ({
        sandbox_id: "sandbox-1",
        provider: "e2b",
        status: "running",
      })),
      exec: vi.fn(async function* () { throw new Error("attachment staging must not execute shell commands"); }),
      files: {
        read: vi.fn(),
        write: vi.fn(),
        writeStream,
        list: vi.fn(async (input: { path: string }) => ({
          path: input.path,
          entries: [...staged.entries()].map(([path, content]) => ({
            path,
            type: "file",
            size_bytes: content.byteLength,
            mtime: null,
          })),
        })),
      },
    } as unknown as SandboxProvider;
    const repository = {
      loadRun: vi.fn(),
      continuity: vi.fn(async () => null),
      latest: vi.fn(async () => null),
      inputFiles: vi.fn(async () => [
        {
          fileId: "00000000-0000-7000-8000-000000000099",
          name: "candidate.xlsx",
          mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          sizeBytes: (256 * 1024) + 2,
          objectKey: "artifacts/tenants/t/files/candidate.xlsx",
        },
        {
          fileId: "00000000-0000-7000-8000-000000000098",
          name: "unrequested.dwg",
          mediaType: "application/acad",
          sizeBytes: 3,
          objectKey: "artifacts/tenants/t/files/unrequested.dwg",
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
      getSource: vi.fn(async () => new Uint8Array([1, 2, 3])),
      streamSource: vi.fn(async function* (key: string) {
        expect(key).toBe("artifacts/tenants/t/files/candidate.xlsx");
        yield new Uint8Array(256 * 1024).fill(1);
        yield new Uint8Array([2, 3]);
      }),
    } satisfies SandboxSnapshotObjectStore;
    const manager = new SandboxContinuityManager(provider, repository, objects, {
      image: "berry-sandbox",
      cwd: "/home/user/workspace",
    });

    const path = "/home/user/workspace/inputs/00000000-0000-7000-8000-000000000099/candidate.xlsx";
    const result = await manager.execute(snapshot(), toolStep("read", {
      path,
    }));

    expect(objects.streamSource).toHaveBeenCalledWith(
      "artifacts/tenants/t/files/candidate.xlsx",
      350 * 1024 * 1024,
      undefined,
      undefined,
    );
    const stagedBytes = Buffer.from(staged.get(path)!);
    expect(stagedBytes).toHaveLength((256 * 1024) + 2);
    expect(stagedBytes.subarray(-2)).toEqual(Buffer.from([2, 3]));
    expect(writeStream).toHaveBeenCalledTimes(1);
    expect(repository.inputFiles).toHaveBeenCalledTimes(1);
    expect(provider.exec).not.toHaveBeenCalled();
    expect(result.output).toMatchObject({ path, binary: true });
  });

  it("coalesces concurrent staging requests for the same attachment and sandbox", async () => {
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    let writeStarted!: () => void;
    const writeStartedPromise = new Promise<void>((resolve) => { writeStarted = resolve; });
    const writeStream = vi.fn(async (input: { path: string; content: ReadableStream<Uint8Array> }) => {
      writeStarted();
      await writeGate;
      const reader = input.content.getReader();
      let size = 0;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
      }
      return { path: input.path, size_bytes: size, mtime: null };
    });
    const provider = {
      kind: "e2b",
      supportsResume: true,
      create: vi.fn(),
      resume: vi.fn(async () => ({ sandbox_id: "sandbox-existing", provider: "e2b", status: "running" })),
      exec: vi.fn(),
      files: {
        read: vi.fn(),
        write: vi.fn(),
        writeStream,
        list: vi.fn(),
      },
    } as unknown as SandboxProvider;
    const file = {
      fileId: "00000000-0000-7000-8000-000000000099",
      name: "candidate.xlsx",
      mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      sizeBytes: 4,
      objectKey: "artifacts/candidate.xlsx",
    };
    const repository = {
      loadRun: vi.fn(),
      continuity: vi.fn(),
      latest: vi.fn(),
      inputFiles: vi.fn(async () => [file]),
      persistOutput: vi.fn(),
      persist: vi.fn(),
      recordSandbox: vi.fn(async () => undefined),
    } satisfies SandboxSnapshotRepository;
    const objects = {
      put: vi.fn(),
      putArtifact: vi.fn(),
      get: vi.fn(),
      getSource: vi.fn(),
      streamSource: vi.fn(async function* () { yield new Uint8Array([1, 2, 3, 4]); }),
    } satisfies SandboxSnapshotObjectStore;
    const manager = new SandboxContinuityManager(provider, repository, objects, {
      image: "berry-sandbox",
      cwd: "/home/user/workspace",
    });
    const current = snapshot();
    current.sandboxId = "sandbox-existing";
    current.sandboxProvider = "e2b";

    const first = manager.stageAssociatedInputFiles(current, [file.fileId]);
    await writeStartedPromise;
    const second = manager.stageAssociatedInputFiles(current, [file.fileId]);
    releaseWrite();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(writeStream).toHaveBeenCalledTimes(1);
  });

  it("stages every current-turn attachment before preparing the first model request", async () => {
    const staged = new Map<string, Uint8Array>();
    const writeStream = vi.fn(async (input: { path: string; content: ReadableStream<Uint8Array> }) => {
      const reader = input.content.getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        chunks.push(next.value);
      }
      staged.set(input.path, Buffer.concat(chunks));
      return { path: input.path, size_bytes: staged.get(input.path)!.byteLength, mtime: null };
    });
    const provider = {
      kind: "e2b",
      create: vi.fn(async () => ({ sandbox_id: "sandbox-model-inputs", provider: "e2b", status: "running" })),
      exec: vi.fn(),
      files: {
        read: vi.fn(),
        write: vi.fn(),
        writeStream,
        list: vi.fn(async (input: { path: string }) => ({
          path: input.path,
          entries: [...staged.entries()].map(([path, content]) => ({
            path,
            type: "file",
            size_bytes: content.byteLength,
            mtime: null,
          })),
        })),
      },
    } as unknown as SandboxProvider;
    const files = [{
      fileId: "00000000-0000-7000-8000-000000000099",
      name: "requirements.docx",
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sizeBytes: 4,
      objectKey: "objects/requirements.docx",
    }, {
      fileId: "00000000-0000-7000-8000-000000000098",
      name: "evidence.zip",
      mediaType: "application/zip",
      sizeBytes: 3,
      objectKey: "objects/evidence.zip",
    }];
    const repository = {
      loadRun: vi.fn(),
      continuity: vi.fn(async () => null),
      latest: vi.fn(async () => null),
      inputFiles: vi.fn(async (_tenantId: string, _runId: string, scope?: "turn" | "session") => {
        expect(scope).toBe("turn");
        return files;
      }),
      persistOutput: vi.fn(),
      persist: vi.fn(),
      recordSandbox: vi.fn(async () => undefined),
    } satisfies SandboxSnapshotRepository;
    const objects = {
      put: vi.fn(),
      putArtifact: vi.fn(),
      get: vi.fn(),
      getSource: vi.fn(),
      streamSource: vi.fn(async function* (key: string) {
        yield key.endsWith(".docx") ? new Uint8Array([1, 2, 3, 4]) : new Uint8Array([5, 6, 7]);
      }),
    } satisfies SandboxSnapshotObjectStore;
    const manager = new SandboxContinuityManager(provider, repository, objects, {
      image: "berry-sandbox",
      cwd: "/home/user/workspace",
    });
    const current = snapshot();
    current.steps = [];

    await expect(manager.modelContent(current)).resolves.toEqual([]);

    expect([...staged.keys()].sort()).toEqual([
      "/home/user/workspace/inputs/00000000-0000-7000-8000-000000000098/evidence.zip",
      "/home/user/workspace/inputs/00000000-0000-7000-8000-000000000099/requirements.docx",
    ]);
    expect(writeStream).toHaveBeenCalledTimes(2);
    await expect(manager.execute(current, toolStep("ls", {
      path: "/home/user/workspace/inputs",
    }))).resolves.toMatchObject({
      output: {
        content: expect.stringContaining("requirements.docx"),
      },
    });
  });

  it("waits for current-turn attachment verification before preparing model input", async () => {
    const file = {
      fileId: "00000000-0000-7000-8000-000000000099",
      name: "candidate.pdf",
      mediaType: "application/pdf",
      sizeBytes: 4,
      objectKey: "objects/candidate.pdf",
    };
    let inputFileReads = 0;
    const repository = {
      loadRun: vi.fn(),
      continuity: vi.fn(async () => null),
      latest: vi.fn(async () => null),
      inputFiles: vi.fn(async () => ++inputFileReads === 1 ? [] : [file]),
      persistOutput: vi.fn(),
      persist: vi.fn(),
      recordSandbox: vi.fn(async () => undefined),
    } satisfies SandboxSnapshotRepository;
    const writeStream = vi.fn(async (input: { path: string; size_bytes: number }) => ({
      path: input.path,
      size_bytes: input.size_bytes,
      mtime: null,
    }));
    const provider = {
      kind: "e2b",
      create: vi.fn(async () => ({ sandbox_id: "sandbox-verification", provider: "e2b", status: "running" })),
      exec: vi.fn(),
      files: { read: vi.fn(), write: vi.fn(), writeStream, list: vi.fn() },
    } as unknown as SandboxProvider;
    const objects = {
      put: vi.fn(),
      putArtifact: vi.fn(),
      get: vi.fn(),
      getSource: vi.fn(),
      streamSource: vi.fn(async function* () { yield new Uint8Array([1, 2, 3, 4]); }),
    } satisfies SandboxSnapshotObjectStore;
    const manager = new SandboxContinuityManager(provider, repository, objects, {
      image: "berry-sandbox",
      inputAvailabilityTimeoutMs: 50,
      inputAvailabilityPollMs: 1,
    });
    const current = snapshot();
    current.steps = [];
    current.runtimeRequest = {
      attachments: [{
        fileId: file.fileId,
        name: file.name,
        mediaType: file.mediaType,
        size: file.sizeBytes,
      }],
    };

    await expect(manager.modelContent(current)).resolves.toEqual([]);

    expect(repository.inputFiles).toHaveBeenCalledTimes(2);
    expect(writeStream).toHaveBeenCalledTimes(1);
  });

  it("restages a referenced attachment when it disappeared from a resumed sandbox", async () => {
    const file = {
      fileId: "00000000-0000-7000-8000-000000000099",
      name: "candidate.png",
      mediaType: "image/png",
      sizeBytes: 4,
      objectKey: "objects/candidate.png",
    };
    const staged = new Map<string, Uint8Array>();
    const writeStream = vi.fn(async (input: { path: string; content: ReadableStream<Uint8Array> }) => {
      const reader = input.content.getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        chunks.push(next.value);
      }
      const content = Buffer.concat(chunks);
      staged.set(input.path, content);
      return { path: input.path, size_bytes: content.byteLength, mtime: null };
    });
    const provider = {
      kind: "e2b",
      create: vi.fn(async () => ({ sandbox_id: "sandbox-repair", provider: "e2b", status: "running" })),
      exec: vi.fn(),
      files: {
        read: vi.fn(),
        write: vi.fn(),
        writeStream,
        list: vi.fn(async (input: { path: string }) => ({
          path: input.path,
          entries: [...staged.entries()].map(([path, content]) => ({
            path,
            type: "file" as const,
            size_bytes: content.byteLength,
            mtime: null,
          })),
        })),
      },
    } as unknown as SandboxProvider;
    const repository = {
      loadRun: vi.fn(),
      continuity: vi.fn(async () => null),
      latest: vi.fn(async () => null),
      inputFiles: vi.fn(async () => [file]),
      persistOutput: vi.fn(),
      persist: vi.fn(),
      recordSandbox: vi.fn(async () => undefined),
    } satisfies SandboxSnapshotRepository;
    const objects = {
      put: vi.fn(),
      putArtifact: vi.fn(),
      get: vi.fn(),
      getSource: vi.fn(),
      streamSource: vi.fn(async function* () { yield new Uint8Array([1, 2, 3, 4]); }),
    } satisfies SandboxSnapshotObjectStore;
    const manager = new SandboxContinuityManager(provider, repository, objects, {
      image: "berry-sandbox",
      cwd: "/home/user/workspace",
    });
    const current = snapshot();
    const stagedFiles = await manager.stageAssociatedInputFiles(current, [file.fileId]);
    const path = stagedFiles[0]!.path;
    staged.clear();

    await expect(manager.execute(current, toolStep("read", { path }))).resolves.toMatchObject({
      output: { path, binary: true, mediaType: "image/png" },
    });

    expect(writeStream).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["verifies within the wait", 2, 1],
    ["is still unverified at the deadline", Number.POSITIVE_INFINITY, 0],
  ] as const)("stages a connector import that %s", async (_label, verifiedOnCall, expected) => {
    const file = {
      fileId: "00000000-0000-7000-8000-000000000123",
      name: "rfp.pdf",
      mediaType: "application/pdf",
      sizeBytes: 4,
      objectKey: "objects/rfp.pdf",
    };
    let calls = 0;
    const writeStream = vi.fn(async (input: { path: string }) => ({ path: input.path, size_bytes: 4, mtime: null }));
    const provider = {
      kind: "e2b",
      create: vi.fn(async () => ({ sandbox_id: "sandbox-import", provider: "e2b", status: "running" })),
      exec: vi.fn(),
      files: { read: vi.fn(), write: vi.fn(), writeStream, list: vi.fn(async (input: { path: string }) => ({ path: input.path, entries: [] })) },
    } as unknown as SandboxProvider;
    const repository = {
      loadRun: vi.fn(),
      continuity: vi.fn(async () => null),
      latest: vi.fn(async () => null),
      // The verification job finishes after the import returned (task 1191: 75 ms later).
      inputFiles: vi.fn(async () => (++calls >= verifiedOnCall ? [file] : [])),
      persistOutput: vi.fn(),
      persist: vi.fn(),
      recordSandbox: vi.fn(async () => undefined),
    } satisfies SandboxSnapshotRepository;
    const objects = {
      put: vi.fn(), putArtifact: vi.fn(), get: vi.fn(), getSource: vi.fn(),
      streamSource: vi.fn(async function* () { yield new Uint8Array([1, 2, 3, 4]); }),
    } satisfies SandboxSnapshotObjectStore;
    const manager = new SandboxContinuityManager(provider, repository, objects, {
      image: "berry-sandbox", importAvailabilityPollMs: 1, importAvailabilityTimeoutMs: 50,
    });
    const current = snapshot();
    current.steps = [];

    const staged = await manager.stageAssociatedInputFiles(current, [file.fileId]);

    expect(staged).toHaveLength(expected);
    expect(writeStream).toHaveBeenCalledTimes(expected);
    if (expected) expect(staged[0]?.path).toBe("/workspace/inputs/00000000-0000-7000-8000-000000000123/rfp.pdf");
  });

  describe("connector import readiness (H-068)", () => {
    // Uses the production bounds (30 s wait, 250 ms polls) under fake timers.
    const file = {
      fileId: "00000000-0000-7000-8000-000000000124",
      name: "site photo.png",
      mediaType: "image/png",
      sizeBytes: 6,
      objectKey: "objects/site-photo.png",
      objectVersionId: "version-7",
    };
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10]);

    function readinessFixture(options: { verifiedAfterMs?: number; hydrate?: () => AsyncIterable<Uint8Array> } = {}) {
      const start = Date.now();
      const written: number[] = [];
      const writeStream = vi.fn(async (input: { path: string; content: ReadableStream<Uint8Array> }) => {
        const reader = input.content.getReader();
        for (let next = await reader.read(); !next.done; next = await reader.read()) written.push(...next.value);
        return { path: input.path, size_bytes: written.length, mtime: null };
      });
      const provider = {
        kind: "e2b",
        create: vi.fn(async () => ({ sandbox_id: "sandbox-readiness", provider: "e2b", status: "running" })),
        exec: vi.fn(),
        files: { read: vi.fn(), write: vi.fn(), writeStream, list: vi.fn(async (input: { path: string }) => ({ path: input.path, entries: [] })) },
      } as unknown as SandboxProvider;
      // Only verified blobs are listed, as in SqlSandboxSnapshotRepository.inputFiles.
      const inputFiles = vi.fn(async () => (
        options.verifiedAfterMs !== undefined && Date.now() - start >= options.verifiedAfterMs ? [file] : []
      ));
      const repository = {
        loadRun: vi.fn(),
        continuity: vi.fn(async () => null),
        latest: vi.fn(async () => null),
        inputFiles,
        persistOutput: vi.fn(),
        persist: vi.fn(),
        recordSandbox: vi.fn(async () => undefined),
      } satisfies SandboxSnapshotRepository;
      const streamSource = vi.fn(options.hydrate ?? async function* () { yield bytes; });
      const objects = {
        put: vi.fn(), putArtifact: vi.fn(), get: vi.fn(), getSource: vi.fn(), streamSource,
      } satisfies SandboxSnapshotObjectStore;
      const manager = new SandboxContinuityManager(provider, repository, objects, { image: "berry-sandbox" });
      const current = snapshot();
      current.steps = [];
      return { manager, current, written, writeStream, inputFiles, streamSource };
    }

    it.each([200, 2_000])("stages the exact bytes of a file verified %i ms after the receipt", async (delayMs) => {
      vi.useFakeTimers();
      try {
        const fixture = readinessFixture({ verifiedAfterMs: delayMs });
        const pending = fixture.manager.stageAssociatedInputFiles(fixture.current, [file.fileId]);
        await vi.advanceTimersByTimeAsync(delayMs + 250);
        const staged = await pending;

        expect(staged).toEqual([{
          fileId: file.fileId,
          name: file.name,
          mediaType: file.mediaType,
          path: `/workspace/inputs/${file.fileId}/site photo.png`,
        }]);
        expect(fixture.written).toEqual([...bytes]);
        expect(fixture.writeStream).toHaveBeenCalledTimes(1);
        expect(fixture.streamSource).toHaveBeenCalledWith(file.objectKey, expect.any(Number), file.objectVersionId, undefined);
      } finally {
        vi.useRealTimers();
      }
    });

    it("stages nothing and reads no bytes while a file stays unverified past the 30 s bound", async () => {
      vi.useFakeTimers();
      try {
        const fixture = readinessFixture();
        const pending = fixture.manager.stageAssociatedInputFiles(fixture.current, [file.fileId]);
        await vi.advanceTimersByTimeAsync(30_000);

        await expect(pending).resolves.toEqual([]);
        expect(fixture.streamSource).not.toHaveBeenCalled();
        expect(fixture.writeStream).not.toHaveBeenCalled();
        expect(fixture.inputFiles.mock.calls.length).toBeGreaterThan(100);
      } finally {
        vi.useRealTimers();
      }
    });

    it("stops polling when the task is cancelled during the wait", async () => {
      vi.useFakeTimers();
      try {
        const fixture = readinessFixture();
        const controller = new AbortController();
        const pending = fixture.manager.stageAssociatedInputFiles(fixture.current, [file.fileId], { signal: controller.signal });
        const settled = expect(pending).rejects.toThrow("Task cancelled");
        await vi.advanceTimersByTimeAsync(1_000);
        controller.abort(new Error("Task cancelled"));
        await settled;
        const polls = fixture.inputFiles.mock.calls.length;
        await vi.advanceTimersByTimeAsync(10_000);

        expect(fixture.inputFiles).toHaveBeenCalledTimes(polls);
        expect(fixture.streamSource).not.toHaveBeenCalled();
        expect(fixture.writeStream).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("fails instead of returning a path when a verified file cannot be hydrated", async () => {
      const fixture = readinessFixture({
        verifiedAfterMs: 0,
        // eslint-disable-next-line require-yield
        hydrate: async function* () { throw new Error("NoSuchKey: The specified key does not exist."); },
      });

      await expect(fixture.manager.stageAssociatedInputFiles(fixture.current, [file.fileId])).rejects.toThrow("NoSuchKey");
      expect(fixture.written).toEqual([]);
    });
  });

  it("does not stage task attachments for an unrelated sandbox operation", async () => {
    const writeStream = vi.fn();
    const provider = {
      kind: "e2b",
      create: vi.fn(async () => ({ sandbox_id: "sandbox-1", provider: "e2b", status: "running" })),
      exec: vi.fn(),
      files: {
        read: vi.fn(),
        write: vi.fn(),
        writeStream,
        list: vi.fn(async (input: { path: string }) => ({ path: input.path, entries: [] })),
      },
    } as unknown as SandboxProvider;
    const repository = {
      loadRun: vi.fn(),
      continuity: vi.fn(async () => null),
      latest: vi.fn(async () => null),
      inputFiles: vi.fn(async () => [{
        fileId: "00000000-0000-7000-8000-000000000099",
        name: "candidate.pdf",
        mediaType: "text/plain",
        sizeBytes: 4,
        objectKey: "artifacts/candidate.pdf",
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
    }))).resolves.toMatchObject({ output: { content: "(empty directory)" } });

    expect(repository.inputFiles).not.toHaveBeenCalled();
    expect(writeStream).not.toHaveBeenCalled();
  });

  it.each(["prior-turn", "paused-current-turn"])("reconnects a %s sandbox before staging model attachments", async (mode) => {
    let paused = true;
    const resume = vi.fn(async (input: { force_reconnect?: boolean }) => {
      if (input.force_reconnect) paused = false;
      return { sandbox_id: "sandbox-paused-remotely", provider: "e2b", status: "running" };
    });
    const writeStream = vi.fn(async (input: { path: string; content: ReadableStream<Uint8Array> }) => {
      if (paused) throw new Error("The sandbox was not found: This error is likely due to sandbox timeout.");
      const bytes = await new Response(input.content).arrayBuffer();
      return { path: input.path, size_bytes: bytes.byteLength, mtime: null };
    });
    const provider = {
      kind: "e2b",
      create: vi.fn(),
      resume,
      files: { writeStream, read: vi.fn(), write: vi.fn(), list: vi.fn() },
    } as unknown as SandboxProvider;
    const file = {
      fileId: "00000000-0000-7000-8000-000000000099",
      name: "tracker.xlsx",
      mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      sizeBytes: 4,
      objectKey: "objects/tracker.xlsx",
    };
    const repository = {
      loadRun: vi.fn(),
      continuity: vi.fn(async () => ({ provider: "e2b", sandboxId: "sandbox-paused-remotely", snapshot: null })),
      latest: vi.fn(async () => null),
      inputFiles: vi.fn(async () => [file]),
      persistOutput: vi.fn(),
      persist: vi.fn(),
      recordSandbox: vi.fn(async () => undefined),
    } satisfies SandboxSnapshotRepository;
    const objects = {
      put: vi.fn(),
      putArtifact: vi.fn(),
      get: vi.fn(),
      getSource: vi.fn(async () => new Uint8Array([1, 2, 3, 4])),
    } satisfies SandboxSnapshotObjectStore;
    const manager = new SandboxContinuityManager(provider, repository, objects, { image: "berry-sandbox" });
    const current = snapshot();
    current.steps = [];
    if (mode === "paused-current-turn") {
      current.sandboxId = "sandbox-paused-remotely";
      current.sandboxState = "paused";
    }
    const controller = new AbortController();

    await expect(manager.modelContent(current, controller.signal)).resolves.toEqual([]);

    expect(resume).toHaveBeenCalledWith(expect.objectContaining({
      sandbox_id: "sandbox-paused-remotely",
      force_reconnect: true,
    }), { signal: controller.signal });
    expect(writeStream).toHaveBeenCalledTimes(1);
    expect(provider.create).not.toHaveBeenCalled();
  });

  it.each([false, true])("applies policy before reusing a follow-up sandbox (update failure: %s)", async (updateFails) => {
    const provider = {
      kind: "e2b",
      create: vi.fn(),
      resume: vi.fn(async () => {
        if (updateFails) throw new SandboxNetworkPolicyUpdateError("network update failed");
        return { sandbox_id: "sandbox-from-previous-turn" };
      }),
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

    if (updateFails) {
      await expect(manager.execute(snapshot(), lsStep())).rejects.toThrow("network update failed");
      expect(provider.create).not.toHaveBeenCalled();
      expect(provider.files.list).not.toHaveBeenCalled();
      expect(provider.exec).not.toHaveBeenCalled();
      return;
    }
    await manager.execute(snapshot(), lsStep());

    expect(provider.create).not.toHaveBeenCalled();
    expect(provider.resume).toHaveBeenCalledWith({
      sandbox_id: "sandbox-from-previous-turn",
      reason: "Follow-up turn requested the prior sandbox",
      network_policy: { egress: "off", allowedDomains: [] },
      force_reconnect: true,
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
    const requestOptions: unknown[] = [];
    const client = {
      send: vi.fn(async (command: { input?: { Key?: string; VersionId?: string } }, options?: unknown) => {
        keys.push(command.input?.Key ?? "");
        versions.push(command.input?.VersionId);
        requestOptions.push(options);
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
    const controller = new AbortController();
    await expect(store.getSource("artifacts/tenants/tenant/files/input.pdf", "version-7", controller.signal)).resolves.toEqual(new Uint8Array([1, 2]));

    expect(keys).toEqual([
      "artifacts/sandbox-snapshots/tenant/run/hash.json",
      "artifacts/sandbox-snapshots/tenant/run/hash.json",
      "artifacts/tenants/tenant/files/input.pdf",
    ]);
    expect(versions).toEqual([undefined, undefined, "version-7"]);
    expect(requestOptions).toEqual([undefined, undefined, { abortSignal: controller.signal }]);
  });

  it("selects an archived snapshot only from the target run's proven prior branch", async () => {
    let continuitySql = "";
    const repository = new SqlSandboxSnapshotRepository({
      execute: vi.fn(),
      query: vi.fn(async (sql: string) => {
        continuitySql = sql;
        return [{
          sandbox_provider: null,
          sandbox_id: null,
          snapshot_id: "00000000-0000-7000-8000-000000000030",
          object_key: "sandbox-snapshots/tenant/prior.json",
          content_hash: "snapshot-digest",
          sequence: 4,
          snapshot_created_at: "2026-08-17T09:59:59.000Z",
          snapshot_session_leaf_id: "prior-request-entry",
          snapshot_branch_compatible: true,
          target_created_at: "2026-08-17T10:00:00.000Z",
        }];
      }),
    } as never);

    await expect(repository.continuity(
      "00000000-0000-7000-8000-000000000002",
      "00000000-0000-7000-8000-000000000001",
    )).resolves.toMatchObject({
      sandboxId: null,
      snapshot: {
        id: "00000000-0000-7000-8000-000000000030",
        sequence: 4,
      },
    });

    expect(continuitySql).toContain("WITH RECURSIVE current_run");
    // Continue anchors at its verified journal head; other runs keep the
    // request message (scripts/test-continue-lineage.mjs covers real rows).
    expect(continuitySql).toContain("entry.entry_id=COALESCE(current_run_row.continuation_head_entry_id,current_run_row.request_message_id::text)");
    expect(continuitySql).toContain("WHEN runtime_request->>'continueInterruptedTurn'='true'");
    expect(continuitySql).toContain("s.created_at<current_run_row.created_at");
    expect(continuitySql).toContain("s.session_leaf_id IS NOT NULL");
    expect(continuitySql).toContain("branch_entry.entry_id=s.session_leaf_id");
  });

  it.each([
    ["a sibling branch", { prior_created_at: "2026-08-17T09:59:59.000Z", prior_branch_compatible: false }],
    ["the same timestamp", { prior_created_at: "2026-08-17T10:00:00.000Z", prior_branch_compatible: true }],
  ])("does not reuse a live sandbox from %s", async (_reason, prior) => {
    let continuitySql = "";
    const repository = new SqlSandboxSnapshotRepository({
      execute: vi.fn(),
      query: vi.fn(async (sql: string) => {
        continuitySql = sql;
        return [{
          sandbox_provider: "e2b",
          sandbox_id: "sandbox-from-unproven-run",
          ...prior,
          snapshot_id: null,
          object_key: null,
          content_hash: null,
          sequence: null,
          snapshot_created_at: null,
          snapshot_session_leaf_id: null,
          snapshot_branch_compatible: null,
          target_created_at: "2026-08-17T10:00:00.000Z",
        }];
      }),
    } as never);

    await expect(repository.continuity(
      "00000000-0000-7000-8000-000000000002",
      "00000000-0000-7000-8000-000000000001",
    )).resolves.toBeNull();

    expect(continuitySql).toContain("r.created_at<current_run_row.created_at");
    expect(continuitySql).toContain("branch_entry.run_id=r.id");
  });

  it.each([
    ["branch membership is unproven", { snapshot_branch_compatible: false }],
    ["the snapshot is not strictly older", { snapshot_created_at: "2026-08-17T10:00:00.000Z" }],
  ])("fails closed when %s", async (_reason, override) => {
    const repository = new SqlSandboxSnapshotRepository({
      execute: vi.fn(),
      query: vi.fn(async () => [{
        sandbox_provider: null,
        sandbox_id: null,
        snapshot_id: "00000000-0000-7000-8000-000000000030",
        object_key: "sandbox-snapshots/tenant/prior.json",
        content_hash: "snapshot-digest",
        sequence: 4,
        snapshot_created_at: "2026-08-17T09:59:59.000Z",
        snapshot_session_leaf_id: "prior-request-entry",
        snapshot_branch_compatible: true,
        target_created_at: "2026-08-17T10:00:00.000Z",
        ...override,
      }]),
    } as never);

    await expect(repository.continuity(
      "00000000-0000-7000-8000-000000000002",
      "00000000-0000-7000-8000-000000000001",
    )).resolves.toBeNull();
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
    expect(query).toContain("blob.verification_status='verified'");
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

  it("keeps an artifact operation staged until its backing blob is verified", async () => {
    const execute = vi.fn(async (_sql: string, _params: readonly unknown[] = []) => undefined);
    const repository = new SqlSandboxSnapshotRepository({
      query: vi.fn(async () => []),
      execute,
    } as never);

    await repository.completeArtifactOperation({
      tenantId: "00000000-0000-7000-8000-000000000002",
      runId: "00000000-0000-7000-8000-000000000001",
      operationKey: "run:artifact:path",
      fileId: "00000000-0000-7000-8000-000000000020",
    });

    const [sql] = execute.mock.calls[0] ?? [];
    expect(sql).toContain("WHEN blob.verification_status='verified' THEN 'complete'");
    expect(sql).toContain("ELSE 'staged'");
    expect(sql).toContain("WHEN blob.verification_status='failed' THEN 'failed'");
    expect(sql).toContain("ELSE 'pending'");
  });

  it("records partial finalization while any artifact verification remains unsettled", async () => {
    const queries: string[] = [];
    const executions: Array<{ sql: string; params: readonly unknown[] }> = [];
    const repository = new SqlSandboxSnapshotRepository({
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        return [{
          id: "00000000-0000-7000-8000-000000000040",
          status: "partial",
          item_count: 1,
          completed_count: 0,
          failed_count: 0,
          last_error: null,
        }];
      }),
      execute: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
        executions.push({ sql, params });
      }),
    } as never);

    await repository.finishFinalization({
      tenantId: "00000000-0000-7000-8000-000000000002",
      runId: "00000000-0000-7000-8000-000000000001",
      sessionId: "00000000-0000-7000-8000-000000000004",
      owner: "terminal-finalizer:test",
      operationKey: "run:finalization",
      status: "complete",
      itemCount: 1,
      completedCount: 1,
      failedCount: 0,
      manifest: [],
    });

    expect(queries[0]).toContain("operation.status='complete' AND operation.verification_status='verified'");
    expect(queries[0]).toContain("ELSE 'partial'");
    expect(queries[0]).toContain("completed_count+counts.failed_count>=counts.item_count");
    const finalizationEvent = executions.find(({ sql }) => sql.includes("INSERT INTO turn_events"));
    expect(JSON.parse(String(finalizationEvent?.params[4]))).toMatchObject({
      kind: "finalization.end",
      status: "partial",
      itemCount: 1,
      completedCount: 0,
      failedCount: 0,
    });
  });

  it("settles an unavailable sandbox finalization as skipped exactly once", async () => {
    const executions: Array<{ sql: string; params: readonly unknown[] }> = [];
    const repository = new SqlSandboxSnapshotRepository({
      query: vi.fn(async () => []),
      execute: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
        executions.push({ sql, params });
      }),
    } as never);

    await repository.skipFinalization({
      tenantId: "00000000-0000-7000-8000-000000000002",
      runId: "00000000-0000-7000-8000-000000000001",
      sessionId: "00000000-0000-7000-8000-000000000004",
      operationKey: "run:finalization",
      reason: "sandbox_paused",
    });

    expect(executions[0]?.sql).toContain("WITH settled AS");
    expect(executions[0]?.sql).toContain("SET status='skipped'");
    expect(executions[0]?.sql).toContain("status<>'running' OR lease_expires_at IS NULL OR lease_expires_at<=now()");
    expect(executions[0]?.sql).toContain("INSERT INTO turn_events");
    expect(executions[0]?.params.slice(0, 4)).toEqual([
      "00000000-0000-7000-8000-000000000002",
      "00000000-0000-7000-8000-000000000001",
      "sandbox_paused",
      "00000000-0000-7000-8000-000000000004",
    ]);
    const finalizationEvent = executions[0];
    expect(JSON.parse(String(finalizationEvent?.params[4]))).toMatchObject({
      kind: "finalization.end",
      status: "skipped",
      itemCount: 0,
      completedCount: 0,
      failedCount: 0,
    });
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
    const { transfer: cachedTransfer, ...cachedResult } = cached;
    const { transfer: secondTransfer, ...secondResult } = second;
    expect(cachedResult).toEqual(secondResult);
    expect(secondTransfer).toMatchObject({ files: 1, bytes: Buffer.byteLength("version two") });
    expect(cachedTransfer).toMatchObject({ files: 0, bytes: 0 });
    expect(first.filePath).toMatch(/runtime-skills\/memo-[a-f0-9]{16}\/SKILL\.md$/);
    expect(second.filePath).toMatch(/runtime-skills\/memo-[a-f0-9]{16}\/SKILL\.md$/);
    expect(write).toHaveBeenCalledTimes(3);
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
    expect(write).not.toHaveBeenCalled();
    expect(staged.filePath).toMatch(/^\/workspace\/runtime-skills\//);
    // The only command is a read-only content-hash check for reuse; bytes are
    // never pushed through a shell command.
    expect(exec).toHaveBeenCalledTimes(1);
    const hashCheck = (exec.mock.calls[0] as unknown[] | undefined)?.[0];
    expect(hashCheck).toMatchObject({ command: expect.arrayContaining(["sh", "-c"]) });
    expect(JSON.stringify(hashCheck)).toContain("sha256sum");
    expect(JSON.stringify(hashCheck).length).toBeLessThan(1_000);
    expect(staged.transfer).toMatchObject({ files: 2, reusedFiles: 0 });
  });

  it("records how long sandbox access and skill staging took, and ignores a failed record (H-013)", async () => {
    const timings: PreparationTiming[] = [];
    const recordTiming = vi.fn(async (timing: PreparationTiming) => {
      timings.push(timing);
      throw new Error("operational events unavailable");
    });
    const manager = managerWithProvider({
      list: vi.fn(async () => ({ path: "/workspace", entries: [] })),
      read: vi.fn(async () => { throw new Error("not found"); }),
      write: vi.fn(),
      writeManyBytes: vi.fn(async (input: { files: Array<{ path: string; content: Uint8Array }> }) => (
        input.files.map((file) => ({ path: file.path, size_bytes: file.content.byteLength, mtime: null }))
      )),
    }, undefined, { recordTiming });

    const staged = await manager.stageSkillPackage(snapshot(), "timed", [
      { path: "SKILL.md", contentBytes: Buffer.from("---\nname: timed\ndescription: Timed\n---\n") },
    ]);
    await expect(manager.stageSkillPackage(snapshot(), "broken", [])).rejects.toThrow("Skill package must contain SKILL.md");

    expect(staged.filePath).toMatch(/SKILL\.md$/);
    await vi.waitFor(() => expect(timings.filter((timing) => timing.operation === "skill.stage")).toHaveLength(2));
    expect(timings.map((timing) => timing.operation)).toContain("sandbox.ensure");
    const [succeeded, failed] = timings.filter((timing) => timing.operation === "skill.stage");
    expect(succeeded).toMatchObject({
      tenantId: snapshot().tenantId,
      runId: snapshot().id,
      sessionId: snapshot().sessionId,
      outcome: "success",
      itemCount: staged.transfer.files,
      byteCount: staged.transfer.bytes,
    });
    expect(succeeded!.durationMs).toBeGreaterThanOrEqual(0);
    expect(failed).toMatchObject({ outcome: "failure" });
  });

  it("stages a fresh explicit resource with SKILL.md in one batch and no probes", async () => {
    const read = vi.fn(async () => { throw new Error("read probe should not run"); });
    const writeManyBytes = vi.fn(async (input: { files: Array<{ path: string; content: Uint8Array }> }) => (
      input.files.map((file) => ({ path: file.path, size_bytes: file.content.byteLength, mtime: null }))
    ));
    const manager = managerWithProvider({
      list: vi.fn(async () => ({ path: "/workspace", entries: [] })),
      read,
      write: vi.fn(),
      writeManyBytes,
    });
    const files = [
      { path: "SKILL.md", contentBytes: Buffer.from("---\nname: fresh\ndescription: Fresh\n---\n") },
      { path: "references/guide.md", contentBytes: Buffer.from("guide") },
    ];

    const staged = await manager.stageSkillPackage(snapshot(), "fresh", files, {
      resourcePaths: ["references/guide.md"],
    });

    expect(staged.stagedResources).toEqual([expect.stringMatching(/references\/guide\.md$/)]);
    expect(writeManyBytes).toHaveBeenCalledTimes(1);
    expect(writeManyBytes.mock.calls[0]?.[0].files.map((file) => file.path)).toEqual([
      expect.stringMatching(/SKILL\.md$/),
      expect.stringMatching(/references\/guide\.md$/),
    ]);
    expect(read).not.toHaveBeenCalled();
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
    expect(loadContentBytes).toHaveBeenCalledTimes(2);
    expect(writeBytes).toHaveBeenCalledTimes(4);
    expect(write).not.toHaveBeenCalled();
    expect(fileApi.read).not.toHaveBeenCalled();
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
    expect(read).not.toHaveBeenCalled();
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
  options: {
    ttlSeconds?: number;
    cwd?: string;
    documentTextExtractor?: (input: { bytes: Uint8Array; mediaType: string }) => Promise<string>;
    recordTiming?: (timing: PreparationTiming) => Promise<void>;
  } = {},
): SandboxContinuityManager {
  const { recordTiming, ...managerOptions } = options;
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
    ...(recordTiming ? { recordTiming } : {}),
  } satisfies SandboxSnapshotRepository;
  return new SandboxContinuityManager(provider, repository, null, {
    image: "berry-sandbox",
    ...managerOptions,
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

/** A minimal OLE2 compound file (512-byte sectors): FAT, one directory sector, root streams named here. */
function ole2File(streams: string[]): Buffer {
  const file = Buffer.alloc(512 * 3, 0);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(file, 0);
  file.writeUInt16LE(0x3e, 0x18);
  file.writeUInt16LE(3, 0x1a);
  file.writeUInt16LE(0xfffe, 0x1c);
  file.writeUInt16LE(9, 0x1e);
  file.writeUInt16LE(6, 0x20);
  file.writeUInt32LE(1, 0x2c);
  file.writeUInt32LE(1, 0x30);
  file.writeUInt32LE(4096, 0x38);
  file.writeUInt32LE(0xfffffffe, 0x3c);
  file.writeUInt32LE(0xfffffffe, 0x44);
  for (let index = 0; index < 109; index += 1) file.writeUInt32LE(index === 0 ? 0 : 0xffffffff, 0x4c + index * 4);
  const fat = 512;
  for (let index = 0; index < 128; index += 1) file.writeUInt32LE(0xffffffff, fat + index * 4);
  file.writeUInt32LE(0xfffffffd, fat);
  file.writeUInt32LE(0xfffffffe, fat + 4);
  const entry = (index: number, name: string, type: number, child: number, right: number) => {
    const offset = 1024 + index * 128;
    file.write(name, offset, "utf16le");
    file.writeUInt16LE((name.length + 1) * 2, offset + 0x40);
    file[offset + 0x42] = type;
    file.writeUInt32LE(0xffffffff, offset + 0x44);
    file.writeUInt32LE(right, offset + 0x48);
    file.writeUInt32LE(child, offset + 0x4c);
    file.writeUInt32LE(0xfffffffe, offset + 0x74);
  };
  entry(0, "Root Entry", 5, streams.length > 0 ? 1 : 0xffffffff, 0xffffffff);
  // Up to three root children, chained through their right-sibling pointers.
  const children = streams.slice(0, 3);
  children.forEach((name, index) => entry(index + 1, name, 2, 0xffffffff, index + 1 < children.length ? index + 2 : 0xffffffff));
  return file;
}
