import "reflect-metadata";

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { BadRequestException, Body, Controller, Get, Inject, Module, NotFoundException, Param, Post, Res, type DynamicModule } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
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
import type { BerryAuthRuntime } from "./auth/auth-runtime.ts";
import { PublicAuth } from "./auth/auth.decorators.ts";

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
}

const ARTIFACT_READ_CONFIG = Symbol("ARTIFACT_READ_CONFIG");

type ArtifactReadConfig = {
  client: S3Client;
  bucket: string;
  prefix: string;
} | null;

@Controller("/v1/artifacts")
class ArtifactController {
  constructor(@Inject(ARTIFACT_READ_CONFIG) private readonly config: ArtifactReadConfig) {}

  @Get()
  async list() {
    if (!this.config) return [];
    const items: Array<ReturnType<typeof artifactLibraryItem>> = [];
    let continuationToken: string | undefined;
    do {
      const page = await this.config.client.send(new ListObjectsV2Command({
        Bucket: this.config.bucket,
        Prefix: `${this.config.prefix}/`,
        ContinuationToken: continuationToken,
      }));
      for (const object of page.Contents ?? []) {
        if (!object.Key || object.Key.endsWith("/")) continue;
        items.push(artifactLibraryItem(this.config.prefix, object.Key, object.Size ?? 0, object.LastModified));
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
    return items.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  @Post()
  async upload(@Body() body: { name?: unknown; mediaType?: unknown; dataUrl?: unknown }) {
    if (!this.config) throw new BadRequestException("Artifact storage is not configured");
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const mediaType = typeof body.mediaType === "string" && body.mediaType.trim() ? body.mediaType.trim() : "application/octet-stream";
    if (!name || name.length > 240 || typeof body.dataUrl !== "string") throw new BadRequestException("A valid file is required");
    const match = /^data:([^;,]*)(?:;charset=[^;,]*)?;base64,([A-Za-z0-9+/=\r\n]+)$/.exec(body.dataUrl);
    if (!match) throw new BadRequestException("The file payload must be base64 encoded");
    const content = Buffer.from(match[2]!.replace(/[\r\n]/g, ""), "base64");
    if (content.byteLength > 10 * 1024 * 1024) throw new BadRequestException("Files are limited to 10 MB");
    const key = `${this.config.prefix}/${crypto.randomUUID()}-${safeArtifactName(name)}`;
    await this.config.client.send(new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: key,
      Body: content,
      ContentType: mediaType,
      Metadata: { "original-name": encodeURIComponent(name), source: "web-upload" },
    }));
    return artifactLibraryItem(this.config.prefix, key, content.byteLength, new Date(), mediaType);
  }

  @Get("*key")
  async read(@Param("key") rawKey: string | string[], @Res() response: ServerResponse) {
    if (!this.config) throw new NotFoundException("Artifact storage is not configured");
    const key = Array.isArray(rawKey) ? rawKey.join("/") : rawKey;
    if (!key.startsWith(`${this.config.prefix}/`) || key.includes("\\") || key.split("/").includes("..")) {
      throw new NotFoundException("Artifact not found");
    }
    try {
      const object = await this.config.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: key }));
      if (!object.Body) throw new NotFoundException("Artifact not found");
      const content = await object.Body.transformToByteArray();
      response.statusCode = 200;
      response.setHeader("Content-Type", object.ContentType ?? "application/octet-stream");
      response.setHeader("Content-Length", String(content.byteLength));
      response.setHeader("Cache-Control", "private, max-age=3600");
      response.setHeader("Content-Disposition", inlineDisposition(object.ContentType) ? "inline" : "attachment");
      response.end(Buffer.from(content));
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

function artifactLibraryItem(prefix: string, key: string, size: number, createdAt = new Date(0), explicitMediaType?: string) {
  const storedName = key.slice(`${prefix}/`.length).replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-/i, "");
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
  const pg = PgSqlExecutor.fromConnectionString(requiredEnv(env, "BERRY_DATABASE_URL", env.DATABASE_URL));
  const budgetService = createBudgetServiceFromEnv(env, new PostgresBudgetRepository(new CloudDatabaseService(pg)));
  const contractProvider = createBudgetedContractSandboxProvider(env, budgetService);
  const runtime = createRuntimeSessionHost(env, contractProvider);
  const personalCapabilities = new PersonalCapabilitiesService(new CloudDatabaseService(pg));
  const organizationCapabilities = new OrganizationCapabilitiesService(personalCapabilities, new CloudDatabaseService(pg));
  const auth = createAuthRuntime(env);
  return {
    module: BerryApiMainModule,
    imports: [
      CloudDatabaseModule.register({ useValue: pg }),
      FilePlatformModule,
      AgentApiModule.register({
        sessionHost: { useValue: runtime },
        sandboxWorkspace: { useValue: new SandboxWorkspaceService({
          provider: contractProvider,
          repository: new PostgresSandboxWorkspaceRepository(new CloudDatabaseService(pg)),
          image: env.BERRY_SANDBOX_IMAGE ?? "node:22-bookworm",
          ttlSeconds: numberEnv(env.BERRY_SANDBOX_TTL_SECONDS, 3600),
        }) },
        personalCapabilities: { useValue: personalCapabilities },
        organizationCapabilities: { useValue: organizationCapabilities },
        taskStore: {
          inject: [CloudDatabaseService],
          useFactory: (database: CloudDatabaseService) => new PostgresCloudTaskStore(database, env.BERRY_TENANT_ID ?? SELF_HOST_TENANT_ID),
        },
        identity: {
          scimBearerToken: env.BERRY_SCIM_BEARER_TOKEN ?? null,
          repository: {
            inject: [CloudDatabaseService],
            useFactory: (database: CloudDatabaseService) => new PostgresEnterpriseIdentityRepository(
              database,
              Math.max(1, Math.floor(numberEnv(env.BERRY_AUTH_MAX_USERS, 10))),
            ),
          },
        },
        budget: { service: { useValue: budgetService }, allowanceRepository: new PostgresAllowanceRepository(new CloudDatabaseService(pg)) },
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
        policyDistribution: { service: { useValue: new PolicyDistributionService(new PostgresPolicyDistributionRepository(new CloudDatabaseService(pg)), createPolicySignerFromEnv(env), organizationCapabilities) } },
        management: {
          repository: new PostgresManagementRepository(new CloudDatabaseService(pg)),
          platformService: new PostgresPlatformService(new CloudDatabaseService(pg)),
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
        ...(auth ? { auth: { useValue: auth } } : {}),
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
  await database.migrate();
  const port = Number(env.PORT ?? env.BERRY_API_PORT ?? 3000);
  await app.listen(port, "0.0.0.0");
}

function createRuntimeSessionHost(env: NodeJS.ProcessEnv, contractProvider: ContractSandboxProvider): SessionHost {
  const runtimeDbPath = env.BERRY_RUNTIME_DB_PATH ?? "/data/berry-runtime.sqlite";
  mkdirSync(dirname(runtimeDbPath), { recursive: true });
  const db = new BerryDatabase(runtimeDbPath);
  db.migrate();
  const sandboxProvider = new CloudSandboxProvider({
    provider: contractProvider,
    tenantId: env.BERRY_TENANT_ID ?? SELF_HOST_TENANT_ID,
    image: env.BERRY_SANDBOX_IMAGE ?? "node:22-bookworm",
    cwd: env.BERRY_SANDBOX_CWD ?? "/workspace",
    ttlSeconds: numberEnv(env.BERRY_SANDBOX_TTL_SECONDS, 3600),
    resources: {
      cpuCount: numberEnv(env.BERRY_SANDBOX_CPU_COUNT, 2),
      memoryMiB: numberEnv(env.BERRY_SANDBOX_MEMORY_MIB, 4096),
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
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return undefined;
  const client = new S3Client({
    endpoint,
    region: env.BERRY_ARTIFACT_S3_REGION ?? "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
  const uploadClient = new S3Client({
    endpoint: env.BERRY_ARTIFACT_S3_PUBLIC_ENDPOINT ?? endpoint,
    region: env.BERRY_ARTIFACT_S3_REGION ?? "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
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
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return {
    bucket,
    prefix: (env.BERRY_ARTIFACT_S3_PREFIX ?? "artifacts").replace(/^\/+|\/+$/g, ""),
    client: new S3Client({
      endpoint,
      region: env.BERRY_ARTIFACT_S3_REGION ?? "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
    }),
  };
}

function inlineDisposition(contentType: string | undefined): boolean {
  return ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"].includes(contentType ?? "");
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

function createAuthRuntime(env: NodeJS.ProcessEnv): BerryAuthRuntime | null {
  if ((env.BERRY_AUTH_MODE ?? "single-user") !== "single-user") {
    return null;
  }
  return {
    describe: () => ({
      basePath: "/v1/auth",
      emailPassword: { enabled: true, minPasswordLength: 8, maxPasswordLength: 128 },
      signupEnabled: false,
      socialProviders: [],
      storage: "memory",
    }),
    getSession: async () => singleUserSession(env),
    requireSession: async () => singleUserSession(env),
    handleNodeRequest: async (_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, mode: "single-user" }));
    },
  };
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

function singleUserSession(env: NodeJS.ProcessEnv) {
  return {
    session: { id: "self-host-session", userId: "self-host-user" },
    user: {
      id: "self-host-user",
      email: env.BERRY_AUTH_SINGLE_USER_EMAIL ?? "self-host@berry.local",
      name: env.BERRY_AUTH_SINGLE_USER_NAME ?? "Self Host",
      emailVerified: true,
    },
  };
}

function corsConfig(env: NodeJS.ProcessEnv) {
  const origins = csv(env.BERRY_API_CORS_ORIGINS ?? "http://localhost:3108,http://127.0.0.1:3108");
  return { origin: origins, credentials: true };
}

function csv(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function numberEnv(value: string | undefined, fallback: number): number {
  const parsed = value ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
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
