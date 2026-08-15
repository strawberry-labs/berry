import "reflect-metadata";

import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { BadRequestException, Body, Controller, Get, Header, Inject, Module, NotFoundException, Param, Post, Query, Req, Res, UnauthorizedException, type DynamicModule } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { ServerResponse } from "node:http";
import { BerryDatabase } from "@berry/desktop-db";
import {
  CloudSandboxProvider,
  RuntimeSessionHost,
  S3CompatibleArtifactStore,
  createAssistantMessageEventStream,
  type AssistantMessage,
  type BerryModelProviderInfo,
  type ObjectPutClient,
  type SessionHost,
  type StartTurnOptions,
} from "@berry/local-agent";
import { SELF_HOST_TENANT_ID } from "@berry/db";
import { durableContextConfigFromEnv } from "@berry/shared";
import {
  DockerSandboxProvider,
  E2BSandboxProvider,
  FixtureSandboxProvider,
  RouterSandboxProvider,
  type DockerCommandExecutor,
  type DockerCommandResult,
  type DockerStreamEvent,
  type SandboxProvider as ContractSandboxProvider,
} from "@berry/sandbox-contract";
import { AgentApiModule } from "./http/agent-api.module.ts";
import { PostgresAuditRepository, createAuditExportDispatcherFromEnv } from "./audit/audit.service.ts";
import { billingDependencyRequiredFromEnv, createBillingProviderFromEnv, PostgresBillingRepository } from "./billing/billing.service.ts";
import { BudgetedSandboxProvider } from "./budget/budgeted-sandbox-provider.ts";
import { createBudgetServiceFromEnv, PostgresBudgetRepository, type BudgetService } from "./budget/budget.service.ts";
import { PostgresAllowanceRepository } from "./budget/allowance.service.ts";
import { PostgresManagementRepository } from "./management/management.service.ts";
import { ExplicitPlatformAuthorizer } from "./management/platform-authorizer.ts";
import { PostgresPlatformService } from "./management/platform.service.ts";
import {
  bufferBodyPrefix,
  detectMediaType,
  FILE_TYPE_SAMPLE_BYTES,
  fileResponsePolicy,
  INVALID_FILE_CACHE_CONTROL,
  normalizeMediaType,
  PROTECTED_FILE_CACHE_CONTROL,
  setUntrustedFileResponseHeaders,
} from "./files/file-response-security.ts";
import { FilePlatformService } from "./files/file-platform.service.ts";
import { CloudDatabaseModule } from "./db/cloud-database.module.ts";
import { CloudDatabaseService } from "./db/cloud-database.service.ts";
import { FilePlatformModule } from "./files/file-platform.module.ts";
import { PgSqlExecutor } from "./db/pg-executor.ts";
import { PostgresCloudTaskStore } from "./http/cloud-task-store.ts";
import { PostgresSandboxWorkspaceRepository, SandboxWorkspaceService } from "./http/sandbox-workspace.service.ts";
import { PersonalCapabilitiesService } from "./http/personal-capabilities.service.ts";
import { OrganizationCapabilitiesService } from "./http/organization-capabilities.service.ts";
import { PostgresEnterpriseIdentityRepository } from "./identity/identity.repository.ts";
import { PostgresModelGovernanceRepository } from "./model-governance/model-governance.service.ts";
import { createPolicySignerFromEnv, PolicyDistributionService, PostgresPolicyDistributionRepository } from "./policy-distribution/policy-distribution.service.ts";
import { PostgresUsageRepository } from "./usage/usage.repository.ts";
import { createUsageEventVerifierFromEnv } from "./usage/usage.signing.ts";
import { deploymentRuntimeDescription } from "./deployment-mode.ts";
import { createBerryAuthRuntime, type BerryAuthRuntime } from "./auth/auth-runtime.ts";
import type { AuthenticatedRequest } from "./auth/auth.guard.ts";
import { PublicAuth } from "./auth/auth.decorators.ts";
import { ConnectorsService } from "./connectors/connectors.service.ts";
import { SetupService } from "./setup/setup.service.ts";
import { s3ClientOptions, s3PresignClientOptions } from "./storage/s3-client-options.ts";
import { ArtifactListQuerySchema } from "./storage/artifact-pagination.ts";
import { apiRuntimeMetrics } from "./runtime/runtime-metrics.ts";

