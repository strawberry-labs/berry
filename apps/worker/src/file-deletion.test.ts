import { describe, expect, it, vi } from "vitest";
import { S3FileObjectDeleter, SqlFileDeletionReceiptStore } from "./file-deletion.js";
import type { SqlExecutor } from "./sql-repositories.js";

const tenantId = "00000000-0000-7000-8000-000000000001";
const fileId = "00000000-0000-7000-8000-000000000010";
const outboxId = "00000000-0000-7000-8000-000000000011";

describe("S3FileObjectDeleter", () => {
  it("deduplicates keys before version discovery and deletion", async () => {
    const commands: unknown[] = [];
    const send = vi.fn(async (command: unknown) => {
      commands.push(command);
      return {};
    });
    const acknowledge = vi.fn(async () => undefined);
    const deleter = new S3FileObjectDeleter({ send } as never, { acknowledge });

    await expect(deleter.delete({
      outboxId,
      tenantId,
      fileId,
      bucket: "berry-test",
      keys: ["artifacts/file.png", "artifacts/file.png", "artifacts/preview.png"],
    })).resolves.toEqual({ deleted: 2 });

    expect(commands.map((command) => (command as { constructor: { name: string } }).constructor.name))
      .toEqual(["ListObjectVersionsCommand", "ListObjectVersionsCommand", "DeleteObjectsCommand"]);
    const command = commands[2] as { input: unknown };
    expect(command.input).toEqual({
      Bucket: "berry-test",
      Delete: {
        Quiet: true,
        Objects: [{ Key: "artifacts/file.png" }, { Key: "artifacts/preview.png" }],
      },
    });
    expect(acknowledge).toHaveBeenCalledWith({
      outboxId,
      tenantId,
      fileId,
      bucket: "berry-test",
      keys: ["artifacts/file.png", "artifacts/file.png", "artifacts/preview.png"],
    });
  });

  it("deletes every stored version and delete marker for each exact key", async () => {
    const commands: unknown[] = [];
    const send = vi.fn(async (command: unknown) => {
      commands.push(command);
      if ((command as { constructor: { name: string } }).constructor.name === "ListObjectVersionsCommand") {
        return {
          Versions: [
            { Key: "artifacts/file.png", VersionId: "v2" },
            { Key: "artifacts/file.png", VersionId: "v1" },
            { Key: "artifacts/file.png.extra", VersionId: "unrelated" },
          ],
          DeleteMarkers: [{ Key: "artifacts/file.png", VersionId: "marker-1" }],
        };
      }
      return {};
    });
    const acknowledge = vi.fn(async () => undefined);
    const deleter = new S3FileObjectDeleter({ send } as never, { acknowledge });

    await expect(deleter.delete({
      outboxId,
      tenantId,
      fileId,
      bucket: "berry-test",
      keys: ["artifacts/file.png"],
    })).resolves.toEqual({ deleted: 1 });

    expect((commands[1] as { input: unknown }).input).toEqual({
      Bucket: "berry-test",
      Delete: {
        Quiet: true,
        Objects: [
          { Key: "artifacts/file.png", VersionId: "v2" },
          { Key: "artifacts/file.png", VersionId: "v1" },
          { Key: "artifacts/file.png", VersionId: "marker-1" },
        ],
      },
    });
    expect(acknowledge).toHaveBeenCalledOnce();
  });

  it("follows version pagination before acknowledging deletion", async () => {
    const commands: unknown[] = [];
    const send = vi.fn(async (command: unknown) => {
      commands.push(command);
      const typed = command as { constructor: { name: string }; input: Record<string, unknown> };
      if (typed.constructor.name !== "ListObjectVersionsCommand") return {};
      if (!typed.input.VersionIdMarker) {
        return {
          IsTruncated: true,
          NextKeyMarker: "artifacts/file.png",
          NextVersionIdMarker: "v2",
          Versions: [{ Key: "artifacts/file.png", VersionId: "v2" }],
        };
      }
      return {
        Versions: [{ Key: "artifacts/file.png", VersionId: "v1" }],
      };
    });
    const acknowledge = vi.fn(async () => undefined);
    const deleter = new S3FileObjectDeleter({ send } as never, { acknowledge });

    await deleter.delete({
      outboxId,
      tenantId,
      fileId,
      bucket: "berry-test",
      keys: ["artifacts/file.png"],
    });

    expect((commands[1] as { input: unknown }).input).toEqual({
      Bucket: "berry-test",
      Prefix: "artifacts/file.png",
      KeyMarker: "artifacts/file.png",
      VersionIdMarker: "v2",
    });
    expect((commands[2] as { input: { Delete: { Objects: unknown[] } } }).input.Delete.Objects).toEqual([
      { Key: "artifacts/file.png", VersionId: "v2" },
      { Key: "artifacts/file.png", VersionId: "v1" },
    ]);
    expect(acknowledge).toHaveBeenCalledOnce();
  });

  it("fails the job when object storage reports a partial deletion error", async () => {
    const acknowledge = vi.fn(async () => undefined);
    const deleter = new S3FileObjectDeleter({
      send: vi.fn(async (command: unknown) =>
        (command as { constructor: { name: string } }).constructor.name === "DeleteObjectsCommand"
          ? { Errors: [{ Key: "artifacts/file.png", Code: "AccessDenied" }] }
          : {}),
    } as never, { acknowledge });

    await expect(deleter.delete({ outboxId, tenantId, fileId, bucket: "berry-test", keys: ["artifacts/file.png"] }))
      .rejects.toThrow("rejected 1 file deletion");
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it("fails for a retry when storage succeeded but its durable receipt did not", async () => {
    const receiptError = new Error("database unavailable");
    const deleter = new S3FileObjectDeleter({
      send: vi.fn(async () => ({})),
    } as never, {
      acknowledge: vi.fn(async () => { throw receiptError; }),
    });

    await expect(deleter.delete({ outboxId, tenantId, fileId, bucket: "berry-test", keys: ["artifacts/file.png"] }))
      .rejects.toBe(receiptError);
  });
});

describe("SqlFileDeletionReceiptStore", () => {
  it("acknowledges only the matching tenant, outbox row, event, and file", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const executor: SqlExecutor = {
      execute: vi.fn(async () => undefined),
      query: async <T>(sql: string, params: readonly unknown[] = []) => {
        calls.push({ sql, params });
        return [{ id: outboxId }] as T[];
      },
    };

    await new SqlFileDeletionReceiptStore(executor).acknowledge({
      outboxId,
      tenantId,
      fileId,
      bucket: "berry-test",
      keys: ["artifacts/file.png"],
    });

    expect(calls[0]?.sql).toContain("event_type = 'file.delete-object' AND aggregate_id = $3");
    expect(calls[0]?.sql).toContain("completed_at = COALESCE(completed_at, now())");
    expect(calls[0]?.params).toEqual([tenantId, outboxId, fileId]);
  });

  it("rejects a receipt that cannot find its durable outbox row", async () => {
    const executor: SqlExecutor = {
      execute: vi.fn(async () => undefined),
      query: async <T>() => [] as T[],
    };

    await expect(new SqlFileDeletionReceiptStore(executor).acknowledge({
      outboxId,
      tenantId,
      fileId,
      bucket: "berry-test",
      keys: ["artifacts/file.png"],
    })).rejects.toThrow("receipt could not be recorded");
  });
});
