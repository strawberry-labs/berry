import { createHash } from "node:crypto";
import { formatSkillInvocation } from "@berry/harness";
import {
  DEFERRED_SKILL_RESOURCE_INSTRUCTIONS,
  DurableTurnRuntimeRequestSchema,
  parseAgentSkillMarkdown,
} from "@berry/shared";
import type { ChatContentPart, ChatToolDefinition } from "@berry/router-client";
import { z } from "zod";
import type { SqlExecutor } from "../sql-repositories.js";
import type {
  DurableToolPolicy,
  DurableTurnSnapshot,
  DurableTurnStep,
  DurableTurnToolExecutor,
  DurableSkillPackageFile,
  TurnToolResult,
} from "../turn-runner.js";

const SavePersonalSkillInputSchema = z.union([
  z.object({ content: z.string().min(1).max(262_144) }).strict(),
  z.object({ path: z.string().trim().min(1).max(4_096) }).strict(),
]);

const ActivateStoredSkillInputSchema = z.object({
  name: z.string().trim().min(1).max(128),
  resources: z.array(z.string().trim().min(1).max(512)).max(50).optional(),
}).strict();

const DIRECT_FILE_TOOLS = new Set(["read", "grep", "find", "ls"]);

export class DurablePersonalSkillToolExecutor implements DurableTurnToolExecutor {
  constructor(
    private readonly base: DurableTurnToolExecutor,
    private readonly executor: SqlExecutor,
  ) {}

  async definitions(snapshot: DurableTurnSnapshot): Promise<readonly ChatToolDefinition[]> {
    return this.base.definitions?.(snapshot) ?? [];
  }

  async modelContent(snapshot: DurableTurnSnapshot): Promise<readonly ChatContentPart[]> {
    return this.base.modelContent?.(snapshot) ?? [];
  }

  async stageAssociatedInputFiles(snapshot: DurableTurnSnapshot, fileIds: readonly string[]) {
    return this.base.stageAssociatedInputFiles?.(snapshot, fileIds) ?? [];
  }

  async finalize(snapshot: DurableTurnSnapshot): Promise<readonly TurnToolResult[]> {
    return this.base.finalize?.(snapshot) ?? [];
  }

  policy(
    snapshot: DurableTurnSnapshot,
    toolName: string,
    permissionMode: string,
  ): DurableToolPolicy | undefined {
    if (toolName === "save_personal_skill") {
      return {
        retryClass: "idempotent_with_key",
        requiresApproval: false,
        approvalKind: "file-edit",
      };
    }
    return this.base.policy?.(snapshot, toolName, permissionMode);
  }

