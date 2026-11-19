import { mcpOAuthStartError } from "./mcp-oauth-error.ts";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import {
  completeRemoteMcpOAuth,
  discoverRemoteMcpTools,
  McpOAuthRefreshError,
  refreshRemoteMcpOAuth,
  resolvePublicRemoteUrl,
  startRemoteMcpOAuth,
  validateRemoteMcpOAuthIssuer,
  type McpOAuthState,
  type McpServerSpec,
} from "@berry/local-agent";
import { McpConnectionError, type McpResolvedCredential } from "@berry/local-agent/mcp";
import {
  ConnectorSecretEnvelopeSchema,
  ConnectorSchema,
  DurableMcpServerSchema,
  McpCredentialRequestSchema,
  isStoredMcpCredentialRef,
  openConnectorSecret,
  openDurableSecret,
  sealConnectorSecret,
  type Connector,
  type ConnectorAccessLevel,
  type ConnectorSecretEnvelope,
  type ConnectorWorkspaceAccessMode,
  type DurableMcpServer,
  type DurableSecretEnvelope,
  type McpCredentialRequest,
  type McpCredentialResult,
  type TaskConnectorReconnect,
} from "@berry/shared";
import type { CloudDatabaseService, SqlExecutor } from "../db/cloud-database.service.ts";
import {
  DEFAULT_GOOGLE_CONNECTOR_ACCESS_LEVEL,
  executeGoogleTool,
  GOOGLE_CONNECTOR_SERVICES,
  googleConnectorScopes,
  googleToolCatalog,
  googleToolsRequiringApproval,
  type ConnectorArtifactImport,
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
  approval_status?: "pending" | "approved" | "rejected";
  requested_by?: string | null;
  reviewed_by?: string | null;
  reviewed_at?: Date | string | null;
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
const CONNECTOR_SESSION_MAX_RUN_EXTENSION_SECONDS = 24 * 60 * 60;
const CONNECTOR_SESSION_ENDED_MESSAGE = "Berry's connector session for this task has ended. This is not a Google sign-in problem and does not require reconnecting Google; send a new message to continue.";

type ConnectorSession = {
  tenantId: string;
  userId: string;
  connectorKey: GoogleConnectorKey;
  accessLevel: ConnectorAccessLevel;
  taskId?: string;
  sessionId?: string;
  exp: number;
};

type StoredMcpOAuth = {
  state: McpOAuthState;
  obtainedAt: string;
  authorizedAt?: string;
  grantId?: string;
  version?: string;
  reauthRequired?: true;
  // Commit the claim before sending a rotating refresh request. An interrupted
  // claimant leaves proof that the outcome may be unknown, even after restart.
  refresh?: { claimId: string | null; until: number; uncertain: boolean; invalidGrant?: true; configuration?: true };
};
type McpGrant = { stored: StoredMcpOAuth; grantId: string; version: string; context: string; connection: ConnectionRow | null };
type McpAdmission = { server: DurableMcpServer; createdAt: string | Date; userId: string };
type McpRefreshClaim = { row: ConnectorRow; grant: McpGrant; claimId: string; uncertain: boolean };
type McpResolution = McpCredentialResult | { status: "waiting" } | { status: "refresh"; claim: McpRefreshClaim };
const MCP_REFRESH_CLAIM_MS = 45_000;
const MCP_REFRESH_COOLDOWN_MS = 30_000;
type CustomConnectorConfig = {
  discoveredTools?: Array<{ name: string; description: string | null; inputSchema: Record<string, unknown>; annotations?: Record<string, boolean> }>;
  allowedTools?: string[];
  oauthScope?: string;
  websiteUrl?: string;
  privacyPolicyUrl?: string;
  lastDiscoveredAt?: string;
  serverApproved?: boolean;
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
    const custom = await Promise.all(rows.filter((row) => row.kind === "custom_mcp").map(async (row) => {
      const view = this.#connectorView(row, byConnector, userId, true);
      if (row.auth_strategy !== "shared" || row.auth_type !== "oauth") return view;
      const envelope = connectorEnvelope(row.shared_credential_envelope);
      const grant = envelope ? await this.#openMcpGrant(envelope, sharedCredentialContext(tenantId, row.id)) : null;
      return grant?.reauthRequired ? { ...view, connectionStatus: "reauth_required" as const, connectedAccessLevel: null } : view;
    }));
    return ConnectorSchema.array().parse([...builtIns, ...custom]);
  }

  async listCustomRequests(tenantId: string, userId: string): Promise<Connector[]> {
    const rows = await this.database.withTenant(tenantId, (db) => db.query<{ id: string }>(`
      SELECT request.connector_id AS id
      FROM connector_approval_requests AS request
      JOIN organization_connectors AS connector
        ON connector.tenant_id=request.tenant_id AND connector.id=request.connector_id
      WHERE request.user_id=$1 AND connector.kind='custom_mcp'
      ORDER BY request.requested_at DESC
    `, [userId]));
    const visible = new Set(rows.map((row) => row.id));
    return (await this.list(tenantId, userId)).filter((connector) => visible.has(connector.id));
  }

  async requestCustom(tenantId: string, userId: string, input: { url: string }): Promise<Connector> {
    const url = await safeRemoteUrl(input.url, this.env.NODE_ENV !== "production");
    const id = await this.database.withTenant(tenantId, async (db) => {
      await db.execute(
        "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
        [`berry-custom-mcp-request:${tenantId}:${url}`],
      );
      const existingRows = await db.query<ConnectorRow>(`
        SELECT * FROM organization_connectors
        WHERE kind='custom_mcp' AND endpoint_url=$1
        ORDER BY CASE
          WHEN approval_status='approved' AND publication_status='published' AND enabled=true THEN 0
          WHEN approval_status='pending' THEN 1
          WHEN approval_status='rejected' THEN 2
          ELSE 3
        END, created_at
        LIMIT 1
      `, [url]);
      const existing = existingRows[0];
      if (existing) {
        const approvedAndAvailable = (existing.approval_status ?? "approved") === "approved"
          && existing.publication_status === "published"
          && existing.enabled;
        if (approvedAndAvailable) return existing.id;
        if (existing.approval_status === "pending") {
          await this.#recordCustomRequest(db, tenantId, existing.id, userId);
          return existing.id;
        }
        if (existing.approval_status === "rejected") {
          await db.execute(`
            UPDATE organization_connectors
            SET approval_status='pending', requested_by=$1, reviewed_by=NULL, reviewed_at=NULL,
                enabled=false, publication_status='draft',
                config=$2::jsonb, updated_at=now()
            WHERE id=$3
          `, [userId, JSON.stringify({ ...customConfig(existing.config), serverApproved: false }), existing.id]);
          await this.#recordCustomRequest(db, tenantId, existing.id, userId);
          return existing.id;
        }
        if ((existing.approval_status ?? "approved") === "approved") {
          throw new ConflictException("This MCP server already exists but is not available. Ask an administrator to enable and publish it.");
        }
      }

      const createdId = `connector_mcp_${randomUUID()}`;
      await db.execute(`
        INSERT INTO organization_connectors (
          id, tenant_id, connector_key, kind, provider, name, description, enabled,
          max_access_level, auth_strategy, transport, endpoint_url, auth_type,
          publication_status, config, created_by, approval_status, requested_by
        ) VALUES (
          $1,$2::uuid,$3,'custom_mcp','mcp',$4,$5,false,
          'full','personal','streamable-http',$6,'oauth',
          'draft',$7::jsonb,$8,'pending',$8
        )
      `, [
        createdId,
        tenantId,
        `custom-mcp-${randomUUID()}`,
        mcpNameFromUrl(url),
        `Streamable HTTP MCP server at ${new URL(url).hostname}.`,
        url,
        JSON.stringify({ serverApproved: false } satisfies CustomConnectorConfig),
        userId,
      ]);
      await this.#recordCustomRequest(db, tenantId, createdId, userId);
      return createdId;
    });
    return this.#find(await this.list(tenantId, userId), id);
  }

  async reviewCustomRequest(tenantId: string, userId: string, id: string, decision: "approved" | "rejected"): Promise<Connector> {
    const approved = decision === "approved";
    const reviewed = await this.database.withTenant(tenantId, (db) => db.query<{ id: string }>(`
      UPDATE organization_connectors
      SET approval_status=$1, reviewed_by=$2, reviewed_at=now(),
          enabled=$3, publication_status=$4,
          config=COALESCE(config, '{}'::jsonb) || jsonb_build_object('serverApproved', $3::boolean),
          updated_at=now()
      WHERE id=$5 AND kind='custom_mcp' AND approval_status='pending'
      RETURNING id
    `, [decision, userId, approved, approved ? "published" : "draft", id]));
    if (!reviewed[0]) {
      await this.#row(tenantId, id);
      throw new BadRequestException("This MCP request is no longer pending");
    }
    return this.#find(await this.list(tenantId, userId), id);
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
    const savedId = await this.database.withTenant(tenantId, async (db) => {
      const existing = input.id ? (await db.query<ConnectorRow>("SELECT * FROM organization_connectors WHERE id=$1 FOR UPDATE", [input.id]))[0] : null;
      if (input.id && !existing) throw new NotFoundException("Connector not found");
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
        ...(!authorityChanged && priorConfig.serverApproved !== undefined ? { serverApproved: priorConfig.serverApproved } : {}),
        ...(!authorityChanged && priorConfig.discoveredTools ? { discoveredTools: priorConfig.discoveredTools } : {}),
        ...(!authorityChanged && priorConfig.allowedTools ? { allowedTools: priorConfig.allowedTools } : {}),
        ...(!authorityChanged && priorConfig.lastDiscoveredAt ? { lastDiscoveredAt: priorConfig.lastDiscoveredAt } : {}),
        ...(input.oauthScope?.trim() ? { oauthScope: input.oauthScope.trim() } : {}),
        ...(input.websiteUrl?.trim() ? { websiteUrl: new URL(input.websiteUrl).toString() } : {}),
        ...(input.privacyPolicyUrl?.trim() ? { privacyPolicyUrl: new URL(input.privacyPolicyUrl).toString() } : {}),
      };
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
      return id;
    });
    return this.#find(await this.list(tenantId, userId), savedId);
  }

  async discoverCustom(tenantId: string, userId: string, id: string): Promise<Connector> {
    const row = await this.#row(tenantId, id);
    if (row.kind !== "custom_mcp" || !row.endpoint_url || !row.transport) throw new BadRequestException("Custom MCP is incomplete");
    if (customConfig(row.config).serverApproved) throw new BadRequestException("Organization catalog servers discover their tools through each user's connection");
    const endpoint = await safeRemoteUrl(row.endpoint_url, this.env.NODE_ENV !== "production");
    const tools = await this.#discoverCustomTools(tenantId, userId, row, endpoint);
    const config = customConfig(row.config);
    const next: CustomConnectorConfig = { ...config, discoveredTools: tools, allowedTools: tools.map((tool) => tool.name), lastDiscoveredAt: new Date().toISOString() };
    await this.database.withTenant(tenantId, (db) => db.execute(`
      UPDATE organization_connectors SET config=$1::jsonb, publication_status='draft', enabled=false, updated_at=now()
      WHERE id=$2 AND config=$3::jsonb AND endpoint_url=$4 AND transport=$5 AND auth_type=$6 AND auth_strategy=$7
    `, [JSON.stringify(next), id, JSON.stringify(config), row.endpoint_url, row.transport, row.auth_type, row.auth_strategy]));
    return this.#find(await this.list(tenantId, userId), id);
  }

  async publishCustom(tenantId: string, userId: string, id: string, input: { enabled: boolean; allowedTools?: string[] | undefined }): Promise<Connector> {
    const row = await this.#row(tenantId, id);
    if (row.kind !== "custom_mcp") throw new BadRequestException("Only custom MCP connectors can be published");
    if ((row.approval_status ?? "approved") !== "approved") throw new BadRequestException("Approve this MCP server before publishing it");
    const config = customConfig(row.config);
    if (config.serverApproved) throw new BadRequestException("Organization catalog servers are published by the approval workflow");
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
    if ((row.approval_status ?? "approved") !== "approved") throw new BadRequestException("This MCP server is awaiting organization approval");
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
    await this.database.withTenant(tenantId, async (db) => {
      await db.query("SELECT id FROM organization_connectors WHERE id=$1 FOR UPDATE", [id]);
      await db.execute("DELETE FROM connector_connections WHERE connector_id=$1 AND user_id=$2", [id, userId]);
      await db.execute("DELETE FROM connector_oauth_states WHERE connector_id=$1 AND user_id=$2", [id, userId]);
    });
    return { ok: true };
  }

  async startGoogleOAuth(tenantId: string, userId: string, id: string, accessLevel: ConnectorAccessLevel, taskId?: string) {
    const row = await this.#row(tenantId, id);
    if (!isGoogleKey(row.connector_key)) throw new BadRequestException("This connector does not use Google OAuth");
    if (!row.enabled) throw new BadRequestException("This connector is disabled by the administrator");
    if (accessLevel === "full" && row.max_access_level !== "full") throw new BadRequestException("Full access has not been enabled by the administrator");
    if (taskId) {
      const action = (await this.#taskMcpReconnects(tenantId, userId, taskId, false)).find((candidate) => candidate.connectorId === id);
      if (!action?.canReconnect || action.accessLevel !== accessLevel) {
        throw new BadRequestException("This task no longer needs to reconnect this Google account");
      }
    }
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
      await db.execute("DELETE FROM connector_oauth_states WHERE expires_at <= now()");
      await db.execute(`
        INSERT INTO connector_oauth_states (state_digest, tenant_id, connector_id, user_id, access_level, requested_scopes, code_verifier_envelope, redirect_after, expires_at)
        VALUES ($1,$2::uuid,$3,$4,$5,$6::text[],$7::jsonb,$8,$9::timestamptz)
      `, [stateDigest, tenantId, row.id, userId, accessLevel, scopes, JSON.stringify(verifierEnvelope), taskId ? `/tasks/${taskId}` : "/settings/connectors", expiresAt.toISOString()]);
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

  async completeGoogleOAuth(tenantId: string, userId: string, input: { state: string; code?: string; error?: string }): Promise<{ redirectAfter: string; connectorId: string; error?: string }> {
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
      const previous = existing?.account_subject === profile.sub ? await this.#openGoogleToken(tenantId, row.id, userId, existing) : null;
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
    } catch (cause) {
      if (!flow.redirect_after.startsWith("/tasks/")) throw cause;
      return {
        redirectAfter: flow.redirect_after,
        connectorId: flow.connector_id,
        error: (cause instanceof Error ? cause.message : "Google authorization failed").slice(0, 240),
      };
    } finally {
      await this.database.withTenant(tenantId, (db) => db.execute("DELETE FROM connector_oauth_states WHERE state_digest=$1", [stateDigest]));
    }
  }

  async startCustomOAuth(tenantId: string, userId: string, id: string, allowShared = false, redirectAfter = "/settings/connectors", taskId?: string) {
    const row = await this.#row(tenantId, id);
    if (row.kind !== "custom_mcp" || row.auth_type !== "oauth" || !row.endpoint_url) throw new BadRequestException("This connector does not use MCP OAuth");
    if ((row.approval_status ?? "approved") !== "approved") throw new BadRequestException("This MCP server is awaiting organization approval");
    if (row.auth_strategy === "shared" && !allowShared) throw new BadRequestException("Only an administrator can authorize this organization-wide connector");
    if ((!allowShared || taskId) && (row.publication_status !== "published" || !row.enabled)) throw new BadRequestException("This connector is not available to members");
    const reconnect = taskId ? (await this.#taskMcpReconnects(tenantId, userId, taskId, allowShared)).find((action) => action.connectorId === id) : undefined;
    if (taskId && !reconnect?.canReconnect) throw new ForbiddenException("This task has no eligible reconnect action for this connector");
    const grantId = reconnect?.grantId ?? (await this.database.withTenant(tenantId, (db) => this.#readMcpGrant(db, tenantId, userId, row)))?.grantId ?? null;
    const endpoint = await safeRemoteUrl(row.endpoint_url, this.env.NODE_ENV !== "production");
    const state = randomBytes(32).toString("base64url"); const stateDigest = sha256(state); const config = customConfig(row.config); const callbackUrl = this.mcpCallbackUrl();
    const clientMetadataUrl = this.mcpClientMetadataUrl();
    const started = await startRemoteMcpOAuth({ serverUrl: endpoint, callbackUrl, requestState: state, ...(config.oauthScope ? { scope: config.oauthScope } : {}), ...(clientMetadataUrl ? { clientMetadataUrl } : {}) }).catch((cause: unknown) => { throw mcpOAuthStartError(cause, endpoint); });
    const envelope = await this.#seal(JSON.stringify({ type: "mcp", state: started.state, authority: mcpAuthority(row), grantId,
      ...(reconnect ? { taskId } : {}),
    }), oauthStateContext(tenantId, stateDigest));
    const expiresAt = new Date(Date.now() + 10 * 60_000);
    await this.database.withTenant(tenantId, async (db) => {
      await db.execute("DELETE FROM connector_oauth_states WHERE expires_at <= now()");
      await db.execute(`
        INSERT INTO connector_oauth_states (state_digest, tenant_id, connector_id, user_id, access_level, requested_scopes, code_verifier_envelope, redirect_after, expires_at)
        VALUES ($1,$2::uuid,$3,$4,$5,$6::text[],$7::jsonb,$8,$9::timestamptz)
      `, [stateDigest, tenantId, row.id, userId, row.max_access_level, config.oauthScope ? config.oauthScope.split(/\s+/).filter(Boolean) : [], JSON.stringify(envelope), taskId ? `/tasks/${taskId}` : redirectAfter, expiresAt.toISOString()]);
    });
    return { connectorId: row.id, state, authorizationUrl: started.authorizationUrl, expiresAt: expiresAt.toISOString() };
  }

  async completeCustomOAuth(tenantId: string, userId: string, input: { state: string; code?: string; error?: string; issuer?: string }, canManageShared = false): Promise<{ redirectAfter: string; connectorId: string; error?: string }> {
    const stateDigest = sha256(input.state);
    const states = await this.database.withTenant(tenantId, (db) => db.query<OAuthStateRow>("UPDATE connector_oauth_states SET consumed_at=now() WHERE state_digest=$1 AND user_id=$2 AND consumed_at IS NULL AND expires_at>now() RETURNING *", [stateDigest, userId]));
    const flow = states[0]; if (!flow) throw new BadRequestException("MCP OAuth state is invalid or expired");
    let taskReturn: string | undefined;
    try {
      const envelope = connectorEnvelope(flow.code_verifier_envelope); if (!envelope) throw new BadRequestException("MCP OAuth state is invalid");
      const stored = JSON.parse(await this.#open(envelope, oauthStateContext(tenantId, stateDigest))) as { type?: string; state?: McpOAuthState; authority?: string; taskId?: string; grantId?: string | null };
      if (stored.type !== "mcp" || !stored.state) throw new BadRequestException("MCP OAuth state is invalid");
      if (stored.taskId) {
        await this.#assertTaskMcpAccess(tenantId, userId, stored.taskId);
        taskReturn = `/tasks/${stored.taskId}`;
      }
      const row = await this.#row(tenantId, flow.connector_id);
      if (!isMcpOAuth(row) || (stored.authority && stored.authority !== mcpAuthority(row))) throw new BadRequestException("The MCP connector configuration changed");
      if (row.auth_strategy === "shared" && !canManageShared) throw new ForbiddenException("Only an administrator can authorize this organization-wide connector");
      validateRemoteMcpOAuthIssuer(stored.state, input.issuer);
      if (input.error) {
        if (taskReturn) return { redirectAfter: taskReturn, connectorId: row.id, error: "Sign-in was cancelled or denied. You can try again." };
        throw new BadRequestException("MCP authorization was cancelled or denied");
      }
      if (!input.code) throw new BadRequestException("MCP authorization code is missing");
      const endpoint = await safeRemoteUrl(row.endpoint_url!, this.env.NODE_ENV !== "production");
      const config = customConfig(row.config);
      const clientMetadataUrl = this.mcpClientMetadataUrl();
      const completed = await completeRemoteMcpOAuth({ serverUrl: endpoint, callbackUrl: this.mcpCallbackUrl(), requestState: input.state, authorizationCode: input.code, state: stored.state, ...(config.oauthScope ? { scope: config.oauthScope } : {}), ...(clientMetadataUrl ? { clientMetadataUrl } : {}) });
      const obtainedAt = new Date().toISOString();
      const credential: StoredMcpOAuth = { state: completed, obtainedAt, authorizedAt: obtainedAt, grantId: sha256(randomUUID()), version: sha256(randomUUID()) };
      const saved = await this.database.withTenant(tenantId, async (db) => {
        const [current] = await db.query<ConnectorRow>("SELECT * FROM organization_connectors WHERE id=$1 FOR UPDATE", [row.id]);
        const [activeState] = await db.query("SELECT state_digest FROM connector_oauth_states WHERE state_digest=$1", [stateDigest]);
        if (!current || !activeState || !isMcpOAuth(current) || mcpAuthority(current) !== mcpAuthority(row)) throw new BadRequestException("The MCP connector configuration changed");
        if (taskReturn && (!current.enabled || current.publication_status !== "published")) throw new ForbiddenException("This connector is unavailable to the task");
        if (stored.grantId !== undefined) {
          const latest = await this.#readMcpGrant(db, tenantId, userId, current, true);
          if ((latest?.grantId ?? null) !== stored.grantId || (taskReturn && latest && !mcpReauthRequired(latest))) {
            if (taskReturn && latest && !mcpReauthRequired(latest)) return false;
            throw new ConflictException("The connector grant changed during sign-in. Start sign-in again if needed.");
          }
        }
        const sealed = await this.#seal(JSON.stringify(credential), customCredentialContext(tenantId, userId, current));
        if (current.auth_strategy === "shared") {
          await db.execute("UPDATE organization_connectors SET shared_credential_envelope=$1::jsonb, updated_at=now() WHERE id=$2", [JSON.stringify(sealed), row.id]);
        } else {
          await this.#upsertConnectionWith(db, tenantId, row.id, userId, current.max_access_level, sealed, null, null, mcpScopes(credential, flow.requested_scopes), mcpExpiry(credential)?.toISOString() ?? null);
        }
        return true;
      });
      if (saved && config.serverApproved && row.transport && (!taskReturn || !config.discoveredTools?.length)) {
        try {
          const tools = await this.#discoverCustomTools(tenantId, userId, row, endpoint);
          const next: CustomConnectorConfig = { ...config, discoveredTools: tools, lastDiscoveredAt: new Date().toISOString() };
          await this.database.withTenant(tenantId, (db) => db.execute("UPDATE organization_connectors SET config=$1::jsonb, updated_at=now() WHERE id=$2 AND config=$3::jsonb", [JSON.stringify(next), row.id, JSON.stringify(config)]));
        } catch {
          // Authorization succeeded. Live tool discovery will retry when the connector is used.
        }
      }
      return { redirectAfter: taskReturn ?? flow.redirect_after, connectorId: row.id };
    } catch (cause) {
      if (taskReturn) return { redirectAfter: taskReturn, connectorId: flow.connector_id, error: "Could not finish reconnecting. You can try again." };
      if (cause instanceof BadRequestException || cause instanceof ForbiddenException || cause instanceof ConflictException) throw cause;
      throw new BadRequestException("MCP authorization failed. Try connecting again.");
    } finally {
      await this.database.withTenant(tenantId, (db) => db.execute("DELETE FROM connector_oauth_states WHERE state_digest=$1", [stateDigest]));
    }
  }

  async runtime(tenantId: string, userId: string, context: { taskId?: string; sessionId?: string; resolveDuringExecution?: boolean } = {}): Promise<McpServerSpec[]> {
    const rows = await this.database.withTenant(tenantId, (db) => db.query<ConnectorRow>("SELECT * FROM organization_connectors WHERE enabled=true AND publication_status='published' AND approval_status='approved' ORDER BY kind, name"));
    const servers: McpServerSpec[] = [];
    for (const row of rows) {
      if (isGoogleKey(row.connector_key)) {
        const connection = await this.#connection(tenantId, row.id, userId);
        if (!connection || (connection.status !== "connected" && connection.status !== "reauth_required")) continue;
        const accessLevel: ConnectorAccessLevel = row.max_access_level === "read" ? "read" : connection.access_level;
        const grantedScopes = googleCatalogScopes(connection);
        const tools = googleToolCatalog(row.connector_key, accessLevel, grantedScopes);
        if (!tools.length) continue;
        const credential = this.#signSession({ tenantId, userId, connectorKey: row.connector_key, accessLevel, ...(context.taskId ? { taskId: context.taskId } : {}), ...(context.sessionId ? { sessionId: context.sessionId } : {}), exp: Math.floor(Date.now() / 1000) + 20 * 60 });
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
      // The registration was validated on save. Connection-time fetch still
      // validates every socket's address, including after an outage or DNS change.
      const lazyOAuth = row.auth_type === "oauth" && context.resolveDuringExecution === true;
      const endpoint = lazyOAuth ? row.endpoint_url : await safeRemoteUrl(row.endpoint_url, this.env.NODE_ENV !== "production").catch(() => null);
      if (!endpoint) continue;
      let credential: string | undefined;
      let credentialKey = customCredentialReference(row, userId);
      try {
        if (lazyOAuth) {
          const grant = await this.database.withTenant(tenantId, (db) => this.#readMcpGrant(db, tenantId, userId, row));
          if (!grant) continue;
          credentialKey = mcpOAuthReference(row, userId, grant.grantId);
        } else {
          credential = await this.#customCredential(tenantId, userId, row);
          if (row.auth_type !== "none" && !credential) continue;
        }
      } catch {
        continue;
      }
      const config = customConfig(row.config);
      const serverApproved = config.serverApproved === true;
      const approved = new Set(config.allowedTools ?? []);
      const cachedTools = serverApproved
        ? config.discoveredTools ?? []
        : (config.discoveredTools ?? []).filter((tool) => approved.has(tool.name));
      if (!serverApproved && !cachedTools.length) continue;
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
        credentialKey,
        cachedTools,
        ...(serverApproved && cachedTools.length ? { defaultTools: cachedTools.map((tool) => tool.name) } : {}),
        ...(!serverApproved ? { allowedTools: cachedTools.map((tool) => tool.name) } : {}),
        ...(credential ? { credential } : {}),
      });
    }
    return servers;
  }

  async handleGoogleMcp(
    authorization: string | undefined,
    connectorKey: string,
    request: unknown,
    options: {
      importArtifact?: (context: {
        tenantId: string;
        userId: string;
        taskId: string;
        sessionId: string;
        connectorKey: GoogleConnectorKey;
        accountEmail: string | null;
      }, input: ConnectorArtifactImport) => Promise<unknown>;
    } = {},
  ): Promise<{ status: number; body?: unknown }> {
    if (!isGoogleKey(connectorKey)) return { status: 404, body: rpcError(null, -32601, "Unknown connector") };
    const credential = bearer(authorization);
    if (!credential) return { status: 401, body: rpcError(null, -32001, "Connector authorization is required") };
    const session = this.#verifySession(credential, { allowExpired: true });
    if (session.connectorKey !== connectorKey) return { status: 403, body: rpcError(null, -32001, "Connector token audience mismatch") };
    if (session.exp < Math.floor(Date.now() / 1000) && !(await this.#activeTaskSession(session))) {
      throw new BadRequestException(CONNECTOR_SESSION_ENDED_MESSAGE);
    }
    const rpc = rpcRequest(request);
    if (rpc.method === "notifications/initialized") return { status: 202 };
    if (rpc.method === "initialize") return { status: 200, body: { jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: false } }, serverInfo: { name: `berry-${connectorKey}`, version: "1.0.0" } } } };
    if (rpc.method === "ping") return { status: 200, body: { jsonrpc: "2.0", id: rpc.id, result: {} } };
    const row = await this.#row(session.tenantId, BUILT_INS[connectorKey].id);
    if (!row.enabled) return { status: 403, body: rpcError(rpc.id, -32001, "Connector is disabled") };
    const connection = await this.#connection(session.tenantId, row.id, session.userId);
    if (!connection || (connection.status !== "connected" && connection.status !== "reauth_required")) return { status: 403, body: rpcError(rpc.id, -32001, "Google connector is not connected") };
    const accessLevel: ConnectorAccessLevel = row.max_access_level === "read" || session.accessLevel === "read" ? "read" : connection.access_level;
    const tools = googleToolCatalog(connectorKey, accessLevel, googleCatalogScopes(connection));
    if (rpc.method === "tools/list") return { status: 200, body: { jsonrpc: "2.0", id: rpc.id, result: { tools } } };
    if (rpc.method !== "tools/call") return { status: 200, body: rpcError(rpc.id, -32601, `Method ${rpc.method} is not supported`) };
    try {
      const params = requiredObject(rpc.params, "params");
      const name = requiredTokenString(params.name, "tool name");
      if (!tools.some((tool) => tool.name === name)) throw new Error(`Tool ${name} is not authorized for this connection`);
      if (connection.status === "reauth_required") throw new GoogleReconnectRequired(connection);
      const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? params.arguments as Record<string, unknown> : {};
      const accessToken = await this.#googleAccessToken(session.tenantId, row, connection);
      const artifactImporter = session.taskId && session.sessionId && options.importArtifact
        ? (artifact: ConnectorArtifactImport) => options.importArtifact!({
            tenantId: session.tenantId,
            userId: session.userId,
            taskId: session.taskId!,
            sessionId: session.sessionId!,
            connectorKey,
            accountEmail: connection.account_email,
          }, artifact)
        : undefined;
      const result = await executeGoogleTool(
        connectorKey,
        accessLevel,
        name,
        accessToken,
        args,
        connection.account_email,
        connection.granted_scopes ?? [],
        artifactImporter ? { artifactImporter } : {},
      );
      return { status: 200, body: { jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: googleToolText(result) }], structuredContent: result, isError: false } } };
    } catch (cause) {
      if (cause instanceof GoogleReconnectRequired) {
        return { status: 200, body: { jsonrpc: "2.0", id: rpc.id, result: {
          content: [{ type: "text", text: cause.message }],
          structuredContent: { code: "berry_google_reauth_required", connectorId: row.id, grantId: cause.grantId },
          isError: true,
        } } };
      }
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
      approvalStatus: row.approval_status ?? "approved",
      serverApproved: config.serverApproved === true,
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
      tools: googleKey
        ? googleToolCatalog(googleKey, visibleGoogleAccessLevel, connection?.granted_scopes?.length ? connection.granted_scopes : undefined).map((item) => item.name)
        : config.serverApproved
          ? (config.discoveredTools ?? []).map((tool) => tool.name)
          : config.allowedTools ?? [],
      limitations: google
        ? ["Berry blocks deletion and trash actions."]
        : [config.serverApproved
            ? "The organization approved this MCP server. Its live tool catalog may change, and server-supplied safety annotations are not trusted."
            : "The administrator's exact tool allowlist is enforced, and Berry requires approval for every custom MCP call. Server-supplied safety annotations are not trusted."],
      createdAt: virtual(row.created_at),
      updatedAt: virtual(row.updated_at),
    };
  }

  async #ensureBuiltIn(db: SqlExecutor, tenantId: string, key: GoogleConnectorKey, userId: string): Promise<void> {
    const definition = BUILT_INS[key];
    await db.execute(`
      INSERT INTO organization_connectors (id, tenant_id, connector_key, kind, provider, name, description, enabled, max_access_level, workspace_access_mode, auth_strategy, auth_type, publication_status, created_by)
      VALUES ($1,$2::uuid,$3,'app','google',$4,$5,false,$7,CASE WHEN $3='google-workspace' THEN 'selected_files' ELSE NULL END,'personal','oauth','published',$6)
      ON CONFLICT (tenant_id, connector_key) DO NOTHING
    `, [definition.id, tenantId, key, definition.name, definition.description, userId, DEFAULT_GOOGLE_CONNECTOR_ACCESS_LEVEL]);
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

  async #recordCustomRequest(db: SqlExecutor, tenantId: string, connectorId: string, userId: string): Promise<void> {
    await db.execute(`
      INSERT INTO connector_approval_requests (tenant_id, connector_id, user_id, requested_at)
      VALUES ($1::uuid,$2,$3,now())
      ON CONFLICT (tenant_id, connector_id, user_id)
      DO UPDATE SET requested_at=EXCLUDED.requested_at
    `, [tenantId, connectorId, userId]);
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
      await this.#markGoogleReconnectRequired(tenantId, connection, "refresh_token_missing");
      throw new GoogleReconnectRequired(connection);
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
      const [saved] = await this.database.withTenant(tenantId, (db) => db.query<{ id: string }>(`
        UPDATE connector_connections
        SET credential_envelope=$1::jsonb, expires_at=$2::timestamptz, granted_scopes=$3::text[],
            status='connected', last_error_code=NULL, last_successful_use_at=now(), updated_at=now()
        WHERE id=$4 AND status='connected' AND credential_envelope IS NOT DISTINCT FROM $5::jsonb
        RETURNING id
      `, [JSON.stringify(envelope), next.expiresAt, next.scope, connection.id, JSON.stringify(connection.credential_envelope)]));
      if (!saved) throw new Error("The Google connection changed during token refresh");
      return next.accessToken;
    } catch (cause) {
      if (cause instanceof GoogleOAuthExchangeError && cause.oauthCode === "invalid_grant") {
        await this.#markGoogleReconnectRequired(tenantId, connection, "invalid_grant");
        throw new GoogleReconnectRequired(connection);
      }
      throw new ServiceUnavailableException("Google could not refresh this connection. Try again in a moment.");
    }
  }

  async #markGoogleReconnectRequired(tenantId: string, connection: ConnectionRow, errorCode: string): Promise<void> {
    await this.database.withTenant(tenantId, (db) => db.execute(`
      UPDATE connector_connections SET status='reauth_required', last_error_code=$1, updated_at=now()
      WHERE id=$2 AND status='connected' AND credential_envelope IS NOT DISTINCT FROM $3::jsonb
    `, [errorCode, connection.id, JSON.stringify(connection.credential_envelope)]));
  }

  async resolveRunMcpCredential(proof: DurableSecretEnvelope, signal?: AbortSignal): Promise<McpCredentialResult> {
    const key = this.env.BERRY_DURABLE_CAPABILITY_KEY?.trim();
    const request = key ? await openDurableSecret(proof, key)
      .then((plaintext) => McpCredentialRequestSchema.parse(JSON.parse(plaintext)))
      .catch(() => null) : null;
    if (!request || request.expiresAt <= Date.now() || request.expiresAt > Date.now() + 60_000) {
      throw new ForbiddenException("Invalid connector credential request");
    }
    const admission = await this.#mcpRunAdmission(request);
    const row = await this.#row(request.tenantId, request.connectorId);
    if (!mcpAdmissionMatches(row, admission)) return { status: "configuration" };
    if (row.auth_type !== "oauth") {
      if (admission.server.credentialRef !== customCredentialReference(row, request.userId)) return { status: "configuration" };
      const credential = await this.#customCredential(request.tenantId, request.userId, row);
      if (row.auth_type === "bearer" && (!credential || !admission.server.credential || await openDurableSecret(admission.server.credential, key!).catch(() => undefined) !== credential)) {
        return { status: "configuration" };
      }
      return { status: "static" };
    }
    const result = await this.#resolveMcpOAuth(request.tenantId, request.userId, row, { admission, rejectedVersion: request.rejectedVersion, signal });
    signal?.throwIfAborted();
    if (result.status === "available") await this.#mcpRunAdmission(request);
    return result;
  }

  async taskMcpReconnects(tenantId: string, userId: string, taskId: string, canManageShared: boolean): Promise<TaskConnectorReconnect[]> {
    return (await this.#taskMcpReconnects(tenantId, userId, taskId, canManageShared)).map(({ grantId: _grantId, ...action }) => action);
  }

  async #assertTaskMcpAccess(tenantId: string, userId: string, taskId: string): Promise<void> {
    const [task] = await this.database.withTenant(tenantId, (db) => db.query(`
      SELECT t.id FROM tasks t
      JOIN tenant_memberships m ON m.tenant_id=t.tenant_id AND m.user_id=t.user_id
      WHERE t.tenant_id=$1::uuid AND t.user_id=$2::uuid AND t.id=$3::uuid AND t.deleted_at IS NULL
        AND m.status='active' AND m.deprovisioned_at IS NULL
    `, [tenantId, userId, taskId]));
    if (!task) throw new NotFoundException("Task not found");
  }

  async #taskMcpReconnects(tenantId: string, userId: string, taskId: string, canManageShared: boolean): Promise<Array<TaskConnectorReconnect & { grantId: string }>> {
    await this.#assertTaskMcpAccess(tenantId, userId, taskId);
    return this.database.withTenant(tenantId, async (db) => {
      const failures = await db.query<{ connector_id: string; grant_id: string; run_id: string }>(`
        SELECT DISTINCT ON (connector_id, grant_id)
          s.output#>>'{failure,reconnect,connectorId}' AS connector_id,
          s.output#>>'{failure,reconnect,grantId}' AS grant_id, r.id AS run_id
        FROM turn_runs r
        JOIN turn_steps s ON s.tenant_id=r.tenant_id AND s.run_id=r.id
        WHERE r.tenant_id=$1::uuid AND r.user_id=$2::uuid AND r.task_id=$3::uuid
          AND s.state='failed' AND s.output#>>'{failure,reconnect,grantId}' IS NOT NULL
        ORDER BY connector_id, grant_id, r.created_at DESC
      `, [tenantId, userId, taskId]);
      if (!failures.length) return [];
      const connectors = await db.query<ConnectorRow>("SELECT * FROM organization_connectors WHERE id=ANY($1::text[]) AND enabled=true AND publication_status='published' AND approval_status='approved'", [[...new Set(failures.map((failure) => failure.connector_id))]]);
      const actions = await Promise.all(connectors.map(async (row) => {
        if (row.provider === "google" && isGoogleKey(row.connector_key)) {
          const [connection] = await db.query<ConnectionRow>(
            "SELECT * FROM connector_connections WHERE connector_id=$1 AND user_id=$2 AND status='reauth_required' LIMIT 1", [row.id, userId],
          );
          if (!connection) return null;
          const grantId = googleGrantId(connection);
          const failure = failures.find((candidate) => candidate.connector_id === row.id && candidate.grant_id === grantId);
          return failure ? {
            connectorId: row.id, name: row.name, taskId, runId: failure.run_id, grantId, canReconnect: true,
            connectorKey: row.connector_key, accessLevel: row.max_access_level === "read" ? "read" as const : connection.access_level,
          } : null;
        }
        if (!isMcpOAuth(row)) return null;
        const grant = await this.#readMcpGrant(db, tenantId, userId, row);
        if (!grant || !mcpReauthRequired(grant)) return null;
        const failure = failures.find((candidate) => candidate.connector_id === row.id && candidate.grant_id === grant.grantId);
        return failure ? { connectorId: row.id, name: row.name, taskId, runId: failure.run_id, grantId: grant.grantId, canReconnect: row.auth_strategy === "personal" || canManageShared } : null;
      }));
      return actions.filter((action) => action !== null);
    });
  }

  async #mcpRunAdmission(request: McpCredentialRequest): Promise<McpAdmission> {
    const [admission] = await this.database.withTenant(request.tenantId, (db) => db.query<{ server: unknown; created_at: Date | string }>(`
      SELECT server.spec AS server, r.created_at
      FROM turn_runs r
      JOIN tasks t ON t.tenant_id=r.tenant_id AND t.id=r.task_id
      JOIN tenant_memberships m ON m.tenant_id=r.tenant_id AND m.user_id=r.user_id
      CROSS JOIN LATERAL jsonb_array_elements(r.runtime_request->'mcpServers') AS server(spec)
      WHERE r.tenant_id=$1::uuid AND r.id=$2::uuid AND r.user_id=$3::uuid
        AND r.lease_owner=$4 AND r.ownership_generation=$5 AND r.lease_expires_at>now()
        AND r.state='executing_tool' AND r.cancelled_at IS NULL
        AND t.user_id=r.user_id AND t.deleted_at IS NULL
        AND m.status='active' AND m.deprovisioned_at IS NULL AND server.spec->>'id'=$6
      LIMIT 1
    `, [request.tenantId, request.runId, request.userId, request.leaseOwner, request.ownershipGeneration, request.connectorId]));
    const server = DurableMcpServerSchema.safeParse(admission?.server);
    if (!admission || !server.success || !server.data.enabled || !server.data.trusted
      || !isStoredMcpCredentialRef(server.data.id, server.data.credentialRef)) {
      throw new ForbiddenException("Connector is outside the active run's admission");
    }
    return { server: server.data, createdAt: admission.created_at, userId: request.userId };
  }

  async #discoverCustomTools(tenantId: string, userId: string, row: ConnectorRow, endpoint: string) {
    if (!row.transport) throw new BadRequestException("Custom MCP is incomplete");
    const resolveCredential = async (_server: McpServerSpec, signal?: AbortSignal, rejectedVersion?: string): Promise<McpResolvedCredential> => {
      const result = await this.#resolveMcpOAuth(tenantId, userId, row, { rejectedVersion, signal });
      if (result.status === "available") return result;
      if (result.status === "reauth_required") throw new McpConnectionError("reauth_required", true);
      if (result.status === "temporary") throw new McpConnectionError("temporary", true);
      throw new McpConnectionError("configuration", true);
    };
    const credential = row.auth_type !== "oauth" ? await this.#customCredential(tenantId, userId, row) : undefined;
    try {
      return await discoverRemoteMcpTools({
        id: row.id, name: row.name, url: endpoint, transport: row.transport,
        ...(credential ? { credential } : {}),
        ...(row.auth_type === "oauth" ? { resolveCredential } : {}),
      });
    } catch (cause) {
      if (cause instanceof McpConnectionError && cause.kind === "temporary") throw new ServiceUnavailableException(cause.message);
      if (cause instanceof McpConnectionError) throw new BadRequestException(cause.message);
      throw new BadRequestException("Unable to discover MCP tools with the saved connection");
    }
  }

  async #customCredential(tenantId: string, userId: string, row: ConnectorRow): Promise<string | undefined> {
    if (row.auth_type === "none") return undefined;
    if (row.auth_type === "oauth") {
      const result = await this.#resolveMcpOAuth(tenantId, userId, row);
      return result.status === "available" ? result.accessToken : undefined;
    }
    const connection = row.auth_strategy === "personal" ? await this.#connection(tenantId, row.id, userId) : null;
    const envelope = row.auth_strategy === "shared" ? connectorEnvelope(row.shared_credential_envelope) : connectorEnvelope(connection?.credential_envelope);
    if (!envelope) return undefined;
    return this.#open(envelope, customCredentialContext(tenantId, userId, row));
  }

  async #readMcpGrant(db: SqlExecutor, tenantId: string, userId: string, row: ConnectorRow, lock = false): Promise<McpGrant | null> {
    const connection = row.auth_strategy === "shared" ? null : (await db.query<ConnectionRow>(
      `SELECT * FROM connector_connections WHERE connector_id=$1 AND user_id=$2${lock ? " FOR UPDATE" : ""}`, [row.id, userId],
    ))[0] ?? null;
    if (connection && connection.status !== "connected" && connection.status !== "reauth_required") return null;
    const envelope = connectorEnvelope(row.auth_strategy === "shared" ? row.shared_credential_envelope : connection?.credential_envelope);
    if (!envelope) return null;
    const context = customCredentialContext(tenantId, userId, row);
    const stored = await this.#openMcpGrant(envelope, context);
    if (!stored?.state?.tokens?.access_token) return null;
    // Existing envelopes become their own stable grant ID on first write.
    const version = stored.version ?? sha256(envelope.ciphertext);
    return { stored, grantId: stored.grantId ?? version, version, context, connection };
  }

  async #openMcpGrant(envelope: ConnectorSecretEnvelope, context: string): Promise<StoredMcpOAuth | null> {
    return this.#open(envelope, context).then((plaintext) => JSON.parse(plaintext) as StoredMcpOAuth).catch(() => null);
  }

  async #writeMcpGrant(db: SqlExecutor, row: ConnectorRow, grant: McpGrant, stored: StoredMcpOAuth): Promise<void> {
    const envelope = JSON.stringify(await this.#seal(JSON.stringify(stored), grant.context));
    if (row.auth_strategy === "shared") {
      await db.execute("UPDATE organization_connectors SET shared_credential_envelope=$1::jsonb, updated_at=now() WHERE id=$2", [envelope, row.id]);
    } else if (grant.connection) {
      await db.execute(`
        UPDATE connector_connections SET credential_envelope=$1::jsonb, status=$2, expires_at=$3::timestamptz,
          last_error_code=$4, granted_scopes=$5::text[], updated_at=now() WHERE id=$6
      `, [envelope, stored.reauthRequired ? "reauth_required" : "connected", mcpExpiry(stored)?.toISOString() ?? null,
        stored.reauthRequired ? "mcp_oauth_grant_unusable" : null, mcpScopes(stored, grant.connection.granted_scopes ?? []), grant.connection.id]);
    }
  }

  async #resolveMcpOAuth(
    tenantId: string, userId: string, expected: ConnectorRow,
    { admission, rejectedVersion, signal }: { admission?: McpAdmission; rejectedVersion?: string | undefined; signal?: AbortSignal | undefined } = {},
  ): Promise<McpCredentialResult> {
    const deadline = Date.now() + MCP_REFRESH_CLAIM_MS;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const decision: McpResolution = await this.database.withTenant(tenantId, async (db) => {
        const [row] = await db.query<ConnectorRow>("SELECT * FROM organization_connectors WHERE id=$1 FOR UPDATE", [expected.id]);
        if (!row || mcpAuthority(row) !== mcpAuthority(expected) || (row.approval_status ?? "approved") !== "approved"
          || (admission && !mcpAdmissionMatches(row, admission))) return { status: "configuration" };
        const grant = await this.#readMcpGrant(db, tenantId, userId, row, true);
        if (!grant || (admission && !mcpGrantAdmitted(row, grant, admission))) return { status: "configuration" };
        const { stored, grantId, version } = grant;
        if (mcpReauthRequired(grant)) return { status: "reauth_required", grantId };
        const now = Date.now();
        const expiresAt = mcpExpiry(stored)?.getTime();
        const rejected = rejectedVersion === version;
        const expired = expiresAt !== undefined && expiresAt <= now;
        const refreshToken = stored.state.tokens?.refresh_token;
        const refreshSoon = expiresAt !== undefined && expiresAt <= now + Math.min(90_000, (stored.state.tokens?.expires_in ?? 0) * 100);
        if (!rejected && !expired && (!refreshToken || !refreshSoon || rejectedVersion !== undefined)) return mcpAvailable(grant);
        if (!refreshToken) {
          await this.#writeMcpGrant(db, row, grant, { ...stored, grantId, version, reauthRequired: true });
          return { status: "reauth_required", grantId };
        }
        if (stored.refresh && stored.refresh.until > now) {
          if (stored.refresh.claimId) return { status: "waiting" };
          if (!rejected && !expired) return mcpAvailable(grant);
          return stored.refresh.configuration ? { status: "configuration" } : { status: "temporary", uncertain: stored.refresh.uncertain };
        }
        const claimId = randomUUID();
        const uncertain = Boolean(stored.refresh?.uncertain || stored.refresh?.claimId);
        await this.#writeMcpGrant(db, row, grant, { ...stored, grantId, version, refresh: { ...stored.refresh, claimId, until: now + MCP_REFRESH_CLAIM_MS, uncertain } });
        return { status: "refresh", claim: { row, grant, claimId, uncertain } };
      });
      if (decision.status === "waiting") {
        await delay(150, undefined, { signal });
        continue;
      }
      if (decision.status !== "refresh") return decision;
      const result = await this.#finishMcpRefresh(tenantId, userId, decision.claim, admission, signal);
      if (!result) continue; // The grant changed while the provider request was in flight.
      return result;
    }
    return { status: "temporary", uncertain: false };
  }

  async #finishMcpRefresh(tenantId: string, userId: string, claim: McpRefreshClaim, admission?: McpAdmission, signal?: AbortSignal): Promise<McpCredentialResult | null> {
    const { row, grant, claimId } = claim;
    let nextState: McpOAuthState | undefined;
    let failure: McpOAuthRefreshError | undefined;
    try {
      if (signal?.aborted) throw new McpOAuthRefreshError("temporary");
      nextState = await refreshRemoteMcpOAuth({ serverUrl: row.endpoint_url!, callbackUrl: this.mcpCallbackUrl(), state: grant.stored.state, ...(signal ? { signal } : {}) });
    } catch (cause) {
      failure = cause instanceof McpOAuthRefreshError ? cause : new McpOAuthRefreshError("uncertain");
    }
    // Finish persistence even when the HTTP caller has stopped waiting. A
    // rotated token must be saved before another process can use this grant.
    return this.database.withTenant(tenantId, async (db) => {
      const [current] = await db.query<ConnectorRow>("SELECT * FROM organization_connectors WHERE id=$1 FOR UPDATE", [row.id]);
      if (!current || mcpAuthority(current) !== mcpAuthority(row)) return null;
      const latest = await this.#readMcpGrant(db, tenantId, userId, current, true);
      if (!latest || latest.grantId !== grant.grantId || latest.stored.refresh?.claimId !== claimId) return null;
      const { refresh: _claim, ...stored } = latest.stored;
      if (nextState) {
        const version = sha256(randomUUID());
        const renewed: StoredMcpOAuth = { ...stored, state: nextState, obtainedAt: new Date().toISOString(), version };
        await this.#writeMcpGrant(db, current, latest, renewed);
        return admission && !mcpAdmissionMatches(current, admission) ? { status: "configuration" } : mcpAvailable({ ...latest, stored: renewed, version });
      }
      // After an uncertain rotation, require a second definitive rejection
      // against the same persisted grant before asking for an interactive login.
      const invalidGrant = failure?.kind === "invalid_grant";
      if (invalidGrant && (!claim.uncertain || _claim?.invalidGrant)) {
        await this.#writeMcpGrant(db, current, latest, { ...stored, reauthRequired: true });
        return { status: "reauth_required", grantId: latest.grantId };
      }
      const uncertain = claim.uncertain || failure?.kind === "uncertain";
      const configuration = failure?.kind === "configuration";
      const until = Date.now() + Math.max(MCP_REFRESH_COOLDOWN_MS, failure?.retryAfterMs ?? 0);
      await this.#writeMcpGrant(db, current, latest, { ...stored, refresh: {
        claimId: null, until, uncertain,
        ...(invalidGrant || _claim?.invalidGrant ? { invalidGrant: true } : {}),
        ...(configuration ? { configuration: true } : {}),
      } });
      return configuration ? { status: "configuration" } : { status: "temporary", uncertain };
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
  mcpClientMetadataUrl(): string | undefined {
    const url = new URL("/v1/connectors/mcp/oauth/client-metadata", this.#publicApiBase());
    return url.protocol === "https:" ? url.toString() : undefined;
  }
  mcpClientMetadata() {
    const clientId = new URL("/v1/connectors/mcp/oauth/client-metadata", this.#publicApiBase()).toString();
    return {
      client_id: clientId,
      client_name: "Berry Connectors",
      redirect_uris: [this.mcpCallbackUrl()],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }
  #signSession(session: ConnectorSession): string {
    const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
    const signature = createHmac("sha256", Buffer.from(this.#encryptionKey(), "base64")).update(payload).digest("base64url");
    return `${payload}.${signature}`;
  }
  /**
   * A task-scoped session is minted with a 20-minute lease when its turn is
   * admitted, but the worker keeps using it for the whole run, including long
   * model/human waits. Past the lease it stays usable only while that run is
   * still active and the user still owns the task and belongs to the tenant
   * (checked on every call), and never beyond a hard cap. Google access and
   * connector policy are still checked per call below.
   */
  async #activeTaskSession(session: ConnectorSession): Promise<boolean> {
    if (!session.taskId || !session.sessionId) return false;
    if (session.exp + CONNECTOR_SESSION_MAX_RUN_EXTENSION_SECONDS < Math.floor(Date.now() / 1000)) return false;
    const rows = await this.database.withTenant(session.tenantId, (db) => db.query<{ active: boolean }>(`
      SELECT true AS active
      FROM turn_runs r
      JOIN tasks t ON t.tenant_id=r.tenant_id AND t.id=r.task_id
      JOIN tenant_memberships m ON m.tenant_id=r.tenant_id AND m.user_id=r.user_id
      WHERE r.tenant_id=$1::uuid AND r.task_id=$2::uuid AND r.session_id=$3::uuid AND r.user_id=$4::uuid
        AND r.state NOT IN ('completed','failed','cancelled','recovery_required')
        AND t.user_id=$4::uuid AND t.deleted_at IS NULL
        AND m.status='active' AND m.deprovisioned_at IS NULL
      LIMIT 1
    `, [session.tenantId, session.taskId, session.sessionId, session.userId]));
    return rows[0]?.active === true;
  }
  #verifySession(token: string, options: { allowExpired?: boolean } = {}): ConnectorSession {
    const [payload, signature] = token.split(".");
    if (!payload || !signature) throw new BadRequestException("Connector token is invalid");
    const expected = createHmac("sha256", Buffer.from(this.#encryptionKey(), "base64")).update(payload).digest();
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new BadRequestException("Connector token signature is invalid");
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as ConnectorSession;
    const hasTaskContext = Boolean(parsed.taskId || parsed.sessionId);
    if (!parsed.tenantId || !parsed.userId || !isGoogleKey(parsed.connectorKey) || !["read", "full"].includes(parsed.accessLevel) || typeof parsed.exp !== "number"
      || (!options.allowExpired && parsed.exp < Math.floor(Date.now() / 1000))
      || (hasTaskContext && (!isUuid(parsed.taskId) || !isUuid(parsed.sessionId)))) throw new BadRequestException("Connector token is invalid or expired");
    return parsed;
  }
  #find(connectors: Connector[], id: string): Connector { const connector = connectors.find((item) => item.id === id); if (!connector) throw new NotFoundException("Connector not found"); return connector; }
}

function virtualBuiltIn(key: GoogleConnectorKey): ConnectorRow {
  const item = BUILT_INS[key];
  return { id: item.id, connector_key: key, kind: "app", provider: "google", name: item.name, description: item.description, enabled: false, max_access_level: DEFAULT_GOOGLE_CONNECTOR_ACCESS_LEVEL, workspace_access_mode: key === "google-workspace" ? "selected_files" : null, auth_strategy: "personal", transport: null, endpoint_url: null, auth_type: "oauth", publication_status: "published", shared_credential_envelope: null, config: {}, created_at: "", updated_at: "" };
}
function mcpNameFromUrl(raw: string): string {
  const hostname = new URL(raw).hostname.replace(/^www\./, "");
  const label = hostname.split(".").filter(Boolean).slice(0, -1).join(" ") || hostname;
  const words = label.split(/[-_.\s]+/).filter(Boolean).map((word) => word[0]!.toUpperCase() + word.slice(1));
  return `${words.join(" ") || "Custom"} MCP`.slice(0, 100);
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
function customCredentialContext(tenantId: string, userId: string, row: ConnectorRow): string {
  return row.auth_strategy === "shared" ? sharedCredentialContext(tenantId, row.id) : connectionContext(tenantId, row.id, userId);
}
function customCredentialReference(row: ConnectorRow, userId: string): string {
  return `connector:${row.id}:${row.auth_strategy === "shared" ? "shared" : userId}`;
}
function isMcpOAuth(row: ConnectorRow): boolean {
  return row.kind === "custom_mcp" && row.provider === "mcp" && row.auth_type === "oauth" && Boolean(row.endpoint_url && row.transport)
    && (row.approval_status ?? "approved") === "approved";
}
function mcpAuthority(row: ConnectorRow): string {
  return sha256(JSON.stringify([row.provider, row.endpoint_url, row.transport, row.auth_type, row.auth_strategy, row.max_access_level, customConfig(row.config).oauthScope ?? ""]));
}
function mcpOAuthReference(row: ConnectorRow, userId: string, grantId: string): string {
  return `connector-oauth:${row.id}:${row.auth_strategy === "shared" ? "shared" : userId}:${sha256(`${mcpAuthority(row)}:${grantId}`)}`;
}
function mcpAdmissionMatches(row: ConnectorRow, { server }: McpAdmission): boolean {
  if (row.kind !== "custom_mcp" || row.provider !== "mcp" || !row.enabled || row.publication_status !== "published"
    || (row.approval_status ?? "approved") !== "approved" || row.endpoint_url !== server.url || row.transport !== server.transport) return false;
  const config = customConfig(row.config);
  if (config.serverApproved === true) return true;
  const allowed = new Set(config.allowedTools ?? []);
  return Boolean(server.allowedTools?.length && server.allowedTools.every((tool) => allowed.has(tool)));
}
function mcpGrantAdmitted(row: ConnectorRow, grant: McpGrant, admission: McpAdmission): boolean {
  if (admission.server.credentialRef === mcpOAuthReference(row, admission.userId, grant.grantId)) return true;
  // Existing snapshots have a reference and an encrypted access-token copy.
  // They can follow rotation, but an interactive sign-in creates a new grant.
  return admission.server.credentialRef === customCredentialReference(row, admission.userId)
    && (!grant.stored.authorizedAt || Date.parse(grant.stored.authorizedAt) <= new Date(admission.createdAt).getTime());
}
function mcpExpiry(stored: StoredMcpOAuth): Date | null {
  const lifetime = stored.state.tokens?.expires_in;
  if (typeof lifetime !== "number") return null;
  const expiry = new Date(Date.parse(stored.obtainedAt) + lifetime * 1000);
  return Number.isFinite(expiry.getTime()) ? expiry : null;
}
function mcpScopes(stored: StoredMcpOAuth, fallback: string[]): string[] {
  return stored.state.tokens?.scope?.split(/\s+/).filter(Boolean) ?? fallback;
}
function mcpReauthRequired(grant: McpGrant): boolean {
  return grant.stored.reauthRequired === true || grant.connection?.status === "reauth_required";
}
function mcpAvailable(grant: McpGrant): McpCredentialResult {
  return { status: "available", accessToken: grant.stored.state.tokens!.access_token, version: grant.version };
}
function oauthStateContext(tenantId: string, digest: string) { return `${tenantId}:oauth-state:${digest}`; }
function sha256(value: string) { return createHash("sha256").update(value).digest("hex"); }
function googleCatalogScopes(connection: ConnectionRow): string[] | undefined {
  return connection.status === "reauth_required" && !connection.granted_scopes?.length ? undefined : connection.granted_scopes ?? [];
}
function googleGrantId(connection: ConnectionRow): string {
  return sha256(JSON.stringify([connection.id, connectorEnvelope(connection.credential_envelope)?.ciphertext ?? connection.updated_at]));
}
class GoogleReconnectRequired extends Error {
  readonly grantId: string;

  constructor(connection: ConnectionRow) {
    super("Google authorization has expired. Reconnect this account to continue.");
    this.grantId = googleGrantId(connection);
  }
}
class GoogleOAuthExchangeError extends BadRequestException {
  constructor(readonly oauthCode: string | undefined, message: string) {
    super(message);
  }
}
function bearer(header: string | undefined): string | null { const match = header?.match(/^Bearer\s+(.+)$/i); return match?.[1]?.trim() || null; }
function rpcRequest(value: unknown): { id: string | number | null; method: string; params: unknown } { const body = requiredObject(value, "JSON-RPC request"); if (body.jsonrpc !== "2.0" || typeof body.method !== "string") throw new BadRequestException("Invalid JSON-RPC request"); return { id: typeof body.id === "string" || typeof body.id === "number" ? body.id : null, method: body.method, params: body.params }; }
function rpcError(id: string | number | null, code: number, message: string) { return { jsonrpc: "2.0", id, error: { code, message } }; }
function requiredObject(value: unknown, name: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new BadRequestException(`${name} is required`); return value as Record<string, unknown>; }
function requiredTokenString(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new BadRequestException(`${name} is required`); return value; }
function isUuid(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function googleToolText(result: unknown): string {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const artifact = (result as Record<string, unknown>).artifact;
    if (artifact && typeof artifact === "object" && !Array.isArray(artifact)) {
      const item = artifact as Record<string, unknown>;
      return JSON.stringify({
        artifact: {
          fileId: item.fileId,
          name: item.name,
          mediaType: item.mediaType,
          size: item.size,
          sha256: item.sha256,
          sha256Base64: item.sha256Base64,
          source: item.source,
          status: item.status,
          reused: item.reused,
          library: item.library === true,
        },
      });
    }
  }
  return JSON.stringify(result);
}

async function googleTokenRequest(body: Record<string, string>): Promise<Record<string, unknown>> {
  const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body), signal: AbortSignal.timeout(20_000) });
  const value = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const code = typeof value.error === "string" ? value.error : undefined;
    const message = typeof value.error_description === "string" ? value.error_description : code ?? response.status;
    throw new GoogleOAuthExchangeError(code, `Google token exchange failed: ${message}`);
  }
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
