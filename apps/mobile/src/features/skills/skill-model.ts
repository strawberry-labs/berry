import { BerryApiError, type BerryApiClient } from "@berry/api-client";
import { PERSONAL_SKILL_PACKAGE_MAX_BYTES, type EffectiveCapability, type PersonalSkill, type SkillPackageFile } from "@berry/shared";

/** Ported from apps/web/src/components/management/personal-skills-screen.tsx. */

export type SkillCatalogRow = {
  key: string;
  capabilityId: string;
  name: string;
  description: string;
  content: string | null;
  enabled: boolean;
  locked: boolean;
  provenance: "organization" | "personal" | "self-host-bootstrap";
  assignment: EffectiveCapability["assignment"];
  reason: EffectiveCapability["reason"] | "deployment";
  packageFiles: string[];
  packageStorage: "stored" | "managed" | "definition-only";
  packageBytes: number;
  personal?: PersonalSkill | undefined;
};

export type DeployedSkill = { id: string; name: string; description: string; content?: string | undefined; enabled: boolean };
export type SkillResource = { personal: PersonalSkill[]; effective: EffectiveCapability[] };

/** Personal skills always load; organization metadata is optional for members without access. */
export async function loadPersonalSkillResource(
  client: Pick<BerryApiClient, "listPersonalSkills" | "effectiveCapabilities">,
  tenantId: string | null,
): Promise<SkillResource> {
  const [personal, effective] = await Promise.all([
    client.listPersonalSkills(),
    tenantId
      ? client.effectiveCapabilities(tenantId).catch((cause: unknown) => {
        if (cause instanceof BerryApiError && cause.status === 403) return [];
        throw cause;
      })
      : Promise.resolve([] as EffectiveCapability[]),
  ]);
  return { personal, effective };
}

export async function loadSkillPackageForDownload(
  client: Pick<BerryApiClient, "personalSkillPackage" | "organizationSkillPackage">,
  tenantId: string | null,
  skill: Pick<SkillCatalogRow, "capabilityId" | "content" | "personal" | "provenance">,
): Promise<{ content: string; resourceFiles: SkillPackageFile[] }> {
  if (!skill.content) throw new Error("This skill has no downloadable content");
  if (skill.personal) return client.personalSkillPackage(skill.personal.id);
  if (skill.provenance === "organization" && tenantId) return client.organizationSkillPackage(tenantId, skill.capabilityId);
  return { content: skill.content, resourceFiles: [] };
}

export function buildSkillRows(personal: PersonalSkill[], effective: EffectiveCapability[], deployed: DeployedSkill[]): SkillCatalogRow[] {
  const rows = new Map<string, SkillCatalogRow>();
  const deployedByName = new Map(deployed.map((item) => [item.name.replace(/^\$/, "").toLowerCase(), item]));
  for (const item of effective.filter((entry) => entry.kind === "skill" && entry.provenance === "organization")) {
    rows.set(item.name.toLowerCase(), {
      key: `organization:${item.capabilityId}`,
      capabilityId: item.capabilityId,
      name: item.name,
      description: item.description?.trim() || deployedByName.get(item.name.toLowerCase())?.description || "Managed by your organization",
      content: item.content ?? null,
      enabled: item.enabled,
      locked: item.locked,
      provenance: "organization",
      assignment: item.assignment,
      reason: item.reason,
      packageFiles: item.packageFiles ?? [],
      packageStorage: item.packageStorage ?? "definition-only",
      packageBytes: item.packageBytes ?? 0,
    });
  }
  for (const item of personal) {
    rows.set(item.name.toLowerCase(), {
      key: `personal:${item.id}`,
      capabilityId: item.id,
      name: item.name,
      description: item.description,
      content: item.content,
      enabled: item.enabled,
      locked: false,
      provenance: "personal",
      assignment: null,
      reason: "personal",
      packageFiles: item.resources,
      packageStorage: item.resources.length > 0 ? "stored" : "definition-only",
      packageBytes: item.packageBytes,
      personal: item,
    });
  }
  for (const item of deployed) {
    const key = item.name.replace(/^\$/, "").toLowerCase();
    if (!isManagedSkillDuplicate(item.name, effective) && !rows.has(key)) {
      rows.set(key, {
        key: `deployment:${item.id}`,
        capabilityId: item.id,
        name: item.name.replace(/^\$/, ""),
        description: item.description,
        content: item.content ?? null,
        enabled: item.enabled,
        locked: true,
        provenance: "self-host-bootstrap",
        assignment: null,
        reason: "deployment",
        packageFiles: [],
        packageStorage: "definition-only",
        packageBytes: item.content ? new TextEncoder().encode(item.content).byteLength : 0,
      });
    }
  }
  return [...rows.values()].sort((a, b) => a.provenance.localeCompare(b.provenance) || a.name.localeCompare(b.name));
}

export function isManagedSkillDuplicate(deployedName: string, effective: EffectiveCapability[]): boolean {
  const key = deployedName.replace(/^\$/, "").toLowerCase();
  return effective.some((item) => item.kind === "skill" && item.provenance === "organization" && item.capabilityId.replace(/^\$/, "").toLowerCase() === key);
}

export function filterSkillRows(rows: SkillCatalogRow[], query: string): SkillCatalogRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((skill) => `${skill.name} ${skill.description}`.toLowerCase().includes(needle));
}

