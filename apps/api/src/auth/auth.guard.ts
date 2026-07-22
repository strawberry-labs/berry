import { Inject, Injectable } from "@nestjs/common";
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { IncomingMessage } from "node:http";
import { BERRY_AUTH_PUBLIC } from "./auth.decorators.ts";
import { BerryAuthService, type BerryAuthSession } from "./auth-runtime.ts";

export type AuthenticatedRequest = IncomingMessage & {
  auth?: BerryAuthSession;
  user?: BerryAuthSession["user"];
};

@Injectable()
export class BerryAuthGuard implements CanActivate {
  constructor(
    @Inject(BerryAuthService) private readonly auth: BerryAuthService,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(BERRY_AUTH_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const session = await this.auth.requireSession(request.headers);
    request.auth = session;
    request.user = session.user;
    return true;
  }
}
