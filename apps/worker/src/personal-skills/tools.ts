import { createHash } from "node:crypto";
import { formatSkillInvocation } from "@berry/harness";
import {
  DEFERRED_SKILL_RESOURCE_INSTRUCTIONS,
  parseAdmittedRuntimeRequest,
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
  SkillStagingTransfer,
  TurnToolResult,
} from "../turn-runner.js";
import { SKILL_DEPENDENCY_MANIFEST_PATH, parseSkillDependencyManifest, siblingImportPaths } from "./dependencies.js";

type StoredSkill = { name: string; description: string; content: string; filePath: string; resources?: string[] };
type StoredPackage = {
  skill: StoredSkill;
  recordId: string;
  table: "personal_skill_files" | "organization_skill_files";
  foreignKey: "skill_id" | "organization_capability_id";
  rows: ReadonlyArray<{ path: string; size_bytes: number; sha256: string; mode: number }>;
};
type StagedDependency = { skill: string; location: string; directory: string; stagedResources: string[]; resources: string[] };

const MAX_DEPENDENCY_DEPTH = 3;

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

  async modelContent(
    snapshot: DurableTurnSnapshot,
    signal?: AbortSignal,
    reportProgress?: () => void,
  ): Promise<readonly ChatContentPart[]> {
    return this.base.modelContent?.(snapshot, signal, reportProgress) ?? [];
  }

  async stageAssociatedInputFiles(
    snapshot: DurableTurnSnapshot,
    fileIds: readonly string[],
    options?: { signal?: AbortSignal | undefined; reportProgress?: (() => void) | undefined },
  ) {
    return this.base.stageAssociatedInputFiles?.(snapshot, fileIds, options) ?? [];
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
        repeatPolicy: "block_after_success",
        requiresApproval: false,
        approvalKind: "file-edit",
      };
    }
    return this.base.policy?.(snapshot, toolName, permissionMode);
  }

  supportsAbort(snapshot: DurableTurnSnapshot, step: DurableTurnStep): boolean {
    const toolName = stringValue(step.input.toolName) ?? step.type.slice(5);
    if (toolName === "activate_skill") return true;
    if (toolName === "save_personal_skill") return false;
    return this.base.supportsAbort?.(snapshot, step) === true;
  }

  async execute(
    snapshot: DurableTurnSnapshot,
    step: DurableTurnStep,
    signal?: AbortSignal,
    reportProgress?: () => void,
  ): Promise<TurnToolResult> {
    const toolName = stringValue(step.input.toolName) ?? step.type.slice(5);
    if (toolName === "activate_skill") return this.activateSkill(snapshot, step, { signal, reportProgress });
    if (DIRECT_FILE_TOOLS.has(toolName)) {
      this.rejectKnownDeferredResourceForDirectFileTool(snapshot, step);
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
          domainVerification: "unverified",
          resources: packageFiles.filter((file) => file.path !== "SKILL.md").map((file) => file.path),
        },
        note: `${ASSISTANT_SAVED_SKILL_NOTE} Tell the user, and for legal, tax, payroll or safety rules state the jurisdiction, effective date and primary source in SKILL.md.`,
      },
      summary: `Saved $${metadata.name} to the current user's Skills library with ${packageFiles.length - 1} resource file${packageFiles.length === 2 ? "" : "s"}; its domain rules are not independently verified`,
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
) VALUES ($1,$2::uuid,$3,$4,$5,$6,true,true,'text',NULL,$7,$8,$9::jsonb,now(),now())
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
  diagnostics=EXCLUDED.diagnostics,
  updated_at=now()
