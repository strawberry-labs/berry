import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import type { OnModuleDestroy } from "@nestjs/common";
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { APIError, betterAuth, type Auth, type BetterAuthOptions } from "better-auth";
import { hashPassword } from "better-auth/crypto";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import { Pool, type PoolClient } from "pg";
import { SELF_HOST_TENANT_ID, SELF_HOST_WORKSPACE_ID } from "@berry/db";
import { ConnectorSecretEnvelopeSchema, openConnectorSecret, type ConnectorSecretEnvelope } from "@berry/shared";
import { z } from "zod";

export const BERRY_AUTH_RUNTIME = Symbol("BERRY_AUTH_RUNTIME");

export type BerryAuthSession = {
  session: {
    id: string;
    userId: string;
    expiresAt?: Date | string;
  };
  user: {
    id: string;
    email: string;
    name?: string | null;
    image?: string | null;
    emailVerified?: boolean;
  };
};

export type BerryAuthDescription = {
  basePath: string;
  emailPassword: { enabled: boolean; minPasswordLength: number; maxPasswordLength: number };
  loginMode?: "password" | "google" | "mixed";
  signupEnabled?: boolean;
  setup?: {
    required: boolean;
    available: boolean;
    ownerEmail: string | null;
    missingConfiguration: string[];
  };
  socialProviders: Array<"github">;
  ssoProviders?: Array<{
    id: "google";
    name: string;
    domain: string;
  }>;
  storage: "postgres" | "memory";
};

export type BerryOwnerSetupResult = {
  ok: true;
  user: { id: string; email: string; name: string };
  organization: { id: string; name: string };
};

export interface BerryAuthRuntime {
  describe(): BerryAuthDescription | Promise<BerryAuthDescription>;
  setupOwner?(input: unknown): Promise<BerryOwnerSetupResult>;
  getSession(headers: IncomingHttpHeaders): Promise<BerryAuthSession | null>;
  requireSession(headers: IncomingHttpHeaders): Promise<BerryAuthSession>;
  authorizeSession?(session: BerryAuthSession): Promise<boolean>;
  handleNodeRequest(req: IncomingMessage, res: ServerResponse): Promise<void>;
  close?(): Promise<void>;
}

export type BerryAuthEnv = Record<string, string | undefined>;

export type CreateBerryAuthOptions = {
  env?: BerryAuthEnv;
  database?: Pool;
};

const AUTH_BASE_PATH = "/v1/auth";
const DEFAULT_DEV_SECRET = "berry-dev-auth-secret-do-not-use-in-production";
const SETUP_TOKEN_MIN_LENGTH = 32;

const OwnerSetupInputSchema = z.object({
  organizationName: z.string().trim().min(2).max(100),
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().email().transform((value) => value.toLowerCase()),
  password: z.string().min(8).max(128),
  setupToken: z.string().min(1).max(512),
}).strict();

