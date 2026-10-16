#!/usr/bin/env node
// Uses synthetic fixtures only. Credentials are read from the environment and never printed.
import { readFile } from "node:fs/promises";
import { DURABLE_REWRITING_PROMPT, DURABLE_TOOL_DEFINITIONS } from "../apps/worker/dist/turn-runner.js";
const cases=JSON.parse(await readFile(new URL("./rewrite-eval-cases.json",import.meta.url),"utf8"));
const endpoint=process.env.BERRY_ROUTER_INFERENCE_BASE_URL;
const key=process.env.BERRY_ROUTER_API_KEY;
if(!endpoint||!key)throw new Error("Configured router endpoint and credential are required");
const model=process.env.BERRY_REWRITE_EVAL_MODEL||process.env.BERRY_ROUTER_DEFAULT_MODEL;
const tool=DURABLE_TOOL_DEFINITIONS.find(t=>t.function.name==="compose_message");
let failed=0;
for(const c of cases){
 const r=await fetch(endpoint.replace(/\/$/,"")+(process.env.BERRY_ROUTER_CHAT_COMPLETIONS_PATH||"/chat/completions"),{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${key}`},body:JSON.stringify({model,messages:[{role:"system",content:DURABLE_REWRITING_PROMPT},...(c.messages||[{role:"user",content:c.input}])],tools:[tool],max_tokens:1200}),signal:AbortSignal.timeout(45000)});
 if(!r.ok){console.log(JSON.stringify({case:c.id,status:"blocked",httpStatus:r.status}));process.exitCode=1;break;}
 const result=await r.json();const message=result.choices?.[0]?.message;
 const call=message?.tool_calls?.find(t=>t.function.name==="compose_message");
 const draft=call?JSON.parse(call.function.arguments):null;
 const text=draft?.variants?.map(v=>v.body).join("\n")||message?.content||"";
 const checks={content:c.checks.contains.every(v=>text.toLowerCase().includes(v.toLowerCase())),perspective:/\b(I|we|my|our)\b/i.test(text)===c.checks.firstPerson,noInventedActions:c.checks.forbidden.every(v=>!text.toLowerCase().includes(v.toLowerCase())),emailKind:!c.input.toLowerCase().includes("report")?draft?.kind==="email":true};
 if(Object.values(checks).some(v=>!v))failed++;
 console.log(JSON.stringify({case:c.id,checks,draft:text}));
}
if(failed)process.exitCode=1;
