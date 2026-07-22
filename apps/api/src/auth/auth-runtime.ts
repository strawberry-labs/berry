import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import type { OnModuleDestroy } from "@nestjs/common";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { betterAuth, type Auth, type BetterAuthOptions } from "better-auth";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import { Pool } from "pg";
import { SELF_HOST_TENANT_ID } from "@berry/db";

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
  emailPassword: { enabled: true; minPasswordLength: number; maxPasswordLength: number };
  signupEnabled?: boolean;
  socialProviders: Array<"github">;
  storage: "postgres" | "memory";
};

export interface BerryAuthRuntime {
  describe(): BerryAuthDescription;
  getSession(headers: IncomingHttpHeaders): Promise<BerryAuthSession | null>;
  requireSession(headers: IncomingHttpHeaders): Promise<BerryAuthSession>;
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
  const signupEnabled = env.BERRY_AUTH_SIGNUP_ENABLED === "true" || (!production && env.BERRY_AUTH_SIGNUP_ENABLED !== "false");
  const maxUsers = positiveInteger(env.BERRY_AUTH_MAX_USERS, 10);
  const defaultOrgBudgetMicros = positiveInteger(env.BERRY_DEFAULT_ORG_MONTHLY_BUDGET_MICROS, 100_000_000);
  const defaultUserBudgetMicros = positiveInteger(env.BERRY_DEFAULT_USER_MONTHLY_BUDGET_MICROS, 15_000_000);
  const allowedEmails = new Set(parseCsv(env.BERRY_AUTH_ALLOWED_EMAILS).map((email) => email.toLowerCase()));
  const allowedDomains = new Set(parseCsv(env.BERRY_AUTH_ALLOWED_EMAIL_DOMAINS).map((domain) => domain.toLowerCase()));
  if (production && signupEnabled && allowedEmails.size === 0 && allowedDomains.size === 0 && env.BERRY_AUTH_ALLOW_OPEN_SIGNUP !== "true") {
    throw new Error("Production signup requires BERRY_AUTH_ALLOWED_EMAILS or BERRY_AUTH_ALLOWED_EMAIL_DOMAINS; set BERRY_AUTH_ALLOW_OPEN_SIGNUP=true only for an intentionally public deployment");
  }
  const tenantId = env.BERRY_TENANT_ID ?? SELF_HOST_TENANT_ID;
  const authOptions: BetterAuthOptions = {
    appName: "Berry",
    basePath: AUTH_BASE_PATH,
    baseURL: env.BERRY_AUTH_BASE_URL ?? "http://localhost:3000",
    secret,
    ...(pool ? { database: pool } : {}),
    ...(trustedOrigins.length > 0 ? { trustedOrigins } : {}),
    emailAndPassword: {
      enabled: true,
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
            before: async (user: { email: string }) => {
              const email = user.email.trim().toLowerCase();
              const domain = email.split("@")[1] ?? "";
              if (!signupEnabled) throw new Error("Account creation is disabled. Ask an administrator to invite you.");
              if (allowedEmails.size > 0 && !allowedEmails.has(email)) throw new Error("This email address is not allowed to create an account.");
              if (allowedDomains.size > 0 && !allowedDomains.has(domain)) throw new Error("This email domain is not allowed to create an account.");
              const count = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM users WHERE deleted_at IS NULL");
              if (Number(count.rows[0]?.count ?? "0") >= maxUsers) throw new Error("This Berry instance has reached its account limit.");
            },
            after: async (user: { id: string }) => {
              const client = await pool.connect();
              try {
                await client.query("BEGIN");
                await client.query("SELECT berry_set_tenant_id($1::uuid)", [tenantId]);
                const owners = await client.query<{ count: string }>(
                  "SELECT count(*)::text AS count FROM tenant_memberships WHERE tenant_id = $1::uuid AND role = 'owner' AND status = 'active'",
                  [tenantId],
                );
                const role = Number(owners.rows[0]?.count ?? "0") === 0 ? "owner" : "member";
                await client.query(
                  `INSERT INTO tenant_memberships (tenant_id, user_id, status, role, source)
                   VALUES ($1::uuid, $2::uuid, 'active', $3, 'manual')
                   ON CONFLICT (tenant_id, user_id) DO UPDATE SET status = 'active', updated_at = now()`,
                  [tenantId, user.id, role],
                );
                await client.query(
                  role === "owner"
                    ? `INSERT INTO budget_limits (tenant_id, scope_type, scope_id, period, soft_limit_micros, hard_limit_micros, status)
                       VALUES ($1::uuid, 'org', $1::text, 'month', $2, $3, 'active')
                       ON CONFLICT (tenant_id, scope_type, scope_id, period) DO UPDATE SET
                         soft_limit_micros = EXCLUDED.soft_limit_micros,
                         hard_limit_micros = EXCLUDED.hard_limit_micros,
                         status = 'active',
                         updated_at = now()`
                    : `INSERT INTO budget_limits (tenant_id, scope_type, scope_id, period, soft_limit_micros, hard_limit_micros, status)
                       VALUES ($1::uuid, 'org', $1::text, 'month', $2, $3, 'active')
                       ON CONFLICT (tenant_id, scope_type, scope_id, period) DO NOTHING`,
                  [tenantId, Math.floor(defaultOrgBudgetMicros * 0.8), defaultOrgBudgetMicros],
                );
                await client.query(
                  `INSERT INTO budget_limits (tenant_id, scope_type, scope_id, period, soft_limit_micros, hard_limit_micros, status)
                   VALUES ($1::uuid, 'user', $2::text, 'month', $3, $4, 'active')
                   ON CONFLICT (tenant_id, scope_type, scope_id, period) DO NOTHING`,
                  [tenantId, user.id, Math.floor(defaultUserBudgetMicros * 0.8), defaultUserBudgetMicros],
                );
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
        trustedProviders: ["github", "email-password"],
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
      emailPassword: { enabled: true, minPasswordLength: 8, maxPasswordLength: 128 },
      signupEnabled,
      socialProviders: socialProviders.github ? ["github"] : [],
      storage: pool ? "postgres" : "memory",
    },
  };
  if (pool) result.pool = pool;
  return result;
}

export function createBerryAuthRuntime(options: CreateBerryAuthOptions = {}): RealBetterAuthRuntime {
  const { authOptions, description, pool } = createBetterAuthOptions(options);
  return new RealBetterAuthRuntime(betterAuth(authOptions), description, pool);
}

@Injectable()
export class RealBetterAuthRuntime implements BerryAuthRuntime {
  private readonly nodeHandler: ReturnType<typeof toNodeHandler>;

  constructor(
    private readonly auth: Auth,
    private readonly authDescription: BerryAuthDescription,
    private readonly pool?: Pool,
  ) {
    this.nodeHandler = toNodeHandler(auth);
  }

  describe(): BerryAuthDescription {
    return this.authDescription;
  }

  async getSession(headers: IncomingHttpHeaders): Promise<BerryAuthSession | null> {
    const session = await (this.auth.api.getSession as (context: { headers: Headers }) => Promise<unknown>)({
      headers: fromNodeHeaders(headers),
    });
    return normalizeSession(session);
  }

  async requireSession(headers: IncomingHttpHeaders): Promise<BerryAuthSession> {
    const session = await this.getSession(headers);
    if (!session) throw new UnauthorizedException("Authentication required");
    return session;
  }

  async handleNodeRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    await this.nodeHandler(req, res);
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }
}

@Injectable()
export class BerryAuthService implements BerryAuthRuntime, OnModuleDestroy {
  constructor(@Inject(BERRY_AUTH_RUNTIME) private readonly runtime: BerryAuthRuntime) {}

  describe(): BerryAuthDescription {
    return this.runtime.describe();
  }

  getSession(headers: IncomingHttpHeaders): Promise<BerryAuthSession | null> {
    return this.runtime.getSession(headers);
  }

  requireSession(headers: IncomingHttpHeaders): Promise<BerryAuthSession> {
    return this.runtime.requireSession(headers);
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

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = value ? Number(value) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
