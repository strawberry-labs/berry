import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import {
  completeRemoteMcpOAuth,
  discoverRemoteMcpTools,
  refreshRemoteMcpOAuth,
  resolvePublicRemoteUrl,
  startRemoteMcpOAuth,
  type McpOAuthState,
  type McpServerSpec,
} from "@berry/local-agent";
import {
  ConnectorSecretEnvelopeSchema,
  ConnectorSchema,
  openConnectorSecret,
  sealConnectorSecret,
  type Connector,
  type ConnectorAccessLevel,
  type ConnectorSecretEnvelope,
  type ConnectorWorkspaceAccessMode,
} from "@berry/shared";
import type { CloudDatabaseService, SqlExecutor } from "../db/cloud-database.service.ts";
import {
  executeGoogleTool,
  GOOGLE_CONNECTOR_SERVICES,
  googleConnectorScopes,
  googleToolCatalog,
  googleToolsRequiringApproval,
  type GoogleConnectorKey,
} from "./google-tools.ts";

export const CONNECTORS = Symbol("CONNECTORS");

const GOOGLE_KEYS = ["google-workspace", "gmail", "google-calendar"] as const;
const BUILT_INS: Record<GoogleConnectorKey, { id: string; name: string; description: string; websiteUrl: string; privacyPolicyUrl: string }> = {
  "google-workspace": {
    id: "connector_google_workspace",
    name: "Google Workspace",
    description: "Find, read, create, and update files across Drive, Docs, Sheets, Slides, and Forms.",
    websiteUrl: "https://workspace.google.com/",
    privacyPolicyUrl: "https://policies.google.com/privacy",
  },
  gmail: {
    id: "connector_gmail",
    name: "Gmail",
    description: "Search email, review threads, organize messages, draft replies, and send email.",
    websiteUrl: "https://workspace.google.com/products/gmail/",
    privacyPolicyUrl: "https://policies.google.com/privacy",
  },
  "google-calendar": {
    id: "connector_google_calendar",
    name: "Google Calendar",
    description: "Review schedules, find free time, create events, and respond to invitations.",
    websiteUrl: "https://workspace.google.com/products/calendar/",
    privacyPolicyUrl: "https://policies.google.com/privacy",
  },
};
const BASE_GOOGLE_SCOPES = ["openid", "email", "profile"];

type ConnectorRow = {
  id: string;
  connector_key: string;
  kind: "app" | "custom_mcp";
  provider: string;
  name: string;
  description: string;
  enabled: boolean;
  max_access_level: ConnectorAccessLevel;
  workspace_access_mode: ConnectorWorkspaceAccessMode | null;
  auth_strategy: "personal" | "shared";
  transport: "http-sse" | "streamable-http" | null;
  endpoint_url: string | null;
  auth_type: "none" | "bearer" | "oauth";
  publication_status: "draft" | "published";
  shared_credential_envelope: unknown;
  config: unknown;
  created_at: Date | string;
  updated_at: Date | string;
};
type ConnectionRow = {
  id: string;
  connector_id: string;
  user_id: string | null;
  access_level: ConnectorAccessLevel;
  credential_envelope: unknown;
  account_email: string | null;
  account_subject: string | null;
  granted_scopes: string[] | null;
  status: "connected" | "reauth_required" | "revoked" | "error";
  expires_at: Date | string | null;
  last_error_code: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};
type ProviderCredentialRow = {
  client_id: string;
  client_secret_envelope: unknown;
  hosted_domain: string | null;
  picker_api_key_envelope: unknown;
  picker_project_number: string | null;
  status: "configured" | "verified" | "error";
  last_tested_at: Date | string | null;
};
type OAuthStateRow = {
  state_digest: string;
  connector_id: string;
  user_id: string;
  access_level: ConnectorAccessLevel;
  code_verifier_envelope: unknown;
  requested_scopes: string[];
  redirect_after: string;
  expires_at: Date | string;
};
type StoredGoogleToken = {
  accessToken: string;
  refreshToken: string | null;
  tokenType: string;
  expiresAt: string;
  scope: string[];
};
type ConnectorSession = {
  tenantId: string;
  userId: string;
  connectorKey: GoogleConnectorKey;
  accessLevel: ConnectorAccessLevel;
  exp: number;
};

type StoredMcpOAuth = { state: McpOAuthState; obtainedAt: string };
type CustomConnectorConfig = {
  discoveredTools?: Array<{ name: string; description: string | null; inputSchema: Record<string, unknown>; annotations?: Record<string, boolean> }>;
  allowedTools?: string[];
  oauthScope?: string;
  websiteUrl?: string;
  privacyPolicyUrl?: string;
  lastDiscoveredAt?: string;
};

