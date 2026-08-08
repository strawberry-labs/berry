import { describe, expect, it } from "vitest";
import { SqlMaintenanceRunner } from "./maintenance.js";
import type { SqlExecutor } from "./sql-repositories.js";

describe("SqlMaintenanceRunner", () => {
  it("runs the explicit legacy blob verification phase in bounded resumable batches", async () => {
    const blobId = "00000000-0000-7000-8000-000000000010";
    const executions: Array<{ sql: string; params: readonly unknown[] }> = [];
    const executor: SqlExecutor = {
      execute: async (sql, params = []) => { executions.push({ sql, params }); },
      query: async <T>(sql: string) => {
        if (sql.includes("FROM maintenance_runs")) {
          return [{ status: "running", cursor: { phase: "verify_file_blobs", lastId: null } }] as T[];
        }
        if (sql.includes("FROM file_blobs")) return [{ id: blobId }] as T[];
        return [] as T[];
      },
      transaction: async <T>(callback: (transaction: SqlExecutor) => Promise<T>) => callback(executor),
    };
    const runner = new SqlMaintenanceRunner(executor);

    await expect(runner.backfill({
      tenantId: "00000000-0000-7000-8000-000000000001",
      runId: "00000000-0000-7000-8000-000000000002",
      batchSize: 25,
      generation: 0,
      phase: "verify_file_blobs",
    })).resolves.toMatchObject({ status: "completed", phase: "done", scanned: 1, enqueued: 1 });

    const verification = executions.find((call) => call.sql.includes("'file.verify-blob'"));
    expect(verification?.params[1]).toBe(blobId);
    expect(verification?.sql).toContain("ON CONFLICT (tenant_id,dedupe_key) DO UPDATE");
  });

  it("repairs an orphan logical file and reports its delayed blob deletion", async () => {
    const tenantId = "00000000-0000-7000-8000-000000000001";
    const fileId = "00000000-0000-7000-8000-000000000010";
    const blobId = "00000000-0000-7000-8000-000000000011";
    const deleteAfter = new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000);
    const executions: Array<{ sql: string; params: readonly unknown[] }> = [];
    const queries: string[] = [];
    const executor: SqlExecutor = {
      execute: async (sql, params = []) => { executions.push({ sql, params }); },
      query: async <T>(sql: string) => {
        queries.push(sql);
        if (sql.includes("FROM maintenance_runs")) {
          return [{ status: "running", cursor: { phase: "orphan_files" } }] as T[];
        }
        if (sql.includes("SELECT f.id, f.blob_id")) {
          return [{ id: fileId, blob_id: blobId, bucket: "berry", object_key: "object", deleted_at: null }] as T[];
        }
        if (sql.includes("SELECT id FROM file_blobs") && sql.includes("FOR UPDATE")) {
          return [{ id: blobId }] as T[];
        }
        if (sql.includes("UPDATE file_blobs") && sql.includes("RETURNING delete_after")) {
          return [{ delete_after: deleteAfter }] as T[];
        }
        return [] as T[];
      },
      transaction: async <T>(callback: (transaction: SqlExecutor) => Promise<T>) => callback(executor),
    };
    const runner = new SqlMaintenanceRunner(executor);

    await expect(runner.cleanup({
      tenantId,
      runId: "00000000-0000-7000-8000-000000000002",
      batchSize: 25,
      generation: 0,
      eventRetentionDays: 30,
      diagnosticRetentionDays: 30,
      outboxRetentionDays: 7,
    })).resolves.toMatchObject({ status: "running", phase: "runtime_outbox", changed: 1, enqueued: 1 });

    expect(executions.some((call) => call.sql.includes("status='deleted'"))).toBe(true);
    expect(executions.find((call) => call.sql.includes("'file.delete-blob'"))?.params[4]).toBe(deleteAfter.toISOString());
    const blobLock = queries.findIndex((sql) => sql.includes("SELECT id FROM file_blobs") && sql.includes("FOR UPDATE"));
    const lastReferenceCheck = queries.findIndex((sql) => sql.includes("id<>$3::uuid") && sql.includes("deleted_at IS NULL"));
    expect(blobLock).toBeGreaterThan(-1);
    expect(lastReferenceCheck).toBeGreaterThan(blobLock);
  });

  it("retires expired uploads during scheduled cleanup without a Library request", async () => {
    const tenantId = "00000000-0000-7000-8000-000000000001";
    const fileId = "00000000-0000-7000-8000-000000000010";
    const executions: Array<{ sql: string; params: readonly unknown[] }> = [];
    const executor: SqlExecutor = {
      execute: async (sql, params = []) => { executions.push({ sql, params }); },
      query: async <T>(sql: string) => {
        if (sql.includes("FROM maintenance_runs")) {
          return [{ status: "running", cursor: { phase: "orphan_files" } }] as T[];
        }
        if (sql.includes("UPDATE file_uploads upload") && sql.includes("RETURNING upload.file_id")) {
          return [{ file_id: fileId }] as T[];
        }
        if (sql.includes("SELECT f.id FROM files f") && sql.includes("FOR UPDATE OF f")) {
          return [{ id: fileId }] as T[];
        }
        return [] as T[];
      },
      transaction: async <T>(callback: (transaction: SqlExecutor) => Promise<T>) => callback(executor),
    };
    const runner = new SqlMaintenanceRunner(executor);

    await expect(runner.cleanup({
      tenantId,
      runId: "00000000-0000-7000-8000-000000000002",
      batchSize: 25,
      generation: 0,
      eventRetentionDays: 30,
      diagnosticRetentionDays: 30,
      outboxRetentionDays: 7,
    })).resolves.toMatchObject({ status: "running", phase: "runtime_outbox" });

    expect(executions.some((call) => call.sql.includes("status='failed'") && call.params.includes(fileId))).toBe(true);
    expect(executions.some((call) => call.sql.includes("UPDATE file_library_entries") && call.sql.includes("deleted_at"))).toBe(true);
    expect(executions.some((call) => call.sql.includes("DELETE FROM file_associations"))).toBe(true);
    expect(executions.some((call) => call.sql.includes("UPDATE workspace_files") && call.sql.includes("index_status='deleted'"))).toBe(true);
  });

  it("schedules blob deletion for a logical file that was already tombstoned", async () => {
    const tenantId = "00000000-0000-7000-8000-000000000001";
    const fileId = "00000000-0000-7000-8000-000000000010";
    const blobId = "00000000-0000-7000-8000-000000000011";
    const deleteAfter = new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000);
    const executions: Array<{ sql: string; params: readonly unknown[] }> = [];
    const queries: string[] = [];
    const executor: SqlExecutor = {
      execute: async (sql, params = []) => { executions.push({ sql, params }); },
      query: async <T>(sql: string) => {
        queries.push(sql);
        if (sql.includes("FROM maintenance_runs")) {
          return [{ status: "running", cursor: { phase: "orphan_files" } }] as T[];
        }
        if (sql.includes("SELECT f.id, f.blob_id")) {
          return [{ id: fileId, blob_id: blobId, bucket: "berry", object_key: "object", deleted_at: "2026-01-01T00:00:00.000Z" }] as T[];
        }
        if (sql.includes("SELECT id FROM file_blobs") && sql.includes("FOR UPDATE")) {
          return [{ id: blobId }] as T[];
        }
        if (sql.includes("UPDATE file_blobs") && sql.includes("RETURNING delete_after")) {
          return [{ delete_after: deleteAfter }] as T[];
        }
        return [] as T[];
      },
      transaction: async <T>(callback: (transaction: SqlExecutor) => Promise<T>) => callback(executor),
    };
    const runner = new SqlMaintenanceRunner(executor);

    await expect(runner.cleanup({
      tenantId,
      runId: "00000000-0000-7000-8000-000000000002",
      batchSize: 25,
      generation: 0,
      eventRetentionDays: 30,
      diagnosticRetentionDays: 30,
      outboxRetentionDays: 7,
    })).resolves.toMatchObject({ status: "running", phase: "runtime_outbox", changed: 0, enqueued: 1 });

    expect(queries.find((sql) => sql.includes("SELECT f.id, f.blob_id"))).toContain("f.deleted_at IS NULL\n          OR");
    expect(executions.find((call) => call.sql.includes("'file.delete-blob'"))?.params[1]).toBe(blobId);
  });

  it("preserves a file when a reference appears while orphan maintenance waits for its lock", async () => {
    const tenantId = "00000000-0000-7000-8000-000000000001";
    const fileId = "00000000-0000-7000-8000-000000000010";
    const executions: Array<{ sql: string; params: readonly unknown[] }> = [];
    const executor: SqlExecutor = {
      execute: async (sql, params = []) => { executions.push({ sql, params }); },
      query: async <T>(sql: string) => {
        if (sql.includes("FROM maintenance_runs")) {
          return [{ status: "running", cursor: { phase: "orphan_files" } }] as T[];
        }
        if (sql.includes("SELECT f.id, f.blob_id")) {
          return [{ id: fileId, blob_id: "00000000-0000-7000-8000-000000000011", bucket: "berry", object_key: "object" }] as T[];
        }
        if (sql.includes("AS reference_exists")) return [{ reference_exists: true }] as T[];
        return [] as T[];
      },
      transaction: async <T>(callback: (transaction: SqlExecutor) => Promise<T>) => callback(executor),
    };
    const runner = new SqlMaintenanceRunner(executor);

    await expect(runner.cleanup({
      tenantId,
      runId: "00000000-0000-7000-8000-000000000002",
      batchSize: 25,
      generation: 0,
      eventRetentionDays: 30,
      diagnosticRetentionDays: 30,
      outboxRetentionDays: 7,
    })).resolves.toMatchObject({ status: "running", phase: "runtime_outbox", changed: 0, enqueued: 0 });

    expect(executions.some((call) => call.sql.includes("UPDATE files SET status='deleted'"))).toBe(false);
    expect(executions.some((call) => call.sql.includes("'file.delete-blob'"))).toBe(false);
  });

  it("does not create a stale project reference after garbage collection wins the file lock", async () => {
    const queries: string[] = [];
    const executions: string[] = [];
    const executor: SqlExecutor = {
      execute: async (sql) => { executions.push(sql); },
      query: async <T>(sql: string) => {
        queries.push(sql);
        if (sql.includes("FROM maintenance_runs")) {
          return [{ status: "running", cursor: { phase: "workspace_files", lastId: null } }] as T[];
        }
        if (sql.includes("SELECT fa.id AS association_id")) {
          return [{
            association_id: "00000000-0000-7000-8000-000000000020",
            file_id: "00000000-0000-7000-8000-000000000010",
            task_id: "00000000-0000-7000-8000-000000000030",
            workspace_id: "00000000-0000-7000-8000-000000000040",
            owner_user_id: "00000000-0000-7000-8000-000000000050",
          }] as T[];
        }
        // PostgreSQL rechecks f.deleted_at after a concurrent collector's
        // UPDATE commits, so a tombstoned candidate produces no locked row.
        if (sql.includes("FOR UPDATE OF f")) return [] as T[];
        return [] as T[];
      },
      transaction: async <T>(callback: (transaction: SqlExecutor) => Promise<T>) => callback(executor),
    };
    const runner = new SqlMaintenanceRunner(executor);

    await expect(runner.backfill({
      tenantId: "00000000-0000-7000-8000-000000000001",
      runId: "00000000-0000-7000-8000-000000000002",
      batchSize: 25,
      generation: 0,
      phase: "workspace_files",
    })).resolves.toMatchObject({ status: "running", phase: "file_sources", scanned: 1, changed: 0 });

    expect(queries.some((sql) => sql.includes("FOR UPDATE OF f") && sql.includes("f.deleted_at IS NULL"))).toBe(true);
    expect(queries.some((sql) => sql.includes("INSERT INTO workspace_files"))).toBe(false);
    expect(executions.some((sql) => sql.includes("INSERT INTO workspace_files"))).toBe(false);
  });

  it("releases stale model reservations that never reached durable admission", async () => {
    const queries: string[] = [];
    const executions: string[] = [];
    const executor: SqlExecutor = {
      execute: async (sql) => { executions.push(sql); },
      query: async <T>(sql: string) => {
        queries.push(sql);
        if (sql.includes("FROM maintenance_runs")) {
          return [{ status: "running", cursor: { phase: "orphan_budget_reservations" } }] as T[];
        }
        if (sql.includes("WITH candidates AS") && sql.includes("budget_reservations")) {
          return [{ id: "00000000-0000-7000-8000-000000000099" }] as T[];
        }
        return [] as T[];
      },
      transaction: async <T>(callback: (transaction: SqlExecutor) => Promise<T>) => callback(executor),
    };
    const runner = new SqlMaintenanceRunner(executor);

    await expect(runner.cleanup({
      tenantId: "00000000-0000-7000-8000-000000000001",
      runId: "00000000-0000-7000-8000-000000000002",
      batchSize: 25,
      generation: 0,
      eventRetentionDays: 30,
      diagnosticRetentionDays: 30,
      outboxRetentionDays: 7,
    })).resolves.toMatchObject({
      status: "running",
      phase: "orphan_files",
      changed: 1,
    });

    const cleanup = queries.find((sql) => sql.includes("WITH candidates AS"));
    expect(cleanup).toContain("run.request_id = reservation.request_id");
    expect(cleanup).toContain("SET status = 'released'");
    expect(cleanup).toContain("orphan_admission_timeout");
    expect(executions.some((sql) => sql.includes("INSERT INTO runtime_outbox"))).toBe(true);
  });
});
