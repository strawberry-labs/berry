import { createHash, randomUUID } from "node:crypto";
import { BadRequestException } from "@nestjs/common";
import type { AgentSkill, McpServerSpec } from "@berry/local-agent";
import type { CapabilityUserOverride, EffectiveCapability, JsonValue, OrgCapability, OrgCapabilityAssignment, PersonalSkillPackage, SkillPackageFile } from "@berry/shared";
import type { CloudDatabaseService } from "../db/cloud-database.service.ts";
import { parseAgentSkillMarkdown } from "./agent-skill-content.ts";
import { PersonalCapabilitiesService } from "./personal-capabilities.service.ts";

export const ORGANIZATION_CAPABILITIES = Symbol("ORGANIZATION_CAPABILITIES");
type Upsert = { kind: "skill" | "mcp"; capabilityId: string; name: string; description?: string; assignment: OrgCapabilityAssignment; allowUserDisable?: boolean; config?: JsonValue; contentHash?: string | null; resourceFiles?: SkillPackageFile[] };
type OrgSkillFileMetadata = { path: string; sizeBytes: number };

export class OrganizationCapabilitiesService {
  readonly #records = new Map<string, OrgCapability>();
  readonly #skillFiles = new Map<string, SkillPackageFile[]>();
  readonly #overrides = new Map<string, CapabilityUserOverride & { kind: "skill" | "mcp" }>();
  readonly #settings = new Map<string, { skills: boolean; mcp: boolean }>();
  constructor(private readonly personal: PersonalCapabilitiesService, private readonly database?: CloudDatabaseService) {}

