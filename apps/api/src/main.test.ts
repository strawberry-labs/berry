import "reflect-metadata";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Test } from "@nestjs/testing";
import { describe, expect, it, vi } from "vitest";
import { BERRY_AUTH_PUBLIC } from "./auth/auth.decorators.ts";
import { FilePlatformController } from "./files/file-platform.controller.ts";
import { FilePlatformService } from "./files/file-platform.service.ts";
import { createApiMainModule, createAuthRuntime, HealthController } from "./main.ts";

describe("API health probes", () => {
  it("starts direct execution only after runtime class declarations are initialized", () => {
    const adjacentSource = new URL("./main.ts", import.meta.url);
    const sourceUrl = existsSync(adjacentSource) ? adjacentSource : new URL("../src/main.ts", import.meta.url);
    const source = readFileSync(sourceUrl, "utf8");

    expect(source.lastIndexOf("if (import.meta.url")).toBeGreaterThan(source.indexOf("class S3ObjectPutClient"));
  });

  it("resolves production repository factories from the shared database module", async () => {
    const directory = mkdtempSync(join(tmpdir(), "berry-api-main-"));
    try {
      const moduleRef = await Test.createTestingModule({
        imports: [createApiMainModule({
          BERRY_DATABASE_URL: "postgres://berry:berry@127.0.0.1:5432/berry",
          BERRY_API_MODEL_MODE: "fixture",
          BERRY_SANDBOX_PROVIDER: "fixture",
          BERRY_AUTH_MODE: "better-auth",
          BETTER_AUTH_SECRET: "test-only-auth-secret-with-at-least-thirty-two-characters",
          BERRY_RUNTIME_DB_PATH: join(directory, "runtime.sqlite"),
        })],
      }).compile();

      const fileController = moduleRef.get(FilePlatformController);
      const fileService = moduleRef.get(FilePlatformService);
      expect((fileController as unknown as { files: FilePlatformService }).files).toBe(fileService);

      await moduleRef.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps liveness and readiness public while readiness checks Postgres", async () => {
    const ping = vi.fn(async () => undefined);
    const controller = new HealthController({ ping } as never);

    expect(Reflect.getMetadata(BERRY_AUTH_PUBLIC, HealthController)).toBe(true);
    expect(controller.health()).toMatchObject({ ok: true, service: "berry-api" });
    await expect(controller.ready()).resolves.toEqual({ ok: true, service: "berry-api", ready: true });
    expect(ping).toHaveBeenCalledOnce();
  });

  it("uses the same database-backed auth flow in local and production deployments", () => {
    expect(createAuthRuntime({
      NODE_ENV: "test",
      BERRY_AUTH_MODE: "better-auth",
    }).describe()).toBeInstanceOf(Promise);
    expect(() => createAuthRuntime({ BERRY_AUTH_MODE: "single-user" })).toThrow("Unsupported BERRY_AUTH_MODE");
  });
});
