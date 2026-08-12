#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";

import {
  DEEP_RESEARCH_SKILL_MIGRATION,
  ORG_CAPABILITIES_MIGRATION,
  PERSONAL_CAPABILITIES_MIGRATION,
  SKILL_PACKAGE_FILES_MIGRATION,
  TENANT_CONTEXT_SQL,
} from "../../../packages/db/src/index.ts";
import { recoverSkill } from "../src/backfill-skill-packages.ts";

const adminUrl = requiredLoopbackUrl("BERRY_INTEGRATION_ADMIN_DATABASE_URL");
const databaseName = `berry_skill_packages_${randomUUID().replaceAll("-", "")}`;
const admin = new Pool({ connectionString: adminUrl });
const databaseUrl = new URL(adminUrl);
databaseUrl.pathname = `/${databaseName}`;

const ids = {
  tenantA: "20000000-0000-7000-8000-000000000001",
  tenantB: "20000000-0000-7000-8000-000000000002",
  userA: "20000000-0000-7000-8000-000000000011",
  fileA: "20000000-0000-7000-8000-000000000021",
  blobA: "20000000-0000-7000-8000-000000000031",
};
const personalSingleId = "skill_single_file";
const personalBackfillId = "skill_backfill";
const orgResearchId = "orgcap_research";
const orgConflictResearchId = "orgcap_conflict_research";
const orgConflictDeepId = "orgcap_conflict_deep";
const originalTemplate = Buffer.from("existing-template-bytes");
const occupiedRecoveredPath = Buffer.from("occupied-recovered-path");
const recoveredTemplate = Buffer.from("recovered-template-bytes");
const legacyInputPath = `/workspace/inputs/${ids.fileA}/template.docx`;

let database;
try {
  await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
  database = new Pool({ connectionString: databaseUrl.toString() });
  await bootstrapLegacySkillSchema(database);
  await seedLegacySkills(database);

  const beforePackageMigration = await skillSnapshot(database);
  await applySql(database, SKILL_PACKAGE_FILES_MIGRATION);
  assert.deepEqual(await skillSnapshot(database), beforePackageMigration, "migration 50 must preserve old single-file skill rows");
  assert.equal(await scalar(database, "SELECT count(*)::int FROM personal_skill_files"), 0);
  assert.equal(await scalar(database, "SELECT count(*)::int FROM organization_skill_files"), 0);
  await verifyPackageTableRls(database);

  await seedPackageFilesAndBackfillFixture(database);
  await verifyBackfill(database);
  await verifyDeepResearchMigration(database);
  await verifyIdempotency(database);

  console.log("[integration] skill package migrations preserve legacy skills, retain resources, rename deep research safely, and backfill task-scoped files without path collisions");
} finally {
  await database?.end().catch(() => undefined);
  await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`).catch(() => undefined);
  await admin.end();
}

async function bootstrapLegacySkillSchema(pool) {
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE TABLE tenants (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      slug text NOT NULL UNIQUE,
      deleted_at timestamptz
    );
    ${TENANT_CONTEXT_SQL};
    ${PERSONAL_CAPABILITIES_MIGRATION};
    ${ORG_CAPABILITIES_MIGRATION};
    CREATE TABLE file_blobs (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      bucket text NOT NULL,
      object_key text NOT NULL,
      object_version_id text,
      size_bytes bigint NOT NULL,
      verification_status text NOT NULL DEFAULT 'verified',
      deleted_at timestamptz
    );
    CREATE TABLE files (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      owner_user_id uuid,
      blob_id uuid REFERENCES file_blobs(id),
      display_name text NOT NULL,
      bucket text NOT NULL,
      object_key text NOT NULL,
      object_version_id text,
      size_bytes bigint NOT NULL,
      status text NOT NULL,
      deleted_at timestamptz
    );
  `);
}

