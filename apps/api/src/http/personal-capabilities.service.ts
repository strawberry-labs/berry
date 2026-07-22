import { createHash, randomBytes, randomUUID } from "node:crypto";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { AgentSkill, McpServerSpec } from "@berry/local-agent";
import type { PersonalMcpServer, PersonalSkill, PersonalSkillReview } from "@berry/shared";
import type { CloudDatabaseService } from "../db/cloud-database.service.ts";
import { parseAgentSkillMarkdown } from "./agent-skill-content.ts";

export const PERSONAL_CAPABILITIES = Symbol("PERSONAL_CAPABILITIES");
const MAX_SKILL_BYTES = 262_144;

type SkillInput = { name?: string | undefined; description?: string | undefined; content?: string | undefined; source?: "text" | "upload" | "git" | undefined; sourceUrl?: string | null | undefined; version?: string | null | undefined; packageFiles?: string[] | undefined; enabled?: boolean | undefined; trusted?: boolean | undefined };
type McpInput = { name: string; url: string; transport: "http-sse" | "streamable-http"; auth: "none" | "bearer" | "oauth"; credential?: string | undefined; enabled?: boolean | undefined; trusted?: boolean | undefined };
type ToggleInput = { enabled?: boolean | undefined; trusted?: boolean | undefined };

export class PersonalCapabilitiesService {
  readonly #skills = new Map<string, PersonalSkill>();
  readonly #mcp = new Map<string, PersonalMcpServer>();
  readonly #secrets = new Map<string, string>();
  readonly #oauth = new Map<string, { tenantId: string; userId: string; serverId: string; expiresAt: number; complete: boolean }>();
  readonly #loaded = new Set<string>();

  constructor(private readonly database?: CloudDatabaseService) {}

