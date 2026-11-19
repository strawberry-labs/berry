import { randomUUID } from "node:crypto";
import { SELF_HOST_TENANT_ID } from "@berry/db";
import {
  ApprovalPushPayloadSchema,
  MobileDeviceRegistrationCreateSchema,
  MobileDeviceRegistrationSchema,
  type ApprovalPushPayload,
  type MobileDeviceRegistration,
  type MobileDeviceRegistrationCreate,
  type MobilePairingDevice,
} from "@berry/shared";
import type { CloudDatabaseService } from "../db/cloud-database.service.ts";

export const MOBILE_DEVICE_REGISTRY = Symbol("MOBILE_DEVICE_REGISTRY");

export interface RegisterMobileDeviceInput extends MobileDeviceRegistrationCreate {
  tenantId?: string | null | undefined;
  userId?: string | null | undefined;
}

export type PairMobileDeviceInput = {
  tenantId: string;
  userId: string;
  authSessionId: string;
  device: MobilePairingDevice;
  ip: string | null;
};

export type ListMobileDevicesInput = {
  tenantId?: string | null | undefined;
  userId?: string | null | undefined;
  /** Marks the device whose session made the request as `current`. */
  currentSessionId?: string | null | undefined;
};

export type DisableMobileDeviceInput = {
  tenantId?: string | null | undefined;
  userId?: string | null | undefined;
  deviceId: string;
  revokedByUserId?: string | null | undefined;
};

export interface MobileDeviceRegistry {
  register(input: RegisterMobileDeviceInput): Promise<MobileDeviceRegistration>;
  list(input: ListMobileDevicesInput): Promise<MobileDeviceRegistration[]>;
  /** Disables a device and signs it out by deleting its session. */
  disable(input: DisableMobileDeviceInput): Promise<boolean>;
  /** Records a phone that completed QR pairing, bound to its new session. */
  pair(input: PairMobileDeviceInput): Promise<MobileDeviceRegistration>;
  /** Signs out the device that owns this session (the app's own sign-out). */
  disableForSession(input: { tenantId: string; sessionId: string }): Promise<boolean>;
  /** Updates last-seen details; implementations throttle writes. */
  touchSession(input: { tenantId: string; sessionId: string; ip: string | null }): Promise<void>;
}

type StoredDevice = MobileDeviceRegistration & { pushToken: string | null; authSessionId: string | null };

/**
 * Test and development registry. It cannot delete Better Auth sessions on its
 * own, so callers that need revocation pass `revokeSession`.
 */
export class InMemoryMobileDeviceRegistry implements MobileDeviceRegistry {
  readonly #devices = new Map<string, StoredDevice>();

  constructor(private readonly revokeSession: (sessionId: string) => Promise<void> = async () => undefined) {}

  async register(input: RegisterMobileDeviceInput): Promise<MobileDeviceRegistration> {
    const { tenantId: tenantIdInput, userId, ...registrationInput } = input;
    const parsed = MobileDeviceRegistrationCreateSchema.parse(registrationInput);
    const now = new Date().toISOString();
    const tenantId = tenantIdInput ?? SELF_HOST_TENANT_ID;
    const key = `${tenantId}:${parsed.deviceId}`;
    const existing = this.#devices.get(key);
    const device = MobileDeviceRegistrationSchema.parse({
      id: existing?.id ?? `mobile_${randomUUID()}`,
      tenantId,
      userId: userId ?? null,
      deviceId: parsed.deviceId,
      platform: parsed.platform,
      pushProvider: parsed.pushProvider,
      pushTokenLast4: parsed.pushToken ? parsed.pushToken.slice(-4) : null,
      endpointMode: parsed.endpointMode,
      appVersion: parsed.appVersion ?? null,
      capabilities: parsed.capabilities,
      status: "active",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastSeenAt: now,
    });
    this.#devices.set(key, { ...device, pushToken: parsed.pushToken ?? null, authSessionId: existing?.authSessionId ?? null });
    return device;
  }