@Injectable()
export class ConnectorsService {
  constructor(
    private readonly database: CloudDatabaseService,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async list(tenantId: string, userId: string): Promise<Connector[]> {
    const [rows, connections, provider] = await this.database.withTenant(tenantId, async (db) => Promise.all([
      db.query<ConnectorRow>("SELECT * FROM organization_connectors ORDER BY kind, name"),
      db.query<ConnectionRow>("SELECT * FROM connector_connections WHERE user_id = $1 OR user_id IS NULL", [userId]),
      db.query<ProviderCredentialRow>("SELECT * FROM connector_provider_credentials WHERE provider = 'google' LIMIT 1"),
    ]));
    const byKey = new Map(rows.map((row) => [row.connector_key, row]));
    const byConnector = new Map(connections.map((row) => [`${row.connector_id}:${row.user_id ?? "shared"}`, row]));
    const googleConfigured = Boolean(provider[0]?.client_id && connectorEnvelope(provider[0].client_secret_envelope));
    const builtIns = GOOGLE_KEYS.map((key) => {
      const row = byKey.get(key);
      return this.#connectorView(row ?? virtualBuiltIn(key), byConnector, userId, googleConfigured);
    });
    const custom = rows.filter((row) => row.kind === "custom_mcp").map((row) => this.#connectorView(row, byConnector, userId, true));
    return ConnectorSchema.array().parse([...builtIns, ...custom]);
  }

  async googleConfiguration(tenantId: string) {
    const rows = await this.database.withTenant(tenantId, (db) => db.query<ProviderCredentialRow>("SELECT * FROM connector_provider_credentials WHERE provider = 'google' LIMIT 1"));
    const row = rows[0];
    return {
      configured: Boolean(row?.client_id && connectorEnvelope(row.client_secret_envelope)),
      clientId: row?.client_id ?? null,
      hostedDomain: row?.hosted_domain ?? null,
      pickerConfigured: Boolean(connectorEnvelope(row?.picker_api_key_envelope)),
      pickerProjectNumber: row?.picker_project_number ?? null,
      status: row?.status ?? "not_configured" as const,
      lastTestedAt: row?.last_tested_at ? new Date(row.last_tested_at).toISOString() : null,
      callbackUrl: this.googleCallbackUrl(),
    };
  }

  async configureGoogle(tenantId: string, userId: string, input: { clientId: string; clientSecret?: string | undefined; hostedDomain?: string | null | undefined; pickerApiKey?: string | undefined; pickerProjectNumber?: string | null | undefined }) {
    const existing = await this.database.withTenant(tenantId, (db) => db.query<ProviderCredentialRow>("SELECT * FROM connector_provider_credentials WHERE provider = 'google' LIMIT 1"));
    const previous = existing[0];
    const prior = connectorEnvelope(existing[0]?.client_secret_envelope);
    const envelope = input.clientSecret?.trim() ? await this.#seal(input.clientSecret.trim(), providerContext(tenantId, "client-secret")) : prior;
    if (!envelope) throw new BadRequestException("Google OAuth client secret is required the first time you configure Google");
    const priorPicker = connectorEnvelope(existing[0]?.picker_api_key_envelope);
    const pickerEnvelope = input.pickerApiKey?.trim() ? await this.#seal(input.pickerApiKey.trim(), providerContext(tenantId, "picker-api-key")) : priorPicker;
    const pickerProjectNumber = input.pickerProjectNumber?.trim() || null;
    const hostedDomain = input.hostedDomain?.trim().toLowerCase() || null;
    if (hostedDomain && (!hostedDomain.includes(".") || hostedDomain.includes("@"))) throw new BadRequestException("Hosted domain must look like example.com");
    const clientId = input.clientId.trim();
    if (previous && previous.client_id !== clientId && !input.clientSecret?.trim()) {
      throw new BadRequestException("A new Google OAuth client secret is required when the client ID changes");
    }
    const clientCredentialsChanged = Boolean(previous && (
      previous.client_id !== clientId
      || input.clientSecret?.trim()
    ));
    const hostedDomainChanged = Boolean(previous && previous.hosted_domain !== hostedDomain);
    await this.database.withTenant(tenantId, async (db) => {
      if (!pickerEnvelope || !pickerProjectNumber) {
        const [selectedFilesEnabled] = await db.query<{ id: string }>(`
          SELECT id FROM organization_connectors
          WHERE connector_key='google-workspace' AND enabled=true
            AND workspace_access_mode='selected_files'
          LIMIT 1
        `);
        if (selectedFilesEnabled) {
          throw new BadRequestException("Google Picker configuration cannot be removed while Selected files is enabled");
        }
      }
      await db.execute(`
        INSERT INTO connector_provider_credentials (tenant_id, provider, client_id, client_secret_envelope, hosted_domain, picker_api_key_envelope, picker_project_number, status, configured_by)
        VALUES ($1::uuid, 'google', $2, $3::jsonb, $4, $5::jsonb, $6, 'configured', $7)
        ON CONFLICT (tenant_id, provider) DO UPDATE SET
          client_id=EXCLUDED.client_id,
          client_secret_envelope=EXCLUDED.client_secret_envelope,
          hosted_domain=EXCLUDED.hosted_domain,
          picker_api_key_envelope=EXCLUDED.picker_api_key_envelope,
          picker_project_number=EXCLUDED.picker_project_number,
          status='configured', last_error_code=NULL,
          configured_by=EXCLUDED.configured_by,
          updated_at=now()
      `, [tenantId, clientId, JSON.stringify(envelope), hostedDomain, pickerEnvelope ? JSON.stringify(pickerEnvelope) : null, pickerProjectNumber, userId]);
      for (const key of GOOGLE_KEYS) await this.#ensureBuiltIn(db, tenantId, key, userId);
      if (clientCredentialsChanged || hostedDomainChanged) {
        await db.execute(`
          DELETE FROM connector_oauth_states
          WHERE connector_id IN (
            SELECT id FROM organization_connectors
            WHERE tenant_id=$1::uuid AND provider='google'
          )
        `, [tenantId]);
      }
      if (clientCredentialsChanged) {
        await db.execute(`
          UPDATE connector_connections AS connection
          SET status='reauth_required',credential_envelope=NULL,
              granted_scopes=ARRAY[]::text[],expires_at=NULL,
              last_error_code='google_oauth_configuration_changed',updated_at=now()
          FROM organization_connectors AS connector
          WHERE connection.tenant_id=$1::uuid
            AND connector.tenant_id=connection.tenant_id
            AND connector.id=connection.connector_id
            AND connector.provider='google'
            AND connection.status='connected'
        `, [tenantId]);
      } else if (hostedDomainChanged && hostedDomain) {
        await db.execute(`
          UPDATE connector_connections AS connection
          SET status='reauth_required',credential_envelope=NULL,
              granted_scopes=ARRAY[]::text[],expires_at=NULL,
              last_error_code='google_hosted_domain_changed',updated_at=now()
          FROM organization_connectors AS connector
          WHERE connection.tenant_id=$1::uuid
            AND connector.tenant_id=connection.tenant_id
            AND connector.id=connection.connector_id
            AND connector.provider='google'
            AND connection.status='connected'
            AND lower(split_part(COALESCE(connection.account_email,''),'@',2))<>$2
        `, [tenantId, hostedDomain]);
      }
    });
    return this.googleConfiguration(tenantId);
  }

  async testGoogleConfiguration(tenantId: string) {
    const provider = await this.#providerCredential(tenantId);
    if (!provider) throw new BadRequestException("Google OAuth is not configured");
    const response = await fetch("https://accounts.google.com/.well-known/openid-configuration", { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new ServiceUnavailableException("Google OAuth discovery is unavailable");
    await this.database.withTenant(tenantId, (db) => db.execute("UPDATE connector_provider_credentials SET last_tested_at=now(), last_error_code=NULL, updated_at=now() WHERE provider='google'"));
    return this.googleConfiguration(tenantId);
  }

  async googlePickerSession(tenantId: string, userId: string, id: string) {
    const row = await this.#row(tenantId, id);
    if (row.connector_key !== "google-workspace" || !row.enabled || row.workspace_access_mode !== "selected_files") throw new BadRequestException("Google Picker is not enabled for this connector");
    const provider = await this.#providerCredential(tenantId);
    if (!provider?.pickerApiKey || !provider.pickerProjectNumber) throw new BadRequestException("The administrator has not configured Google Picker");
    const connection = await this.#connection(tenantId, row.id, userId);
    if (!connection || connection.status !== "connected") throw new BadRequestException("Connect Google Workspace before choosing files");
    const accessToken = await this.#googleAccessToken(tenantId, row, connection);
    return {
      apiKey: provider.pickerApiKey,
      appId: provider.pickerProjectNumber,
      accessToken,
      origin: new URL(this.env.BERRY_WEB_PUBLIC_URL?.trim() || this.#publicApiBase()).origin,
    };
  }

  async updateBuiltIn(tenantId: string, userId: string, key: GoogleConnectorKey, input: { enabled: boolean; maxAccessLevel: ConnectorAccessLevel; workspaceAccessMode?: ConnectorWorkspaceAccessMode | undefined }): Promise<Connector> {
    await this.database.withTenant(tenantId, async (db) => {
      await this.#ensureBuiltIn(db, tenantId, key, userId);
      const [current] = await db.query<ConnectorRow>("SELECT * FROM organization_connectors WHERE connector_key=$1 FOR UPDATE", [key]);
      const workspaceAccessMode = input.workspaceAccessMode ?? current?.workspace_access_mode ?? "selected_files";
      if (key === "google-workspace" && input.enabled && workspaceAccessMode === "selected_files") {
        const [provider] = await db.query<Pick<ProviderCredentialRow, "picker_api_key_envelope" | "picker_project_number">>(`
          SELECT picker_api_key_envelope,picker_project_number
          FROM connector_provider_credentials
          WHERE provider='google'
          LIMIT 1
        `);
        if (!connectorEnvelope(provider?.picker_api_key_envelope) || !provider?.picker_project_number) {
          throw new BadRequestException("Configure a Google Picker API key and project number before enabling Selected files");
        }
      }
      await db.execute("UPDATE organization_connectors SET enabled=$1, max_access_level=$2, workspace_access_mode=CASE WHEN connector_key='google-workspace' THEN $3 ELSE NULL END, publication_status='published', updated_at=now() WHERE connector_key=$4", [input.enabled, input.maxAccessLevel, workspaceAccessMode, key]);
      const workspaceModeChanged = key === "google-workspace"
        && Boolean(current)
        && current?.workspace_access_mode !== workspaceAccessMode;
      const accessDowngraded = current?.max_access_level === "full" && input.maxAccessLevel === "read";
      if (current && (workspaceModeChanged || accessDowngraded)) {
        await db.execute("DELETE FROM connector_oauth_states WHERE tenant_id=$1::uuid AND connector_id=$2", [tenantId, current.id]);
        await db.execute(`
          UPDATE connector_connections
          SET status='reauth_required',credential_envelope=NULL,
              granted_scopes=ARRAY[]::text[],expires_at=NULL,
              last_error_code=$3,updated_at=now()
          WHERE tenant_id=$1::uuid AND connector_id=$2 AND status='connected'
        `, [
          tenantId,
          current.id,
          workspaceModeChanged ? "workspace_access_mode_changed" : "admin_access_level_downgraded",
        ]);
      }
    });
    return this.#find(await this.list(tenantId, userId), BUILT_INS[key].id);
  }

  async saveCustom(
    tenantId: string,
    userId: string,
    input: {
      id?: string;
      name: string;
      description?: string | undefined;
      url: string;
      transport: "http-sse" | "streamable-http";
      authType: "none" | "bearer" | "oauth";
      authStrategy: "personal" | "shared";
      maxAccessLevel: "full";
      oauthScope?: string | undefined;
      websiteUrl?: string | undefined;
      privacyPolicyUrl?: string | undefined;
      sharedCredential?: string | undefined;
      personalCredential?: string | undefined;
    },
  ): Promise<Connector> {
    const url = await safeRemoteUrl(input.url, this.env.NODE_ENV !== "production");
    const existing = input.id ? await this.#row(tenantId, input.id) : null;
    if (existing && existing.kind !== "custom_mcp") throw new BadRequestException("Built-in connectors cannot be replaced by a custom MCP");
    const priorConfig = customConfig(existing?.config);
    const authorityChanged = Boolean(existing && (
      existing.endpoint_url !== url
      || existing.transport !== input.transport
      || existing.auth_type !== input.authType
      || existing.auth_strategy !== input.authStrategy
      || (priorConfig.oauthScope ?? "") !== (input.oauthScope?.trim() ?? "")
    ));
    const reusableSharedCredential = !authorityChanged ? connectorEnvelope(existing?.shared_credential_envelope) : null;
    if (input.authStrategy === "shared" && input.authType === "bearer" && !input.sharedCredential?.trim() && !reusableSharedCredential) {
      throw new BadRequestException("A shared bearer token is required");
    }
    if (input.authStrategy === "personal" && input.authType === "bearer" && !input.personalCredential?.trim() && (!existing || authorityChanged)) {
      throw new BadRequestException("An administrator bearer token is required to discover this connector's tools");
    }
    const id = existing?.id ?? `connector_mcp_${randomUUID()}`;
    const key = existing?.connector_key ?? `custom-mcp-${randomUUID()}`;
    const sharedEnvelope = input.authStrategy !== "shared"
      ? null
      : input.authType === "bearer" && input.sharedCredential?.trim()
        ? await this.#seal(input.sharedCredential.trim(), sharedCredentialContext(tenantId, id))
        : reusableSharedCredential;
    const personalEnvelope = input.authStrategy === "personal" && input.authType === "bearer" && input.personalCredential?.trim()
      ? await this.#seal(input.personalCredential.trim(), connectionContext(tenantId, id, userId))
      : null;
    const config: CustomConnectorConfig = {
      ...(!authorityChanged && priorConfig.discoveredTools ? { discoveredTools: priorConfig.discoveredTools } : {}),
      ...(!authorityChanged && priorConfig.allowedTools ? { allowedTools: priorConfig.allowedTools } : {}),
      ...(!authorityChanged && priorConfig.lastDiscoveredAt ? { lastDiscoveredAt: priorConfig.lastDiscoveredAt } : {}),
      ...(input.oauthScope?.trim() ? { oauthScope: input.oauthScope.trim() } : {}),
      ...(input.websiteUrl?.trim() ? { websiteUrl: new URL(input.websiteUrl).toString() } : {}),
      ...(input.privacyPolicyUrl?.trim() ? { privacyPolicyUrl: new URL(input.privacyPolicyUrl).toString() } : {}),
    };
    await this.database.withTenant(tenantId, async (db) => {
      await db.execute(`
        INSERT INTO organization_connectors (
          id, tenant_id, connector_key, kind, provider, name, description, enabled,
          max_access_level, auth_strategy, transport, endpoint_url, auth_type,
          shared_credential_envelope, publication_status, config, created_by
        ) VALUES ($1,$2::uuid,$3,'custom_mcp','mcp',$4,$5,false,$6,$7,$8,$9,$10,$11::jsonb,'draft',$12::jsonb,$13)
        ON CONFLICT (tenant_id, id) DO UPDATE SET
          name=EXCLUDED.name, description=EXCLUDED.description, enabled=false,
          max_access_level=EXCLUDED.max_access_level, auth_strategy=EXCLUDED.auth_strategy,
          transport=EXCLUDED.transport, endpoint_url=EXCLUDED.endpoint_url,
          auth_type=EXCLUDED.auth_type, shared_credential_envelope=EXCLUDED.shared_credential_envelope,
          publication_status='draft', config=EXCLUDED.config,
          updated_at=now()
      `, [id, tenantId, key, input.name.trim(), input.description?.trim() ?? "", input.maxAccessLevel, input.authStrategy, input.transport, url, input.authType, sharedEnvelope ? JSON.stringify(sharedEnvelope) : null, JSON.stringify(config), userId]);
      if (authorityChanged) {
        await db.execute("DELETE FROM connector_oauth_states WHERE connector_id=$1", [id]);
        await db.execute("DELETE FROM connector_connections WHERE connector_id=$1", [id]);
      }
      if (personalEnvelope) {
        await this.#upsertConnectionWith(db, tenantId, id, userId, input.maxAccessLevel, personalEnvelope, null, null, [], null);
      }
    });
    return this.#find(await this.list(tenantId, userId), id);
  }

  async discoverCustom(tenantId: string, userId: string, id: string): Promise<Connector> {
    const row = await this.#row(tenantId, id);
    if (row.kind !== "custom_mcp" || !row.endpoint_url || !row.transport) throw new BadRequestException("Custom MCP is incomplete");
    const endpoint = await safeRemoteUrl(row.endpoint_url, this.env.NODE_ENV !== "production");
    const credential = await this.#customCredential(tenantId, userId, row, false);
    const tools = await discoverRemoteMcpTools({ id: row.id, name: row.name, url: endpoint, transport: row.transport, ...(credential ? { credential } : {}) });
    const config = customConfig(row.config);
    const next: CustomConnectorConfig = { ...config, discoveredTools: tools, allowedTools: tools.map((tool) => tool.name), lastDiscoveredAt: new Date().toISOString() };
    await this.database.withTenant(tenantId, (db) => db.execute("UPDATE organization_connectors SET config=$1::jsonb, publication_status='draft', enabled=false, updated_at=now() WHERE id=$2", [JSON.stringify(next), id]));
    return this.#find(await this.list(tenantId, userId), id);
  }

  async publishCustom(tenantId: string, userId: string, id: string, input: { enabled: boolean; allowedTools?: string[] | undefined }): Promise<Connector> {
    const row = await this.#row(tenantId, id);
    if (row.kind !== "custom_mcp") throw new BadRequestException("Only custom MCP connectors can be published");
    const config = customConfig(row.config);
    if (!config.discoveredTools?.length) throw new BadRequestException("Discover and review MCP tools before publishing");
    const discovered = new Set(config.discoveredTools.map((tool) => tool.name));
    const allowedTools = [...new Set(input.allowedTools ?? config.allowedTools ?? [])];
    if (!allowedTools.length || allowedTools.some((name) => !discovered.has(name))) throw new BadRequestException("Allowed tools must be a non-empty subset of the discovered tools");
    await this.database.withTenant(tenantId, (db) => db.execute("UPDATE organization_connectors SET config=$1::jsonb, publication_status='published', enabled=$2, updated_at=now() WHERE id=$3", [JSON.stringify({ ...config, allowedTools }), input.enabled, id]));
    return this.#find(await this.list(tenantId, userId), id);
  }

  async removeCustom(tenantId: string, id: string): Promise<{ ok: true }> {
    const row = await this.#row(tenantId, id);
    if (row.kind !== "custom_mcp") throw new BadRequestException("Built-in connectors cannot be deleted");
    await this.database.withTenant(tenantId, (db) => db.execute("DELETE FROM organization_connectors WHERE id=$1", [id]));
    return { ok: true };
  }

  async connectBearer(tenantId: string, userId: string, id: string, credential: string): Promise<Connector> {
    const row = await this.#row(tenantId, id);
    if (!row.enabled) throw new BadRequestException("This connector is disabled by the administrator");
    if (row.publication_status !== "published") throw new BadRequestException("This connector has not been published by the administrator");
    if (row.kind !== "custom_mcp" || row.auth_type !== "bearer" || row.auth_strategy !== "personal") throw new BadRequestException("This connector does not accept a personal bearer token");
    const envelope = await this.#seal(credential.trim(), connectionContext(tenantId, row.id, userId));
    await this.#upsertConnection(tenantId, row.id, userId, row.max_access_level, envelope, null, null, [], null);
    return this.#find(await this.list(tenantId, userId), id);
  }

  async disconnect(tenantId: string, userId: string, id: string): Promise<{ ok: true }> {
    const row = await this.#row(tenantId, id);
    if (row.auth_strategy === "shared") throw new BadRequestException("This connector uses an organization-wide credential and cannot be disconnected by an individual user");
    const connection = await this.#connection(tenantId, id, userId);
    if (connection && isGoogleKey(row.connector_key)) {
      const others = await this.database.withTenant(tenantId, (db) => db.query<{ count: string }>(`
        SELECT count(*)::text AS count
        FROM connector_connections cc
        JOIN organization_connectors oc ON oc.tenant_id=cc.tenant_id AND oc.id=cc.connector_id
        WHERE cc.user_id=$1 AND cc.connector_id<>$2 AND cc.status='connected' AND oc.provider='google'
      `, [userId, id]));
      if (Number(others[0]?.count ?? 0) === 0) {
        const token = await this.#openGoogleToken(tenantId, row.id, userId, connection);
        const revocable = token?.refreshToken ?? token?.accessToken;
        if (revocable) await revokeGoogleToken(revocable).catch(() => undefined);
      }
    }
    await this.database.withTenant(tenantId, (db) => db.execute("DELETE FROM connector_connections WHERE connector_id=$1 AND user_id=$2", [id, userId]));
    return { ok: true };
  }

  async startGoogleOAuth(tenantId: string, userId: string, id: string, accessLevel: ConnectorAccessLevel) {
    const row = await this.#row(tenantId, id);
    if (!isGoogleKey(row.connector_key)) throw new BadRequestException("This connector does not use Google OAuth");
    if (!row.enabled) throw new BadRequestException("This connector is disabled by the administrator");
    if (accessLevel === "full" && row.max_access_level !== "full") throw new BadRequestException("Full access has not been enabled by the administrator");
    const provider = await this.#providerCredential(tenantId);
    if (!provider) throw new BadRequestException("The administrator has not configured Google OAuth yet");
    const state = randomBytes(32).toString("base64url");
    const stateDigest = sha256(state);
    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const verifierEnvelope = await this.#seal(JSON.stringify({ type: "google", verifier }), oauthStateContext(tenantId, stateDigest));
    const scopes = googleConnectorScopes(row.connector_key, accessLevel, row.workspace_access_mode ?? "selected_files");
    const expiresAt = new Date(Date.now() + 10 * 60_000);
    await this.database.withTenant(tenantId, async (db) => {
      await db.execute("DELETE FROM connector_oauth_states WHERE expires_at <= now() OR consumed_at IS NOT NULL");
      await db.execute(`
        INSERT INTO connector_oauth_states (state_digest, tenant_id, connector_id, user_id, access_level, requested_scopes, code_verifier_envelope, redirect_after, expires_at)
        VALUES ($1,$2::uuid,$3,$4,$5,$6::text[],$7::jsonb,'/settings/connectors',$8::timestamptz)
      `, [stateDigest, tenantId, row.id, userId, accessLevel, scopes, JSON.stringify(verifierEnvelope), expiresAt.toISOString()]);
    });
    const authorizationUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authorizationUrl.searchParams.set("client_id", provider.clientId);
    authorizationUrl.searchParams.set("redirect_uri", this.googleCallbackUrl());
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("scope", [...BASE_GOOGLE_SCOPES, ...scopes].join(" "));
    authorizationUrl.searchParams.set("access_type", "offline");
    if (row.connector_key !== "google-workspace" || row.workspace_access_mode !== "selected_files") {
      authorizationUrl.searchParams.set("include_granted_scopes", "true");
    }
    authorizationUrl.searchParams.set("prompt", "consent select_account");
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("code_challenge", challenge);
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    if (provider.hostedDomain) authorizationUrl.searchParams.set("hd", provider.hostedDomain);
    return { connectorId: row.id, state, authorizationUrl: authorizationUrl.toString(), expiresAt: expiresAt.toISOString() };
  }

  async completeGoogleOAuth(tenantId: string, userId: string, input: { state: string; code?: string; error?: string }): Promise<{ redirectAfter: string; connectorId: string }> {
    const stateDigest = sha256(input.state);
    const states = await this.database.withTenant(tenantId, (db) => db.query<OAuthStateRow>("UPDATE connector_oauth_states SET consumed_at=now() WHERE state_digest=$1 AND user_id=$2 AND consumed_at IS NULL AND expires_at>now() RETURNING *", [stateDigest, userId]));
    const flow = states[0];
    if (!flow || new Date(flow.expires_at).getTime() <= Date.now()) throw new BadRequestException("Google OAuth state is invalid or expired");
    try {
      if (input.error) throw new BadRequestException(`Google authorization failed: ${input.error}`);
      if (!input.code) throw new BadRequestException("Google did not return an authorization code");
      const row = await this.#row(tenantId, flow.connector_id);
      if (!isGoogleKey(row.connector_key)) throw new BadRequestException("OAuth state references an invalid connector");
      const provider = await this.#providerCredential(tenantId);
      if (!provider) throw new BadRequestException("Google OAuth configuration is missing");
      const verifierEnvelope = connectorEnvelope(flow.code_verifier_envelope);
      if (!verifierEnvelope) throw new BadRequestException("Google OAuth verifier is invalid");
      const verifierState = JSON.parse(await this.#open(verifierEnvelope, oauthStateContext(tenantId, stateDigest))) as { type?: string; verifier?: string };
      if (verifierState.type !== "google" || !verifierState.verifier) throw new BadRequestException("Google OAuth verifier is invalid");
      const tokenResponse = await googleTokenRequest({
        client_id: provider.clientId,
        client_secret: provider.clientSecret,
        code: input.code,
        code_verifier: verifierState.verifier,
        grant_type: "authorization_code",
        redirect_uri: this.googleCallbackUrl(),
      });
      const accessToken = requiredTokenString(tokenResponse.access_token, "access_token");
      const profile = await googleUserInfo(accessToken);
      if (provider.hostedDomain && profile.email.split("@")[1]?.toLowerCase() !== provider.hostedDomain) throw new BadRequestException(`Connect an account from ${provider.hostedDomain}`);
      const existing = await this.#connection(tenantId, row.id, userId);
      const previous = existing ? await this.#openGoogleToken(tenantId, row.id, userId, existing) : null;
      const grantedScopes = typeof tokenResponse.scope === "string" ? tokenResponse.scope.split(/\s+/).filter(Boolean) : flow.requested_scopes;
      const missingScopes = flow.requested_scopes.filter((scope) => !grantedScopes.includes(scope));
      if (missingScopes.length) {
        throw new BadRequestException("Google did not grant every required permission. Review the consent screen and try again.");
      }
      const token: StoredGoogleToken = {
        accessToken,
        refreshToken: typeof tokenResponse.refresh_token === "string" ? tokenResponse.refresh_token : previous?.refreshToken ?? null,
        tokenType: typeof tokenResponse.token_type === "string" ? tokenResponse.token_type : "Bearer",
        expiresAt: new Date(Date.now() + Number(tokenResponse.expires_in ?? 3600) * 1000).toISOString(),
        scope: grantedScopes,
      };
      if (!token.refreshToken) throw new BadRequestException("Google did not return a refresh token. Revoke the existing Berry grant in Google and connect again.");
      const envelope = await this.#seal(JSON.stringify(token), connectionContext(tenantId, row.id, userId));
      await this.#upsertConnection(tenantId, row.id, userId, flow.access_level, envelope, profile.email, profile.sub, grantedScopes, token.expiresAt);
      await this.database.withTenant(tenantId, (db) => db.execute("UPDATE connector_provider_credentials SET status='verified', last_tested_at=now(), last_error_code=NULL, updated_at=now() WHERE provider='google'"));
      return { redirectAfter: flow.redirect_after, connectorId: row.id };
    } finally {
      await this.database.withTenant(tenantId, (db) => db.execute("DELETE FROM connector_oauth_states WHERE state_digest=$1", [stateDigest]));
    }
  }

  async startCustomOAuth(tenantId: string, userId: string, id: string, allowShared = false, redirectAfter = "/settings/connectors") {
    const row = await this.#row(tenantId, id);
    if (row.kind !== "custom_mcp" || row.auth_type !== "oauth" || !row.endpoint_url) throw new BadRequestException("This connector does not use MCP OAuth");
    if (row.auth_strategy === "shared" && !allowShared) throw new BadRequestException("Only an administrator can authorize this organization-wide connector");
    if (!allowShared && (row.publication_status !== "published" || !row.enabled)) throw new BadRequestException("This connector is not available to members");
    const endpoint = await safeRemoteUrl(row.endpoint_url, this.env.NODE_ENV !== "production");
    const state = randomBytes(32).toString("base64url"); const stateDigest = sha256(state); const config = customConfig(row.config); const callbackUrl = this.mcpCallbackUrl();
    const started = await startRemoteMcpOAuth({ serverUrl: endpoint, callbackUrl, requestState: state, ...(config.oauthScope ? { scope: config.oauthScope } : {}) });
    const envelope = await this.#seal(JSON.stringify({ type: "mcp", state: started.state }), oauthStateContext(tenantId, stateDigest));
    const expiresAt = new Date(Date.now() + 10 * 60_000);
    await this.database.withTenant(tenantId, async (db) => {
      await db.execute("DELETE FROM connector_oauth_states WHERE expires_at <= now() OR consumed_at IS NOT NULL");
      await db.execute(`
        INSERT INTO connector_oauth_states (state_digest, tenant_id, connector_id, user_id, access_level, requested_scopes, code_verifier_envelope, redirect_after, expires_at)
        VALUES ($1,$2::uuid,$3,$4,$5,$6::text[],$7::jsonb,$8,$9::timestamptz)
      `, [stateDigest, tenantId, row.id, userId, row.max_access_level, config.oauthScope ? config.oauthScope.split(/\s+/).filter(Boolean) : [], JSON.stringify(envelope), redirectAfter, expiresAt.toISOString()]);
    });
    return { connectorId: row.id, state, authorizationUrl: started.authorizationUrl, expiresAt: expiresAt.toISOString() };
  }

  async completeCustomOAuth(tenantId: string, userId: string, input: { state: string; code?: string; error?: string }) {
    const stateDigest = sha256(input.state);
    const states = await this.database.withTenant(tenantId, (db) => db.query<OAuthStateRow>("UPDATE connector_oauth_states SET consumed_at=now() WHERE state_digest=$1 AND user_id=$2 AND consumed_at IS NULL AND expires_at>now() RETURNING *", [stateDigest, userId]));
    const flow = states[0]; if (!flow) throw new BadRequestException("MCP OAuth state is invalid or expired");
    try {
      if (input.error) throw new BadRequestException(`MCP authorization failed: ${input.error}`); if (!input.code) throw new BadRequestException("MCP authorization code is missing");
      const row = await this.#row(tenantId, flow.connector_id); if (row.kind !== "custom_mcp" || row.auth_type !== "oauth" || !row.endpoint_url) throw new BadRequestException("OAuth state references an invalid MCP connector");
      const endpoint = await safeRemoteUrl(row.endpoint_url, this.env.NODE_ENV !== "production");
      const envelope = connectorEnvelope(flow.code_verifier_envelope); if (!envelope) throw new BadRequestException("MCP OAuth state is invalid");
      const stored = JSON.parse(await this.#open(envelope, oauthStateContext(tenantId, stateDigest))) as { type?: string; state?: McpOAuthState };
      if (stored.type !== "mcp" || !stored.state) throw new BadRequestException("MCP OAuth state is invalid");
      const config = customConfig(row.config);
      const completed = await completeRemoteMcpOAuth({ serverUrl: endpoint, callbackUrl: this.mcpCallbackUrl(), requestState: input.state, authorizationCode: input.code, state: stored.state, ...(config.oauthScope ? { scope: config.oauthScope } : {}) });
      const credential: StoredMcpOAuth = { state: completed, obtainedAt: new Date().toISOString() };
      if (row.auth_strategy === "shared") {
        const shared = await this.#seal(JSON.stringify(credential), sharedCredentialContext(tenantId, row.id));
        await this.database.withTenant(tenantId, (db) => db.execute("UPDATE organization_connectors SET shared_credential_envelope=$1::jsonb, updated_at=now() WHERE id=$2", [JSON.stringify(shared), row.id]));
      } else {
        const personal = await this.#seal(JSON.stringify(credential), connectionContext(tenantId, row.id, userId));
        await this.#upsertConnection(tenantId, row.id, userId, row.max_access_level, personal, null, null, flow.requested_scopes, null);
      }
      return { redirectAfter: flow.redirect_after, connectorId: row.id };
    } finally {
      await this.database.withTenant(tenantId, (db) => db.execute("DELETE FROM connector_oauth_states WHERE state_digest=$1", [stateDigest]));
    }
  }

  async runtime(tenantId: string, userId: string): Promise<McpServerSpec[]> {
    const rows = await this.database.withTenant(tenantId, (db) => db.query<ConnectorRow>("SELECT * FROM organization_connectors WHERE enabled=true AND publication_status='published' ORDER BY kind, name"));
    const servers: McpServerSpec[] = [];
    for (const row of rows) {
      if (isGoogleKey(row.connector_key)) {
        const connection = await this.#connection(tenantId, row.id, userId);
        if (!connection || connection.status !== "connected") continue;
        const accessLevel: ConnectorAccessLevel = row.max_access_level === "read" ? "read" : connection.access_level;
        const grantedScopes = connection.granted_scopes ?? [];
        const tools = googleToolCatalog(row.connector_key, accessLevel, grantedScopes);
        if (!tools.length) continue;
        const credential = this.#signSession({ tenantId, userId, connectorKey: row.connector_key, accessLevel, exp: Math.floor(Date.now() / 1000) + 20 * 60 });
        servers.push({
          id: row.id,
          name: row.name,
          transport: "streamable-http",
          command: null,
          args: [],
          url: this.#internalMcpUrl(row.connector_key),
          env: {},
          enabled: true,
          trusted: true,
          trustReadOnlyAnnotations: true,
          approvalRequiredTools: googleToolsRequiringApproval(row.connector_key, accessLevel, grantedScopes),
          credentialKey: `connector:${row.id}:${userId}`,
          credential,
          cachedTools: tools,
        });
        continue;
      }
      if (row.kind !== "custom_mcp" || !row.endpoint_url || !row.transport) continue;
      const endpoint = await safeRemoteUrl(row.endpoint_url, this.env.NODE_ENV !== "production").catch(() => null);
      if (!endpoint) continue;
      let credential: string | undefined;
      try {
        credential = await this.#customCredential(tenantId, userId, row, true);
      } catch {
        await this.#invalidateCustomCredential(tenantId, userId, row).catch(() => undefined);
        continue;
      }
      if (row.auth_type !== "none" && !credential) continue;
      const config = customConfig(row.config);
      const approved = new Set(config.allowedTools ?? []);
      const cachedTools = (config.discoveredTools ?? []).filter((tool) => approved.has(tool.name));
      if (!cachedTools.length) continue;
      servers.push({
        id: row.id,
        name: row.name,
        transport: row.transport,
        command: null,
        args: [],
        url: endpoint,
        env: {},
        enabled: true,
        trusted: true,
        credentialKey: `connector:${row.id}:${row.auth_strategy === "shared" ? "shared" : userId}`,
        cachedTools,
        allowedTools: cachedTools.map((tool) => tool.name),
        ...(credential ? { credential } : {}),
      });
    }
    return servers;
  }

  async handleGoogleMcp(authorization: string | undefined, connectorKey: string, request: unknown): Promise<{ status: number; body?: unknown }> {
    if (!isGoogleKey(connectorKey)) return { status: 404, body: rpcError(null, -32601, "Unknown connector") };
    const credential = bearer(authorization);
    if (!credential) return { status: 401, body: rpcError(null, -32001, "Connector authorization is required") };
    const session = this.#verifySession(credential);
    if (session.connectorKey !== connectorKey) return { status: 403, body: rpcError(null, -32001, "Connector token audience mismatch") };
    const rpc = rpcRequest(request);
    if (rpc.method === "notifications/initialized") return { status: 202 };
    if (rpc.method === "initialize") return { status: 200, body: { jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: false } }, serverInfo: { name: `berry-${connectorKey}`, version: "1.0.0" } } } };
    if (rpc.method === "ping") return { status: 200, body: { jsonrpc: "2.0", id: rpc.id, result: {} } };
    const row = await this.#row(session.tenantId, BUILT_INS[connectorKey].id);
    if (!row.enabled) return { status: 403, body: rpcError(rpc.id, -32001, "Connector is disabled") };
    const accessLevel: ConnectorAccessLevel = row.max_access_level === "read" ? "read" : session.accessLevel;
    const connection = await this.#connection(session.tenantId, row.id, session.userId);
    if (!connection || connection.status !== "connected") return { status: 403, body: rpcError(rpc.id, -32001, "Google connector is not connected") };
    const grantedScopes = connection.granted_scopes ?? [];
    if (rpc.method === "tools/list") return { status: 200, body: { jsonrpc: "2.0", id: rpc.id, result: { tools: googleToolCatalog(connectorKey, accessLevel, grantedScopes) } } };
    if (rpc.method !== "tools/call") return { status: 200, body: rpcError(rpc.id, -32601, `Method ${rpc.method} is not supported`) };
    try {
      const params = requiredObject(rpc.params, "params");
      const name = requiredTokenString(params.name, "tool name");
      const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? params.arguments as Record<string, unknown> : {};
      const accessToken = await this.#googleAccessToken(session.tenantId, row, connection);
      const result = await executeGoogleTool(connectorKey, accessLevel, name, accessToken, args, connection.account_email, grantedScopes);
      return { status: 200, body: { jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: false } } };
    } catch (cause) {
      return { status: 200, body: { jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: cause instanceof Error ? cause.message : "Google connector tool failed" }], isError: true } } };
    }
  }

