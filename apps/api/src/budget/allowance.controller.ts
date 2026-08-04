import { BadRequestException, Body, Controller, ForbiddenException, Get, Inject, Optional, Param, Post, Put, Query, Req } from "@nestjs/common";
import {
  AllowanceAdjustmentCreateSchema, AllowanceAdjustmentSchema, AllowanceBalanceSchema,
  AllowanceCycleSettingsSchema, AllowanceCycleSettingsUpsertSchema, AllowanceDefaultUpsertSchema, AllowanceProfileSchema, AllowanceProfileUpsertSchema, BlockedRequestPageSchema,
  BulkLimitMutationSchema, BulkLimitResultSchema, EffectiveLimitSchema, MemberAllowanceBaseUpsertSchema, OrgPermissionSchema, QuotaMetricSchema,
  type OrgPermission,
} from "@berry/shared";
import { z } from "zod";
import { AUDIT_SERVICE, type AuditService } from "../audit/audit.service.ts";
import type { AuthenticatedRequest } from "../auth/auth.guard.ts";
import { ENTERPRISE_IDENTITY_REPOSITORY, type EnterpriseIdentityRepository } from "../identity/identity.repository.ts";
import { ALLOWANCE_SERVICE, type AllowanceService } from "./allowance.service.ts";

const EffectiveQuerySchema = z.object({ metric: QuotaMetricSchema.default("cost"), period: z.enum(["day", "month"]).default("month") }).strict();
const PageQuerySchema = z.object({ cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict();
const AdjustmentQuerySchema = z.object({ userId: z.string().optional() }).strict();

@Controller("/v1/orgs/:tenantId/allowances")
export class AllowanceController {
  constructor(@Inject(ALLOWANCE_SERVICE) private readonly allowances: AllowanceService, @Inject(ENTERPRISE_IDENTITY_REPOSITORY) private readonly identity: EnterpriseIdentityRepository, @Optional() @Inject(AUDIT_SERVICE) private readonly audit?: AuditService) {}

  @Get("/profiles") async profiles(@Req() req:AuthenticatedRequest,@Param("tenantId") tenantId:string){await this.require(req,tenantId,"budgets:read");return z.array(AllowanceProfileSchema).parse(await this.allowances.listProfiles(tenantId));}
  @Post("/profiles") async createProfile(@Req() req:AuthenticatedRequest,@Param("tenantId") tenantId:string,@Body() body:unknown){await this.require(req,tenantId,"budgets:write");const input=parse(AllowanceProfileUpsertSchema,body);const row=await this.allowances.upsertProfile(tenantId,null,{...input,status:input.status??"active"});await this.record(req,tenantId,"allowance-profile-upserted",row.id,row);return AllowanceProfileSchema.parse(row);}
  @Put("/profiles/:id") async updateProfile(@Req() req:AuthenticatedRequest,@Param("tenantId") tenantId:string,@Param("id") id:string,@Body() body:unknown){await this.require(req,tenantId,"budgets:write");const input=parse(AllowanceProfileUpsertSchema,body);const row=await this.allowances.upsertProfile(tenantId,id,{...input,status:input.status??"active"});await this.record(req,tenantId,"allowance-profile-upserted",row.id,row);return AllowanceProfileSchema.parse(row);}
  @Get("/defaults") async defaults(@Req() req:AuthenticatedRequest,@Param("tenantId") tenantId:string){await this.require(req,tenantId,"budgets:read");return this.allowances.listDefaults(tenantId);}
  @Put("/defaults") async setDefault(@Req() req:AuthenticatedRequest,@Param("tenantId") tenantId:string,@Body() body:unknown){await this.require(req,tenantId,"budgets:write");const input=parse(AllowanceDefaultUpsertSchema,body);const row=await this.allowances.upsertDefault(tenantId,input);await this.record(req,tenantId,"allowance-default-upserted",row.id,row);return row;}
  @Post("/limits/bulk") async bulk(@Req() req:AuthenticatedRequest,@Param("tenantId") tenantId:string,@Body() body:unknown){await this.require(req,tenantId,"budgets:write");const input=parse(BulkLimitMutationSchema,body);const result=BulkLimitResultSchema.parse(await this.allowances.bulk(tenantId,input,req.auth!.user.id));if(!input.dryRun)await this.record(req,tenantId,"allowance-bulk-applied",input.idempotencyKey,result);return result;}
  @Post("/limits/import") async importCsv(@Req() req:AuthenticatedRequest,@Param("tenantId") tenantId:string,@Body() body:unknown){return this.bulk(req,tenantId,body);}
  @Get("/limits/export.csv") async exportCsv(@Req() req:AuthenticatedRequest,@Param("tenantId") tenantId:string){await this.require(req,tenantId,"budgets:read");const rows=await this.allowances.listProfiles(tenantId);return ["name,period,soft_limit_micros,hard_limit_micros,request_limit,token_limit,sandbox_minute_limit,status",...rows.map((row)=>[row.name,row.period,row.softLimitMicros??"",row.hardLimitMicros??"",row.requestLimit??"",row.tokenLimit??"",row.sandboxMinuteLimit??"",row.status].join(","))].join("\n");}
  @Get("/effective/:userId") async effective(@Req() req:AuthenticatedRequest,@Param("tenantId") tenantId:string,@Param("userId") userId:string,@Query() query:unknown){await this.require(req,tenantId,"budgets:read");const parsed=parse(EffectiveQuerySchema,query);const member=await this.identity.getMembership(tenantId,userId);if(!member)throw new BadRequestException("Member not found");return EffectiveLimitSchema.parse(await this.allowances.effective(tenantId,userId,member.departmentIds,parsed.metric,parsed.period));}
  @Get("/blocked") async blocked(@Req() req:AuthenticatedRequest,@Param("tenantId") tenantId:string,@Query() query:unknown){await this.require(req,tenantId,"budgets:read");const parsed=parse(PageQuerySchema,query);return BlockedRequestPageSchema.parse(await this.allowances.blocked(tenantId,parsed.cursor,parsed.limit));}
  @Get("/cycle") async cycle(@Req() req:AuthenticatedRequest,@Param("tenantId") tenantId:string){await this.require(req,tenantId,"budgets:read");return AllowanceCycleSettingsSchema.parse(await this.allowances.cycle(tenantId));}
  @Put("/cycle") async updateCycle(@Req() req:AuthenticatedRequest,@Param("tenantId") tenantId:string,@Body() body:unknown){
    await this.require(req,tenantId,"budgets:write");
    const input=parse(AllowanceCycleSettingsUpsertSchema,body);
    let row;
    try { row=await this.allowances.updateCycle(tenantId,input.timezone,input.anchorDay,req.auth!.user.id); }
    catch (cause) { if(cause instanceof RangeError)throw new BadRequestException("Timezone must be a valid IANA timezone");throw cause; }
    await this.record(req,tenantId,"allowance-cycle-updated",tenantId,row);
    return AllowanceCycleSettingsSchema.parse(row);
  }
  @Get("/balances") async balances(@Req() req:AuthenticatedRequest,@Param("tenantId") tenantId:string){
    await this.require(req,tenantId,"budgets:read");
    const members=await this.identity.listMemberships(tenantId);
    const balances=await this.allowances.balances(tenantId,members.map((member)=>member.userId));
    const memberById=new Map(members.map((member)=>[member.userId,member]));
    return z.array(AllowanceBalanceSchema).parse(balances.map((balance)=>{const member=memberById.get(balance.userId);return{...balance,userName:member?.name||null,userEmail:member?.email??null};}));
  }
  @Get("/balance/:userId") async balance(@Req() req:AuthenticatedRequest,@Param("tenantId") tenantId:string,@Param("userId") userId:string){
    await this.require(req,tenantId,"budgets:read");
    const member=await this.identity.getMembership(tenantId,userId);if(!member)throw new BadRequestException("Member not found");
    return AllowanceBalanceSchema.parse({...await this.allowances.balance(tenantId,userId),userName:member.name||null,userEmail:member.email});
  }
  @Put("/members/:userId/base") async updateMemberBase(@Req() req:AuthenticatedRequest,@Param("tenantId") tenantId:string,@Param("userId") userId:string,@Body() body:unknown){
    await this.require(req,tenantId,"budgets:write");
    const member=await this.identity.getMembership(tenantId,userId);if(!member)throw new BadRequestException("Member not found");
    const input=parse(MemberAllowanceBaseUpsertSchema,body);
    const balance=await this.allowances.setMemberBase(tenantId,userId,input.amountMicros,req.auth!.user.id);
    const result=AllowanceBalanceSchema.parse({...balance,userName:member.name||null,userEmail:member.email});
    await this.record(req,tenantId,"allowance-member-base-updated",userId,{amountMicros:input.amountMicros,balance:result});
    return result;
  }
  @Get("/me") async myBalance(@Req() req:AuthenticatedRequest,@Param("tenantId") tenantId:string){
    await this.require(req,tenantId,"org:read");
    const member=await this.identity.getMembership(tenantId,req.auth!.user.id);
    return AllowanceBalanceSchema.parse({...await this.allowances.balance(tenantId,req.auth!.user.id),userName:member?.name||null,userEmail:member?.email??req.auth!.user.email});
  }
  @Get("/adjustments") async adjustments(@Req() req:AuthenticatedRequest,@Param("tenantId") tenantId:string,@Query() query:unknown){await this.require(req,tenantId,"budgets:read");const input=parse(AdjustmentQuerySchema,query);return z.array(AllowanceAdjustmentSchema).parse(await this.allowances.listAdjustments(tenantId,input.userId));}
  @Post("/adjustments") async createAdjustment(@Req() req:AuthenticatedRequest,@Param("tenantId") tenantId:string,@Body() body:unknown){
    await this.require(req,tenantId,"budgets:write");const input=parse(AllowanceAdjustmentCreateSchema,body);
    const member=await this.identity.getMembership(tenantId,input.userId);if(!member)throw new BadRequestException("Member not found");
    const row=await this.allowances.createAdjustment(tenantId,input.userId,input.amountMicros,input.reason,input.idempotencyKey,req.auth!.user.id);
    await this.record(req,tenantId,"allowance-adjustment-created",row.id,row);
    return AllowanceAdjustmentSchema.parse(row);
  }
  private async require(req:AuthenticatedRequest,tenantId:string,permission:OrgPermission){OrgPermissionSchema.parse(permission);if(!await this.identity.authorize(req.auth!.user.id,tenantId,permission))throw new ForbiddenException(`Missing organization permission: ${permission}`);}
  private record(req:AuthenticatedRequest,tenantId:string,action:string,targetId:string,after:unknown){return this.audit?.append({tenantId,actorUserId:req.auth?.user.id??null,category:"budget",action,targetType:"allowance",targetId,after:after as never,metadata:{surface:"admin-api"}});}
}
function parse<T extends z.ZodTypeAny>(schema:T,value:unknown):z.infer<T>{const result=schema.safeParse(value);if(!result.success)throw new BadRequestException(result.error.flatten());return result.data;}
