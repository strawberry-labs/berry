import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { SELF_HOST_TENANT_ID } from "@berry/db";
import {
  FILE_RESPONSE_SECURITY_VERSION,
  isConnectorEncryptionKeyValid,
  ORGANIZATION_FAVICON_MEDIA_TYPES,
  ORGANIZATION_LOGO_MEDIA_TYPES,
} from "@berry/shared";
import { Redis } from "ioredis";
import { z } from "zod";
import type { ConnectorsService } from "../connectors/connectors.service.ts";
import type { CloudDatabaseService } from "../db/cloud-database.service.ts";
import type { EnterpriseIdentityRepository } from "../identity/identity.repository.ts";
import { s3ClientOptions } from "../storage/s3-client-options.ts";
import { resolveGoogleSsoRedirectUri } from "../auth/google-sso-callback.ts";
import { normalizeMediaType } from "../files/file-response-security.ts";

const DomainSchema = z.string().trim().toLowerCase().regex(
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
  "Enter a valid Google Workspace domain",
);

const SETUP_ATTEMPT_WINDOW_MS = 15 * 60_000;
const SETUP_ATTEMPT_LIMIT = 8;
const SETUP_ATTEMPT_CACHE_LIMIT = 4_096;
const STORAGE_PROBE_TIMEOUT_MS = 10_000;

const HttpsUrlSchema = z.string().trim().url().max(2_048).refine(
  (value) => {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  },
  "Use an HTTPS URL",
);