@Controller()
@PublicAuth()
export class HealthController {
  constructor(@Inject(CloudDatabaseService) private readonly database: CloudDatabaseService) {}

  @Get("/healthz")
  health() {
    return { ok: true, service: "berry-api", deployment: deploymentRuntimeDescription() };
  }

  @Get("/readyz")
  async ready() {
    await this.database.ping();
    return { ok: true, service: "berry-api", ready: true };
  }

  @Get("/metrics")
  @Header("content-type", "text/plain; version=0.0.4; charset=utf-8")
  metrics(): string {
    return apiRuntimeMetrics.render();
  }
}

export const ARTIFACT_READ_CONFIG = Symbol("ARTIFACT_READ_CONFIG");

export type ArtifactReadConfig = {
  client: S3Client;
  bucket: string;
  prefix: string;
  tenantId: string;
} | null;

@Controller("/v1/artifacts")
export class ArtifactController {
  constructor(
    @Inject(ARTIFACT_READ_CONFIG) private readonly config: ArtifactReadConfig,
    @Inject(CloudDatabaseService) private readonly database: CloudDatabaseService,
    @Inject(FilePlatformService) private readonly files: FilePlatformService,
  ) {}

  @Get()
  async list(@Req() request: AuthenticatedRequest, @Query() rawQuery: Record<string, unknown>) {
    const parsed = ArtifactListQuerySchema.safeParse(rawQuery);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    if (!this.config) return { items: [], nextCursor: null };
    const userPrefix = artifactUserPrefix(this.config, authenticatedUserId(request));
    const page = await this.config.client.send(new ListObjectsV2Command({
      Bucket: this.config.bucket,
      Prefix: `${userPrefix}/`,
      ContinuationToken: parsed.data.cursor,
      MaxKeys: parsed.data.limit,
    }));
    const items = (page.Contents ?? [])
      .filter((object) => Boolean(object.Key) && object.Key!.startsWith(`${userPrefix}/`) && !object.Key!.endsWith("/"))
      .map((object) => artifactLibraryItem(object.Key!, object.Size ?? 0, object.LastModified))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return {
      items,
      nextCursor: page.IsTruncated ? page.NextContinuationToken ?? null : null,
    };
  }

  @Post()
  async upload(@Req() request: AuthenticatedRequest, @Body() body: { name?: unknown; mediaType?: unknown; dataUrl?: unknown }) {
    if (!this.config) throw new BadRequestException("Artifact storage is not configured");
    const userId = authenticatedUserId(request);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const declaredMediaType = body.mediaType === undefined ? "application/octet-stream" : normalizeMediaType(body.mediaType);
    if (!declaredMediaType) throw new BadRequestException("A valid MIME media type is required");
    if (!name || name.length > 240 || typeof body.dataUrl !== "string") throw new BadRequestException("A valid file is required");
    const match = /^data:([^;,]*)(?:;charset=[^;,]*)?;base64,([A-Za-z0-9+/=\r\n]+)$/.exec(body.dataUrl);
    if (!match) throw new BadRequestException("The file payload must be base64 encoded");
    const dataUrlMediaType = match[1] ? normalizeMediaType(match[1]) : null;
    if (match[1] && !dataUrlMediaType) throw new BadRequestException("The data URL contains an invalid MIME media type");
    const content = Buffer.from(match[2]!.replace(/[\r\n]/g, ""), "base64");
    if (content.byteLength > 10 * 1024 * 1024) throw new BadRequestException("Files are limited to 10 MB");
    const detectedMediaType = detectMediaType(content.subarray(0, FILE_TYPE_SAMPLE_BYTES));
    const key = `${artifactUserPrefix(this.config, userId)}/${crypto.randomUUID()}-${safeArtifactName(name)}`;
    await this.config.client.send(new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: key,
      Body: content,
      ContentType: detectedMediaType,
      Metadata: {
        "original-name": encodeURIComponent(name),
        "declared-media-type": declaredMediaType,
        ...(dataUrlMediaType ? { "data-url-media-type": dataUrlMediaType } : {}),
        "tenant-id": this.config.tenantId,
        "owner-user-id": userId,
        source: "web-upload",
      },
    }));
    return artifactLibraryItem(key, content.byteLength, new Date(), detectedMediaType);
  }

  @Get("*key")
  async read(@Req() request: AuthenticatedRequest, @Param("key") rawKey: string | string[], @Res() response: ServerResponse) {
    response.setHeader("Cache-Control", INVALID_FILE_CACHE_CONTROL);
    if (!this.config) throw new NotFoundException("Artifact storage is not configured");
    const key = Array.isArray(rawKey) ? rawKey.join("/") : rawKey;
    if (!key.startsWith(`${this.config.prefix}/`) || key.includes("\\") || key.split("/").includes("..")) {
      throw new NotFoundException("Artifact not found");
    }
    await authorizeArtifactKey(this.database, this.files, this.config, authenticatedUserId(request), key);
    try {
      const object = await this.config.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: key }));
      if (!object.Body) throw new NotFoundException("Artifact not found");
      const inspected = await bufferBodyPrefix(object.Body as AsyncIterable<Uint8Array>);
      const policy = fileResponsePolicy({
        declaredMediaType: object.ContentType,
        detectedMediaType: detectMediaType(inspected.sample),
        allowInline: true,
      });
      response.statusCode = 200;
      if (object.ContentLength != null) response.setHeader("Content-Length", String(object.ContentLength));
      response.setHeader("Cache-Control", PROTECTED_FILE_CACHE_CONTROL);
      response.setHeader("Vary", "Authorization, Cookie");
      setUntrustedFileResponseHeaders(response, {
        fileName: artifactLibraryItem(key, object.ContentLength ?? 0).name,
        policy,
      });
      for await (const chunk of inspected.body) {
        if (!response.write(chunk)) await once(response, "drain");
      }
      response.end();
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      const status = typeof error === "object" && error !== null && "$metadata" in error
        ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
        : undefined;
      if (status === 404) throw new NotFoundException("Artifact not found");
      throw error;
    }
  }
}

