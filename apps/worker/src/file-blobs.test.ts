import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { SqlFileBlobProcessor } from "./file-blobs.js";
import type { SqlExecutor } from "./sql-repositories.js";

const tenantId = "00000000-0000-7000-8000-000000000001";
const blobId = "00000000-0000-7000-8000-000000000010";
const outboxId = "00000000-0000-7000-8000-000000000011";
const body = Buffer.from("berry-blob");

function blob(overrides: Record<string, unknown> = {}) {
  return {
    id: blobId,
    tenant_id: tenantId,
    bucket: "berry-test",
    object_key: "objects/berry.bin",
    size_bytes: body.length,
    sha256: null,
    etag: "etag",
    object_version_id: "v1",
    verification_status: "unverified",
    delete_after: null,
    deleted_at: null,
    updated_at: new Date(0),
    ...overrides,
  };
}

describe("SqlFileBlobProcessor verification", () => {
  it("closes a stale verification receipt when the blob is already terminal", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const executor = testExecutor(async <T>(sql: string) => sql.includes("SELECT * FROM file_blobs")
      ? [blob({ verification_status: "verified", sha256: "verified-digest" })] as T[]
      : [] as T[], calls);
    const client = { send: vi.fn() };
    const processor = new SqlFileBlobProcessor(executor, client as never);

    await expect(processor.verify({ tenantId, blobId })).resolves.toEqual({ status: "skipped" });

    expect(client.send).not.toHaveBeenCalled();
    expect(calls.some((call) => call.sql.includes("event_type='file.verify-blob'") && call.sql.includes("completed_at=COALESCE"))).toBe(true);
  });

  it("streams and verifies backend bytes before recording a tenant-scoped digest", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const executor = testExecutor(async <T>(sql: string, params: readonly unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes("sha256 = $2")) return [] as T[];
      if (sql.includes("SELECT * FROM file_blobs")) return [blob({ verification_status: sql.includes("FOR UPDATE") ? "unverified" : "verifying" })] as T[];
      if (sql.includes("SELECT * FROM file_blobs") || sql.includes("SELECT id FROM files")) return [] as T[];
      return [] as T[];
    }, calls);
    const client = { send: vi.fn(async () => ({ Body: asyncBody(body) })) };
    const processor = new SqlFileBlobProcessor(executor, client as never);

    const digest = createHash("sha256").update(body).digest("hex");
    await expect(processor.verify({ tenantId, blobId })).resolves.toEqual({ status: "verified", sha256: digest });

    const verified = calls.find((call) => call.sql.includes("SET sha256 = $3, verification_status = 'verified'"));
    expect(verified?.params).toEqual([tenantId, blobId, digest]);
    expect(client.send).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ Bucket: "berry-test", Key: "objects/berry.bin", VersionId: "v1" }),
    }));
    expect(calls.find((call) => call.sql.includes("sha256 = $2"))?.sql).toContain("tenant_id = $1::uuid");
    expect(calls.some((call) => call.sql.includes("now()+interval '15 minutes'"))).toBe(true);
    expect(calls.some((call) => call.sql.includes("event_type='file.verify-blob'") && call.sql.includes("completed_at=COALESCE"))).toBe(true);
  });

  it("does not consider an identical digest owned by another tenant", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const executor = testExecutor(async <T>(sql: string, params: readonly unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes("sha256 = $2")) return [] as T[];
      if (sql.includes("SELECT * FROM file_blobs")) return [blob({ verification_status: "unverified" })] as T[];
      return [] as T[];
    }, calls);
    const processor = new SqlFileBlobProcessor(executor, { send: vi.fn(async () => ({ Body: asyncBody(body) })) } as never);

    await expect(processor.verify({ tenantId, blobId })).resolves.toMatchObject({ status: "verified" });
    const winnerLookup = calls.find((call) => call.sql.includes("sha256 = $2"));
    expect(winnerLookup?.params[0]).toBe(tenantId);
    expect(winnerLookup?.sql).toContain("WHERE tenant_id = $1::uuid");
  });

  it("marks verification failed when streamed bytes do not match the stored size", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const executor = testExecutor(async <T>(sql: string) => sql.includes("SELECT * FROM file_blobs")
      ? [blob({ size_bytes: body.length + 1 })] as T[]
      : [] as T[], calls);
    const processor = new SqlFileBlobProcessor(executor, { send: vi.fn(async () => ({ Body: asyncBody(body) })) } as never);

    await expect(processor.verify({ tenantId, blobId })).rejects.toThrow("size mismatch");
    expect(calls.some((call) => call.sql.includes("verification_status = 'failed'"))).toBe(true);
    expect(calls.some((call) => call.sql.includes("file.verification_failed"))).toBe(true);
  });

  it("records a retryable failure when the backend object cannot be read", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const executor = testExecutor(async <T>(sql: string) => sql.includes("SELECT * FROM file_blobs")
      ? [blob()] as T[]
      : [] as T[], calls);
    const processor = new SqlFileBlobProcessor(executor, { send: vi.fn(async () => { throw new Error("temporary object-store failure"); }) } as never);

    await expect(processor.verify({ tenantId, blobId })).rejects.toThrow("temporary object-store failure");
    const failed = calls.find((call) => call.sql.includes("verification_status = 'failed'"));
    expect(failed?.params[2]).toBe("temporary object-store failure");
  });

  it("deduplicates only against a verified winner in the same tenant and delays loser deletion", async () => {
    const winnerId = "00000000-0000-7000-8000-000000000020";
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const deleteAfter = new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000);
    const executor = testExecutor(async <T>(sql: string, params: readonly unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes("sha256 = $2")) return [blob({ id: winnerId, sha256: "winner", verification_status: "verified" })] as T[];
      if (sql.includes("SELECT * FROM file_blobs")) return [blob({ verification_status: "verifying" })] as T[];
      if (sql.includes("RETURNING delete_after")) return [{ delete_after: deleteAfter }] as T[];
      return [] as T[];
    }, calls);
    const processor = new SqlFileBlobProcessor(executor, { send: vi.fn(async () => ({ Body: asyncBody(body) })) } as never);

    await expect(processor.verify({ tenantId, blobId })).resolves.toMatchObject({ status: "deduplicated" });
    const repoint = calls.find((call) => call.sql.includes("SET blob_id = $3::uuid"));
    expect(repoint?.params.slice(0, 3)).toEqual([tenantId, blobId, winnerId]);
    expect(repoint?.sql).not.toContain("object_key =");
    const winnerLookup = calls.find((call) => call.sql.includes("sha256 = $2"));
    expect(winnerLookup?.sql).toContain("tenant_id = $1::uuid");
    expect(calls.some((call) => call.sql.includes("now() + interval '7 days'"))).toBe(true);
    expect(calls.some((call) => call.sql.includes("'file.delete-blob'"))).toBe(true);
  });

  it("converges on the tenant-local winner after a concurrent unique-index race", async () => {
    const winnerId = "00000000-0000-7000-8000-000000000020";
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const deleteAfter = new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000);
    let winnerLookups = 0;
    let conflictRaised = false;
    const executor: SqlExecutor = {
      query: async <T>(sql: string, params: readonly unknown[] = []) => {
        calls.push({ sql, params });
        if (sql.includes("sha256 = $2")) {
          winnerLookups += 1;
          return (winnerLookups === 1 ? [] : [blob({ id: winnerId, sha256: "winner", verification_status: "verified" })]) as T[];
        }
        if (sql.includes("SELECT * FROM file_blobs")) return [blob({ verification_status: "verifying" })] as T[];
        if (sql.includes("RETURNING delete_after")) return [{ delete_after: deleteAfter }] as T[];
        return [] as T[];
      },
      execute: async (sql, params = []) => {
        calls.push({ sql, params });
        if (!conflictRaised && sql.includes("SET sha256 = $3, verification_status = 'verified'")) {
          conflictRaised = true;
          throw Object.assign(new Error("duplicate verified digest"), { code: "23505" });
        }
      },
    };
    executor.transaction = async <T>(callback: (transaction: SqlExecutor) => Promise<T>) => callback(executor);
    const processor = new SqlFileBlobProcessor(executor, { send: vi.fn(async () => ({ Body: asyncBody(body) })) } as never);

    await expect(processor.verify({ tenantId, blobId })).resolves.toMatchObject({ status: "deduplicated" });
    expect(winnerLookups).toBe(2);
    expect(calls.find((call) => call.sql.includes("SET blob_id = $3::uuid"))?.params[2]).toBe(winnerId);
  });
});

