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
