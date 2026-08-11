import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Header,
  Headers,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import { SELF_HOST_TENANT_ID } from "@berry/db";
import { ConnectorAccessLevelSchema, ConnectorWorkspaceAccessModeSchema, type Connector, type JsonValue, type OrgPermission } from "@berry/shared";
import type { ServerResponse } from "node:http";
import { z } from "zod";
import { AUDIT_SERVICE, type AuditService } from "../audit/audit.service.ts";
import type { AuthenticatedRequest } from "../auth/auth.guard.ts";
import { PublicAuth } from "../auth/auth.decorators.ts";
import { ENTERPRISE_IDENTITY_REPOSITORY, type EnterpriseIdentityRepository } from "../identity/identity.repository.ts";
import { CONNECTORS, ConnectorsService } from "./connectors.service.ts";
import type { GoogleConnectorKey } from "./google-tools.ts";
import { FilePlatformService } from "../files/file-platform.service.ts";

const GoogleKeySchema = z.enum(["google-workspace", "gmail", "google-calendar"]);
const OAuthStartSchema = z.object({ accessLevel: ConnectorAccessLevelSchema.default("read") }).strict();
const BearerCredentialSchema = z.object({ credential: z.string().trim().min(1).max(32_768) }).strict();
const GoogleConfigurationInputSchema = z.object({
  clientId: z.string().trim().regex(/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/, "Expected a Google OAuth web client ID").max(1_000),
  clientSecret: z.string().trim().min(1).max(8_192).optional(),
  hostedDomain: z.string().trim().max(253).nullable().optional(),
  pickerApiKey: z.string().trim().min(1).max(8_192).optional(),
  pickerProjectNumber: z.string().trim().regex(/^\d+$/).max(30).nullable().optional(),
}).strict();
const BuiltInPolicySchema = z.object({
  enabled: z.boolean(),
  maxAccessLevel: ConnectorAccessLevelSchema,
  workspaceAccessMode: ConnectorWorkspaceAccessModeSchema.optional(),
}).strict();
const CustomConnectorSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(2_000).optional(),
  url: z.string().url().max(2_048),
  transport: z.enum(["http-sse", "streamable-http"]),
  authType: z.enum(["none", "bearer", "oauth"]),
  authStrategy: z.enum(["personal", "shared"]),
  maxAccessLevel: z.literal("full").default("full"),
  oauthScope: z.string().trim().max(4_096).optional(),
  websiteUrl: z.string().url().max(2_048).optional(),
  privacyPolicyUrl: z.string().url().max(2_048).optional(),
  sharedCredential: z.string().trim().min(1).max(32_768).optional(),
  personalCredential: z.string().trim().min(1).max(32_768).optional(),
}).strict();
const PublishSchema = z.object({ enabled: z.boolean(), allowedTools: z.array(z.string().min(1).max(256)).max(500).optional() }).strict();

@Controller("/v1/connectors")
export class ConnectorsController {
  constructor(
    @Inject(CONNECTORS) private readonly connectors: ConnectorsService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(FilePlatformService) private readonly files: FilePlatformService,
  ) {}

  @Get()
  list(@Req() request: AuthenticatedRequest): Promise<Connector[]> {
    return this.connectors.list(tenantId(), request.auth!.user.id).then((items) => items.filter((item) => item.enabled && item.publicationStatus === "published"));
  }

  @Post(":id/oauth/start")
  async startOAuth(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    const input = parse(OAuthStartSchema, body);
    const available = await this.connectors.list(tenantId(), request.auth!.user.id);
    const connector = available.find((item) => item.id === id);
    if (!connector) throw new BadRequestException("Connector not found");
    if (connector.provider === "google") return this.connectors.startGoogleOAuth(tenantId(), request.auth!.user.id, id, input.accessLevel);
    return this.connectors.startCustomOAuth(tenantId(), request.auth!.user.id, id);
  }

  @Post(":id/credentials")
  async connectBearer(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    const input = parse(BearerCredentialSchema, body);
    const result = await this.connectors.connectBearer(tenantId(), request.auth!.user.id, id, input.credential);
    await this.record(request.auth!.user.id, "connector-connected", result.id, { provider: result.provider, authType: result.authType });
    return result;
  }

  @Delete(":id/connection")
  async disconnect(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
    const result = await this.connectors.disconnect(tenantId(), request.auth!.user.id, id);
    await this.record(request.auth!.user.id, "connector-disconnected", id, {});
    return result;
  }

  @Get(":id/google-picker")
  @Header("Cache-Control", "private, no-store")
  googlePicker(@Req() request: AuthenticatedRequest, @Param("id") id: string) {
    return this.connectors.googlePickerSession(tenantId(), request.auth!.user.id, id);
  }