export const SetupOrganizationInputSchema = z.object({
  organizationName: z.string().trim().min(2).max(100),
  applicationName: z.string().trim().min(2).max(60),
  logoUrl: HttpsUrlSchema.nullable().optional(),
  accentColor: z.string().trim().regex(/^#[0-9a-f]{6}$/i).default("#7c6df2"),
  supportEmail: z.string().trim().email().nullable().optional(),
  securityEmail: z.string().trim().email().nullable().optional(),
  timezone: z.string().trim().min(1).max(100).default("UTC"),
}).strict();

export const SetupGoogleSsoInputSchema = z.object({
  clientId: z.string().trim().min(10).max(1_024),
  clientSecret: z.string().trim().min(1).max(8_192).optional(),
  hostedDomain: DomainSchema,
  jitProvisioning: z.literal(true).default(true),
}).strict();

export const SetupGoogleConnectorsInputSchema = z.object({
  clientId: z.string().trim().min(10).max(1_024),
  clientSecret: z.string().trim().min(1).max(8_192).optional(),
  pickerApiKey: z.string().trim().min(1).max(4_096).optional(),
  pickerProjectNumber: z.string().trim().regex(/^\d{6,30}$/).optional(),
  drive: z.object({
    enabled: z.boolean().default(true),
    access: z.enum(["selected_files", "search_workspace"]).default("selected_files"),
    maxAccessLevel: z.enum(["read", "full"]).default("read"),
  }).default({ enabled: true, access: "selected_files", maxAccessLevel: "read" }),
  gmail: z.object({
    enabled: z.boolean().default(false),
    maxAccessLevel: z.enum(["read", "full"]).default("read"),
  }).default({ enabled: false, maxAccessLevel: "read" }),
  calendar: z.object({
    enabled: z.boolean().default(false),
    maxAccessLevel: z.enum(["read", "full"]).default("read"),
  }).default({ enabled: false, maxAccessLevel: "read" }),
}).strict();

type SetupDraft = {
  foundationConfigured?: boolean;
  foundationVerifiedAt?: string;
  organizationConfigured?: boolean;
  connectorsConfigured?: boolean;
  applicationName?: string;
  accentColor?: string;
};

type SetupCookiePayload = { exp: number; nonce: string };

export type SetupReadinessProbes = {
  redis(url: string): Promise<boolean>;
  storage(input: {
    bucket: string;
    purpose: "artifact" | "audit";
    endpoint?: string | undefined;
    region?: string | undefined;
    accessKeyId?: string | undefined;
    secretAccessKey?: string | undefined;
  }): Promise<boolean>;
};

type SetupCheck = {
  id: string;
  label: string;
  status: "pass" | "warning" | "fail";
  detail: string;
  blocking: boolean;
};

export type SetupStatus = Awaited<ReturnType<SetupService["status"]>>;

@Injectable()
export class SetupService {
  readonly #tenantId: string;
  readonly #attempts = new Map<string, { count: number; resetsAt: number }>();
  readonly #probes: SetupReadinessProbes;

  constructor(
    private readonly database: CloudDatabaseService,
    private readonly identity: EnterpriseIdentityRepository,
    private readonly connectors: ConnectorsService,
    private readonly env: NodeJS.ProcessEnv = process.env,
    probes: SetupReadinessProbes = defaultSetupReadinessProbes,
  ) {
    this.#tenantId = env.BERRY_TENANT_ID ?? SELF_HOST_TENANT_ID;
    this.#probes = probes;
  }

  async status(cookieHeader?: string) {
    await this.database.ping();
    const snapshot = await this.database.withTenant(this.#tenantId, async (db) => {
      const [tenant] = await db.query<{ name: string; settings: unknown }>(
        "SELECT name, settings FROM tenants WHERE id=$1::uuid AND deleted_at IS NULL LIMIT 1",
        [this.#tenantId],
      );
      if (!tenant) throw new ServiceUnavailableException("The configured Berry tenant has not been seeded");
      const [profile] = await db.query<{
        logo_url: string | null;
        support_email: string | null;
        security_email: string | null;
        timezone: string;
        branding: unknown;
      }>("SELECT logo_url,support_email,security_email,timezone,branding FROM organization_profiles WHERE tenant_id=$1::uuid LIMIT 1", [this.#tenantId]);
      const profileBranding = record(profile?.branding);
      const brandingFileIds = [uuidValue(profileBranding.logoFileId), uuidValue(profileBranding.faviconFileId)]
        .filter((value): value is string => Boolean(value));
      const brandingFiles = brandingFileIds.length > 0
        ? await db.query<BrandingFileAvailability>(`
          SELECT id, media_type, detected_media_type, status
          FROM files
          WHERE tenant_id=$1::uuid AND id=ANY($2::uuid[]) AND deleted_at IS NULL
        `, [this.#tenantId, brandingFileIds])
        : [];
      const [sso] = await db.query<{
        client_id: string | null;
        client_secret_envelope: unknown;
        domains: unknown;
        jit_provisioning: boolean;
        status: string;
      }>("SELECT client_id,client_secret_envelope,domains,jit_provisioning,status FROM sso_connections WHERE tenant_id=$1::uuid AND provider='google' AND slug='google-workspace' LIMIT 1", [this.#tenantId]);
      const [connector] = await db.query<{
        client_id: string;
        client_secret_envelope: unknown;
        picker_api_key_envelope: unknown;
        picker_project_number: string | null;
      }>("SELECT client_id,client_secret_envelope,picker_api_key_envelope,picker_project_number FROM connector_provider_credentials WHERE tenant_id=$1::uuid AND provider='google' LIMIT 1", [this.#tenantId]);
      const builtIns = await db.query<{ connector_key: string; enabled: boolean; max_access_level: "read" | "full"; workspace_access_mode: "selected_files" | "search_workspace" | null }>(
        "SELECT connector_key,enabled,max_access_level,workspace_access_mode FROM organization_connectors WHERE tenant_id=$1::uuid AND provider='google'",
        [this.#tenantId],
      );
      const [owner] = await db.query<{ exists: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM tenant_memberships WHERE tenant_id=$1::uuid AND role='owner' AND status='active') AS exists",
        [this.#tenantId],
      );
      return { tenant, profile, brandingFiles, sso, connector, builtIns, completed: owner?.exists === true };
    });

    const settings = record(snapshot.tenant.settings);
    const draft = record(settings.deploymentSetup) as SetupDraft;
    const branding = record(snapshot.profile?.branding);
    const domain = Array.isArray(snapshot.sso?.domains) && typeof snapshot.sso.domains[0] === "string" ? snapshot.sso.domains[0] : null;
    const completed = snapshot.completed;
    const unlocked = !completed && this.verifyCookie(cookieHeader);
    const checks = unlocked ? await this.readinessChecks() : [];
    const systemReady = completed || (unlocked && checks.every((check) => !check.blocking || check.status === "pass"));
    const foundationConfigured = draft.foundationConfigured === true;
    const organizationConfigured = draft.organizationConfigured === true;
    const ssoConfigured = Boolean(snapshot.sso?.status === "enabled" && snapshot.sso.client_id && snapshot.sso.client_secret_envelope && domain);
    const connectorsConfigured = draft.connectorsConfigured === true && Boolean(snapshot.connector?.client_id && snapshot.connector.client_secret_envelope);
    const currentStep = completed ? 5 : !systemReady || !foundationConfigured ? 1 : !organizationConfigured ? 2 : !ssoConfigured ? 3 : !connectorsConfigured ? 4 : 5;
    const applicationName = stringValue(draft.applicationName) ?? stringValue(branding.applicationName) ?? "Berry";
    const logoFileId = uuidValue(branding.logoFileId);
    const faviconFileId = uuidValue(branding.faviconFileId);
    const logoFileAvailable = brandingFileAvailable(snapshot.brandingFiles, logoFileId, ORGANIZATION_LOGO_MEDIA_TYPES);
    const faviconFileAvailable = brandingFileAvailable(snapshot.brandingFiles, faviconFileId, ORGANIZATION_FAVICON_MEDIA_TYPES);
    const byKey = new Map(snapshot.builtIns.map((item) => [item.connector_key, item]));
    return {
      required: !completed,
      completed,
      unlocked,
      systemReady,
      foundationConfigured,
      currentStep,
      ownerEmail: unlocked ? normalizeEmail(this.env.BERRY_SETUP_OWNER_EMAIL) : null,
      applicationName,
      organization: {
        configured: organizationConfigured,
        name: snapshot.tenant.name,
        applicationName,
        logoUrl: logoFileAvailable ? `/v1/branding/logo?v=${encodeURIComponent(logoFileId!)}&sv=${FILE_RESPONSE_SECURITY_VERSION}` : snapshot.profile?.logo_url ?? null,
        faviconUrl: faviconFileAvailable ? `/v1/branding/favicon?v=${encodeURIComponent(faviconFileId!)}&sv=${FILE_RESPONSE_SECURITY_VERSION}` : null,
        accentColor: stringValue(draft.accentColor) ?? stringValue(branding.accentColor) ?? "#7c6df2",
        supportEmail: unlocked ? snapshot.profile?.support_email ?? null : null,
        securityEmail: unlocked ? snapshot.profile?.security_email ?? null : null,
        timezone: snapshot.profile?.timezone ?? "UTC",
      },
      sso: {
        configured: ssoConfigured,
        clientId: unlocked ? snapshot.sso?.client_id ?? null : null,
        clientSecretConfigured: unlocked && Boolean(snapshot.sso?.client_secret_envelope),
        hostedDomain: domain,
        jitProvisioning: snapshot.sso?.jit_provisioning ?? true,
        callbackUrl: resolveGoogleSsoRedirectUri(this.env),
      },
      connectors: {
        configured: connectorsConfigured,
        clientId: unlocked ? snapshot.connector?.client_id ?? null : null,
        clientSecretConfigured: unlocked && Boolean(snapshot.connector?.client_secret_envelope),
        pickerConfigured: unlocked && Boolean(snapshot.connector?.picker_api_key_envelope && snapshot.connector.picker_project_number),
        pickerProjectNumber: unlocked ? snapshot.connector?.picker_project_number ?? null : null,
        callbackUrl: `${this.publicBaseUrl()}/v1/connectors/google/callback`,
        drive: unlocked ? connectorView(byKey.get("google-workspace"), "selected_files") : connectorView(undefined, "selected_files"),
        gmail: unlocked ? connectorView(byKey.get("gmail")) : connectorView(undefined),
        calendar: unlocked ? connectorView(byKey.get("google-calendar")) : connectorView(undefined),
      },
      checks: unlocked ? checks : [],
      steps: [
        { id: "system", label: "System check", status: stepStatus(completed || (systemReady && foundationConfigured), currentStep === 1) },
        { id: "organization", label: "Organization", status: stepStatus(completed || organizationConfigured, currentStep === 2) },
        { id: "sso", label: "Google SSO", status: stepStatus(completed || ssoConfigured, currentStep === 3) },
        { id: "connectors", label: "Google connectors", status: stepStatus(completed || connectorsConfigured, currentStep === 4) },
        { id: "review", label: "Review & claim", status: completed ? "complete" : currentStep === 5 ? "current" : "pending" },
      ],
      readyToClaim: unlocked && !completed && systemReady && foundationConfigured && organizationConfigured && ssoConfigured && connectorsConfigured,
    } as const;
  }

  unlock(setupToken: string, clientKey: string): string {
    const now = Date.now();
    this.pruneAttempts(now, clientKey);
    const current = this.#attempts.get(clientKey);
    if (current && current.resetsAt > now && current.count >= SETUP_ATTEMPT_LIMIT) {
      throw new ForbiddenException("Too many setup attempts. Wait 15 minutes and try again.");
    }
    const configured = this.env.BERRY_SETUP_TOKEN?.trim() ?? "";
    if (configured.length < 32 || !secureEqual(setupToken, configured)) {
      const next = current && current.resetsAt > now ? { ...current, count: current.count + 1 } : { count: 1, resetsAt: now + SETUP_ATTEMPT_WINDOW_MS };
      this.#attempts.delete(clientKey);
      this.#attempts.set(clientKey, next);
      throw new ForbiddenException("The setup key is invalid");
    }
    this.#attempts.delete(clientKey);
    const payload: SetupCookiePayload = { exp: Math.floor(Date.now() / 1000) + 30 * 60, nonce: randomUUID() };
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${body}.${this.sign(body)}`;
  }

  cookieHeader(value: string): string {
    const secure = this.env.NODE_ENV === "production" ? "; Secure" : "";
    return `berry_setup=${value}; Path=/v1/setup; HttpOnly; SameSite=Strict; Max-Age=1800${secure}`;
  }

  clearCookieHeader(): string {
    const secure = this.env.NODE_ENV === "production" ? "; Secure" : "";
    return `berry_setup=; Path=/v1/setup; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
  }

  async confirmFoundation(cookieHeader: string | undefined) {
    const status = await this.requireOpen(cookieHeader);
    if (!status.systemReady) {
      throw new ServiceUnavailableException("Blocking production foundation checks must pass before setup can continue");
    }
    await this.database.withTenant(this.#tenantId, async (db) => {
      const rows = await db.query<{ settings: unknown }>("SELECT settings FROM tenants WHERE id=$1::uuid FOR UPDATE", [this.#tenantId]);
      const settings = record(rows[0]?.settings);
      const setup = {
        ...record(settings.deploymentSetup),
        foundationConfigured: true,
        foundationVerifiedAt: new Date().toISOString(),
      };
      await db.execute("UPDATE tenants SET settings=jsonb_set(settings,'{deploymentSetup}',$2::jsonb,true),updated_at=now() WHERE id=$1::uuid", [this.#tenantId, JSON.stringify(setup)]);
    });
    return this.status(cookieHeader);
  }

  async saveOrganization(cookieHeader: string | undefined, input: unknown) {
    await this.requireReady(cookieHeader, "foundation");
    const parsed = parseInput(SetupOrganizationInputSchema, input);
    await this.database.withTenant(this.#tenantId, async (db) => {
      const rows = await db.query<{ settings: unknown }>("SELECT settings FROM tenants WHERE id=$1::uuid FOR UPDATE", [this.#tenantId]);
      const settings = record(rows[0]?.settings);
      const setup = { ...record(settings.deploymentSetup), organizationConfigured: true, applicationName: parsed.applicationName, accentColor: parsed.accentColor };
      await db.execute("UPDATE tenants SET name=$2,settings=jsonb_set(settings,'{deploymentSetup}',$3::jsonb,true),updated_at=now() WHERE id=$1::uuid", [this.#tenantId, parsed.organizationName, JSON.stringify(setup)]);
      await db.execute(`
        INSERT INTO organization_profiles (tenant_id,logo_url,support_email,security_email,timezone,branding)
        VALUES ($1::uuid,$2,$3,$4,$5,$6::jsonb)
        ON CONFLICT (tenant_id) DO UPDATE SET
          logo_url=excluded.logo_url,support_email=excluded.support_email,security_email=excluded.security_email,
          timezone=excluded.timezone,branding=organization_profiles.branding || excluded.branding,updated_at=now()
      `, [this.#tenantId, parsed.logoUrl ?? null, parsed.supportEmail ?? null, parsed.securityEmail ?? null, parsed.timezone, JSON.stringify({ applicationName: parsed.applicationName, accentColor: parsed.accentColor })]);
    });
    return this.status(cookieHeader);
  }

  async saveGoogleSso(cookieHeader: string | undefined, input: unknown) {
    await this.requireReady(cookieHeader, "organization");
    const parsed = parseInput(SetupGoogleSsoInputSchema, input);
    const ownerEmail = normalizeEmail(this.env.BERRY_SETUP_OWNER_EMAIL);
    if (!ownerEmail || ownerEmail.split("@")[1] !== parsed.hostedDomain) {
      throw new BadRequestException("The configured owner email must belong to the Google Workspace domain");
    }
    const existing = await this.identity.getSsoConnection(this.#tenantId, "google-workspace");
    if (existing?.clientId && existing.clientId !== parsed.clientId && !parsed.clientSecret) {
      throw new BadRequestException("Enter the matching client secret when changing the Google client ID");
    }
    if (!parsed.clientSecret && !existing?.clientSecretConfigured) {
      throw new BadRequestException("Google client secret is required the first time SSO is configured");
    }
    await this.identity.createSsoConnection({
      tenantId: this.#tenantId,
      kind: "oidc",
      provider: "google",
      slug: "google-workspace",
      displayName: "Google Workspace",
      status: "enabled",
      issuer: "https://accounts.google.com",
      clientId: parsed.clientId,
      ...(parsed.clientSecret ? { clientSecret: parsed.clientSecret } : {}),
      domains: [parsed.hostedDomain],
      jitProvisioning: true,
      defaultRole: "member",
      scimEnabled: false,
    });
    return this.status(cookieHeader);
  }

  async saveGoogleConnectors(cookieHeader: string | undefined, input: unknown) {
    await this.requireReady(cookieHeader, "sso");
    const parsed = parseInput(SetupGoogleConnectorsInputSchema, input);
    const sso = await this.identity.getSsoConnection(this.#tenantId, "google-workspace");
    const hostedDomain = sso?.domains[0];
    if (!hostedDomain) throw new BadRequestException("Configure Google SSO before Google connectors");
    const existing = await this.connectors.googleConfiguration(this.#tenantId);
    const pickerProjectNumber = parsed.pickerProjectNumber ?? existing.pickerProjectNumber;
    if (parsed.drive.enabled && parsed.drive.access === "selected_files") {
      if (!parsed.pickerApiKey && !existing.pickerConfigured) {
        throw new BadRequestException("Picker API key is required for selected-file access");
      }
      if (!pickerProjectNumber) {
        throw new BadRequestException("Picker project number is required for selected-file access");
      }
    }
    await this.connectors.configureGoogle(this.#tenantId, "setup", {
      clientId: parsed.clientId,
      ...(parsed.clientSecret ? { clientSecret: parsed.clientSecret } : {}),
      hostedDomain,
      ...(parsed.pickerApiKey ? { pickerApiKey: parsed.pickerApiKey } : {}),
      pickerProjectNumber,
    });
    await this.connectors.updateBuiltIn(this.#tenantId, "setup", "google-workspace", {
      enabled: parsed.drive.enabled,
      maxAccessLevel: parsed.drive.maxAccessLevel,
      workspaceAccessMode: parsed.drive.access,
    });
    await this.connectors.updateBuiltIn(this.#tenantId, "setup", "gmail", parsed.gmail);
    await this.connectors.updateBuiltIn(this.#tenantId, "setup", "google-calendar", parsed.calendar);
    await this.database.withTenant(this.#tenantId, async (db) => {
      const rows = await db.query<{ settings: unknown }>("SELECT settings FROM tenants WHERE id=$1::uuid FOR UPDATE", [this.#tenantId]);
      const settings = record(rows[0]?.settings);
      const setup = { ...record(settings.deploymentSetup), connectorsConfigured: true };
      await db.execute("UPDATE tenants SET settings=jsonb_set(settings,'{deploymentSetup}',$2::jsonb,true),updated_at=now() WHERE id=$1::uuid", [this.#tenantId, JSON.stringify(setup)]);
    });
    return this.status(cookieHeader);
  }

  private async requireOpen(cookieHeader?: string): Promise<SetupStatus> {
    if (!this.verifyCookie(cookieHeader)) throw new ForbiddenException("Unlock setup again to continue");
    const status = await this.status(cookieHeader);
    if (status.completed) throw new ConflictException("This deployment has already been claimed");
    return status;
  }

  private async requireReady(cookieHeader: string | undefined, prerequisite: "foundation" | "organization" | "sso"): Promise<void> {
    const status = await this.requireOpen(cookieHeader);
    if (!status.systemReady) {
      throw new ServiceUnavailableException("Blocking production foundation checks must pass before setup can continue");
    }
    if (!status.foundationConfigured) {
      throw new ConflictException("Confirm the production foundation before entering organization or OAuth settings");
    }
    if (prerequisite === "organization" && !status.organization.configured) {
      throw new ConflictException("Configure the organization before Google SSO");
    }
    if (prerequisite === "sso" && !status.sso.configured) {
      throw new ConflictException("Configure Google SSO before Google connectors");
    }
  }

  private verifyCookie(cookieHeader?: string): boolean {
    const raw = parseCookies(cookieHeader).berry_setup;
    if (!raw) return false;
    const separator = raw.lastIndexOf(".");
    if (separator <= 0) return false;
    const body = raw.slice(0, separator);
    const signature = raw.slice(separator + 1);
    if (!secureEqual(signature, this.sign(body))) return false;
    try {
      const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SetupCookiePayload;
      return Number.isSafeInteger(payload.exp) && payload.exp > Math.floor(Date.now() / 1000) && typeof payload.nonce === "string";
    } catch {
      return false;
    }
  }

  private sign(value: string): string {
    const secret = this.env.BETTER_AUTH_SECRET ?? this.env.AUTH_SECRET;
    if (!secret) throw new ServiceUnavailableException("BETTER_AUTH_SECRET is required for deployment setup");
    return createHmac("sha256", secret).update(`berry-setup:${value}`).digest("base64url");
  }

  private pruneAttempts(now: number, clientKey: string): void {
    for (const [key, attempt] of this.#attempts) {
      if (attempt.resetsAt <= now) this.#attempts.delete(key);
    }
    if (this.#attempts.has(clientKey) || this.#attempts.size < SETUP_ATTEMPT_CACHE_LIMIT) return;
    const oldest = this.#attempts.keys().next().value as string | undefined;
    if (oldest) this.#attempts.delete(oldest);
  }

  private async readinessChecks(): Promise<SetupCheck[]> {
    const production = this.env.NODE_ENV === "production";
    const url = this.publicBaseUrl();
    const urlSecure = !production || url.startsWith("https://");
    const redisUrl = this.env.BERRY_REDIS_URL ?? this.env.REDIS_URL;
    const artifactBucket = this.env.BERRY_ARTIFACT_S3_BUCKET;
    const auditBucket = this.env.BERRY_AUDIT_S3_BUCKET;
    const [redisReady, artifactStorageReady, auditStorageReady] = await Promise.all([
      redisUrl ? settleProbe(() => this.#probes.redis(redisUrl)) : false,
      artifactBucket ? settleProbe(() => this.#probes.storage({
        bucket: artifactBucket,
        purpose: "artifact",
        endpoint: this.env.BERRY_ARTIFACT_S3_ENDPOINT,
        region: this.env.BERRY_ARTIFACT_S3_REGION,
        accessKeyId: this.env.BERRY_ARTIFACT_S3_ACCESS_KEY_ID,
        secretAccessKey: this.env.BERRY_ARTIFACT_S3_SECRET_ACCESS_KEY,
      })) : false,
      auditBucket ? settleProbe(() => this.#probes.storage({
        bucket: auditBucket,
        purpose: "audit",
        endpoint: this.env.BERRY_AUDIT_S3_ENDPOINT,
        region: this.env.BERRY_AUDIT_S3_REGION,
        accessKeyId: this.env.BERRY_AUDIT_S3_ACCESS_KEY_ID,
        secretAccessKey: this.env.BERRY_AUDIT_S3_SECRET_ACCESS_KEY,
      })) : false,
    ]);
    const storageReady = artifactStorageReady && auditStorageReady;
    return [
      { id: "database", label: "PostgreSQL", status: "pass", detail: "Database connection is healthy.", blocking: true },
      check("redis", "Redis", redisReady, "Redis responded to a queue health check.", redisUrl ? "Redis did not respond. Check its URL and network access." : "Set BERRY_REDIS_URL.", production),
      check("storage", "S3 storage", storageReady, "Artifact read, write, multipart, and audit write checks passed.", artifactBucket && auditBucket ? "S3 operations failed. Check bucket names, region, and the runtime IAM role permissions." : "Set BERRY_ARTIFACT_S3_BUCKET and BERRY_AUDIT_S3_BUCKET.", production),
      check("encryption", "Secret encryption", isConnectorEncryptionKeyValid(this.env.BERRY_CONNECTOR_ENCRYPTION_KEY), "Connector encryption key is a valid base64-encoded 32-byte key.", "Set BERRY_CONNECTOR_ENCRYPTION_KEY to a base64-encoded 32-byte key.", true),
      { id: "public-url", label: "Public HTTPS URL", status: urlSecure ? "pass" : "fail", detail: urlSecure ? url : "Production setup requires an HTTPS BERRY_AUTH_BASE_URL.", blocking: true },
      check("model", "AI model", this.env.BERRY_API_MODEL_MODE !== "live" || Boolean(this.env.BERRY_ROUTER_INFERENCE_BASE_URL), "Model runtime is configured.", "Model runtime is incomplete; chat will not work yet.", false),
    ];
  }

  private publicBaseUrl(): string {
    return (this.env.BERRY_AUTH_BASE_URL ?? this.env.BERRY_WEB_PUBLIC_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  }
}

const defaultSetupReadinessProbes: SetupReadinessProbes = {
  async redis(url) {
    const client = new Redis(url, {
      lazyConnect: true,
      connectTimeout: 3_000,
      commandTimeout: 3_000,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    client.on("error", () => undefined);
    try {
      await client.connect();
      return await client.ping() === "PONG";
    } finally {
      client.disconnect();
    }
  },
  async storage(input) {
    const client = new S3Client(s3ClientOptions(input));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), STORAGE_PROBE_TIMEOUT_MS);
    try {
      return await probeS3Storage(client, input, controller.signal);
    } finally {
      clearTimeout(timeout);
      client.destroy();
    }
  },
};

export async function probeS3Storage(
  client: Pick<S3Client, "send">,
  input: Pick<Parameters<SetupReadinessProbes["storage"]>[0], "bucket" | "purpose">,
  abortSignal?: AbortSignal,
): Promise<boolean> {
  const options = abortSignal ? { abortSignal } : undefined;
  await client.send(new HeadBucketCommand({ Bucket: input.bucket }), options);

  if (input.purpose === "audit") {
    try {
      await client.send(new PutObjectCommand({
        Bucket: input.bucket,
        Key: ".berry-readiness/audit-write-probe",
        Body: "berry-audit-storage-ready",
        ContentType: "text/plain; charset=utf-8",
        IfNoneMatch: "*",
      }), options);
    } catch (error) {
      if (!isS3PreconditionFailed(error)) throw error;
    }
    return true;
  }

  const key = `.berry-readiness/artifact-${randomUUID()}`;
  const body = Buffer.from("berry-artifact-storage-ready");
  let uploadId: string | undefined;
  let completed = false;
  let completedVersionId: string | undefined;
  try {
    const created = await client.send(new CreateMultipartUploadCommand({
      Bucket: input.bucket,
      Key: key,
      ContentType: "text/plain; charset=utf-8",
    }), options);
    uploadId = created.UploadId;
    if (!uploadId) throw new Error("S3 did not return a multipart upload id");
    const uploaded = await client.send(new UploadPartCommand({
      Bucket: input.bucket,
      Key: key,
      UploadId: uploadId,
      PartNumber: 1,
      Body: body,
    }), options);
    if (!uploaded.ETag) throw new Error("S3 did not return an upload part ETag");
    const completion = await client.send(new CompleteMultipartUploadCommand({
      Bucket: input.bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: [{ ETag: uploaded.ETag, PartNumber: 1 }] },
    }), options);
    completed = true;
    completedVersionId = completion.VersionId;
    await client.send(new HeadObjectCommand({ Bucket: input.bucket, Key: key }), options);
    const object = await client.send(new GetObjectCommand({ Bucket: input.bucket, Key: key }), options);
    if (!object.Body) throw new Error("S3 readiness object could not be read");
    await object.Body.transformToByteArray();
    return true;
  } finally {
    if (completed) {
      await client.send(new DeleteObjectCommand({
        Bucket: input.bucket,
        Key: key,
        ...(completedVersionId ? { VersionId: completedVersionId } : {}),
      }), options);
    } else if (uploadId) {
      await client.send(new AbortMultipartUploadCommand({ Bucket: input.bucket, Key: key, UploadId: uploadId }), options);
    }
  }
}

function isS3PreconditionFailed(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return value.name === "PreconditionFailed" || value.$metadata?.httpStatusCode === 412;
}

async function settleProbe(probe: () => Promise<boolean>): Promise<boolean> {
  try {
    return await probe();
  } catch {
    return false;
  }
}

function connectorView(row: { enabled: boolean; max_access_level: "read" | "full"; workspace_access_mode: "selected_files" | "search_workspace" | null } | undefined, defaultAccess?: "selected_files" | "search_workspace") {
  return { enabled: row?.enabled ?? false, maxAccessLevel: row?.max_access_level ?? "read", ...(defaultAccess ? { access: row?.workspace_access_mode ?? defaultAccess } : {}) };
}

function check(id: string, label: string, ok: boolean, success: string, failure: string, blocking: boolean): SetupCheck {
  return { id, label, status: ok ? "pass" : blocking ? "fail" : "warning", detail: ok ? success : failure, blocking };
}

function stepStatus(complete: boolean, current: boolean): "complete" | "current" | "pending" {
  return complete ? "complete" : current ? "current" : "pending";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function uuidValue(value: unknown): string | null {
  const candidate = stringValue(value);
  return candidate && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate) ? candidate : null;
}

type BrandingFileAvailability = {
  id: string;
  media_type: string;
  detected_media_type: string | null;
  status: string;
};

function brandingFileAvailable(
  files: readonly BrandingFileAvailability[],
  fileId: string | null,
  allowedMediaTypes: readonly string[],
): boolean {
  if (!fileId) return false;
  const file = files.find((candidate) => candidate.id === fileId);
  if (!file || (file.status !== "available" && file.status !== "processing")) return false;
  const declared = normalizeMediaType(file.media_type);
  const detected = file.detected_media_type === null ? null : normalizeMediaType(file.detected_media_type);
  const allowed = new Set(allowedMediaTypes.map((value) => normalizeMediaType(value)));
  return declared !== null && allowed.has(declared) && (detected === null || detected === declared);
}

function normalizeEmail(value: string | undefined): string | null {
  const email = value?.trim().toLowerCase() ?? "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function parseCookies(header?: string): Record<string, string> {
  return Object.fromEntries((header ?? "").split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const separator = part.indexOf("=");
    return separator < 0 ? [part, ""] : [part.slice(0, separator), part.slice(separator + 1)];
  }));
}

function secureEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function parseInput<TSchema extends z.ZodTypeAny>(schema: TSchema, input: unknown): z.infer<TSchema> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new BadRequestException({ code: "invalid_setup_input", issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) });
  return parsed.data;
}
