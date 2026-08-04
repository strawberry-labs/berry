import { BadRequestException, Body, Controller, ForbiddenException, Get, Header, Inject, NotFoundException, Param, Post, Query, Req, UnauthorizedException } from "@nestjs/common";
import {
  CloudUsageDashboardSchema,
  CloudUsageEventRecordSchema,
  CloudUsageIngestRequestSchema,
  CloudUsageRollupSchema,
  OrgPermissionSchema,
  UsageAnalyticsQuerySchema,
  UsageAnalyticsSchema,
  UsageRequestDetailSchema,
  UsageRequestPageSchema,
  type Department,
  type OrgMembership,
  type OrgPermission,
  type UsageAnalytics,
  type UsageRequestDetail,
  type UsageRequestPage,
} from "@berry/shared";
import { z } from "zod";
import type { AuthenticatedRequest } from "../auth/auth.guard.ts";
import { ENTERPRISE_IDENTITY_REPOSITORY, type EnterpriseIdentityRepository } from "../identity/identity.repository.ts";
import { USAGE_REPOSITORY, usageEventsCsv, type UsageEventFilter, type UsageRepository } from "./usage.repository.ts";
import { USAGE_EVENT_VERIFIER, type UsageEventVerifier } from "./usage.signing.ts";

const UsageQuerySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  feature: z.string().trim().min(1).optional(),
  userId: z.string().trim().min(1).optional(),
  departmentId: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  provider: z.string().trim().min(1).optional(),
  status: z.string().trim().min(1).optional(),
  workspaceId: z.string().trim().min(1).optional(),
  agentId: z.string().trim().min(1).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
}).strict();

@Controller("/v1/orgs/:tenantId/usage")
export class UsageController {
  constructor(
    @Inject(USAGE_REPOSITORY) private readonly usage: UsageRepository,
    @Inject(USAGE_EVENT_VERIFIER) private readonly verifier: UsageEventVerifier,
    @Inject(ENTERPRISE_IDENTITY_REPOSITORY) private readonly identity: EnterpriseIdentityRepository,
  ) {}

  @Post("/events")
  async ingestEvent(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string, @Body() body: unknown) {
    await this.requirePermission(request, tenantId, "budgets:write");
    const parsed = parseBody(CloudUsageIngestRequestSchema, body);
    if (!this.verifier.verify(parsed)) throw new UnauthorizedException("Usage event signature is invalid or expired");
    return CloudUsageEventRecordSchema.parse(await this.usage.ingest(tenantId, parsed));
  }

  @Get("/events")
  async listEvents(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string, @Query() query: unknown) {
    await this.requirePermission(request, tenantId, "usage:read");
    return z.array(CloudUsageEventRecordSchema).parse((await this.usage.listEvents(tenantId, usageFilter(query, 100))).map(redactUsageEvent));
  }

  @Get("/rollups")
  async listRollups(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string, @Query() query: unknown) {
    await this.requirePermission(request, tenantId, "usage:read");
    return z.array(CloudUsageRollupSchema).parse(await this.usage.listRollups(tenantId, usageFilter(query)));
  }

  @Get("/dashboard")
  async dashboard(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string, @Query() query: unknown) {
    await this.requirePermission(request, tenantId, "usage:read");
    return CloudUsageDashboardSchema.parse(await this.usage.dashboard(tenantId, usageFilter(query)));
  }

  @Get("/export.csv")
  @Header("content-type", "text/csv; charset=utf-8")
  async exportCsv(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string, @Query() query: unknown) {
    await this.requirePermission(request, tenantId, "usage:export");
    return usageEventsCsv(await this.usage.listEvents(tenantId, usageFilter(query)));
  }

  @Get("/analytics")
  async analytics(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string, @Query() query: unknown) {
    await this.requirePermission(request, tenantId, "usage:read");
    const [analytics, directory] = await Promise.all([
      this.usage.analytics(tenantId, analyticsQuery(query)),
      this.directory(tenantId),
    ]);
    return UsageAnalyticsSchema.parse(enrichAnalytics(analytics, directory));
  }

  @Get("/requests")
  async requests(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string, @Query() query: unknown) {
    await this.requirePermission(request, tenantId, "usage:read");
    const [page, directory] = await Promise.all([
      this.usage.requestPage(tenantId, analyticsQuery(query)),
      this.directory(tenantId),
    ]);
    return UsageRequestPageSchema.parse(enrichRequestPage(page, directory));
  }

  @Get("/requests/:id")
  async requestDetail(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await this.requirePermission(request, tenantId, "usage:read");
    const [detail, directory] = await Promise.all([
      this.usage.requestDetail(tenantId, id),
      this.directory(tenantId),
    ]);
    if (!detail) throw new NotFoundException("Usage request not found");
    return UsageRequestDetailSchema.parse(enrichRequest(detail, directory));
  }