  async execute(
    snapshot: DurableTurnSnapshot,
    step: DurableTurnStep,
    signal?: AbortSignal,
    reportProgress?: () => void,
  ): Promise<TurnToolResult> {
    const toolName = stringValue(step.input.toolName) ?? step.type.slice(5);
    if (toolName === "activate_skill") return this.activateSkill(snapshot, step);
    if (DIRECT_FILE_TOOLS.has(toolName)) {
      await this.materializeKnownResourceForDirectFileTool(snapshot, step);
    }
    if (toolName !== "save_personal_skill") {
      return signal || reportProgress
        ? this.base.execute(snapshot, step, signal, reportProgress)
        : this.base.execute(snapshot, step);
    }

    const parsedInput = SavePersonalSkillInputSchema.safeParse(step.input.arguments ?? {});
    if (!parsedInput.success) {
      throw new Error(
        "save_personal_skill requires exactly one field: content for an instructions-only skill, or path to a completed skill package directory containing SKILL.md. Never send raw.",
      );
    }
    const input = parsedInput.data;
    let packageFiles = "content" in input
      ? [{ path: "SKILL.md", contentBase64: Buffer.from(input.content, "utf8").toString("base64"), mode: 0o644 }]
      : await this.readWorkspaceSkillPackage(snapshot, step, input.path);
    const skillFile = packageFiles.find((file) => file.path === "SKILL.md");
    if (!skillFile) throw new Error("Skill package is missing SKILL.md at its root");
    const content = skillPackageBytes(skillFile).toString("utf8");
    const metadata = parseAgentSkillMarkdown(content);
    const deterministicId = `skill_${createHash("sha256")
      .update(`${snapshot.tenantId}\0${snapshot.userId}\0${metadata.name}`)
      .digest("hex")
      .slice(0, 40)}`;
    const existing = await this.inTenant(snapshot.tenantId, (executor) => executor.query<{ id: string }>(
      "SELECT id FROM personal_skills WHERE tenant_id=$1::uuid AND user_id=$2 AND name=$3 ORDER BY updated_at DESC LIMIT 1",
      [snapshot.tenantId, snapshot.userId, metadata.name],
    ));
    const id = existing[0]?.id ?? deterministicId;
    if ("content" in input && existing[0]) {
      const resources = await this.inTenant(snapshot.tenantId, (executor) => executor.query<{ path: string; content: Buffer; mode: number }>(
        "SELECT path,content,mode FROM personal_skill_files WHERE skill_id=$1 ORDER BY path",
        [id],
      ));
      packageFiles = [packageFiles[0]!, ...resources.map((row) => ({ path: row.path, contentBytes: row.content, mode: row.mode }))];
    }
    const hash = hashSkillPackage(packageFiles);
    await this.inTenant(snapshot.tenantId, async (executor) => executor.transaction
      ? executor.transaction((transaction) => this.persistSkillPackage(transaction, snapshot, id, metadata, content, hash, packageFiles))
      : this.persistSkillPackage(executor, snapshot, id, metadata, content, hash, packageFiles));
    return {
      output: {
        skill: {
          id,
          name: metadata.name,
          description: metadata.description,
          enabled: true,
          resources: packageFiles.filter((file) => file.path !== "SKILL.md").map((file) => file.path),
        },
      },
      summary: `Saved $${metadata.name} to the current user's Skills library with ${packageFiles.length - 1} resource file${packageFiles.length === 2 ? "" : "s"}`,
    };
  }

