import { BadRequestException, Body, Controller, ForbiddenException, Get, Inject, Optional, Param, Post, Req } from "@nestjs/common";
import {
  BillingAccountSummarySchema,
  BillingCreditGrantCreateSchema,
  BillingCreditGrantSchema,
  BillingInvoiceSchema,
  BillingMeterEventCreateSchema,
  BillingMeterEventSchema,
  AutoRefillConfigurationSchema,
  CreditLedgerPageSchema,
  OrganizationBillingHealthSchema,
  OrgPermissionSchema,
  type OrgPermission,
} from "@berry/shared";
import { z } from "zod";
import { AUDIT_SERVICE, type AuditService } from "../audit/audit.service.ts";
import type { AuthenticatedRequest } from "../auth/auth.guard.ts";
import { ENTERPRISE_IDENTITY_REPOSITORY, type EnterpriseIdentityRepository } from "../identity/identity.repository.ts";
import { BILLING_SERVICE, type BillingService } from "./billing.service.ts";

@Controller("/v1/orgs/:tenantId/billing")
export class BillingController {
  constructor(
    @Inject(BILLING_SERVICE) private readonly billing: BillingService,
    @Inject(ENTERPRISE_IDENTITY_REPOSITORY) private readonly identity: EnterpriseIdentityRepository,
    @Optional() @Inject(AUDIT_SERVICE) private readonly audit?: AuditService,
  ) {}

  @Get()
  async summaryRoot(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string) {
    return this.summary(request, tenantId);
  }

  @Get("/summary")
  async summary(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string) {
    await this.requirePermission(request, tenantId, "billing:read");
    return BillingAccountSummarySchema.parse(await this.billing.accountSummary(tenantId));
  }

  @Post("/credits")
  async createCreditGrant(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string, @Body() body: unknown) {
    await this.requirePermission(request, tenantId, "billing:write");
    const input = parseBody(BillingCreditGrantCreateSchema, body);
    const grant = BillingCreditGrantSchema.parse(await this.billing.createCreditGrant(tenantId, request.auth?.user.id ?? null, input));
    await this.audit?.append({
      tenantId,
      actorUserId: request.auth?.user.id ?? null,
      category: "billing",
      action: "credit-grant-created",
      targetType: "billing_credit_grant",
      targetId: grant.id,
      after: grant as never,
      metadata: { source: grant.source, amountMicros: grant.amountMicros, currency: grant.currency, reason: input.reason, idempotencyKey: input.idempotencyKey },
    });
    return grant;
  }

  @Post("/meter-events")
  async reportMeterEvent(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string, @Body() body: unknown) {
    await this.requirePermission(request, tenantId, "billing:write");
    const input = parseBody(BillingMeterEventCreateSchema, body);
    const event = BillingMeterEventSchema.parse(await this.billing.reportMeterEvent(tenantId, input));
    await this.audit?.append({
      tenantId,
      actorUserId: request.auth?.user.id ?? null,
      category: "billing",
      action: "meter-event-recorded",
      targetType: "billing_meter_event",
      targetId: event.id,
      after: event as never,
      metadata: { provider: event.provider, status: event.status, meter: event.meter },
    });
    return event;
  }

  @Get("/invoices")
  async invoices(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string) {
    await this.requirePermission(request, tenantId, "billing:read");
    return z.array(BillingInvoiceSchema).parse(await this.billing.listInvoices(tenantId));
  }

  @Get("/health")
  async health(@Req() request:AuthenticatedRequest,@Param("tenantId") tenantId:string){await this.requirePermission(request,tenantId,"billing:read");const summary=await this.billing.accountSummary(tenantId);return OrganizationBillingHealthSchema.parse({status:summary.providerConfigured?"healthy":summary.billingDependencyRequired?"blocked":"not_configured",provider:summary.provider,reservationHealthy:true,ingestHealthy:true,explanation:summary.provider==="none"?"No external billing provider is configured. Organization limits and prepaid grants remain available.":summary.providerConfigured?"Billing provider and usage ingestion are healthy.":"The required billing provider is not configured.",recoveryStatus:null});}

  @Get("/ledger")
  async ledger(@Req() request:AuthenticatedRequest,@Param("tenantId") tenantId:string){await this.requirePermission(request,tenantId,"billing:read");return CreditLedgerPageSchema.parse(await this.billing.ledger(tenantId));}

  @Get("/auto-refill")
  async autoRefill(@Req() request:AuthenticatedRequest,@Param("tenantId") tenantId:string){await this.requirePermission(request,tenantId,"billing:read");return AutoRefillConfigurationSchema.parse(await this.billing.autoRefill(tenantId));}

  @Post("/auto-refill")
  async setAutoRefill(@Req() request:AuthenticatedRequest,@Param("tenantId") tenantId:string,@Body() body:unknown){await this.requirePermission(request,tenantId,"billing:write");const schema=AutoRefillConfigurationSchema.omit({supported:true}).extend({reason:z.string().min(3).max(500),confirmation:z.literal(true),idempotencyKey:z.string().min(8)}).strict();const input=parseBody(schema,body);const current=await this.billing.autoRefill(tenantId);if(!current.supported)throw new BadRequestException("Auto-refill is not supported by the active billing provider");const row=await this.billing.setAutoRefill(tenantId,request.auth?.user.id??null,input);await this.audit?.append({tenantId,actorUserId:request.auth?.user.id??null,category:"billing",action:"auto-refill-updated",targetType:"billing_auto_refill",targetId:tenantId,after:row as never,metadata:{reason:input.reason,idempotencyKey:input.idempotencyKey}});return row;}

  private async requirePermission(request: AuthenticatedRequest, tenantId: string, permission: OrgPermission): Promise<void> {
    OrgPermissionSchema.parse(permission);
    const allowed = await this.identity.authorize(request.auth!.user.id, tenantId, permission);
    if (!allowed) throw new ForbiddenException(`Missing organization permission: ${permission}`);
  }
}

function parseBody<TSchema extends z.ZodTypeAny>(schema: TSchema, body: unknown): z.infer<TSchema> {
  const result = schema.safeParse(body);
  if (!result.success) throw new BadRequestException(result.error.flatten());
  return result.data;
}