WHERE personal_skills.tenant_id=EXCLUDED.tenant_id AND personal_skills.user_id=EXCLUDED.user_id
      `.trim(),
      [id, snapshot.tenantId, snapshot.userId, metadata.name, metadata.description, content, metadata.version, hash, JSON.stringify([ASSISTANT_SAVED_SKILL_NOTE])],
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

  private async activateSkill(
    snapshot: DurableTurnSnapshot,
    step: DurableTurnStep,
    options: { signal?: AbortSignal | undefined; reportProgress?: (() => void) | undefined } = {},
  ): Promise<TurnToolResult> {
    const runtime = parseAdmittedRuntimeRequest(snapshot.runtimeRequest);
    if (!runtime) throw new Error("Stored skills are available only to turns admitted with a capability snapshot");
    const parsedInput = ActivateStoredSkillInputSchema.safeParse(step.input.arguments ?? {});
    if (!parsedInput.success) {
      throw new Error("activate_skill requires a valid skill name and, when loading files, an optional resources array of exact relative paths");
    }
    const requestedName = parsedInput.data.name;
    const requestedResources = [...new Set(parsedInput.data.resources ?? [])];
    const skill = runtime.extraSkills.find((candidate) => candidate.name === requestedName);
    if (!skill || !/^\/(personal|organization)-skills\//.test(skill.filePath)) {
      const available = runtime.extraSkills
        .filter((candidate) => !candidate.disableModelInvocation && /^\/(personal|organization)-skills\//.test(candidate.filePath))
        .map((candidate) => candidate.name);
      throw new Error(`Unknown stored skill: ${requestedName ?? "(missing)"}. Use one exact name from: ${available.join(", ") || "(no skills are installed)"}.`);
    }
    const previousActivation = [...snapshot.steps].reverse().find((candidate) => candidate.id !== step.id
      && candidate.state === "completed"
      && (stringValue(candidate.input.toolName) ?? candidate.type.slice(5)) === "activate_skill"
      && stringValue((candidate.input.arguments as Record<string, unknown> | undefined)?.name) === skill.name);

    const alreadyActive = previousActivation !== undefined;
    if (requestedResources.length === 0) {
      const prior = reusableActivationState(previousActivation?.output, skill, snapshot.sandboxId);
      if (prior) {
        return renderActivationResult(skill, {
          ...prior,
          alreadyActive: true,
          requestedResources,
        });
      }
    }

    const personalId = /^\/personal-skills\/([^/]+)\/SKILL\.md$/.exec(skill.filePath)?.[1];
    const organizationId = /^\/organization-skills\/([^/]+)\/SKILL\.md$/.exec(skill.filePath)?.[1];
    options.signal?.throwIfAborted();
    const caution = personalId ? await this.unverifiedSkillCaution(snapshot.tenantId, personalId) : undefined;
    const rows = await this.inTenant(snapshot.tenantId, (executor) => personalId
      ? executor.query<{ path: string; size_bytes: number; sha256: string; mode: number }>("SELECT path,size_bytes,sha256,mode FROM personal_skill_files WHERE skill_id=$1 ORDER BY path", [personalId])
      : executor.query<{ path: string; size_bytes: number; sha256: string; mode: number }>("SELECT path,size_bytes,sha256,mode FROM organization_skill_files WHERE organization_capability_id=$1 ORDER BY path", [organizationId]));
    options.signal?.throwIfAborted();
    const packageRecordId = personalId ?? organizationId!;
    const packageTable = personalId ? "personal_skill_files" : "organization_skill_files";
    const packageForeignKey = personalId ? "skill_id" : "organization_capability_id";
    const availableResources = rows.map((row) => row.path);
    const unknownResources = requestedResources.filter((path) => !availableResources.includes(path));
    if (unknownResources.length > 0) {
      throw new Error([
        `Unknown ${skill.name} resource${unknownResources.length === 1 ? "" : "s"}: ${unknownResources.join(", ")}.`,
        "Resource paths belong to exactly one skill package. Do not retry this activation with the same resource.",
        "Activate the skill that lists the resource, then use the exact directory returned by that activation.",
      ].join(" "));
    }
    if (requestedResources.length === 0) {
      return renderActivationResult(skill, {
        alreadyActive,
        requestedResources,
        location: skill.filePath,
        availableResources,
        deferredResources: availableResources,
        stagedRelativeResources: [],
        stagedResourcePaths: [],
        caution,
      });
    }

    const stagedPackage = await this.stageStoredSkill(snapshot, runtime.extraSkills, {
      skill,
      recordId: packageRecordId,
      table: packageTable,
      foreignKey: packageForeignKey,
      rows,
    }, requestedResources, options, new Set([skill.name]), 0);
    const staged = stagedPackage.staged;
    const skillDirectory = staged.filePath.slice(0, -"/SKILL.md".length);
    const stagedResourcePaths = staged.stagedResources;
    const stagedPathSet = new Set(stagedResourcePaths);
    const stagedRelativeResources = availableResources.filter((path) =>
      stagedPathSet.has(`${skillDirectory}/${path}`)
    );
    const stagedRelativeSet = new Set(stagedRelativeResources);
    const deferredResources = availableResources.filter((path) => !stagedRelativeSet.has(path));
    return renderActivationResult(skill, {
      alreadyActive,
      requestedResources,
      location: staged.filePath,
      availableResources,
      deferredResources,
      stagedRelativeResources,
      stagedResourcePaths,
      stagingSandboxId: staged.stagingSandboxId,
      addedResources: stagedPackage.addedResources,
      dependencies: stagedPackage.dependencies,
      transfer: stagedPackage.transfer,
      caution,
    });
  }

  /** The save-time caution for an assistant-saved personal skill, while it is still recorded (H-045). */
  private async unverifiedSkillCaution(tenantId: string, skillId: string): Promise<string | undefined> {
    const rows = await this.inTenant(tenantId, (executor) => executor.query<{ diagnostics: unknown }>(
      "SELECT diagnostics FROM personal_skills WHERE id=$1",
      [skillId],
    ));
    const diagnostics = rows[0]?.diagnostics;
    return Array.isArray(diagnostics) && diagnostics.includes(ASSISTANT_SAVED_SKILL_NOTE) ? ASSISTANT_SAVED_SKILL_NOTE : undefined;
  }

  /**
   * Stage the requested resources of one stored package together with what
   * those entry points need to run: Python sibling imports (transitively) and
   * resources declared in skill-dependencies.json, including resources of other
   * skills admitted to this run. Large optional assets are never added unless
   * an entry point declares them required.
   */
  private async stageStoredSkill(
    snapshot: DurableTurnSnapshot,
    admittedSkills: readonly StoredSkill[],
    pkg: StoredPackage,
    requestedResources: readonly string[],
    options: { signal?: AbortSignal | undefined; reportProgress?: (() => void) | undefined },
    visited: Set<string>,
    depth: number,
  ): Promise<{
    staged: Awaited<ReturnType<NonNullable<DurableTurnToolExecutor["stageSkillPackage"]>>>;
    addedResources: string[];
    dependencies: StagedDependency[];
    transfer: SkillStagingTransfer;
  }> {
    if (!this.base.stageSkillPackage) throw new Error("Skill package workspace access is unavailable");
    const loadedBytes = new Map<string, Uint8Array>();
    const loadContentBytes = async (paths: readonly string[]): Promise<ReadonlyMap<string, Uint8Array>> => {
      const needed = paths.filter((path) => !loadedBytes.has(path));
      if (needed.length > 0) {
        const loaded = await this.inTenant(snapshot.tenantId, (executor) => executor.query<{ path: string; content: Buffer }>(
          `SELECT path,content FROM ${pkg.table} WHERE ${pkg.foreignKey}=$1 AND path=ANY($2::text[])`,
          [pkg.recordId, [...needed]],
        ));
        options.signal?.throwIfAborted();
        for (const row of loaded) loadedBytes.set(row.path, row.content);
      }
      const missing = paths.filter((path) => !loadedBytes.has(path));
      if (missing.length > 0) throw new Error(`Stored skill resource is missing: ${missing.join(", ")}`);
      return new Map(paths.map((path) => [path, loadedBytes.get(path)!]));
    };

    const available = new Set(pkg.rows.map((row) => row.path));
    const manifest = available.has(SKILL_DEPENDENCY_MANIFEST_PATH)
      ? parseSkillDependencyManifest((await loadContentBytes([SKILL_DEPENDENCY_MANIFEST_PATH])).get(SKILL_DEPENDENCY_MANIFEST_PATH)!)
      : null;
    const selected = new Set(requestedResources);
    const crossSkill = new Map<string, Set<string>>();
    let frontier = [...requestedResources];
    while (frontier.length > 0) {
      const scripts = frontier.filter((path) => path.endsWith(".py"));
      const sources = scripts.length > 0 ? await loadContentBytes(scripts) : new Map<string, Uint8Array>();
      const next: string[] = [];
      const add = (path: string) => {
        if (selected.has(path)) return;
        selected.add(path);
        next.push(path);
      };
      for (const path of frontier) {
        for (const requirement of manifest?.entryPoints[path]?.requires ?? []) {
          if (!requirement.skill || requirement.skill === pkg.skill.name) {
            const missing = requirement.resources.filter((resource) => !available.has(resource));
            if (missing.length > 0) {
              throw new Error(`${pkg.skill.name} declares ${missing.join(", ")} as required by ${path}, but the published package does not contain ${missing.length === 1 ? "it" : "them"}. Republish the skill package; do not create the file yourself.`);
            }
            requirement.resources.forEach(add);
          } else {
            const resources = crossSkill.get(requirement.skill) ?? new Set<string>();
            requirement.resources.forEach((resource) => resources.add(resource));
            crossSkill.set(requirement.skill, resources);
          }
        }
        const source = sources.get(path);
        if (source) siblingImportPaths(path, Buffer.from(source).toString("utf8"), available).forEach(add);
      }
      frontier = next;
    }

    const staged = await this.base.stageSkillPackage(
      snapshot,
      pkg.recordId,
      [
        { path: "SKILL.md", contentBytes: Buffer.from(pkg.skill.content, "utf8"), mode: 0o644 },
        ...pkg.rows.map((row) => ({ path: row.path, sizeBytes: Number(row.size_bytes), sha256: row.sha256, mode: row.mode })),
      ],
      { resourcePaths: [...selected], loadContentBytes, signal: options.signal, reportProgress: options.reportProgress },
    );
    const transfer: SkillStagingTransfer = { ...(staged.transfer ?? { files: 0, bytes: 0, reusedFiles: 0, reusedBytes: 0 }) };
    const dependencies: StagedDependency[] = [];
    for (const [name, resources] of crossSkill) {
      if (visited.has(name) || depth >= MAX_DEPENDENCY_DEPTH) {
        throw new Error(`Skill dependencies form a cycle or exceed ${MAX_DEPENDENCY_DEPTH} levels at ${name}. Republish the skill packages with a direct dependency.`);
      }
      const dependency = admittedSkills.find((candidate) => candidate.name === name
        && /^\/(personal|organization)-skills\//.test(candidate.filePath));
      if (!dependency) {
        throw new Error(`${pkg.skill.name} requires the ${name} skill (${[...resources].join(", ")}), which is not available to this task. Ask an administrator to enable ${name}; retrying will not help.`);
      }
      const dependencyPackage = await this.loadStoredPackage(snapshot, dependency, options.signal);
      const unknown = [...resources].filter((resource) => !dependencyPackage.rows.some((row) => row.path === resource));
      if (unknown.length > 0) {
        throw new Error(`${pkg.skill.name} requires ${unknown.join(", ")} from ${name}, but that package does not contain ${unknown.length === 1 ? "it" : "them"}. Republish the skill packages.`);
      }
      const result = await this.stageStoredSkill(snapshot, admittedSkills, dependencyPackage, [...resources], options, new Set([...visited, name]), depth + 1);
      const directory = result.staged.filePath.slice(0, -"/SKILL.md".length);
      dependencies.push({
        skill: name,
        location: result.staged.filePath,
        directory,
        stagedResources: result.staged.stagedResources,
        resources: [...resources, ...result.addedResources],
      }, ...result.dependencies);
      transfer.files += result.transfer.files;
      transfer.bytes += result.transfer.bytes;
      transfer.reusedFiles += result.transfer.reusedFiles;
      transfer.reusedBytes += result.transfer.reusedBytes;
    }
    return {
      staged,
      addedResources: [...selected].filter((path) => !requestedResources.includes(path)),
      dependencies,
      transfer,
    };
  }

  private async loadStoredPackage(snapshot: DurableTurnSnapshot, skill: StoredSkill, signal?: AbortSignal): Promise<StoredPackage> {
    const personalId = /^\/personal-skills\/([^/]+)\/SKILL\.md$/.exec(skill.filePath)?.[1];
    const organizationId = /^\/organization-skills\/([^/]+)\/SKILL\.md$/.exec(skill.filePath)?.[1];
    if (!personalId && !organizationId) throw new Error(`Unknown stored skill: ${skill.name}`);
    const rows = await this.inTenant(snapshot.tenantId, (executor) => personalId
      ? executor.query<{ path: string; size_bytes: number; sha256: string; mode: number }>("SELECT path,size_bytes,sha256,mode FROM personal_skill_files WHERE skill_id=$1 ORDER BY path", [personalId])
      : executor.query<{ path: string; size_bytes: number; sha256: string; mode: number }>("SELECT path,size_bytes,sha256,mode FROM organization_skill_files WHERE organization_capability_id=$1 ORDER BY path", [organizationId]));
    signal?.throwIfAborted();
    return personalId
      ? { skill, recordId: personalId, table: "personal_skill_files", foreignKey: "skill_id", rows }
      : { skill, recordId: organizationId!, table: "organization_skill_files", foreignKey: "organization_capability_id", rows };
  }

  private rejectKnownDeferredResourceForDirectFileTool(
    snapshot: DurableTurnSnapshot,
    step: DurableTurnStep,
  ): void {
    const input = step.input.arguments as Record<string, unknown> | undefined;
    const requestedPath = stringValue(input?.path);
    if (!requestedPath) return;
    const known = knownDeferredSkillResource(snapshot, requestedPath);
    if (!known) return;
    throw new ResourceNotStagedError(
      known.skill,
      known.relativePath,
      `Call activate_skill with ${JSON.stringify({ name: known.skill, resources: [known.relativePath] })} before reading this deferred resource`,
    );
  }

  private async inTenant<T>(tenantId: string, operation: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    if (!this.executor.runWithTenant) return operation(this.executor);
    return this.executor.runWithTenant(tenantId, () => operation(this.executor));
  }
}

/**
 * Recorded in personal_skills.diagnostics when the assistant saves a skill:
 * the package is valid and trusted to run, but nobody has checked its domain
 * rules (H-045). A user re-uploading a reviewed package replaces it.
 */
export const ASSISTANT_SAVED_SKILL_NOTE = "Saved by the assistant: its domain rules (laws, rates, thresholds, formulas) have not been independently verified. Check them against primary sources before relying on its results.";

export class ResourceNotStagedError extends Error {
  readonly code = "RESOURCE_NOT_STAGED";

  constructor(skill: string, resource: string, detail: string) {
    super(`RESOURCE_NOT_STAGED: ${skill}/${resource}: ${detail}`);
    this.name = "ResourceNotStagedError";
  }
}

interface SkillActivationState {
  alreadyActive: boolean;
  requestedResources: readonly string[];
  location: string;
  availableResources: string[];
  deferredResources: string[];
  stagedRelativeResources: string[];
  stagedResourcePaths: string[];
  stagingSandboxId?: string | undefined;
  /** Same-package files staged because a requested entry point needs them. */
  addedResources?: string[] | undefined;
  /** Other skill packages staged because a requested entry point declares them. */
  dependencies?: StagedDependency[] | undefined;
  transfer?: SkillStagingTransfer | undefined;
  /** Shown before the instructions when the skill's domain rules are unverified (H-045). */
  caution?: string | undefined;
}

function renderActivationResult(skill: {
  name: string;
  description: string;
  content: string;
  filePath: string;
  resources?: string[];
}, state: SkillActivationState): TurnToolResult {
  const directory = skillDirectoryFromLocation(state.location);
  if (!directory) throw new Error(`Stored skill activation has an invalid location: ${state.location}`);
  const activeSkill = { ...skill, filePath: state.location, resources: state.availableResources };
  const resourceState = formatSkillResourceState({
    name: skill.name,
    location: state.location,
    directory,
    stagedRelativeResources: state.stagedRelativeResources,
    stagedResourcePaths: state.stagedResourcePaths,
    deferredResources: state.deferredResources,
  });
  const invocation = state.alreadyActive
    ? `<skill_already_active name=${JSON.stringify(skill.name)} />`
    : formatSkillInvocation(activeSkill, state.requestedResources.length > 0
        ? `The requested resource files are materialized under ${directory}. Use only the exact paths needed for this task.`
        : "Load only resources required for the current task.");
  const dependencyState = formatResolvedDependencies(state.addedResources ?? [], state.dependencies ?? []);
  const caution = state.caution ? `<skill_caution>${state.caution}</skill_caution>\n` : "";
  const content = `${caution}${invocation}\n${resourceState}\n${dependencyState ? `${dependencyState}\n` : ""}${DEFERRED_SKILL_RESOURCE_INSTRUCTIONS}`;
  const summary = state.requestedResources.length > 0
    ? `Loaded ${state.requestedResources.length} ${skill.name} resource file${state.requestedResources.length === 1 ? "" : "s"}`
    : `Activated ${skill.name}; ${state.availableResources.length} resource file${state.availableResources.length === 1 ? "" : "s"} available on demand`;
  return {
    output: {
      skill: skill.name,
      alreadyActive: state.alreadyActive,
      location: state.location,
      directory,
      availableResources: state.availableResources,
      deferredResources: state.deferredResources,
      stagedRelativeResources: state.stagedRelativeResources,
      stagedResources: state.stagedResourcePaths,
      stagedResourcePaths: state.stagedResourcePaths,
      ...(state.stagingSandboxId === undefined ? {} : { stagingSandboxId: state.stagingSandboxId }),
      ...(state.addedResources?.length ? { addedResources: state.addedResources } : {}),
      ...(state.caution ? { domainVerification: "unverified" } : {}),
      ...(state.dependencies?.length ? { dependencies: state.dependencies } : {}),
      ...(state.requestedResources.length > 0 ? { readiness: "ready" } : {}),
      ...(state.transfer ? { transfer: state.transfer } : {}),
      content,
    },
    summary,
  };
}

/** Tell the model exactly which extra files are ready and where, so it never has to guess. */
function formatResolvedDependencies(addedResources: readonly string[], dependencies: readonly StagedDependency[]): string {
  if (addedResources.length === 0 && dependencies.length === 0) return "";
  return [
    "<resolved_dependencies ready=\"true\">",
    ...(addedResources.length > 0
      ? [`  Also staged in this skill because the requested entry points import or require them: ${addedResources.join(", ")}`]
      : []),
    ...dependencies.map((dependency) =>
      `  <skill name=${JSON.stringify(dependency.skill)} directory=${JSON.stringify(dependency.directory)} resources=${JSON.stringify(dependency.resources.join(", "))} />`),
    ...(dependencies.length > 0
      ? ["  Use each listed directory as that skill's directory (for example a --<skill>-skill-dir argument). Do not copy these files or search for them."]
      : []),
    "</resolved_dependencies>",
  ].join("\n");
}

function reusableActivationState(
  output: unknown,
  skill: { name: string; filePath: string; resources?: string[] },
  currentSandboxId: string | null | undefined,
): Omit<SkillActivationState, "alreadyActive" | "requestedResources"> | null {
  const value = record(output);
  if (!value || stringValue(value.skill) !== skill.name) return null;
  const availableResources = stringArray(value.availableResources);
  const runtimeResources = relativeRuntimeSkillResources(skill);
  if (!runtimeResources || !sameStringSet(availableResources, runtimeResources)) return null;
  const stagingSandboxId = stringValue(value.stagingSandboxId) ?? undefined;
  if (stagingSandboxId !== undefined && stagingSandboxId !== currentSandboxId) {
    return {
      location: skill.filePath,
      availableResources,
      deferredResources: availableResources,
      stagedRelativeResources: [],
      stagedResourcePaths: [],
      stagingSandboxId: undefined,
    };
  }
  const location = stringValue(value.location);
  const directory = skillDirectoryFromLocation(location);
  if (!location || !directory || !trustedSkillLocation(location, skill.filePath)) return null;
  const deferredResources = stringArray(value.deferredResources);
  const stagedRelativeResources = stringArray(value.stagedRelativeResources);
  const stagedResourcePaths = stringArray(value.stagedResourcePaths ?? value.stagedResources);
  if (stagingSandboxId === undefined && (stagedRelativeResources.length > 0 || stagedResourcePaths.length > 0)) return null;
  if (deferredResources.some((path) => !availableResources.includes(path))) return null;
  if (stagedRelativeResources.some((path) => !availableResources.includes(path))) return null;
  if (stagedResourcePaths.some((path) => !stagedRelativeResources.includes(path.slice(directory.length + 1)) || path !== `${directory}/${path.slice(directory.length + 1)}`)) return null;
  return {
    location,
    availableResources,
    deferredResources,
    stagedRelativeResources,
    stagedResourcePaths,
    stagingSandboxId,
  };
}

function trustedSkillLocation(location: string, storedLocation: string): boolean {
  if (location === storedLocation) return true;
  const directory = skillDirectoryFromLocation(location);
  return directory !== null && /^\/(?:[^/]+\/)*runtime-skills\/[A-Za-z0-9._-]+-[a-f0-9]{16}$/.test(directory);
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const normalize = (values: readonly string[]) => [...new Set(values)].sort();
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function relativeRuntimeSkillResources(skill: { filePath: string; resources?: string[] }): string[] | null {
  const directory = skillDirectoryFromLocation(skill.filePath);
  if (!directory) return null;
  const prefix = `${directory}/`;
  const relativeResources: string[] = [];
  for (const absolutePath of skill.resources ?? []) {
    if (!absolutePath.startsWith(prefix)) return null;
    const relativePath = absolutePath.slice(prefix.length);
    const parts = relativePath.split("/");
    if (
      !relativePath
      || relativePath.length > 512
      || relativePath.includes("\\")
      || relativePath.includes("\0")
      || parts.some((part) => !part || part === "." || part === "..")
    ) return null;
    relativeResources.push(relativePath);
  }
  return relativeResources;
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
    const stagingSandboxId = stringValue(output?.stagingSandboxId);
    const stagingStateIsCurrent = stagingSandboxId !== null && stagingSandboxId === snapshot.sandboxId;
    const stagedResources = new Set(stagingStateIsCurrent ? [
      ...stringArray(output?.stagedResources),
      ...stringArray(output?.stagedResourcePaths),
    ] : []);
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
