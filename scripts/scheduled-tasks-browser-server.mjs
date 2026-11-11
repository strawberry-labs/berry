// Loopback-only UI fixture backed by the actual schedule service and durable worker.
import { createServer } from "node:http";
import { ScheduledTasksController } from "../apps/api/dist/schedules/scheduled-tasks.controller.js";
export async function serveScheduledTasksFixture(ctx) {
  const { tenantId, userId, workspaceId, scope, repository, services, query, claim, admit, drain, turns } = ctx;
  const controller = new ScheduledTasksController(services, { ensureGeneralWorkspace: async () => ({ id: workspaceId }) });
  const auth = { auth: { user: { id: userId } } };
  const now = new Date().toISOString(); let failSaveOnce = false;
  const task = (t) => ({ id: t.id, workspaceId: t.workspace_id, title: t.title, status: t.status, activeSessionId: t.active_session_id,
    conversationKind: "chat", pinned: false, archived: false, deletedAt: null, unreadAt: t.unread_at,
    lastReadAt: null, worktreePath: null, worktreeBranch: null, worktreeBaseRef: null, worktreeBaseSha: null,
    pullRequestUrl: null, pullRequestNumber: null, createdAt: t.created_at, updatedAt: t.updated_at });
  const messages = async (sessionId) => (await query(`SELECT m.*,coalesce(jsonb_agg(jsonb_build_object('id',p.id,'messageId',m.id,'kind',p.type,'content',p.content,'position',p.ordinal,'createdAt',p.created_at) ORDER BY p.ordinal) FILTER(WHERE p.id IS NOT NULL),'[]') AS parts
    FROM messages m LEFT JOIN message_parts p ON p.message_id=m.id WHERE m.session_id=$1 GROUP BY m.id ORDER BY m.sequence_id`, [sessionId]))
    .map((m) => ({ id: m.id, sessionId, role: m.role, status: m.status, parts: m.parts, inputTokens: m.input_tokens, outputTokens: m.output_tokens, generationMs: m.generation_ms, createdAt: m.created_at, updatedAt: m.updated_at }));
  const server = createServer((req, res) => { void handle(req, res).catch((error) => { res.statusCode = error.getStatus?.() || 500; res.end(JSON.stringify({ message: error.message })); }); });
  async function handle(req, res) {
    const origin = req.headers.origin || "http://127.0.0.1:3112";
    res.setHeader("Access-Control-Allow-Origin", origin); res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Headers", "content-type,x-berry-tenant-id,x-berry-user-id"); res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
    if (req.method === "OPTIONS") { res.end(); return; }
    const url = new URL(req.url, "http://127.0.0.1:3199"), path = url.pathname;
    const json = (value) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(value)); };
    let body = {}; if (req.method !== "GET") { let raw = ""; for await (const chunk of req) raw += chunk; body = raw ? JSON.parse(raw) : {}; }
    if (path === "/__e2e/state") return json({ tenantId, userId, workspaceId, schedules: await repository.list(scope) });
    if (path === "/__e2e/fail-save") { failSaveOnce = true; return json({ ok: true }); }
    if (path === "/__e2e/dispatch") {
      await repository.enqueueDue(tenantId); const { owner, claims } = await claim();
      for (const c of claims) { const turnId = await admit(c); await repository.admitted(tenantId, c.id, owner, turnId); await drain(turnId); }
      return json({ ok: true });
    }
    if (path === "/v1/auth/get-session") return json({ user: { id: userId, email: "browser@schedule.invalid", name: "Schedule Tester", image: null } });
    if (["/v1/workspaces", "/v1/workspaces/page", "/v1/projects/page"].includes(path)) {
      const items = [{ id: workspaceId, path: "/workspace", name: "Schedule tests", workspaceKind: "project", ownerUserId: userId, trustState: "trusted", lastOpenedAt: now, indexedAt: null, createdAt: now, updatedAt: now, pinned: false }];
      return json(path.endsWith("/page") ? { items, nextCursor: null, hasMore: false } : items);
    }
    if (["/v1/tasks", "/v1/tasks/page"].includes(path)) {
      const items = (await query("SELECT * FROM tasks WHERE tenant_id=$1 AND user_id=$2 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 100", [tenantId, userId])).map(task);
      return json(path.endsWith("/page") ? { items, nextCursor: null, hasMore: false } : items);
    }
    if (path.startsWith("/v1/tasks/")) { const [t] = await query("SELECT * FROM tasks WHERE tenant_id=$1 AND id=$2", [tenantId, path.split("/")[3]]); return json(t ? task(t) : null); }
    if (path === "/v1/scheduled-tasks") {
      if (req.method === "POST") {
        const saved = await controller.create(auth, body);
        if (failSaveOnce) { failSaveOnce = false; res.statusCode = 503; return json({ message: "Simulated lost save response. Your draft is still here." }); }
        return json(saved);
      }
      return json(await controller.list(auth));
    }
    if (path.startsWith("/v1/scheduled-tasks/")) {
      const id = path.split("/")[3];
      if (path.endsWith("/runs")) return json(await controller.history(auth, id, url.searchParams.get("limit") || "30"));
      if (path.endsWith("/run")) return json(await controller.run(auth, id, body));
      return json(req.method === "DELETE" ? await controller.remove(auth, id) : await controller.update(auth, id, body));
    }
    const sessionId = path.split("/")[3];
    if (path.startsWith("/v1/sessions/") && path.endsWith("/messages")) return json(await messages(sessionId));
    if (path.startsWith("/v1/sessions/") && path.endsWith("/turn-state")) return json(await turns.state(tenantId, sessionId));
    if (path.startsWith("/v1/sessions/") && path.endsWith("/follow-ups")) return json({ items: [] });
    if (path.startsWith("/v1/sessions/") && path.endsWith("/events")) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" }); res.write(": connected\n\n");
      let cursor = url.searchParams.get("cursor"), busy = false;
      const timer = setInterval(async () => { if (busy) return; busy = true; try { for (const event of await turns.eventsAfter(tenantId, sessionId, cursor)) { res.write(`id: ${event.id}\ndata: ${JSON.stringify(event.event)}\n\n`); cursor = event.id; } } finally { busy = false; } }, 200);
      req.on("close", () => clearInterval(timer)); return;
    }
    if (path === "/v1/me/personalization") return json({});
    if (path.endsWith("/permissions/me")) return json({ tenantId, userId, role: "owner", permissions: [], featureFlags: [] });
    res.statusCode = 404; return json({ message: `No fixture: ${req.method} ${path}` });
  }
  await new Promise((resolve) => server.listen(3199, "127.0.0.1", resolve)); console.log("Scheduled task browser API: http://127.0.0.1:3199");
  await new Promise((resolve) => process.once("SIGINT", () => { server.closeAllConnections(); server.close(resolve); }));
}
