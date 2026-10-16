// Loopback-only UI fixture, with totals from the real PostgreSQL repository.
import { createServer } from "node:http";
export async function serveTaskTokenUsageFixture({ usage,tenantId,userId,workspaceId,taskId,sessionId }) {
  const now = new Date().toISOString();
  const task = { id:taskId,workspaceId,title:"Context details test",status:"completed",activeSessionId:sessionId,conversationKind:"chat",pinned:false,archived:false,deletedAt:null,unreadAt:null,lastReadAt:null,worktreePath:null,worktreeBranch:null,worktreeBaseRef:null,worktreeBaseSha:null,pullRequestUrl:null,pullRequestNumber:null,createdAt:now,updatedAt:now };
  const workspace = { id:workspaceId,path:"/workspace",name:"Context tests",workspaceKind:"project",ownerUserId:userId,trustState:"trusted",lastOpenedAt:now,indexedAt:null,createdAt:now,updatedAt:now,pinned:false };
  let requests = 0, failOnce = false;
  const server = createServer((req,res) => { void handle(req,res).catch((error) => { res.statusCode=500; res.end(JSON.stringify({ message:error.message })); }); });
  async function handle(req,res) {
    res.setHeader("Access-Control-Allow-Origin",req.headers.origin || "http://127.0.0.1:3113"); res.setHeader("Access-Control-Allow-Credentials","true");
    res.setHeader("Access-Control-Allow-Headers","content-type,x-berry-tenant-id,x-berry-user-id"); res.setHeader("Access-Control-Allow-Methods","GET,POST,PATCH,OPTIONS");
    if (req.method==="OPTIONS") { res.end(); return; }
    const path = new URL(req.url,"http://127.0.0.1:3198").pathname;
    const json = (value) => { res.setHeader("Content-Type","application/json"); res.end(JSON.stringify(value)); };
    if (path==="/__e2e/state") return json({ tenantId,userId,workspaceId,taskId,sessionId,requests });
    if (path==="/__e2e/fail-once") { failOnce=true; return json({ ok:true }); }
    if (path==="/v1/auth/get-session") return json({ user:{ id:userId,email:"browser@context.invalid",name:"Context Tester",image:null } });
    if (["/v1/workspaces","/v1/workspaces/page","/v1/projects/page"].includes(path)) return json(path.endsWith("/page") ? { items:[workspace],nextCursor:null,hasMore:false } : [workspace]);
    if (["/v1/tasks","/v1/tasks/page"].includes(path)) return json(path.endsWith("/page") ? { items:[task],nextCursor:null,hasMore:false } : [task]);
    if (path.startsWith("/v1/tasks/")) return json(task);
    if (path.endsWith("/task-token-usage")) {
      requests++;
      if (failOnce) { failOnce=false; res.statusCode=503; return json({ message:"Transient fixture failure" }); }
      return json(await usage.taskTokenUsage(tenantId,taskId));
    }
    if (path.endsWith("/context-stats")) return json({ usedTokens:28000,contextWindow:200000,percentUsed:14,tokensLeft:172000,source:"provider-reported",thresholdState:"normal" });
    if (path.endsWith("/messages")) return json([{ id:sessionId,sessionId,role:"assistant",status:"complete",parts:[{ id:taskId,messageId:sessionId,kind:"text",content:"The task's recorded usage spans multiple sessions and an active model turn. Click the context ring to inspect the totals.",position:0,createdAt:now }],inputTokens:0,outputTokens:0,generationMs:0,createdAt:now,updatedAt:now }]);
    if (path.endsWith("/turn-state")) return json({ active:false,turnId:null,bufferedEvents:[],owner:null });
    if (path.endsWith("/follow-ups")) return json({ items:[] });
    if (path.endsWith("/events")) { res.writeHead(200,{ "Content-Type":"text/event-stream","Cache-Control":"no-cache" }); res.write(": connected\n\n"); return; }
    if (path.endsWith("/permissions/me")) return json({ tenantId,userId,role:"owner",permissions:[],featureFlags:[] });
    if (path==="/v1/me/personalization") return json({});
    res.statusCode=404; return json({ message:`No fixture: ${path}` });
  }
  await new Promise((resolve) => server.listen(3198,"127.0.0.1",resolve));
  console.log(`Context usage fixture: http://127.0.0.1:3113/tasks/${taskId}`);
  await new Promise((resolve) => process.once("SIGINT",() => { server.closeAllConnections(); server.close(resolve); }));
}
