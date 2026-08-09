import { Body, Controller, Delete, ForbiddenException, Get, Inject, Post, Req, Res } from "@nestjs/common";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { PublicAuth } from "../auth/auth.decorators.ts";
import type { SetupService } from "./setup.service.ts";
import { SETUP_SERVICE } from "./setup.tokens.ts";

const UnlockSchema = z.object({ setupToken: z.string().min(1).max(512) }).strict();

@Controller("/v1/setup")
@PublicAuth()
export class SetupController {
  constructor(@Inject(SETUP_SERVICE) private readonly setup: SetupService) {}

  @Get()
  status(@Req() request: IncomingMessage) {
    return this.setup.status(request.headers.cookie);
  }

  @Post("/unlock")
  unlock(@Req() request: IncomingMessage, @Res({ passthrough: true }) response: ServerResponse, @Body() body: unknown) {
    const parsed = UnlockSchema.safeParse(body);
    if (!parsed.success) throw new ForbiddenException("Enter the setup key to continue");
    const forwarded = request.headers["x-forwarded-for"];
    const clientKey = (Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0])?.trim() || request.socket.remoteAddress || "unknown";
    const cookie = this.setup.unlock(parsed.data.setupToken, clientKey);
    response.setHeader("Set-Cookie", this.setup.cookieHeader(cookie));
    return { ok: true };
  }

  @Delete("/unlock")
  lock(@Res({ passthrough: true }) response: ServerResponse) {
    response.setHeader("Set-Cookie", this.setup.clearCookieHeader());
    return { ok: true };
  }

  @Post("/organization")
  organization(@Req() request: IncomingMessage, @Body() body: unknown) {
    return this.setup.saveOrganization(request.headers.cookie, body);
  }

  @Post("/foundation")
  foundation(@Req() request: IncomingMessage) {
    return this.setup.confirmFoundation(request.headers.cookie);
  }

  @Post("/google-sso")
  googleSso(@Req() request: IncomingMessage, @Body() body: unknown) {
    return this.setup.saveGoogleSso(request.headers.cookie, body);
  }

  @Post("/google-connectors")
  googleConnectors(@Req() request: IncomingMessage, @Body() body: unknown) {
    return this.setup.saveGoogleConnectors(request.headers.cookie, body);
  }
}