export function createBetterAuthOptions(options: CreateBerryAuthOptions = {}): { authOptions: BetterAuthOptions; description: BerryAuthDescription; pool?: Pool } {
  const env = options.env ?? process.env;
  const databaseUrl = env.BERRY_DATABASE_URL ?? env.DATABASE_URL;
  const pool = options.database ?? (databaseUrl ? new Pool({ connectionString: databaseUrl }) : undefined);
  const secret = env.BETTER_AUTH_SECRET ?? env.AUTH_SECRET ?? (env.NODE_ENV === "production" ? undefined : DEFAULT_DEV_SECRET);
  if (!secret) {
    throw new Error("BETTER_AUTH_SECRET or AUTH_SECRET is required when NODE_ENV=production");
  }

  const githubClientId = env.BERRY_AUTH_GITHUB_CLIENT_ID;
  const githubClientSecret = env.BERRY_AUTH_GITHUB_CLIENT_SECRET;
  const githubRedirectURI = env.BERRY_AUTH_GITHUB_REDIRECT_URI;
  const socialProviders: BetterAuthOptions["socialProviders"] = {};
  if (githubClientId && githubClientSecret) {
    socialProviders.github = {
      clientId: githubClientId,
      clientSecret: githubClientSecret,
      ...(githubRedirectURI ? { redirectURI: githubRedirectURI } : {}),
    };
  }

  const trustedOrigins = parseCsv(env.BERRY_AUTH_TRUSTED_ORIGINS);
  const production = env.NODE_ENV === "production";
  const loginMethods = new Set(parseCsv(env.BERRY_AUTH_LOGIN_METHODS).map((method) => method.toLowerCase()));
  const passwordEnabled = loginMethods.size === 0 || loginMethods.has("password");
  const googleEnabled = loginMethods.has("google");
  const signupEnabled = passwordEnabled && (env.BERRY_AUTH_SIGNUP_ENABLED === "true" || (!production && env.BERRY_AUTH_SIGNUP_ENABLED !== "false"));
  const maxUsers = positiveInteger(env.BERRY_AUTH_MAX_USERS, 10);
  const defaultOrgBudgetMicros = positiveInteger(env.BERRY_DEFAULT_ORG_MONTHLY_BUDGET_MICROS, 100_000_000);
  const defaultUserBudgetMicros = positiveInteger(env.BERRY_DEFAULT_USER_MONTHLY_BUDGET_MICROS, 15_000_000);
  const allowedEmails = new Set(parseCsv(env.BERRY_AUTH_ALLOWED_EMAILS).map((email) => email.toLowerCase()));
  const allowedDomains = new Set(parseCsv(env.BERRY_AUTH_ALLOWED_EMAIL_DOMAINS).map((domain) => domain.toLowerCase()));
  const setupOwnerEmail = normalizeEmail(env.BERRY_SETUP_OWNER_EMAIL);
  if (production && signupEnabled && allowedEmails.size === 0 && allowedDomains.size === 0 && env.BERRY_AUTH_ALLOW_OPEN_SIGNUP !== "true") {
    throw new Error("Production signup requires BERRY_AUTH_ALLOWED_EMAILS or BERRY_AUTH_ALLOWED_EMAIL_DOMAINS; set BERRY_AUTH_ALLOW_OPEN_SIGNUP=true only for an intentionally public deployment");
  }
  const tenantId = env.BERRY_TENANT_ID ?? SELF_HOST_TENANT_ID;
  const authOptions: BetterAuthOptions = {
    appName: env.BERRY_APPLICATION_NAME?.trim() || "Berry",
    basePath: AUTH_BASE_PATH,
    baseURL: env.BERRY_AUTH_BASE_URL ?? "http://localhost:3000",
    secret,
    ...(pool ? { database: pool } : {}),
    ...(trustedOrigins.length > 0 ? { trustedOrigins } : {}),
    emailAndPassword: {
      enabled: passwordEnabled,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      requireEmailVerification: false,
    },
    rateLimit: {
      enabled: production,
      window: positiveInteger(env.BERRY_AUTH_RATE_LIMIT_WINDOW_SECONDS, 60),
      max: positiveInteger(env.BERRY_AUTH_RATE_LIMIT_MAX, 60),
    },
    ...(pool ? {
      databaseHooks: {
        user: {
          create: {
            before: async (user: { email: string }, context: unknown) => {
              const email = user.email.trim().toLowerCase();
              const domain = email.split("@")[1] ?? "";
              const ssoProvisioning = isGoogleSsoContext(context);
              if (ssoProvisioning) {
                const google = await loadEnabledGoogleSso(pool, tenantId);
                if (!google || domain !== google.domain) throw new Error("Use an account from the configured Google Workspace domain.");
              }
              const hasOwner = await ownerExists(pool, tenantId);
              if (!hasOwner) {
                if (!ssoProvisioning || !setupOwnerEmail || email !== setupOwnerEmail) {
                  throw new Error("The configured owner must claim this deployment with Google before member accounts can be created.");
                }
                if (!await setupReadyForOwnerClaim(pool, tenantId)) {
                  throw new Error("Complete every deployment setup step before claiming ownership.");
                }
              }
              if (hasOwner && !ssoProvisioning) {
                if (!signupEnabled) throw new Error("Account creation is disabled. Ask an administrator to invite you.");
                if (allowedEmails.size > 0 && !allowedEmails.has(email)) throw new Error("This email address is not allowed to create an account.");
                if (allowedDomains.size > 0 && !allowedDomains.has(domain)) throw new Error("This email domain is not allowed to create an account.");
              }
              if (await tenantSeatCount(pool, tenantId) >= maxUsers) throw new Error("This Berry instance has reached its account limit.");
            },
            after: async (user: { id: string }, context: unknown) => {
              const googleProvisioning = isGoogleSsoContext(context);
              const membershipSource = googleProvisioning ? "sso" : "signup";
              const client = await pool.connect();
              try {
                await client.query("BEGIN");
                await client.query("SELECT berry_set_tenant_id($1::uuid)", [tenantId]);
                await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`berry-owner-setup:${tenantId}`]);
                const userResult = await client.query<{ email: string }>("SELECT email FROM users WHERE id=$1::uuid LIMIT 1", [user.id]);
                const email = userResult.rows[0]?.email.trim().toLowerCase() ?? "";
                const initialOwner = googleProvisioning && !await clientHasOwner(client, tenantId) && Boolean(setupOwnerEmail) && email === setupOwnerEmail;
                if (initialOwner) {
                  await completeInitialGoogleOwnerClaim(client, tenantId, user.id, defaultOrgBudgetMicros, defaultUserBudgetMicros);
                } else {
                  await client.query(
                    `INSERT INTO tenant_memberships (tenant_id, user_id, status, role, source)
                     VALUES ($1::uuid, $2::uuid, 'active', $3, $4)
                     ON CONFLICT (tenant_id, user_id) DO UPDATE SET
                       status = 'active',
                       role = CASE WHEN tenant_memberships.role IN ('owner','admin') THEN tenant_memberships.role ELSE EXCLUDED.role END,
                       source = CASE WHEN tenant_memberships.source = 'sso' THEN tenant_memberships.source ELSE EXCLUDED.source END,
                       updated_at = now()`,
                    [tenantId, user.id, "member", membershipSource],
                  );
                  await upsertInitialBudgets(client, tenantId, user.id, defaultOrgBudgetMicros, defaultUserBudgetMicros);
                }
                await client.query("COMMIT");
              } catch (error) {
                await client.query("ROLLBACK");
                throw error;
              } finally {
                client.release();
              }
            },
          },
        },
        session: {
          create: {
            before: async (session: { userId: string }) => {
              const status = await tenantMembershipStatus(pool, tenantId, session.userId);
              if (status === "disabled" || status === "deprovisioned") {
                throw APIError.from("FORBIDDEN", {
                  code: "ORGANIZATION_MEMBERSHIP_INACTIVE",
                  message: "Your organization membership is not active.",
                });
              }
            },
          },
        },
      },
    } : {}),
    socialProviders,
    user: {
      modelName: "users",
      fields: {
        emailVerified: "email_verified",
        image: "avatar_url",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
    session: {
      modelName: "auth_sessions",
      fields: {
        userId: "user_id",
        expiresAt: "expires_at",
        ipAddress: "ip_address",
        userAgent: "user_agent",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
    account: {
      modelName: "auth_accounts",
      encryptOAuthTokens: true,
      accountLinking: {
        enabled: true,
        trustedProviders: ["google", "github", "email-password"],
        requireLocalEmailVerified: true,
      },
      fields: {
        userId: "user_id",
        accountId: "account_id",
        providerId: "provider_id",
        accessToken: "access_token",
        refreshToken: "refresh_token",
        accessTokenExpiresAt: "access_token_expires_at",
        refreshTokenExpiresAt: "refresh_token_expires_at",
        idToken: "id_token",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
    verification: {
      modelName: "auth_verifications",
      fields: {
        expiresAt: "expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
    advanced: {
      useSecureCookies: production,
      database: {
        generateId: "uuid",
      },
    },
  };

  const result: { authOptions: BetterAuthOptions; description: BerryAuthDescription; pool?: Pool } = {
    authOptions,
    description: {
      basePath: AUTH_BASE_PATH,
      emailPassword: { enabled: passwordEnabled, minPasswordLength: 8, maxPasswordLength: 128 },
      loginMode: googleEnabled && !passwordEnabled ? "google" : googleEnabled ? "mixed" : "password",
      signupEnabled,
      setup: {
        required: false,
        available: false,
        ownerEmail: setupOwnerEmail,
        missingConfiguration: [],
      },
      socialProviders: socialProviders.github ? ["github"] : [],
      ssoProviders: [],
      storage: pool ? "postgres" : "memory",
    },
  };
  if (pool) result.pool = pool;
  return result;
}

async function tenantSeatCount(pool: Pool, tenantId: string): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT berry_set_tenant_id($1::uuid)", [tenantId]);
    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM tenant_memberships
       WHERE tenant_id=$1::uuid AND status <> 'deprovisioned'`,
      [tenantId],
    );
    await client.query("COMMIT");
    return Number(result.rows[0]?.count ?? "0");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function tenantMembershipStatus(pool: Pool, tenantId: string, userId: string): Promise<string | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT berry_set_tenant_id($1::uuid)", [tenantId]);
    const result = await client.query<{ status: string }>(
      `SELECT status FROM tenant_memberships
       WHERE tenant_id=$1::uuid AND user_id=$2::uuid
       LIMIT 1`,
      [tenantId, userId],
    );
    await client.query("COMMIT");
    return result.rows[0]?.status ?? null;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function createBerryAuthRuntime(options: CreateBerryAuthOptions = {}): RealBetterAuthRuntime {
  const { authOptions, description, pool } = createBetterAuthOptions(options);
  return new RealBetterAuthRuntime(
    betterAuth(authOptions),
    description,
    pool,
    options.env ?? process.env,
    (options.env ?? process.env).BERRY_TENANT_ID ?? SELF_HOST_TENANT_ID,
    authOptions,
  );
}

@Injectable()
export class RealBetterAuthRuntime implements BerryAuthRuntime {
  private readonly nodeHandler: ReturnType<typeof toNodeHandler>;
  private googleHandlerCache?: { fingerprint: string; handler: ReturnType<typeof toNodeHandler> };
  private readonly completedMembershipRecoveryChecks = new Set<string>();
  private readonly completedOwnerRepairChecks = new Set<string>();

  constructor(
    private readonly auth: Auth,
    private readonly authDescription: BerryAuthDescription,
    private readonly pool?: Pool,
    private readonly env: BerryAuthEnv = process.env,
    private readonly tenantId = SELF_HOST_TENANT_ID,
    private readonly baseAuthOptions?: BetterAuthOptions,
  ) {
    this.nodeHandler = toNodeHandler(auth);
  }

  async describe(): Promise<BerryAuthDescription> {
    if (!this.pool) return this.authDescription;
    const google = await loadEnabledGoogleSso(this.pool, this.tenantId);
    const googleUsable = google ? await isGoogleSsoUsable(google, this.env, this.tenantId) : false;
    const setup = await setupDescription(this.pool, this.tenantId, this.env);
    return {
      ...this.authDescription,
      setup: this.authDescription.emailPassword.enabled ? setup : { ...setup, ownerEmail: null },
      ssoProviders: google && googleUsable
        ? [{ id: "google", name: google.displayName, domain: google.domain }]
        : [],
    };
  }

  async setupOwner(input: unknown): Promise<BerryOwnerSetupResult> {
    if (!this.authDescription.emailPassword.enabled) {
      throw new BadRequestException("Password-based owner setup is disabled. Complete the Google deployment wizard instead.");
    }
    if (!this.pool) {
      throw new ServiceUnavailableException("Owner setup requires Postgres storage.");
    }
    const parsed = OwnerSetupInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new BadRequestException({
        code: "invalid_setup_request",
        message: "Check the organization name, owner details, password, and setup key.",
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      });
    }

    const configuredEmail = normalizeEmail(this.env.BERRY_SETUP_OWNER_EMAIL);
    const configuredToken = this.env.BERRY_SETUP_TOKEN?.trim() ?? "";
    const missingConfiguration = setupConfigurationIssues(configuredEmail, configuredToken);
    if (missingConfiguration.length > 0) {
      throw new ServiceUnavailableException({
        code: "setup_not_configured",
        message: `Set ${missingConfiguration.join(" and ")} in the deployment environment, then restart the API.`,
      });
    }
    if (parsed.data.email !== configuredEmail || !secureEqual(parsed.data.setupToken, configuredToken)) {
      throw new ForbiddenException({
        code: "invalid_setup_credentials",
        message: "The owner email or setup key does not match this deployment.",
      });
    }

    const password = await hashPassword(parsed.data.password);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT berry_set_tenant_id($1::uuid)", [this.tenantId]);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`berry-owner-setup:${this.tenantId}`]);
      if (await clientHasOwner(client, this.tenantId)) {
        throw new ConflictException({
          code: "setup_already_complete",
          message: "This Berry deployment already has an owner. Sign in instead.",
        });
      }

      const created = await client.query<{ id: string }>(
        `INSERT INTO users (email, name, email_verified, status)
         VALUES ($1, $2, true, 'active')
         RETURNING id`,
        [parsed.data.email, parsed.data.name],
      );
      const userId = created.rows[0]!.id;
      await client.query(
        `INSERT INTO auth_accounts (user_id, account_id, provider_id, password)
         VALUES ($1::uuid, $1::text, 'credential', $2)`,
        [userId, password],
      );
      await client.query(
        `INSERT INTO tenant_memberships (tenant_id, user_id, status, role, source)
         VALUES ($1::uuid, $2::uuid, 'active', 'owner', 'setup')`,
        [this.tenantId, userId],
      );
      const organization = await client.query(
        `UPDATE tenants
         SET name = $2, settings = settings || '{"setupComplete":true}'::jsonb, updated_at = now()
         WHERE id = $1::uuid AND deleted_at IS NULL`,
        [this.tenantId, parsed.data.organizationName],
      );
      if (organization.rowCount !== 1) {
        throw new ServiceUnavailableException("The configured Berry tenant has not been seeded.");
      }
      const workspace = await client.query(
        `UPDATE workspaces
         SET owner_id = $2::uuid, updated_at = now()
         WHERE tenant_id = $1::uuid
           AND (id = $3::uuid OR slug = 'default' OR settings->>'selfHostDefault' = 'true')
           AND owner_id IS NULL
           AND deleted_at IS NULL`,
        [this.tenantId, userId, SELF_HOST_WORKSPACE_ID],
      );
      if (workspace.rowCount !== 1) {
        throw new ServiceUnavailableException("The default Berry workspace has not been seeded or already has an owner.");
      }
      await upsertInitialBudgets(
        client,
        this.tenantId,
        userId,
        positiveInteger(this.env.BERRY_DEFAULT_ORG_MONTHLY_BUDGET_MICROS, 100_000_000),
        positiveInteger(this.env.BERRY_DEFAULT_USER_MONTHLY_BUDGET_MICROS, 15_000_000),
      );
      await client.query("COMMIT");
      return {
        ok: true,
        user: { id: userId, email: parsed.data.email, name: parsed.data.name },
        organization: { id: this.tenantId, name: parsed.data.organizationName },
      };
    } catch (error) {
      await client.query("ROLLBACK");
      if (isUniqueViolation(error)) {
        throw new ConflictException({
          code: "owner_email_exists",
          message: "An account already exists for the configured owner email.",
        });
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async getSession(headers: IncomingHttpHeaders): Promise<BerryAuthSession | null> {
    const session = await (this.auth.api.getSession as (context: { headers: Headers }) => Promise<unknown>)({
      headers: fromNodeHeaders(headers),
    });
    const normalized = normalizeSession(session);
    if (normalized && this.pool) {
      const setupOwnerEmail = normalizeEmail(this.env.BERRY_SETUP_OWNER_EMAIL);
      if (setupOwnerEmail
        && normalized.user.email.trim().toLowerCase() === setupOwnerEmail
        && !this.completedOwnerRepairChecks.has(normalized.user.id)) {
        const complete = await repairInitialGoogleOwnerClaim(
          this.pool,
          this.tenantId,
          normalized.user.id,
          setupOwnerEmail,
          positiveInteger(this.env.BERRY_DEFAULT_ORG_MONTHLY_BUDGET_MICROS, 100_000_000),
          positiveInteger(this.env.BERRY_DEFAULT_USER_MONTHLY_BUDGET_MICROS, 15_000_000),
        );
        if (complete) this.completedOwnerRepairChecks.add(normalized.user.id);
      }
      if (!this.completedMembershipRecoveryChecks.has(normalized.user.id)) {
        const complete = await recoverGoogleMembership(
          this.pool,
          this.tenantId,
          normalized.user.id,
          positiveInteger(this.env.BERRY_DEFAULT_ORG_MONTHLY_BUDGET_MICROS, 100_000_000),
          positiveInteger(this.env.BERRY_DEFAULT_USER_MONTHLY_BUDGET_MICROS, 15_000_000),
        );
        if (complete) this.completedMembershipRecoveryChecks.add(normalized.user.id);
      }
    }
    return normalized;
  }

  async requireSession(headers: IncomingHttpHeaders): Promise<BerryAuthSession> {
    const session = await this.getSession(headers);
    if (!session) throw new UnauthorizedException("Authentication required");
    return session;
  }

  async authorizeSession(session: BerryAuthSession): Promise<boolean> {
    if (!this.pool) return true;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT berry_set_tenant_id($1::uuid)", [this.tenantId]);
      const result = await client.query<{ active: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM tenant_memberships
           WHERE tenant_id = $1::uuid AND user_id = $2::uuid AND status = 'active'
         ) AS active`,
        [this.tenantId, session.user.id],
      );
      await client.query("COMMIT");
      return result.rows[0]?.active === true;
    } catch (cause) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw cause;
    } finally {
      client.release();
    }
  }

  async handleNodeRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.pool || !this.baseAuthOptions || !isGoogleAuthRequest(req)) {
      await this.nodeHandler(req, res);
      return;
    }
    sanitizeGoogleSignInRequest(req);
    const google = await loadEnabledGoogleSso(this.pool, this.tenantId);
    if (!google) {
      await this.nodeHandler(req, res);
      return;
    }
    const envelope = ConnectorSecretEnvelopeSchema.parse(google.clientSecretEnvelope);
    const fingerprint = googleSsoFingerprint(google, envelope);
    if (this.googleHandlerCache?.fingerprint !== fingerprint) {
      const clientSecret = await openConnectorSecret(
        envelope,
        connectorEncryptionKeys(this.env),
        `${this.tenantId}:sso:${google.id}:client-secret`,
      );
      const googleAuth = betterAuth({
        ...this.baseAuthOptions,
        socialProviders: {
          ...this.baseAuthOptions.socialProviders,
          google: {
            clientId: google.clientId,
            clientSecret,
            hd: google.domain,
            accessType: "online",
            disableSignUp: !google.jitProvisioning,
          },
        },
      });
      this.googleHandlerCache = { fingerprint, handler: toNodeHandler(googleAuth) };
    }
    await this.googleHandlerCache.handler(req, res);
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }
}

