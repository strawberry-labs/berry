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