  private async persistSkillPackage(
    executor: SqlExecutor,
    snapshot: DurableTurnSnapshot,
    id: string,
    metadata: ReturnType<typeof parseAgentSkillMarkdown>,
    content: string,
    hash: string,
    packageFiles: readonly DurableSkillPackageFile[],
  ): Promise<void> {
    await executor.execute(
      `
INSERT INTO personal_skills (
  id,tenant_id,user_id,name,description,content,enabled,trusted,source,source_url,version,hash,diagnostics,created_at,updated_at
) VALUES ($1,$2::uuid,$3,$4,$5,$6,true,true,'text',NULL,$7,$8,'[]'::jsonb,now(),now())
ON CONFLICT (id) DO UPDATE SET
  name=EXCLUDED.name,
  description=EXCLUDED.description,
  content=EXCLUDED.content,
  enabled=true,
  trusted=true,
  source='text',
  source_url=NULL,
  version=EXCLUDED.version,
  hash=EXCLUDED.hash,
  diagnostics='[]'::jsonb,
  updated_at=now()
WHERE personal_skills.tenant_id=EXCLUDED.tenant_id AND personal_skills.user_id=EXCLUDED.user_id
      `.trim(),
      [id, snapshot.tenantId, snapshot.userId, metadata.name, metadata.description, content, metadata.version, hash],
    );
    await executor.execute("DELETE FROM personal_skill_files WHERE skill_id=$1", [id]);
    const resources = packageFiles.filter((candidate) => candidate.path !== "SKILL.md").map((file) => {
      const bytes = skillPackageBytes(file);
      return { file, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
    });
    if (resources.length > 0) {
      await executor.execute(
        `INSERT INTO personal_skill_files (tenant_id,skill_id,path,content,size_bytes,sha256,mode)
         SELECT $1::uuid,$2,files.path,files.content,files.size_bytes,files.sha256,files.mode
         FROM unnest($3::text[],$4::bytea[],$5::bigint[],$6::text[],$7::int[]) AS files(path,content,size_bytes,sha256,mode)`,
        [
          snapshot.tenantId,
          id,
          resources.map(({ file }) => file.path),
          resources.map(({ bytes }) => bytes),
          resources.map(({ bytes }) => bytes.byteLength),
          resources.map(({ sha256 }) => sha256),
          resources.map(({ file }) => file.mode ?? (file.path.startsWith("scripts/") ? 0o755 : 0o644)),
        ],
      );
    }
  }

  private async readWorkspaceSkillPackage(snapshot: DurableTurnSnapshot, step: DurableTurnStep, path: string): Promise<readonly DurableSkillPackageFile[]> {
    const files = this.base.readSkillPackage
      ? await this.base.readSkillPackage(snapshot, path)
      : await this.readLegacySkillFile(snapshot, step, path);
    const skill = files.find((file) => file.path === "SKILL.md");
    if (!skill || skillPackageBytes(skill).byteLength > 262_144) throw new Error("SKILL.md is missing or exceeds the 256 KiB limit");
    return files;
  }

  private async readLegacySkillFile(snapshot: DurableTurnSnapshot, step: DurableTurnStep, path: string): Promise<readonly DurableSkillPackageFile[]> {
    const result = await this.base.execute(snapshot, {
      ...step,
      type: "tool.read",
      input: { ...step.input, toolName: "read", arguments: { path } },
    });
    const output = result.output && typeof result.output === "object" && !Array.isArray(result.output) ? result.output : null;
    const content = typeof output?.content === "string" ? output.content : null;
    if (!content) throw new Error("The skill path did not resolve to a readable SKILL.md file");
    return [{ path: "SKILL.md", contentBase64: Buffer.from(content, "utf8").toString("base64"), mode: 0o644 }];
  }

  private async activateSkill(snapshot: DurableTurnSnapshot, step: DurableTurnStep): Promise<TurnToolResult> {
    const runtime = DurableTurnRuntimeRequestSchema.parse(snapshot.runtimeRequest);
    const parsedInput = ActivateStoredSkillInputSchema.safeParse(step.input.arguments ?? {});
    if (!parsedInput.success) {
      throw new Error("activate_skill requires a valid skill name and, when loading files, an optional resources array of exact relative paths");
    }
    const requestedName = parsedInput.data.name;
    const requestedResources = [...new Set(parsedInput.data.resources ?? [])];
    const skill = runtime.extraSkills.find((candidate) => candidate.name === requestedName);
    if (!skill || !/^\/(personal|organization)-skills\//.test(skill.filePath)) throw new Error(`Unknown stored skill: ${requestedName ?? "(missing)"}`);
    const alreadyActive = snapshot.steps.some((candidate) => candidate.id !== step.id
      && candidate.state === "completed"
      && (stringValue(candidate.input.toolName) ?? candidate.type.slice(5)) === "activate_skill"
      && stringValue((candidate.input.arguments as Record<string, unknown> | undefined)?.name) === skill.name);

    const personalId = /^\/personal-skills\/([^/]+)\/SKILL\.md$/.exec(skill.filePath)?.[1];
    const organizationId = /^\/organization-skills\/([^/]+)\/SKILL\.md$/.exec(skill.filePath)?.[1];
    const rows = await this.inTenant(snapshot.tenantId, (executor) => personalId
      ? executor.query<{ path: string; size_bytes: number; sha256: string; mode: number }>("SELECT path,size_bytes,sha256,mode FROM personal_skill_files WHERE skill_id=$1 ORDER BY path", [personalId])
      : executor.query<{ path: string; size_bytes: number; sha256: string; mode: number }>("SELECT path,size_bytes,sha256,mode FROM organization_skill_files WHERE organization_capability_id=$1 ORDER BY path", [organizationId]));
    const packageRecordId = personalId ?? organizationId!;
    const packageTable = personalId ? "personal_skill_files" : "organization_skill_files";
    const packageForeignKey = personalId ? "skill_id" : "organization_capability_id";
    const availableResources = rows.map((row) => row.path);
    const unknownResources = requestedResources.filter((path) => !availableResources.includes(path));
    if (unknownResources.length > 0) {
      throw new Error(`Unknown ${skill.name} resource${unknownResources.length === 1 ? "" : "s"}: ${unknownResources.join(", ")}`);
    }
    const files: DurableSkillPackageFile[] = [
      { path: "SKILL.md", contentBytes: Buffer.from(skill.content, "utf8"), mode: 0o644 },
      ...rows.map((row) => ({
        path: row.path,
        sizeBytes: Number(row.size_bytes),
        sha256: row.sha256,
        mode: row.mode,
      })),
    ];
    if (!this.base.stageSkillPackage) throw new Error("Skill package workspace access is unavailable");
    const loadContentBytes = async (paths: readonly string[]): Promise<ReadonlyMap<string, Uint8Array>> => {
      if (paths.length === 0) return new Map();
      const loaded = await this.inTenant(snapshot.tenantId, (executor) => executor.query<{ path: string; content: Buffer }>(
        `SELECT path,content FROM ${packageTable} WHERE ${packageForeignKey}=$1 AND path=ANY($2::text[])`,
        [packageRecordId, [...paths]],
      ));
      const byPath = new Map<string, Uint8Array>(loaded.map((row) => [row.path, row.content]));
      const missing = paths.filter((path) => !byPath.has(path));
      if (missing.length > 0) throw new Error(`Stored skill resource is missing: ${missing.join(", ")}`);
      return byPath;
    };
    const staged = await this.base.stageSkillPackage(
      snapshot,
      personalId ?? organizationId ?? skill.name,
      files,
      { resourcePaths: requestedResources, loadContentBytes },
    );
    const activeSkill = { ...skill, filePath: staged.filePath, resources: availableResources };
    const skillDirectory = staged.filePath.slice(0, -"/SKILL.md".length);
    const stagedResourcePaths = staged.stagedResources;
    const stagedPathSet = new Set(stagedResourcePaths);
    const stagedRelativeResources = availableResources.filter((path) =>
      stagedPathSet.has(`${skillDirectory}/${path}`)
    );
    const stagedRelativeSet = new Set(stagedRelativeResources);
    const deferredResources = availableResources.filter((path) => !stagedRelativeSet.has(path));
    const resourceState = formatSkillResourceState({
      name: skill.name,
      location: staged.filePath,
      directory: skillDirectory,
      stagedRelativeResources,
      stagedResourcePaths,
      deferredResources,
    });
    const invocation = alreadyActive
      ? `<skill_already_active name=${JSON.stringify(skill.name)} />`
      : formatSkillInvocation(activeSkill, requestedResources.length > 0
          ? `The requested resource files are materialized under ${skillDirectory}. Use only the exact paths needed for this task.`
          : "Load only resources required for the current task.");
    const content = `${invocation}\n${resourceState}\n${DEFERRED_SKILL_RESOURCE_INSTRUCTIONS}`;
    const summary = requestedResources.length > 0
      ? `Loaded ${requestedResources.length} ${skill.name} resource file${requestedResources.length === 1 ? "" : "s"}`
      : `Activated ${skill.name}; ${availableResources.length} resource file${availableResources.length === 1 ? "" : "s"} available on demand`;
    return {
      output: {
        skill: skill.name,
        alreadyActive,
        location: staged.filePath,
        directory: skillDirectory,
        availableResources,
        deferredResources,
        stagedRelativeResources,
        stagedResources: stagedResourcePaths,
        stagedResourcePaths,
        stagingSandboxId: staged.stagingSandboxId,
        content,
      },
      summary,
    };
  }

  private async materializeKnownResourceForDirectFileTool(
    snapshot: DurableTurnSnapshot,
    step: DurableTurnStep,
  ): Promise<void> {
    const input = step.input.arguments as Record<string, unknown> | undefined;
    const requestedPath = stringValue(input?.path);
    if (!requestedPath) return;
    const known = knownDeferredSkillResource(snapshot, requestedPath);
    if (!known) return;
    if (!this.base.stageSkillPackage) {
      throw new ResourceNotStagedError(known.skill, known.relativePath, "skill package workspace access is unavailable");
    }
    try {
      await this.activateSkill(snapshot, {
        ...step,
        id: `${step.id}:materialize:${createHash("sha256").update(known.relativePath).digest("hex").slice(0, 12)}`,
        type: "tool.activate_skill",
        input: {
          ...step.input,
          toolName: "activate_skill",
          arguments: { name: known.skill, resources: [known.relativePath] },
        },
      });
    } catch (error) {
      if (error instanceof ResourceNotStagedError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new ResourceNotStagedError(known.skill, known.relativePath, message);
    }
  }

  private async inTenant<T>(tenantId: string, operation: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    if (!this.executor.runWithTenant) return operation(this.executor);
    return this.executor.runWithTenant(tenantId, () => operation(this.executor));
  }
}

export class ResourceNotStagedError extends Error {
  readonly code = "RESOURCE_NOT_STAGED";

  constructor(skill: string, resource: string, detail: string) {
    super(`RESOURCE_NOT_STAGED: ${skill}/${resource}: ${detail}`);
    this.name = "ResourceNotStagedError";
  }
}

function knownDeferredSkillResource(
  snapshot: DurableTurnSnapshot,
  requestedPath: string,
): { skill: string; relativePath: string } | null {
  const activationSteps = snapshot.steps
    .filter((step) => step.state === "completed")
    .sort((left, right) => right.sequence - left.sequence);
  for (const step of activationSteps) {
    if ((stringValue(step.input.toolName) ?? step.type.slice(5)) !== "activate_skill") continue;
    const output = record(step.output);
    const skill = stringValue(output?.skill);
    const directory = stringValue(output?.directory)
      ?? skillDirectoryFromLocation(stringValue(output?.location));
    const availableResources = stringArray(output?.availableResources);
    if (!skill || !directory || availableResources.length === 0) continue;
    const stagedResources = new Set([
      ...stringArray(output?.stagedResources),
      ...stringArray(output?.stagedResourcePaths),
    ]);
    for (const relativePath of availableResources) {
      const absolutePath = `${directory}/${relativePath}`;
      if (requestedPath === absolutePath) {
        return stagedResources.has(absolutePath) ? null : { skill, relativePath };
      }
    }
  }
  return null;
}

function formatSkillResourceState(input: {
  name: string;
  location: string;
  directory: string;
  stagedRelativeResources: readonly string[];
  stagedResourcePaths: readonly string[];
  deferredResources: readonly string[];
}): string {
  const staged = input.stagedRelativeResources.length === 0
    ? "  <staged_resources empty=\"true\" />"
    : input.stagedRelativeResources.map((relativePath) =>
        `    <resource relative=${JSON.stringify(relativePath)} path=${JSON.stringify(input.stagedResourcePaths.find((path) => path === `${input.directory}/${relativePath}`) ?? `${input.directory}/${relativePath}`)} />`
      ).join("\n");
  const deferred = input.deferredResources.length === 0
    ? "  <deferred_resources empty=\"true\" />"
    : input.deferredResources.map((path) => `    <resource relative=${JSON.stringify(path)} />`).join("\n");
  return [
    `<skill_resource_state name=${JSON.stringify(input.name)} location=${JSON.stringify(input.location)} directory=${JSON.stringify(input.directory)}>`,
    ...(input.stagedRelativeResources.length === 0
      ? [staged]
      : ["  <staged_resources>", staged, "  </staged_resources>"]),
    ...(input.deferredResources.length === 0
      ? [deferred]
      : ["  <deferred_resources>", deferred, "  </deferred_resources>"]),
    "</skill_resource_state>",
  ].join("\n");
}

function skillDirectoryFromLocation(location: string | null): string | null {
  return location?.endsWith("/SKILL.md") ? location.slice(0, -"/SKILL.md".length) : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hashSkillPackage(files: readonly DurableSkillPackageFile[]): string {
  const skill = files.find((file) => file.path === "SKILL.md");
  if (!skill) throw new Error("Skill package is missing SKILL.md");
  const hash = createHash("sha256").update("SKILL.md\0").update(skillPackageBytes(skill));
  for (const file of files.filter((candidate) => candidate.path !== "SKILL.md").sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update("\0").update(file.path).update("\0").update(skillPackageBytes(file));
  }
  return hash.digest("hex");
}

function skillPackageBytes(file: DurableSkillPackageFile): Buffer {
  if (file.contentBytes !== undefined) {
    return Buffer.isBuffer(file.contentBytes)
      ? file.contentBytes
      : Buffer.from(file.contentBytes.buffer, file.contentBytes.byteOffset, file.contentBytes.byteLength);
  }
  if (file.contentBase64 !== undefined) return Buffer.from(file.contentBase64, "base64");
  if (file.loadContentBytes) throw new Error(`Skill package content must be loaded before this operation: ${file.path}`);
  throw new Error(`Skill package file has no content: ${file.path}`);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
