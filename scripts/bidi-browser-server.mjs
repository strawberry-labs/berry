#!/usr/bin/env node
// In-memory API for the mixed Arabic/English rendering check (H-047). One task
// has a settled assistant answer, the other a turn that is still streaming.
// The text is synthetic. Usage: node scripts/bidi-browser-server.mjs  (127.0.0.1:3197)
import { createServer } from "node:http";

const userId = "00000000-0000-7000-8000-0000000000b1";
const workspaceId = "00000000-0000-7000-8000-0000000000b2";
const createdAt = "2026-10-14T08:00:00.000Z";
const unknown = new Set();

export const SETTLED_ANSWER = [
  "## ملخص منصة Berry",
  "",
  "تعمل منصة Berry مع Microsoft 365 لتلخيص الملفات.",
  "",
  "Berry Workspace هو المكان الذي تُحفظ فيه ملفات المشروع.",
  "",
  "- يدعم ملفات PDF وDOCX وXLSX",
  "- شارك الرابط https://ai.example.com/tasks/123 مع الفريق",
  "",
  "1. افتح صفحة Settings",
  "2. اختر Connectors ثم Google Drive",
  "",
  "> ملاحظة: لا تشارك مفتاح API مع أي شخص.",
  "",
  "| البند | القيمة |",
  "| --- | --- |",
  "| الرصيد | -1,250.50 درهم |",
  "| التاريخ | 2026-10-14 |",
  "",
  "استخدم الأداة `persist_artifact` لحفظ الملف النهائي.",
  "",
  "```python",
  "total = price * 2  # مجموع",
  "```",
  "",
  "This English paragraph mentions منصة Berry once and stays left-to-right.",
].join("\n");

export const STREAMING_ANSWER = [
  "تعمل منصة Berry مع Microsoft 365 لتلخيص الملفات.",
  "",
  "Berry Workspace هو المكان الذي تُحفظ فيه ملفات المشروع.",
  "",
  "This English line stays left-to-right.",
].join("\n");

const USER_PROMPT = "اكتب ملخصاً قصيراً عن منصة Berry وكيف تعمل مع Microsoft 365.";

const tasks = [
  { id: "00000000-0000-7000-8000-0000000000c1", sessionId: "00000000-0000-7000-8000-0000000000d1", title: "Arabic summary", answer: SETTLED_ANSWER, streaming: false },
  { id: "00000000-0000-7000-8000-0000000000c2", sessionId: "00000000-0000-7000-8000-0000000000d2", title: "Arabic summary (streaming)", answer: STREAMING_ANSWER, streaming: true },
];

const taskRecord = (task) => ({
  id: task.id, workspaceId, title: task.title, status: task.streaming ? "running" : "completed", activeSessionId: task.sessionId,
  conversationKind: "chat", pinned: false, archived: false, deletedAt: null, unreadAt: null, lastReadAt: null,
  worktreePath: null, worktreeBranch: null, worktreeBaseRef: null, worktreeBaseSha: null,
  pullRequestUrl: null, pullRequestNumber: null, createdAt, updatedAt: createdAt,
});
const message = (task, role, index, content) => {
  const id = `${task.sessionId.slice(0, -2)}${role === "user" ? "e" : "f"}${index}`;
  return {
    id, sessionId: task.sessionId, role, status: "complete", inputTokens: 0, outputTokens: 0, generationMs: 0, createdAt, updatedAt: createdAt,
    parts: [{ id: `${id}-part`, messageId: id, kind: "text", content, position: 0, createdAt }],
  };
};
const history = (task) => task.streaming
  ? [message(task, "user", 1, USER_PROMPT)]
  : [message(task, "user", 1, USER_PROMPT), message(task, "assistant", 2, task.answer)];
const turnState = (task) => task.streaming
  ? {
      active: true, turnId: "turn-bidi", bufferedEvents: [
        { kind: "turn.start", turnId: "turn-bidi" },
        { kind: "message.start", messageId: "live-bidi", role: "assistant" },
        { kind: "message.delta", messageId: "live-bidi", delta: task.answer, channel: "text" },
      ],
      lastEventId: null, startedAt: createdAt, replayOnly: false, runState: "calling_model",
    }
  : { active: false, turnId: null, bufferedEvents: [], replayOnly: false };

const server = createServer((req, res) => {
  void handle(req, res).catch((error) => { res.statusCode = 500; res.end(JSON.stringify({ message: error.message })); });
});

async function handle(req, res) {
  const origin = req.headers.origin || "http://127.0.0.1:3112";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "content-type,x-berry-tenant-id,x-berry-user-id");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  if (req.method === "OPTIONS") { res.end(); return; }
  const url = new URL(req.url, "http://127.0.0.1:3197");
  const json = (value) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(value)); };
  for await (const chunk of req) void chunk;

  if (url.pathname === "/__e2e/state") return json({ tasks: tasks.map((task) => task.id), unknown: [...unknown] });
  if (url.pathname === "/v1/auth/get-session") return json({ user: { id: userId, email: "browser@bidi.invalid", name: "Bidi Tester", image: null } });
  if (url.pathname === "/v1/workspaces") return json([{ id: workspaceId, path: "/workspace", name: "Bidi checks", workspaceKind: "project", ownerUserId: userId, trustState: "trusted", lastOpenedAt: createdAt, indexedAt: null, createdAt, updatedAt: createdAt, pinned: false }]);
  if (url.pathname === "/v1/tasks" && req.method === "GET") return json(tasks.map(taskRecord));
  const task = tasks.find((item) => url.pathname === `/v1/tasks/${item.id}` || url.pathname.startsWith(`/v1/sessions/${item.sessionId}/`));
  if (task && url.pathname === `/v1/tasks/${task.id}`) return json(taskRecord(task));
  if (task && url.pathname.endsWith("/events")) {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(": connected\n\n");
    return;
  }
  if (task && url.pathname.endsWith("/messages")) {
    const messages = history(task);
    return json({ messages, hasOlder: false, hasNewer: false, oldestSequence: "1", newestSequence: String(messages.length), cursorPresent: null, historyRevision: "1", historyDeletionRevision: null });
  }
  if (task && url.pathname.endsWith("/turn-state")) return json(turnState(task));
  if (task && url.pathname.endsWith("/follow-ups")) return json({ items: [], nextCursor: null, hasMore: false });
  if (url.pathname === "/v1/me/personalization") return json({});
  if (url.pathname.endsWith("/permissions/me")) return json({ tenantId: "00000000-0000-7000-8000-0000000000b0", userId, role: "owner", permissions: [], featureFlags: [] });
  unknown.add(`${req.method} ${url.pathname}`);
  res.statusCode = 404;
  return json({ message: `No fixture: ${req.method} ${url.pathname}` });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await new Promise((resolve) => server.listen(3197, "127.0.0.1", resolve));
  console.log("Bidi browser API: http://127.0.0.1:3197");
  await new Promise((resolve) => process.once("SIGINT", () => { server.closeAllConnections(); server.close(resolve); }));
}
