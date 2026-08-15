import { describe, expect, it, vi } from "vitest";
import { FILE_RESPONSE_SECURITY_VERSION } from "@berry/shared";
import type { SqlExecutor } from "../db/cloud-database.service.ts";
import { FilePlatformService } from "./file-platform.service.ts";
import {
  INVALID_FILE_CACHE_CONTROL,
  PROTECTED_FILE_CACHE_CONTROL,
  PUBLIC_IMMUTABLE_FILE_CACHE_CONTROL,
} from "./file-response-security.ts";

const TENANT_ID = "00000000-0000-7000-8000-000000000001";
const USER_ID = "00000000-0000-7000-8000-000000000201";
const OTHER_USER_ID = "00000000-0000-7000-8000-000000000209";
const TASK_ID = "00000000-0000-7000-8000-000000000202";
const WORKSPACE_ID = "00000000-0000-7000-8000-000000000203";
const SESSION_ID = "00000000-0000-7000-8000-000000000206";
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

describe("FilePlatformService.list", () => {
  it("keeps searches tenant- and membership-scoped while treating wildcard input literally", async () => {
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
    const { sql, params } = queries.at(-1)!;
    expect(sql).toContain("f.tenant_id = $1::uuid");
    expect(sql).toContain("library.user_id = $2::uuid");
    expect(sql).toContain("library.deleted_at IS NULL");
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

  it("retires references and schedules blob cleanup for expired uploads", async () => {
    const fileId = "00000000-0000-7000-8000-000000000204";
    const blobId = "00000000-0000-7000-8000-000000000205";
    const calls: Array<{ kind: "execute" | "query"; sql: string; params: readonly unknown[] }> = [];
    const deleteAfter = new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000);
    const executor: SqlExecutor = {
      execute: async (sql, params = []) => { calls.push({ kind: "execute", sql, params }); },
      query: async <T>(sql: string, params: readonly unknown[] = []) => {
        calls.push({ kind: "query", sql, params });
        if (sql.includes("UPDATE file_uploads") && sql.includes("RETURNING file_id")) return [{ file_id: fileId }] as T[];
        if (sql.includes("SELECT f.id, f.blob_id") && sql.includes("FOR UPDATE OF f")) return [{ id: fileId, blob_id: blobId, bucket: "berry-test", object_key: "artifact", deleted_at: null }] as T[];
        if (sql.includes("reference_exists")) return [{ reference_exists: false }] as T[];
        if (sql.includes("UPDATE files") && sql.includes("RETURNING id")) return [{ id: fileId }] as T[];
        if (sql.includes("SELECT id FROM file_blobs")) return [{ id: blobId }] as T[];
        if (sql.includes("id <> $3")) return [] as T[];
        if (sql.includes("UPDATE file_blobs")) return [{ delete_after: deleteAfter }] as T[];
        return [] as T[];
      },
    };
    const database = {
      withTenant: async (_tenantId: string, callback: (tenantExecutor: SqlExecutor) => Promise<unknown>) => callback(executor),
    };
    const service = new FilePlatformService(database as never, null);

    await expect(service.list(TENANT_ID, USER_ID, {})).resolves.toMatchObject({ items: [] });

    expect(calls.some(({ sql }) => sql.includes("UPDATE file_library_entries") && sql.includes("deleted_at"))).toBe(true);
    expect(calls.some(({ sql }) => sql.includes("DELETE FROM file_associations"))).toBe(true);
    expect(calls.some(({ sql }) => sql.includes("UPDATE workspace_files") && sql.includes("index_status = 'deleted'"))).toBe(true);
    expect(calls.some(({ sql }) => sql.includes("'file.delete-blob'"))).toBe(true);
  });
});

describe("FilePlatformService.authorizeRegisteredArtifactObjectKey", () => {
  it("reuses normal file access for metadata-less legacy keys and rejects another user", async () => {
    const fileId = "00000000-0000-7000-8000-000000000204";
    const objectKey = `artifacts/${fileId}-legacy.png`;
    const executor: SqlExecutor = {
      execute: async () => undefined,
      query: async <T>(sql: string, params: readonly unknown[] = []) => {
        if (sql.includes("FROM files") && sql.includes("object_key=$2")) {
          return params[1] === objectKey ? [{ id: fileId }] as T[] : [] as T[];
        }
        if (sql.includes("SELECT f.*")) {
          if (params[1] !== USER_ID) return [] as T[];
          return [{
            id: fileId,
            owner_user_id: USER_ID,
            blob_id: null,
            original_name: "legacy.png",
            display_name: "legacy.png",
            media_type: "image/png",
            detected_media_type: "image/png",
            size_bytes: PNG_BYTES.byteLength,
            sha256: null,
            bucket: "berry-test",
            object_key: objectKey,
            etag: null,
            object_version_id: null,
            origin: "sandbox_output",
            status: "available",
            created_at: new Date(),
            updated_at: new Date(),
            task_ids: [TASK_ID],
            roles: ["output"],
          }] as T[];
        }
        return [] as T[];
      },
    };
    const database = {
      withTenant: async (_tenantId: string, callback: (tenantExecutor: SqlExecutor) => Promise<unknown>) => callback(executor),
    };
    const service = new FilePlatformService(database as never, null);

    await expect(service.authorizeRegisteredArtifactObjectKey(TENANT_ID, USER_ID, objectKey)).resolves.toBe(true);
    await expect(service.authorizeRegisteredArtifactObjectKey(TENANT_ID, OTHER_USER_ID, objectKey)).rejects.toThrow("File not found");
    await expect(service.authorizeRegisteredArtifactObjectKey(TENANT_ID, USER_ID, `${objectKey}.missing`)).resolves.toBe(false);
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
        if (sql.includes("SELECT f.id, f.blob_id") && sql.includes("FOR UPDATE OF f")) return [{ id: "file", blob_id: null }] as T[];
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
    expect(executions.some((call) => call.sql.includes("INSERT INTO file_library_entries"))).toBe(false);
  });
});

describe("FilePlatformService.streamContent", () => {
  it("reads the exact object version owned by the resolved blob", async () => {
    const fileId = "00000000-0000-7000-8000-000000000204";
    const executor: SqlExecutor = {
      execute: async () => undefined,
      query: async <T>(sql: string) => sql.includes("SELECT f.*") ? [{
        id: fileId,
        owner_user_id: USER_ID,
        blob_id: "00000000-0000-7000-8000-000000000205",
        original_name: "history.png",
        display_name: "history.png",
        media_type: "image/png",
        detected_media_type: null,
        size_bytes: PNG_BYTES.byteLength,
        sha256: null,
        bucket: "legacy-bucket",
        object_key: "legacy-key",
        etag: null,
        object_version_id: null,
        resolved_bucket: "berry-test",
        resolved_object_key: "objects/history.png",
        resolved_size_bytes: PNG_BYTES.byteLength,
        resolved_sha256: "digest",
        resolved_etag: "etag",
        resolved_object_version_id: "version-7",
        origin: "image_generation",
        status: "available",
        created_at: new Date(),
        updated_at: new Date(),
        task_ids: [TASK_ID],
        roles: ["output"],
      }] as T[] : [] as T[],
    };
    const database = {
      withTenant: async (_tenantId: string, callback: (tenantExecutor: SqlExecutor) => Promise<unknown>) => callback(executor),
    };
    const body = {
      async *[Symbol.asyncIterator]() { yield PNG_BYTES; },
    };
    const client = { send: vi.fn(async () => ({ Body: body, ContentType: "image/png", ContentLength: PNG_BYTES.byteLength })) };
    const response = {
      statusCode: 0,
      setHeader: vi.fn(),
      write: vi.fn(() => true),
      end: vi.fn(),
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

    await service.streamContent(TENANT_ID, USER_ID, fileId, undefined, response as never);

    expect(client.send).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ Bucket: "berry-test", Key: "objects/history.png", VersionId: "version-7" }),
    }));
    expect(response.setHeader).toHaveBeenCalledWith("ETag", `"berry-file-response-v${FILE_RESPONSE_SECURITY_VERSION}-digest"`);
    expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", PROTECTED_FILE_CACHE_CONTROL);
    expect(response.setHeader).toHaveBeenCalledWith("Content-Type", "image/png");
    expect(response.setHeader).toHaveBeenCalledWith("Content-Disposition", expect.stringMatching(/^inline;/));
    expect(response.end).toHaveBeenCalledOnce();
  });

  it("reauthorizes a protected file after access is revoked", async () => {
    const fileId = "00000000-0000-7000-8000-000000000204";
    let accessGranted = true;
    let accessChecks = 0;
    const executor: SqlExecutor = {
      execute: async () => undefined,
      query: async <T>(sql: string) => {
        if (!sql.includes("SELECT f.*")) return [] as T[];
        accessChecks += 1;
        if (!accessGranted) return [] as T[];
        return [{
          id: fileId,
          owner_user_id: USER_ID,
          blob_id: null,
          original_name: "revocable.png",
          display_name: "revocable.png",
          media_type: "image/png",
          detected_media_type: "image/png",
          size_bytes: PNG_BYTES.byteLength,
          sha256: "revocable-digest",
          bucket: "berry-test",
          object_key: "revocable.png",
          etag: "storage-etag",
          object_version_id: null,
          origin: "user_upload",
          status: "available",
          created_at: new Date(),
          updated_at: new Date(),
          task_ids: [TASK_ID],
          roles: ["input"],
        }] as T[];
      },
    };
    const database = {
      withTenant: async (_tenantId: string, callback: (tenantExecutor: SqlExecutor) => Promise<unknown>) => callback(executor),
    };
    const client = { send: vi.fn(async () => ({
      Body: { async *[Symbol.asyncIterator]() { yield PNG_BYTES; } },
      ContentLength: PNG_BYTES.byteLength,
    })) };
    const service = new FilePlatformService(database as never, {
      client,
      presignClient: client,
      bucket: "berry-test",
      prefix: "artifacts",
      maxUploadBytes: 1024,
      partSize: 5 * 1024 * 1024,
      presignSeconds: 900,
    } as never);
    const grantedResponse = { statusCode: 0, setHeader: vi.fn(), write: vi.fn(() => true), end: vi.fn() };

    await service.streamContent(TENANT_ID, USER_ID, fileId, undefined, grantedResponse as never);
    expect(grantedResponse.setHeader).toHaveBeenCalledWith("Cache-Control", PROTECTED_FILE_CACHE_CONTROL);

    accessGranted = false;
    const revokedResponse = { statusCode: 0, setHeader: vi.fn(), write: vi.fn(() => true), end: vi.fn() };
    await expect(service.streamContent(TENANT_ID, USER_ID, fileId, undefined, revokedResponse as never))
      .rejects.toThrow("File not found");

    expect(revokedResponse.setHeader).toHaveBeenCalledWith("Cache-Control", INVALID_FILE_CACHE_CONTROL);
    expect(accessChecks).toBe(2);
    expect(client.send).toHaveBeenCalledOnce();
  });

  it.each([
    ["HTML", "text/html", Buffer.from("<!doctype html><script>top.pwned=true</script>"), "text/html"],
    ["SVG", "image/svg+xml", Buffer.from("<svg onload=\"top.pwned=true\"></svg>"), "image/svg+xml"],
    ["a spoofed image", "image/png", Buffer.from("<html><script>top.pwned=true</script></html>"), "text/html"],
  ])("downloads detected %s content instead of executing it inline", async (_label, declaredMediaType, bytes, expectedDetectedType) => {
    const result = await streamContentFixture({ declaredMediaType, bytes, objectMediaType: "image/png" });

    expect(result.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(result.headers.get("Content-Disposition")).toMatch(/^attachment;/);
    expect(result.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
    expect(result.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(result.headers.get("X-Frame-Options")).toBe("DENY");
    expect(result.detectedMediaTypeUpdate?.params).toEqual([TENANT_ID, result.fileId, expectedDetectedType]);
  });

  it("keeps a signature-validated passive image available inline", async () => {
    const result = await streamContentFixture({ declaredMediaType: "image/png", bytes: PNG_BYTES });

    expect(result.headers.get("Content-Type")).toBe("image/png");
    expect(result.headers.get("Content-Disposition")).toMatch(/^inline;/);
    expect(Buffer.concat(result.writes)).toEqual(PNG_BYTES);
  });

  it("sanitizes stored filenames before writing Content-Disposition", async () => {
    const result = await streamContentFixture({
      declaredMediaType: "text/html",
      bytes: Buffer.from("<html>download only</html>"),
      displayName: "report.html\r\nX-Injection: yes",
    });

    const disposition = String(result.headers.get("Content-Disposition"));
    expect(disposition).toMatch(/^attachment;/);
    expect(disposition).not.toContain("\r");
    expect(disposition).not.toContain("\n");
    expect(result.headers.has("X-Injection")).toBe(false);
  });

  it("returns 304 without transferring a cached image again", async () => {
    const fileId = "00000000-0000-7000-8000-000000000204";
    const executor: SqlExecutor = {
      execute: async () => undefined,
      query: async <T>(sql: string) => sql.includes("SELECT f.*") ? [{
        id: fileId, owner_user_id: USER_ID, original_name: "cached.png", display_name: "cached.png",
        media_type: "image/png", detected_media_type: null, size_bytes: 3, sha256: "content-digest",
        bucket: "berry-test", object_key: "cached.png", etag: "storage-etag", object_version_id: null,
        origin: "image_generation", status: "available", created_at: new Date(), updated_at: new Date(),
        task_ids: [TASK_ID], roles: ["output"],
      }] as T[] : [] as T[],
    };
    const database = { withTenant: async (_tenantId: string, callback: (value: SqlExecutor) => Promise<unknown>) => callback(executor) };
    const client = { send: vi.fn() };
    const response = { statusCode: 0, setHeader: vi.fn(), write: vi.fn(), end: vi.fn() };
    const service = new FilePlatformService(database as never, {
      client, presignClient: client, bucket: "berry-test", prefix: "artifacts",
      maxUploadBytes: 1024, partSize: 5 * 1024 * 1024, presignSeconds: 900,
    } as never);

    await service.streamContent(TENANT_ID, USER_ID, fileId, undefined, response as never, false, `W/"berry-file-response-v${FILE_RESPONSE_SECURITY_VERSION}-content-digest"`);

    expect(response.statusCode).toBe(304);
    expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", PROTECTED_FILE_CACHE_CONTROL);
    expect(client.send).not.toHaveBeenCalled();
    expect(response.end).toHaveBeenCalledOnce();
  });
});

async function streamContentFixture(input: {
  declaredMediaType: string;
  bytes: Uint8Array;
  displayName?: string;
  objectMediaType?: string;
}) {
  const fileId = "00000000-0000-7000-8000-000000000220";
  const executions: Array<{ sql: string; params: readonly unknown[] }> = [];
  const executor: SqlExecutor = {
    execute: async (sql, params = []) => { executions.push({ sql, params }); },
    query: async <T>(sql: string) => sql.includes("SELECT f.*") ? [{
      id: fileId,
      owner_user_id: USER_ID,
      blob_id: null,
      original_name: input.displayName ?? "upload.bin",
      display_name: input.displayName ?? "upload.bin",
      media_type: input.declaredMediaType,
      detected_media_type: null,
      size_bytes: input.bytes.byteLength,
      sha256: "fixture-digest",
      bucket: "berry-test",
      object_key: "objects/upload.bin",
      etag: "storage-etag",
      object_version_id: "version-1",
      origin: "user_upload",
      status: "available",
      created_at: new Date(),
      updated_at: new Date(),
      task_ids: [TASK_ID],
      roles: ["input"],
    }] as T[] : [] as T[],
  };
  const database = {
    withTenant: async (_tenantId: string, callback: (value: SqlExecutor) => Promise<unknown>) => callback(executor),
  };
  const body = { async *[Symbol.asyncIterator]() { yield input.bytes; } };
  const client = { send: vi.fn(async () => ({
    Body: body,
    ContentType: input.objectMediaType ?? input.declaredMediaType,
    ContentLength: input.bytes.byteLength,
  })) };
  const writes: Buffer[] = [];
  const response = {
    statusCode: 0,
    setHeader: vi.fn(),
    write: vi.fn((chunk: Uint8Array) => { writes.push(Buffer.from(chunk)); return true; }),
    end: vi.fn(),
  };
  const service = new FilePlatformService(database as never, {
    client,
    presignClient: client,
    bucket: "berry-test",
    prefix: "artifacts",
    maxUploadBytes: 1024,
    maxIndexableBytes: 1024,
    partSize: 5 * 1024 * 1024,
    presignSeconds: 900,
  } as never);

  await service.streamContent(TENANT_ID, USER_ID, fileId, undefined, response as never);

  return {
    fileId,
    writes,
    headers: new Map<string, unknown>(response.setHeader.mock.calls.map(([name, value]) => [String(name), value])),
    detectedMediaTypeUpdate: executions.find((call) => call.sql.includes("SET detected_media_type")),
  };
}

describe("FilePlatformService.streamBrandingAsset", () => {
  const fileId = "00000000-0000-7000-8000-000000000204";

  it("serves only the active organization asset with public immutable caching", async () => {
    const executor: SqlExecutor = {
      execute: async () => undefined,
      query: async <T>(sql: string) => {
        if (sql.includes("SELECT branding")) return [{ branding: { logoFileId: fileId } }] as T[];
        if (sql.includes("SELECT f.*")) return [{
          id: fileId, owner_user_id: USER_ID, blob_id: null, original_name: "logo.png", display_name: "logo.png",
          media_type: "image/png", detected_media_type: null, size_bytes: PNG_BYTES.byteLength, sha256: "brand-digest",
          bucket: "berry-test", object_key: "branding/logo.png", etag: "storage-etag", object_version_id: "version-1",
          origin: "user_upload", status: "available", created_at: new Date(), updated_at: new Date(),
        }] as T[];
        return [] as T[];
      },
    };
    const database = { withTenant: async (_tenantId: string, callback: (value: SqlExecutor) => Promise<unknown>) => callback(executor) };
    const body = { async *[Symbol.asyncIterator]() { yield PNG_BYTES; } };
    const client = { send: vi.fn(async () => ({ Body: body, ContentType: "image/svg+xml", ContentLength: PNG_BYTES.byteLength })) };
    const response = { statusCode: 0, setHeader: vi.fn(), write: vi.fn(() => true), end: vi.fn() };
    const service = new FilePlatformService(database as never, {
      client, presignClient: client, bucket: "berry-test", prefix: "artifacts",
      maxUploadBytes: 1024, maxIndexableBytes: 1024, partSize: 5 * 1024 * 1024, presignSeconds: 900,
    } as never);

    await service.streamBrandingAsset(TENANT_ID, "logo", fileId, response as never);

    expect(response.statusCode).toBe(200);
    expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", PUBLIC_IMMUTABLE_FILE_CACHE_CONTROL);
    expect(response.setHeader).toHaveBeenCalledWith("Cross-Origin-Resource-Policy", "cross-origin");
    expect(response.setHeader).toHaveBeenCalledWith("Content-Security-Policy", "default-src 'none'; sandbox");
    expect(response.setHeader).toHaveBeenCalledWith("Content-Type", "image/png");
    expect(response.setHeader).toHaveBeenCalledWith("Content-Disposition", expect.stringMatching(/^inline;/));
    expect(client.send).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({ VersionId: "version-1" }) }));
  });

  it("returns a security-versioned 304 for validated content before reading S3 or updating the database", async () => {
    const execute = vi.fn(async () => undefined);
    const executor: SqlExecutor = {
      execute,
      query: async <T>(sql: string) => {
        if (sql.includes("SELECT branding")) return [{ branding: { logoFileId: fileId } }] as T[];
        if (sql.includes("SELECT f.*")) return [{
          id: fileId, owner_user_id: USER_ID, blob_id: null, original_name: "logo.png", display_name: "logo.png",
          media_type: "image/png", detected_media_type: "image/png", size_bytes: PNG_BYTES.byteLength, sha256: "brand-digest",
          bucket: "berry-test", object_key: "branding/logo.png", etag: "storage-etag", object_version_id: "version-1",
          origin: "user_upload", status: "available", created_at: new Date(), updated_at: new Date(),
        }] as T[];
        return [] as T[];
      },
    };
    const database = { withTenant: async (_tenantId: string, callback: (value: SqlExecutor) => Promise<unknown>) => callback(executor) };
    const client = { send: vi.fn() };
    const response = { statusCode: 0, setHeader: vi.fn(), write: vi.fn(), end: vi.fn() };
    const service = new FilePlatformService(database as never, {
      client, presignClient: client, bucket: "berry-test", prefix: "artifacts",
      maxUploadBytes: 1024, maxIndexableBytes: 1024, partSize: 5 * 1024 * 1024, presignSeconds: 900,
    } as never);

    await service.streamBrandingAsset(
      TENANT_ID,
      "logo",
      fileId,
      response as never,
      `W/"berry-file-response-v${FILE_RESPONSE_SECURITY_VERSION}-brand-digest"`,
    );

    expect(response.statusCode).toBe(304);
    expect(response.setHeader).toHaveBeenCalledWith("ETag", `"berry-file-response-v${FILE_RESPONSE_SECURITY_VERSION}-brand-digest"`);
    expect(client.send).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(response.write).not.toHaveBeenCalled();
    expect(response.end).toHaveBeenCalledOnce();
  });

  it("validates an uninspected conditional request before honoring If-None-Match", async () => {
    let persistedDetectedMediaType: string | null = null;
    const execute = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
      if (sql.includes("SET detected_media_type")) persistedDetectedMediaType = String(params[2]);
    });
    const content = Buffer.from("<html><body>active</body></html>");
    const executor: SqlExecutor = {
      execute,
      query: async <T>(sql: string) => {
        if (sql.includes("SELECT branding")) return [{ branding: { logoFileId: fileId } }] as T[];
        if (sql.includes("SELECT f.*")) return [{
          id: fileId, owner_user_id: USER_ID, blob_id: null, original_name: "spoofed.png", display_name: "spoofed.png",
          media_type: "image/png", detected_media_type: persistedDetectedMediaType, size_bytes: content.byteLength, sha256: "spoofed-digest",
          bucket: "berry-test", object_key: "branding/spoofed.png", etag: "storage-etag", object_version_id: null,
          origin: "user_upload", status: "available", created_at: new Date(), updated_at: new Date(),
        }] as T[];
        return [] as T[];
      },
    };
    const database = { withTenant: async (_tenantId: string, callback: (value: SqlExecutor) => Promise<unknown>) => callback(executor) };
    const client = { send: vi.fn(async () => ({
      Body: { async *[Symbol.asyncIterator]() { yield content; } },
      ContentLength: content.byteLength,
    })) };
    const response = { statusCode: 0, setHeader: vi.fn(), write: vi.fn(), end: vi.fn() };
    const service = new FilePlatformService(database as never, {
      client, presignClient: client, bucket: "berry-test", prefix: "artifacts",
      maxUploadBytes: 1024, maxIndexableBytes: 1024, partSize: 5 * 1024 * 1024, presignSeconds: 900,
    } as never);

    await expect(service.streamBrandingAsset(TENANT_ID, "logo", fileId, response as never, "*"))
      .rejects.toThrow("Branding asset not found");

    expect(client.send).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(expect.stringContaining("SET detected_media_type"), [TENANT_ID, fileId, "text/html"]);
    expect(response.statusCode).not.toBe(304);
    expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", INVALID_FILE_CACHE_CONTROL);

    client.send.mockClear();
    const repeatedResponse = { statusCode: 0, setHeader: vi.fn(), write: vi.fn(), end: vi.fn() };
    await expect(service.streamBrandingAsset(TENANT_ID, "logo", fileId, repeatedResponse as never, "*"))
      .rejects.toThrow("Branding asset not found");
    expect(client.send).not.toHaveBeenCalled();
    expect(repeatedResponse.setHeader).toHaveBeenCalledWith("Cache-Control", INVALID_FILE_CACHE_CONTROL);
  });

  it("cancels the storage body when branding metadata has a stale size", async () => {
    const executor: SqlExecutor = {
      execute: async () => undefined,
      query: async <T>(sql: string) => {
        if (sql.includes("SELECT branding")) return [{ branding: { logoFileId: fileId } }] as T[];
        if (sql.includes("SELECT f.*")) return [{
          id: fileId, owner_user_id: USER_ID, blob_id: null, original_name: "logo.png", display_name: "logo.png",
          media_type: "image/png", detected_media_type: null, size_bytes: PNG_BYTES.byteLength, sha256: "brand-digest",
          bucket: "berry-test", object_key: "branding/logo.png", etag: "storage-etag", object_version_id: null,
          origin: "user_upload", status: "available", created_at: new Date(), updated_at: new Date(),
        }] as T[];
        return [] as T[];
      },
    };
    const database = { withTenant: async (_tenantId: string, callback: (value: SqlExecutor) => Promise<unknown>) => callback(executor) };
    const destroy = vi.fn();
    const body = { destroy, async *[Symbol.asyncIterator]() { yield PNG_BYTES; } };
    const client = { send: vi.fn(async () => ({ Body: body, ContentLength: PNG_BYTES.byteLength + 1 })) };
    const response = { statusCode: 0, setHeader: vi.fn(), write: vi.fn(), end: vi.fn() };
    const service = new FilePlatformService(database as never, {
      client, presignClient: client, bucket: "berry-test", prefix: "artifacts",
      maxUploadBytes: 1024, maxIndexableBytes: 1024, partSize: 5 * 1024 * 1024, presignSeconds: 900,
    } as never);

    await expect(service.streamBrandingAsset(TENANT_ID, "logo", fileId, response as never))
      .rejects.toThrow("Branding asset not found");
    expect(destroy).toHaveBeenCalledOnce();
    expect(response.setHeader).not.toHaveBeenCalledWith("Cache-Control", PUBLIC_IMMUTABLE_FILE_CACHE_CONTROL);
  });

  it("refuses to render an SVG branding asset from Berry's origin", async () => {
    const executor: SqlExecutor = {
      execute: async () => undefined,
      query: async <T>(sql: string) => {
        if (sql.includes("SELECT branding")) return [{ branding: { logoFileId: fileId } }] as T[];
        if (sql.includes("SELECT f.*")) return [{
          id: fileId, owner_user_id: USER_ID, blob_id: null, original_name: "logo.svg", display_name: "logo.svg",
          media_type: "image/svg+xml", detected_media_type: null, size_bytes: 11, sha256: "brand-digest",
          bucket: "berry-test", object_key: "branding/logo.svg", etag: "storage-etag", object_version_id: null,
          origin: "user_upload", status: "available", created_at: new Date(), updated_at: new Date(),
        }] as T[];
        return [] as T[];
      },
    };
    const database = { withTenant: async (_tenantId: string, callback: (value: SqlExecutor) => Promise<unknown>) => callback(executor) };
    const client = { send: vi.fn() };
    const response = { statusCode: 0, setHeader: vi.fn(), write: vi.fn(), end: vi.fn() };
    const service = new FilePlatformService(database as never, {
      client, presignClient: client, bucket: "berry-test", prefix: "artifacts",
      maxUploadBytes: 1024, maxIndexableBytes: 1024, partSize: 5 * 1024 * 1024, presignSeconds: 900,
    } as never);

    await expect(service.streamBrandingAsset(TENANT_ID, "logo", fileId, response as never)).rejects.toThrow("Branding asset not found");
    expect(client.send).not.toHaveBeenCalled();
  });

  it("does not attach immutable cache headers when S3 retrieval fails", async () => {
    const executor: SqlExecutor = {
      execute: async () => undefined,
      query: async <T>(sql: string) => {
        if (sql.includes("SELECT branding")) return [{ branding: { logoFileId: fileId } }] as T[];
        if (sql.includes("SELECT f.*")) return [{
          id: fileId, owner_user_id: USER_ID, blob_id: null, original_name: "logo.png", display_name: "logo.png",
          media_type: "image/png", detected_media_type: null, size_bytes: 12, sha256: "brand-digest",
          bucket: "berry-test", object_key: "branding/logo.png", etag: "storage-etag", object_version_id: null,
          origin: "user_upload", status: "available", created_at: new Date(), updated_at: new Date(),
        }] as T[];
        return [] as T[];
      },
    };
    const database = { withTenant: async (_tenantId: string, callback: (value: SqlExecutor) => Promise<unknown>) => callback(executor) };
    const client = { send: vi.fn(async () => { throw new Error("temporary S3 failure"); }) };
    const response = { statusCode: 0, setHeader: vi.fn(), write: vi.fn(() => true), end: vi.fn() };
    const service = new FilePlatformService(database as never, {
      client, presignClient: client, bucket: "berry-test", prefix: "artifacts",
      maxUploadBytes: 1024, maxIndexableBytes: 1024, partSize: 5 * 1024 * 1024, presignSeconds: 900,
    } as never);

    await expect(service.streamBrandingAsset(TENANT_ID, "logo", fileId, response as never))
      .rejects.toThrow("temporary S3 failure");
    expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", INVALID_FILE_CACHE_CONTROL);
    expect(response.setHeader).not.toHaveBeenCalledWith("Cache-Control", PUBLIC_IMMUTABLE_FILE_CACHE_CONTROL);
  });

  it("rejects a stale version URL after the selected asset changes", async () => {
    const executor: SqlExecutor = {
      execute: async () => undefined,
      query: async <T>(sql: string) => sql.includes("SELECT branding") ? [{ branding: { faviconFileId: fileId } }] as T[] : [] as T[],
    };
    const database = { withTenant: async (_tenantId: string, callback: (value: SqlExecutor) => Promise<unknown>) => callback(executor) };
    const client = { send: vi.fn() };
    const response = { statusCode: 0, setHeader: vi.fn(), write: vi.fn(), end: vi.fn() };
    const service = new FilePlatformService(database as never, {
      client, presignClient: client, bucket: "berry-test", prefix: "artifacts",
      maxUploadBytes: 1024, maxIndexableBytes: 1024, partSize: 5 * 1024 * 1024, presignSeconds: 900,
    } as never);

    await expect(service.streamBrandingAsset(TENANT_ID, "favicon", "00000000-0000-7000-8000-000000000205", response as never))
      .rejects.toThrow("Branding asset not found");
    expect(client.send).not.toHaveBeenCalled();
  });
});

