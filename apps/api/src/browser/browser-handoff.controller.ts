import { BadRequestException, Body, Controller, Get, Header, Inject, Optional, Param, Post, Req, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { SELF_HOST_TENANT_ID } from "@berry/db";
import { BrowserSessionReceiptSchema } from "@berry/shared";
import { z } from "zod";
import type { AuthenticatedRequest } from "../auth/auth.guard.js";
import { BrowserHandoffService } from "./browser-handoff.service.js";
const BrowserId = BrowserSessionReceiptSchema.shape.sessionId;
const Request = z.object({ browserId: BrowserId }).strict();
const Connection = Request.extend({ control: z.boolean().default(false) });
const Resume = Request.extend({ handoffId: z.string().uuid() });
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException("Invalid browser control request");
  return result.data;
}
@Controller("/v1/sessions/:sessionId/browser")
export class BrowserHandoffController {
  constructor(@Optional() @Inject(BrowserHandoffService) private readonly handoffs?: BrowserHandoffService) {}
  private scope(request: AuthenticatedRequest, sessionId: string) {
    if (!request.auth?.user.id) throw new UnauthorizedException("Authentication required");
    if (!this.handoffs) throw new ServiceUnavailableException("Browser takeover requires the durable runner");
    return { service: this.handoffs, tenantId: process.env.BERRY_TENANT_ID?.trim() || SELF_HOST_TENANT_ID, userId: request.auth.user.id, sessionId: parse(z.string().uuid(), sessionId) };
  }
  @Get() @Header("Cache-Control", "no-store")
  state(@Req() request: AuthenticatedRequest, @Param("sessionId") sessionId: string) {
    const { service, tenantId, userId } = this.scope(request, sessionId);
    return service.state(tenantId, userId, sessionId);
  }
  @Post("take-control") @Header("Cache-Control", "no-store")
  takeControl(@Req() request: AuthenticatedRequest, @Param("sessionId") sessionId: string, @Body() body: unknown) {
    const input = parse(Request, body), { service, tenantId, userId } = this.scope(request, sessionId);
    return service.request(tenantId, userId, sessionId, input.browserId);
  }
  @Post("connection") @Header("Cache-Control", "no-store") @Header("Referrer-Policy", "no-referrer")
  connection(@Req() request: AuthenticatedRequest, @Param("sessionId") sessionId: string, @Body() body: unknown) {
    const input = parse(Connection, body), { service, tenantId, userId } = this.scope(request, sessionId);
    return service.connection(tenantId, userId, sessionId, input.browserId, input.control ?? false);
  }
  @Post("resume") @Header("Cache-Control", "no-store")
  resume(@Req() request: AuthenticatedRequest, @Param("sessionId") sessionId: string, @Body() body: unknown) {
    const input = parse(Resume, body), { service, tenantId, userId } = this.scope(request, sessionId);
    return service.resume(tenantId, userId, sessionId, input.browserId, input.handoffId);
  }
}
