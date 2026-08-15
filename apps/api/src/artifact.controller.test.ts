import "reflect-metadata";

import { NotFoundException, UnauthorizedException, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BerryAuthModule } from "./auth/auth.module.ts";
import type { BerryAuthRuntime } from "./auth/auth-runtime.ts";
import { CloudDatabaseService } from "./db/cloud-database.service.ts";
import { FilePlatformService } from "./files/file-platform.service.ts";
import {
  FILE_TYPE_SAMPLE_BYTES,
  INVALID_FILE_CACHE_CONTROL,
  PROTECTED_FILE_CACHE_CONTROL,
} from "./files/file-response-security.ts";
import {
  ARTIFACT_READ_CONFIG,
  ArtifactController,
  type ArtifactReadConfig,
} from "./main.ts";

const TENANT_ID = "00000000-0000-7000-8000-000000000200";
const USER_ID = "00000000-0000-7000-8000-000000000201";
const OTHER_USER_ID = "00000000-0000-7000-8000-000000000202";
const TASK_ID = "00000000-0000-7000-8000-000000000203";
const OBJECT_ID = "00000000-0000-7000-8000-000000000204";
const OTHER_TASK_ID = "00000000-0000-7000-8000-000000000205";
const USER_PREFIX = `artifacts/tenants/${TENANT_ID}/users/${USER_ID}/legacy-artifacts`;
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

type StoredObject = {
  body: Uint8Array;
  contentType?: string;
  metadata?: Record<string, string>;
};