  async list(input: ListMobileDevicesInput): Promise<MobileDeviceRegistration[]> {
    const tenantId = input.tenantId ?? SELF_HOST_TENANT_ID;
    return [...this.#devices.values()]
      .filter((device) => device.tenantId === tenantId && device.status === "active" && (!input.userId || device.userId === input.userId))
      .map((device) => publicDevice(device, input.currentSessionId));
  }

  async disable(input: DisableMobileDeviceInput): Promise<boolean> {
    const tenantId = input.tenantId ?? SELF_HOST_TENANT_ID;
    const key = `${tenantId}:${input.deviceId}`;
    const device = this.#devices.get(key);
    if (!device || device.status !== "active" || (input.userId && device.userId !== input.userId)) return false;
    const now = new Date().toISOString();
    if (device.authSessionId) await this.revokeSession(device.authSessionId);
    this.#devices.set(key, { ...device, status: "disabled", authSessionId: null, revokedAt: now, updatedAt: now });
    return true;
  }

  async pair(input: PairMobileDeviceInput): Promise<MobileDeviceRegistration> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const device: StoredDevice = {
      ...MobileDeviceRegistrationSchema.parse({
        id,
        tenantId: input.tenantId,
        userId: input.userId,
        deviceId: id,
        platform: input.device.platform,
        pushProvider: "none",
        pushTokenLast4: null,
        endpointMode: "paired",
        appVersion: input.device.appVersion,
        capabilities: ["approvals", "chat", "tasks"],
        status: "active",
        displayName: input.device.model,
        model: input.device.model,
        osVersion: input.device.osVersion,
        pairedAt: now,
        revokedAt: null,
        createdAt: now,
        updatedAt: now,
        lastSeenAt: now,
      }),
      pushToken: null,
      authSessionId: input.authSessionId,
    };
    this.#devices.set(`${input.tenantId}:${id}`, device);
    return publicDevice(device, input.authSessionId);
  }

  async disableForSession(input: { tenantId: string; sessionId: string }): Promise<boolean> {
    const device = [...this.#devices.values()].find((candidate) => candidate.tenantId === input.tenantId && candidate.authSessionId === input.sessionId);
    if (!device) {
      await this.revokeSession(input.sessionId);
      return false;
    }
    return this.disable({ tenantId: input.tenantId, deviceId: device.deviceId });
  }

  async touchSession(input: { tenantId: string; sessionId: string; ip: string | null }): Promise<void> {
    for (const device of this.#devices.values()) {
      if (device.tenantId === input.tenantId && device.authSessionId === input.sessionId) {
        device.lastSeenAt = new Date().toISOString();
      }
    }
  }
}

type DeviceRow = {
  id: string;
  tenant_id: string;
  user_id: string | null;
  device_id: string;
  platform: "ios" | "android" | "expo";
  push_provider: "expo" | "apns" | "fcm" | "none";
  push_token_last4: string | null;
  endpoint_mode: MobileDeviceRegistration["endpointMode"];
  app_version: string | null;
  capabilities: unknown;
  status: "active" | "disabled";
  auth_session_id: string | null;
  display_name: string | null;
  model: string | null;
  os_version: string | null;
  paired_at: Date | string | null;
  revoked_at: Date | string | null;
  last_seen_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
};

const TOUCH_INTERVAL_MS = 5 * 60_000;

export class PostgresMobileDeviceRegistry implements MobileDeviceRegistry {
  readonly #lastTouch = new Map<string, number>();

  constructor(private readonly database: CloudDatabaseService) {}