describe("FilePlatformService.get", () => {
  it("rejects deleted project links while preserving owner access through a soft-deleted task association", async () => {
    const queries: Array<{ sql: string; params: readonly unknown[] }> = [];
    const executor: SqlExecutor = {
      execute: async () => undefined,
      query: async <T>(sql: string, params: readonly unknown[] = []) => {
        queries.push({ sql, params });
        return [] as T[];
      },
    };
    const database = {
      withTenant: async (_tenantId: string, callback: (tenantExecutor: SqlExecutor) => Promise<unknown>) => callback(executor),
    };
    const service = new FilePlatformService(database as never, null);

    await expect(service.get(TENANT_ID, USER_ID, "00000000-0000-7000-8000-000000000204"))
      .rejects.toThrow("File not found");

    const accessQuery = queries[0]!;
    expect(accessQuery.sql).toContain("w.tenant_id = wf.tenant_id");
    expect(accessQuery.sql).toContain("w.deleted_at IS NULL");
    expect(accessQuery.sql).toContain("access_task.tenant_id = wf.tenant_id");
    expect(accessQuery.sql).toContain("access_task.deleted_at IS NULL");
    const associationAccess = accessQuery.sql.slice(
      accessQuery.sql.indexOf("FROM file_associations access_link"),
      accessQuery.sql.indexOf("OR project_link.workspace_id IS NOT NULL"),
    );
    expect(associationAccess).toContain("access_task.user_id = $2::uuid");
    expect(associationAccess).toContain("access_task.user_id IS NULL AND access_task.deleted_at IS NULL");
  });
});