  @Get("google/callback")
  async googleCallback(@Req() request: AuthenticatedRequest, @Query("state") state: string | undefined, @Query("code") code: string | undefined, @Query("error") error: string | undefined, @Res() response: ServerResponse) {
    await this.completeAndRedirect(response, "/settings/connectors", async () => {
      if (!state) throw new BadRequestException("Google OAuth state is missing");
      const result = await this.connectors.completeGoogleOAuth(tenantId(), request.auth!.user.id, { state, ...(code ? { code } : {}), ...(error ? { error } : {}) });
      await this.record(request.auth!.user.id, "connector-connected", result.connectorId, { provider: "google", authType: "oauth" });
      return result;
    });
  }

  @Get("mcp/oauth/callback")
  async mcpCallback(@Req() request: AuthenticatedRequest, @Query("state") state: string | undefined, @Query("code") code: string | undefined, @Query("error") error: string | undefined, @Res() response: ServerResponse) {
    await this.completeAndRedirect(response, "/settings/connectors", async () => {
      if (!state) throw new BadRequestException("MCP OAuth state is missing");
      const result = await this.connectors.completeCustomOAuth(tenantId(), request.auth!.user.id, { state, ...(code ? { code } : {}), ...(error ? { error } : {}) });
      await this.record(request.auth!.user.id, "connector-connected", result.connectorId, { provider: "mcp", authType: "oauth" });
      return result;
    });
  }

  @PublicAuth()
  @Post("mcp/:connectorKey")
  async googleMcp(@Headers("authorization") authorization: string | undefined, @Param("connectorKey") connectorKey: string, @Body() body: unknown, @Res() response: ServerResponse) {
    const result = await this.connectors.handleGoogleMcp(authorization, connectorKey, body, {
      importDriveArtifact: (context, artifact) => this.files.importConnectorArtifact(
        context.tenantId,
        context.userId,
        {
          connectorKey: context.connectorKey,
          accountEmail: context.accountEmail,
          sourceFileId: artifact.sourceFileId,
          sourceRevision: artifact.sourceRevision,
          sourceMimeType: artifact.sourceMimeType,
          exportMimeType: artifact.exportMimeType,
          saveToLibrary: artifact.saveToLibrary,
          name: artifact.name,
          contentType: artifact.contentType,
          declaredSize: artifact.declaredSize,
          sourceMetadata: artifact.metadata,
          body: artifact.body,
          taskId: context.taskId,
          sessionId: context.sessionId,
        },
      ),
    });
    response.statusCode = result.status;
    if (result.body === undefined) return response.end();
    response.setHeader("content-type", "application/json");
    return response.end(JSON.stringify(result.body));
  }

  private async completeAndRedirect(response: ServerResponse, fallback: string, complete: () => Promise<{ redirectAfter: string; connectorId: string }>): Promise<void> {
    try {
      const result = await complete();
      redirect(response, this.connectors.webRedirect(result.redirectAfter, { connector: result.connectorId, connected: "true" }));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Connector authorization failed";
      redirect(response, this.connectors.webRedirect(fallback, { connector_error: message.slice(0, 240) }));
    }
  }

  private async record(userId: string, action: string, targetId: string, metadata: JsonValue): Promise<void> {
    await this.audit.append({ tenantId: tenantId(), actorUserId: userId, category: "connectors", action, targetType: "connector", targetId, metadata });
  }
}