@Injectable()
export class BerryAuthService implements BerryAuthRuntime, OnModuleDestroy {
  constructor(@Inject(BERRY_AUTH_RUNTIME) private readonly runtime: BerryAuthRuntime) {}

  describe(): BerryAuthDescription | Promise<BerryAuthDescription> {
    return this.runtime.describe();
  }

  setupOwner(input: unknown): Promise<BerryOwnerSetupResult> {
    if (!this.runtime.setupOwner) {
      throw new ServiceUnavailableException("Owner setup is not available for this authentication runtime.");
    }
    return this.runtime.setupOwner(input);
  }

  getSession(headers: IncomingHttpHeaders): Promise<BerryAuthSession | null> {
    return this.runtime.getSession(headers);
  }

  requireSession(headers: IncomingHttpHeaders): Promise<BerryAuthSession> {
    return this.runtime.requireSession(headers);
  }

  authorizeSession(session: BerryAuthSession): Promise<boolean> {
    return this.runtime.authorizeSession?.(session) ?? Promise.resolve(true);
  }

  handleNodeRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    return this.runtime.handleNodeRequest(req, res);
  }

  async onModuleDestroy(): Promise<void> {
    await this.runtime.close?.();
  }
}

function normalizeSession(value: unknown): BerryAuthSession | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { session?: unknown; user?: unknown };
  if (!candidate.session || !candidate.user || typeof candidate.session !== "object" || typeof candidate.user !== "object") return null;
  const session = candidate.session as Record<string, unknown>;
  const user = candidate.user as Record<string, unknown>;
  if (typeof session.id !== "string" || typeof session.userId !== "string" || typeof user.id !== "string" || typeof user.email !== "string") return null;
  const normalized: BerryAuthSession = {
    session: {
      id: session.id,
      userId: session.userId,
    },
    user: {
      id: user.id,
      email: user.email,
      name: typeof user.name === "string" ? user.name : null,
      image: typeof user.image === "string" ? user.image : null,
    },
  };
  if (session.expiresAt instanceof Date || typeof session.expiresAt === "string") normalized.session.expiresAt = session.expiresAt;
  if (typeof user.emailVerified === "boolean") normalized.user.emailVerified = user.emailVerified;
  return normalized;
}

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

