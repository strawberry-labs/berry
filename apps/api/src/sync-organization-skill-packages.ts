import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { ORGANIZATION_SKILL_PACKAGE_MAX_BYTES, SKILL_PACKAGE_MAX_FILES, type SkillPackageFile } from "@berry/shared";
import { CloudDatabaseService } from "./db/cloud-database.service.js";
import { PgSqlExecutor } from "./db/pg-executor.js";
import { OrganizationCapabilitiesService } from "./http/organization-capabilities.service.js";
import { PersonalCapabilitiesService } from "./http/personal-capabilities.service.js";

const AESG_SKILLS = ["aesg-branding", "cv-creator", "docx", "pdf", "pptx", "skill-creator", "xlsx"] as const;

export async function syncOrganizationSkillPackages(env: NodeJS.ProcessEnv = process.env, argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const databaseUrl = env.BERRY_DATABASE_URL ?? env.DATABASE_URL;
  if (!databaseUrl) throw new Error("BERRY_DATABASE_URL or DATABASE_URL is required");
  const root = resolve(argument(argv, "--root") ?? "/organization-skill-import");
  const tenantId = argument(argv, "--tenant") ?? env.AESG_TENANT_ID ?? "00000000-0000-7000-8000-000000000001";
  const executor = PgSqlExecutor.fromConnectionString(databaseUrl);
  try {
    const reviewer = new OrganizationCapabilitiesService(new PersonalCapabilitiesService(undefined, env));
    const prepared: Array<{ capabilityId: typeof AESG_SKILLS[number]; skill: Awaited<ReturnType<typeof readOrganizationSkillDirectory>>; review: Awaited<ReturnType<OrganizationCapabilitiesService["reviewSkill"]>> }> = [];
    for (const capabilityId of AESG_SKILLS) {
      const packageRoot = join(root, capabilityId);
      const skill = await readOrganizationSkillDirectory(packageRoot);
      const review = await reviewer.reviewSkill({ ...skill, source: "upload" });
      if (review.name !== capabilityId) throw new Error(`${packageRoot}/SKILL.md declares ${review.name}; expected ${capabilityId}`);
      prepared.push({ capabilityId, skill, review });
    }
    const stored = await executor.transaction(async (transaction) => {
      const database = new CloudDatabaseService(transaction);
      const organizations = new OrganizationCapabilitiesService(new PersonalCapabilitiesService(database, env), database);
      const results = [];
      for (const { capabilityId, skill, review } of prepared) {
        const current = (await organizations.list(tenantId)).find((item) => item.kind === "skill" && item.capabilityId === capabilityId);
        const saved = await organizations.upsert(tenantId, {
          kind: "skill",
          capabilityId,
          name: current?.name ?? review.name,
          description: review.description,
          assignment: current?.assignment ?? "required",
          allowUserDisable: current?.allowUserDisable ?? false,
          contentHash: review.hash,
          config: { content: skill.content, packageStorageVersion: 1 },
          resourceFiles: skill.resourceFiles,
        });
        if (saved.resources.length !== skill.resourceFiles.length || saved.packageBytes !== review.bytes) {
          throw new Error(`Stored package verification failed for ${capabilityId}`);
        }
        results.push(saved);
      }
      return results;
    });
    for (const saved of stored) {
      const capabilityId = saved.capabilityId;
      console.log(JSON.stringify({ capabilityId, files: saved.resources.length + 1, bytes: saved.packageBytes, hash: saved.contentHash }));
    }
  } finally {
    await executor.close();
  }
}

export async function readOrganizationSkillDirectory(root: string): Promise<{ content: string; packageFiles: string[]; resourceFiles: SkillPackageFile[] }> {
  const rootInfo = await stat(root);
  if (!rootInfo.isDirectory()) throw new Error(`Skill package root is not a directory: ${root}`);
  const diskFiles: Array<{ absolutePath: string; path: string }> = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".DS_Store" || entry.name === "__pycache__" || entry.name.endsWith(".pyc")) continue;
      const absolutePath = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Skill packages cannot contain symbolic links: ${absolutePath}`);
      if (entry.isDirectory()) await visit(absolutePath);
      else if (entry.isFile()) diskFiles.push({ absolutePath, path: relative(root, absolutePath).split(sep).join("/") });
    }
  };
  await visit(root);
  if (diskFiles.length === 0 || diskFiles.length > SKILL_PACKAGE_MAX_FILES + 1) throw new Error(`Skill packages must contain SKILL.md and at most ${SKILL_PACKAGE_MAX_FILES} resources`);
  const skillEntry = diskFiles.find((file) => file.path === "SKILL.md");
  if (!skillEntry) throw new Error(`Skill package is missing ${join(root, "SKILL.md")}`);
  const contentBytes = await readFile(skillEntry.absolutePath);
  if (contentBytes.byteLength > 262_144) throw new Error("SKILL.md is limited to 256 KB");
  const content = new TextDecoder("utf-8", { fatal: true }).decode(contentBytes);
  const resourceFiles: SkillPackageFile[] = [];
  let packageBytes = contentBytes.byteLength;
  for (const file of diskFiles.filter((candidate) => candidate !== skillEntry).sort((left, right) => left.path.localeCompare(right.path))) {
    if (!file.path || file.path.length > 512 || file.path.split("/").includes("..")) throw new Error(`Unsafe skill package path: ${file.path}`);
    const bytes = await readFile(file.absolutePath);
    packageBytes += bytes.byteLength;
    if (packageBytes > ORGANIZATION_SKILL_PACKAGE_MAX_BYTES) throw new Error("Organization skill packages are limited to 100 MB extracted");
    resourceFiles.push({ path: file.path, contentBase64: bytes.toString("base64"), mode: file.path.startsWith("scripts/") ? 0o755 : 0o644 });
  }
  return { content, packageFiles: ["SKILL.md", ...resourceFiles.map((file) => file.path)], resourceFiles };
}

function argument(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

if (process.argv[1] && basename(process.argv[1]).startsWith("sync-organization-skill-packages") && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void syncOrganizationSkillPackages().catch((cause) => {
    console.error(cause);
    process.exitCode = 1;
  });
}