describe("ArtifactController", () => {
  let app: INestApplication | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("requires authentication and lists only the signed-in user's legacy prefix", async () => {
    const fixture = createFixture();
    fixture.objects.set(`${USER_PREFIX}/${OBJECT_ID}-report.png`, { body: PNG_BYTES, contentType: "image/png" });
    app = await createApp(fixture);

    await request(app.getHttpServer()).get("/v1/artifacts").expect(401);
    expect(fixture.client.send).not.toHaveBeenCalled();

    const response = await request(app.getHttpServer()).get("/v1/artifacts").set(authHeader()).expect(200);
    expect(response.body.items).toEqual([expect.objectContaining({ name: "report.png" })]);
    expect(fixture.client.send).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ Prefix: `${USER_PREFIX}/` }),
    }));
  });

  it("stores uploads under the authenticated user and serves HTML and SVG as downloads", async () => {
    const fixture = createFixture();
    app = await createApp(fixture);

    await request(app.getHttpServer())
      .post("/v1/artifacts")
      .set(authHeader())
      .send({ name: "bad.png", mediaType: "image/png\r\nX-Evil: yes", dataUrl: dataUrl("image/png", "<html></html>") })
      .expect(400);
    expect(fixture.client.send).not.toHaveBeenCalled();

    for (const upload of [
      { name: "page.html", source: "<html><script>alert(1)</script></html>", detected: "text/html" },
      { name: "logo.svg", source: '<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>', detected: "image/svg+xml" },
    ]) {
      const created = await request(app.getHttpServer())
        .post("/v1/artifacts")
        .set(authHeader())
        .send({ name: upload.name, mediaType: "image/png", dataUrl: dataUrl("image/png", upload.source) })
        .expect(201);
      expect(created.body.key).toMatch(new RegExp(`^${USER_PREFIX}/`));
      expect(created.body.mediaType).toBe(upload.detected);
      const stored = fixture.objects.get(created.body.key);
      expect(stored).toMatchObject({
        contentType: upload.detected,
        metadata: {
          "declared-media-type": "image/png",
          "data-url-media-type": "image/png",
          "tenant-id": TENANT_ID,
          "owner-user-id": USER_ID,
        },
      });

      const read = await request(app.getHttpServer()).get(created.body.url).set(authHeader()).expect(200);
      expect(read.headers["content-type"]).toMatch(/^application\/octet-stream/);
      expect(read.headers["content-disposition"]).toMatch(/^attachment;/);
      expect(read.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
      expect(read.headers["x-content-type-options"]).toBe("nosniff");
      expect(read.headers["x-frame-options"]).toBe("DENY");
      expect(read.headers["cache-control"]).toBe(PROTECTED_FILE_CACHE_CONTROL);
    }
  });

  it("uses the canonical file-type sample bound for artifact uploads", async () => {
    const fixture = createFixture();
    app = await createApp(fixture);
    const html = "<html></html>";
    const withinSample = `${" ".repeat(FILE_TYPE_SAMPLE_BYTES - html.length)}${html}`;
    const afterSample = `${" ".repeat(FILE_TYPE_SAMPLE_BYTES)}${html}`;

    const detectedActive = await request(app.getHttpServer())
      .post("/v1/artifacts")
      .set(authHeader())
      .send({ name: "within-sample.txt", mediaType: "text/plain", dataUrl: dataUrl("text/plain", withinSample) })
      .expect(201);
    expect(detectedActive.body.mediaType).toBe("text/html");

    const detectedPassive = await request(app.getHttpServer())
      .post("/v1/artifacts")
      .set(authHeader())
      .send({ name: "after-sample.txt", mediaType: "text/plain", dataUrl: dataUrl("text/plain", afterSample) })
      .expect(201);
    expect(detectedPassive.body.mediaType).toBe("text/plain");
  });

  it("fails closed for missing, malformed, or conflicting object MIME metadata", async () => {
    const fixture = createFixture();
    const cases = [
      { name: "missing.png", body: PNG_BYTES, contentType: undefined },
      { name: "malformed.png", body: PNG_BYTES, contentType: "image/png\r\nX-Evil: yes" },
      { name: "spoofed.png", body: Buffer.from("<html><body>not a png</body></html>"), contentType: "image/png" },
    ];
    for (const value of cases) {
      fixture.objects.set(`${USER_PREFIX}/${OBJECT_ID}-${value.name}`, {
        body: value.body,
        ...(value.contentType ? { contentType: value.contentType } : {}),
      });
    }
    fixture.objects.set(`${USER_PREFIX}/${OBJECT_ID}-valid.png`, { body: PNG_BYTES, contentType: "image/png" });
    app = await createApp(fixture);

    for (const value of cases) {
      const response = await request(app.getHttpServer())
        .get(`/v1/artifacts/${USER_PREFIX}/${OBJECT_ID}-${value.name}`)
        .set(authHeader())
        .expect(200);
      expect(response.headers["content-type"]).toMatch(/^application\/octet-stream/);
      expect(response.headers["content-disposition"]).toMatch(/^attachment;/);
    }

    const valid = await request(app.getHttpServer())
      .get(`/v1/artifacts/${USER_PREFIX}/${OBJECT_ID}-valid.png`)
      .set(authHeader())
      .expect(200);
    expect(valid.headers["content-type"]).toMatch(/^image\/png/);
    expect(valid.headers["content-disposition"]).toMatch(/^inline;/);
  });

  it("authorizes generated artifact keys through their task and rejects foreign or unscoped keys before object reads", async () => {
    const registeredKey = `artifacts/${OBJECT_ID}-registered.png`;
    const foreignRegisteredKey = `artifacts/00000000-0000-7000-8000-000000000206-foreign.png`;
    const fixture = createFixture({
      allowedTaskId: TASK_ID,
      registeredArtifactOwners: new Map([
        [registeredKey, USER_ID],
        [foreignRegisteredKey, OTHER_USER_ID],
      ]),
    });
    const taskKey = `artifacts/tasks/${TASK_ID}/${OBJECT_ID}-result.png`;
    const migratedKey = `artifacts/${OBJECT_ID}-migrated.png`;
    fixture.objects.set(taskKey, { body: PNG_BYTES, contentType: "image/png" });
    fixture.objects.set(migratedKey, { body: PNG_BYTES, contentType: "image/png", metadata: { taskid: TASK_ID } });
    fixture.objects.set(registeredKey, { body: PNG_BYTES, contentType: "image/png" });
    fixture.objects.set(foreignRegisteredKey, { body: PNG_BYTES, contentType: "image/png" });
    app = await createApp(fixture);

    await request(app.getHttpServer()).get(`/v1/artifacts/${taskKey}`).set(authHeader()).expect(200);
    await request(app.getHttpServer()).get(`/v1/artifacts/${migratedKey}`).set(authHeader()).expect(200);
    await request(app.getHttpServer()).get(`/v1/artifacts/${registeredKey}`).set(authHeader()).expect(200);
    expect(fixture.files.authorizeRegisteredArtifactObjectKey).toHaveBeenCalledWith(TENANT_ID, USER_ID, registeredKey);
    expect(fixture.database.withTenant).toHaveBeenCalledWith(TENANT_ID, expect.any(Function));
    expect(fixture.queries).toContainEqual(expect.objectContaining({ params: [TENANT_ID, TASK_ID, USER_ID] }));

    fixture.client.send.mockClear();
    const denied = await request(app.getHttpServer())
      .get(`/v1/artifacts/${foreignRegisteredKey}`)
      .set(authHeader())
      .expect(404);
    expect(denied.headers["cache-control"]).toBe(INVALID_FILE_CACHE_CONTROL);
    await request(app.getHttpServer())
      .get(`/v1/artifacts/artifacts/tasks/${OTHER_TASK_ID}/${OBJECT_ID}-foreign-task.png`)
      .set(authHeader())
      .expect(404);
    await request(app.getHttpServer())
      .get(`/v1/artifacts/artifacts/tenants/${TENANT_ID}/users/${OTHER_USER_ID}/legacy-artifacts/${OBJECT_ID}-foreign.png`)
      .set(authHeader())
      .expect(404);
    await request(app.getHttpServer())
      .get(`/v1/artifacts/artifacts/${OBJECT_ID}-unscoped.png`)
      .set(authHeader())
      .expect(404);
    expect(fixture.client.send.mock.calls.some(([command]) => command.constructor.name === "GetObjectCommand")).toBe(false);
  });
});