describe("FilePlatformService.importConnectorArtifact", () => {
  it("streams a Drive revision into S3 and queues typed knowledge metadata", async () => {
    const executions: Array<{ sql: string; params: readonly unknown[] }> = [];
    const queries: Array<{ sql: string; params: readonly unknown[] }> = [];
    const createdAt = new Date();
    const executor: SqlExecutor = {
      execute: async (sql, params = []) => { executions.push({ sql, params }); },
      query: async <T>(sql: string, params: readonly unknown[] = []) => {
        queries.push({ sql, params });
        if (sql.includes("FROM tasks") && sql.includes("workspace_id")) return [{ id: TASK_ID, workspace_id: WORKSPACE_ID }] as T[];
        if (sql.includes("FROM sessions s")) return [{ id: SESSION_ID }] as T[];
        if (sql.includes("WHERE f.tenant_id=$1::uuid") && sql.includes("f.origin='connector_import'")) return [] as T[];
        if (sql.includes("INSERT INTO files")) return [{
          id: "00000000-0000-8000-8000-000000000999",
          blob_id: "00000000-0000-8000-8000-000000000998",
          owner_user_id: USER_ID,
          original_name: "Quarterly report.pdf",
          display_name: "Quarterly report.pdf",
          media_type: "application/pdf",
          detected_media_type: null,
          size_bytes: 12,
          sha256: "unused",
          bucket: "berry-test",
          object_key: "artifact",
          etag: "etag",
          object_version_id: "version-1",
          origin: "connector_import",
          status: "available",
          metadata: { connectorKey: "google-workspace", sourceFileId: "drive-1", sourceRevision: "revision-7", exportMimeType: null },
          created_at: createdAt,
          updated_at: createdAt,
        }] as T[];
        if (sql.includes("SELECT f.id, f.blob_id") && sql.includes("FOR UPDATE OF f")) {
          return [{ id: "00000000-0000-8000-8000-000000000999", blob_id: "00000000-0000-8000-8000-000000000998" }] as T[];
        }
        if (sql.includes("INSERT INTO knowledge_sources")) {
          if (!sql.includes("'mediaType',$8::text") || !sql.includes("'objectKey',$9::text")) {
            throw new Error("could not determine data type of parameter $8");
          }
          return [{ id: "00000000-0000-8000-8000-000000000997" }] as T[];
        }
        return [] as T[];
      },
    };
    const database = {
      withTenant: async (_tenantId: string, callback: (tenantExecutor: SqlExecutor) => Promise<unknown>) => callback(executor),
    };
    const uploadedBodies: Uint8Array[] = [];
    const client = {
      send: vi.fn(async (command: { constructor: { name: string }; input?: { Body?: Uint8Array } }) => {
        if (command.constructor.name === "CreateMultipartUploadCommand") return { UploadId: "drive-upload-1" };
        if (command.constructor.name === "UploadPartCommand") {
          uploadedBodies.push(command.input?.Body ?? new Uint8Array());
          return { ETag: '"part-etag"' };
        }
        if (command.constructor.name === "CompleteMultipartUploadCommand") return { ETag: '"etag"', VersionId: "version-1" };
        throw new Error(`Unexpected S3 command: ${command.constructor.name}`);
      }),
    };
    const service = new FilePlatformService(database as never, {
      client,
      presignClient: client,
      bucket: "berry-test",
      prefix: "artifacts",
      maxUploadBytes: 1024 * 1024,
      maxIndexableBytes: 1024 * 1024,
      partSize: 5 * 1024 * 1024,
      presignSeconds: 900,
    } as never);
    const bytes = new TextEncoder().encode("hello drive!");
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });

    await expect(service.importConnectorArtifact(TENANT_ID, USER_ID, {
      connectorKey: "google-workspace",
      accountEmail: "person@example.com",
      sourceFileId: "drive-1",
      sourceRevision: "revision-7",
      sourceMimeType: "application/pdf",
      exportMimeType: null,
      saveToLibrary: true,
      name: "Quarterly report.pdf",
      contentType: "application/pdf",
      declaredSize: bytes.byteLength,
      sourceMetadata: { id: "drive-1", version: "7" },
      body,
      taskId: TASK_ID,
      sessionId: SESSION_ID,
    })).resolves.toEqual({ artifact: expect.objectContaining({
      origin: "connector_import",
      sourceFileId: "drive-1",
      sourceRevision: "revision-7",
      library: true,
      reused: false,
    }) });

    expect(Buffer.concat(uploadedBodies.map((item) => Buffer.from(item))).toString("utf8")).toBe("hello drive!");
    expect(executions.some(({ sql }) => sql.includes("INSERT INTO file_library_entries"))).toBe(true);
    expect(executions.some(({ sql }) => sql.includes("INSERT INTO file_associations"))).toBe(true);
    expect(executions.some(({ sql }) => sql.includes("INSERT INTO workspace_files"))).toBe(true);
    expect(queries.find(({ sql }) => sql.includes("INSERT INTO knowledge_sources"))?.params.slice(7, 9))
      .toEqual(["application/pdf", expect.stringContaining("Quarterly report.pdf")]);
    expect(executions.some(({ sql }) => sql.includes("'knowledge.extract'"))).toBe(true);
  });

  it("keeps a normal Drive read task-scoped and out of the Library", async () => {
    const executions: Array<{ sql: string; params: readonly unknown[] }> = [];
    const createdAt = new Date();
    const fileId = "00000000-0000-8000-8000-000000000996";
    const blobId = "00000000-0000-8000-8000-000000000995";
    const executor: SqlExecutor = {
      execute: async (sql, params = []) => { executions.push({ sql, params }); },
      query: async <T>(sql: string) => {
        if (sql.includes("FROM tasks") && sql.includes("workspace_id")) return [{ id: TASK_ID, workspace_id: WORKSPACE_ID }] as T[];
        if (sql.includes("FROM sessions s")) return [{ id: SESSION_ID }] as T[];
        if (sql.includes("f.origin='connector_import'")) return [] as T[];
        if (sql.includes("INSERT INTO files")) return [{
          id: fileId,
          blob_id: blobId,
          owner_user_id: USER_ID,
          original_name: "brent.png",
          display_name: "brent.png",
          media_type: "image/png",
          detected_media_type: null,
          size_bytes: 4,
          sha256: "unused",
          bucket: "berry-test",
          object_key: "artifact",
          etag: "etag",
          object_version_id: null,
          origin: "connector_import",
          status: "available",
          metadata: { connectorKey: "google-workspace", sourceFileId: "drive-image", sourceRevision: "revision-1", exportMimeType: null },
          created_at: createdAt,
          updated_at: createdAt,
        }] as T[];
        if (sql.includes("SELECT f.id, f.blob_id") && sql.includes("FOR UPDATE OF f")) return [{ id: fileId, blob_id: blobId }] as T[];
        return [] as T[];
      },
    };
    const database = { withTenant: async (_tenantId: string, callback: (tenantExecutor: SqlExecutor) => Promise<unknown>) => callback(executor) };
    const client = {
      send: vi.fn(async (command: { constructor: { name: string } }) => {
        if (command.constructor.name === "CreateMultipartUploadCommand") return { UploadId: "temporary-drive-upload" };
        if (command.constructor.name === "UploadPartCommand") return { ETag: '"part-etag"' };
        if (command.constructor.name === "CompleteMultipartUploadCommand") return { ETag: '"etag"' };
        throw new Error(`Unexpected S3 command: ${command.constructor.name}`);
      }),
    };
    const service = new FilePlatformService(database as never, {
      client,
      presignClient: client,
      bucket: "berry-test",
      prefix: "artifacts",
      maxUploadBytes: 1024 * 1024,
      maxIndexableBytes: 1024 * 1024,
      partSize: 5 * 1024 * 1024,
      presignSeconds: 900,
    } as never);
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3, 4])); controller.close(); } });

    await expect(service.importConnectorArtifact(TENANT_ID, USER_ID, {
      connectorKey: "google-workspace",
      accountEmail: "person@example.com",
      sourceFileId: "drive-image",
      sourceRevision: "revision-1",
      sourceMimeType: "image/png",
      exportMimeType: null,
      saveToLibrary: false,
      name: "brent.png",
      contentType: "image/png",
      declaredSize: 4,
      sourceMetadata: { id: "drive-image", version: "1" },
      body,
      taskId: TASK_ID,
      sessionId: SESSION_ID,
    })).resolves.toEqual({ artifact: expect.objectContaining({
      name: "brent.png",
      status: "available",
      library: false,
      reused: false,
    }) });

    expect(executions.some(({ sql }) => sql.includes("INSERT INTO file_associations"))).toBe(true);
    expect(executions.some(({ sql }) => sql.includes("INSERT INTO file_library_entries"))).toBe(false);
    expect(executions.some(({ sql }) => sql.includes("INSERT INTO workspace_files"))).toBe(false);
    expect(executions.some(({ sql }) => sql.includes("'knowledge.extract'"))).toBe(false);
  });

  it("promotes a previously temporary Drive file when the model decides to keep it", async () => {
    const executions: Array<{ sql: string; params: readonly unknown[] }> = [];
    const queries: Array<{ sql: string; params: readonly unknown[] }> = [];
    const fileId = "00000000-0000-8000-8000-000000000994";
    const blobId = "00000000-0000-8000-8000-000000000993";
    const existing = {
      id: fileId,
      blob_id: blobId,
      owner_user_id: USER_ID,
      original_name: "reference.pdf",
      display_name: "reference.pdf",
      media_type: "application/pdf",
      detected_media_type: null,
      size_bytes: 12,
      sha256: "stale-reference-digest",
      bucket: "berry-test",
      object_key: "artifacts/stale/reference.pdf",
      etag: "stale-etag",
      object_version_id: null,
      resolved_bucket: "berry-test",
      resolved_object_key: "artifacts/canonical/reference.pdf",
      resolved_size_bytes: 12,
      resolved_sha256: "reference-digest",
      resolved_etag: "canonical-etag",
      resolved_object_version_id: "canonical-version",
      origin: "connector_import",
      status: "available",
      in_library: false,
      metadata: { connectorKey: "google-workspace", sourceFileId: "drive-reference", sourceRevision: "revision-2", exportMimeType: null },
      created_at: new Date(),
      updated_at: new Date(),
    };
    const executor: SqlExecutor = {
      execute: async (sql, params = []) => { executions.push({ sql, params }); },
      query: async <T>(sql: string, params: readonly unknown[] = []) => {
        queries.push({ sql, params });
        if (sql.includes("FROM tasks") && sql.includes("workspace_id")) return [{ id: TASK_ID, workspace_id: WORKSPACE_ID }] as T[];
        if (sql.includes("FROM sessions s")) return [{ id: SESSION_ID }] as T[];
        if (sql.includes("f.origin='connector_import'")) return [existing] as T[];
        if (sql.includes("SELECT f.id, f.blob_id") && sql.includes("FOR UPDATE OF f")) return [{ id: fileId, blob_id: blobId }] as T[];
        if (sql.includes("INSERT INTO knowledge_sources")) return [{ id: "00000000-0000-8000-8000-000000000992" }] as T[];
        return [] as T[];
      },
    };
    const database = { withTenant: async (_tenantId: string, callback: (tenantExecutor: SqlExecutor) => Promise<unknown>) => callback(executor) };
    const client = { send: vi.fn() };
    const service = new FilePlatformService(database as never, {
      client,
      presignClient: client,
      bucket: "berry-test",
      prefix: "artifacts",
      maxUploadBytes: 1024 * 1024,
      maxIndexableBytes: 1024 * 1024,
      partSize: 5 * 1024 * 1024,
      presignSeconds: 900,
    } as never);
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });

    await expect(service.importConnectorArtifact(TENANT_ID, USER_ID, {
      connectorKey: "google-workspace",
      accountEmail: "person@example.com",
      sourceFileId: "drive-reference",
      sourceRevision: "revision-2",
      sourceMimeType: "application/pdf",
      exportMimeType: null,
      saveToLibrary: true,
      name: "reference.pdf",
      contentType: "application/pdf",
      declaredSize: 12,
      sourceMetadata: { id: "drive-reference", version: "2" },
      body,
      taskId: TASK_ID,
      sessionId: SESSION_ID,
    })).resolves.toEqual({ artifact: expect.objectContaining({
      name: "reference.pdf",
      status: "processing",
      library: true,
      reused: true,
    }) });

    expect(cancel).toHaveBeenCalledOnce();
    expect(client.send).not.toHaveBeenCalled();
    expect(executions.some(({ sql }) => sql.includes("INSERT INTO file_library_entries"))).toBe(true);
    expect(executions.some(({ sql }) => sql.includes("INSERT INTO workspace_files"))).toBe(true);
    expect(executions.some(({ sql }) => sql.includes("UPDATE files") && sql.includes("status='processing'"))).toBe(true);
    const extraction = queries.find(({ sql }) => sql.includes("INSERT INTO knowledge_sources"));
    expect(extraction?.params[8]).toBe("artifacts/canonical/reference.pdf");
    expect(extraction?.params[5]).toBe("reference-digest");
    const outbox = executions.find(({ sql }) => sql.includes("'knowledge.extract'"));
    expect(outbox?.sql).toContain("ON CONFLICT (tenant_id, dedupe_key) DO UPDATE SET");
    expect(outbox?.sql).toContain("completed_at = NULL");
    expect(outbox?.sql).toContain("available_at = now()");
  });

  it("keeps concurrent retry cleanup isolated on unversioned object storage", async () => {
    let artifactLookup = 0;
    const queries: string[] = [];
    const winner = {
      id: "00000000-0000-8000-8000-000000000999",
      blob_id: "00000000-0000-8000-8000-000000000998",
      owner_user_id: USER_ID,
      original_name: "Quarterly report.pdf",
      display_name: "Quarterly report.pdf",
      media_type: "application/pdf",
      detected_media_type: null,
      size_bytes: 5,
      sha256: "winner-digest",
      bucket: "berry-test",
      object_key: "winner-object-key",
      etag: "winner-etag",
      object_version_id: null,
      resolved_bucket: "berry-test",
      resolved_object_key: "winner-object-key",
      resolved_size_bytes: 5,
      resolved_sha256: "winner-digest",
      resolved_etag: "winner-etag",
      resolved_object_version_id: null,
      origin: "connector_import",
      status: "available",
      metadata: { connectorKey: "google-workspace", sourceFileId: "drive-race", sourceRevision: "revision-7", exportMimeType: null },
      created_at: new Date(),
      updated_at: new Date(),
    };
    const executor: SqlExecutor = {
      execute: async () => undefined,
      query: async <T>(sql: string) => {
        queries.push(sql);
        if (sql.includes("FROM tasks") && sql.includes("workspace_id")) return [{ id: TASK_ID, workspace_id: WORKSPACE_ID }] as T[];
        if (sql.includes("FROM sessions s")) return [{ id: SESSION_ID }] as T[];
        if (sql.includes("f.origin='connector_import'")) {
          artifactLookup += 1;
          return (artifactLookup % 2 === 0 ? [winner] : []) as T[];
        }
        if (sql.includes("SELECT f.id, f.blob_id") && sql.includes("FOR UPDATE OF f")) {
          return [{ id: winner.id, blob_id: winner.blob_id }] as T[];
        }
        return [] as T[];
      },
    };
    const database = { withTenant: async (_tenantId: string, callback: (tenantExecutor: SqlExecutor) => Promise<unknown>) => callback(executor) };
    const uploadedKeys: string[] = [];
    const deletedKeys: string[] = [];
    let upload = 0;
    const client = {
      send: vi.fn(async (command: { constructor: { name: string }; input?: { Key?: string } }) => {
        if (command.constructor.name === "CreateMultipartUploadCommand") {
          uploadedKeys.push(command.input?.Key ?? "");
          upload += 1;
          return { UploadId: `drive-race-${upload}` };
        }
        if (command.constructor.name === "UploadPartCommand") return { ETag: `"part-${upload}"` };
        if (command.constructor.name === "CompleteMultipartUploadCommand") return { ETag: `"complete-${upload}"` };
        if (command.constructor.name === "DeleteObjectCommand") {
          deletedKeys.push(command.input?.Key ?? "");
          return {};
        }
        throw new Error(`Unexpected S3 command: ${command.constructor.name}`);
      }),
    };
    const service = new FilePlatformService(database as never, {
      client,
      presignClient: client,
      bucket: "berry-test",
      prefix: "artifacts",
      maxUploadBytes: 1024 * 1024,
      maxIndexableBytes: 0,
      partSize: 5 * 1024 * 1024,
      presignSeconds: 900,
    } as never);
    const importArtifact = () => service.importConnectorArtifact(TENANT_ID, USER_ID, {
      connectorKey: "google-workspace",
      accountEmail: "person@example.com",
      sourceFileId: "drive-race",
      sourceRevision: "revision-7",
      sourceMimeType: "application/pdf",
      exportMimeType: null,
      saveToLibrary: false,
      name: "Quarterly report.pdf",
      contentType: "application/pdf",
      declaredSize: 5,
      sourceMetadata: { id: "drive-race", version: "7" },
      body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("hello")); controller.close(); } }),
      taskId: TASK_ID,
      sessionId: SESSION_ID,
    });

    await expect(importArtifact()).resolves.toEqual({ artifact: expect.objectContaining({ reused: true }) });
    await expect(importArtifact()).resolves.toEqual({ artifact: expect.objectContaining({ reused: true }) });

    expect(new Set(uploadedKeys).size).toBe(2);
    expect(deletedKeys.sort()).toEqual([...uploadedKeys].sort());
    expect(deletedKeys).not.toContain(winner.object_key);
    expect(queries.filter((sql) => sql.includes("pg_advisory_xact_lock"))).toHaveLength(2);
  });

  it("rejects a Drive stream above the 100 MB bounded-ingestion limit", async () => {
    const executor: SqlExecutor = {
      execute: async () => undefined,
      query: async <T>(sql: string) => {
        if (sql.includes("FROM tasks") && sql.includes("workspace_id")) return [{ id: TASK_ID, workspace_id: WORKSPACE_ID }] as T[];
        if (sql.includes("FROM sessions s")) return [{ id: SESSION_ID }] as T[];
        return [] as T[];
      },
    };
    const database = { withTenant: async (_tenantId: string, callback: (tenantExecutor: SqlExecutor) => Promise<unknown>) => callback(executor) };
    const client = { send: vi.fn(async (command: { constructor: { name: string } }) => command.constructor.name === "CreateMultipartUploadCommand" ? { UploadId: "drive-upload-2" } : {}) };
    const service = new FilePlatformService(database as never, {
      client,
      presignClient: client,
      bucket: "berry-test",
      prefix: "artifacts",
      maxUploadBytes: 1024 * 1024 * 1024,
      maxIndexableBytes: 100 * 1024 * 1024,
      partSize: 16 * 1024 * 1024,
      presignSeconds: 900,
    } as never);
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1])); controller.close(); } });
    await expect(service.importConnectorArtifact(TENANT_ID, USER_ID, {
      connectorKey: "google-workspace",
      accountEmail: null,
      sourceFileId: "drive-large",
      sourceRevision: "revision-1",
      sourceMimeType: "application/pdf",
      exportMimeType: null,
      saveToLibrary: false,
      name: "large.pdf",
      contentType: "application/pdf",
      declaredSize: 100 * 1024 * 1024 + 1,
      sourceMetadata: {},
      body,
      taskId: TASK_ID,
      sessionId: SESSION_ID,
    })).rejects.toThrow("100 MB");
    expect(client.send).not.toHaveBeenCalled();
  });
});

