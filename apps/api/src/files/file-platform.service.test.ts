import { describe, expect, it, vi } from "vitest";
import type { SqlExecutor } from "../db/cloud-database.service.ts";
import { FilePlatformService } from "./file-platform.service.ts";

const TENANT_ID = "00000000-0000-7000-8000-000000000001";
const USER_ID = "00000000-0000-7000-8000-000000000201";
const TASK_ID = "00000000-0000-7000-8000-000000000202";
const WORKSPACE_ID = "00000000-0000-7000-8000-000000000203";

describe("FilePlatformService.list", () => {
  it("keeps searches tenant- and owner-scoped while treating wildcard input literally", async () => {
    const execute = vi.fn(async () => undefined);
    const queries: Array<{ sql: string; params: readonly unknown[] }> = [];
    const executor: SqlExecutor = {
      execute,
      query: async <T>(sql: string, params: readonly unknown[] = []) => {
        queries.push({ sql, params });
        return [] as T[];
      },
    };
    const withTenant = vi.fn(async (_tenantId: string, callback: (tenantExecutor: SqlExecutor) => Promise<unknown>) => callback(executor));
    const database = { withTenant };
    const service = new FilePlatformService(database as never, null);

    await service.list(TENANT_ID, USER_ID, { search: "budget 100%_\\", limit: 25 });

    expect(withTenant).toHaveBeenCalledWith(TENANT_ID, expect.any(Function));
    const { sql, params } = queries[0]!;
    expect(sql).toContain("f.tenant_id = $1::uuid");
    expect(sql).toContain("f.owner_user_id = $2::uuid");
    expect(sql).toContain("f.display_name ILIKE $3 ESCAPE '\\' OR f.original_name ILIKE $3 ESCAPE '\\'");
    expect(params).toEqual([TENANT_ID, USER_ID, "%budget 100\\%\\_\\\\%", 26]);
  });

  it("scopes the library to files linked to tasks or uploads in a project", async () => {
    const execute = vi.fn(async () => undefined);
    const queries: Array<{ sql: string; params: readonly unknown[] }> = [];
    const executor: SqlExecutor = {
      execute,
      query: async <T>(sql: string, params: readonly unknown[] = []) => {
        queries.push({ sql, params });
        if (sql.includes("FROM workspaces")) return [{ id: WORKSPACE_ID }] as T[];
        return [] as T[];
      },
    };
    const database = {
      withTenant: vi.fn(async (_tenantId: string, callback: (tenantExecutor: SqlExecutor) => Promise<unknown>) => callback(executor)),
    };
    const service = new FilePlatformService(database as never, null);

    await service.list(TENANT_ID, USER_ID, { workspaceId: WORKSPACE_ID, limit: 25 });

    const listQuery = queries.at(-1)!;
    expect(listQuery.sql).toContain("workspace_task.workspace_id = $3::uuid");
    expect(listQuery.sql).toContain("project_file_link.workspace_id = $3::uuid");
    expect(listQuery.params).toEqual([TENANT_ID, USER_ID, WORKSPACE_ID, 26]);
  });
});

describe("FilePlatformService.initiateUpload", () => {
  it("links a project-chat attachment as task-only knowledge by default", async () => {
    const executions: Array<{ sql: string; params: readonly unknown[] }> = [];
    const executor: SqlExecutor = {
      execute: async (sql, params = []) => {
        executions.push({ sql, params });
      },
      query: async <T>(sql: string) => {
        if (sql.includes("FROM tasks")) return [{ id: TASK_ID, workspace_id: WORKSPACE_ID }] as T[];
        return [] as T[];
      },
    };
    const database = {
      withTenant: async (_tenantId: string, callback: (tenantExecutor: SqlExecutor) => Promise<unknown>) => callback(executor),
    };
    const client = {
      send: vi.fn(async (command: object) => {
        if (command.constructor.name === "CreateMultipartUploadCommand") return { UploadId: "provider-upload-1" };
        throw new Error(`Unexpected S3 command: ${command.constructor.name}`);
      }),
    };
    const service = new FilePlatformService(database as never, {
      client,
      presignClient: client,
      bucket: "berry-test",
      prefix: "artifacts",
      maxUploadBytes: 1024,
      partSize: 5 * 1024 * 1024,
      presignSeconds: 900,
    } as never);

    await service.initiateUpload(TENANT_ID, USER_ID, {
      name: "notes.txt",
      mediaType: "text/plain",
      size: 12,
      taskId: TASK_ID,
    });

    const workspaceInsert = executions.find((call) => call.sql.includes("INSERT INTO workspace_files"));
    expect(workspaceInsert?.params).toEqual([
      TENANT_ID,
      WORKSPACE_ID,
      expect.any(String),
      "task_only",
      TASK_ID,
      USER_ID,
    ]);
  });
});

