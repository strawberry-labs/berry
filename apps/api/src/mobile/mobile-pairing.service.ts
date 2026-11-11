import { ForbiddenException, GoneException, HttpException, HttpStatus, Inject, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { SELF_HOST_TENANT_ID } from "@berry/db";
import {
  MOBILE_MANUAL_CODE_ALPHABET,
  MOBILE_MANUAL_CODE_LENGTH,
  MOBILE_PAIRING_APPROVAL_WINDOW_SECONDS,
  MOBILE_PAIRING_POLL_TIMEOUT_MS,
  MOBILE_PAIRING_TTL_SECONDS,
  MOBILE_PROTOCOL_VERSION,
  MobileCapabilitySchema,
  buildMobilePairingUri,
  formatMobileManualCode,
  normalizeMobileManualCode,
  normalizeMobileServerOrigin,
  type MobileBrand,
  type MobileDeviceRegistration,
  type MobilePairingClaimRequest,
  type MobilePairingClaimResponse,
  type MobilePairingCreateResponse,
  type MobilePairingPollRequest,
  type MobilePairingPollResponse,
  type MobilePairingStatus,
  type MobileServerInfo,
} from "@berry/shared";
import { AUDIT_SERVICE, type AuditService } from "../audit/audit.service.ts";
import { BerryAuthService, type BerryAuthSession } from "../auth/auth-runtime.ts";
import { MANAGEMENT_SERVICE, type ManagementService } from "../management/management.service.ts";
import { MOBILE_DEVICE_REGISTRY, type MobileDeviceRegistry } from "../http/mobile-devices.ts";
import { MOBILE_PAIRING_STORE, type MobilePairingRecord, type MobilePairingStore } from "./mobile-pairing.store.ts";
import { MOBILE_RATE_LIMITER, type MobileRateLimiter } from "./mobile-rate-limiter.ts";

export const MOBILE_PAIRING_CONFIG = Symbol("MOBILE_PAIRING_CONFIG");

export type MobilePairingConfig = {
  tenantId: string;
  /** Public origin of the web app, shown to users and opened for admin tasks. */
  serverUrl: string;
  /** Public origin the app calls for /v1; the same as serverUrl behind the bundled proxy. */
  apiUrl: string;
  serverVersion: string;
  minimumAppVersion: string;
  capabilities: string[];
  /** Trusted proxy headers carrying the client address, most trusted first. */
  ipHeaders: string[];
  loadBrand: () => Promise<MobileBrand>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  pollTimeoutMs?: number;
};

export function mobilePairingConfigFromEnv(env: NodeJS.ProcessEnv, loadBrand?: () => Promise<MobileBrand>): MobilePairingConfig {
  // Behind the bundled proxy the API and web share one origin, which is also
  // Better Auth's base URL. Split local setups (web :3108, API :3001) need
  // nothing extra; phones testing over a LAN set BERRY_PUBLIC_API_URL.
  const apiUrl = normalizeMobileServerOrigin(env.BERRY_PUBLIC_API_URL ?? "")
    ?? originOf(env.BERRY_AUTH_BASE_URL)
    ?? "http://localhost:3001";
  const serverUrl = normalizeMobileServerOrigin(env.BERRY_WEB_PUBLIC_URL ?? "") ?? apiUrl;
  const ipHeaders = (env.BERRY_AUTH_IP_ADDRESS_HEADERS ?? "x-berry-client-ip")
    .split(",")
    .map((header) => header.trim().toLowerCase())
    .filter(Boolean);
  const applicationName = env.BERRY_APPLICATION_NAME?.trim() || "Berry";
  return {
    tenantId: env.BERRY_TENANT_ID?.trim() || SELF_HOST_TENANT_ID,
    serverUrl,
    apiUrl,
    serverVersion: env.BERRY_VERSION?.trim() || "0.1.0",
    minimumAppVersion: env.BERRY_MOBILE_MINIMUM_APP_VERSION?.trim() || "0.1.0",
    capabilities: [...MobileCapabilitySchema.options],
    ipHeaders,
    loadBrand: loadBrand ?? (async () => ({ applicationName, logoUrl: null, accentColor: null })),
  };
}

const INVALID_CODE_MESSAGE = "This sign-in code is no longer valid. Show a new code on your computer and try again.";
const STALE_PAIRING_RETENTION_MS = 24 * 60 * 60 * 1000;
const POLL_INTERVAL_MS = 1_000;

@Injectable()
export class MobilePairingService {
  constructor(
    @Inject(MOBILE_PAIRING_STORE) private readonly store: MobilePairingStore,
    @Inject(MOBILE_DEVICE_REGISTRY) private readonly devices: MobileDeviceRegistry,
    @Inject(MOBILE_RATE_LIMITER) private readonly limiter: MobileRateLimiter,
    @Inject(MOBILE_PAIRING_CONFIG) private readonly config: MobilePairingConfig,
    @Inject(BerryAuthService) private readonly auth: BerryAuthService,
    @Optional() @Inject(MANAGEMENT_SERVICE) private readonly management?: ManagementService,
    @Optional() @Inject(AUDIT_SERVICE) private readonly audit?: AuditService,
  ) {}

  get tenantId(): string {
    return this.config.tenantId;
  }

  clientIp(headers: IncomingHttpHeaders, socketAddress: string | undefined): string | null {
    for (const header of this.config.ipHeaders) {
      const value = headers[header];
      const first = (Array.isArray(value) ? value[0] : value)?.split(",")[0]?.trim();
      if (first) return first.slice(0, 64);
    }
    return socketAddress?.slice(0, 64) ?? null;
  }

  async serverInfo(): Promise<MobileServerInfo> {
    const brand = await this.config.loadBrand().catch(() => ({ applicationName: "Berry", logoUrl: null, accentColor: null }));
    return {
      protocolVersion: MOBILE_PROTOCOL_VERSION,
      serverVersion: this.config.serverVersion,
      minimumAppVersion: this.config.minimumAppVersion,
      capabilities: this.config.capabilities,
      mobileEnabled: await this.mobileEnabled(),
      serverUrl: this.config.serverUrl,
      apiUrl: this.config.apiUrl,
      brand: { ...brand, logoUrl: absoluteUrl(brand.logoUrl, this.config.apiUrl) },
    };
  }

  async createPairing(session: BerryAuthSession): Promise<MobilePairingCreateResponse> {
    if (session.session.clientKind === "mobile") {
      throw new ForbiddenException({ code: "mobile_pairing_requires_web", message: "Add another phone from Berry on your computer." });
    }
    await this.requireEnabled();
    await this.limit(`create:user:${session.user.id}`, 20, 600);
    const now = this.now();
    const tenantId = this.config.tenantId;
    await this.store.cancelOpenForCreator(tenantId, session.session.id, now);
    await this.store.deleteStale(tenantId, new Date(now.getTime() - STALE_PAIRING_RETENTION_MS)).catch(() => undefined);
    const secret = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now.getTime() + MOBILE_PAIRING_TTL_SECONDS * 1000);
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const manualCode = generateManualCode();
      try {
        const record = await this.store.create({
          tenantId,
          userId: session.user.id,
          creatorSessionId: session.session.id,
          secretHash: sha256(secret),
          manualCodeHash: sha256(manualCode),
          expiresAt,
        });
        await this.record(session.user.id, "mobile.pairing.created", record.id, { expiresAt: expiresAt.toISOString() });
        return {
          id: record.id,
          qrPayload: buildMobilePairingUri({ serverUrl: this.config.serverUrl, apiUrl: this.config.apiUrl, pairingId: record.id, secret }),
          manualCode: formatMobileManualCode(manualCode),
          serverUrl: this.config.serverUrl,
          ...(this.config.apiUrl !== this.config.serverUrl ? { apiUrl: this.config.apiUrl } : {}),
          expiresAt: expiresAt.toISOString(),
        };
      } catch (error) {
        // A pending manual code collided; draw another one.
        lastError = error;
      }
    }
    throw lastError;
  }

  async getPairing(session: BerryAuthSession, id: string): Promise<MobilePairingStatus> {
    const record = await this.store.get(this.config.tenantId, id);
    if (!record || record.creatorSessionId !== session.session.id) throw new NotFoundException("Pairing not found");
    return this.publicStatus(record);
  }

  async decide(session: BerryAuthSession, id: string, decision: "approved" | "denied"): Promise<MobilePairingStatus> {
    if (decision === "approved") await this.requireEnabled();
    const record = await this.store.decide(this.config.tenantId, id, session.session.id, decision, this.now());
    if (!record) {
      const current = await this.store.get(this.config.tenantId, id);
      if (!current || current.creatorSessionId !== session.session.id) throw new NotFoundException("Pairing not found");
      throw new GoneException({ code: "mobile_pairing_not_actionable", message: "This sign-in request is no longer waiting for approval.", status: this.publicStatus(current).status });
    }
    await this.record(session.user.id, decision === "approved" ? "mobile.pairing.approved" : "mobile.pairing.denied", record.id, {
      device: record.device,
      claimedIp: record.claimedIp,
    });
    return this.publicStatus(record);
  }

  async cancel(session: BerryAuthSession, id: string): Promise<void> {
    await this.store.cancel(this.config.tenantId, id, session.session.id, this.now());
  }

  async claim(request: MobilePairingClaimRequest, ip: string | null): Promise<MobilePairingClaimResponse> {
    await this.limit(`claim:ip:${ip ?? "unknown"}`, 10, 60);
    await this.requireEnabled();
    const now = this.now();
    const tenantId = this.config.tenantId;
    let record: MobilePairingRecord | null;
    if ("manualCode" in request) {
      // Manual codes are short, so failures are also limited across the whole
      // deployment to keep guessing a live code impractical.
      await this.limit(`claim:manual:${tenantId}`, 60, 60);
      const code = normalizeMobileManualCode(request.manualCode);
      record = code ? await this.store.findPendingByManualCodeHash(tenantId, sha256(code), now) : null;
    } else {
      record = await this.store.get(tenantId, request.pairingId);
      if (record && !hashMatches(request.secret, record.secretHash)) record = null;
    }
    if (!record || record.status !== "pending" || record.expiresAt <= now) {
      throw new NotFoundException({ code: "mobile_pairing_invalid", message: INVALID_CODE_MESSAGE });
    }
    const claimToken = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now.getTime() + MOBILE_PAIRING_APPROVAL_WINDOW_SECONDS * 1000);
    const claimed = await this.store.claim(tenantId, record.id, { claimTokenHash: sha256(claimToken), device: request.device, claimedIp: ip, expiresAt, now });
    if (!claimed) throw new NotFoundException({ code: "mobile_pairing_invalid", message: INVALID_CODE_MESSAGE });
    const brand = await this.config.loadBrand().catch(() => ({ applicationName: "Berry", logoUrl: null, accentColor: null }));
    return { pairingId: claimed.id, claimToken, expiresAt: expiresAt.toISOString(), brand: { ...brand, logoUrl: absoluteUrl(brand.logoUrl, this.config.apiUrl) } };
  }

  /**
   * Long-polls until the web user decides. On approval the first poll to
   * win the approved → completed transition mints the phone's session, so no
   * session token is ever stored with the pairing.
   */
  async poll(request: MobilePairingPollRequest, client: { ip: string | null; userAgent: string | null; closed?: () => boolean }): Promise<MobilePairingPollResponse> {
    await this.limit(`poll:ip:${client.ip ?? "unknown"}`, 90, 60);
    const tenantId = this.config.tenantId;
    const claimTokenHash = sha256(request.claimToken);
    const deadline = Date.now() + (this.config.pollTimeoutMs ?? MOBILE_PAIRING_POLL_TIMEOUT_MS);
    for (;;) {
      const record = await this.store.get(tenantId, request.pairingId);
      if (!record || !record.claimTokenHash || !hashMatches(request.claimToken, record.claimTokenHash)) {
        throw new NotFoundException({ code: "mobile_pairing_invalid", message: INVALID_CODE_MESSAGE });
      }
      const now = this.now();
      if (record.status === "denied" || record.status === "cancelled") return { status: "denied" };
      if (record.status === "completed" || record.expiresAt <= now) return { status: "expired" };
      if (record.status === "approved") {
        const completed = await this.store.complete(tenantId, record.id, claimTokenHash, now);
        if (completed) return this.issue(completed, client);
      }
      if (Date.now() >= deadline || client.closed?.()) return { status: "awaiting" };
      await (this.config.sleep ?? delay)(POLL_INTERVAL_MS);
    }
  }

  async listDevices(session: BerryAuthSession): Promise<MobileDeviceRegistration[]> {
    return this.devices.list({ tenantId: this.config.tenantId, userId: session.user.id, currentSessionId: session.session.id });
  }

  async revokeOwnDevice(session: BerryAuthSession, deviceId: string): Promise<boolean> {
    const revoked = await this.devices.disable({ tenantId: this.config.tenantId, userId: session.user.id, deviceId, revokedByUserId: session.user.id });
    if (revoked) await this.record(session.user.id, "mobile.device.revoked", deviceId, { actor: "user" });
    return revoked;
  }

  async signOutCurrentDevice(session: BerryAuthSession): Promise<void> {
    if (session.session.clientKind !== "mobile") {
      throw new ForbiddenException({ code: "mobile_session_required", message: "Only a paired phone can sign itself out here." });
    }
    await this.devices.disableForSession({ tenantId: this.config.tenantId, sessionId: session.session.id });
    await this.record(session.user.id, "mobile.session.signed_out", session.session.id, { actor: "self" });
  }

  async listMemberDevices(memberUserId: string): Promise<MobileDeviceRegistration[]> {
    return this.devices.list({ tenantId: this.config.tenantId, userId: memberUserId });
  }

  async revokeMemberDevice(admin: BerryAuthSession, memberUserId: string, deviceId: string): Promise<boolean> {
    const revoked = await this.devices.disable({ tenantId: this.config.tenantId, userId: memberUserId, deviceId, revokedByUserId: admin.user.id });
    if (revoked) await this.record(admin.user.id, "mobile.device.revoked", deviceId, { actor: "admin", memberUserId });
    return revoked;
  }

  private async issue(record: MobilePairingRecord, client: { ip: string | null; userAgent: string | null }): Promise<MobilePairingPollResponse> {
    const tenantId = this.config.tenantId;
    try {
      const grant = await this.auth.createMobileSession({ userId: record.userId, ipAddress: client.ip, userAgent: client.userAgent });
      const device = await this.devices.pair({
        tenantId,
        userId: record.userId,
        authSessionId: grant.sessionId,
        device: record.device ?? { model: "Phone", platform: "ios", osVersion: "unknown", appVersion: "unknown" },
        ip: client.ip,
      });
      await this.store.attachResult(tenantId, record.id, { mobileSessionId: grant.sessionId, mobileDeviceId: device.id });
      await this.record(record.userId, "mobile.device.paired", device.deviceId, { device: record.device, claimedIp: record.claimedIp });
      return { status: "approved", sessionToken: grant.token, sessionExpiresAt: grant.expiresAt, deviceId: device.deviceId, user: grant.user };
    } catch (error) {
      await this.store.fail(tenantId, record.id, this.now()).catch(() => undefined);
      // An inactive membership is refused by the session-create hook.
      if (isForbidden(error)) return { status: "denied" };
      throw error;
    }
  }

  private publicStatus(record: MobilePairingRecord): MobilePairingStatus {
    const open = record.status === "pending" || record.status === "claimed" || record.status === "approved";
    return {
      id: record.id,
      status: open && record.expiresAt <= this.now() ? "expired" : record.status,
      expiresAt: record.expiresAt.toISOString(),
      device: record.device,
      claimedIp: record.claimedIp,
    };
  }

  private async mobileEnabled(): Promise<boolean> {
    if (!this.management) return true;
    const policy = await this.management.getAuthentication(this.config.tenantId);
    return policy.mobileAppEnabled !== false;
  }

  private async requireEnabled(): Promise<void> {
    if (!await this.mobileEnabled()) {
      throw new ForbiddenException({ code: "mobile_app_disabled", message: "Your organization has turned off the Berry mobile app." });
    }
  }

  private async limit(key: string, limit: number, windowSeconds: number): Promise<void> {
    if (!await this.limiter.consume(key, limit, windowSeconds)) {
      throw new HttpException({ code: "mobile_pairing_rate_limited", message: "Too many attempts. Wait a minute and try again." }, HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  private now(): Date {
    return this.config.now?.() ?? new Date();
  }

  private async record(actorUserId: string, action: string, targetId: string, metadata: Record<string, unknown>): Promise<void> {
    await this.audit?.append({
      tenantId: this.config.tenantId,
      actorUserId,
      category: "authentication",
      action,
      targetType: "mobile_device",
      targetId,
      metadata: JSON.parse(JSON.stringify({ surface: "mobile-pairing", ...metadata })),
    }).catch(() => undefined);
  }
}

function isForbidden(error: unknown): boolean {
  if (error instanceof HttpException) return error.getStatus() === HttpStatus.FORBIDDEN;
  const candidate = error as { status?: unknown; statusCode?: unknown } | null;
  return candidate?.status === "FORBIDDEN" || candidate?.statusCode === HttpStatus.FORBIDDEN;
}

function generateManualCode(): string {
  let code = "";
  for (let index = 0; index < MOBILE_MANUAL_CODE_LENGTH; index += 1) {
    code += MOBILE_MANUAL_CODE_ALPHABET[randomInt(MOBILE_MANUAL_CODE_ALPHABET.length)];
  }
  return code;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashMatches(value: string, expectedHash: string): boolean {
  const actual = Buffer.from(sha256(value), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function originOf(value: string | undefined): string | null {
  if (!value) return null;
  const match = /^(https?:\/\/[^/?#]+)/i.exec(value.trim());
  return match ? normalizeMobileServerOrigin(match[1]!) : null;
}

function absoluteUrl(value: string | null, base: string): string | null {
  if (!value) return null;
  if (/^https:\/\//i.test(value)) return value;
  if (value.startsWith("/") && !value.startsWith("//")) return `${base}${value}`;
  return null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
