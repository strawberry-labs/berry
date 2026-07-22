import { BadRequestException, Body, Controller, ForbiddenException, Get, Header, Inject, Param, Put, Req, ServiceUnavailableException } from "@nestjs/common";
import {
  ManagedPolicyBundleSchema,
  ManagedPolicyPublishRequestSchema,
  ManagedPolicyVersionSchema,
  OrgPermissionSchema,
  type OrgPermission,
} from "@berry/shared";
import { z } from "zod";
import type { AuthenticatedRequest } from "../auth/auth.guard.ts";
import { ENTERPRISE_IDENTITY_REPOSITORY, type EnterpriseIdentityRepository } from "../identity/identity.repository.ts";
import { POLICY_DISTRIBUTION_SERVICE, type PolicyDistributionService } from "./policy-distribution.service.ts";

@Controller("/v1/orgs/:tenantId/policy")
export class PolicyDistributionController {
  constructor(
    @Inject(POLICY_DISTRIBUTION_SERVICE) private readonly policies: PolicyDistributionService,
    @Inject(ENTERPRISE_IDENTITY_REPOSITORY) private readonly identity: EnterpriseIdentityRepository,
  ) {}

  @Get("/versions")
  async listVersions(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string) {
    await this.requirePermission(request, tenantId, "policy:read");
    return z.array(ManagedPolicyVersionSchema).parse(await this.policies.listVersions(tenantId));
  }

  @Get()
  async activeVersion(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string) {
    await this.requirePermission(request, tenantId, "policy:read");
    return ManagedPolicyVersionSchema.nullable().parse(await this.policies.activeVersion(tenantId));
  }

  @Get("/berry-policy.json")
  @Header("Content-Type", "application/json; charset=utf-8")
  async activeBundle(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string) {
    await this.requirePermission(request, tenantId, "policy:read");
    const version = await this.policies.activeVersion(tenantId);
    return ManagedPolicyBundleSchema.nullable().parse(version?.bundle ?? null);
  }

  @Put()
  async publish(@Req() request: AuthenticatedRequest, @Param("tenantId") tenantId: string, @Body() body: unknown) {
    await this.requirePermission(request, tenantId, "policy:write");
    const parsed = parseBody(ManagedPolicyPublishRequestSchema, body);
    try {
      return ManagedPolicyVersionSchema.parse(await this.policies.publish({
        tenantId,
        actorUserId: request.auth?.user.id ?? null,
        body: parsed,
      }));
    } catch (error) {
      if (error instanceof Error && error.message.includes("Policy signing is not configured")) {
        throw new ServiceUnavailableException("Policy signing is not configured");
      }
      throw error;
    }
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