async function seedLegacySkills(pool) {
  const singleContent = skillMarkdown("single-file", "An old instructions-only skill", "Keep working.");
  const researchContent = skillMarkdown("research", "Search many sources for every question", "Use the retained guide.\r\n", "\r\n");
  const conflictResearch = skillMarkdown("research", "Legacy broad research", "Legacy body.");
  const conflictDeep = skillMarkdown("deep-research", "Existing explicit deep research", "Existing body.");
  await pool.query(
    `INSERT INTO tenants (id,name,slug) VALUES
       ($1::uuid,'Skill tenant A','skill-migration-a'),
       ($2::uuid,'Skill tenant B','skill-migration-b')`,
    [ids.tenantA, ids.tenantB],
  );
  await pool.query(
    `INSERT INTO personal_skills (
       id,tenant_id,user_id,name,description,content,enabled,trusted,source,hash
     ) VALUES ($1,$2::uuid,$3,'single-file','An old instructions-only skill',$4,true,true,'text',$5)`,
    [personalSingleId, ids.tenantA, ids.userA, singleContent, packageHash(singleContent, [])],
  );
  await pool.query(
    `INSERT INTO organization_capabilities (
       id,tenant_id,kind,capability_id,name,description,assignment,allow_user_disable,content_hash,config
     ) VALUES
       ($1,$4::uuid,'skill','research','research','Search many sources for every question','default-on',true,$6,jsonb_build_object('content',$7::text)),
       ($2,$5::uuid,'skill','research','research','Legacy broad research','default-on',true,$8,jsonb_build_object('content',$9::text)),
       ($3,$5::uuid,'skill','deep-research','deep-research','Existing explicit deep research','available',true,$10,jsonb_build_object('content',$11::text))`,
    [
      orgResearchId,
      orgConflictResearchId,
      orgConflictDeepId,
      ids.tenantA,
      ids.tenantB,
      packageHash(researchContent, []),
      researchContent,
      packageHash(conflictResearch, []),
      conflictResearch,
      packageHash(conflictDeep, []),
      conflictDeep,
    ],
  );
  await pool.query(
    `INSERT INTO capability_user_overrides (tenant_id,user_id,kind,capability_id,enabled)
     VALUES ($1::uuid,$2,'skill','research',false)`,
    [ids.tenantA, ids.userA],
  );
}

async function seedPackageFilesAndBackfillFixture(pool) {
  const researchGuide = Buffer.from("research-guide");
  await insertOrganizationFile(pool, ids.tenantA, orgResearchId, "references/guide.md", researchGuide);
  await insertOrganizationFile(pool, ids.tenantB, orgConflictResearchId, "references/legacy.md", Buffer.from("legacy"));
  await insertOrganizationFile(pool, ids.tenantB, orgConflictDeepId, "references/deep.md", Buffer.from("deep"));

  const backfillContent = skillMarkdown("memo", "Create a memo from the retained template", `Open ${legacyInputPath}.`);
  await pool.query(
    `INSERT INTO personal_skills (
       id,tenant_id,user_id,name,description,content,enabled,trusted,source,hash
     ) VALUES ($1,$2::uuid,$3,'memo','Create a memo from the retained template',$4,true,true,'text',$5)`,
    [personalBackfillId, ids.tenantA, ids.userA, backfillContent, packageHash(backfillContent, [])],
  );
  await insertPersonalFile(pool, ids.tenantA, personalBackfillId, "assets/templates/template.docx", originalTemplate);
  await insertPersonalFile(pool, ids.tenantA, personalBackfillId, `assets/templates/${ids.fileA}-template.docx`, occupiedRecoveredPath);
  await pool.query(
    `INSERT INTO file_blobs (
       id,tenant_id,bucket,object_key,object_version_id,size_bytes
     ) VALUES ($1::uuid,$2::uuid,'canonical-bucket','canonical/template.docx','canonical-version',$3)`,
    [ids.blobA, ids.tenantA, recoveredTemplate.byteLength],
  );
  await pool.query(
    `INSERT INTO files (
       id,tenant_id,owner_user_id,blob_id,display_name,bucket,object_key,size_bytes,status
     ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'template.docx','stale-bucket','stale/template.docx',1,'available')`,
    [ids.fileA, ids.tenantA, ids.userA, ids.blobA],
  );
}

