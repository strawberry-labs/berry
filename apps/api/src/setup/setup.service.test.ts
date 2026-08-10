import { describe, expect, it, vi } from "vitest";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import {
  probeS3Storage,
  SetupOrganizationInputSchema,
  SetupService,
} from "./setup.service.ts";

const tenantId = "00000000-0000-7000-8000-000000000001";
const setupToken = "setup-token-with-at-least-thirty-two-characters";

describe("SetupService", () => {
  it("accepts only HTTPS organization logo URLs", () => {
    const organization = {
      organizationName: "AESG",
      applicationName: "AESG AI",
      accentColor: "#7c6df2",
      timezone: "Asia/Dubai",
    };

    expect(SetupOrganizationInputSchema.safeParse({ ...organization, logoUrl: "https://assets.aesg.com/logo.svg" }).success).toBe(true);
    expect(SetupOrganizationInputSchema.safeParse({ ...organization, logoUrl: "http://assets.aesg.com/logo.svg" }).success).toBe(false);
    expect(SetupOrganizationInputSchema.safeParse({ ...organization, logoUrl: "ftp://assets.aesg.com/logo.svg" }).success).toBe(false);
    expect(SetupOrganizationInputSchema.safeParse({ ...organization, logoUrl: "not-a-url" }).success).toBe(false);
  });

  it("verifies the complete artifact S3 lifecycle and removes the canary", async () => {
    const body = { transformToByteArray: vi.fn(async () => new Uint8Array([1])) };
    const send = vi.fn(async (command: object) => {
      if (command instanceof CreateMultipartUploadCommand) return { UploadId: "probe-upload" };
      if (command instanceof UploadPartCommand) return { ETag: "probe-etag" };
      if (command instanceof CompleteMultipartUploadCommand) return { VersionId: "probe-version" };
      if (command instanceof GetObjectCommand) return { Body: body };
      return {};
    });

    await expect(probeS3Storage({ send } as never, { bucket: "artifacts", purpose: "artifact" })).resolves.toBe(true);

    expect(send.mock.calls.map(([command]) => command.constructor)).toEqual([
      HeadBucketCommand,
      CreateMultipartUploadCommand,
      UploadPartCommand,
      CompleteMultipartUploadCommand,
      HeadObjectCommand,
      GetObjectCommand,
      DeleteObjectCommand,
    ]);
    expect(body.transformToByteArray).toHaveBeenCalledOnce();
    const deletion = send.mock.calls.find(([command]) => command instanceof DeleteObjectCommand)?.[0] as DeleteObjectCommand;
    expect(deletion.input.VersionId).toBe("probe-version");
  });

  it("fails artifact readiness when object reads fail and still removes the canary", async () => {
    const send = vi.fn(async (command: object) => {
      if (command instanceof CreateMultipartUploadCommand) return { UploadId: "probe-upload" };
      if (command instanceof UploadPartCommand) return { ETag: "probe-etag" };
      if (command instanceof GetObjectCommand) throw new Error("GetObject denied");
      return {};
    });

    await expect(probeS3Storage({ send } as never, { bucket: "artifacts", purpose: "artifact" })).rejects.toThrow("GetObject denied");
    expect(send.mock.calls.some(([command]) => command instanceof DeleteObjectCommand)).toBe(true);
    expect(send.mock.calls.some(([command]) => command instanceof AbortMultipartUploadCommand)).toBe(false);
  });

  it("checks write access without requiring deletion on the audit bucket", async () => {
    const send = vi.fn(async (_command: object) => ({}));

    await expect(probeS3Storage({ send } as never, { bucket: "audit", purpose: "audit" })).resolves.toBe(true);

    expect(send.mock.calls.map(([command]) => command.constructor)).toEqual([
      HeadBucketCommand,
      PutObjectCommand,
    ]);
    expect((send.mock.calls[1]?.[0] as PutObjectCommand).input.IfNoneMatch).toBe("*");
  });

  it("accepts an existing immutable audit probe after S3 authorizes the conditional write", async () => {
    const send = vi.fn(async (command: object) => {
      if (command instanceof PutObjectCommand) {
        throw Object.assign(new Error("already exists"), { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } });
      }
      return {};
    });

    await expect(probeS3Storage({ send } as never, { bucket: "audit", purpose: "audit" })).resolves.toBe(true);
  });

  it("exchanges the one-time key for a signed, short-lived HttpOnly setup cookie", () => {
    const service = setupService();

    expect(() => service.unlock("wrong", "127.0.0.1")).toThrow("invalid");
    const value = service.unlock(setupToken, "127.0.0.1");
    const cookie = service.cookieHeader(value);

    expect(value.split(".")).toHaveLength(2);
    expect(cookie).toContain("berry_setup=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("Max-Age=1800");
  });

  it("returns resumable setup state without returning OAuth secrets", async () => {
    const service = setupService();
    const value = service.unlock(setupToken, "127.0.0.1");
    const status = await service.status(`berry_setup=${value}`);

    expect(status).toMatchObject({
      required: true,
      unlocked: true,
      systemReady: true,
      foundationConfigured: true,
      currentStep: 5,
      readyToClaim: true,
      ownerEmail: "strawberry@aesg.com",
      applicationName: "AESG AI",
      sso: { configured: true, clientSecretConfigured: true, hostedDomain: "aesg.com" },
      connectors: { configured: true, clientSecretConfigured: true, pickerConfigured: true },
    });
    expect(JSON.stringify(status)).not.toContain("sso-plaintext-secret");
    expect(JSON.stringify(status)).not.toContain("connector-plaintext-secret");
  });

  it("publishes the configured enterprise SSO callback without changing the connector callback", async () => {
    const service = setupService({
      env: {
        BERRY_AUTH_GOOGLE_REDIRECT_URI: "https://ai.aesg.com/v1/auth/sso/callback/aesg",
      },
    });
    const value = service.unlock(setupToken, "127.0.0.1");

    const status = await service.status(`berry_setup=${value}`);

    expect(status.sso.callbackUrl).toBe("https://ai.aesg.com/v1/auth/sso/callback/aesg");
    expect(status.connectors.callbackUrl).toBe("https://ai.aesg.com/v1/connectors/google/callback");
  });

  it("publishes versioned Berry branding URLs for S3-backed logo and favicon files", async () => {
    const logoFileId = "00000000-0000-7000-8000-000000000204";
    const faviconFileId = "00000000-0000-7000-8000-000000000205";
    const status = await setupService({ profileBranding: { applicationName: "AESG AI", logoFileId, faviconFileId } }).status();

    expect(status.organization.logoUrl).toBe(`/v1/branding/logo?v=${logoFileId}`);
    expect(status.organization.faviconUrl).toBe(`/v1/branding/favicon?v=${faviconFileId}`);
  });

  it("keeps deployment and contact details private until setup is unlocked", async () => {
    const status = await setupService().status();

    expect(status).toMatchObject({
      unlocked: false,
      ownerEmail: null,
      readyToClaim: false,
      organization: { supportEmail: null, securityEmail: null },
      sso: { clientId: null, clientSecretConfigured: false },
      connectors: { clientId: null, clientSecretConfigured: false, pickerProjectNumber: null },
      checks: [],
    });
  });

  it("retains an encrypted Picker key when connector policy is edited", async () => {
    const identity = {
      getSsoConnection: vi.fn(async () => ({ domains: ["aesg.com"] })),
    };
    const connectors = {
      googleConfiguration: vi.fn(async () => ({ pickerConfigured: true, pickerProjectNumber: "123456789012" })),
      configureGoogle: vi.fn(async () => undefined),
      updateBuiltIn: vi.fn(async () => undefined),
    };
    const service = setupService({ identity, connectors });
    const cookie = `berry_setup=${service.unlock(setupToken, "127.0.0.1")}`;

    await service.saveGoogleConnectors(cookie, {
      clientId: "connectors.apps.googleusercontent.com",
      drive: { enabled: true, access: "selected_files", maxAccessLevel: "read" },
      gmail: { enabled: true, maxAccessLevel: "read" },
      calendar: { enabled: false, maxAccessLevel: "read" },
    });

    expect(connectors.configureGoogle).toHaveBeenCalledWith(tenantId, "setup", {
      clientId: "connectors.apps.googleusercontent.com",
      hostedDomain: "aesg.com",
      pickerProjectNumber: "123456789012",
    });
  });

  it("blocks owner claim when Redis or either S3 bucket is unreachable", async () => {
    const probes = {
      redis: vi.fn(async () => false),
      storage: vi.fn(async () => false),
    };
    const service = setupService({ probes });
    const value = service.unlock(setupToken, "127.0.0.1");

    const status = await service.status(`berry_setup=${value}`);

    expect(status).toMatchObject({ currentStep: 1, readyToClaim: false });
    expect(status.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "redis", status: "fail", blocking: true }),
      expect.objectContaining({ id: "storage", status: "fail", blocking: true }),
    ]));
    expect(probes.storage).toHaveBeenCalledTimes(2);
    expect(probes.storage).toHaveBeenCalledWith(expect.objectContaining({ bucket: "berry-aesg-production" }));
    expect(probes.storage).toHaveBeenCalledWith(expect.objectContaining({ bucket: "berry-aesg-audit" }));
  });

  it("blocks setup when the connector encryption key is malformed", async () => {
    const service = setupService({ env: { BERRY_CONNECTOR_ENCRYPTION_KEY: "connector-encryption-key" } });
    const value = service.unlock(setupToken, "127.0.0.1");

    const status = await service.status(`berry_setup=${value}`);

    expect(status).toMatchObject({ currentStep: 1, systemReady: false, readyToClaim: false });
    expect(status.checks).toContainEqual(expect.objectContaining({ id: "encryption", status: "fail", blocking: true }));
  });

  it("expires setup attempt limits after fifteen minutes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-09T00:00:00.000Z"));
    try {
      const service = setupService();
      for (let attempt = 0; attempt < 8; attempt += 1) {
        expect(() => service.unlock("wrong", "127.0.0.1")).toThrow("invalid");
      }
      expect(() => service.unlock(setupToken, "127.0.0.1")).toThrow("Too many setup attempts");

      vi.advanceTimersByTime(15 * 60_000 + 1);
      expect(service.unlock(setupToken, "127.0.0.1")).toContain(".");
    } finally {
      vi.useRealTimers();
    }
  });

  it("requires an explicit server-side foundation checkpoint before accepting setup data", async () => {
    const service = setupService({ deploymentSetup: { foundationConfigured: false } });
    const cookie = `berry_setup=${service.unlock(setupToken, "127.0.0.1")}`;

    await expect(service.saveOrganization(cookie, {})).rejects.toThrow("Confirm the production foundation");

    const status = await service.confirmFoundation(cookie);
    expect(status).toMatchObject({ systemReady: true, foundationConfigured: true, currentStep: 5 });
  });

  it("rejects setup mutations when a blocking foundation probe fails", async () => {
    const service = setupService({
      probes: {
        redis: vi.fn(async () => false),
        storage: vi.fn(async () => true),
      },
    });
    const cookie = `berry_setup=${service.unlock(setupToken, "127.0.0.1")}`;

    await expect(service.saveOrganization(cookie, {})).rejects.toThrow("Blocking production foundation checks must pass");
  });
});