  googleCallbackUrl(): string { return new URL("/v1/connectors/google/callback", this.#publicApiBase()).toString(); }
  webRedirect(path: string, params: Record<string, string>): string {
    const url = new URL(path, this.env.BERRY_WEB_PUBLIC_URL?.trim() || this.#publicApiBase());
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.toString();
  }

  #connectorView(row: ConnectorRow, connections: Map<string, ConnectionRow>, userId: string, providerConfigured: boolean): Connector {
    const connection = connections.get(`${row.id}:${row.auth_strategy === "shared" ? "shared" : userId}`);
    const googleKey = isGoogleKey(row.connector_key) ? row.connector_key : null;
    const google = googleKey !== null;
    const noAuth = row.auth_type === "none";
    const credentialConfigured = google ? Boolean(connection?.credential_envelope) : row.auth_strategy === "shared" ? Boolean(connectorEnvelope(row.shared_credential_envelope)) : Boolean(connection?.credential_envelope);
    const connectedAccessLevel = connection?.status === "connected"
      ? row.max_access_level === "read" ? "read" : connection.access_level
      : null;
    const visibleGoogleAccessLevel = connectedAccessLevel ?? row.max_access_level;
    const config = customConfig(row.config);
    return {
      id: row.id,
      key: row.connector_key,
      kind: row.kind,
      provider: row.provider,
      name: row.name,
      description: row.description,
      enabled: row.enabled,
      maxAccessLevel: row.max_access_level,
      workspaceAccessMode: google && row.connector_key === "google-workspace" ? row.workspace_access_mode ?? "selected_files" : null,
      authStrategy: row.auth_strategy,
      authType: row.auth_type,
      publicationStatus: row.publication_status,
      transport: row.transport,
      url: row.endpoint_url,
      websiteUrl: googleKey ? BUILT_INS[googleKey].websiteUrl : config.websiteUrl ?? null,
      privacyPolicyUrl: googleKey ? BUILT_INS[googleKey].privacyPolicyUrl : config.privacyPolicyUrl ?? null,
      configured: google ? providerConfigured : Boolean(row.endpoint_url),
      credentialConfigured,
      connectionStatus: noAuth ? "connected" : connection?.status ?? (row.auth_strategy === "shared" && credentialConfigured ? "connected" : "not_connected"),
      connectedAccessLevel: noAuth ? row.max_access_level : connectedAccessLevel ?? (row.auth_strategy === "shared" && credentialConfigured ? row.max_access_level : null),
      accountEmail: connection?.account_email ?? null,
      grantedScopes: connection?.granted_scopes ?? [],
      services: googleKey ? GOOGLE_CONNECTOR_SERVICES[googleKey] : ["Custom MCP"],
      tools: googleKey ? googleToolCatalog(googleKey, visibleGoogleAccessLevel, connection?.granted_scopes?.length ? connection.granted_scopes : undefined).map((item) => item.name) : config.allowedTools ?? [],
      limitations: google ? [] : ["The administrator's exact tool allowlist is enforced, and Berry requires approval for every custom MCP call. Server-supplied safety annotations are not trusted."],
      createdAt: virtual(row.created_at),
      updatedAt: virtual(row.updated_at),
    };
  }

  async #ensureBuiltIn(db: SqlExecutor, tenantId: string, key: GoogleConnectorKey, userId: string): Promise<void> {
    const definition = BUILT_INS[key];
    await db.execute(`
      INSERT INTO organization_connectors (id, tenant_id, connector_key, kind, provider, name, description, enabled, max_access_level, workspace_access_mode, auth_strategy, auth_type, publication_status, created_by)
      VALUES ($1,$2::uuid,$3,'app','google',$4,$5,false,'read',CASE WHEN $3='google-workspace' THEN 'selected_files' ELSE NULL END,'personal','oauth','published',$6)
      ON CONFLICT (tenant_id, connector_key) DO NOTHING
    `, [definition.id, tenantId, key, definition.name, definition.description, userId]);
  }

  async #providerCredential(tenantId: string): Promise<{ clientId: string; clientSecret: string; hostedDomain: string | null; pickerApiKey: string | null; pickerProjectNumber: string | null } | null> {
    const rows = await this.database.withTenant(tenantId, (db) => db.query<ProviderCredentialRow>("SELECT * FROM connector_provider_credentials WHERE provider='google' LIMIT 1"));
    const row = rows[0];
    const envelope = connectorEnvelope(row?.client_secret_envelope);
    if (!row?.client_id || !envelope) return null;
    const pickerEnvelope = connectorEnvelope(row.picker_api_key_envelope);
    return {
      clientId: row.client_id,
      clientSecret: await this.#open(envelope, providerContext(tenantId, "client-secret")),
      hostedDomain: row.hosted_domain ?? null,
      pickerApiKey: pickerEnvelope ? await this.#open(pickerEnvelope, providerContext(tenantId, "picker-api-key")) : null,
      pickerProjectNumber: row.picker_project_number ?? null,
    };
  }