type GoogleWorkspaceSsoRecord = {
  id: string;
  displayName: string;
  clientId: string;
  clientSecretEnvelope: unknown;
  domain: string;
  jitProvisioning: boolean;
  updatedAt: string;
};

async function loadEnabledGoogleSso(pool: Pool, tenantId: string): Promise<GoogleWorkspaceSsoRecord | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT berry_set_tenant_id($1::uuid)", [tenantId]);
    const result = await client.query<{
      id: string;
      display_name: string;
      client_id: string | null;
      client_secret_envelope: unknown;
      domains: unknown;
      jit_provisioning: boolean;
      updated_at: Date | string;
    }>(
      `SELECT id, display_name, client_id, client_secret_envelope, domains, jit_provisioning, updated_at
       FROM sso_connections
       WHERE tenant_id = $1::uuid AND provider = 'google' AND kind = 'oidc' AND status = 'enabled'
       ORDER BY updated_at DESC
       LIMIT 1`,
      [tenantId],
    );
    await client.query("COMMIT");
    const row = result.rows[0];
    const domain = Array.isArray(row?.domains) && typeof row.domains[0] === "string" ? row.domains[0].trim().toLowerCase() : "";
    if (!row?.client_id || !domain) return null;
    return {
      id: row.id,
      displayName: row.display_name,
      clientId: row.client_id,
      clientSecretEnvelope: row.client_secret_envelope,
      domain,
      jitProvisioning: row.jit_provisioning,
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    };
  } catch (cause) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw cause;
  } finally {
    client.release();
  }
}

