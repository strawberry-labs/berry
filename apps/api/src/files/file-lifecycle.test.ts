import { describe, expect, it } from "vitest";
import type { SqlExecutor } from "../db/cloud-database.service.ts";
import { garbageCollectFileIfUnreferenced } from "./file-lifecycle.ts";

const tenantId = "00000000-0000-7000-8000-000000000001";
const fileId = "00000000-0000-7000-8000-000000000010";
const blobId = "00000000-0000-7000-8000-000000000011";

describe("reference-safe logical file garbage collection", () => {
  it("schedules the final blob no earlier than seven days after the last reference", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const deleteAfter = new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000);
    const executor: SqlExecutor = {
      execute: async (sql, params = []) => { calls.push({ sql, params }); },
      query: async <T>(sql: string, params: readonly unknown[] = []) => {
        calls.push({ sql, params });
        if (sql.includes("CASE WHEN f.blob_id")) return [{ id: fileId, blob_id: blobId, bucket: "berry", object_key: "object", deleted_at: null }] as T[];
        if (sql.includes("reference_exists")) return [{ reference_exists: false }] as T[];
        if (sql.includes("UPDATE files")) return [{ id: fileId }] as T[];
        if (sql.includes("SELECT id FROM file_blobs")) return [{ id: blobId }] as T[];
        if (sql.includes("id <> $3")) return [] as T[];
        if (sql.includes("UPDATE file_blobs")) return [{ delete_after: deleteAfter }] as T[];
        return [] as T[];
      },
    };

    await expect(garbageCollectFileIfUnreferenced(executor, tenantId, fileId))
      .resolves.toEqual({ collected: true, blobScheduled: true });

    const blobUpdate = calls.find((call) => call.sql.includes("UPDATE file_blobs"));
    expect(blobUpdate?.sql).toContain("now() + interval '7 days'");
    const outbox = calls.find((call) => call.sql.includes("'file.delete-blob'"));
    expect(outbox?.params[4]).toBe(deleteAfter.toISOString());
  });

  it("retains associations through task soft deletion and restoration without file repair", async () => {
    const calls: string[] = [];
    const executor: SqlExecutor = {
      execute: async (sql) => { calls.push(sql); },
      query: async <T>(sql: string) => {
        calls.push(sql);
        if (sql.includes("CASE WHEN f.blob_id")) return [{ id: fileId, blob_id: blobId, bucket: "berry", object_key: "object", deleted_at: null }] as T[];
        if (sql.includes("reference_exists")) return [{ reference_exists: true }] as T[];
        return [] as T[];
      },
    };

    await expect(garbageCollectFileIfUnreferenced(executor, tenantId, fileId))
      .resolves.toEqual({ collected: false, blobScheduled: false });
    // Restoration changes the task tombstone, not its association. Re-running
    // collection after restoration must observe the same durable reference.
    await expect(garbageCollectFileIfUnreferenced(executor, tenantId, fileId))
      .resolves.toEqual({ collected: false, blobScheduled: false });
    expect(calls.some((sql) => sql.includes("UPDATE files") && sql.includes("status = 'deleted'"))).toBe(false);
    const referenceQuery = calls.find((sql) => sql.includes("reference_exists"));
    expect(referenceQuery).toContain("FROM file_associations");
    expect(referenceQuery).toContain("FROM file_library_entries");
    expect(referenceQuery).toContain("JOIN workspace_files");
    expect(referenceQuery).toContain("FROM file_uploads");
    expect(referenceQuery).toContain("upload.status IN ('uploading')");
    expect(referenceQuery).not.toContain("task.deleted_at");
  });

  it("keeps a shared tenant blob while another live logical file points to it", async () => {
    const calls: string[] = [];
    const executor: SqlExecutor = {
      execute: async (sql) => { calls.push(sql); },
      query: async <T>(sql: string) => {
        calls.push(sql);
        if (sql.includes("CASE WHEN f.blob_id")) return [{ id: fileId, blob_id: blobId, bucket: "berry", object_key: "object", deleted_at: null }] as T[];
        if (sql.includes("reference_exists")) return [{ reference_exists: false }] as T[];
        if (sql.includes("UPDATE files")) return [{ id: fileId }] as T[];
        if (sql.includes("SELECT id FROM file_blobs")) return [{ id: blobId }] as T[];
        if (sql.includes("id <> $3")) return [{ id: "00000000-0000-7000-8000-000000000012" }] as T[];
        return [] as T[];
      },
    };

    await expect(garbageCollectFileIfUnreferenced(executor, tenantId, fileId))
      .resolves.toEqual({ collected: true, blobScheduled: false });
    expect(calls.some((sql) => sql.includes("UPDATE file_blobs"))).toBe(false);
  });
});
