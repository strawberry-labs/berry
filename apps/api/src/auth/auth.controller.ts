import { All, Body, Controller, Get, Inject, Post, Req, Res } from "@nestjs/common";
import type { IncomingMessage, ServerResponse } from "node:http";
import { PublicAuth } from "./auth.decorators.ts";
import { BerryAuthService } from "./auth-runtime.ts";

@Controller("/v1/auth")
@PublicAuth()
export class BerryAuthController {
  constructor(@Inject(BerryAuthService) private readonly auth: BerryAuthService) {}

  @Get("/config")
  config() {
    return this.auth.describe();
  }

  @Post("/setup")
  setup(@Body() body: unknown) {
    return this.auth.setupOwner(body);
  }

  @All()
  handleRoot(@Req() req: IncomingMessage, @Res() res: ServerResponse) {
    return this.auth.handleNodeRequest(req, res);
  }

  @All("*path")
  handleNested(@Req() req: IncomingMessage, @Res() res: ServerResponse) {
    return this.auth.handleNodeRequest(req, res);
  }
}
