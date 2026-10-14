import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
export async function serveQueueFixture(ctx) {
 const {tenantId,userId,workspaceId,fixture,admit,enqueue,drain,query,queue,turns,scoped,promoteIdleQueuedFollowUps}=ctx;
 let f=await fixture();await admit(f,"Original browser task");
 const calls=[];let failQueueOnce=false;
 const now=new Date().toISOString();
 const task=async()=>({...f,id:f.taskId,workspaceId,title:"Queue browser verification",status:(await query("SELECT status FROM tasks WHERE id=$1",[f.taskId]))[0].status,activeSessionId:f.sessionId,conversationKind:"chat",pinned:false,archived:false,deletedAt:null,unreadAt:null,lastReadAt:null,worktreePath:null,worktreeBranch:null,worktreeBaseRef:null,worktreeBaseSha:null,pullRequestUrl:null,pullRequestNumber:null,createdAt:now,updatedAt:now});
 const messages=async()=>{
  const rows=await query("SELECT m.*,coalesce(jsonb_agg(jsonb_build_object('id',p.id,'messageId',m.id,'kind',p.type,'content',p.content,'position',p.ordinal,'createdAt',p.created_at) ORDER BY p.ordinal) FILTER(WHERE p.id IS NOT NULL),'[]') AS parts FROM messages m LEFT JOIN message_parts p ON p.message_id=m.id WHERE m.session_id=$1 GROUP BY m.id ORDER BY m.sequence_id",[f.sessionId]);
  return rows.map(m=>({id:m.id,sessionId:f.sessionId,role:m.role,status:m.status,parts:m.parts,inputTokens:m.input_tokens,outputTokens:m.output_tokens,generationMs:m.generation_ms,createdAt:m.created_at,updatedAt:m.updated_at}));
 };
 const server=createServer((req,res)=>{void handle(req,res).catch(e=>{res.statusCode=e.getStatus?.()||500;res.end(JSON.stringify({message:e.message}));});});
 async function handle(req,res) {
  const origin=req.headers.origin||"http://127.0.0.1:3108";
  res.setHeader("Access-Control-Allow-Origin",origin);res.setHeader("Access-Control-Allow-Credentials","true");res.setHeader("Access-Control-Allow-Headers","content-type,x-berry-tenant-id,x-berry-user-id");res.setHeader("Access-Control-Allow-Methods","GET,POST,PATCH,DELETE,OPTIONS");
  if(req.method==="OPTIONS"){res.end();return;}
  const u=new URL(req.url,"http://127.0.0.1:3198");
  const json=x=>{res.setHeader("Content-Type","application/json");res.end(JSON.stringify(x));};
  let body={};if(req.method!=="GET"){let raw="";for await(const chunk of req)raw+=chunk;body=raw?JSON.parse(raw):{};}
  if(u.pathname==="/__e2e/state")return json({...f,tenantId,calls,queue:await queue.list(tenantId,userId,f.sessionId),messages:await messages(),runs:await query("SELECT id,state,runtime_request->>'input' AS input FROM turn_runs WHERE session_id=$1 ORDER BY created_at",[f.sessionId])});
  if(u.pathname==="/__e2e/reset"){f=await fixture();await admit(f,"Original browser task");calls.length=0;return json(f);}
  if(u.pathname==="/__e2e/fail-queue"){failQueueOnce=true;return json({ok:true});}
  if(u.pathname==="/__e2e/complete"){
   for(let i=0;i<5;i++){await scoped(e=>promoteIdleQueuedFollowUps(e,tenantId));const r=(await query("SELECT id FROM turn_runs WHERE session_id=$1 AND state NOT IN ('completed','failed','cancelled','recovery_required') ORDER BY created_at LIMIT 1",[f.sessionId]))[0];if(!r)break;await drain(r.id);}
   return json({ok:true});
  }
  if(u.pathname==="/v1/auth/get-session")return json({user:{id:userId,email:"browser@queue.invalid",name:"Queue Tester",image:null}});
  if(u.pathname==="/v1/workspaces")return json([{id:workspaceId,path:"/workspace",name:"Queue tests",workspaceKind:"project",ownerUserId:userId,trustState:"trusted",lastOpenedAt:now,indexedAt:null,createdAt:now,updatedAt:now,pinned:false}]);
  if(u.pathname==="/v1/tasks")return json([await task()]);
  if(u.pathname===`/v1/tasks/${f.taskId}`)return json(await task());
  if(u.pathname===`/v1/sessions/${f.sessionId}/turn-state`)return json(await turns.state(tenantId,f.sessionId));
  if(u.pathname===`/v1/sessions/${f.sessionId}/events`){
   res.writeHead(200,{"Content-Type":"text/event-stream","Cache-Control":"no-cache","Connection":"keep-alive"});res.write(": connected\n\n");
   let cursor=u.searchParams.get("cursor"),busy=false;
   const timer=setInterval(async()=>{if(busy)return;busy=true;try{for(const e of await turns.eventsAfter(tenantId,f.sessionId,cursor)){res.write(`id: ${e.id}\ndata: ${JSON.stringify(e.event)}\n\n`);cursor=e.id;}}catch{}finally{busy=false;}},100);
   req.on("close",()=>clearInterval(timer));return;
  }
  if(u.pathname===`/v1/sessions/${f.sessionId}/messages`){
   if(req.method==="POST"){
    calls.push("append");const id=body.messageId||randomUUID();await query("INSERT INTO messages(id,tenant_id,session_id,task_id,role,status) VALUES($1,$2,$3,$4,'user','complete') ON CONFLICT(id) DO NOTHING",[id,tenantId,f.sessionId,f.taskId]);
    for(const [i,p] of body.parts.entries())await query("INSERT INTO message_parts(tenant_id,message_id,type,content,ordinal) VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT(message_id,ordinal) DO NOTHING",[tenantId,id,p.kind,JSON.stringify(p.content),i]);
    return json((await messages()).find(m=>m.id===id));
   }
   return json(await messages());
  }
  if(u.pathname.startsWith(`/v1/sessions/${f.sessionId}/messages/`))return json((await messages()).find(m=>m.id===u.pathname.split("/").at(-1)));
  if(u.pathname===`/v1/sessions/${f.sessionId}/follow-ups`){
   if(req.method==="POST"){
    calls.push(`enqueue:${body.idempotencyKey}`);
    const row=await enqueue(f,body.input,body.idempotencyKey,body.attachments||[]);
    if(failQueueOnce){failQueueOnce=false;res.statusCode=503;return json({message:"Simulated lost queue response. Retry your saved prompt."});}
    return json(row);
   }
   return json(await queue.list(tenantId,userId,f.sessionId));
  }
  if(u.pathname.startsWith("/v1/follow-ups/")){
   const id=u.pathname.split("/").at(-1);calls.push(req.method==="DELETE"?"delete-queue":"update-queue");
   const row=req.method==="DELETE"?await queue.cancel(tenantId,userId,id):await queue.update(tenantId,userId,id,body);
   await scoped(e=>promoteIdleQueuedFollowUps(e,tenantId));return json(row);
  }
  if(u.pathname===`/v1/sessions/${f.sessionId}/cancel`){calls.push("cancel");return json({ok:await turns.cancel(tenantId,f.sessionId)});}
  if(u.pathname===`/v1/sessions/${f.sessionId}/turns`){calls.push("admit");const result=await turns.admit({tenantId,userId,workspaceId,...f,requestId:body.operationId?`model_${body.operationId}`:randomUUID(),operationFingerprint:randomUUID(),input:body.input,requestMessageId:body.requestMessageId,runtimeRequest:{input:body.input},groundingContext:{},budgetReservationRequired:false});return json({...result,turnId:result.runId,operationId:body.operationId||randomUUID(),accepted:true});}
  if(u.pathname==="/v1/me/personalization")return json({});
  if(u.pathname.endsWith("/permissions/me"))return json({tenantId,userId,role:"owner",permissions:[],featureFlags:[]});
  res.statusCode=404;return json({message:`No fixture: ${req.method} ${u.pathname}`});
 }
 await new Promise(r=>server.listen(3198,"127.0.0.1",r));console.log("Queue browser API: http://127.0.0.1:3198");
 await new Promise(resolve=>process.once("SIGINT",()=>{server.closeAllConnections();server.close(resolve);}));
}
