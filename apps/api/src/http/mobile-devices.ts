import { randomUUID } from "node:crypto";
import { SELF_HOST_TENANT_ID } from "@berry/db";
import {
  ApprovalPushPayloadSchema,
  MobileDeviceRegistrationCreateSchema,
  MobileDeviceRegistrationSchema,
  type ApprovalPushPayload,
  type MobileDeviceRegistration,
  type MobileDeviceRegistrationCreate,
} from "@berry/shared";

export const MOBILE_DEVICE_REGISTRY = Symbol("MOBILE_DEVICE_REGISTRY");

export interface RegisterMobileDeviceInput extends MobileDeviceRegistrationCreate {
  tenantId?: string | null | undefined;
  userId?: string | null | undefined;
}

export interface MobileDeviceRegistry {
  register(input: RegisterMobileDeviceInput): Promise<MobileDeviceRegistration>;
  list(input: { tenantId?: string | null | undefined; userId?: string | null | undefined }): Promise<MobileDeviceRegistration[]>;
  disable(input: { tenantId?: string | null | undefined; userId?: string | null | undefined; deviceId: string }): Promise<boolean>;
}

export class InMemoryMobileDeviceRegistry implements MobileDeviceRegistry {
  readonly #devices = new Map<string, MobileDeviceRegistration & { pushToken: string | null }>();

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
    this.#devices.set(key, { ...device, pushToken: parsed.pushToken ?? null });
    return device;
  }

  async list(input: { tenantId?: string | null | undefined; userId?: string | null | undefined }): Promise<MobileDeviceRegistration[]> {
    const tenantId = input.tenantId ?? SELF_HOST_TENANT_ID;
    return [...this.#devices.values()]
      .filter((device) => device.tenantId === tenantId && device.status === "active" && (!input.userId || device.userId === input.userId))
      .map(stripPushToken);
  }

  async disable(input: { tenantId?: string | null | undefined; userId?: string | null | undefined; deviceId: string }): Promise<boolean> {
    const tenantId = input.tenantId ?? SELF_HOST_TENANT_ID;
    const key = `${tenantId}:${input.deviceId}`;
    const device = this.#devices.get(key);
    if (!device || (input.userId && device.userId !== input.userId)) return false;
    const now = new Date().toISOString();
    this.#devices.set(key, { ...device, status: "disabled", updatedAt: now, lastSeenAt: now });
    return true;
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

function stripPushToken(device: MobileDeviceRegistration & { pushToken?: string | null | undefined }): MobileDeviceRegistration {
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
    createdAt: device.createdAt,
    updatedAt: device.updatedAt,
    lastSeenAt: device.lastSeenAt,
  });
}
