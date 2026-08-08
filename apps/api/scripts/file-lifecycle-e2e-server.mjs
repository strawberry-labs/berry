#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Pool } from "pg";

import { CloudDatabaseService } from "../dist/db/cloud-database.service.js";
import { PgSqlExecutor } from "../dist/db/pg-executor.js";
import { FilePlatformService } from "../dist/files/file-platform.service.js";

const port = Number(process.env.BERRY_FILE_LIFECYCLE_E2E_PORT ?? 3199);
const webOrigin = process.env.BERRY_FILE_LIFECYCLE_E2E_WEB_ORIGIN ?? "http://127.0.0.1:3109";
const publicUrl = process.env.BERRY_FILE_LIFECYCLE_E2E_API_URL ?? `http://127.0.0.1:${port}`;
const adminUrl = requiredLoopbackUrl("BERRY_FILE_LIFECYCLE_E2E_ADMIN_DATABASE_URL");
const apiUrl = requiredLoopbackUrl("BERRY_FILE_LIFECYCLE_E2E_API_DATABASE_URL");
const s3Endpoint = requiredLoopbackUrl("BERRY_FILE_LIFECYCLE_E2E_S3_ENDPOINT");
const bucket = process.env.BERRY_FILE_LIFECYCLE_E2E_S3_BUCKET ?? "berry-file-lifecycle-e2e";
const prefix = `artifacts/file-lifecycle-e2e/${randomUUID()}`;
const now = "2026-07-10T00:00:00.000Z";
const webTenantId = "00000000-0000-7000-8000-000000000001";
const ids = {
  tenant: randomUUID(),
  owner: randomUUID(),
  other: randomUUID(),
  workspace: randomUUID(),
  task: randomUUID(),
  session: randomUUID(),
  unavailableFile: randomUUID(),
};

const admin = new Pool({ connectionString: adminUrl });
const executor = PgSqlExecutor.fromConnectionString(apiUrl);
const database = new CloudDatabaseService(executor);
const s3 = new S3Client({
  endpoint: s3Endpoint,
  region: "us-east-1",
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.BERRY_FILE_LIFECYCLE_E2E_S3_ACCESS_KEY_ID ?? "berry",
    secretAccessKey: process.env.BERRY_FILE_LIFECYCLE_E2E_S3_SECRET_ACCESS_KEY ?? "berry-integration-password",
  },
});
const files = new FilePlatformService(database, {
  client: s3,
  presignClient: s3,
  bucket,
  prefix,
  maxUploadBytes: 25 * 1024 * 1024,
  maxIndexableBytes: 25 * 1024 * 1024,
  partSize: 5 * 1024 * 1024,
  presignSeconds: 900,
});

let storedFile;
let server;
let stopping = false;
let dataCleaned = false;

