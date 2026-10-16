#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { cloudMigrations } from "../packages/db/dist/index.js";
const require=createRequire(new URL("../apps/worker/package.json",import.meta.url));
const {Client}=require("pg");
const url=new URL(process.env.BERRY_TEST_DATABASE_URL||"");
assert(["127.0.0.1","localhost","[::1]"].includes(url.hostname),"Use an empty disposable loopback database with pgvector installed");
const c=new Client({connectionString:url.href});await c.connect();
try {
 assert.equal((await c.query("SELECT to_regclass('public.tenants') AS existing")).rows[0].existing,null,"Database must be empty");
 for(const m of cloudMigrations){
  if("onlineSql" in m){for(const sql of m.onlineSql)await c.query(sql);}else await c.query(m.sql);
  await c.query("INSERT INTO schema_migrations(id,name) VALUES($1,$2) ON CONFLICT DO NOTHING",[m.id,m.name]);
 }
 console.log("Production migrations applied to the isolated queue test database");
} finally {await c.end();}