describe("FilePlatformService.registerSandboxOutput", () => {
  it("rejects a task-scoped object key when its task does not match the registration context", async () => {
    const client = { send: vi.fn() };
    const service = new FilePlatformService({ withTenant: vi.fn() } as never, {
      client,
      presignClient: client,
      bucket: "berry-test",
      prefix: "artifacts",
      maxUploadBytes: 1024,
      partSize: 5 * 1024 * 1024,
      presignSeconds: 900,
    } as never);

    await expect(service.registerSandboxOutput(TENANT_ID, USER_ID, {
      key: "artifacts/tasks/00000000-0000-7000-8000-000000000299/00000000-0000-7000-8000-000000000204-report.pdf",
      name: "report.pdf",
      mediaType: "application/pdf",
      size: 12,
      taskId: TASK_ID,
      sessionId: SESSION_ID,
    })).rejects.toThrow("does not belong to this task");
    expect(client.send).not.toHaveBeenCalled();
  });

  it("does not let a user claim an ownerless logical file by reusing its object key", async () => {
    const execute = vi.fn(async () => undefined);
    const executor: SqlExecutor = {
      execute,
      query: async <T>(sql: string) => sql.includes("SELECT f.*") ? [{
        id: "00000000-0000-7000-8000-000000000204",
        owner_user_id: null,
        blob_id: null,
        original_name: "legacy.pdf",
        display_name: "legacy.pdf",
        media_type: "application/pdf",
        detected_media_type: null,
        size_bytes: 12,
        sha256: null,
        bucket: "berry-test",
        object_key: "artifacts/00000000-0000-7000-8000-000000000204-legacy.pdf",
        etag: "etag",
        object_version_id: null,
        origin: "legacy_artifact",
        status: "available",
        created_at: new Date(),
        updated_at: new Date(),
      }] as T[] : [] as T[],
    };
    const database = {
      withTenant: async (_tenantId: string, callback: (tenantExecutor: SqlExecutor) => Promise<unknown>) => callback(executor),
    };
    const client = { send: vi.fn(async () => ({ ContentLength: 12, ETag: "etag" })) };
    const service = new FilePlatformService(database as never, {
      client,
      presignClient: client,
      bucket: "berry-test",
      prefix: "artifacts",
      maxUploadBytes: 1024,
      partSize: 5 * 1024 * 1024,
      presignSeconds: 900,
    } as never);

    await expect(service.registerSandboxOutput(TENANT_ID, USER_ID, {
      key: "artifacts/00000000-0000-7000-8000-000000000204-legacy.pdf",
      name: "legacy.pdf",
      mediaType: "application/pdf",
      size: 12,
      taskId: TASK_ID,
      sessionId: "00000000-0000-7000-8000-000000000206",
    })).rejects.toThrow("Artifact identity conflicts with an existing file");
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails closed instead of reusing a stable key whose stored bytes changed", async () => {
    const execute = vi.fn(async () => undefined);
    const executor: SqlExecutor = {
      execute,
      query: async <T>(sql: string) => sql.includes("SELECT f.*") ? [{
        id: "00000000-0000-7000-8000-000000000204",
        owner_user_id: USER_ID,
        blob_id: "00000000-0000-7000-8000-000000000205",
        original_name: "report.pdf",
        display_name: "report.pdf",
        media_type: "application/pdf",
        detected_media_type: null,
        size_bytes: 12,
        sha256: null,
        bucket: "berry-test",
        object_key: "artifacts/00000000-0000-7000-8000-000000000204-report.pdf",
        etag: "old-etag",
        object_version_id: null,
        resolved_bucket: "berry-test",
        resolved_object_key: "artifacts/00000000-0000-7000-8000-000000000204-report.pdf",
        resolved_size_bytes: 12,
        resolved_sha256: null,
        resolved_etag: "old-etag",
        resolved_object_version_id: "version-1",
        origin: "sandbox_output",
        status: "available",
        created_at: new Date(),
        updated_at: new Date(),
      }] as T[] : [] as T[],
    };
    const database = {
      withTenant: async (_tenantId: string, callback: (tenantExecutor: SqlExecutor) => Promise<unknown>) => callback(executor),
    };
    const client = { send: vi.fn(async () => ({ ContentLength: 12, ETag: "new-etag", VersionId: "version-2" })) };
    const service = new FilePlatformService(database as never, {
      client,
      presignClient: client,
      bucket: "berry-test",
      prefix: "artifacts",
      maxUploadBytes: 1024,
      partSize: 5 * 1024 * 1024,
      presignSeconds: 900,
    } as never);

    await expect(service.registerSandboxOutput(TENANT_ID, USER_ID, {
      key: "artifacts/00000000-0000-7000-8000-000000000204-report.pdf",
      name: "report.pdf",
      mediaType: "application/pdf",
      size: 12,
      taskId: TASK_ID,
      sessionId: "00000000-0000-7000-8000-000000000206",
    })).rejects.toThrow("Artifact key content changed");
    expect(execute).not.toHaveBeenCalled();
  });

  it("reuses an exact stable logical identity after backend deduplication moved its canonical blob", async () => {
    const fileId = "00000000-0000-7000-8000-000000000204";
    const blobId = "00000000-0000-7000-8000-000000000205";
    const objectKey = `artifacts/tasks/${TASK_ID}/${fileId}-report.pdf`;
    const execute = vi.fn(async () => undefined);
    const executor: SqlExecutor = {
      execute,
      query: async <T>(sql: string) => {
        if (sql.includes("SELECT f.*")) return [{
          id: fileId,
          owner_user_id: USER_ID,
          blob_id: blobId,
          original_name: "report.pdf",
          display_name: "report.pdf",
          media_type: "application/pdf",
          detected_media_type: null,
          size_bytes: 12,
          sha256: "digest",
          bucket: "berry-test",
          object_key: objectKey,
          etag: "original-etag",
          object_version_id: "original-version",
          resolved_bucket: "berry-test",
          resolved_object_key: "artifacts/canonical-report.pdf",
          resolved_size_bytes: 12,
          resolved_sha256: "digest",
          resolved_etag: "winner-etag",
          resolved_object_version_id: "winner-version",
          origin: "sandbox_output",
          status: "available",
          created_at: new Date(),
          updated_at: new Date(),
        }] as T[];
        if (sql.includes("SELECT f.id, f.blob_id")) return [{ id: fileId, blob_id: blobId }] as T[];
        return [] as T[];
      },
    };
    const database = {
      withTenant: async (_tenantId: string, callback: (tenantExecutor: SqlExecutor) => Promise<unknown>) => callback(executor),
    };
    const client = { send: vi.fn(async () => ({ ContentLength: 12, ETag: "original-etag", VersionId: "original-version" })) };
    const service = new FilePlatformService(database as never, {
      client,
      presignClient: client,
      bucket: "berry-test",
      prefix: "artifacts",
      maxUploadBytes: 1024,
      partSize: 5 * 1024 * 1024,
      presignSeconds: 900,
    } as never);

    await expect(service.registerSandboxOutput(TENANT_ID, USER_ID, {
      key: objectKey,
      name: "report.pdf",
      mediaType: "application/pdf",
      size: 12,
      taskId: TASK_ID,
      sessionId: "00000000-0000-7000-8000-000000000206",
    })).resolves.toMatchObject({ id: fileId, size: 12 });
    expect(execute).not.toHaveBeenCalledWith(expect.stringContaining("INSERT INTO file_blobs"), expect.anything());
    expect(execute).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO file_associations"), expect.anything());
  });

  it("fails closed when a matching creator and key disagree with the stable logical file id", async () => {
    const execute = vi.fn(async () => undefined);
    const objectKey = "artifacts/00000000-0000-7000-8000-000000000207-report.pdf";
    const executor: SqlExecutor = {
      execute,
      query: async <T>(sql: string) => sql.includes("SELECT f.*") ? [{
        id: "00000000-0000-7000-8000-000000000204",
        owner_user_id: USER_ID,
        blob_id: "00000000-0000-7000-8000-000000000205",
        original_name: "report.pdf",
        display_name: "report.pdf",
        media_type: "application/pdf",
        detected_media_type: null,
        size_bytes: 12,
        sha256: null,
        bucket: "berry-test",
        object_key: objectKey,
        etag: "etag",
        object_version_id: null,
        origin: "sandbox_output",
        status: "available",
        created_at: new Date(),
        updated_at: new Date(),
      }] as T[] : [] as T[],
    };
    const database = {
      withTenant: async (_tenantId: string, callback: (tenantExecutor: SqlExecutor) => Promise<unknown>) => callback(executor),
    };
    const client = { send: vi.fn(async () => ({ ContentLength: 12, ETag: "etag" })) };
    const service = new FilePlatformService(database as never, {
      client,
      presignClient: client,
      bucket: "berry-test",
      prefix: "artifacts",
      maxUploadBytes: 1024,
      partSize: 5 * 1024 * 1024,
      presignSeconds: 900,
    } as never);

    await expect(service.registerSandboxOutput(TENANT_ID, USER_ID, {
      key: objectKey,
      name: "report.pdf",
      mediaType: "application/pdf",
      size: 12,
      taskId: TASK_ID,
      sessionId: "00000000-0000-7000-8000-000000000206",
    })).rejects.toThrow("Artifact identity conflicts with an existing file");
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects legacy artifact keys that do not carry a stable logical file id", async () => {
    const client = { send: vi.fn() };
    const service = new FilePlatformService({} as never, {
      client,
      presignClient: client,
      bucket: "berry-test",
      prefix: "artifacts",
      maxUploadBytes: 1024,
      partSize: 5 * 1024 * 1024,
      presignSeconds: 900,
    } as never);

    await expect(service.registerSandboxOutput(TENANT_ID, USER_ID, {
      key: "artifacts/report.pdf",
      name: "report.pdf",
      mediaType: "application/pdf",
      taskId: TASK_ID,
      sessionId: "00000000-0000-7000-8000-000000000206",
    })).rejects.toThrow("stable logical file id");
    expect(client.send).not.toHaveBeenCalled();
  });
});