  @Get("/me")
  async myUsage(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string, @Query() query: unknown) {
    await this.requirePermission(request, tenantId, "org:read");
    const parsed = analyticsQuery(query);
    const [analytics, directory] = await Promise.all([
      this.usage.analytics(tenantId, { ...parsed, memberId: request.auth!.user.id }),
      this.directory(tenantId),
    ]);
    return UsageAnalyticsSchema.parse(enrichAnalytics(analytics, directory));
  }

  @Get("/me/requests")
  async myRequests(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string, @Query() query: unknown) {
    await this.requirePermission(request, tenantId, "org:read");
    return UsageRequestPageSchema.parse(
      await this.usage.requestPage(tenantId, analyticsQuery(query), request.auth!.user.id),
    );
  }

  @Get("/me/export.csv")
  @Header("content-type", "text/csv; charset=utf-8")
  async exportMyUsageCsv(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string, @Query() query: unknown) {
    await this.requirePermission(request, tenantId, "org:read");
    return usageEventsCsv(await this.usage.listEvents(tenantId, { ...usageFilter(query), userId: request.auth!.user.id }));
  }

  private async requirePermission(request: AuthenticatedRequest, tenantId: string, permission: OrgPermission): Promise<void> {
    OrgPermissionSchema.parse(permission);
    const allowed = await this.identity.authorize(request.auth!.user.id, tenantId, permission);
    if (!allowed) throw new ForbiddenException(`Missing organization permission: ${permission}`);
  }

  private async directory(tenantId: string): Promise<UsageDirectory> {
    const [memberships, departments] = await Promise.all([
      this.identity.listMemberships(tenantId),
      this.identity.listDepartments(tenantId),
    ]);
    return { memberships, departments };
  }
}

type UsageDirectory = {
  memberships: OrgMembership[];
  departments: Department[];
};

function enrichAnalytics(
  analytics: UsageAnalytics,
  directory: UsageDirectory,
): UsageAnalytics {
  const members = new Map(directory.memberships.map((member) => [member.userId, member]));
  const departments = new Map(directory.departments.map((department) => [department.id, department]));
  return {
    ...analytics,
    breakdowns: Object.fromEntries(
      Object.entries(analytics.breakdowns).map(([key, rows]) => [
        key,
        rows.map((row) => {
          if (!row.id) return { ...row, label: "Unattributed" };
          if (row.dimension === "member") {
            const member = members.get(row.id);
            return member
              ? {
                  ...row,
                  name: member.name || undefined,
                  email: member.email,
                  label: member.name || member.email,
                }
              : { ...row, label: `Unknown member · ${shortId(row.id)}` };
          }
          if (row.dimension === "department") {
            const department = departments.get(row.id);
            return department
              ? { ...row, name: department.name, label: department.name }
              : { ...row, label: `Unknown department · ${shortId(row.id)}` };
          }
          return row;
        }),
      ]),
    ),
  };
}

function enrichRequestPage(
  page: UsageRequestPage,
  directory: UsageDirectory,
): UsageRequestPage {
  return { ...page, items: page.items.map((item) => enrichRequest(item, directory)) };
}

function enrichRequest<TRequest extends UsageRequestDetail | UsageRequestPage["items"][number]>(
  request: TRequest,
  directory: UsageDirectory,
): TRequest {
  const member = directory.memberships.find((item) => item.userId === request.userId);
  const department = directory.departments.find((item) => item.id === request.departmentId);
  return {
    ...request,
    userName: member?.name || null,
    userEmail: member?.email ?? null,
    departmentName: department?.name ?? null,
  };
}

function shortId(value: string): string {
  return value.length <= 8 ? value : value.slice(0, 8);
}

function usageFilter(query: unknown, defaultLimit?: number): UsageEventFilter {
  const parsed = parseBody(UsageQuerySchema, query);
  return {
    from: parsed.from ? new Date(parsed.from) : undefined,
    to: parsed.to ? new Date(parsed.to) : undefined,
    feature: parsed.feature,
    userId: parsed.userId,
    departmentId: parsed.departmentId,
    model: parsed.model,
    provider: parsed.provider,
    status: parsed.status,
    workspaceId: parsed.workspaceId,
    agentId: parsed.agentId,
    cursor: parsed.cursor,
    limit: parsed.limit ?? defaultLimit,
  };
}

function analyticsQuery(query: unknown) {
  const source = query && typeof query === "object" && !Array.isArray(query) ? query as Record<string, unknown> : {};
  const to = typeof source.to === "string" ? source.to : new Date().toISOString();
  const from = typeof source.from === "string" ? source.from : new Date(new Date(to).getTime() - 30 * 86_400_000).toISOString();
  return parseBody(UsageAnalyticsQuerySchema, { ...source, from, to });
}

function redactUsageEvent(event: z.infer<typeof CloudUsageEventRecordSchema>) {
  return { ...event, metadata: {}, signedPayload: {}, signature: null };
}

function parseBody<TSchema extends z.ZodTypeAny>(schema: TSchema, body: unknown): z.infer<TSchema> {
  const result = schema.safeParse(body);
  if (!result.success) throw new BadRequestException(result.error.flatten());
  return result.data;
}