  async list(tenantId: string): Promise<OrgCapability[]> {
    if (!this.database) return [...this.#records.values()].filter((item) => item.tenantId === tenantId);
    const [rows, fileRows] = await Promise.all([
      this.database.withTenant(tenantId, (db) => db.query<Record<string, unknown>>("SELECT * FROM organization_capabilities ORDER BY kind, name")),
      this.database.withTenant(tenantId, (db) => db.query<Record<string, unknown>>("SELECT organization_capability_id,path,size_bytes FROM organization_skill_files ORDER BY organization_capability_id,path")),
    ]);
    const files = groupOrgSkillFiles(fileRows);
    return rows.map((row) => orgRow(row, files.get(String(row.id)) ?? []));
  }
  async upsert(tenantId: string, input: Upsert): Promise<OrgCapability> {
    const current = (await this.list(tenantId)).find((item) => item.kind === input.kind && item.capabilityId === input.capabilityId);
    const now = new Date().toISOString();
    let config = input.config ?? current?.config ?? {};
    let packageFiles = input.resourceFiles;
    if (input.kind === "skill" && input.config !== undefined && packageFiles === undefined && current) {
      packageFiles = (await this.skillPackage(tenantId, current.id)).resourceFiles;
    }
    if (input.kind === "skill" && (packageFiles !== undefined || object(current?.config ?? {}).packageStorageVersion === 1)) {
      config = { ...object(config), packageStorageVersion: 1 };
    }
    let normalizedFiles: SkillPackageFile[] | undefined;
    let reviewedHash: string | undefined;
    if (input.kind === "skill" && input.config !== undefined) {
      const content = object(config).content;
      if (typeof content === "string" && content.trim()) {
        const preview = await this.personal.previewSkill({ content, source: "upload", resourceFiles: packageFiles ?? [], packageFiles: ["SKILL.md", ...(packageFiles ?? []).map((file) => file.path)] });
        reviewedHash = preview.review.hash;
        const metadata = parseAgentSkillMarkdown(preview.content);
        if (metadata.name !== input.capabilityId) throw new BadRequestException(`Organization skill ID must match SKILL.md name (${metadata.name})`);
        normalizedFiles = preview.resourceFiles;
      } else if (input.assignment !== "blocked") {
        throw new BadRequestException("Organization skills require SKILL.md content");
      }
    }
    const hash = input.contentHash !== undefined
      ? input.contentHash
      : reviewedHash
        ? reviewedHash
      : input.config !== undefined && input.kind === "skill"
        ? hashContent(config)
        : current?.contentHash ?? (input.kind === "skill" ? hashContent(config) : null);
    const record: OrgCapability = {
      id: current?.id ?? `orgcap_${randomUUID()}`,
      tenantId,
      kind: input.kind,
      capabilityId: input.capabilityId,
      name: input.name,
      description: input.description ?? current?.description ?? "",
      assignment: input.assignment,
      allowUserDisable: input.allowUserDisable ?? current?.allowUserDisable ?? false,
      contentHash: hash,
      config,
      resources: normalizedFiles?.map((file) => file.path) ?? current?.resources ?? [],
      packageBytes: typeof object(config).content === "string"
        ? Buffer.byteLength(String(object(config).content)) + (normalizedFiles ?? this.#skillFiles.get(current?.id ?? "") ?? []).reduce((total, file) => total + Buffer.from(file.contentBase64, "base64").byteLength, 0)
        : 0,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    this.#records.set(record.id, record);
    if (normalizedFiles) this.#skillFiles.set(record.id, normalizedFiles);
    if (this.database) await this.database.withTenant(tenantId, async (db) => {
      await db.execute(`INSERT INTO organization_capabilities (id,tenant_id,kind,capability_id,name,description,assignment,allow_user_disable,content_hash,config,created_at,updated_at) VALUES ($1,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::timestamptz,$12::timestamptz) ON CONFLICT (tenant_id,kind,capability_id) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,assignment=EXCLUDED.assignment,allow_user_disable=EXCLUDED.allow_user_disable,content_hash=EXCLUDED.content_hash,config=EXCLUDED.config,updated_at=EXCLUDED.updated_at`, [record.id,tenantId,record.kind,record.capabilityId,record.name,record.description,record.assignment,record.allowUserDisable,record.contentHash,JSON.stringify(record.config),record.createdAt,record.updatedAt]);
      if (!normalizedFiles) return;
      await db.execute("DELETE FROM organization_skill_files WHERE organization_capability_id=$1", [record.id]);
      for (const file of normalizedFiles) {
        const content = Buffer.from(file.contentBase64, "base64");
        await db.execute("INSERT INTO organization_skill_files (tenant_id,organization_capability_id,path,content,size_bytes,sha256,mode) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7)", [tenantId,record.id,file.path,content,content.byteLength,createHash("sha256").update(content).digest("hex"),file.mode ?? (file.path.startsWith("scripts/") ? 0o755 : 0o644)]);
      }
    });
    return record;
  }
  async reviewSkill(input: { content?: string | undefined; source?: "text" | "upload" | "git" | undefined; sourceUrl?: string | null | undefined; packageFiles?: string[] | undefined; resourceFiles?: SkillPackageFile[] | undefined }) {
    return (await this.personal.previewSkill(input)).review;
  }
  async skillPackage(tenantId: string, id: string): Promise<PersonalSkillPackage> {
    const record = (await this.list(tenantId)).find((item) => item.kind === "skill" && (item.id === id || item.capabilityId === id));
    if (!record) throw new BadRequestException("Organization skill not found");
    const content = object(record.config).content;
    if (typeof content !== "string" || !content.trim()) throw new BadRequestException("Organization skill has no package content");
    if (!this.database) return { content, resourceFiles: this.#skillFiles.get(record.id) ?? [] };
    const rows = await this.database.withTenant(tenantId, (db) => db.query<Record<string, unknown>>("SELECT path,content,mode FROM organization_skill_files WHERE organization_capability_id=$1 ORDER BY path", [record.id]));
    return { content, resourceFiles: rows.map(orgSkillFileRow) };
  }
  async remove(tenantId: string, id: string) { const record = (await this.list(tenantId)).find((item) => item.id === id); if (!record) return { ok: false }; this.#records.delete(id); if (this.database) await this.database.withTenant(tenantId, (db) => db.execute("DELETE FROM organization_capabilities WHERE id=$1", [id])); return { ok: true }; }
  async settings(tenantId: string) { if (!this.database) return { skills: true, mcp: this.#settings.get(tenantId)?.mcp ?? true }; const rows = await this.database.withTenant(tenantId, (db) => db.query<{ allow_personal_mcp: boolean }>("SELECT allow_personal_mcp FROM organization_capability_settings")); return { skills: true, mcp: rows[0]?.allow_personal_mcp ?? true }; }
  async updateSettings(tenantId: string, value: { skills: boolean; mcp: boolean }) { const next = { skills: true, mcp: value.mcp }; this.#settings.set(tenantId, next); if (this.database) await this.database.withTenant(tenantId, (db) => db.execute("INSERT INTO organization_capability_settings (tenant_id,allow_personal_skills,allow_personal_mcp) VALUES ($1::uuid,true,$2) ON CONFLICT (tenant_id) DO UPDATE SET allow_personal_skills=true,allow_personal_mcp=EXCLUDED.allow_personal_mcp,updated_at=now()", [tenantId,value.mcp])); return next; }
  async setOverride(tenantId: string, userId: string, kind: "skill" | "mcp", capabilityId: string, enabled: boolean) { const row = { tenantId,userId,kind,capabilityId,enabled,updatedAt:new Date().toISOString() }; this.#overrides.set(`${tenantId}:${userId}:${kind}:${capabilityId}`, row); if (this.database) await this.database.withTenant(tenantId, (db) => db.execute("INSERT INTO capability_user_overrides (tenant_id,user_id,kind,capability_id,enabled) VALUES ($1::uuid,$2,$3,$4,$5) ON CONFLICT (tenant_id,user_id,kind,capability_id) DO UPDATE SET enabled=EXCLUDED.enabled,updated_at=now()", [tenantId,userId,kind,capabilityId,enabled])); return row; }
  async managedPolicy(tenantId: string) {
    const [records, personalAdditions] = await Promise.all([this.list(tenantId), this.settings(tenantId)]);
    return {
      personalAdditions,
      capabilityCatalog: records.map((record) => {
        const config = object(record.config);
        return {
          kind: record.kind,
          id: record.capabilityId,
          name: record.name,
          description: record.description,
          hash: record.contentHash,
          assignment: record.assignment,
          ...(record.kind === "skill" && typeof config.content === "string" ? { content: config.content } : {}),
          ...(record.kind === "mcp" && typeof config.url === "string" ? { url: config.url, transport: config.transport === "http-sse" ? "http-sse" as const : "streamable-http" as const } : {}),
        };
      }),
    };
  }
  async effective(tenantId: string, userId: string): Promise<{ rows: EffectiveCapability[]; skills: AgentSkill[]; mcpServers: McpServerSpec[] }> {
    const [org, personal, settings, overrides] = await Promise.all([this.list(tenantId), this.personal.runtime(tenantId,userId), this.settings(tenantId), this.#listOverrides(tenantId,userId)]);
    const rows: EffectiveCapability[] = []; const skills: AgentSkill[] = []; const mcpServers: McpServerSpec[] = [];
    for (const item of org) {
      const override = overrides.find((entry) => entry.kind === item.kind && entry.capabilityId === item.capabilityId);
      const userCanChange = item.assignment === "available" || item.assignment === "default-on" && item.allowUserDisable;
      const enabled = item.assignment === "required" || item.assignment === "default-on" && !(userCanChange && override?.enabled === false) || item.assignment === "available" && override?.enabled === true;
      const reason: EffectiveCapability["reason"] = item.assignment === "blocked" ? "blocked" : item.assignment === "required" ? "required" : userCanChange && override?.enabled === false ? "user-disabled" : userCanChange && override?.enabled === true ? "user-enabled" : item.assignment === "default-on" ? "default" : "available";
      const config = object(item.config);
      rows.push({
        kind:item.kind,capabilityId:item.capabilityId,name:item.name,description:item.description,
        enabled:enabled && item.assignment !== "blocked",locked:!userCanChange,assignment:item.assignment,
        provenance:"organization",reason,contentHash:item.contentHash,
        ...(item.kind === "skill" && item.assignment !== "blocked" && typeof config.content === "string" ? { content: config.content } : {}),
      });
      if (!enabled || item.assignment === "blocked") continue;
      if (item.kind === "skill") {
        const content = typeof config.content === "string" ? config.content : "";
        if (content) {
          const metadata = parseAgentSkillMarkdown(content);
          skills.push({
            name: metadata.name,
            description: metadata.description,
            content,
            filePath: item.resources.length > 0 || config.packageStorageVersion === 1 ? `/organization-skills/${item.id}/SKILL.md` : `/managed-skills/${item.capabilityId}/SKILL.md`,
            scope: "registered",
            disableModelInvocation: false,
            resources: item.resources.map((path) => `/organization-skills/${item.id}/${path}`),
          });
        }
      }
      else { const config = object(item.config); if (typeof config.url === "string") mcpServers.push({ id:item.capabilityId,name:item.name,transport:config.transport === "http-sse" ? "http-sse" : "streamable-http",command:null,args:[],url:config.url,env:{},enabled:true,trusted:true,credentialKey:typeof config.credentialRef === "string" ? config.credentialRef : null }); }
    }
    const blocked = new Set(org.filter((item) => item.assignment === "blocked").map((item) => `${item.kind}:${item.capabilityId}`));
    for (const skill of personal.skills) { const id = skill.name.toLowerCase(); rows.push({kind:"skill",capabilityId:id,name:skill.name,description:skill.description,content:skill.content,enabled:true,locked:false,assignment:null,provenance:"personal",reason:"personal",contentHash:hashContent({content:skill.content})}); skills.push(skill); }
    for (const server of personal.mcpServers) { const denied = !settings.mcp || blocked.has(`mcp:${server.id}`); rows.push({kind:"mcp",capabilityId:server.id,name:server.name,enabled:!denied,locked:denied,assignment:null,provenance:"personal",reason:denied?"personal-blocked":"personal",contentHash:null}); if (!denied) mcpServers.push(server); }
    return { rows, skills, mcpServers };
  }
  async #listOverrides(tenantId:string,userId:string) { if (!this.database) return [...this.#overrides.values()].filter((item)=>item.tenantId===tenantId&&item.userId===userId); const rows=await this.database.withTenant(tenantId,(db)=>db.query<Record<string,unknown>>("SELECT * FROM capability_user_overrides WHERE user_id=$1",[userId])); return rows.map((row)=>({tenantId:String(row.tenant_id),userId:String(row.user_id),kind:String(row.kind) as "skill"|"mcp",capabilityId:String(row.capability_id),enabled:Boolean(row.enabled),updatedAt:new Date(String(row.updated_at)).toISOString()})); }
}
function object(value:JsonValue):Record<string,JsonValue>{return typeof value==="object"&&value!==null&&!Array.isArray(value)?value as Record<string,JsonValue>:{};}
function hashContent(value:JsonValue|undefined){const config=object(value??{});return typeof config.content==="string"?createHash("sha256").update(config.content).digest("hex"):null;}
function orgRow(row:Record<string,unknown>,files:readonly OrgSkillFileMetadata[]=[]):OrgCapability{const content=object((typeof row.config==="string"?JSON.parse(row.config):row.config??{}) as JsonValue).content;return{id:String(row.id),tenantId:String(row.tenant_id),kind:String(row.kind) as "skill"|"mcp",capabilityId:String(row.capability_id),name:String(row.name),description:String(row.description??""),assignment:String(row.assignment) as OrgCapabilityAssignment,allowUserDisable:Boolean(row.allow_user_disable),contentHash:row.content_hash===null?null:String(row.content_hash),config:(typeof row.config==="string"?JSON.parse(row.config):row.config??{}) as JsonValue,resources:files.map((file)=>file.path),packageBytes:(typeof content==="string"?Buffer.byteLength(content):0)+files.reduce((total,file)=>total+file.sizeBytes,0),createdAt:new Date(String(row.created_at)).toISOString(),updatedAt:new Date(String(row.updated_at)).toISOString()};}
function orgSkillFileRow(row:Record<string,unknown>):SkillPackageFile{const raw=row.content;const content=Buffer.isBuffer(raw)?raw:Buffer.from(raw instanceof Uint8Array?raw:String(raw??""));return{path:String(row.path),contentBase64:content.toString("base64"),mode:Number(row.mode??0o644)};}
function groupOrgSkillFiles(rows:readonly Record<string,unknown>[]):Map<string,OrgSkillFileMetadata[]>{const grouped=new Map<string,OrgSkillFileMetadata[]>();for(const row of rows){const id=String(row.organization_capability_id);grouped.set(id,[...(grouped.get(id)??[]),{path:String(row.path),sizeBytes:Number(row.size_bytes??0)}]);}return grouped;}
