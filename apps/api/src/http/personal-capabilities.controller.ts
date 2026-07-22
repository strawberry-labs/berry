import { BadRequestException, Body, Controller, Delete, Get, Inject, Param, Patch, Post, Req } from "@nestjs/common";
import { SELF_HOST_TENANT_ID } from "@berry/db";
import { z } from "zod";
import type { AuthenticatedRequest } from "../auth/auth.guard.ts";
import { PERSONAL_CAPABILITIES, PersonalCapabilitiesService } from "./personal-capabilities.service.ts";

const SkillInputSchema = z.object({ name: z.string().trim().max(64).optional(), description: z.string().trim().max(1024).optional(), content: z.string().max(262_144).optional(), source: z.enum(["text", "upload", "git"]).default("text"), sourceUrl: z.string().url().nullable().optional(), version: z.string().max(64).nullable().optional(), packageFiles: z.array(z.string().min(1).max(512)).max(500).optional(), enabled: z.boolean().optional(), trusted: z.boolean().optional() }).strict();
const SkillSaveSchema = SkillInputSchema.extend({ confirmedHash: z.string().regex(/^[a-f0-9]{64}$/) });
const ToggleSchema = z.object({ enabled: z.boolean().optional(), trusted: z.boolean().optional() }).strict().refine((input) => input.enabled !== undefined || input.trusted !== undefined);
const McpInputSchema = z.object({ name: z.string().trim().min(1).max(100), url: z.string().url(), transport: z.enum(["http-sse", "streamable-http"]), auth: z.enum(["none", "bearer", "oauth"]), credential: z.string().min(1).max(16_384).optional(), enabled: z.boolean().optional(), trusted: z.boolean().optional() }).strict();
const OAuthStartSchema = z.object({ redirectUri: z.string().url() }).strict();
const OAuthCompleteSchema = z.object({ state: z.string().min(20), code: z.string().min(1).max(16_384) }).strict();

@Controller("/v1/me")
export class PersonalCapabilitiesController {
  constructor(@Inject(PERSONAL_CAPABILITIES) private readonly capabilities: PersonalCapabilitiesService) {}
  @Get("/skills") listSkills(@Req() request: AuthenticatedRequest) { return this.capabilities.listSkills(tenant(), user(request)); }
  @Post("/skills/review") async reviewSkill(@Body() body: unknown) { return (await this.capabilities.previewSkill(parse(SkillInputSchema, body))).review; }
  @Post("/skills") saveSkill(@Req() request: AuthenticatedRequest, @Body() body: unknown) { return this.capabilities.saveSkill(tenant(), user(request), parse(SkillSaveSchema, body)); }
  @Patch("/skills/:id") updateSkill(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) { return this.capabilities.updateSkill(tenant(), user(request), id, parse(ToggleSchema, body)); }
  @Delete("/skills/:id") deleteSkill(@Req() request: AuthenticatedRequest, @Param("id") id: string) { return this.capabilities.deleteSkill(tenant(), user(request), id); }

  @Get("/mcp") listMcp(@Req() request: AuthenticatedRequest) { return this.capabilities.listMcp(tenant(), user(request)); }
  @Post("/mcp") saveMcp(@Req() request: AuthenticatedRequest, @Body() body: unknown) { return this.capabilities.saveMcp(tenant(), user(request), parse(McpInputSchema, body)); }
  @Patch("/mcp/:id") updateMcp(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) { return this.capabilities.updateMcp(tenant(), user(request), id, parse(ToggleSchema, body)); }
  @Delete("/mcp/:id") deleteMcp(@Req() request: AuthenticatedRequest, @Param("id") id: string) { return this.capabilities.deleteMcp(tenant(), user(request), id); }
  @Post("/mcp/:id/health") healthMcp(@Req() request: AuthenticatedRequest, @Param("id") id: string) { return this.capabilities.healthMcp(tenant(), user(request), id); }
  @Post("/mcp/:id/reconnect") reconnectMcp(@Req() request: AuthenticatedRequest, @Param("id") id: string) { return this.capabilities.healthMcp(tenant(), user(request), id); }
  @Post("/mcp/:id/oauth/start") startOAuth(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) { return this.capabilities.startOAuth(tenant(), user(request), id, parse(OAuthStartSchema, body).redirectUri); }
  @Post("/mcp/oauth/complete") completeOAuth(@Req() request: AuthenticatedRequest, @Body() body: unknown) { const input = parse(OAuthCompleteSchema, body); return this.capabilities.completeOAuth(tenant(), user(request), input.state, input.code); }
  @Post("/mcp/oauth/poll") pollOAuth(@Req() request: AuthenticatedRequest, @Body() body: unknown) { return this.capabilities.pollOAuth(tenant(), user(request), parse(z.object({ state: z.string().min(20) }).strict(), body).state); }
}

function user(request: AuthenticatedRequest) { const id = request.auth?.user.id; if (!id) throw new BadRequestException("Authenticated user is required"); return id; }
function tenant() { return process.env.BERRY_TENANT_ID?.trim() || SELF_HOST_TENANT_ID; }
function parse<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> { const result = schema.safeParse(body); if (!result.success) throw new BadRequestException(result.error.flatten()); return result.data; }