function connectorEncryptionKeys(env: BerryAuthEnv): string[] {
  const primary = env.BERRY_CONNECTOR_ENCRYPTION_KEY?.trim();
  if (!primary) throw new Error("BERRY_CONNECTOR_ENCRYPTION_KEY is required to use Google Workspace SSO");
  return [primary, ...parseCsv(env.BERRY_CONNECTOR_DECRYPTION_KEYS)];
}

async function isGoogleSsoUsable(record: GoogleWorkspaceSsoRecord, env: BerryAuthEnv, tenantId: string): Promise<boolean> {
  const parsed = ConnectorSecretEnvelopeSchema.safeParse(record.clientSecretEnvelope);
  if (!record.clientId || !record.domain || !parsed.success) return false;
  try {
    const clientSecret = await openConnectorSecret(
      parsed.data,
      connectorEncryptionKeys(env),
      `${tenantId}:sso:${record.id}:client-secret`,
    );
    return clientSecret.length > 0;
  } catch {
    return false;
  }
}

function googleSsoFingerprint(record: GoogleWorkspaceSsoRecord, envelope: ConnectorSecretEnvelope): string {
  return createHash("sha256").update(JSON.stringify({
    id: record.id,
    clientId: record.clientId,
    domain: record.domain,
    jitProvisioning: record.jitProvisioning,
    updatedAt: record.updatedAt,
    keyId: envelope.keyId,
    ciphertext: envelope.ciphertext,
  })).digest("hex");
}

