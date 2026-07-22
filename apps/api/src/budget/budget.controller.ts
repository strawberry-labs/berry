import { BadRequestException, Body, Controller, ForbiddenException, Get, Inject, Optional, Param, Put, Req } from "@nestjs/common";
import { BudgetLimitSchema, OrgPermissionSchema, type OrgPermission } from "@berry/shared";
import { z } from "zod";
import { AUDIT_SERVICE, type AuditService } from "../audit/audit.service.ts";
import type { AuthenticatedRequest } from "../auth/auth.guard.ts";
import { ENTERPRISE_IDENTITY_REPOSITORY, type EnterpriseIdentityRepository } from "../identity/identity.repository.ts";
import { BUDGET_SERVICE, type BudgetService } from "./budget.service.ts";

const UpsertBudgetLimitRequestSchema = z.object({
  scopeType: z.enum(["org", "department", "user"]),
  scopeId: z.string().trim().min(1),
  period: z.enum(["day", "month"]),
  softLimitMicros: z.string().regex(/^\d+$/),
  hardLimitMicros: z.string().regex(/^\d+$/),
  requestLimit: z.number().int().nonnegative().nullable().optional(),
  tokenLimit: z.number().int().nonnegative().nullable().optional(),
  sandboxMinuteLimit: z.number().int().nonnegative().nullable().optional(),
  thresholdPercentages: z.array(z.number().int().min(1).max(100)).min(1).optional(),
  status: z.enum(["active", "disabled"]),
}).strict();

@Controller("/v1/orgs/:tenantId/budgets")
export class BudgetController {
  constructor(
    @Inject(BUDGET_SERVICE) private readonly budgets: BudgetService,
    @Inject(ENTERPRISE_IDENTITY_REPOSITORY) private readonly identity: EnterpriseIdentityRepository,
    @Optional() @Inject(AUDIT_SERVICE) private readonly audit?: AuditService,
  ) {}

  @Get("/limits")
  async listLimits(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string) {
    await this.requirePermission(request, tenantId, "budgets:read");
    return z.array(BudgetLimitSchema).parse(await this.budgets.listLimits(tenantId));
  }

  @Put("/limits")
  async upsertLimit(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string, @Body() body: unknown) {
    await this.requirePermission(request, tenantId, "budgets:write");
    const parsed = parseBody(UpsertBudgetLimitRequestSchema, body);
    const limit = BudgetLimitSchema.parse(await this.budgets.upsertLimit({ tenantId, ...parsed }));
    await this.audit?.append({
      tenantId,
      actorUserId: request.auth?.user.id ?? null,
      category: "budget",
      action: "limit-upserted",
      targetType: "budget_limit",
      targetId: `${limit.scopeType}:${limit.scopeId}:${limit.period}`,
      after: limit as never,
      metadata: { surface: "admin-api" },
    });
    return limit;
  }

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