  async #row(tenantId: string, id: string): Promise<ConnectorRow> {
    const rows = await this.database.withTenant(tenantId, (db) => db.query<ConnectorRow>("SELECT * FROM organization_connectors WHERE id=$1 LIMIT 1", [id]));
    if (!rows[0]) throw new NotFoundException("Connector not found");
    return rows[0];
  }

  async #connection(tenantId: string, connectorId: string, userId: string): Promise<ConnectionRow | null> {
    const rows = await this.database.withTenant(tenantId, (db) => db.query<ConnectionRow>("SELECT * FROM connector_connections WHERE connector_id=$1 AND user_id=$2 LIMIT 1", [connectorId, userId]));
    return rows[0] ?? null;
  }

  async #upsertConnection(
    tenantId: string,
    connectorId: string,
    userId: string,
    accessLevel: ConnectorAccessLevel,
    envelope: ConnectorSecretEnvelope,
    accountEmail: string | null,
    accountSubject: string | null,
    scopes: string[],
    expiresAt: string | null,
  ): Promise<void> {
    await this.database.withTenant(tenantId, (db) => this.#upsertConnectionWith(
      db,
      tenantId,
      connectorId,
      userId,
      accessLevel,
      envelope,
      accountEmail,
      accountSubject,
      scopes,
      expiresAt,
    ));
  }

  async #upsertConnectionWith(
    db: SqlExecutor,
    tenantId: string,
    connectorId: string,
    userId: string,
    accessLevel: ConnectorAccessLevel,
    envelope: ConnectorSecretEnvelope,
    accountEmail: string | null,
    accountSubject: string | null,
    scopes: string[],
    expiresAt: string | null,
  ): Promise<void> {
    await db.execute(`
      INSERT INTO connector_connections (id, tenant_id, connector_id, user_id, access_level, credential_envelope, account_email, account_subject, granted_scopes, status, expires_at)
      VALUES ($1,$2::uuid,$3,$4,$5,$6::jsonb,$7,$8,$9::text[],'connected',$10::timestamptz)
      ON CONFLICT (tenant_id, connector_id, user_id) WHERE user_id IS NOT NULL DO UPDATE SET
        access_level=EXCLUDED.access_level, credential_envelope=EXCLUDED.credential_envelope,
        account_email=EXCLUDED.account_email, account_subject=EXCLUDED.account_subject,
        granted_scopes=EXCLUDED.granted_scopes, status='connected', expires_at=EXCLUDED.expires_at,
        last_error_code=NULL, updated_at=now()
    `, [`connection_${randomUUID()}`, tenantId, connectorId, userId, accessLevel, JSON.stringify(envelope), accountEmail, accountSubject, scopes, expiresAt]);
  }

  async #openGoogleToken(tenantId: string, connectorId: string, userId: string, connection: ConnectionRow): Promise<StoredGoogleToken | null> {
    const envelope = connectorEnvelope(connection.credential_envelope);
    if (!envelope) return null;
    try {
      const parsed = JSON.parse(await this.#open(envelope, connectionContext(tenantId, connectorId, userId))) as Partial<StoredGoogleToken>;
      if (!parsed.accessToken || !parsed.expiresAt || !Array.isArray(parsed.scope)) return null;
      return { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken ?? null, tokenType: parsed.tokenType ?? "Bearer", expiresAt: parsed.expiresAt, scope: parsed.scope };
    } catch { return null; }
  }

  async #googleAccessToken(tenantId: string, connector: ConnectorRow, connection: ConnectionRow): Promise<string> {
    const stored = await this.#openGoogleToken(tenantId, connector.id, connection.user_id!, connection);
    if (!stored) throw new Error("Google credentials cannot be opened");
    if (new Date(stored.expiresAt).getTime() > Date.now() + 90_000) return stored.accessToken;
    if (!stored.refreshToken) {
      await this.#markConnection(tenantId, connection.id, "reauth_required", "refresh_token_missing");
      throw new Error("Google connection has expired; reconnect it in Settings → Connectors");
    }
    const provider = await this.#providerCredential(tenantId);
    if (!provider) throw new ServiceUnavailableException("Google OAuth configuration is missing");
    try {
      const refreshed = await googleTokenRequest({ client_id: provider.clientId, client_secret: provider.clientSecret, refresh_token: stored.refreshToken, grant_type: "refresh_token" });
      const next: StoredGoogleToken = {
        accessToken: requiredTokenString(refreshed.access_token, "access_token"),
        refreshToken: typeof refreshed.refresh_token === "string" ? refreshed.refresh_token : stored.refreshToken,
        tokenType: typeof refreshed.token_type === "string" ? refreshed.token_type : stored.tokenType,
        expiresAt: new Date(Date.now() + Number(refreshed.expires_in ?? 3600) * 1000).toISOString(),
        scope: typeof refreshed.scope === "string" ? refreshed.scope.split(/\s+/).filter(Boolean) : stored.scope,
      };
      const envelope = await this.#seal(JSON.stringify(next), connectionContext(tenantId, connector.id, connection.user_id!));
      await this.database.withTenant(tenantId, (db) => db.execute("UPDATE connector_connections SET credential_envelope=$1::jsonb, expires_at=$2::timestamptz, granted_scopes=$3::text[], status='connected', last_error_code=NULL, last_successful_use_at=now(), updated_at=now() WHERE id=$4", [JSON.stringify(envelope), next.expiresAt, next.scope, connection.id]));
      return next.accessToken;
    } catch (cause) {
      await this.#markConnection(tenantId, connection.id, "reauth_required", googleOAuthErrorCode(cause));
      throw new Error(`Google connection for ${connector.name} has expired; reconnect it in Settings → Connectors`);
    }
  }

  async #markConnection(tenantId: string, id: string, status: "reauth_required" | "error", errorCode: string): Promise<void> {
    await this.database.withTenant(tenantId, (db) => db.execute("UPDATE connector_connections SET status=$1, last_error_code=$2, updated_at=now() WHERE id=$3", [status, errorCode.slice(0, 120), id]));
  }

  async #customCredential(tenantId: string, userId: string, row: ConnectorRow, persistRefresh: boolean): Promise<string | undefined> {
    if (row.auth_type === "none") return undefined;
    const connection = row.auth_strategy === "personal" ? await this.#connection(tenantId, row.id, userId) : null;
    const envelope = row.auth_strategy === "shared" ? connectorEnvelope(row.shared_credential_envelope) : connectorEnvelope(connection?.credential_envelope);
    if (!envelope) return undefined;
    const context = row.auth_strategy === "shared" ? sharedCredentialContext(tenantId, row.id) : connectionContext(tenantId, row.id, userId);
    const opened = await this.#open(envelope, context);
    if (row.auth_type === "bearer") return opened;
    let stored = JSON.parse(opened) as StoredMcpOAuth;
    const tokens = stored.state.tokens;
    if (!tokens?.access_token) return undefined;
    const expiresIn = typeof tokens.expires_in === "number" ? tokens.expires_in : null;
    const expired = expiresIn !== null && Date.parse(stored.obtainedAt) + expiresIn * 1000 <= Date.now() + 90_000;
    if (expired && tokens.refresh_token && row.endpoint_url) {
      const config = customConfig(row.config);
      const endpoint = await safeRemoteUrl(row.endpoint_url, this.env.NODE_ENV !== "production");
      stored = { state: await refreshRemoteMcpOAuth({ serverUrl: endpoint, callbackUrl: this.mcpCallbackUrl(), state: stored.state, ...(config.oauthScope ? { scope: config.oauthScope } : {}) }), obtainedAt: new Date().toISOString() };
      if (persistRefresh) {
        const refreshedEnvelope = await this.#seal(JSON.stringify(stored), context);
        if (row.auth_strategy === "shared") await this.database.withTenant(tenantId, (db) => db.execute("UPDATE organization_connectors SET shared_credential_envelope=$1::jsonb, updated_at=now() WHERE id=$2", [JSON.stringify(refreshedEnvelope), row.id]));
        else if (connection) await this.database.withTenant(tenantId, (db) => db.execute("UPDATE connector_connections SET credential_envelope=$1::jsonb, updated_at=now() WHERE id=$2", [JSON.stringify(refreshedEnvelope), connection.id]));
      }
    }
    return stored.state.tokens?.access_token;
  }

  async #invalidateCustomCredential(tenantId: string, userId: string, row: ConnectorRow): Promise<void> {
    const errorCode = row.auth_type === "oauth" ? "mcp_oauth_refresh_failed" : "mcp_credential_unavailable";
    await this.database.withTenant(tenantId, async (db) => {
      if (row.auth_strategy === "shared") {
        await db.execute("UPDATE organization_connectors SET shared_credential_envelope=NULL, updated_at=now() WHERE tenant_id=$1::uuid AND id=$2", [tenantId, row.id]);
        return;
      }
      await db.execute(`
        UPDATE connector_connections
        SET status='reauth_required',credential_envelope=NULL,last_error_code=$4,updated_at=now()
        WHERE tenant_id=$1::uuid AND connector_id=$2 AND user_id=$3
      `, [tenantId, row.id, userId, errorCode]);
    });
  }

  async #seal(plaintext: string, context: string): Promise<ConnectorSecretEnvelope> {
    return sealConnectorSecret(plaintext, this.#encryptionKeys()[0]!, context);
  }

  async #open(envelope: ConnectorSecretEnvelope, context: string): Promise<string> {
    return openConnectorSecret(envelope, this.#encryptionKeys(), context);
  }

  #encryptionKeys(): string[] {
    const primary = this.env.BERRY_CONNECTOR_ENCRYPTION_KEY?.trim();
    if (!primary) throw new ServiceUnavailableException("BERRY_CONNECTOR_ENCRYPTION_KEY is required for connector credentials");
    return [primary, ...(this.env.BERRY_CONNECTOR_DECRYPTION_KEYS ?? "").split(",").map((value) => value.trim()).filter(Boolean)];
  }

  #encryptionKey(): string {
    return this.#encryptionKeys()[0]!;
  }

  #publicApiBase(): string { return this.env.BERRY_AUTH_BASE_URL?.trim() || "http://localhost:3001"; }
  #internalMcpUrl(key: GoogleConnectorKey): string { return new URL(`/v1/connectors/mcp/${key}`, this.#publicApiBase()).toString(); }
  mcpCallbackUrl(): string { return new URL("/v1/connectors/mcp/oauth/callback", this.#publicApiBase()).toString(); }
  #signSession(session: ConnectorSession): string {
    const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
    const signature = createHmac("sha256", Buffer.from(this.#encryptionKey(), "base64")).update(payload).digest("base64url");
    return `${payload}.${signature}`;
  }
  #verifySession(token: string): ConnectorSession {
    const [payload, signature] = token.split(".");
    if (!payload || !signature) throw new BadRequestException("Connector token is invalid");
    const expected = createHmac("sha256", Buffer.from(this.#encryptionKey(), "base64")).update(payload).digest();
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new BadRequestException("Connector token signature is invalid");
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as ConnectorSession;
    if (!parsed.tenantId || !parsed.userId || !isGoogleKey(parsed.connectorKey) || !["read", "full"].includes(parsed.accessLevel) || parsed.exp < Math.floor(Date.now() / 1000)) throw new BadRequestException("Connector token is invalid or expired");
    return parsed;
  }
  #find(connectors: Connector[], id: string): Connector { const connector = connectors.find((item) => item.id === id); if (!connector) throw new NotFoundException("Connector not found"); return connector; }
}

function virtualBuiltIn(key: GoogleConnectorKey): ConnectorRow {
  const item = BUILT_INS[key];
  return { id: item.id, connector_key: key, kind: "app", provider: "google", name: item.name, description: item.description, enabled: false, max_access_level: "read", workspace_access_mode: key === "google-workspace" ? "selected_files" : null, auth_strategy: "personal", transport: null, endpoint_url: null, auth_type: "oauth", publication_status: "published", shared_credential_envelope: null, config: {}, created_at: "", updated_at: "" };
}
function virtual(value: Date | string): string | null { if (!value) return null; return new Date(value).toISOString(); }
function isGoogleKey(value: string): value is GoogleConnectorKey { return (GOOGLE_KEYS as readonly string[]).includes(value); }
function connectorEnvelope(value: unknown): ConnectorSecretEnvelope | null { const result = ConnectorSecretEnvelopeSchema.safeParse(value); return result.success ? result.data : null; }
async function safeRemoteUrl(raw: string, allowLocalDevelopment: boolean): Promise<string> {
  const parsed = new URL(raw); const local = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  if (local && allowLocalDevelopment && parsed.protocol === "http:") return parsed.toString();
  try { return (await resolvePublicRemoteUrl(raw)).toString(); }
  catch (cause) { throw new BadRequestException(cause instanceof Error ? cause.message : "Invalid MCP URL"); }
}
function customConfig(value: unknown): CustomConnectorConfig { return value && typeof value === "object" && !Array.isArray(value) ? value as CustomConnectorConfig : {}; }
function providerContext(tenantId: string, purpose: string) { return `${tenantId}:provider:google:${purpose}`; }
function sharedCredentialContext(tenantId: string, connectorId: string) { return `${tenantId}:connector:${connectorId}:shared-credential`; }
function connectionContext(tenantId: string, connectorId: string, userId: string) { return `${tenantId}:connector:${connectorId}:user:${userId}:credential`; }
function oauthStateContext(tenantId: string, digest: string) { return `${tenantId}:oauth-state:${digest}`; }
function sha256(value: string) { return createHash("sha256").update(value).digest("hex"); }
function googleOAuthErrorCode(cause: unknown) { const message = cause instanceof Error ? cause.message : "token_refresh_failed"; if (/invalid_grant/i.test(message)) return "invalid_grant"; if (/admin_policy_enforced/i.test(message)) return "admin_policy_enforced"; return "token_refresh_failed"; }
function bearer(header: string | undefined): string | null { const match = header?.match(/^Bearer\s+(.+)$/i); return match?.[1]?.trim() || null; }
function rpcRequest(value: unknown): { id: string | number | null; method: string; params: unknown } { const body = requiredObject(value, "JSON-RPC request"); if (body.jsonrpc !== "2.0" || typeof body.method !== "string") throw new BadRequestException("Invalid JSON-RPC request"); return { id: typeof body.id === "string" || typeof body.id === "number" ? body.id : null, method: body.method, params: body.params }; }
function rpcError(id: string | number | null, code: number, message: string) { return { jsonrpc: "2.0", id, error: { code, message } }; }
function requiredObject(value: unknown, name: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new BadRequestException(`${name} is required`); return value as Record<string, unknown>; }
function requiredTokenString(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new BadRequestException(`${name} is required`); return value; }

async function googleTokenRequest(body: Record<string, string>): Promise<Record<string, unknown>> {
  const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body), signal: AbortSignal.timeout(20_000) });
  const value = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new BadRequestException(`Google token exchange failed: ${typeof value.error_description === "string" ? value.error_description : typeof value.error === "string" ? value.error : response.status}`);
  return value;
}
async function revokeGoogleToken(token: string): Promise<void> {
  const response = await fetch("https://oauth2.googleapis.com/revoke", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }), signal: AbortSignal.timeout(10_000) });
  if (!response.ok && response.status !== 400) throw new Error(`Google revocation failed with HTTP ${response.status}`);
}
async function googleUserInfo(accessToken: string): Promise<{ email: string; sub: string }> {
  const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10_000) });
  const value = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || typeof value.email !== "string" || typeof value.sub !== "string") throw new BadRequestException("Google account identity could not be verified");
  return { email: value.email, sub: value.sub };
}