function isGoogleAuthRequest(req: IncomingMessage): boolean {
  const path = new URL(req.url ?? "/", "http://berry.local").pathname;
  if (path === `${AUTH_BASE_PATH}/callback/google`) return true;
  if (path !== `${AUTH_BASE_PATH}/sign-in/social`) return false;
  const body = (req as IncomingMessage & { body?: unknown }).body;
  return typeof body === "object"
    && body !== null
    && !Array.isArray(body)
    && (body as Record<string, unknown>).provider === "google";
}

function sanitizeGoogleSignInRequest(req: IncomingMessage): void {
  const path = new URL(req.url ?? "/", "http://berry.local").pathname;
  if (path !== `${AUTH_BASE_PATH}/sign-in/social`) return;
  const request = req as IncomingMessage & { body?: unknown };
  if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) return;
  const body = request.body as Record<string, unknown>;
  request.body = {
    provider: "google",
    ...(typeof body.callbackURL === "string" ? { callbackURL: body.callbackURL } : {}),
    ...(typeof body.errorCallbackURL === "string" ? { errorCallbackURL: body.errorCallbackURL } : {}),
    ...(typeof body.disableRedirect === "boolean" ? { disableRedirect: body.disableRedirect } : {}),
  };
}

function isGoogleSsoContext(context: unknown): boolean {
  if (!context || typeof context !== "object") return false;
  const candidate = context as { path?: unknown; params?: unknown };
  if (candidate.path === "/callback/google") return true;
  if (candidate.path !== "/callback/:id" || !candidate.params || typeof candidate.params !== "object") return false;
  return (candidate.params as { id?: unknown }).id === "google";
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = value ? Number(value) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function setupDescription(pool: Pool, tenantId: string, env: BerryAuthEnv): Promise<NonNullable<BerryAuthDescription["setup"]>> {
  const required = !await ownerExists(pool, tenantId);
  const ownerEmail = normalizeEmail(env.BERRY_SETUP_OWNER_EMAIL);
  const missingConfiguration = required
    ? setupConfigurationIssues(ownerEmail, env.BERRY_SETUP_TOKEN?.trim() ?? "")
    : [];
  return {
    required,
    available: required && missingConfiguration.length === 0,
    ownerEmail,
    missingConfiguration,
  };
}

async function ownerExists(pool: Pool, tenantId: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT berry_set_tenant_id($1::uuid)", [tenantId]);
    const exists = await clientHasOwner(client, tenantId);
    await client.query("COMMIT");
    return exists;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function setupReadyForOwnerClaim(pool: Pool, tenantId: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT berry_set_tenant_id($1::uuid)", [tenantId]);
    const result = await client.query<{ ready: boolean }>(
      `SELECT COALESCE((settings->'deploymentSetup'->>'foundationConfigured')::boolean,false)
          AND COALESCE((settings->'deploymentSetup'->>'organizationConfigured')::boolean,false)
          AND COALESCE((settings->'deploymentSetup'->>'connectorsConfigured')::boolean,false) AS ready
       FROM tenants WHERE id=$1::uuid AND deleted_at IS NULL`,
      [tenantId],
    );
    await client.query("COMMIT");
    return result.rows[0]?.ready === true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function recoverGoogleMembership(
  pool: Pool,
  tenantId: string,
  userId: string,
  defaultOrgBudgetMicros: number,
  defaultUserBudgetMicros: number,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT berry_set_tenant_id($1::uuid)", [tenantId]);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`berry-google-membership:${tenantId}:${userId}`]);
    const eligibility = await client.query<{ eligible: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM users user_record
         WHERE user_record.id=$2::uuid
           AND user_record.deleted_at IS NULL
           AND user_record.email_verified=true
           AND EXISTS (
             SELECT 1 FROM auth_accounts account
             WHERE account.user_id=user_record.id AND account.provider_id='google'
           )
           AND EXISTS (
             SELECT 1 FROM sso_connections connection
             WHERE connection.tenant_id=$1::uuid
               AND connection.provider='google'
               AND connection.kind='oidc'
               AND connection.status='enabled'
               AND connection.jit_provisioning=true
               AND connection.domains @> jsonb_build_array(split_part(lower(user_record.email),'@',2))
           )
           AND EXISTS (
             SELECT 1 FROM tenant_memberships owner_membership
             WHERE owner_membership.tenant_id=$1::uuid
               AND owner_membership.role='owner'
               AND owner_membership.status='active'
           )
       ) AS eligible`,
      [tenantId, userId],
    );
    if (eligibility.rows[0]?.eligible === true) {
      await client.query(
        `INSERT INTO tenant_memberships (tenant_id,user_id,status,role,source)
         VALUES ($1::uuid,$2::uuid,'active','member','sso')
         ON CONFLICT (tenant_id,user_id) DO NOTHING`,
        [tenantId, userId],
      );
      await client.query(
        `UPDATE tenant_memberships
         SET status='active',source='sso',deprovisioned_at=NULL,updated_at=now()
         WHERE tenant_id=$1::uuid AND user_id=$2::uuid AND status='pending'`,
        [tenantId, userId],
      );
    }
    const membership = await client.query<{ status: string }>(
      `SELECT status FROM tenant_memberships
       WHERE tenant_id=$1::uuid AND user_id=$2::uuid
       LIMIT 1`,
      [tenantId, userId],
    );
    const status = membership.rows[0]?.status;
    if (status === "active") {
      await upsertInitialBudgets(client, tenantId, userId, defaultOrgBudgetMicros, defaultUserBudgetMicros);
    }
    await client.query("COMMIT");
    return status === "active" || (typeof status === "string" && status !== "pending");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function repairInitialGoogleOwnerClaim(
  pool: Pool,
  tenantId: string,
  userId: string,
  setupOwnerEmail: string | null,
  defaultOrgBudgetMicros: number,
  defaultUserBudgetMicros: number,
): Promise<boolean> {
  if (!setupOwnerEmail) return true;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT berry_set_tenant_id($1::uuid)", [tenantId]);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`berry-owner-setup:${tenantId}`]);
    if (await clientHasOwner(client, tenantId)) {
      await client.query("COMMIT");
      return true;
    }
    const candidate = await client.query<{ email: string; email_verified: boolean; has_google_account: boolean }>(
      `SELECT lower(user_record.email) AS email,
              user_record.email_verified,
              EXISTS (
                SELECT 1 FROM auth_accounts account
                WHERE account.user_id=user_record.id AND account.provider_id='google'
              ) AS has_google_account
       FROM users user_record
       WHERE user_record.id=$1::uuid AND user_record.deleted_at IS NULL
       LIMIT 1`,
      [userId],
    );
    const ownerDomain = setupOwnerEmail.split("@")[1] ?? "";
    if (candidate.rows[0]?.email !== setupOwnerEmail
      || candidate.rows[0]?.email_verified !== true
      || candidate.rows[0]?.has_google_account !== true
      || !ownerDomain) {
      await client.query("COMMIT");
      return false;
    }
    const readiness = await client.query<{ ready: boolean }>(
      `SELECT
         NOT COALESCE((tenant.settings->>'setupComplete')::boolean,false)
         AND COALESCE((tenant.settings->'deploymentSetup'->>'foundationConfigured')::boolean,false)
         AND COALESCE((tenant.settings->'deploymentSetup'->>'organizationConfigured')::boolean,false)
         AND COALESCE((tenant.settings->'deploymentSetup'->>'connectorsConfigured')::boolean,false)
         AND EXISTS (
           SELECT 1 FROM sso_connections connection
           WHERE connection.tenant_id=tenant.id
             AND connection.provider='google'
             AND connection.kind='oidc'
             AND connection.status='enabled'
             AND connection.domains @> $2::jsonb
         ) AS ready
       FROM tenants tenant
       WHERE tenant.id=$1::uuid AND tenant.deleted_at IS NULL`,
      [tenantId, JSON.stringify([ownerDomain])],
    );
    if (readiness.rows[0]?.ready !== true) {
      await client.query("COMMIT");
      return false;
    }
    await completeInitialGoogleOwnerClaim(client, tenantId, userId, defaultOrgBudgetMicros, defaultUserBudgetMicros);
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function completeInitialGoogleOwnerClaim(
  client: PoolClient,
  tenantId: string,
  userId: string,
  defaultOrgBudgetMicros: number,
  defaultUserBudgetMicros: number,
): Promise<void> {
  await client.query(
    `INSERT INTO tenant_memberships (tenant_id, user_id, status, role, source)
     VALUES ($1::uuid, $2::uuid, 'active', $3, $4)
     ON CONFLICT (tenant_id, user_id) DO UPDATE SET
       status='active',role=EXCLUDED.role,source=EXCLUDED.source,deprovisioned_at=NULL,updated_at=now()`,
    [tenantId, userId, "owner", "sso"],
  );
  const tenant = await client.query(
    `UPDATE tenants SET
       settings = jsonb_set(
         settings || '{"setupComplete":true}'::jsonb,
         '{deploymentSetup,completedAt}', to_jsonb(now()::text), true
       ),
       updated_at=now()
     WHERE id=$1::uuid AND deleted_at IS NULL`,
    [tenantId],
  );
  if (tenant.rowCount !== 1) throw new Error("The configured Berry tenant has not been seeded.");
  const workspace = await client.query(
    `UPDATE workspaces SET owner_id=$2::uuid,updated_at=now()
     WHERE tenant_id=$1::uuid
       AND (id=$3::uuid OR slug='default' OR settings->>'selfHostDefault'='true')
       AND (owner_id IS NULL OR owner_id=$2::uuid)
       AND deleted_at IS NULL`,
    [tenantId, userId, SELF_HOST_WORKSPACE_ID],
  );
  if (workspace.rowCount !== 1) throw new Error("The default Berry workspace could not be claimed.");
  await upsertInitialBudgets(client, tenantId, userId, defaultOrgBudgetMicros, defaultUserBudgetMicros);
}

async function clientHasOwner(client: PoolClient, tenantId: string): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM tenant_memberships
       WHERE tenant_id = $1::uuid AND role = 'owner' AND status = 'active'
     ) AS exists`,
    [tenantId],
  );
  return result.rows[0]?.exists === true;
}

async function upsertInitialBudgets(
  client: PoolClient,
  tenantId: string,
  userId: string,
  orgBudgetMicros: number,
  userBudgetMicros: number,
): Promise<void> {
  await client.query(
    `INSERT INTO budget_limits (tenant_id, scope_type, scope_id, period, soft_limit_micros, hard_limit_micros, status)
     VALUES ($1::uuid, 'org', $1::text, 'month', $2, $3, 'active')
     ON CONFLICT (tenant_id, scope_type, scope_id, period) DO UPDATE SET
       soft_limit_micros = EXCLUDED.soft_limit_micros,
       hard_limit_micros = EXCLUDED.hard_limit_micros,
       status = 'active',
       updated_at = now()`,
    [tenantId, Math.floor(orgBudgetMicros * 0.8), orgBudgetMicros],
  );
  await client.query(
    `INSERT INTO budget_limits (tenant_id, scope_type, scope_id, period, soft_limit_micros, hard_limit_micros, status)
     VALUES ($1::uuid, 'user', $2::text, 'month', $3, $4, 'active')
     ON CONFLICT (tenant_id, scope_type, scope_id, period) DO UPDATE SET
       soft_limit_micros = EXCLUDED.soft_limit_micros,
       hard_limit_micros = EXCLUDED.hard_limit_micros,
       status = 'active',
       updated_at = now()`,
    [tenantId, userId, Math.floor(userBudgetMicros * 0.8), userBudgetMicros],
  );
}

function normalizeEmail(value: string | undefined): string | null {
  const email = value?.trim().toLowerCase() ?? "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function setupConfigurationIssues(ownerEmail: string | null, setupToken: string): string[] {
  const missing: string[] = [];
  if (!ownerEmail) missing.push("BERRY_SETUP_OWNER_EMAIL");
  if (setupToken.length < SETUP_TOKEN_MIN_LENGTH) missing.push("BERRY_SETUP_TOKEN (at least 32 characters)");
  return missing;
}

function secureEqual(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "23505";
}
