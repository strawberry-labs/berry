import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Pool, type PoolClient } from "pg";
import {
  legacyInputReferences,
  legacyInputSourcePath,
  missingLegacyRelativePackageReferences,
  replaceLegacyInputPath,
  safeLegacyInputFileName,
  uniqueRecoveredPackagePath,
} from "./skill-package-backfill.js";
import { s3ClientOptions } from "./storage/s3-client-options.js";

const MAX_PACKAGE_BYTES = 5 * 1024 * 1024;

export type LegacySkill = {
  kind: "personal" | "organization";
  id: string;
  tenant_id: string;
  user_id: string | null;
  name: string;
  content: string;
  snapshot_hash: string | null;
};

type StoredFile = {
  id: string;
  owner_user_id: string | null;
  display_name: string;
  bucket: string;
  object_key: string;
  object_version_id: string | null;
  size_bytes: number;
  status: string;
};

type PackageFile = { path: string; content: Buffer; mode: number };

export function backfillS3ClientOptions(env: NodeJS.ProcessEnv = process.env) {
  return s3ClientOptions({
    endpoint: env.BERRY_ARTIFACT_S3_ENDPOINT,
    region: env.BERRY_ARTIFACT_S3_REGION ?? env.AWS_REGION,
    accessKeyId: env.BERRY_ARTIFACT_S3_ACCESS_KEY_ID,
    secretAccessKey: env.BERRY_ARTIFACT_S3_SECRET_ACCESS_KEY,
  });
}

export async function main(): Promise<void> {
  const databaseUrl = process.env.BERRY_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("BERRY_DATABASE_URL or DATABASE_URL is required");
  const apply = process.argv.includes("--apply");
  const pool = new Pool({ connectionString: databaseUrl });
  const s3 = new S3Client(backfillS3ClientOptions());
  const totals = {
    scanned: 0,
    candidates: 0,
    recovered: 0,
    unresolved: 0,
    oversized: 0,
    manualReuploadSkills: 0,
    manualReuploadReferences: 0,
  };
  try {
    const tenants = await pool.query<{ id: string }>("SELECT id::text FROM tenants WHERE deleted_at IS NULL ORDER BY id");
    for (const tenant of tenants.rows) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT berry_set_tenant_id($1::uuid)", [tenant.id]);
        const result = await client.query<LegacySkill>(`
          SELECT 'personal'::text AS kind,id,tenant_id::text,user_id,name,content,hash AS snapshot_hash
          FROM personal_skills
          UNION ALL
          SELECT 'organization'::text AS kind,id,tenant_id::text,NULL::text AS user_id,name,config->>'content' AS content,content_hash AS snapshot_hash
          FROM organization_capabilities
          WHERE kind='skill' AND config->>'content' IS NOT NULL
          ORDER BY kind,name
        `);
        totals.scanned += result.rows.length;
        for (const skill of result.rows) {
          const existingPaths = new Set((await existingPackageFiles(client, skill)).map((file) => file.path));
          const missingRelativeResources = missingLegacyRelativePackageReferences(skill.content, existingPaths);
          if (missingRelativeResources.length > 0) {
            totals.manualReuploadSkills += 1;
            totals.manualReuploadReferences += missingRelativeResources.length;
            console.warn(JSON.stringify({
              skill: skill.name,
              skillId: skill.id,
              kind: skill.kind,
              status: "manual-reupload-required",
              reason: "legacy-browser-import-did-not-retain-resource-bytes",
              missingResources: missingRelativeResources,
            }));
          }
          if (legacyInputReferences(skill.content).length === 0) continue;
          totals.candidates += 1;
          const recovered = await recoverSkill(client, s3, skill, apply);
          totals.recovered += recovered.recovered;
          totals.unresolved += recovered.unresolved;
          totals.oversized += recovered.oversized ? 1 : 0;
        }
        if (apply) await client.query("COMMIT");
        else await client.query("ROLLBACK");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
  } finally {
    s3.destroy();
    await pool.end();
  }
  console.log(JSON.stringify({ mode: apply ? "apply" : "audit", ...totals }));
}