  async register(input: RegisterMobileDeviceInput): Promise<MobileDeviceRegistration> {
    const { tenantId: tenantIdInput, userId, ...registrationInput } = input;
    const parsed = MobileDeviceRegistrationCreateSchema.parse(registrationInput);
    const tenantId = tenantIdInput ?? SELF_HOST_TENANT_ID;
    return this.database.withTenant(tenantId, async (db) => {
      const rows = await db.query<DeviceRow>(
        `INSERT INTO mobile_devices (tenant_id, user_id, device_id, platform, push_provider, push_token_last4, endpoint_mode, app_version, capabilities, status)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9::jsonb, 'active')
         ON CONFLICT (tenant_id, device_id) DO UPDATE SET
           user_id = EXCLUDED.user_id, platform = EXCLUDED.platform, push_provider = EXCLUDED.push_provider,
           push_token_last4 = EXCLUDED.push_token_last4, endpoint_mode = EXCLUDED.endpoint_mode,
           app_version = EXCLUDED.app_version, capabilities = EXCLUDED.capabilities, status = 'active',
           last_seen_at = now(), updated_at = now()
         WHERE mobile_devices.user_id IS NOT DISTINCT FROM EXCLUDED.user_id
         RETURNING *`,
        [tenantId, userId ?? null, parsed.deviceId, parsed.platform, parsed.pushProvider, parsed.pushToken ? parsed.pushToken.slice(-4) : null, parsed.endpointMode, parsed.appVersion ?? null, JSON.stringify(parsed.capabilities)],
      );
      if (!rows[0]) throw new Error("Device is registered to another user");
      return deviceFromRow(rows[0], null);
    });
  }

  async list(input: ListMobileDevicesInput): Promise<MobileDeviceRegistration[]> {
    const tenantId = input.tenantId ?? SELF_HOST_TENANT_ID;
    return this.database.withTenant(tenantId, async (db) => {
      const rows = await db.query<DeviceRow>(
        `SELECT * FROM mobile_devices
         WHERE tenant_id=$1::uuid AND status='active' AND ($2::uuid IS NULL OR user_id=$2::uuid)
         ORDER BY last_seen_at DESC LIMIT 100`,
        [tenantId, input.userId ?? null],
      );
      return rows.map((row) => deviceFromRow(row, input.currentSessionId));
    });
  }

  async disable(input: DisableMobileDeviceInput): Promise<boolean> {
    const tenantId = input.tenantId ?? SELF_HOST_TENANT_ID;
    return this.database.withTenant(tenantId, async (db) => {
      const rows = await db.query<{ auth_session_id: string | null }>(
        `UPDATE mobile_devices SET status='disabled', revoked_at=now(), revoked_by_user_id=$4::uuid, updated_at=now()
         WHERE tenant_id=$1::uuid AND device_id=$2 AND status='active' AND ($3::uuid IS NULL OR user_id=$3::uuid)
         RETURNING auth_session_id`,
        [tenantId, input.deviceId, input.userId ?? null, input.revokedByUserId ?? null],
      );
      if (!rows[0]) return false;
      // Deleting the session signs the phone out on its next request; the
      // foreign key then clears auth_session_id.
      if (rows[0].auth_session_id) await db.execute("DELETE FROM auth_sessions WHERE id=$1::uuid AND client_kind='mobile'", [rows[0].auth_session_id]);
      return true;
    });
  }

  async pair(input: PairMobileDeviceInput): Promise<MobileDeviceRegistration> {
    const id = randomUUID();
    return this.database.withTenant(input.tenantId, async (db) => {
      const rows = await db.query<DeviceRow>(
        `INSERT INTO mobile_devices (id, tenant_id, user_id, device_id, platform, push_provider, endpoint_mode, app_version, capabilities,
           status, auth_session_id, display_name, model, os_version, paired_at, last_ip)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $1::text, $4, 'none', 'paired', $5, '["approvals","chat","tasks"]'::jsonb,
           'active', $6::uuid, $7, $7, $8, now(), $9)
         RETURNING *`,
        [id, input.tenantId, input.userId, input.device.platform, input.device.appVersion, input.authSessionId, input.device.model, input.device.osVersion, input.ip],
      );
      return deviceFromRow(rows[0]!, input.authSessionId);
    });
  }

  async disableForSession(input: { tenantId: string; sessionId: string }): Promise<boolean> {
    return this.database.withTenant(input.tenantId, async (db) => {
      const rows = await db.query<{ id: string }>(
        `UPDATE mobile_devices SET status='disabled', revoked_at=now(), revoked_by_user_id=user_id, updated_at=now()
         WHERE tenant_id=$1::uuid AND auth_session_id=$2::uuid AND status='active'
         RETURNING id`,
        [input.tenantId, input.sessionId],
      );
      await db.execute("DELETE FROM auth_sessions WHERE id=$1::uuid AND client_kind='mobile'", [input.sessionId]);
      return rows.length > 0;
    });
  }

