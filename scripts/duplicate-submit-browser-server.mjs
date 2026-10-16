#!/usr/bin/env node
// In-memory API for the duplicate-submit browser check (H-035). Task creation is
// deliberately slow so a second Enter lands while the first request is in flight.
// Usage: node scripts/duplicate-submit-browser-server.mjs   (listens on 127.0.0.1:3199)
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const userId = "00000000-0000-7000-8000-0000000000a1";
const workspaceId = "00000000-0000-7000-8000-0000000000a2";
const now = () => new Date().toISOString();
let tasks = [];
let calls = [];

const taskRecord = (id, sessionId, title) => ({
  id, workspaceId, title, status: "running", activeSessionId: sessionId, conversationKind: "chat",
  pinned: false, archived: false, deletedAt: null, unreadAt: null, lastReadAt: null,
  worktreePath: null, worktreeBranch: null, worktreeBaseRef: null, worktreeBaseSha: null,
  pullRequestUrl: null, pullRequestNumber: null, createdAt: now(), updatedAt: now(),
});
const sessionRecord = (id, taskId) => ({
  id, taskId, parentSessionId: null, status: "active", modelProviderId: null, model: null,
  permissionMode: "ask", createdAt: now(), updatedAt: now(),
});

const server = createServer((req, res) => {
  void handle(req, res).catch((error) => { res.statusCode = 500; res.end(JSON.stringify({ message: error.message })); });
});

async function handle(req, res) {
  const origin = req.headers.origin || "http://127.0.0.1:3111";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "content-type,x-berry-tenant-id,x-berry-user-id");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  if (req.method === "OPTIONS") { res.end(); return; }
  const url = new URL(req.url, "http://127.0.0.1:3199");
  const json = (value) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(value)); };
  let body = {};
  if (req.method !== "GET") { let raw = ""; for await (const chunk of req) raw += chunk; body = raw ? JSON.parse(raw) : {}; }

  if (url.pathname === "/__e2e/state") return json({ calls, tasks: tasks.map((task) => task.task.title) });
  if (url.pathname === "/__e2e/reset") { tasks = []; calls = []; return json({ ok: true }); }
  if (url.pathname === "/v1/auth/get-session") return json({ user: { id: userId, email: "browser@duplicate.invalid", name: "Duplicate Tester", image: null } });
  if (url.pathname === "/v1/workspaces") return json([{ id: workspaceId, path: "/workspace", name: "Duplicate tests", workspaceKind: "project", ownerUserId: userId, trustState: "trusted", lastOpenedAt: now(), indexedAt: null, createdAt: now(), updatedAt: now(), pinned: false }]);
  if (url.pathname === "/v1/tasks" && req.method === "POST") {
    calls.push("create-task");
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const id = randomUUID(), sessionId = randomUUID();
    const created = { task: taskRecord(id, sessionId, String(body.title ?? "New cloud task")), session: sessionRecord(sessionId, id) };
    tasks.push(created);
    return json(created);
  }
  if (url.pathname === "/v1/tasks") return json(tasks.map((item) => item.task));
  const task = tasks.find((item) => url.pathname === `/v1/tasks/${item.task.id}`);
  if (task) return json(task.task);
  const session = tasks.find((item) => url.pathname.startsWith(`/v1/sessions/${item.session.id}/`));
  if (session) {
    if (url.pathname.endsWith("/events")) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(": connected\n\n");
      return;
    }
    if (url.pathname.endsWith("/turns")) { calls.push("start-turn"); return json({ turnId: randomUUID(), sessionId: session.session.id, accepted: true }); }
    if (url.pathname.endsWith("/messages")) return json(req.method === "POST" ? { id: body.messageId ?? randomUUID() } : []);
    if (url.pathname.endsWith("/follow-ups")) return json({ items: [], nextCursor: null, hasMore: false });
    if (url.pathname.endsWith("/turn-state")) return json({ state: "idle" });
  }
  if (url.pathname === "/v1/me/personalization") return json({});
  if (url.pathname.endsWith("/permissions/me")) return json({ tenantId: "00000000-0000-7000-8000-0000000000a0", userId, role: "owner", permissions: [], featureFlags: [] });
  res.statusCode = 404;
  return json({ message: `No fixture: ${req.method} ${url.pathname}` });
}

await new Promise((resolve) => server.listen(3199, "127.0.0.1", resolve));
console.log("Duplicate-submit browser API: http://127.0.0.1:3199");
await new Promise((resolve) => process.once("SIGINT", () => { server.closeAllConnections(); server.close(resolve); }));