export async function recoverSkill(client: PoolClient, s3: Pick<S3Client, "send">, skill: LegacySkill, apply: boolean): Promise<{ recovered: number; unresolved: number; oversized: boolean }> {
  const references = legacyInputReferences(skill.content);
  const replacements = new Map<string, { path: string; file: StoredFile }>();
  const existing = await existingPackageFiles(client, skill);
  const usedPaths = new Set(existing.map((file) => file.path));
  let unresolved = 0;
  for (const reference of references) {
    const fileId = reference.fileId;
    const rows = await client.query<StoredFile>(`
      SELECT f.id::text,f.owner_user_id::text,f.display_name,
        CASE WHEN f.blob_id IS NOT NULL THEN blob.bucket ELSE f.bucket END AS bucket,
        CASE WHEN f.blob_id IS NOT NULL THEN blob.object_key ELSE f.object_key END AS object_key,
        CASE WHEN f.blob_id IS NOT NULL THEN blob.object_version_id ELSE f.object_version_id END AS object_version_id,
        CASE WHEN f.blob_id IS NOT NULL THEN blob.size_bytes ELSE f.size_bytes END AS size_bytes,
        f.status
      FROM files f
      LEFT JOIN file_blobs blob ON blob.id=f.blob_id AND blob.tenant_id=f.tenant_id
      WHERE f.id=$1::uuid AND f.deleted_at IS NULL
        AND (
          f.blob_id IS NULL OR (
            blob.id IS NOT NULL AND blob.deleted_at IS NULL
            AND blob.verification_status <> 'deleted'
          )
        )
      LIMIT 1
    `, [fileId]);
    const file = rows.rows[0];
    if (!file || file.status !== "available" || (skill.kind === "personal" && file.owner_user_id !== skill.user_id)) {
      unresolved += 1;
      console.warn(JSON.stringify({ skill: skill.name, skillId: skill.id, referenceFileId: fileId, status: "unresolved" }));
      continue;
    }
    const baseName = safeLegacyInputFileName(file.display_name || file.id);
    const sourcePath = legacyInputSourcePath(reference, baseName);
    if (!skill.content.includes(sourcePath)) {
      unresolved += 1;
      console.warn(JSON.stringify({ skill: skill.name, skillId: skill.id, referenceFileId: fileId, status: "path-mismatch" }));
      continue;
    }
    const folder = /\.(docx|dotx|pptx|potx|xlsx|xltx)$/i.test(baseName) ? "assets/templates" : "assets/recovered";
    const path = uniqueRecoveredPackagePath(folder, baseName, file.id, usedPaths);
    replacements.set(sourcePath, { path, file });
  }
  if (replacements.size === 0) return { recovered: 0, unresolved, oversized: false };
  const content = [...replacements.entries()].reduce(
    (current, [source, target]) => replaceLegacyInputPath(current, source, target.path),
    skill.content,
  );
  const projectedPackageBytes = Buffer.byteLength(content)
    + existing.reduce((total, file) => total + file.content.byteLength, 0)
    + [...replacements.values()].reduce((total, target) => total + Number(target.file.size_bytes), 0);
  if (projectedPackageBytes > MAX_PACKAGE_BYTES) {
    console.warn(JSON.stringify({ skill: skill.name, skillId: skill.id, status: "oversized", packageBytes: projectedPackageBytes }));
    return { recovered: 0, unresolved, oversized: true };
  }
  if (!apply) return { recovered: replacements.size, unresolved, oversized: false };

  const additions: PackageFile[] = [];
  for (const { path, file } of replacements.values()) {
    if (existing.some((entry) => entry.path === path)) continue;
    const response = await s3.send(new GetObjectCommand({ Bucket: file.bucket, Key: file.object_key, ...(file.object_version_id ? { VersionId: file.object_version_id } : {}) }));
    const bytes = Buffer.from(await response.Body!.transformToByteArray());
    if (bytes.byteLength !== Number(file.size_bytes)) throw new Error(`Stored file size mismatch for ${file.id}`);
    additions.push({ path, content: bytes, mode: path.startsWith("scripts/") ? 0o755 : 0o644 });
  }
  const packageFiles = [...existing, ...additions];
  const packageBytes = Buffer.byteLength(content) + packageFiles.reduce((total, file) => total + file.content.byteLength, 0);
  if (packageBytes > MAX_PACKAGE_BYTES) {
    console.warn(JSON.stringify({ skill: skill.name, skillId: skill.id, status: "oversized", packageBytes }));
    return { recovered: 0, unresolved, oversized: true };
  }
  const hash = hashPackage(content, packageFiles);
  if (skill.kind === "personal") {
    const updated = await client.query(
      "UPDATE personal_skills SET content=$2,hash=$3,updated_at=now() WHERE id=$1 AND content=$4 AND hash IS NOT DISTINCT FROM $5::text",
      [skill.id, content, hash, skill.content, skill.snapshot_hash],
    );
    assertSkillSnapshotUnchanged(updated.rowCount, skill);
    for (const file of additions) await insertPersonalFile(client, skill, file);
  } else {
    const updated = await client.query(
      "UPDATE organization_capabilities SET config=jsonb_set(jsonb_set(config,'{content}',to_jsonb($2::text),true),'{packageStorageVersion}','1'::jsonb,true),content_hash=$3,updated_at=now() WHERE id=$1 AND config->>'content'=$4 AND content_hash IS NOT DISTINCT FROM $5::text",
      [skill.id, content, hash, skill.content, skill.snapshot_hash],
    );
    assertSkillSnapshotUnchanged(updated.rowCount, skill);
    for (const file of additions) await insertOrganizationFile(client, skill, file);
  }
  console.log(JSON.stringify({ skill: skill.name, skillId: skill.id, status: "recovered", files: additions.map((file) => file.path) }));
  return { recovered: additions.length, unresolved, oversized: false };
}

