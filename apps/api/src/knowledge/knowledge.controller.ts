import { Controller, Get, Inject, Param, Req, UnauthorizedException } from "@nestjs/common";
import { SELF_HOST_TENANT_ID } from "@berry/db";
import { z } from "zod";
import type { AuthenticatedRequest } from "../auth/auth.guard.js";
import { KnowledgeService } from "./knowledge.service.js";

@Controller("/v1/workspaces/:workspaceId/knowledge")
export class KnowledgeController {
  constructor(@Inject(KnowledgeService) private readonly knowledge: KnowledgeService) {}

  @Get("/outcomes")
  outcomes(@Req() request: AuthenticatedRequest, @Param("workspaceId") workspaceId: string) {
    const userId = request.auth?.user.id;
    if (!userId) throw new UnauthorizedException("Authentication required");
    return this.knowledge.listTaskOutcomes({
      tenantId: process.env.BERRY_TENANT_ID?.trim() || SELF_HOST_TENANT_ID,
      userId,
      workspaceId: z.string().uuid().parse(workspaceId),
    });
  }
}