describe("FilePlatformService.completeUpload", () => {
  it("reconciles PostgreSQL when S3 already completed the multipart upload", async () => {
    const executions: Array<{ sql: string; params: readonly unknown[] }> = [];
    const fileId = "00000000-0000-7000-8000-000000000204";
    const uploadId = "00000000-0000-7000-8000-000000000205";
    const fileRow = {
      id: fileId,
      owner_user_id: USER_ID,
      original_name: "notes.txt",
      display_name: "notes.txt",
      media_type: "text/plain",
      detected_media_type: null,
      size_bytes: 12,
      sha256: null,
      bucket: "berry-test",
      object_key: "artifacts/notes.txt",
      etag: "etag",
      origin: "user_upload",
      status: "available",
      created_at: new Date(),
      updated_at: new Date(),
      task_ids: [],
      roles: [],
    };
    const executor: SqlExecutor = {
      execute: async (sql, params = []) => { executions.push({ sql, params }); },
      query: async <T>(sql: string) => {
        if (sql.includes("SELECT f.*")) return [fileRow] as T[];
        if (sql.includes("SELECT u.*")) return [{
          id: uploadId,
          file_id: fileId,
          provider_upload_id: "consumed-provider-upload",
          part_size: 5 * 1024 * 1024,
          part_count: 1,
          status: "uploading",
          expires_at: new Date(Date.now() + 60_000),
          object_key: "artifacts/notes.txt",
          declared_size_bytes: 12,
        }] as T[];
        return [] as T[];
      },
    };
    const database = {
      withTenant: async (_tenantId: string, callback: (tenantExecutor: SqlExecutor) => Promise<unknown>) => callback(executor),
    };
    const client = {
      send: vi.fn(async (command: object) => {
        if (command.constructor.name === "CompleteMultipartUploadCommand") throw new Error("NoSuchUpload");
        if (command.constructor.name === "HeadObjectCommand") return { ContentLength: 12, ETag: "etag" };
        throw new Error(`Unexpected S3 command: ${command.constructor.name}`);
      }),
    };
    const service = new FilePlatformService(database as never, {
      client,
      presignClient: client,
      bucket: "berry-test",
      prefix: "artifacts",
      maxUploadBytes: 1024,
      maxIndexableBytes: 512,
      partSize: 5 * 1024 * 1024,
      presignSeconds: 900,
    } as never);

    await expect(service.completeUpload(TENANT_ID, USER_ID, fileId, uploadId, [{ PartNumber: 1, ETag: "etag" }]))
      .resolves.toMatchObject({ id: fileId });

    expect(executions.some((call) => call.sql.includes("UPDATE file_uploads SET status = 'completed'"))).toBe(true);
    expect(executions.some((call) => call.sql.includes("UPDATE files SET status = $6"))).toBe(true);
  });

  it("returns the completed file when the completion response is retried", async () => {
    const fileId = "00000000-0000-7000-8000-000000000204";
    const uploadId = "00000000-0000-7000-8000-000000000205";
    const executor: SqlExecutor = {
      execute: async () => undefined,
      query: async <T>(sql: string) => {
        if (sql.includes("SELECT u.*")) return [{
          id: uploadId,
          file_id: fileId,
          provider_upload_id: "consumed-provider-upload",
          part_size: 5 * 1024 * 1024,
          part_count: 1,
          status: "completed",
          expires_at: new Date(Date.now() - 60_000),
          object_key: "artifacts/notes.txt",
          declared_size_bytes: 12,
        }] as T[];
        if (sql.includes("SELECT f.*")) return [{
          id: fileId,
          owner_user_id: USER_ID,
          original_name: "notes.txt",
          display_name: "notes.txt",
          media_type: "text/plain",
          detected_media_type: null,
          size_bytes: 12,
          sha256: null,
          bucket: "berry-test",
          object_key: "artifacts/notes.txt",
          etag: "etag",
          origin: "user_upload",
          status: "available",
          created_at: new Date(),
          updated_at: new Date(),
          task_ids: [],
          roles: [],
        }] as T[];
        return [] as T[];
      },
    };
    const database = {
      withTenant: async (_tenantId: string, callback: (tenantExecutor: SqlExecutor) => Promise<unknown>) => callback(executor),
    };
    const client = { send: vi.fn() };
    const service = new FilePlatformService(database as never, {
      client,
      presignClient: client,
      bucket: "berry-test",
      prefix: "artifacts",
      maxUploadBytes: 1024,
      maxIndexableBytes: 512,
      partSize: 5 * 1024 * 1024,
      presignSeconds: 900,
    } as never);

    await expect(service.completeUpload(TENANT_ID, USER_ID, fileId, uploadId, []))
      .resolves.toMatchObject({ id: fileId, status: "available" });
    expect(client.send).not.toHaveBeenCalled();
  });

  it("rejects and removes an object whose actual size differs from the declared upload", async () => {
    const executions: Array<{ sql: string; params: readonly unknown[] }> = [];
    const executor: SqlExecutor = {
      execute: async (sql, params = []) => {
        executions.push({ sql, params });
      },
      query: async <T>(sql: string) => {
        if (sql.includes("SELECT f.*")) {
          return [{
            id: "00000000-0000-7000-8000-000000000204",
            owner_user_id: USER_ID,
            original_name: "notes.txt",
            display_name: "notes.txt",
            media_type: "text/plain",
            detected_media_type: null,
            size_bytes: 12,
            sha256: null,
            bucket: "berry-test",
            object_key: "artifacts/notes.txt",
            etag: null,
            origin: "user_upload",
            status: "uploading",
            created_at: new Date(),
            updated_at: new Date(),
          }] as T[];
        }
        if (sql.includes("SELECT u.*")) {
          return [{
            id: "00000000-0000-7000-8000-000000000205",
            file_id: "00000000-0000-7000-8000-000000000204",
            provider_upload_id: "provider-upload-1",
            part_size: 5 * 1024 * 1024,
            part_count: 1,
            status: "uploading",
            expires_at: new Date(Date.now() + 60_000),
            object_key: "artifacts/notes.txt",
            declared_size_bytes: 12,
          }] as T[];
        }
        return [] as T[];
      },
    };
    const database = {
      withTenant: async (_tenantId: string, callback: (tenantExecutor: SqlExecutor) => Promise<unknown>) => callback(executor),
    };
    const client = {
      send: vi.fn(async (command: object) => {
        if (command.constructor.name === "CompleteMultipartUploadCommand") return { ETag: "etag" };
        if (command.constructor.name === "HeadObjectCommand") return { ContentLength: 13, ETag: "etag" };
        if (command.constructor.name === "DeleteObjectCommand") return {};
        throw new Error(`Unexpected S3 command: ${command.constructor.name}`);
      }),
    };
    const service = new FilePlatformService(database as never, {
      client,
      presignClient: client,
      bucket: "berry-test",
      prefix: "artifacts",
      maxUploadBytes: 1024,
      maxIndexableBytes: 512,
      partSize: 5 * 1024 * 1024,
      presignSeconds: 900,
    } as never);

    await expect(service.completeUpload(
      TENANT_ID,
      USER_ID,
      "00000000-0000-7000-8000-000000000204",
      "00000000-0000-7000-8000-000000000205",
      [{ PartNumber: 1, ETag: "etag" }],
    )).rejects.toThrow("does not match");

    expect(client.send).toHaveBeenCalledWith(expect.objectContaining({
      constructor: expect.objectContaining({ name: "DeleteObjectCommand" }),
    }));
    expect(executions.some((call) => call.sql.includes("status='failed'"))).toBe(true);
  });
});