describe("FilePlatformService.completeUpload", () => {
  it("allows multipart completion only for the file owner", async () => {
    const queries: Array<{ sql: string; params: readonly unknown[] }> = [];
    const fileId = "00000000-0000-7000-8000-000000000204";
    const uploadId = "00000000-0000-7000-8000-000000000205";
    const executor: SqlExecutor = {
      execute: async () => undefined,
      query: async <T>(sql: string, params: readonly unknown[] = []) => {
        queries.push({ sql, params });
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
      .rejects.toThrow("Upload session not found or expired");

    const uploadQuery = queries.find((query) => query.sql.includes("SELECT u.*"));
    expect(uploadQuery?.sql).toContain("f.owner_user_id = $4::uuid");
    expect(uploadQuery?.sql).toContain("f.deleted_at IS NULL");
    expect(uploadQuery?.params).toEqual([TENANT_ID, uploadId, fileId, USER_ID]);
    expect(client.send).not.toHaveBeenCalled();
  });

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
        if (command.constructor.name === "GetObjectCommand") return {
          Body: { async *[Symbol.asyncIterator]() { yield Buffer.from("hello world!"); } },
          ContentLength: 12,
        };
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
    expect(executions.find((call) => call.sql.includes("detected_media_type = $7"))?.params[6]).toBe("text/plain");
    expect(executions.some((call) => call.sql.includes("INSERT INTO file_library_entries"))).toBe(true);
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
    expect(executions.some((call) => call.sql.includes("UPDATE file_library_entries") && call.sql.includes("deleted_at"))).toBe(true);
    expect(executions.some((call) => call.sql.includes("DELETE FROM file_associations"))).toBe(true);
    expect(executions.some((call) => call.sql.includes("UPDATE workspace_files") && call.sql.includes("index_status = 'deleted'"))).toBe(true);
  });
});