@Controller("/v1/orgs/:tenantId/connectors")
export class OrganizationConnectorsController {
  constructor(
    @Inject(CONNECTORS) private readonly connectors: ConnectorsService,
    @Inject(ENTERPRISE_IDENTITY_REPOSITORY) private readonly identity: EnterpriseIdentityRepository,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {}

  @Get()
  async list(@Req() request: AuthenticatedRequest, @Param("tenantId") organizationId: string) {
    await this.allow(request, organizationId, "mcp:read");
    return this.connectors.list(organizationId, request.auth!.user.id);
  }

  @Get("google/configuration")
  async googleConfiguration(@Req() request: AuthenticatedRequest, @Param("tenantId") organizationId: string) {
    await this.allow(request, organizationId, "org_settings:read");
    return this.connectors.googleConfiguration(organizationId);
  }

  @Put("google/configuration")
  async configureGoogle(@Req() request: AuthenticatedRequest, @Param("tenantId") organizationId: string, @Body() body: unknown) {
    await this.allow(request, organizationId, "org_settings:write");
    const input = parse(GoogleConfigurationInputSchema, body);
    const result = await this.connectors.configureGoogle(organizationId, request.auth!.user.id, input);
    await this.record(organizationId, request.auth!.user.id, "google-oauth-configuration-updated", "google", { configured: result.configured, hostedDomain: result.hostedDomain, pickerConfigured: result.pickerConfigured });
    return result;
  }

  @Post("google/configuration/test")
  async testGoogle(@Req() request: AuthenticatedRequest, @Param("tenantId") organizationId: string) {
    await this.allow(request, organizationId, "org_settings:write");
    const result = await this.connectors.testGoogleConfiguration(organizationId);
    await this.record(organizationId, request.auth!.user.id, "google-oauth-configuration-tested", "google", { status: result.status });
    return result;
  }

  @Patch("google/:key")
  async updateGoogle(@Req() request: AuthenticatedRequest, @Param("tenantId") organizationId: string, @Param("key") rawKey: string, @Body() body: unknown) {
    await this.allow(request, organizationId, "mcp:write");
    const key = GoogleKeySchema.parse(rawKey) as GoogleConnectorKey;
    const input = parse(BuiltInPolicySchema, body);
    if (key !== "google-workspace" && input.workspaceAccessMode) throw new BadRequestException("Workspace access mode only applies to Google Workspace");
    const result = await this.connectors.updateBuiltIn(organizationId, request.auth!.user.id, key, input);
    await this.record(organizationId, request.auth!.user.id, "google-connector-policy-updated", result.id, { key, enabled: result.enabled, maxAccessLevel: result.maxAccessLevel, workspaceAccessMode: result.workspaceAccessMode });
    return result;
  }

  @Post("custom")
  async createCustom(@Req() request: AuthenticatedRequest, @Param("tenantId") organizationId: string, @Body() body: unknown) {
    await this.allow(request, organizationId, "mcp:write");
    const input = parse(CustomConnectorSchema.omit({ id: true }), body);
    const result = await this.connectors.saveCustom(organizationId, request.auth!.user.id, input);
    await this.record(organizationId, request.auth!.user.id, "custom-mcp-draft-created", result.id, safeConnectorMetadata(result));
    return result;
  }

  @Put("custom/:id")
  async updateCustom(@Req() request: AuthenticatedRequest, @Param("tenantId") organizationId: string, @Param("id") id: string, @Body() body: unknown) {
    await this.allow(request, organizationId, "mcp:write");
    const input = parse(CustomConnectorSchema.omit({ id: true }), body);
    const result = await this.connectors.saveCustom(organizationId, request.auth!.user.id, { ...input, id });
    await this.record(organizationId, request.auth!.user.id, "custom-mcp-draft-updated", result.id, safeConnectorMetadata(result));
    return result;
  }

  @Post("custom/:id/oauth/start")
  async startAdminOAuth(@Req() request: AuthenticatedRequest, @Param("tenantId") organizationId: string, @Param("id") id: string) {
    await this.allow(request, organizationId, "mcp:write");
    return this.connectors.startCustomOAuth(organizationId, request.auth!.user.id, id, true, "/admin/connectors");
  }

  @Post("custom/:id/discover")
  async discoverCustom(@Req() request: AuthenticatedRequest, @Param("tenantId") organizationId: string, @Param("id") id: string) {
    await this.allow(request, organizationId, "mcp:write");
    const result = await this.connectors.discoverCustom(organizationId, request.auth!.user.id, id);
    await this.record(organizationId, request.auth!.user.id, "custom-mcp-tools-discovered", result.id, { toolNames: result.tools });
    return result;
  }

  @Post("custom/:id/publish")
  async publishCustom(@Req() request: AuthenticatedRequest, @Param("tenantId") organizationId: string, @Param("id") id: string, @Body() body: unknown) {
    await this.allow(request, organizationId, "mcp:write");
    const input = parse(PublishSchema, body);
    const result = await this.connectors.publishCustom(organizationId, request.auth!.user.id, id, input);
    await this.record(organizationId, request.auth!.user.id, "custom-mcp-published", result.id, { enabled: result.enabled, toolNames: result.tools });
    return result;
  }

  @Delete("custom/:id")
  async removeCustom(@Req() request: AuthenticatedRequest, @Param("tenantId") organizationId: string, @Param("id") id: string) {
    await this.allow(request, organizationId, "mcp:write");
    const result = await this.connectors.removeCustom(organizationId, id);
    await this.record(organizationId, request.auth!.user.id, "custom-mcp-deleted", id, {});
    return result;
  }

  private async allow(request: AuthenticatedRequest, organizationId: string, permission: OrgPermission): Promise<void> {
    if (!await this.identity.authorize(request.auth!.user.id, organizationId, permission)) throw new ForbiddenException(`Missing organization permission: ${permission}`);
  }

  private async record(organizationId: string, userId: string, action: string, targetId: string, metadata: JsonValue): Promise<void> {
    await this.audit.append({ tenantId: organizationId, actorUserId: userId, category: "connectors", action, targetType: "connector", targetId, metadata });
  }
}

function parse<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) throw new BadRequestException(result.error.flatten());
  return result.data;
}

function tenantId(): string { return process.env.BERRY_TENANT_ID ?? SELF_HOST_TENANT_ID; }
function redirect(response: ServerResponse, location: string): void { response.statusCode = 302; response.setHeader("location", location); response.end(); }
function safeConnectorMetadata(connector: Connector): JsonValue { return { name: connector.name, url: connector.url, authType: connector.authType, authStrategy: connector.authStrategy, maxAccessLevel: connector.maxAccessLevel, publicationStatus: connector.publicationStatus }; }