function createFixture(input: { allowedTaskId?: string; registeredArtifactOwners?: ReadonlyMap<string, string> } = {}) {
  const objects = new Map<string, StoredObject>();
  const queries: Array<{ sql: string; params: readonly unknown[] }> = [];
  const client = {
    send: vi.fn(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      if (command.constructor.name === "ListObjectsV2Command") {
        const prefix = String(command.input.Prefix);
        return {
          Contents: [...objects.entries()]
            .filter(([key]) => key.startsWith(prefix))
            .map(([Key, value]) => ({ Key, Size: value.body.byteLength, LastModified: new Date("2026-08-15T00:00:00.000Z") })),
        };
      }
      if (command.constructor.name === "PutObjectCommand") {
        objects.set(String(command.input.Key), {
          body: command.input.Body as Uint8Array,
          contentType: String(command.input.ContentType),
          metadata: command.input.Metadata as Record<string, string>,
        });
        return {};
      }
      if (command.constructor.name === "GetObjectCommand") {
        const stored = objects.get(String(command.input.Key));
        if (!stored) return { $metadata: { httpStatusCode: 404 } };
        return {
          Body: { async *[Symbol.asyncIterator]() { yield stored.body; } },
          ContentLength: stored.body.byteLength,
          ...(stored.contentType ? { ContentType: stored.contentType } : {}),
          Metadata: stored.metadata,
        };
      }
      if (command.constructor.name === "HeadObjectCommand") {
        const stored = objects.get(String(command.input.Key));
        if (!stored) throw { $metadata: { httpStatusCode: 404 } };
        return { ContentLength: stored.body.byteLength, ContentType: stored.contentType, Metadata: stored.metadata };
      }
      throw new Error(`Unexpected S3 command: ${command.constructor.name}`);
    }),
  };
  const executor = {
    execute: vi.fn(),
    query: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
      queries.push({ sql, params });
      return [{ allowed: params[1] === input.allowedTaskId }];
    }),
  };
  const database = {
    withTenant: vi.fn(async (_tenantId: string, callback: (value: typeof executor) => Promise<unknown>) => callback(executor)),
  };
  const files = {
    authorizeRegisteredArtifactObjectKey: vi.fn(async (_tenantId: string, userId: string, objectKey: string) => {
      const ownerUserId = input.registeredArtifactOwners?.get(objectKey);
      if (!ownerUserId) return false;
      if (ownerUserId !== userId) throw new NotFoundException("File not found");
      return true;
    }),
  };
  return { objects, client, database, files, queries };
}

async function createApp(fixture: ReturnType<typeof createFixture>): Promise<INestApplication> {
  const config: Exclude<ArtifactReadConfig, null> = {
    client: fixture.client as never,
    bucket: "berry-test",
    prefix: "artifacts",
    tenantId: TENANT_ID,
  };
  const moduleRef = await Test.createTestingModule({
    imports: [BerryAuthModule.register({ runtime: { useValue: fakeAuthRuntime() } })],
    controllers: [ArtifactController],
    providers: [
      { provide: ARTIFACT_READ_CONFIG, useValue: config },
      { provide: CloudDatabaseService, useValue: fixture.database },
      { provide: FilePlatformService, useValue: fixture.files },
    ],
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
    handleNodeRequest: async (_request, response) => {
      response.statusCode = 200;
      response.end(JSON.stringify({ ok: true }));
    },
  };
}

function dataUrl(mediaType: string, value: string): string {
  return `data:${mediaType};base64,${Buffer.from(value).toString("base64")}`;
}