describe("FilePlatformService.abortUpload", () => {
  it("retires provisional references before garbage collection", async () => {
    const fileId = "00000000-0000-7000-8000-000000000204";
    const uploadId = "00000000-0000-7000-8000-000000000205";
    const calls: Array<{ kind: "execute" | "query"; sql: string; params: readonly unknown[] }> = [];
    const executor: SqlExecutor = {
      execute: async (sql, params = []) => { calls.push({ kind: "execute", sql, params }); },
      query: async <T>(sql: string, params: readonly unknown[] = []) => {
        calls.push({ kind: "query", sql, params });
        if (sql.includes("SELECT u.*")) return [{
          id: uploadId,
          file_id: fileId,
          provider_upload_id: "provider-upload-1",
          part_size: 5 * 1024 * 1024,
          part_count: 1,
          status: "uploading",
          expires_at: new Date(Date.now() + 60_000),
          object_key: "artifacts/notes.txt",
          declared_size_bytes: 12,
          blob_id: null,
        }] as T[];
        if (sql.includes("SELECT f.id, f.blob_id") && sql.includes("FOR UPDATE OF f")) return [{ id: fileId, blob_id: null, bucket: "berry-test", object_key: "artifact", deleted_at: null }] as T[];
        if (sql.includes("reference_exists")) return [{ reference_exists: false }] as T[];
        if (sql.includes("UPDATE files") && sql.includes("RETURNING id")) return [{ id: fileId }] as T[];
        return [] as T[];
      },
    };
    const database = {
      withTenant: async (_tenantId: string, callback: (tenantExecutor: SqlExecutor) => Promise<unknown>) => callback(executor),
    };
    const client = {
      send: vi.fn(async () => {
        throw Object.assign(new Error("The specified multipart upload does not exist"), { name: "NoSuchUpload" });
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

    await expect(service.abortUpload(TENANT_ID, USER_ID, fileId, uploadId)).resolves.toEqual({ ok: true });

    expect(client.send).toHaveBeenCalledWith(expect.objectContaining({
      constructor: expect.objectContaining({ name: "AbortMultipartUploadCommand" }),
    }));
    expect(calls.some(({ sql }) => sql.includes("DELETE FROM file_associations"))).toBe(true);
    expect(calls.some(({ sql }) => sql.includes("UPDATE workspace_files") && sql.includes("index_status = 'deleted'"))).toBe(true);
    expect(calls.some(({ params }) => params.includes(`file.delete-object:legacy:${fileId}`))).toBe(true);
  });

  it("does not let an abort retire an upload that already completed", async () => {
    const executor: SqlExecutor = {
      execute: async () => undefined,
      query: async <T>(sql: string) => {
        if (sql.includes("SELECT u.*")) return [{
          id: "00000000-0000-7000-8000-000000000205",
          file_id: "00000000-0000-7000-8000-000000000204",
          provider_upload_id: "consumed-provider-upload",
          part_size: 5 * 1024 * 1024,
          part_count: 1,
          status: "completed",
          expires_at: new Date(Date.now() - 60_000),
          object_key: "artifacts/notes.txt",
          declared_size_bytes: 12,
          blob_id: null,
        }] as T[];
        return [] as T[];
      },
    };
    const database = {
      withTenant: async (_tenantId: string, callback: (tenantExecutor: SqlExecutor) => Promise<unknown>) => callback(executor),
    };
    const client = { send: vi.fn(async () => ({})) };
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

    await expect(service.abortUpload(
      TENANT_ID,
      USER_ID,
      "00000000-0000-7000-8000-000000000204",
      "00000000-0000-7000-8000-000000000205",
    )).rejects.toThrow("already complete");
    expect(client.send).not.toHaveBeenCalled();
  });
});

describe("FilePlatformService reference-safe Library removal", () => {
  it("removes only the requesting user's Library membership and preserves conversation, project, and second-user references", async () => {
    const fileId = "00000000-0000-7000-8000-000000000204";
    const calls: Array<{ kind: "execute" | "query"; sql: string; params: readonly unknown[] }> = [];
    const executor: SqlExecutor = {
      execute: async (sql, params = []) => { calls.push({ kind: "execute", sql, params }); },
      query: async <T>(sql: string, params: readonly unknown[] = []) => {
        calls.push({ kind: "query", sql, params });
        if (sql.includes("SELECT library.file_id")) return [{ file_id: fileId, deleted_at: null }] as T[];
        if (sql.includes("CASE WHEN f.blob_id")) return [{ id: fileId, deleted_at: null, blob_id: "00000000-0000-7000-8000-000000000205", bucket: "berry-test", object_key: "artifact" }] as T[];
        if (sql.includes("reference_exists")) return [{ reference_exists: true }] as T[];
        return [] as T[];
      },
    };
    const database = {
      withTenant: vi.fn(async (_tenantId: string, callback: (tenantExecutor: SqlExecutor) => Promise<unknown>) => callback(executor)),
    };
    const service = new FilePlatformService(database as never, null);

    await expect(service.removeFromLibrary(TENANT_ID, USER_ID, fileId)).resolves.toEqual({ ok: true });

    expect(calls.some((call) => call.sql.includes("UPDATE file_library_entries") && call.params.includes(USER_ID))).toBe(true);
    expect(calls.some((call) => call.sql.includes("UPDATE file_associations"))).toBe(false);
    expect(calls.some((call) => call.sql.includes("UPDATE workspace_files"))).toBe(false);
    const knowledgeCleanup = calls.find((call) => call.sql.includes("UPDATE knowledge_sources"));
    expect(knowledgeCleanup?.sql).toContain("NOT EXISTS");
    expect(calls.some((call) => call.sql.includes("'file.delete-object'"))).toBe(false);
    const referenceQuery = calls.find((call) => call.sql.includes("reference_exists"));
    expect(referenceQuery?.sql).toContain("FROM file_library_entries library");
    expect(referenceQuery?.sql).not.toContain("library.user_id");
  });

  it("checks for last-reference collection after a project file is unlinked", async () => {
    const fileId = "00000000-0000-7000-8000-000000000204";
    const workspaceId = "00000000-0000-7000-8000-000000000206";
    const calls: Array<{ kind: "execute" | "query"; sql: string; params: readonly unknown[] }> = [];
    const executor: SqlExecutor = {
      execute: async (sql, params = []) => { calls.push({ kind: "execute", sql, params }); },
      query: async <T>(sql: string, params: readonly unknown[] = []) => {
        calls.push({ kind: "query", sql, params });
        if (sql.includes("SELECT w.id")) return [{ id: workspaceId }] as T[];
        if (sql.includes("UPDATE knowledge_sources") && sql.includes("RETURNING id, source_revision")) {
          return [{ id: "source-1", source_revision: "revision-1" }] as T[];
        }
        if (sql.includes("UPDATE workspace_files") && sql.includes("RETURNING id")) return [{ id: "link-1" }] as T[];
        if (sql.includes("CASE WHEN f.blob_id")) {
          return [{ id: fileId, deleted_at: null, blob_id: null, bucket: "berry-test", object_key: "artifact" }] as T[];
        }
        if (sql.includes("reference_exists")) return [{ reference_exists: true }] as T[];
        return [] as T[];
      },
    };
    const database = {
      withTenant: vi.fn(async (_tenantId: string, callback: (tenantExecutor: SqlExecutor) => Promise<unknown>) => callback(executor)),
    };
    const service = new FilePlatformService(database as never, null);

    await expect(service.unlinkWorkspaceFile(TENANT_ID, USER_ID, workspaceId, fileId)).resolves.toEqual({ ok: true });

    expect(calls.some((call) => call.sql.includes("reference_exists"))).toBe(true);
    expect(calls.some((call) => call.sql.includes("UPDATE files") && call.sql.includes("status = 'deleted'"))).toBe(false);
  });

  it("treats a retry after a lost Library-removal response as idempotently complete", async () => {
    const fileId = "00000000-0000-7000-8000-000000000204";
    const calls: string[] = [];
    const executor: SqlExecutor = {
      execute: async (sql) => { calls.push(sql); },
      query: async <T>(sql: string) => {
        calls.push(sql);
        if (sql.includes("SELECT library.file_id")) return [{ file_id: fileId, deleted_at: new Date() }] as T[];
        if (sql.includes("CASE WHEN f.blob_id")) {
          return [{ id: fileId, deleted_at: null, blob_id: null, bucket: "berry-test", object_key: "artifact" }] as T[];
        }
        if (sql.includes("reference_exists")) return [{ reference_exists: true }] as T[];
        return [] as T[];
      },
    };
    const database = {
      withTenant: vi.fn(async (_tenantId: string, callback: (tenantExecutor: SqlExecutor) => Promise<unknown>) => callback(executor)),
    };
    const service = new FilePlatformService(database as never, null);

    await expect(service.removeFromLibrary(TENANT_ID, USER_ID, fileId)).resolves.toEqual({ ok: true });
    expect(calls.some((sql) => sql.includes("UPDATE file_library_entries"))).toBe(false);
    expect(calls.some((sql) => sql.includes("reference_exists"))).toBe(true);
  });

  it("does not let a foreign user probe a file without their own membership", async () => {
    const executor: SqlExecutor = { execute: vi.fn(async () => undefined), query: vi.fn(async () => []) };
    const database = { withTenant: vi.fn(async (_tenantId: string, callback: (tenantExecutor: SqlExecutor) => Promise<unknown>) => callback(executor)) };
    const service = new FilePlatformService(database as never, null);

    await expect(service.removeFromLibrary(TENANT_ID, USER_ID, "00000000-0000-7000-8000-000000000204"))
      .rejects.toThrow("File not found");
    expect(executor.execute).not.toHaveBeenCalled();
  });
});