function setupService(overrides: {
  identity?: { getSsoConnection: ReturnType<typeof vi.fn> };
  connectors?: {
    googleConfiguration: ReturnType<typeof vi.fn>;
    configureGoogle: ReturnType<typeof vi.fn>;
    updateBuiltIn: ReturnType<typeof vi.fn>;
  };
  probes?: {
    redis: ReturnType<typeof vi.fn>;
    storage: ReturnType<typeof vi.fn>;
  };
  deploymentSetup?: Record<string, unknown>;
  profileBranding?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
} = {}) {
  const deploymentSetup: Record<string, unknown> = {
    foundationConfigured: true,
    organizationConfigured: true,
    connectorsConfigured: true,
    applicationName: "AESG AI",
    accentColor: "#7c6df2",
    ...overrides.deploymentSetup,
  };
  const database = {
    selfHostTenantId: tenantId,
    ping: vi.fn(async () => undefined),
    withTenant: vi.fn(async (_tenantId: string, callback: (db: { query: (sql: string) => Promise<unknown[]>; execute: (sql: string, params?: readonly unknown[]) => Promise<void> }) => Promise<unknown>) => callback({
      query: async (sql: string) => {
        if (sql.includes("SELECT name, settings FROM tenants")) return [{ name: "AESG", settings: { deploymentSetup } }];
        if (sql.includes("SELECT settings FROM tenants")) return [{ settings: { deploymentSetup } }];
        if (sql.includes("FROM organization_profiles")) return [{ logo_url: null, support_email: "support@aesg.com", security_email: "security@aesg.com", timezone: "Asia/Dubai", branding: overrides.profileBranding ?? { applicationName: "AESG AI" } }];
        if (sql.includes("FROM sso_connections")) return [{ client_id: "sso.apps.googleusercontent.com", client_secret_envelope: { ciphertext: "sso-plaintext-secret" }, domains: ["aesg.com"], jit_provisioning: true, status: "enabled" }];
        if (sql.includes("FROM connector_provider_credentials")) return [{ client_id: "connectors.apps.googleusercontent.com", client_secret_envelope: { ciphertext: "connector-plaintext-secret" }, picker_api_key_envelope: { ciphertext: "picker-secret" }, picker_project_number: "123456789012" }];
        if (sql.includes("FROM organization_connectors")) return [{ connector_key: "google-workspace", enabled: true, max_access_level: "read", workspace_access_mode: "selected_files" }];
        if (sql.includes("SELECT EXISTS")) return [{ exists: false }];
        return [];
      },
      execute: async (sql: string, params: readonly unknown[] = []) => {
        if (!sql.includes("'{deploymentSetup}'")) return;
        const serialized = params.find((value) => typeof value === "string" && value.startsWith("{"));
        if (typeof serialized === "string") Object.assign(deploymentSetup, JSON.parse(serialized));
      },
    })),
  };
  return new SetupService(database as never, (overrides.identity ?? { getSsoConnection: vi.fn() }) as never, (overrides.connectors ?? {}) as never, {
    NODE_ENV: "production",
    BETTER_AUTH_SECRET: "better-auth-secret-with-at-least-thirty-two-characters",
    BERRY_SETUP_TOKEN: setupToken,
    BERRY_SETUP_OWNER_EMAIL: "strawberry@aesg.com",
    BERRY_TENANT_ID: tenantId,
    BERRY_REDIS_URL: "redis://redis:6379",
    BERRY_ARTIFACT_S3_BUCKET: "berry-aesg-production",
    BERRY_AUDIT_S3_BUCKET: "berry-aesg-audit",
    BERRY_CONNECTOR_ENCRYPTION_KEY: Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"),
    BERRY_AUTH_BASE_URL: "https://ai.aesg.com",
    BERRY_API_MODEL_MODE: "live",
    BERRY_ROUTER_INFERENCE_BASE_URL: "https://router.aesg.com/v1",
    ...overrides.env,
  }, (overrides.probes ?? {
    redis: vi.fn(async () => true),
    storage: vi.fn(async () => true),
  }) as never);
}