async function verifyBackfill(pool) {
  const client = await pool.connect();
  const skill = {
    kind: "personal",
    id: personalBackfillId,
    tenant_id: ids.tenantA,
    user_id: ids.userA,
    name: "memo",
    content: skillMarkdown("memo", "Create a memo from the retained template", `Open ${legacyInputPath}.`),
  };
  let objectReads = 0;
  const s3 = {
    send: async (command) => {
      objectReads += 1;
      assert.equal(command.input.Bucket, "canonical-bucket");
      assert.equal(command.input.Key, "canonical/template.docx");
      assert.equal(command.input.VersionId, "canonical-version");
      return { Body: { transformToByteArray: async () => recoveredTemplate } };
    },
  };
  try {
    await client.query("BEGIN");
    await client.query("SELECT berry_set_tenant_id($1::uuid)", [ids.tenantA]);
    const audit = await recoverSkill(client, s3, skill, false);
    assert.deepEqual(audit, { recovered: 1, unresolved: 0, oversized: false });
    assert.equal(await scalarClient(client, "SELECT count(*)::int FROM personal_skill_files WHERE skill_id=$1", [personalBackfillId]), 2, "audit mode must not write files");
    assert.equal(objectReads, 0, "audit mode must not read object bodies");

    const applied = await recoverSkill(client, s3, skill, true);
    assert.deepEqual(applied, { recovered: 1, unresolved: 0, oversized: false });
    assert.equal(objectReads, 1, "apply mode must read each recovered object exactly once");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  const rows = (await pool.query(
    "SELECT path,content FROM personal_skill_files WHERE skill_id=$1 ORDER BY path COLLATE \"C\"",
    [personalBackfillId],
  )).rows;
  assert.deepEqual(rows.map((row) => row.path), [
    `assets/templates/${ids.fileA}-2-template.docx`,
    `assets/templates/${ids.fileA}-template.docx`,
    "assets/templates/template.docx",
  ]);
  assert.deepEqual(Buffer.from(rows[0].content), recoveredTemplate);
  assert.deepEqual(Buffer.from(rows[1].content), occupiedRecoveredPath);
  assert.deepEqual(Buffer.from(rows[2].content), originalTemplate);
  const [saved] = (await pool.query("SELECT content,hash FROM personal_skills WHERE id=$1", [personalBackfillId])).rows;
  assert.match(saved.content, new RegExp(`assets/templates/${ids.fileA}-2-template\\.docx`));
  assert.doesNotMatch(saved.content, /\/workspace\/inputs\//);
  assert.equal(saved.hash, packageHash(saved.content, rows));
}

async function verifyDeepResearchMigration(pool) {
  const originalSingle = (await pool.query("SELECT * FROM personal_skills WHERE id=$1", [personalSingleId])).rows[0];
  const researchFileBefore = await scalar(pool, "SELECT count(*)::int FROM organization_skill_files WHERE organization_capability_id=$1", [orgResearchId]);
  await applySql(pool, DEEP_RESEARCH_SKILL_MIGRATION);

  const [migrated] = (await pool.query("SELECT * FROM organization_capabilities WHERE id=$1", [orgResearchId])).rows;
  assert.equal(migrated.capability_id, "deep-research");
  assert.equal(migrated.name, "deep-research");
  assert.equal(migrated.description, "Conduct deep, extensive, multi-source research only when explicitly requested.");
  assert.match(migrated.config.content, /\r?\nname: deep-research\r?\n/);
  assert.match(migrated.config.content, /\r?\ndescription: Conduct deep, extensive, multi-source research only when explicitly requested\.\r?\n/);
  const migratedFiles = (await pool.query(
    "SELECT path,content FROM organization_skill_files WHERE organization_capability_id=$1 ORDER BY path COLLATE \"C\"",
    [orgResearchId],
  )).rows;
  assert.equal(migratedFiles.length, researchFileBefore);
  assert.equal(migrated.content_hash, packageHash(migrated.config.content, migratedFiles));
  assert.equal(await scalar(pool, "SELECT count(*)::int FROM capability_user_overrides WHERE tenant_id=$1::uuid AND capability_id='research'", [ids.tenantA]), 0);
  assert.equal(await scalar(pool, "SELECT count(*)::int FROM capability_user_overrides WHERE tenant_id=$1::uuid AND capability_id='deep-research' AND enabled=false", [ids.tenantA]), 1);

  const [blockedLegacy] = (await pool.query("SELECT assignment,capability_id FROM organization_capabilities WHERE id=$1", [orgConflictResearchId])).rows;
  const [existingDeep] = (await pool.query("SELECT assignment,capability_id FROM organization_capabilities WHERE id=$1", [orgConflictDeepId])).rows;
  assert.deepEqual(blockedLegacy, { assignment: "blocked", capability_id: "research" });
  assert.deepEqual(existingDeep, { assignment: "available", capability_id: "deep-research" });
  assert.equal(await scalar(pool, "SELECT count(*)::int FROM organization_skill_files WHERE organization_capability_id IN ($1,$2)", [orgConflictResearchId, orgConflictDeepId]), 2);
  assert.deepEqual((await pool.query("SELECT * FROM personal_skills WHERE id=$1", [personalSingleId])).rows[0], originalSingle, "migration 52 must not alter personal or old single-file skills");
}

async function verifyPackageTableRls(pool) {
  const result = await pool.query(
    `SELECT relname,relrowsecurity,relforcerowsecurity
     FROM pg_class
     WHERE relname IN ('personal_skill_files','organization_skill_files')
     ORDER BY relname`,
  );
  assert.equal(result.rows.length, 2);
  assert.ok(result.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity));
}

async function verifyIdempotency(pool) {
  const beforeSkills = await skillSnapshot(pool);
  const beforePersonalFiles = await packageFileSnapshot(pool, "personal_skill_files", "skill_id");
  const beforeOrganizationFiles = await packageFileSnapshot(pool, "organization_skill_files", "organization_capability_id");
  await applySql(pool, SKILL_PACKAGE_FILES_MIGRATION);
  await applySql(pool, DEEP_RESEARCH_SKILL_MIGRATION);
  assert.deepEqual(await skillSnapshot(pool), beforeSkills);
  assert.deepEqual(await packageFileSnapshot(pool, "personal_skill_files", "skill_id"), beforePersonalFiles);
  assert.deepEqual(await packageFileSnapshot(pool, "organization_skill_files", "organization_capability_id"), beforeOrganizationFiles);
}

async function applySql(pool, sql) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function insertPersonalFile(pool, tenantId, skillId, path, content) {
  await pool.query(
    "INSERT INTO personal_skill_files (tenant_id,skill_id,path,content,size_bytes,sha256,mode) VALUES ($1::uuid,$2,$3,$4,$5,$6,420)",
    [tenantId, skillId, path, content, content.byteLength, sha256(content)],
  );
}

async function insertOrganizationFile(pool, tenantId, skillId, path, content) {
  await pool.query(
    "INSERT INTO organization_skill_files (tenant_id,organization_capability_id,path,content,size_bytes,sha256,mode) VALUES ($1::uuid,$2,$3,$4,$5,$6,420)",
    [tenantId, skillId, path, content, content.byteLength, sha256(content)],
  );
}

async function skillSnapshot(pool) {
  const personal = (await pool.query("SELECT id,tenant_id::text,user_id,name,content,hash FROM personal_skills ORDER BY id")).rows;
  const organization = (await pool.query("SELECT id,tenant_id::text,capability_id,name,description,assignment,content_hash,config FROM organization_capabilities ORDER BY id")).rows;
  const overrides = (await pool.query("SELECT tenant_id::text,user_id,kind,capability_id,enabled FROM capability_user_overrides ORDER BY tenant_id,user_id,kind,capability_id")).rows;
  return { personal, organization, overrides };
}

async function packageFileSnapshot(pool, table, ownerColumn) {
  if (!new Set(["personal_skill_files", "organization_skill_files"]).has(table)) throw new Error("Unsafe table");
  if (!new Set(["skill_id", "organization_capability_id"]).has(ownerColumn)) throw new Error("Unsafe owner column");
  return (await pool.query(`SELECT tenant_id::text,${ownerColumn},path,encode(content,'base64') AS content,mode FROM ${table} ORDER BY ${ownerColumn},path COLLATE "C"`)).rows;
}

function packageHash(content, files) {
  const hash = createHash("sha256").update("SKILL.md\0").update(content);
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update("\0").update(file.path).update("\0").update(Buffer.from(file.content));
  }
  return hash.digest("hex");
}

function skillMarkdown(name, description, body, newline = "\n") {
  return ["---", `name: ${name}`, `description: ${description}`, "---", body].join(newline);
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function scalar(pool, sql, params = []) {
  const result = await pool.query(sql, params);
  return Object.values(result.rows[0] ?? {})[0];
}

async function scalarClient(client, sql, params = []) {
  const result = await client.query(sql, params);
  return Object.values(result.rows[0] ?? {})[0];
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
    throw new Error(`${name} must target an isolated loopback test database`);
  }
  return value;
}

function quoteIdentifier(value) {
  if (!/^[a-z0-9_]+$/.test(value)) throw new Error("Unsafe temporary database name");
  return `"${value}"`;
}
