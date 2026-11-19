import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Param, ParseUUIDPipe, Post, Req } from "@nestjs/common";
import {
  MobilePairingClaimRequestSchema,
  MobilePairingPollRequestSchema,
  type MobileDeviceRegistration,
  type MobilePairingClaimResponse,
  type MobilePairingCreateResponse,
  type MobilePairingPollResponse,
  type MobilePairingStatus,
  type MobileServerInfo,
  type OrgPermission,
} from "@berry/shared";
import type { z } from "zod";
import { PublicAuth } from "../auth/auth.decorators.ts";
import type { AuthenticatedRequest } from "../auth/auth.guard.ts";
import { ENTERPRISE_IDENTITY_REPOSITORY, type EnterpriseIdentityRepository } from "../identity/identity.repository.ts";
import { MobilePairingService } from "./mobile-pairing.service.ts";

@Controller("/v1/mobile")
export class MobileController {
  constructor(@Inject(MobilePairingService) private readonly pairing: MobilePairingService) {}

  /** Lets the app confirm a scanned server, its brand, and compatibility before claiming. */
  @Get("/server-info")
  @PublicAuth()
  serverInfo(): Promise<MobileServerInfo> {
    return this.pairing.serverInfo();
  }

  @Post("/pairings")
  createPairing(@Req() request: AuthenticatedRequest): Promise<MobilePairingCreateResponse> {
    return this.pairing.createPairing(request.auth!);
  }

  @Post("/pairings/claim")
  @PublicAuth()
  @HttpCode(200)
  claim(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<MobilePairingClaimResponse> {
    return this.pairing.claim(parse(MobilePairingClaimRequestSchema, body), this.clientIp(request));
  }

  @Post("/pairings/poll")
  @PublicAuth()
  @HttpCode(200)
  poll(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<MobilePairingPollResponse> {
    return this.pairing.poll(parse(MobilePairingPollRequestSchema, body), {
      ip: this.clientIp(request),
      userAgent: headerValue(request.headers["user-agent"])?.slice(0, 256) ?? null,
      closed: () => Boolean(request.socket?.destroyed),
    });
  }

  @Get("/pairings/:id")
  getPairing(@Req() request: AuthenticatedRequest, @Param("id", new ParseUUIDPipe()) id: string): Promise<MobilePairingStatus> {
    return this.pairing.getPairing(request.auth!, id);
  }

  @Post("/pairings/:id/approve")
  @HttpCode(200)
  approve(@Req() request: AuthenticatedRequest, @Param("id", new ParseUUIDPipe()) id: string): Promise<MobilePairingStatus> {
    return this.pairing.decide(request.auth!, id, "approved");
  }

  @Post("/pairings/:id/deny")
  @HttpCode(200)
  deny(@Req() request: AuthenticatedRequest, @Param("id", new ParseUUIDPipe()) id: string): Promise<MobilePairingStatus> {
    return this.pairing.decide(request.auth!, id, "denied");
  }

  @Delete("/pairings/:id")
  async cancel(@Req() request: AuthenticatedRequest, @Param("id", new ParseUUIDPipe()) id: string): Promise<{ ok: true }> {
    await this.pairing.cancel(request.auth!, id);
    return { ok: true };
  }

  @Get("/devices")
  listDevices(@Req() request: AuthenticatedRequest): Promise<MobileDeviceRegistration[]> {
    return this.pairing.listDevices(request.auth!);
  }

  @Delete("/devices/:deviceId")
  async revokeDevice(@Req() request: AuthenticatedRequest, @Param("deviceId") deviceId: string): Promise<{ ok: true }> {
    if (!await this.pairing.revokeOwnDevice(request.auth!, deviceId)) throw new NotFoundException("Device not found");
    return { ok: true };
  }

  /** The app's own sign-out: revokes the bearer session that made this call. */
  @Delete("/session")
  async signOut(@Req() request: AuthenticatedRequest): Promise<{ ok: true }> {
    await this.pairing.signOutCurrentDevice(request.auth!);
    return { ok: true };
  }

  private clientIp(request: AuthenticatedRequest): string | null {
    return this.pairing.clientIp(request.headers, request.socket?.remoteAddress);
  }
}

@Controller("/v1/orgs/:tenantId/members/:userId/mobile-devices")
export class MobileDeviceAdminController {
  constructor(
    @Inject(MobilePairingService) private readonly pairing: MobilePairingService,
    @Inject(ENTERPRISE_IDENTITY_REPOSITORY) private readonly identity: EnterpriseIdentityRepository,
  ) {}

  @Get()
  async list(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId", new ParseUUIDPipe()) userId: string,
  ): Promise<MobileDeviceRegistration[]> {
    await this.require(request, tenantId, "members:read");
    return this.pairing.listMemberDevices(userId);
  }

  @Delete("/:deviceId")
  async revoke(
    @Req() request: AuthenticatedRequest,
    @Param("tenantId") tenantId: string,
    @Param("userId", new ParseUUIDPipe()) userId: string,
    @Param("deviceId") deviceId: string,
  ): Promise<{ ok: true }> {
    await this.require(request, tenantId, "members:write");
    if (!await this.pairing.revokeMemberDevice(request.auth!, userId, deviceId)) throw new NotFoundException("Device not found");
    return { ok: true };
  }

  private async require(request: AuthenticatedRequest, tenantId: string, permission: OrgPermission): Promise<void> {
    if (tenantId !== this.pairing.tenantId) throw new NotFoundException("Organization not found");
    if (!await this.identity.authorize(request.auth!.user.id, tenantId, permission)) {
      throw new ForbiddenException(`Missing organization permission: ${permission}`);
    }
  }
}

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException(result.error.flatten());
  return result.data;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