try {
  await ensureBucket();
  await setupFixture();

  server = createServer((request, response) => {
    void handle(request, response).catch((error) => respondError(response, error));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  console.log(`[file-lifecycle-e2e] listening on ${publicUrl}`);
} catch (error) {
  await cleanup();
  throw error;
}

process.once("SIGINT", () => { void shutdown(0); });
process.once("SIGTERM", () => { void shutdown(0); });

async function handle(request, response) {
  setCors(response);
  if (request.method === "OPTIONS") {
    response.statusCode = 204;
    response.end();
    return;
  }
  const url = new URL(request.url ?? "/", publicUrl);
  const user = activeUser(request);
  if (request.method === "GET" && url.pathname === "/health") {
    return json(response, { ok: true });
  }
  if (request.method === "GET" && url.pathname === "/v1/auth/get-session") {
    return json(response, {
      user: {
        id: user.id,
        email: `${user.role}@file-lifecycle.berry.invalid`,
        name: user.role === "owner" ? "Lifecycle Owner" : "Lifecycle Collaborator",
        image: null,
      },
    });
  }
  if (request.method === "GET" && url.pathname === "/v1/workspaces") {
    return json(response, [workspaceFixture(user.id)]);
  }
  if (request.method === "GET" && url.pathname === "/v1/tasks") {
    return json(response, [taskFixture()]);
  }
  if (request.method === "GET" && url.pathname === "/v1/tasks/task_chat") {
    return json(response, taskFixture());
  }
  if (request.method === "GET" && url.pathname === "/v1/sessions/session_chat/messages") {
    return json(response, messageFixtures());
  }
  if (request.method === "GET" && url.pathname === "/v1/sessions/session_chat/turn-state") {
    return json(response, { active: false, turnId: null, bufferedEvents: [], runState: "completed" });
  }
  if (request.method === "GET" && url.pathname === "/v1/files") {
    return json(response, await files.list(ids.tenant, user.id, {
      category: url.searchParams.get("category") === "images" ? "images" : undefined,
    }));
  }
  const contentMatch = url.pathname.match(/^\/v1\/files\/([0-9a-f-]{36})\/content$/i);
  if (request.method === "GET" && contentMatch?.[1]) {
    return files.streamContent(
      ids.tenant,
      user.id,
      contentMatch[1],
      typeof request.headers.range === "string" ? request.headers.range : undefined,
      response,
      url.searchParams.get("download") === "1",
    );
  }
  const fileMatch = url.pathname.match(/^\/v1\/files\/([0-9a-f-]{36})$/i);
  if (request.method === "DELETE" && fileMatch?.[1]) {
    return json(response, await files.removeFromLibrary(ids.tenant, user.id, fileMatch[1]));
  }
  if (request.method === "GET" && url.pathname === "/v1/me/personalization") {
    return json(response, {});
  }
  if (request.method === "GET" && /^\/v1\/orgs\/[0-9a-f-]{36}\/permissions\/me$/i.test(url.pathname)) {
    return json(response, { tenantId: webTenantId, userId: user.id, role: "owner", permissions: [], featureFlags: [] });
  }
  if (request.method === "GET" && /^\/v1\/orgs\/[0-9a-f-]{36}\/allowances\/me$/i.test(url.pathname)) {
    return json(response, allowanceFixture(user.id));
  }
  if (request.method === "GET" && url.pathname === "/__e2e/state") {
    return json(response, await lifecycleState());
  }
  if (request.method === "POST" && url.pathname === "/__e2e/task/soft-delete") {
    await admin.query("UPDATE tasks SET deleted_at=COALESCE(deleted_at,now()),updated_at=now() WHERE id=$1::uuid", [ids.task]);
    return json(response, { ok: true });
  }
  if (request.method === "POST" && url.pathname === "/__e2e/task/restore") {
    await admin.query("UPDATE tasks SET deleted_at=NULL,updated_at=now() WHERE id=$1::uuid", [ids.task]);
    return json(response, { ok: true });
  }
  if (request.method === "POST" && url.pathname === "/__e2e/reset") {
    await cleanupData();
    await setupFixture();
    return json(response, { ok: true });
  }
  if (request.method === "POST" && url.pathname === "/__e2e/cleanup") {
    await cleanupData();
    return json(response, { ok: true });
  }
  response.statusCode = 404;
  return json(response, { error: `No lifecycle fixture for ${request.method} ${url.pathname}` });
}

async function seedDatabase() {
  await admin.query(
    `INSERT INTO tenants (id,name,slug,status) VALUES ($1::uuid,$2,$3,'active')`,
    [ids.tenant, "File lifecycle browser tenant", `file-lifecycle-${ids.tenant}`],
  );
  await admin.query(
    `INSERT INTO users (id,email,name,status) VALUES
      ($1::uuid,$3,'Lifecycle Owner','active'),
      ($2::uuid,$4,'Lifecycle Collaborator','active')`,
    [ids.owner, ids.other, `${ids.owner}@berry.invalid`, `${ids.other}@berry.invalid`],
  );
  await admin.query(
    `INSERT INTO tenant_memberships (tenant_id,user_id,status) VALUES
      ($1::uuid,$2::uuid,'active'),($1::uuid,$3::uuid,'active')`,
    [ids.tenant, ids.owner, ids.other],
  );
  await admin.query(
    `INSERT INTO workspaces (id,tenant_id,owner_id,name,slug,trust_state)
     VALUES ($1::uuid,$2::uuid,$3::uuid,'Lifecycle project','lifecycle-project','trusted')`,
    [ids.workspace, ids.tenant, ids.owner],
  );
  await admin.query(
    `INSERT INTO tasks (id,tenant_id,workspace_id,user_id,title,status)
     VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'Lifecycle conversation','completed')`,
    [ids.task, ids.tenant, ids.workspace, ids.owner],
  );
  await admin.query(
    `INSERT INTO sessions (id,tenant_id,task_id,user_id,model_provider_id,model)
     VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'fixture','fixture-model')`,
    [ids.session, ids.tenant, ids.task, ids.owner],
  );
  await admin.query("UPDATE tasks SET active_session_id=$2::uuid WHERE id=$1::uuid", [ids.task, ids.session]);
}

async function setupFixture() {
  dataCleaned = false;
  await seedDatabase();
  storedFile = await files.persistGeneratedImage(ids.tenant, ids.owner, {
    name: "berry-orchard.svg",
    mediaType: "image/svg+xml",
    data: Buffer.from(orchardSvg(), "utf8").toString("base64"),
    taskId: ids.task,
    sessionId: ids.session,
  });
  await database.withTenant(ids.tenant, (tenantExecutor) => tenantExecutor.execute(`
    INSERT INTO file_library_entries (tenant_id,user_id,file_id)
    VALUES ($1::uuid,$2::uuid,$3::uuid)
    ON CONFLICT (tenant_id,user_id,file_id) DO UPDATE
    SET deleted_at=NULL,updated_at=now()
  `, [ids.tenant, ids.other, storedFile.id]));
}

async function lifecycleState() {
  const result = await admin.query(
    `SELECT
       f.id::text AS file_id,
       f.deleted_at IS NULL AS file_live,
       f.status::text AS file_status,
       blob.id::text AS blob_id,
       blob.deleted_at IS NULL AS blob_live,
       blob.verification_status::text AS blob_status,
       count(DISTINCT association.id)::int AS association_count,
       count(DISTINCT library.id) FILTER (WHERE library.user_id=$2::uuid AND library.deleted_at IS NULL)::int AS owner_memberships,
       count(DISTINCT library.id) FILTER (WHERE library.user_id=$3::uuid AND library.deleted_at IS NULL)::int AS other_memberships,
       count(DISTINCT outbox.id) FILTER (WHERE outbox.event_type IN ('file.delete-blob','file.delete-object') AND outbox.completed_at IS NULL)::int AS pending_physical_deletions,
       EXISTS (SELECT 1 FROM tasks WHERE id=$4::uuid AND deleted_at IS NOT NULL) AS task_soft_deleted
     FROM files f
     JOIN file_blobs blob ON blob.id=f.blob_id
     LEFT JOIN file_associations association ON association.file_id=f.id
     LEFT JOIN file_library_entries library ON library.file_id=f.id
     LEFT JOIN runtime_outbox outbox ON outbox.tenant_id=f.tenant_id AND outbox.aggregate_id IN (f.id::text,blob.id::text)
     WHERE f.id=$1::uuid
     GROUP BY f.id,blob.id`,
    [storedFile.id, ids.owner, ids.other, ids.task],
  );
  return result.rows[0];
}

function messageFixtures() {
  const image = (id, title, fileId) => ({
    id,
    messageId: "msg_assistant_images",
    kind: "image",
    content: {
      title,
      prompt: title === "Berry orchard at dusk"
        ? "A cinematic berry orchard at blue hour with glowing rows of fruit."
        : "An image whose durable object is genuinely unavailable.",
      aspectRatio: "16:9",
      width: 640,
      height: 360,
      mimeType: "image/svg+xml",
      sizeBytes: 0,
      transparentBackground: false,
      generationId: id,
      parentGenerationId: null,
      fileId,
      src: `${publicUrl}/v1/files/${fileId}/content`,
      downloadUrl: `${publicUrl}/v1/files/${fileId}/content?download=1`,
    },
    position: id.endsWith("1") ? 0 : 1,
    createdAt: now,
  });
  return [
    message("msg_user_images", "user", [{
      id: "msg_user_images_part",
      messageId: "msg_user_images",
      kind: "text",
      content: "Create a cinematic berry orchard at dusk.",
      position: 0,
      createdAt: now,
    }]),
    message("msg_assistant_images", "assistant", [
      image("msg_assistant_images_1", "Berry orchard at dusk", storedFile.id),
      image("msg_assistant_images_2", "Unavailable archive image", ids.unavailableFile),
    ]),
  ];
}

function message(id, role, parts) {
  return {
    id,
    sessionId: "session_chat",
    role,
    status: "complete",
    parts,
    inputTokens: 0,
    outputTokens: 0,
    generationMs: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function taskFixture() {
  return {
    id: "task_chat",
    workspaceId: "self-host",
    title: "Reference-safe file lifecycle",
    status: "completed",
    activeSessionId: "session_chat",
    conversationKind: "chat",
    pinned: false,
    archived: false,
    deletedAt: null,
    unreadAt: null,
    lastReadAt: null,
    worktreePath: null,
    worktreeBranch: null,
    worktreeBaseRef: null,
    worktreeBaseSha: null,
    pullRequestUrl: null,
    pullRequestNumber: null,
    createdAt: now,
    updatedAt: now,
  };
}

function workspaceFixture(ownerUserId) {
  return {
    id: "self-host",
    path: "/workspace",
    name: "Lifecycle project",
    workspaceKind: "project",
    ownerUserId,
    trustState: "trusted",
    lastOpenedAt: now,
    indexedAt: null,
    createdAt: now,
    updatedAt: now,
    pinned: false,
  };
}

function allowanceFixture(userId) {
  return {
    tenantId: webTenantId,
    userId,
    cycleStart: now,
    cycleEnd: "2026-08-10T00:00:00.000Z",
    baseLimitMicros: null,
    adjustmentMicros: "0",
    effectiveLimitMicros: null,
    usedMicros: "0",
    reservedMicros: "0",
    availableMicros: null,
    status: "unlimited",
  };
}

function activeUser(request) {
  const cookies = Object.fromEntries(String(request.headers.cookie ?? "").split(";").flatMap((item) => {
    const separator = item.indexOf("=");
    return separator < 0 ? [] : [[item.slice(0, separator).trim(), item.slice(separator + 1).trim()]];
  }));
  return cookies["berry-e2e-user"] === "other"
    ? { id: ids.other, role: "other" }
    : { id: ids.owner, role: "owner" };
}

function setCors(response) {
  response.setHeader("Access-Control-Allow-Origin", webOrigin);
  response.setHeader("Access-Control-Allow-Credentials", "true");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "content-type,range");
  response.setHeader("Vary", "Origin");
}

function json(response, body) {
  if (response.writableEnded) return;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(body));
}

function respondError(response, error) {
  if (response.writableEnded) return;
  const status = typeof error?.getStatus === "function" ? error.getStatus() : 500;
  response.statusCode = status;
  json(response, { error: error instanceof Error ? error.message : String(error) });
}

async function ensureBucket() {
  try {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  } catch (error) {
    if (!["BucketAlreadyOwnedByYou", "BucketAlreadyExists"].includes(error?.name)) throw error;
  }
}

async function shutdown(code) {
  if (stopping) return;
  stopping = true;
  await cleanup();
  process.exit(code);
}

async function cleanup() {
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  await cleanupData();
  await Promise.allSettled([executor.close(), admin.end()]);
  s3.destroy();
}

async function cleanupData() {
  if (dataCleaned) return;
  dataCleaned = true;
  const objectKey = storedFile
    ? (await admin.query("SELECT object_key FROM file_blobs WHERE id=(SELECT blob_id FROM files WHERE id=$1::uuid)", [storedFile.id]).catch(() => ({ rows: [] }))).rows[0]?.object_key
    : null;
  if (objectKey) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey })).catch(() => undefined);
  await admin.query("DELETE FROM tenants WHERE id=$1::uuid", [ids.tenant]).catch(() => undefined);
  await admin.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [[ids.owner, ids.other]]).catch(() => undefined);
  storedFile = undefined;
}

function orchardSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
    <rect width="640" height="360" fill="#251044"/>
    <circle cx="480" cy="92" r="76" fill="#ff4f91" opacity=".72"/>
    <path d="M0 300L260 170L380 170L640 310V360H0Z" fill="#09040e"/>
  </svg>`;
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredLoopbackUrl(name) {
  const value = required(name);
  const hostname = new URL(value).hostname;
  if (!["127.0.0.1", "localhost", "::1"].includes(hostname)) {
    throw new Error(`${name} must target an isolated loopback test service`);
  }
  return value;
}