  async touchSession(input: { tenantId: string; sessionId: string; ip: string | null }): Promise<void> {
    const now = Date.now();
    if ((this.#lastTouch.get(input.sessionId) ?? 0) > now - TOUCH_INTERVAL_MS) return;
    this.#lastTouch.set(input.sessionId, now);
    if (this.#lastTouch.size > 5_000) {
      for (const [sessionId, touchedAt] of this.#lastTouch) if (touchedAt <= now - TOUCH_INTERVAL_MS) this.#lastTouch.delete(sessionId);
    }
    await this.database.withTenant(input.tenantId, (db) => db.execute(
      "UPDATE mobile_devices SET last_seen_at=now(), last_ip=COALESCE($3, last_ip) WHERE tenant_id=$1::uuid AND auth_session_id=$2::uuid AND status='active'",
      [input.tenantId, input.sessionId, input.ip],
    ));
  }
}

export class CompanionPushService {
  approvalPayload(input: { approvalId: string; title?: string | undefined; detail?: string | undefined; createdAt?: string | undefined }): ApprovalPushPayload {
    return ApprovalPushPayloadSchema.parse({
      type: "approval.requested",
      approvalId: input.approvalId,
      title: input.title ?? "Approval required",
      detail: input.detail ?? "Open Berry to approve or deny the agent action.",
      createdAt: input.createdAt ?? new Date().toISOString(),
    });
  }

  async dispatchApproval(input: {
    devices: MobileDeviceRegistration[];
    approvalId: string;
    title?: string | undefined;
    detail?: string | undefined;
  }): Promise<Array<{ deviceId: string; delivered: boolean; provider: string; payload: ApprovalPushPayload }>> {
    const payload = this.approvalPayload(input);
    return input.devices
      .filter((device) => device.status === "active" && device.capabilities.includes("push") && device.pushProvider !== "none")
      .map((device) => ({ deviceId: device.deviceId, delivered: false, provider: device.pushProvider, payload }));
  }
}

function publicDevice(device: StoredDevice, currentSessionId: string | null | undefined): MobileDeviceRegistration {
  return MobileDeviceRegistrationSchema.parse({
    id: device.id,
    tenantId: device.tenantId,
    userId: device.userId,
    deviceId: device.deviceId,
    platform: device.platform,
    pushProvider: device.pushProvider,
    pushTokenLast4: device.pushTokenLast4,
    endpointMode: device.endpointMode,
    appVersion: device.appVersion,
    capabilities: device.capabilities,
    status: device.status,
    displayName: device.displayName ?? null,
    model: device.model ?? null,
    osVersion: device.osVersion ?? null,
    pairedAt: device.pairedAt ?? null,
    revokedAt: device.revokedAt ?? null,
    current: Boolean(currentSessionId && device.authSessionId === currentSessionId),
    createdAt: device.createdAt,
    updatedAt: device.updatedAt,
    lastSeenAt: device.lastSeenAt,
  });
}

function deviceFromRow(row: DeviceRow, currentSessionId: string | null | undefined): MobileDeviceRegistration {
  return MobileDeviceRegistrationSchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    deviceId: row.device_id,
    platform: row.platform,
    pushProvider: row.push_provider,
    pushTokenLast4: row.push_token_last4,
    endpointMode: row.endpoint_mode,
    appVersion: row.app_version,
    capabilities: Array.isArray(row.capabilities) ? row.capabilities.filter((item): item is string => typeof item === "string") : [],
    status: row.status,
    displayName: row.display_name,
    model: row.model,
    osVersion: row.os_version,
    pairedAt: isoOrNull(row.paired_at),
    revokedAt: isoOrNull(row.revoked_at),
    current: Boolean(currentSessionId && row.auth_session_id === currentSessionId),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    lastSeenAt: new Date(row.last_seen_at).toISOString(),
  });
}

function isoOrNull(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}