  async listSkills(tenantId: string, userId: string) { await this.#load(tenantId, userId); return [...this.#skills.values()].filter((item) => owns(item, tenantId, userId)); }

  async previewSkill(input: SkillInput): Promise<{ review: PersonalSkillReview; content: string }> {
    const source = input.source ?? "text";
    const content = source === "git" ? await fetchApprovedSkill(input.sourceUrl) : input.content ?? "";
    validateSkillContent(content);
    const metadata = parseAgentSkillMarkdown(content);
    if (input.name?.trim() && input.name.trim() !== metadata.name) throw new BadRequestException(`Skill name must match SKILL.md frontmatter (${metadata.name})`);
    if (input.description?.trim() && input.description.trim() !== metadata.description) throw new BadRequestException("Skill description must match SKILL.md frontmatter");
    const packageFiles = [...new Set(input.packageFiles ?? [])].sort();
    const warnings = [/ignore (all|previous) instructions/i, /curl\s+.*\|\s*(sh|bash)/i].filter((pattern) => pattern.test(content)).map(() => "Skill contains instructions that require careful trust review.");
    if (packageFiles.some((path) => path.startsWith("scripts/"))) warnings.push("This skill package includes executable scripts. Review them before trusting the skill.");
    return { content, review: { ...metadata, source, hash: sha256(content), bytes: Buffer.byteLength(content), warnings, resources: packageFiles.filter((path) => path !== "SKILL.md"), hasScripts: packageFiles.some((path) => path.startsWith("scripts/")) } };
  }

  async saveSkill(tenantId: string, userId: string, input: SkillInput & { id?: string; confirmedHash: string }): Promise<PersonalSkill> {
    await this.#load(tenantId, userId);
    const preview = await this.previewSkill(input);
    if (preview.review.hash !== input.confirmedHash) throw new BadRequestException("Skill changed after review; review it again");
    const existing = input.id ? this.#skill(input.id, tenantId, userId) : null;
    const now = new Date().toISOString();
    const skill: PersonalSkill = { id: existing?.id ?? `skill_${randomUUID()}`, tenantId, userId, name: preview.review.name, description: preview.review.description, content: preview.content, enabled: input.enabled ?? existing?.enabled ?? false, trusted: input.trusted ?? existing?.trusted ?? false, source: preview.review.source, sourceUrl: input.sourceUrl ?? null, version: input.version ?? preview.review.version, hash: preview.review.hash, diagnostics: preview.review.warnings, createdAt: existing?.createdAt ?? now, updatedAt: now };
    this.#skills.set(skill.id, skill); await this.#persistSkill(skill); return skill;
  }

  async updateSkill(tenantId: string, userId: string, id: string, input: ToggleInput): Promise<PersonalSkill> {
    await this.#load(tenantId, userId); const current = this.#skill(id, tenantId, userId); const next: PersonalSkill = { ...current, ...(input.enabled !== undefined ? { enabled: input.enabled } : {}), ...(input.trusted !== undefined ? { trusted: input.trusted } : {}), updatedAt: new Date().toISOString() }; this.#skills.set(id, next); await this.#persistSkill(next); return next;
  }
  async deleteSkill(tenantId: string, userId: string, id: string) { await this.#load(tenantId, userId); this.#skill(id, tenantId, userId); this.#skills.delete(id); if (this.database) await this.database.withTenant(tenantId, (db) => db.execute("DELETE FROM personal_skills WHERE id = $1 AND user_id = $2", [id, userId])); return { ok: true }; }

  async listMcp(tenantId: string, userId: string) { await this.#load(tenantId, userId); return [...this.#mcp.values()].filter((item) => owns(item, tenantId, userId)); }
  async saveMcp(tenantId: string, userId: string, input: McpInput & { id?: string }): Promise<PersonalMcpServer> {
    await this.#load(tenantId, userId);
    const url = safeRemoteUrl(input.url);
    const existing = input.id ? this.#server(input.id, tenantId, userId) : null;
    const now = new Date().toISOString();
    const credentialRef = input.auth === "none" ? null : existing?.credentialRef ?? `secret_mcp_${randomUUID()}`;
    if (input.credential && credentialRef) this.#secrets.set(credentialRef, input.credential);
    const server: PersonalMcpServer = { id: existing?.id ?? `mcp_${randomUUID()}`, tenantId, userId, name: input.name.trim(), url, transport: input.transport, auth: input.auth, credentialRef, credentialConfigured: credentialRef ? this.#secrets.has(credentialRef) : false, enabled: input.enabled ?? existing?.enabled ?? true, trusted: input.trusted ?? existing?.trusted ?? false, health: existing?.health ?? "unknown", toolCount: existing?.toolCount ?? 0, lastCheckedAt: existing?.lastCheckedAt ?? null, diagnostics: existing?.diagnostics ?? [], createdAt: existing?.createdAt ?? now, updatedAt: now };
    this.#mcp.set(server.id, server); await this.#persistMcp(server); return server;
  }
  async updateMcp(tenantId: string, userId: string, id: string, input: ToggleInput): Promise<PersonalMcpServer> { await this.#load(tenantId, userId); const current = this.#server(id, tenantId, userId); const next: PersonalMcpServer = { ...current, ...(input.enabled !== undefined ? { enabled: input.enabled } : {}), ...(input.trusted !== undefined ? { trusted: input.trusted } : {}), updatedAt: new Date().toISOString() }; this.#mcp.set(id, next); await this.#persistMcp(next); return next; }
  async deleteMcp(tenantId: string, userId: string, id: string) { await this.#load(tenantId, userId); const server = this.#server(id, tenantId, userId); if (server.credentialRef) this.#secrets.delete(server.credentialRef); this.#mcp.delete(id); if (this.database) await this.database.withTenant(tenantId, (db) => db.execute("DELETE FROM personal_mcp_servers WHERE id = $1 AND user_id = $2", [id, userId])); return { ok: true }; }

  async healthMcp(tenantId: string, userId: string, id: string): Promise<PersonalMcpServer> {
    await this.#load(tenantId, userId);
    const current = this.#server(id, tenantId, userId); let health: PersonalMcpServer["health"] = "unreachable"; let diagnostics: string[] = [];
    try {
      const secret = current.credentialRef ? this.#secrets.get(current.credentialRef) : undefined;
      const response = await fetch(current.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(secret ? { authorization: `Bearer ${secret}` } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: "berry-health", method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "berry", version: "1" } } }), signal: AbortSignal.timeout(8_000) });
      health = response.status === 401 || response.status === 403 ? "unauthorized" : response.ok ? "healthy" : "invalid-response";
      if (!response.ok) diagnostics = [`HTTP ${response.status}`];
    } catch (cause) { diagnostics = [cause instanceof Error ? cause.message : "Connection failed"]; }
    const next = { ...current, health, diagnostics, lastCheckedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; this.#mcp.set(id, next); await this.#persistMcp(next); return next;
  }

  async startOAuth(tenantId: string, userId: string, id: string, redirectUri: string) {
    await this.#load(tenantId, userId);
    const server = this.#server(id, tenantId, userId); if (server.auth !== "oauth") throw new BadRequestException("Server is not configured for OAuth");
    const state = randomBytes(24).toString("base64url"); const expiresAt = Date.now() + 10 * 60_000; this.#oauth.set(state, { tenantId, userId, serverId: id, expiresAt, complete: false });
    const url = new URL(server.url); url.pathname = `${url.pathname.replace(/\/$/, "")}/authorize`; url.searchParams.set("state", state); url.searchParams.set("redirect_uri", redirectUri);
    return { serverId: id, state, authorizationUrl: url.toString(), expiresAt: new Date(expiresAt).toISOString() };
  }
  async completeOAuth(tenantId: string, userId: string, state: string, token: string): Promise<PersonalMcpServer> {
    const flow = this.#oauth.get(state);
    if (!flow || flow.expiresAt < Date.now() || flow.tenantId !== tenantId || flow.userId !== userId) throw new BadRequestException("OAuth state is invalid or expired");
    const server = this.#server(flow.serverId, tenantId, userId); if (!server.credentialRef) throw new BadRequestException("OAuth credential reference is missing");
    this.#secrets.set(server.credentialRef, token); flow.complete = true; const next = { ...server, credentialConfigured: true, updatedAt: new Date().toISOString() }; this.#mcp.set(server.id, next); await this.#persistMcp(next); return next;
  }
  pollOAuth(tenantId: string, userId: string, state: string) { const flow = this.#oauth.get(state); if (!flow || flow.expiresAt < Date.now() || flow.tenantId !== tenantId || flow.userId !== userId) throw new BadRequestException("OAuth state is invalid or expired"); return { status: flow.complete ? "complete" as const : "pending" as const, serverId: flow.complete ? flow.serverId : null }; }

  async runtime(tenantId: string, userId: string): Promise<{ skills: AgentSkill[]; mcpServers: McpServerSpec[] }> {
    const skills = (await this.listSkills(tenantId, userId)).filter((item) => item.enabled && item.trusted).map((item) => ({ name: item.name, description: item.description, content: item.content, filePath: `/personal-skills/${item.id}/SKILL.md`, scope: "registered" as const, disableModelInvocation: false, resources: [] }));
    const mcpServers = (await this.listMcp(tenantId, userId)).filter((item) => item.enabled && item.trusted).map((item) => ({ id: item.id, name: item.name, transport: item.transport, command: null, args: [], url: item.url, env: {}, enabled: true, trusted: true, credentialKey: item.credentialRef, ...(item.credentialRef && this.#secrets.get(item.credentialRef) ? { credential: this.#secrets.get(item.credentialRef)! } : {}) }));
    return { skills, mcpServers };
  }

  #skill(id: string, tenantId: string, userId: string) { const item = this.#skills.get(id); if (!item || !owns(item, tenantId, userId)) throw new NotFoundException("Skill not found"); return item; }
  #server(id: string, tenantId: string, userId: string) { const item = this.#mcp.get(id); if (!item || !owns(item, tenantId, userId)) throw new NotFoundException("MCP server not found"); return item; }

  async #load(tenantId: string, userId: string) {
    const key = `${tenantId}:${userId}`; if (!this.database || this.#loaded.has(key)) return; this.#loaded.add(key);
    const [skills, servers] = await Promise.all([
      this.database.withTenant(tenantId, (db) => db.query<Record<string, unknown>>("SELECT * FROM personal_skills WHERE user_id = $1", [userId])),
      this.database.withTenant(tenantId, (db) => db.query<Record<string, unknown>>("SELECT * FROM personal_mcp_servers WHERE user_id = $1", [userId])),
    ]);
    for (const row of skills) { const item = skillRow(row); this.#skills.set(item.id, item); }
    for (const row of servers) { const item = mcpRow(row, false); this.#mcp.set(item.id, item); }
  }
  async #persistSkill(skill: PersonalSkill) { if (!this.database) return; await this.database.withTenant(skill.tenantId, (db) => db.execute(`INSERT INTO personal_skills (id, tenant_id, user_id, name, description, content, enabled, trusted, source, source_url, version, hash, diagnostics, created_at, updated_at) VALUES ($1,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::timestamptz,$15::timestamptz) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,content=EXCLUDED.content,enabled=EXCLUDED.enabled,trusted=EXCLUDED.trusted,source=EXCLUDED.source,source_url=EXCLUDED.source_url,version=EXCLUDED.version,hash=EXCLUDED.hash,diagnostics=EXCLUDED.diagnostics,updated_at=EXCLUDED.updated_at`, [skill.id,skill.tenantId,skill.userId,skill.name,skill.description,skill.content,skill.enabled,skill.trusted,skill.source,skill.sourceUrl,skill.version,skill.hash,JSON.stringify(skill.diagnostics),skill.createdAt,skill.updatedAt])); }
  async #persistMcp(server: PersonalMcpServer) { if (!this.database) return; await this.database.withTenant(server.tenantId, (db) => db.execute(`INSERT INTO personal_mcp_servers (id, tenant_id, user_id, name, url, transport, auth, credential_ref, enabled, trusted, health, tool_count, last_checked_at, diagnostics, created_at, updated_at) VALUES ($1,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::timestamptz,$14::jsonb,$15::timestamptz,$16::timestamptz) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,url=EXCLUDED.url,transport=EXCLUDED.transport,auth=EXCLUDED.auth,credential_ref=EXCLUDED.credential_ref,enabled=EXCLUDED.enabled,trusted=EXCLUDED.trusted,health=EXCLUDED.health,tool_count=EXCLUDED.tool_count,last_checked_at=EXCLUDED.last_checked_at,diagnostics=EXCLUDED.diagnostics,updated_at=EXCLUDED.updated_at`, [server.id,server.tenantId,server.userId,server.name,server.url,server.transport,server.auth,server.credentialRef,server.enabled,server.trusted,server.health,server.toolCount,server.lastCheckedAt,JSON.stringify(server.diagnostics),server.createdAt,server.updatedAt])); }
}

function owns(item: { tenantId: string; userId: string }, tenantId: string, userId: string) { return item.tenantId === tenantId && item.userId === userId; }
function sha256(content: string) { return createHash("sha256").update(content).digest("hex"); }
function validateSkillContent(content: string) { const bytes = Buffer.byteLength(content); if (!content.trim()) throw new BadRequestException("Skill content is required"); if (bytes > MAX_SKILL_BYTES) throw new BadRequestException("Skill packages are limited to 256 KB"); }
function safeRemoteUrl(raw: string) { const url = new URL(raw); if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) throw new BadRequestException("Remote MCP must use HTTPS"); return url.toString(); }
async function fetchApprovedSkill(raw: string | null | undefined) { if (!raw) throw new BadRequestException("Git source URL is required"); let url = new URL(raw); if (!["github.com", "raw.githubusercontent.com"].includes(url.hostname) || url.protocol !== "https:") throw new BadRequestException("Git skill sources must be hosted on approved GitHub domains"); if (url.hostname === "github.com") { const parts = url.pathname.split("/").filter(Boolean); if (parts[2] !== "blob" || parts.length < 5) throw new BadRequestException("GitHub skill URL must point to a SKILL.md file"); url = new URL(`https://raw.githubusercontent.com/${parts[0]}/${parts[1]}/${parts[3]}/${parts.slice(4).join("/")}`); } const response = await fetch(url, { signal: AbortSignal.timeout(10_000) }); if (!response.ok) throw new BadRequestException(`Skill source returned HTTP ${response.status}`); const content = await response.text(); validateSkillContent(content); return content; }
function value(row: Record<string, unknown>, key: string) { return row[key]; }
function str(row: Record<string, unknown>, key: string) { return String(value(row, key) ?? ""); }
function nullable(row: Record<string, unknown>, key: string) { const result = value(row, key); return result === null || result === undefined ? null : String(result); }
function bool(row: Record<string, unknown>, key: string) { return Boolean(value(row, key)); }
function date(row: Record<string, unknown>, key: string) { const result = value(row, key); return result instanceof Date ? result.toISOString() : new Date(String(result)).toISOString(); }
function jsonStrings(row: Record<string, unknown>, key: string) { const result = value(row, key); return Array.isArray(result) ? result.map(String) : typeof result === "string" ? JSON.parse(result) as string[] : []; }
function skillRow(row: Record<string, unknown>): PersonalSkill { return { id:str(row,"id"),tenantId:str(row,"tenant_id"),userId:str(row,"user_id"),name:str(row,"name"),description:str(row,"description"),content:str(row,"content"),enabled:bool(row,"enabled"),trusted:bool(row,"trusted"),source:str(row,"source") as PersonalSkill["source"],sourceUrl:nullable(row,"source_url"),version:nullable(row,"version"),hash:str(row,"hash"),diagnostics:jsonStrings(row,"diagnostics"),createdAt:date(row,"created_at"),updatedAt:date(row,"updated_at")}; }
function mcpRow(row: Record<string, unknown>, credentialConfigured: boolean): PersonalMcpServer { return { id:str(row,"id"),tenantId:str(row,"tenant_id"),userId:str(row,"user_id"),name:str(row,"name"),url:str(row,"url"),transport:str(row,"transport") as PersonalMcpServer["transport"],auth:str(row,"auth") as PersonalMcpServer["auth"],credentialRef:nullable(row,"credential_ref"),credentialConfigured,enabled:bool(row,"enabled"),trusted:bool(row,"trusted"),health:str(row,"health") as PersonalMcpServer["health"],toolCount:Number(value(row,"tool_count") ?? 0),lastCheckedAt:nullable(row,"last_checked_at"),diagnostics:jsonStrings(row,"diagnostics"),createdAt:date(row,"created_at"),updatedAt:date(row,"updated_at")}; }
