import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export const SCIM_BEARER_TOKEN = Symbol("SCIM_BEARER_TOKEN");

@Injectable()
export class ScimBearerGuard implements CanActivate {
  constructor(@Inject(SCIM_BEARER_TOKEN) private readonly expectedToken: string | null) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.expectedToken) {
      throw new UnauthorizedException("SCIM is not configured");
    }
    const request = context.switchToHttp().getRequest<IncomingMessage>();
    const header = request.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    if (!constantTimeEqual(token, this.expectedToken)) {
      throw new UnauthorizedException("Invalid SCIM bearer token");
    }
    return true;
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}
