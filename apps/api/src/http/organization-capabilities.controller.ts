import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Inject, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { ORGANIZATION_SKILL_PACKAGE_MAX_BYTES, OrgCapabilityAssignmentSchema, type OrgPermission } from "@berry/shared";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { AuthenticatedRequest } from "../auth/auth.guard.ts";
import { ENTERPRISE_IDENTITY_REPOSITORY, type EnterpriseIdentityRepository } from "../identity/identity.repository.ts";
import { AUDIT_SERVICE, type AuditService } from "../audit/audit.service.ts";
import { FilePlatformService } from "../files/file-platform.service.ts";
import { ORGANIZATION_CAPABILITIES, OrganizationCapabilitiesService } from "./organization-capabilities.service.ts";
import { extractOrganizationSkillArchive, type StagedOrganizationSkillArchive } from "./skill-package-archive.ts";

const SkillPackageFileSchema=z.object({path:z.string().trim().min(1).max(512),contentBase64:z.string().max(7_000_000),mode:z.number().int().min(0).max(0o777).optional()}).strict();
const UpsertSchema=z.object({kind:z.enum(["skill","mcp"]),capabilityId:z.string().min(1),name:z.string().min(1),description:z.string().optional(),assignment:OrgCapabilityAssignmentSchema,allowUserDisable:z.boolean().optional(),contentHash:z.string().nullable().optional(),config:z.record(z.unknown()).optional(),resourceFiles:z.array(SkillPackageFileSchema).max(500).optional()}).strict();
const SkillReviewSchema=z.object({content:z.string().max(262_144).optional(),source:z.enum(["text","upload","git"]).default("text"),sourceUrl:z.string().url().nullable().optional(),packageFiles:z.array(z.string().min(1).max(512)).max(500).optional(),resourceFiles:z.array(SkillPackageFileSchema).max(500).optional()}).strict();
const SkillArchiveSchema=z.object({fileId:z.string().uuid()}).strict();
const InstallSkillArchiveSchema=SkillArchiveSchema.extend({assignment:OrgCapabilityAssignmentSchema,allowUserDisable:z.boolean().optional()}).strict();
@Controller("/v1/orgs/:tenantId/capabilities")
export class OrganizationCapabilitiesController {
  constructor(@Inject(ORGANIZATION_CAPABILITIES) private readonly capabilities:OrganizationCapabilitiesService,@Inject(ENTERPRISE_IDENTITY_REPOSITORY) private readonly identity:EnterpriseIdentityRepository,@Inject(AUDIT_SERVICE) private readonly audit:AuditService,@Inject(FilePlatformService) private readonly files:FilePlatformService){}
  @Get() async list(@Req() req:AuthenticatedRequest,@Param("tenantId") tenantId:string){await this.allow(req,tenantId,"skills:read");return this.capabilities.list(tenantId);}
  @Post() async upsert(@Req() req:AuthenticatedRequest,@Param("tenantId") tenantId:string,@Body() body:unknown){const input=parse(UpsertSchema,body);await this.allow(req,tenantId,input.kind==="skill"?"skills:write":"mcp:write");const result=await this.capabilities.upsert(tenantId,input as never);await this.audit.append({tenantId,actorUserId:req.auth!.user.id,category:"capabilities",action:"organization-capability-upserted",targetType:input.kind,targetId:result.capabilityId,after:result as never,metadata:{assignment:result.assignment,contentHash:result.contentHash}});return result;}
  @Post("skills/review") async reviewSkill(@Req() req:AuthenticatedRequest,@Param("tenantId") tenantId:string,@Body() body:unknown){await this.allow(req,tenantId,"skills:write");return this.capabilities.reviewSkill(parse(SkillReviewSchema,body));}
  @Post("skills/packages/review")
  async reviewSkillArchive(@Req() req:AuthenticatedRequest,@Param("tenantId") tenantId:string,@Body() body:unknown) {
    await this.allow(req,tenantId,"skills:write");
    const input=parse(SkillArchiveSchema,body);
    return this.withSkillArchive(tenantId, req.auth!.user.id, input.fileId, async (skill) => this.capabilities.reviewStagedSkill(skill));
  }
  @Post("skills/packages")
  async installSkillArchive(@Req() req:AuthenticatedRequest,@Param("tenantId") tenantId:string,@Body() body:unknown) {
    await this.allow(req,tenantId,"skills:write");
    const input=parse(InstallSkillArchiveSchema,body);
    return this.withSkillArchive(tenantId, req.auth!.user.id, input.fileId, async (skill) => {
      const review=this.capabilities.reviewStagedSkill(skill);
      const result=await this.capabilities.upsert(tenantId,{kind:"skill",capabilityId:review.name,name:review.name,description:review.description,assignment:input.assignment,allowUserDisable:input.assignment==="required"||input.assignment==="blocked"?false:input.allowUserDisable??true,contentHash:review.hash,config:{content:skill.content,packageStorageVersion:1},stagedResourceFiles:skill.resourceFiles,reviewedSkill:review});
      await this.audit.append({tenantId,actorUserId:req.auth!.user.id,category:"capabilities",action:"organization-skill-package-installed",targetType:"skill",targetId:result.capabilityId,after:result as never,metadata:{assignment:result.assignment,contentHash:result.contentHash,sourceFileId:input.fileId,packageBytes:result.packageBytes,resourceCount:result.resources.length}});
      return result;
    });
  }
  @Get("skills/:id/package") async skillPackage(@Req() req:AuthenticatedRequest,@Param("tenantId") tenantId:string,@Param("id") id:string){await this.allow(req,tenantId,"skills:read");return this.capabilities.skillPackage(tenantId,id);}
  @Get("skills/:id/package/file") async skillPackageFile(@Req() req:AuthenticatedRequest,@Param("tenantId") tenantId:string,@Param("id") id:string,@Query("path") path:unknown){await this.allow(req,tenantId,"skills:read");return this.capabilities.skillPackageFile(tenantId,id,parse(z.string().trim().min(1).max(512),path));}
  @Delete(":id") async remove(@Req() req:AuthenticatedRequest,@Param("tenantId") tenantId:string,@Param("id") id:string){const record=(await this.capabilities.list(tenantId)).find((item)=>item.id===id);if(!record)return{ok:false};await this.allow(req,tenantId,record.kind==="skill"?"skills:write":"mcp:write");const result=await this.capabilities.remove(tenantId,id);await this.audit.append({tenantId,actorUserId:req.auth!.user.id,category:"capabilities",action:"organization-capability-deleted",targetType:record.kind,targetId:record.capabilityId,before:record as never,metadata:{assignment:record.assignment,contentHash:record.contentHash}});return result;}
  @Get("settings/personal-additions") async settings(@Req() req:AuthenticatedRequest,@Param("tenantId") tenantId:string){await this.allow(req,tenantId,"skills:read");return this.capabilities.settings(tenantId);}
  @Patch("settings/personal-additions") async updateSettings(@Req() req:AuthenticatedRequest,@Param("tenantId") tenantId:string,@Body() body:unknown){await this.allow(req,tenantId,"skills:write");await this.allow(req,tenantId,"mcp:write");const before=await this.capabilities.settings(tenantId);const result=await this.capabilities.updateSettings(tenantId,parse(z.object({skills:z.boolean(),mcp:z.boolean()}).strict(),body));await this.audit.append({tenantId,actorUserId:req.auth!.user.id,category:"capabilities",action:"personal-addition-policy-updated",targetType:"organization",targetId:tenantId,before:before as never,after:result as never,metadata:{}});return result;}
  @Get("effective/me") async effective(@Req() req:AuthenticatedRequest,@Param("tenantId") tenantId:string){await this.allow(req,tenantId,"skills:read");return (await this.capabilities.effective(tenantId,req.auth!.user.id)).rows;}
  @Patch("effective/me/:kind/:capabilityId") async override(@Req() req:AuthenticatedRequest,@Param("tenantId") tenantId:string,@Param("kind") kind:string,@Param("capabilityId") id:string,@Body() body:unknown){const parsedKind=z.enum(["skill","mcp"]).parse(kind);await this.allow(req,tenantId,parsedKind==="mcp"?"mcp:read":"skills:read");const effective=(await this.capabilities.effective(tenantId,req.auth!.user.id)).rows.find((item)=>item.kind===parsedKind&&item.capabilityId===id);if(!effective||effective.locked)throw new ForbiddenException("This organization capability is locked");return this.capabilities.setOverride(tenantId,req.auth!.user.id,parsedKind,id,parse(z.object({enabled:z.boolean()}).strict(),body).enabled);}
  private async allow(req:AuthenticatedRequest,tenantId:string,permission:OrgPermission){if(!await this.identity.authorize(req.auth!.user.id,tenantId,permission))throw new ForbiddenException(`Missing organization permission: ${permission}`);}
  private async withSkillArchive<T>(tenantId:string,userId:string,fileId:string,operation:(archive:StagedOrganizationSkillArchive)=>Promise<T>):Promise<T>{
    const root=await mkdtemp(join(tmpdir(),"berry-organization-skill-"));
    try {
      const archivePath=join(root,"package.skill");
      await this.files.downloadContentToFile(tenantId,userId,fileId,ORGANIZATION_SKILL_PACKAGE_MAX_BYTES,archivePath);
      return await operation(await extractOrganizationSkillArchive(archivePath,join(root,"entries")));
    } finally {
      await rm(root,{recursive:true,force:true});
    }
  }
}
function parse<T extends z.ZodTypeAny>(schema:T,body:unknown):z.infer<T>{const result=schema.safeParse(body);if(!result.success)throw new BadRequestException(result.error.flatten());return result.data;}