function artifactLibraryItem(key: string, size: number, createdAt = new Date(0), explicitMediaType?: string) {
  const storedName = (key.split("/").at(-1) ?? "artifact").replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-/i, "");
  const mediaType = explicitMediaType ?? mediaTypeForName(storedName);
  return {
    id: key,
    key,
    url: `/v1/artifacts/${encodeURI(key)}`,
    name: storedName,
    mediaType,
    size,
    createdAt: createdAt.toISOString(),
    category: mediaType.startsWith("image/") ? "images" as const : "documents" as const,
  };
}

function authenticatedUserId(request: AuthenticatedRequest): string {
  const userId = request.auth?.user.id;
  if (!userId) throw new UnauthorizedException("Authentication required");
  return userId;
}

function artifactUserPrefix(config: Exclude<ArtifactReadConfig, null>, userId: string): string {
  return `${config.prefix}/tenants/${config.tenantId}/users/${userId}/legacy-artifacts`;
}

async function authorizeArtifactKey(
  database: CloudDatabaseService,
  files: FilePlatformService,
  config: Exclude<ArtifactReadConfig, null>,
  userId: string,
  key: string,
): Promise<void> {
  if (key.startsWith(`${artifactUserPrefix(config, userId)}/`)) return;
  const relative = key.slice(`${config.prefix}/`.length);
  if (relative.startsWith("tenants/")) throw new NotFoundException("Artifact not found");
  let taskId = /^tasks\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/[^/]+$/i.exec(relative)?.[1];
  if (!taskId && !relative.includes("/")) {
    if (await files.authorizeRegisteredArtifactObjectKey(config.tenantId, userId, key)) return;
    try {
      const legacy = await config.client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
      taskId = objectMetadataValue(legacy.Metadata, "taskId");
    } catch (error) {
      const status = typeof error === "object" && error !== null && "$metadata" in error
        ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
        : undefined;
      if (status === 404) throw new NotFoundException("Artifact not found");
      throw error;
    }
  }
  if (!taskId) throw new NotFoundException("Artifact not found");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(taskId)) {
    throw new NotFoundException("Artifact not found");
  }
  const allowed = await database.withTenant(config.tenantId, async (executor) => {
    const [row] = await executor.query<{ allowed: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM tasks
        WHERE tenant_id=$1::uuid AND id=$2::uuid AND deleted_at IS NULL
          AND (user_id=$3::uuid OR user_id IS NULL)
      ) AS allowed
    `, [config.tenantId, taskId, userId]);
    return row?.allowed === true;
  });
  if (!allowed) throw new NotFoundException("Artifact not found");
}

function objectMetadataValue(metadata: Record<string, string> | undefined, expectedKey: string): string | undefined {
  const normalizedExpected = expectedKey.replace(/-/g, "").toLowerCase();
  return Object.entries(metadata ?? {}).find(([key]) => key.replace(/-/g, "").toLowerCase() === normalizedExpected)?.[1];
}

function mediaTypeForName(name: string): string {
  const extension = name.split(".").at(-1)?.toLowerCase();
  return ({
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", svg: "image/svg+xml",
    pdf: "application/pdf", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    csv: "text/csv", txt: "text/plain", md: "text/markdown", json: "application/json", zip: "application/zip",
  } as Record<string, string>)[extension ?? ""] ?? "application/octet-stream";
}

function safeArtifactName(name: string): string {
  return name.normalize("NFKC").replace(/[\\/\0]/g, "-").replace(/[^\p{L}\p{N}._() -]+/gu, "-").replace(/\s+/g, " ").slice(0, 180) || "artifact";
}

@Module({})
class BerryApiMainModule {}

export function createApiMainModule(env: NodeJS.ProcessEnv = process.env): DynamicModule {
  const durableConfig = durableContextConfigFromEnv(env);
  if (env.NODE_ENV === "production" && !durableConfig.durableRunnerEnabled) {
    throw new Error("BERRY_DURABLE_RUNNER_ENABLED must remain enabled in production; the inline runner is intended for development and tests only");
  }
  const pg = PgSqlExecutor.fromConnectionString(requiredEnv(env, "BERRY_DATABASE_URL", env.DATABASE_URL));
  const platformPg = env.BERRY_PLATFORM_DATABASE_URL
    ? PgSqlExecutor.fromConnectionString(env.BERRY_PLATFORM_DATABASE_URL)
    : pg;
  const database = new CloudDatabaseService(pg, platformPg);
  const budgetService = createBudgetServiceFromEnv(env, new PostgresBudgetRepository(database));
  const contractProvider = createBudgetedContractSandboxProvider(env, budgetService);
  const runtime = createRuntimeSessionHost(env, contractProvider);
  const personalCapabilities = new PersonalCapabilitiesService(database, env);
  const organizationCapabilities = new OrganizationCapabilitiesService(personalCapabilities, database);
  const auth = createAuthRuntime(env);
  const identity = new PostgresEnterpriseIdentityRepository(
    database,
    Math.max(1, Math.floor(numberEnv(env.BERRY_AUTH_MAX_USERS, 10))),
    env,
  );
  const connectors = new ConnectorsService(database, env);
  const setup = new SetupService(database, identity, connectors, env);
  return {
    module: BerryApiMainModule,
    imports: [
      CloudDatabaseModule.register({ useValue: pg, privilegedUseValue: platformPg }),
      FilePlatformModule,
      AgentApiModule.register({
        durableRunnerEnabled: durableConfig.durableRunnerEnabled,
        durableContextEnabled: true,
        sessionHost: { useValue: runtime },
        sandboxWorkspace: { useValue: new SandboxWorkspaceService({
          provider: contractProvider,
          repository: new PostgresSandboxWorkspaceRepository(database),
          image: env.BERRY_SANDBOX_IMAGE ?? "node:22-bookworm",
          root: env.BERRY_SANDBOX_CWD ?? "/workspace",
          ttlSeconds: sandboxTtlSeconds(env),
        }) },
        personalCapabilities: { useValue: personalCapabilities },
        organizationCapabilities: { useValue: organizationCapabilities },
        taskStore: {
          inject: [CloudDatabaseService],
          useFactory: (database: CloudDatabaseService) => new PostgresCloudTaskStore(database, env.BERRY_TENANT_ID ?? SELF_HOST_TENANT_ID),
        },
        identity: {
          scimBearerToken: env.BERRY_SCIM_BEARER_TOKEN ?? null,
          localMemberProvisioningEnabled: authLoginMethods(env).has("password"),
          repository: { useValue: identity },
        },
        budget: { service: { useValue: budgetService }, allowanceRepository: new PostgresAllowanceRepository(database) },
        usage: {
          repository: {
            inject: [CloudDatabaseService],
            useFactory: (database: CloudDatabaseService) => new PostgresUsageRepository(database),
          },
          verifier: { useValue: createUsageEventVerifierFromEnv(env) },
        },
        billing: {
          repository: {
            inject: [CloudDatabaseService],
            useFactory: (database: CloudDatabaseService) => new PostgresBillingRepository(database),
          },
          provider: { useValue: createBillingProviderFromEnv(env) },
          dependencyRequired: billingDependencyRequiredFromEnv(env),
        },
        modelGovernance: {
          repository: {
            inject: [CloudDatabaseService],
            useFactory: (database: CloudDatabaseService) => new PostgresModelGovernanceRepository(database),
          },
        },
        policyDistribution: { service: { useValue: new PolicyDistributionService(new PostgresPolicyDistributionRepository(database), createPolicySignerFromEnv(env), organizationCapabilities) } },
        management: {
          repository: new PostgresManagementRepository(database),
          platformService: new PostgresPlatformService(database),
          platformAuthorizer: new ExplicitPlatformAuthorizer({
            userIds: csv(env.BERRY_PLATFORM_OPERATOR_USER_IDS ?? ""),
            emails: csv(env.BERRY_PLATFORM_OPERATOR_EMAILS ?? ""),
          }),
        },
        audit: {
          repository: {
            inject: [CloudDatabaseService],
            useFactory: (database: CloudDatabaseService) => new PostgresAuditRepository(database),
          },
          dispatcher: { useValue: createAuditExportDispatcherFromEnv(env) },
        },
        auth: { useValue: auth },
        connectors: { useValue: connectors },
        setup: { useValue: setup },
      }),
    ],
    controllers: [HealthController, ArtifactController],
    providers: [{ provide: ARTIFACT_READ_CONFIG, useValue: createArtifactReadConfig(env) }],
  };
}

export async function bootstrap(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(createApiMainModule(env), { cors: corsConfig(env), bodyParser: false });
  app.useBodyParser("json", { limit: env.BERRY_API_JSON_BODY_LIMIT ?? "40mb" });
  app.useBodyParser("urlencoded", { limit: env.BERRY_API_JSON_BODY_LIMIT ?? "40mb", extended: true });
  app.enableShutdownHooks();
  const database = app.get(CloudDatabaseService);
  if (env.BERRY_RUN_MIGRATIONS !== "false") await database.migrate();
  const port = Number(env.PORT ?? env.BERRY_API_PORT ?? 3000);
  await app.listen(port, "0.0.0.0");
}

function createRuntimeSessionHost(env: NodeJS.ProcessEnv, contractProvider: ContractSandboxProvider): SessionHost {
  // This SQLite store is only the rollback adapter used when the durable
  // runner feature flag is disabled. Postgres session_entries is authoritative
  // for the normal web path.
  const runtimeDbPath = env.BERRY_RUNTIME_DB_PATH ?? "/data/berry-inline-fallback.sqlite";
  mkdirSync(dirname(runtimeDbPath), { recursive: true });
  const db = new BerryDatabase(runtimeDbPath);
  db.migrate();
  const sandboxProvider = new CloudSandboxProvider({
    provider: contractProvider,
    tenantId: env.BERRY_TENANT_ID ?? SELF_HOST_TENANT_ID,
    image: env.BERRY_SANDBOX_IMAGE ?? "node:22-bookworm",
    cwd: env.BERRY_SANDBOX_CWD ?? "/workspace",
    ttlSeconds: sandboxTtlSeconds(env),
    resources: {
      cpuCount: numberEnv(env.BERRY_SANDBOX_CPU_COUNT, 1),
      memoryMiB: numberEnv(env.BERRY_SANDBOX_MEMORY_MIB, 1024),
      diskMiB: numberEnv(env.BERRY_SANDBOX_DISK_MIB, 10_240),
    },
  });
  const host = RuntimeSessionHost.create({
    db,
    sandboxProvider,
    artifactStore: createArtifactStore(env),
    log: (level, message) => console[level === "info" ? "log" : level](`[berry-api] ${message}`),
  });
  return env.BERRY_API_MODEL_MODE === "live" ? host : new FixtureStreamSessionHost(host, env.BERRY_API_FIXTURE_RESPONSE);
}

function createBudgetedContractSandboxProvider(env: NodeJS.ProcessEnv, budgets: BudgetService): ContractSandboxProvider {
  return new BudgetedSandboxProvider({
    provider: createContractSandboxProvider(env),
    budgets,
    estimates: {
      createMicros: env.BERRY_BUDGET_SANDBOX_CREATE_ESTIMATE_MICROS ?? 50,
      execMicros: env.BERRY_BUDGET_SANDBOX_EXEC_ESTIMATE_MICROS ?? 25,
      fileMicros: env.BERRY_BUDGET_SANDBOX_FILE_ESTIMATE_MICROS ?? 5,
      portMicros: env.BERRY_BUDGET_SANDBOX_PORT_ESTIMATE_MICROS ?? 5,
    },
  });
}

function createArtifactStore(env: NodeJS.ProcessEnv): S3CompatibleArtifactStore | undefined {
  const endpoint = env.BERRY_ARTIFACT_S3_ENDPOINT;
  const bucket = env.BERRY_ARTIFACT_S3_BUCKET;
  const accessKeyId = env.BERRY_ARTIFACT_S3_ACCESS_KEY_ID;
  const secretAccessKey = env.BERRY_ARTIFACT_S3_SECRET_ACCESS_KEY;
  if (!bucket) return undefined;
  const client = new S3Client(s3ClientOptions({ endpoint, region: env.BERRY_ARTIFACT_S3_REGION, accessKeyId, secretAccessKey }));
  const uploadClient = new S3Client(s3PresignClientOptions({ endpoint: env.BERRY_ARTIFACT_S3_PUBLIC_ENDPOINT ?? endpoint, region: env.BERRY_ARTIFACT_S3_REGION, accessKeyId, secretAccessKey }));
  return new S3CompatibleArtifactStore({
    bucket,
    prefix: env.BERRY_ARTIFACT_S3_PREFIX ?? "artifacts",
    client: new S3ObjectPutClient(client, uploadClient, bucket, env.BERRY_ARTIFACT_PUBLIC_BASE_URL ?? `${(env.BERRY_AUTH_BASE_URL ?? "").replace(/\/+$/, "")}/v1/artifacts`),
  });
}

function createArtifactReadConfig(env: NodeJS.ProcessEnv): ArtifactReadConfig {
  const endpoint = env.BERRY_ARTIFACT_S3_ENDPOINT;
  const bucket = env.BERRY_ARTIFACT_S3_BUCKET;
  const accessKeyId = env.BERRY_ARTIFACT_S3_ACCESS_KEY_ID;
  const secretAccessKey = env.BERRY_ARTIFACT_S3_SECRET_ACCESS_KEY;
  if (!bucket) return null;
  return {
    bucket,
    prefix: (env.BERRY_ARTIFACT_S3_PREFIX ?? "artifacts").replace(/^\/+|\/+$/g, ""),
    tenantId: env.BERRY_TENANT_ID ?? SELF_HOST_TENANT_ID,
    client: new S3Client(s3ClientOptions({ endpoint, region: env.BERRY_ARTIFACT_S3_REGION, accessKeyId, secretAccessKey })),
  };
}

class S3ObjectPutClient implements ObjectPutClient {
  constructor(
    private readonly client: S3Client,
    private readonly uploadClient: S3Client,
    private readonly bucket: string,
    private readonly publicBaseUrl: string,
  ) {}

  async putObject(input: { key: string; body: Uint8Array; contentType: string; metadata?: Record<string, string> | undefined }): Promise<{ url: string }> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: input.key,
      Body: input.body,
      ContentType: input.contentType,
      Metadata: input.metadata,
    }));
    return { url: `${this.publicBaseUrl.replace(/\/+$/, "")}/${encodeURI(input.key)}` };
  }

  async createUploadUrl(input: { key: string; contentType: string; metadata?: Record<string, string> | undefined }): Promise<{ uploadUrl: string; url: string }> {
    const uploadUrl = await getSignedUrl(this.uploadClient, new PutObjectCommand({
      Bucket: this.bucket,
      Key: input.key,
      ContentType: input.contentType,
    }), { expiresIn: 900 });
    return { uploadUrl, url: `${this.publicBaseUrl.replace(/\/+$/, "")}/${encodeURI(input.key)}` };
  }
}

class FixtureStreamSessionHost implements SessionHost {
  constructor(private readonly delegate: SessionHost, private readonly response = "Self-host fixture model response.") {}
  startTurn(options: StartTurnOptions) { return this.delegate.startTurn({ ...options, streamFn: options.streamFn ?? fixtureStreamFn(this.response) }); }
  resolveQuestion(...args: Parameters<SessionHost["resolveQuestion"]>) { return this.delegate.resolveQuestion(...args); }
  resolveApproval(...args: Parameters<SessionHost["resolveApproval"]>) { return this.delegate.resolveApproval(...args); }
  recordApprovalGrant(...args: Parameters<SessionHost["recordApprovalGrant"]>) { return this.delegate.recordApprovalGrant(...args); }
  pendingApprovalIds() { return this.delegate.pendingApprovalIds(); }
  pendingQuestionIds() { return this.delegate.pendingQuestionIds(); }
  cancel(...args: Parameters<SessionHost["cancel"]>) { return this.delegate.cancel(...args); }
  turnState(...args: Parameters<SessionHost["turnState"]>) { return this.delegate.turnState(...args); }
  contextStats(...args: Parameters<SessionHost["contextStats"]>) { return this.delegate.contextStats(...args); }
  steer(...args: Parameters<SessionHost["steer"]>) { return this.delegate.steer(...args); }
  followUp(...args: Parameters<SessionHost["followUp"]>) { return this.delegate.followUp(...args); }
  fork(...args: Parameters<SessionHost["fork"]>) { return this.delegate.fork(...args); }
  rewind(...args: Parameters<SessionHost["rewind"]>) { return this.delegate.rewind(...args); }
  rewindForEdit(...args: Parameters<SessionHost["rewindForEdit"]>) { return this.delegate.rewindForEdit(...args); }
  compact(...args: Parameters<SessionHost["compact"]>) { return this.delegate.compact(...args); }
  listLoadedSkills(...args: Parameters<SessionHost["listLoadedSkills"]>) { return this.delegate.listLoadedSkills(...args); }
  dispose() { return this.delegate.dispose(); }
}

function fixtureStreamFn(text: string): NonNullable<StartTurnOptions["streamFn"]> {
  return (model) => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const message = assistant(model as unknown as BerryModelProviderInfo & { api: string; provider: string; id: string }, text);
      stream.push({ type: "start", partial: message });
      stream.push({ type: "text_start", contentIndex: 0, partial: message });
      stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
      stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
      stream.push({ type: "done", reason: "stop", message });
    });
    return stream;
  };
}

function assistant(model: { api: string; provider: string; id: string }, text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function createContractSandboxProvider(env: NodeJS.ProcessEnv): ContractSandboxProvider {
  const provider = (env.BERRY_SANDBOX_PROVIDER ?? "docker").trim().toLowerCase();
  if (provider === "fixture") return new FixtureSandboxProvider();
  if (provider === "docker") {
    return new DockerSandboxProvider({
      executor: new DockerCliExecutor(),
      imageAllowlist: csv(env.BERRY_SANDBOX_DOCKER_IMAGE_ALLOWLIST ?? env.BERRY_SANDBOX_IMAGE ?? "node:22-bookworm"),
      containerNamePrefix: env.BERRY_SANDBOX_CONTAINER_PREFIX ?? "berry-box",
    });
  }
  if (provider === "e2b") {
    return new E2BSandboxProvider({
      apiKey: requiredEnv(env, "E2B_API_KEY"),
      template: env.BERRY_E2B_TEMPLATE_ID ?? "base",
      ...(env.BERRY_E2B_DOMAIN ? { domain: env.BERRY_E2B_DOMAIN } : {}),
      requestTimeoutMs: numberEnv(env.BERRY_E2B_REQUEST_TIMEOUT_MS, 60_000),
      keepMemoryOnPause: env.BERRY_E2B_KEEP_MEMORY_ON_PAUSE?.trim().toLowerCase() === "true",
      ...(env.BERRY_E2B_ESTIMATED_HOURLY_COST_MICROS ? { estimatedHourlyCostMicros: numberEnv(env.BERRY_E2B_ESTIMATED_HOURLY_COST_MICROS, 0) } : {}),
      ...(env.BERRY_E2B_MINIMUM_EXEC_COST_MICROS ? { minimumExecCostMicros: numberEnv(env.BERRY_E2B_MINIMUM_EXEC_COST_MICROS, 0) } : {}),
    });
  }
  if (provider === "router" || provider === "commercial") {
    return new RouterSandboxProvider({
      kind: provider,
      baseUrl: requiredEnv(env, "BERRY_ROUTER_URL", env.BERRY_ROUTER_BASE_URL),
      serviceToken: requiredEnv(env, "BERRY_ROUTER_SERVICE_TOKEN"),
      providerHint: env.BERRY_ROUTER_SANDBOX_PROVIDER ?? env.BERRY_SANDBOX_COMMERCIAL_PROVIDER,
      contractVersion: env.BERRY_ROUTER_CONTRACT_VERSION,
    });
  }
  throw new Error(`Unsupported BERRY_SANDBOX_PROVIDER: ${provider}`);
}

class DockerCliExecutor implements DockerCommandExecutor {
  async run(args: readonly string[], options: { stdin?: string | Buffer | undefined; signal?: AbortSignal | undefined } = {}): Promise<DockerCommandResult> {
    return runProcess("docker", args, options);
  }

  async *stream(args: readonly string[], options: { stdin?: string | Buffer | undefined; signal?: AbortSignal | undefined } = {}): AsyncIterable<DockerStreamEvent> {
    const child = spawn("docker", [...args], { stdio: ["pipe", "pipe", "pipe"], signal: options.signal });
    if (options.stdin) child.stdin.end(options.stdin);
    else child.stdin.end();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const events: DockerStreamEvent[] = [];
    child.stdout.on("data", (data: string) => events.push({ stream: "stdout", data }));
    child.stderr.on("data", (data: string) => events.push({ stream: "stderr", data }));
    let closed = false;
    let exitCode = 0;
    let signal: string | null = null;
    child.on("close", (code, closeSignal) => {
      closed = true;
      exitCode = code ?? 0;
      signal = closeSignal;
    });
    while (!closed || events.length > 0) {
      const event = events.shift();
      if (event) yield event;
      else await new Promise((resolve) => setTimeout(resolve, 10));
    }
    yield { stream: "exit", exitCode, signal };
  }
}

export function createAuthRuntime(env: NodeJS.ProcessEnv): BerryAuthRuntime {
  const mode = env.BERRY_AUTH_MODE ?? "better-auth";
  if (mode !== "better-auth") {
    throw new Error(`Unsupported BERRY_AUTH_MODE "${mode}". Berry now uses the same better-auth owner setup flow in local and production deployments.`);
  }
  return createBerryAuthRuntime({ env });
}

function runProcess(command: string, args: readonly string[], options: { stdin?: string | Buffer | undefined; signal?: AbortSignal | undefined } = {}): Promise<DockerCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"], signal: options.signal });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data: string) => { stdout += data; });
    child.stderr.on("data", (data: string) => { stderr += data; });
    child.on("error", (error) => {
      stderr += error.message;
    });
    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
    if (options.stdin) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
}

function corsConfig(env: NodeJS.ProcessEnv) {
  const origins = csv(env.BERRY_API_CORS_ORIGINS ?? "http://localhost:3108,http://127.0.0.1:3108");
  return { origin: origins, credentials: true };
}

function csv(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function authLoginMethods(env: NodeJS.ProcessEnv): Set<string> {
  const configured = csv(env.BERRY_AUTH_LOGIN_METHODS ?? "").map((method) => method.toLowerCase());
  return new Set(configured.length > 0 ? configured : ["password"]);
}

function numberEnv(value: string | undefined, fallback: number): number {
  const parsed = value ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sandboxTtlSeconds(env: NodeJS.ProcessEnv): number {
  const parsed = Number(env.BERRY_SANDBOX_TTL_SECONDS);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 300) : 300;
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string, fallback?: string): string {
  const value = env[name] ?? fallback;
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}

// Keep direct execution after every class declaration. Calling bootstrap earlier
// can evaluate runtime factories while later classes are still in their TDZ.
if (import.meta.url === `file://${process.argv[1]}`) {
  bootstrap().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
