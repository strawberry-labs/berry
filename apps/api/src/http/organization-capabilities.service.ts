import { createHash, randomUUID } from "node:crypto";
import type { AgentSkill, McpServerSpec } from "@berry/local-agent";
import type { CapabilityUserOverride, EffectiveCapability, JsonValue, OrgCapability, OrgCapabilityAssignment } from "@berry/shared";
import type { CloudDatabaseService } from "../db/cloud-database.service.ts";
import { PersonalCapabilitiesService } from "./personal-capabilities.service.ts";

export const ORGANIZATION_CAPABILITIES = Symbol("ORGANIZATION_CAPABILITIES");
type Upsert = { kind: "skill" | "mcp"; capabilityId: string; name: string; description?: string; assignment: OrgCapabilityAssignment; allowUserDisable?: boolean; config?: JsonValue; contentHash?: string | null };

export class OrganizationCapabilitiesService {
  readonly #records = new Map<string, OrgCapability>();
  readonly #overrides = new Map<string, CapabilityUserOverride & { kind: "skill" | "mcp" }>();
  readonly #settings = new Map<string, { skills: boolean; mcp: boolean }>();
  constructor(private readonly personal: PersonalCapabilitiesService, private readonly database?: CloudDatabaseService) {}

  async list(tenantId: string): Promise<OrgCapability[]> {
    if (!this.database) return [...this.#records.values()].filter((item) => item.tenantId === tenantId);
    const rows = await this.database.withTenant(tenantId, (db) => db.query<Record<string, unknown>>("SELECT * FROM organization_capabilities ORDER BY kind, name"));
    return rows.map(orgRow);
  }
  async upsert(tenantId: string, input: Upsert): Promise<OrgCapability> {
    const current = (await this.list(tenantId)).find((item) => item.kind === input.kind && item.capabilityId === input.capabilityId);
    const now = new Date().toISOString(); const hash = input.contentHash ?? (input.kind === "skill" ? hashContent(input.config) : null);
    const record: OrgCapability = { id: current?.id ?? `orgcap_${randomUUID()}`, tenantId, kind: input.kind, capabilityId: input.capabilityId, name: input.name, description: input.description ?? "", assignment: input.assignment, allowUserDisable: input.allowUserDisable ?? false, contentHash: hash, config: input.config ?? {}, createdAt: current?.createdAt ?? now, updatedAt: now };
    this.#records.set(record.id, record);
    if (this.database) await this.database.withTenant(tenantId, (db) => db.execute(`INSERT INTO organization_capabilities (id,tenant_id,kind,capability_id,name,description,assignment,allow_user_disable,content_hash,config,created_at,updated_at) VALUES ($1,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::timestamptz,$12::timestamptz) ON CONFLICT (tenant_id,kind,capability_id) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,assignment=EXCLUDED.assignment,allow_user_disable=EXCLUDED.allow_user_disable,content_hash=EXCLUDED.content_hash,config=EXCLUDED.config,updated_at=EXCLUDED.updated_at`, [record.id,tenantId,record.kind,record.capabilityId,record.name,record.description,record.assignment,record.allowUserDisable,record.contentHash,JSON.stringify(record.config),record.createdAt,record.updatedAt]));
    return record;
  }
  async remove(tenantId: string, id: string) { const record = (await this.list(tenantId)).find((item) => item.id === id); if (!record) return { ok: false }; this.#records.delete(id); if (this.database) await this.database.withTenant(tenantId, (db) => db.execute("DELETE FROM organization_capabilities WHERE id=$1", [id])); return { ok: true }; }
  async settings(tenantId: string) { if (!this.database) return this.#settings.get(tenantId) ?? { skills: true, mcp: true }; const rows = await this.database.withTenant(tenantId, (db) => db.query<{ allow_personal_skills: boolean; allow_personal_mcp: boolean }>("SELECT allow_personal_skills,allow_personal_mcp FROM organization_capability_settings")); return rows[0] ? { skills: rows[0].allow_personal_skills, mcp: rows[0].allow_personal_mcp } : { skills: true, mcp: true }; }
  async updateSettings(tenantId: string, value: { skills: boolean; mcp: boolean }) { this.#settings.set(tenantId, value); if (this.database) await this.database.withTenant(tenantId, (db) => db.execute("INSERT INTO organization_capability_settings (tenant_id,allow_personal_skills,allow_personal_mcp) VALUES ($1::uuid,$2,$3) ON CONFLICT (tenant_id) DO UPDATE SET allow_personal_skills=EXCLUDED.allow_personal_skills,allow_personal_mcp=EXCLUDED.allow_personal_mcp,updated_at=now()", [tenantId,value.skills,value.mcp])); return value; }
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
      const enabled = item.assignment === "required" || item.assignment === "default-on" && !(item.allowUserDisable && override?.enabled === false) || item.assignment === "available" && override?.enabled === true;
      const reason: EffectiveCapability["reason"] = item.assignment === "blocked" ? "blocked" : item.assignment === "required" ? "required" : override?.enabled === false ? "user-disabled" : override?.enabled === true ? "user-enabled" : item.assignment === "default-on" ? "default" : "available";
      rows.push({ kind:item.kind,capabilityId:item.capabilityId,name:item.name,enabled:enabled && item.assignment !== "blocked",locked:item.assignment === "required" || item.assignment === "blocked" || !item.allowUserDisable,assignment:item.assignment,provenance:"organization",reason,contentHash:item.contentHash });
      if (!enabled || item.assignment === "blocked") continue;
      if (item.kind === "skill") { const config = object(item.config); const content = typeof config.content === "string" ? config.content : ""; if (content) skills.push({ name:item.name,description:item.description,content,filePath:`/workspace/.berry/managed-skills/${item.capabilityId}/SKILL.md`,scope:"registered",disableModelInvocation:false,resources:[] }); }
      else { const config = object(item.config); if (typeof config.url === "string") mcpServers.push({ id:item.capabilityId,name:item.name,transport:config.transport === "http-sse" ? "http-sse" : "streamable-http",command:null,args:[],url:config.url,env:{},enabled:true,trusted:true,credentialKey:typeof config.credentialRef === "string" ? config.credentialRef : null }); }
    }
    const blocked = new Set(org.filter((item) => item.assignment === "blocked").map((item) => `${item.kind}:${item.capabilityId}`));
    for (const skill of personal.skills) { const id = skill.name.toLowerCase(); const denied = !settings.skills || blocked.has(`skill:${id}`); rows.push({kind:"skill",capabilityId:id,name:skill.name,enabled:!denied,locked:denied,assignment:null,provenance:"personal",reason:denied?"personal-blocked":"personal",contentHash:hashContent({content:skill.content})}); if (!denied) skills.push(skill); }
    for (const server of personal.mcpServers) { const denied = !settings.mcp || blocked.has(`mcp:${server.id}`); rows.push({kind:"mcp",capabilityId:server.id,name:server.name,enabled:!denied,locked:denied,assignment:null,provenance:"personal",reason:denied?"personal-blocked":"personal",contentHash:null}); if (!denied) mcpServers.push(server); }
    return { rows, skills, mcpServers };
  }
  async #listOverrides(tenantId:string,userId:string) { if (!this.database) return [...this.#overrides.values()].filter((item)=>item.tenantId===tenantId&&item.userId===userId); const rows=await this.database.withTenant(tenantId,(db)=>db.query<Record<string,unknown>>("SELECT * FROM capability_user_overrides WHERE user_id=$1",[userId])); return rows.map((row)=>({tenantId:String(row.tenant_id),userId:String(row.user_id),kind:String(row.kind) as "skill"|"mcp",capabilityId:String(row.capability_id),enabled:Boolean(row.enabled),updatedAt:new Date(String(row.updated_at)).toISOString()})); }
}
function object(value:JsonValue):Record<string,JsonValue>{return typeof value==="object"&&value!==null&&!Array.isArray(value)?value as Record<string,JsonValue>:{};}
function hashContent(value:JsonValue|undefined){const config=object(value??{});return typeof config.content==="string"?createHash("sha256").update(config.content).digest("hex"):null;}
function orgRow(row:Record<string,unknown>):OrgCapability{return{id:String(row.id),tenantId:String(row.tenant_id),kind:String(row.kind) as "skill"|"mcp",capabilityId:String(row.capability_id),name:String(row.name),description:String(row.description??""),assignment:String(row.assignment) as OrgCapabilityAssignment,allowUserDisable:Boolean(row.allow_user_disable),contentHash:row.content_hash===null?null:String(row.content_hash),config:(typeof row.config==="string"?JSON.parse(row.config):row.config??{}) as JsonValue,createdAt:new Date(String(row.created_at)).toISOString(),updatedAt:new Date(String(row.updated_at)).toISOString()};}
