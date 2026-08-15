import "reflect-metadata";
import { UnauthorizedException, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { SELF_HOST_TENANT_ID } from "@berry/db";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BerryAuthModule } from "../auth/auth.module.ts";
import type { BerryAuthRuntime } from "../auth/auth-runtime.ts";
import { FilePlatformController } from "./file-platform.controller.ts";
import { FilePlatformService } from "./file-platform.service.ts";

const USER_ID = "00000000-0000-7000-8000-000000000201";

describe("FilePlatformController", () => {
  let app: INestApplication | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("requires a signed-in user and forwards a bounded search only for that user", async () => {
    const files = { list: vi.fn(async () => ({ items: [], nextCursor: null })) };
    app = await createApp(files);

    await request(app.getHttpServer())
      .get("/v1/files?search=annual%20report&category=documents&limit=25")
      .expect(401);
    expect(files.list).not.toHaveBeenCalled();

    await request(app.getHttpServer())
      .get("/v1/files?search=annual%20report&category=documents&limit=25")
      .set(authHeader())
      .expect(200);
    expect(files.list).toHaveBeenCalledWith(SELF_HOST_TENANT_ID, USER_ID, {
      search: "annual report",
      category: "documents",
      limit: 25,
    });
  });

  it("rejects unrecognized or oversized search parameters before they reach the file service", async () => {
    const files = { list: vi.fn(async () => ({ items: [], nextCursor: null })) };
    app = await createApp(files);

    await request(app.getHttpServer())
      .get(`/v1/files?search=${"a".repeat(201)}`)
      .set(authHeader())
      .expect(400);
    await request(app.getHttpServer())
      .get("/v1/files?search=report&includeDeleted=true")
      .set(authHeader())
      .expect(400);
    expect(files.list).not.toHaveBeenCalled();
  });

  it("rejects malformed upload MIME metadata and normalizes valid values", async () => {
    const files = {
      list: vi.fn(async () => ({ items: [], nextCursor: null })),
      initiateUpload: vi.fn(async () => ({
        fileId: "00000000-0000-7000-8000-000000000204" as const,
        uploadId: "00000000-0000-7000-8000-000000000205" as const,
        partSize: 5 * 1024 * 1024,
        partCount: 1,
        expiresAt: new Date(0).toISOString(),
      })),
    };
    app = await createApp(files);

    await request(app.getHttpServer())
      .post("/v1/files/uploads")
      .set(authHeader())
      .send({ name: "report.png", mediaType: "image/png\r\nX-Evil: yes", size: 9 })
      .expect(400);
    expect(files.initiateUpload).not.toHaveBeenCalled();

    await request(app.getHttpServer())
      .post("/v1/files/uploads")
      .set(authHeader())
      .send({ name: "report.png", mediaType: "IMAGE/PNG", size: 9 })
      .expect(201);
    expect(files.initiateUpload).toHaveBeenCalledWith(SELF_HOST_TENANT_ID, USER_ID, expect.objectContaining({
      name: "report.png",
      mediaType: "image/png",
      size: 9,
    }));
  });

  it("removes only a valid Library membership through the authenticated file route", async () => {
    const files = {
      list: vi.fn(async () => ({ items: [], nextCursor: null })),
      removeFromLibrary: vi.fn(async () => ({ ok: true as const })),
    };
    app = await createApp(files);
    const fileId = "00000000-0000-7000-8000-000000000204";

    await request(app.getHttpServer()).delete(`/v1/files/${fileId}`).expect(401);
    await request(app.getHttpServer()).delete("/v1/files/not-a-uuid").set(authHeader()).expect(400);
    await request(app.getHttpServer()).delete(`/v1/files/${fileId}`).set(authHeader()).expect(200, { ok: true });

    expect(files.removeFromLibrary).toHaveBeenCalledTimes(1);
    expect(files.removeFromLibrary).toHaveBeenCalledWith(SELF_HOST_TENANT_ID, USER_ID, fileId);
  });
});

async function createApp(files: Pick<FilePlatformService, "list"> & Partial<Pick<FilePlatformService, "initiateUpload" | "removeFromLibrary">>): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [BerryAuthModule.register({ runtime: { useValue: fakeAuthRuntime() } })],
    controllers: [FilePlatformController],
    providers: [{ provide: FilePlatformService, useValue: files }],
  }).compile();
  const nestApp = moduleRef.createNestApplication();
  await nestApp.init();
  return nestApp;
}

function authHeader() {
  return { Authorization: "Bearer berry-test-session" };
}

function fakeAuthRuntime(): BerryAuthRuntime {
  const getSession: BerryAuthRuntime["getSession"] = async (headers) => {
    if (headers.authorization !== "Bearer berry-test-session") return null;
    return {
      session: { id: "auth_session_1", userId: USER_ID },
      user: { id: USER_ID, email: "test@example.test", name: "Test User", emailVerified: true },
    };
  };
  return {
    describe: () => ({
      basePath: "/v1/auth",
      emailPassword: { enabled: true, minPasswordLength: 8, maxPasswordLength: 128 },
      socialProviders: [],
      storage: "memory",
    }),
    getSession,
    requireSession: async (headers) => {
      const session = await getSession(headers);
      if (!session) throw new UnauthorizedException("Authentication required");
      return session;
    },
    handleNodeRequest: async (_req, response) => {
      response.statusCode = 200;
      response.end(JSON.stringify({ ok: true }));
    },
  };
}