describe("SqlFileBlobProcessor deletion", () => {
  it("fails closed before storage access when global physical locations are not enforced", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const executor: SqlExecutor = {
      execute: async (sql, params = []) => { calls.push({ sql, params }); },
      query: async <T>(sql: string, params: readonly unknown[] = []) => {
        calls.push({ sql, params });
        return [{ guard_name: null }] as T[];
      },
    };
    executor.transaction = async <T>(callback: (transaction: SqlExecutor) => Promise<T>) => callback(executor);
    const client = { send: vi.fn() };

    await expect(new SqlFileBlobProcessor(executor, client as never).delete({ tenantId, blobId, outboxId }))
      .rejects.toThrow("refusing blob deletion");
    expect(client.send).not.toHaveBeenCalled();
    expect(calls.some((call) => call.sql.includes("SELECT id, deleted_at FROM files"))).toBe(false);
  });

  it("cancels during the grace period when a live logical file appears", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const executor = testExecutor(async <T>(sql: string) => {
      calls.push({ sql, params: [] });
      if (sql.includes("SELECT id, deleted_at FROM files")) return [{ id: "file", deleted_at: null }] as T[];
      if (sql.includes("SELECT * FROM file_blobs")) return [blob({ verification_status: "pending_delete", delete_after: new Date(Date.now() - 1_000) })] as T[];
      if (sql.includes("SET verification_status='deleted'")) return [{ id: blobId }] as T[];
      if (sql.includes("SELECT id FROM runtime_outbox")) return [{ id: outboxId }] as T[];
      if (sql.includes("UPDATE runtime_outbox")) return [{ id: outboxId }] as T[];
      return [] as T[];
    }, calls);
    const client = { send: vi.fn() };
    const processor = new SqlFileBlobProcessor(executor, client as never);

    await expect(processor.delete({ tenantId, blobId, outboxId })).resolves.toEqual({ deleted: 0, cancelled: true });
    expect(client.send).not.toHaveBeenCalled();
    expect(calls.some((call) => call.sql.includes("delete_after = NULL"))).toBe(true);
  });

  it("fails closed when a deleted logical row still has an authoritative reference", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const executor = testExecutor(async <T>(sql: string) => {
      calls.push({ sql, params: [] });
      if (sql.includes("SELECT id, deleted_at FROM files")) return [{ id: "file", deleted_at: new Date() }] as T[];
      if (sql.includes("SELECT * FROM file_blobs")) return [blob({ verification_status: "pending_delete", delete_after: new Date(Date.now() - 1_000) })] as T[];
      if (sql.includes("SELECT id FROM runtime_outbox")) return [{ id: outboxId }] as T[];
      if (sql.includes("AS reference_exists")) return [{ reference_exists: true }] as T[];
      if (sql.includes("UPDATE runtime_outbox")) return [{ id: outboxId }] as T[];
      return [] as T[];
    }, calls);
    const client = { send: vi.fn() };
    const processor = new SqlFileBlobProcessor(executor, client as never);

    await expect(processor.delete({ tenantId, blobId, outboxId })).resolves.toEqual({ deleted: 0, cancelled: true });
    expect(client.send).not.toHaveBeenCalled();
    expect(calls.find((call) => call.sql.includes("AS reference_exists"))?.sql).toContain("FROM file_associations");
  });

  it("deletes every object version and acknowledges an eligible blob idempotently", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const executor = testExecutor(async <T>(sql: string) => {
      calls.push({ sql, params: [] });
      if (sql.includes("SELECT id, deleted_at FROM files")) return [] as T[];
      if (sql.includes("SELECT * FROM file_blobs")) return [blob({ verification_status: "pending_delete", delete_after: new Date(Date.now() - 1_000) })] as T[];
      if (sql.includes("SET verification_status='deleted'")) return [{ id: blobId }] as T[];
      if (sql.includes("SELECT id FROM runtime_outbox")) return [{ id: outboxId }] as T[];
      if (sql.includes("UPDATE runtime_outbox")) return [{ id: outboxId }] as T[];
      return [] as T[];
    }, calls);
    const client = { send: vi.fn(async (command: object) => command.constructor.name === "ListObjectVersionsCommand"
      ? { Versions: [{ Key: "objects/berry.bin", VersionId: "v1" }], DeleteMarkers: [{ Key: "objects/berry.bin", VersionId: "marker" }] }
      : {}) };
    const processor = new SqlFileBlobProcessor(executor, client as never);

    await expect(processor.delete({ tenantId, blobId, outboxId })).resolves.toEqual({ deleted: 1 });
    expect(client.send).toHaveBeenCalledTimes(1);
    expect((client.send.mock.calls[0]?.[0] as { input?: Record<string, unknown> }).input).toMatchObject({
      Bucket: "berry-test",
      Key: "objects/berry.bin",
      VersionId: "v1",
    });
    expect(calls.some((call) => call.sql.includes("verification_status='deleted'"))).toBe(true);
    expect(calls.some((call) => call.sql.includes("event_type = 'file.delete-blob'"))).toBe(true);
  });

  it("performs storage deletion after the claim transaction releases database locks", async () => {
    let transactionActive = false;
    let remoteCallDuringTransaction = false;
    const executor = testExecutor(async <T>(sql: string) => {
      if (sql.includes("SELECT id, deleted_at FROM files")) return [] as T[];
      if (sql.includes("SELECT * FROM file_blobs")) return [blob({ verification_status: "pending_delete", delete_after: new Date(Date.now() - 1_000) })] as T[];
      if (sql.includes("SELECT id FROM runtime_outbox")) return [{ id: outboxId }] as T[];
      if (sql.includes("SET verification_status='deleted'")) return [{ id: blobId }] as T[];
      if (sql.includes("UPDATE runtime_outbox")) return [{ id: outboxId }] as T[];
      return [] as T[];
    }, []);
    executor.transaction = async <T>(callback: (transaction: SqlExecutor) => Promise<T>) => {
      transactionActive = true;
      try {
        return await callback(executor);
      } finally {
        transactionActive = false;
      }
    };
    const client = {
      send: vi.fn(async () => {
        if (transactionActive) remoteCallDuringTransaction = true;
        return {};
      }),
    };

    await expect(new SqlFileBlobProcessor(executor, client as never).delete({ tenantId, blobId, outboxId }))
      .resolves.toEqual({ deleted: 1 });
    expect(client.send).toHaveBeenCalledOnce();
    expect(remoteCallDuringTransaction).toBe(false);
  });
});

function testExecutor(
  queryImpl: SqlExecutor["query"],
  calls: Array<{ sql: string; params: readonly unknown[] }>,
): SqlExecutor {
  const executor: SqlExecutor = {
    execute: async (sql, params = []) => { calls.push({ sql, params }); },
    query: async <T>(sql: string, params: readonly unknown[] = []) => {
      if (sql.includes("to_regclass")) {
        return [{ guard_name: "file_blobs_physical_location_unique" }] as T[];
      }
      return queryImpl<T>(sql, params);
    },
  };
  executor.transaction = async <T>(callback: (transaction: SqlExecutor) => Promise<T>) => callback(executor);
  return executor;
}

function asyncBody(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      yield bytes;
    },
  };
}