export function skillControlHint(skill: Pick<SkillCatalogRow, "enabled" | "locked" | "personal">, hasClient = true): string {
  if (!hasClient) return "Connect to Berry to change this setting";
  if (skill.locked) return skill.enabled ? "Required by your organization" : "Disabled by your organization";
  return skill.enabled ? "On" : "Off";
}

export function skillDisplayName(name: string): string {
  return name.startsWith("$") ? name : `$${name}`;
}

export function skillProviderLabel(skill: Pick<SkillCatalogRow, "provenance">): string {
  return skill.provenance === "organization" ? "Organization" : skill.provenance === "personal" ? "You" : "Deployment";
}

export function skillProviderPhrase(skill: Pick<SkillCatalogRow, "provenance">): string {
  return skill.provenance === "organization" ? "your organization" : skill.provenance === "personal" ? "you" : "this deployment";
}

/** The policy pill: "default on", "required", or the effective reason. */
export function skillPolicyLabel(skill: Pick<SkillCatalogRow, "assignment" | "reason">): string {
  return skill.assignment ? skill.assignment.replace("-", " ") : skill.reason;
}

/** The web's info tooltip copy. */
export function skillAboutLabel(skill: Pick<SkillCatalogRow, "assignment" | "reason">): string {
  return skill.assignment ? `${skill.assignment.replace("-", " ")} organization skill` : `${skill.reason.replace("-", " ")} skill`;
}

export type SkillTreeEntry = { kind: "folder" | "file"; name: string; path: string; depth: number };

export function skillPackageTreeEntries(paths: readonly string[]): SkillTreeEntry[] {
  type FolderNode = { folders: Map<string, FolderNode>; files: Map<string, string> };
  const root: FolderNode = { folders: new Map(), files: new Map() };
  for (const rawPath of paths) {
    const path = rawPath.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
    if (!path) continue;
    const parts = path.split("/");
    const fileName = parts.pop()!;
    let folder = root;
    for (const part of parts) {
      let child = folder.folders.get(part);
      if (!child) {
        child = { folders: new Map(), files: new Map() };
        folder.folders.set(part, child);
      }
      folder = child;
    }
    folder.files.set(fileName, path);
  }
  const entries: SkillTreeEntry[] = [];
  const visit = (node: FolderNode, parentPath: string, depth: number) => {
    for (const [name, path] of [...node.files].sort(([left], [right]) => {
      if (left === "SKILL.md") return -1;
      if (right === "SKILL.md") return 1;
      return left.localeCompare(right);
    })) entries.push({ kind: "file", name, path, depth });
    for (const [name, child] of [...node.folders].sort(([left], [right]) => left.localeCompare(right))) {
      const path = parentPath ? `${parentPath}/${name}` : name;
      entries.push({ kind: "folder", name, path, depth });
      visit(child, path, depth + 1);
    }
  };
  visit(root, "", 0);
  return entries;
}

export function skillPackagePaths(packageFiles: readonly string[], loaded: readonly { path: string }[]): string[] {
  return ["SKILL.md", ...new Set([...packageFiles, ...loaded.map((file) => file.path)].filter((path) => path !== "SKILL.md"))];
}

export function skillMarkdownBody(content: string): string {
  const normalized = content.replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("---\n")) return normalized;
  const delimiter = normalized.indexOf("\n---\n", 4);
  if (delimiter < 0) return normalized;
  return normalized.slice(delimiter + 5).trimStart();
}

const TEXT_FILE = /\.(md|txt|json|ya?ml|toml|csv|py|js|jsx|ts|tsx|sh|bash|css|html?|xml|sql)$/i;
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|avif|svg)$/i;

export function isTextSkillFile(path: string): boolean {
  return TEXT_FILE.test(path);
}

export function isPreviewableSkillFile(path: string): boolean {
  return TEXT_FILE.test(path) || IMAGE_FILE.test(path);
}

export function skillImageMediaType(path: string): string | null {
  const extension = path.split(".").at(-1)?.toLowerCase();
  // SVG stays out: the phone renders bundled images natively, without a sandboxed browser.
  return ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif" } as Record<string, string>)[extension ?? ""] ?? null;
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function decodeSkillTextFile(file: { path: string; contentBase64: string }): string | null {
  if (!isTextSkillFile(file.path)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(base64ToBytes(file.contentBase64));
  } catch {
    return null;
  }
}

export function base64ByteLength(value: string): number {
  if (!value) return 0;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return value.length * 3 / 4 - padding;
}

export function formatSkillBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function safeSkillFileStem(name: string): string {
  return name
    .trim()
    .replace(/\.skill$/i, "")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 120) || "skill";
}

/** The import dialog's file checks, with the same limits and copy as the web. */
export function validateSkillImportFile(name: string, size: number | null): string | null {
  if (!/\.(skill|zip|md)$/i.test(name)) return "Choose a .skill, .zip, or SKILL.md file.";
  if (size !== null && size > PERSONAL_SKILL_PACKAGE_MAX_BYTES) return "Skill packages can be up to 500 MB.";
  if (/\.md$/i.test(name) && size !== null && size > 256 * 1024) return "SKILL.md instructions can be up to 256 KB. Put larger resources in a .skill package.";
  return null;
}

/** The home composer reads this key like the web's berry.web.pendingPrompt ("Try in a task"). */
export { PENDING_PROMPT_KEY } from "../composer/pending-prompt";

export function tryInTaskPrompt(skill: Pick<SkillCatalogRow, "capabilityId">): string {
  return `$${skill.capabilityId} `;
}