describe("FilePlatformService.deleteOwnedFile", () => {
  it("tombstones every association and durably queues object and knowledge deletion", async () => {
    const fileId = "00000000-0000-7000-8000-000000000204";
    const sourceId = "00000000-0000-7000-8000-000000000205";
    const calls: Array<{ kind: "execute" | "query"; sql: string; params: readonly unknown[] }> = [];
    const fileRow = {
      id: fileId,
      owner_user_id: USER_ID,
      original_name: "report.pdf",
      display_name: "report.pdf",
      media_type: "application/pdf",
      detected_media_type: null,
      size_bytes: 12,
      sha256: null,
      bucket: "berry-test",
      object_key: "artifacts/original.pdf",
      etag: "etag",
      origin: "user_upload",
      status: "available",
      created_at: new Date(),
      updated_at: new Date(),
      task_ids: [TASK_ID],
      roles: ["output"],
    };
    const executor: SqlExecutor = {
      execute: async (sql, params = []) => {
        calls.push({ kind: "execute", sql, params });
      },
      query: async <T>(sql: string, params: readonly unknown[] = []) => {
        calls.push({ kind: "query", sql, params });
        if (sql.includes("SELECT f.*")) return [fileRow] as T[];
        if (sql.includes("FROM file_derivatives")) {
          return [
            { object_key: "artifacts/preview.png" },
            { object_key: "artifacts/preview.png" },
          ] as T[];
        }
        if (sql.includes("UPDATE knowledge_sources")) {
          return [{ id: sourceId, source_revision: "rev-1" }] as T[];
        }
        if (sql.includes("UPDATE files")) return [{ id: fileId }] as T[];
        return [] as T[];
      },
    };
    const database = {
      withTenant: vi.fn(async (_tenantId: string, callback: (tenantExecutor: SqlExecutor) => Promise<unknown>) => callback(executor)),
    };
    const service = new FilePlatformService(database as never, null);

    await expect(service.deleteOwnedFile(TENANT_ID, USER_ID, fileId)).resolves.toEqual({ ok: true });

    const ownershipLockIndex = calls.findIndex((call) => call.sql.includes("SELECT f.*") && call.sql.includes("FOR UPDATE"));
    expect(calls.some((call) => call.sql.includes("UPDATE workspace_files") && call.sql.includes("deleted_at"))).toBe(true);
    expect(calls.some((call) => call.sql.includes("UPDATE knowledge_sources") && call.sql.includes("vector_ready = false"))).toBe(true);
    const sourceTombstoneIndex = calls.findIndex((call) => call.sql.includes("UPDATE knowledge_sources"));
    const derivativeReadIndex = calls.findIndex((call) => call.sql.includes("FROM file_derivatives"));
    expect(ownershipLockIndex).toBeGreaterThanOrEqual(0);
    expect(sourceTombstoneIndex).toBeGreaterThan(ownershipLockIndex);
    expect(sourceTombstoneIndex).toBeGreaterThanOrEqual(0);
    expect(derivativeReadIndex).toBeGreaterThan(sourceTombstoneIndex);
    const knowledgeOutbox = calls.find((call) => call.kind === "execute" && call.sql.includes("'knowledge.delete'"));
    expect(knowledgeOutbox?.params).toContain(`knowledge.delete:${sourceId}:rev-1`);
    const objectOutbox = calls.find((call) => call.kind === "execute" && call.sql.includes("'file.delete-object'"));
    expect(JSON.parse(String(objectOutbox?.params[3]))).toEqual({
      tenantId: TENANT_ID,
      fileId,
      bucket: "berry-test",
      keys: ["artifacts/original.pdf", "artifacts/preview.png"],
    });
  });

  it("does not delete a file owned by another user", async () => {
    const executor: SqlExecutor = {
      execute: vi.fn(async () => undefined),
      query: vi.fn(async () => []),
    };
    const database = {
      withTenant: vi.fn(async (_tenantId: string, callback: (tenantExecutor: SqlExecutor) => Promise<unknown>) => callback(executor)),
    };
    const service = new FilePlatformService(database as never, null);

    await expect(service.deleteOwnedFile(TENANT_ID, USER_ID, "00000000-0000-7000-8000-000000000204"))
      .rejects.toThrow("File not found");
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("treats a retry after a lost success response as idempotently complete", async () => {
    const fileId = "00000000-0000-7000-8000-000000000204";
    let queryCount = 0;
    const query: SqlExecutor["query"] = async <T>() => {
      queryCount += 1;
      return [{
        id: fileId,
        owner_user_id: USER_ID,
        deleted_at: new Date(),
        object_key: "artifacts/already-deleted.pdf",
      }] as T[];
    };
    const execute = vi.fn(async () => undefined);
    const executor: SqlExecutor = { execute, query };
    const database = {
      withTenant: vi.fn(async (_tenantId: string, callback: (tenantExecutor: SqlExecutor) => Promise<unknown>) => callback(executor)),
    };
    const service = new FilePlatformService(database as never, null);

    await expect(service.deleteOwnedFile(TENANT_ID, USER_ID, fileId)).resolves.toEqual({ ok: true });
    expect(queryCount).toBe(1);
    expect(execute).not.toHaveBeenCalled();
  });
});
