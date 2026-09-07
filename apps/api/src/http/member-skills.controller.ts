import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Inject, NotFoundException, Param, Patch, Post, Req } from "@nestjs/common";
import { z } from "zod";
import type { AuthenticatedRequest } from "../auth/auth.guard.ts";
import { ENTERPRISE_IDENTITY_REPOSITORY, type EnterpriseIdentityRepository } from "../identity/identity.repository.ts";
import { AUDIT_SERVICE, type AuditService } from "../audit/audit.service.ts";
import { FilePlatformService } from "../files/file-platform.service.ts";
import { PERSONAL_CAPABILITIES, PersonalCapabilitiesService } from "./personal-capabilities.service.ts";
import { ORGANIZATION_CAPABILITIES, OrganizationCapabilitiesService } from "./organization-capabilities.service.ts";
import { SkillInputSchema } from "./personal-capabilities.controller.ts";
import { installPersonalSkillArchive } from "./personal-skill-archive.ts";

@Controller("/v1/orgs/:tenantId/members/:userId/skills")
export class MemberSkillsController {
  constructor(@Inject(PERSONAL_CAPABILITIES) private readonly skills: PersonalCapabilitiesService, @Inject(ORGANIZATION_CAPABILITIES) private readonly organization: OrganizationCapabilitiesService, @Inject(ENTERPRISE_IDENTITY_REPOSITORY) private readonly identity: EnterpriseIdentityRepository, @Inject(AUDIT_SERVICE) private readonly audit: AuditService, @Inject(FilePlatformService) private readonly files: FilePlatformService) {}
  private async allow(req: AuthenticatedRequest, tenantId: string, userId: string, write = false) {
    const actor = req.auth!.user.id;
    if (!await this.identity.authorize(actor, tenantId, "org:admin") || !await this.identity.authorize(actor, tenantId, write ? "skills:write" : "skills:read")) throw new ForbiddenException("Organization administrator permission is required to manage member skills");
    if (!await this.identity.getMembership(tenantId, userId)) throw new NotFoundException("Organization member not found");
    return actor;
  }
  private record(tenantId: string, actorUserId: string, userId: string, skillId: string, action: string) {
    return this.audit.append({ tenantId, actorUserId, category: "capabilities", action, targetType: "personal-skill", targetId: skillId, metadata: { ownerUserId: userId } });
  }
  @Get() async list(@Req() req: AuthenticatedRequest, @Param("tenantId") tenantId: string, @Param("userId") userId: string) {
    await this.allow(req, tenantId, userId);
    return { personal: await this.skills.listSkills(tenantId, userId), effective: (await this.organization.effective(tenantId, userId)).rows.filter((row) => row.kind === "skill") };
  }
  @Post() async save(@Req() req: AuthenticatedRequest, @Param("tenantId") tenantId: string, @Param("userId") userId: string, @Body() body: unknown) {
    const actor = await this.allow(req, tenantId, userId, true);
    const result = await this.skills.saveSkill(tenantId, userId, parse(SkillInputSchema, body));
    await this.record(tenantId, actor, userId, result.id, "member-skill-saved"); return result;
  }
  @Post("packages") async install(@Req() req: AuthenticatedRequest, @Param("tenantId") tenantId: string, @Param("userId") userId: string, @Body() body: unknown) {
    const actor = await this.allow(req, tenantId, userId, true);
    const { fileId } = parse(z.object({ fileId: z.string().uuid() }).strict(), body);
    const result = await installPersonalSkillArchive(this.files, this.skills, tenantId, actor, userId, fileId);
    await this.record(tenantId, actor, userId, result.id, "member-skill-package-installed"); return result;
  }
  @Patch(":id") async toggle(@Req() req: AuthenticatedRequest, @Param("tenantId") tenantId: string, @Param("userId") userId: string, @Param("id") id: string, @Body() body: unknown) {
    const actor = await this.allow(req, tenantId, userId, true);
    const result = await this.skills.updateSkill(tenantId, userId, id, parse(z.object({ enabled: z.boolean() }).strict(), body));
    await this.record(tenantId, actor, userId, id, "member-skill-updated"); return result;
  }
  @Delete(":id") async remove(@Req() req: AuthenticatedRequest, @Param("tenantId") tenantId: string, @Param("userId") userId: string, @Param("id") id: string) {
    const actor = await this.allow(req, tenantId, userId, true);
    const result = await this.skills.deleteSkill(tenantId, userId, id);
    await this.record(tenantId, actor, userId, id, "member-skill-removed"); return result;
  }
}
function parse<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> { const result = schema.safeParse(body); if (!result.success) throw new BadRequestException(result.error.flatten()); return result.data; }