export async function existingPackageFiles(client: PoolClient, skill: LegacySkill): Promise<PackageFile[]> {
  const table = skill.kind === "personal" ? "personal_skill_files" : "organization_skill_files";
  const key = skill.kind === "personal" ? "skill_id" : "organization_capability_id";
  const rows = await client.query<{ path: string; content: Buffer; mode: number }>(`SELECT path,content,mode FROM ${table} WHERE ${key}=$1 ORDER BY path`, [skill.id]);
  return rows.rows.map((row) => ({ path: row.path, content: Buffer.from(row.content), mode: row.mode }));
}

async function insertPersonalFile(client: PoolClient, skill: LegacySkill, file: PackageFile): Promise<void> {
  const inserted = await client.query("INSERT INTO personal_skill_files (tenant_id,skill_id,path,content,size_bytes,sha256,mode) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7) ON CONFLICT (skill_id,path) DO NOTHING", [skill.tenant_id,skill.id,file.path,file.content,file.content.byteLength,sha256(file.content),file.mode]);
  assertSkillSnapshotUnchanged(inserted.rowCount, skill);
}

async function insertOrganizationFile(client: PoolClient, skill: LegacySkill, file: PackageFile): Promise<void> {
  const inserted = await client.query("INSERT INTO organization_skill_files (tenant_id,organization_capability_id,path,content,size_bytes,sha256,mode) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7) ON CONFLICT (organization_capability_id,path) DO NOTHING", [skill.tenant_id,skill.id,file.path,file.content,file.content.byteLength,sha256(file.content),file.mode]);
  assertSkillSnapshotUnchanged(inserted.rowCount, skill);
}

function assertSkillSnapshotUnchanged(rowCount: number | null, skill: LegacySkill): void {
  if (rowCount === 1) return;
  throw new Error(`Skill ${skill.name} (${skill.id}) changed during package recovery; rerun the backfill from a fresh audit`);
}

function hashPackage(content: string, files: readonly PackageFile[]): string {
  const hash = createHash("sha256").update("SKILL.md\0").update(content);
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) hash.update("\0").update(file.path).update("\0").update(file.content);
  return hash.digest("hex");
}

function sha256(content: Buffer): string { return createHash("sha256").update(content).digest("hex"); }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
