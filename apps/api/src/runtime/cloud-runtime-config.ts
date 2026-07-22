import { BadGatewayException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import type { AgentSkill, BerryModelProviderInfo, McpServerSpec, StartTurnOptions } from "@berry/local-agent";
import { NetworkPolicySchema, RemoteModelSchema, type NetworkPolicy, type RemoteModel } from "@berry/shared";
import { z } from "zod";

const RequestProviderSchema = z.object({
  id: z.string().min(1),
  baseUrl: z.string().url(),
  defaultModel: z.string().min(1).optional(),
  kind: z.string().min(1),
  name: z.string().min(1),
  apiType: z.enum(["openai-chat-completions", "openai-responses", "anthropic-messages"]).optional(),
  endpointPath: z.string().nullable().optional(),
  modelsPath: z.string().nullable().optional(),
  authType: z.enum(["none", "bearer", "optional-bearer", "x-api-key"]).optional(),
}).passthrough();

const CloudMcpServerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  transport: z.enum(["stdio", "http-sse", "streamable-http"]),
  command: z.string().nullable().default(null),
  args: z.array(z.string()).default([]),
  url: z.string().url().nullable().default(null),
  env: z.record(z.string()).default({}),
  enabled: z.boolean().default(true),
  trusted: z.boolean().default(true),
  credential: z.string().nullable().optional(),
  credentialEnv: z.string().min(1).optional(),
  credentialKey: z.string().nullable().optional(),
  cachedTools: z.array(z.object({
    name: z.string(),
    description: z.string().nullable().default(null),
    inputSchema: z.record(z.unknown()),
    annotations: z.object({
      readOnlyHint: z.boolean().optional(),
      destructiveHint: z.boolean().optional(),
      idempotentHint: z.boolean().optional(),
      openWorldHint: z.boolean().optional(),
    }).optional(),
  })).optional(),
});

const CloudSkillSchema = z.object({
  name: z.string().trim().min(1).max(64),
  description: z.string().trim().min(1).max(1024),
  content: z.string().min(1),
  enabled: z.boolean().default(true),
  disableModelInvocation: z.boolean().default(false),
});

const ImageGenerationResponseSchema = z.object({
  created: z.number().optional(),
  model: z.string().optional(),
  data: z.array(z.object({
    url: z.string().url().optional(),
    b64_json: z.string().optional(),
    revised_prompt: z.string().optional(),
  }).passthrough()).min(1),
}).passthrough();

interface CloudImageGenerationConfig {
  endpoint: string;
  model: string;
  responseFormat: "url" | "b64_json";
  costMicros: string;
}

export interface CloudRuntimeConfig {
  managed: boolean;
  provider: BerryModelProviderInfo | null;
  apiKey: string | undefined;
  mcpServers: McpServerSpec[];
  extraSkills: AgentSkill[];
  networkPolicy: NetworkPolicy | undefined;
  imageGeneration: CloudImageGenerationConfig | null;
  providerMaxOutputTokens: number | undefined;
}

export interface ResolvedCloudTurnConfig {
  provider: BerryModelProviderInfo;
  apiKey: string | undefined;
  mcpServers: McpServerSpec[];
  extraSkills: AgentSkill[];
  networkPolicy: NetworkPolicy | undefined;
  providerMaxOutputTokens: number | undefined;
}

@Injectable()
export class CloudRuntimeConfigService {
  readonly config: CloudRuntimeConfig;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.config = createCloudRuntimeConfigFromEnv(env);
  }

  resolve(request: { provider?: unknown; apiKey?: string | undefined; model?: string | undefined }): ResolvedCloudTurnConfig {
    if (this.config.provider) {
      return {
        provider: this.config.provider,
        apiKey: this.config.apiKey,
        mcpServers: this.config.mcpServers,
        extraSkills: this.config.extraSkills,
        networkPolicy: this.config.networkPolicy,
        providerMaxOutputTokens: this.config.providerMaxOutputTokens,
      };
    }
    const parsedProvider = RequestProviderSchema.parse(request.provider);
    const provider = {
      ...parsedProvider,
      defaultModel: parsedProvider.defaultModel ?? request.model ?? "berry/auto",
    } as BerryModelProviderInfo;
    return {
      provider,
      apiKey: request.apiKey,
      mcpServers: [],
      extraSkills: [],
      networkPolicy: undefined,
      providerMaxOutputTokens: undefined,
    };
  }

  catalog(): { providerId: string; name: string; defaultModel: string; models: RemoteModel[]; skills: Array<{ id: string; name: string; description: string; enabled: true }>; mcpServers: Array<{ id: string; name: string; url: string; auth: "none" | "bearer"; enabled: boolean }> } | null {
    const provider = this.config.provider;
    if (!provider) return null;
    return {
      providerId: provider.id,
      name: provider.name,
      defaultModel: provider.defaultModel,
      models: provider.models ?? [],
      skills: this.config.extraSkills.map((skill) => ({ id: safeSegment(skill.name), name: skill.name, description: skill.description, enabled: true })),
      mcpServers: this.config.mcpServers.flatMap((server) => server.url ? [{ id: server.id, name: server.name, url: server.url, auth: server.credential ? "bearer" as const : "none" as const, enabled: server.enabled }] : []),
    };
  }

  async generateImage(input: { prompt: string; size?: string | undefined }) {
    const image = this.config.imageGeneration;
    if (!image) {
      throw new ServiceUnavailableException("Image generation is not configured on this deployment");
    }
    const response = await fetch(image.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: image.model,
        prompt: input.prompt,
        n: 1,
        size: input.size ?? "1024x1024",
        response_format: image.responseFormat,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      throw new BadGatewayException({
        code: "image_generation_failed",
        message: "BerryRouter rejected the image generation request",
        upstreamStatus: response.status,
      });
    }
    const parsed = ImageGenerationResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new BadGatewayException("BerryRouter returned an invalid image generation response");
    }
    return { ...parsed.data, model: parsed.data.model ?? image.model };
  }

  imageGenerationInfo(): { providerId: string; model: string; costMicros: string } | null {
    const image = this.config.imageGeneration;
    if (!image) return null;
    return {
      providerId: this.config.provider?.id ?? "router",
      model: image.model,
      costMicros: image.costMicros,
    };
  }
}

export function createCloudRuntimeConfigFromEnv(env: NodeJS.ProcessEnv): CloudRuntimeConfig {
  const live = (env.BERRY_API_MODEL_MODE ?? "fixture").trim().toLowerCase() === "live";
  const completionTransport = parseCompletionTransport(env.BERRY_ROUTER_COMPLETION_TRANSPORT);
  const baseUrl = first(env.BERRY_ROUTER_INFERENCE_BASE_URL, env.BERRY_INFERENCE_BASE_URL, env.BERRY_ROUTER_URL);
  if (live && !baseUrl) {
    throw new Error("BERRY_ROUTER_INFERENCE_BASE_URL is required when BERRY_API_MODEL_MODE=live");
  }
  const models = parseModels(env.BERRY_ROUTER_MODELS_JSON);
  const defaultModel = first(env.BERRY_ROUTER_DEFAULT_MODEL, models[0]?.id, live ? undefined : "berry/auto");
  if (live && !defaultModel) {
    throw new Error("BERRY_ROUTER_DEFAULT_MODEL or at least one BERRY_ROUTER_MODELS_JSON entry is required in live mode");
  }
  const provider: BerryModelProviderInfo | null = baseUrl && defaultModel
    ? {
        id: env.BERRY_ROUTER_PROVIDER_ID?.trim() || "router",
        name: env.BERRY_ROUTER_PROVIDER_NAME?.trim() || "Berry Router",
        kind: "berry-router",
        baseUrl: stripTrailingSlash(baseUrl),
        defaultModel,
        apiType: "openai-chat-completions",
        endpointPath: env.BERRY_ROUTER_CHAT_COMPLETIONS_PATH?.trim() || "/chat/completions",
        modelsPath: env.BERRY_ROUTER_MODELS_PATH?.trim() || "/models",
        authType: "bearer",
        capabilities: { reasoning: true, toolCalling: true, imageInput: true },
        completionTransport,
        ...(completionTransport === "stream" ? { completionFallback: "buffered" as const } : {}),
        models,
      }
    : null;
  const mcpServers = parseMcpServers(env.BERRY_CLOUD_MCP_SERVERS_JSON, env);
  const allowedDomains = csv(env.BERRY_CLOUD_NETWORK_ALLOWED_DOMAINS);
  const egress = env.BERRY_CLOUD_NETWORK_EGRESS?.trim() || (live ? "on" : "off");
  const networkPolicy = live || mcpServers.length > 0
    ? NetworkPolicySchema.parse({ egress, allowedDomains })
    : undefined;
  const imageModel = env.BERRY_ROUTER_IMAGE_MODEL?.trim();
  const imageCostMicros = imageModel ? nonnegativeIntegerString(env.BERRY_ROUTER_IMAGE_COST_MICROS, live) : null;
  return {
    managed: provider !== null,
    provider,
    apiKey: first(env.BERRY_ROUTER_API_KEY, env.BERRY_INFERENCE_API_KEY),
    mcpServers,
    extraSkills: parseSkills(first(env.BERRY_CLOUD_SKILLS_JSON, decodeBase64(env.BERRY_CLOUD_SKILLS_BASE64))),
    networkPolicy,
    imageGeneration: baseUrl && imageModel && imageCostMicros !== null
      ? {
          endpoint: first(env.BERRY_ROUTER_IMAGE_GENERATIONS_URL) ?? joinUrl(baseUrl, env.BERRY_ROUTER_IMAGE_GENERATIONS_PATH?.trim() || "/images/generations"),
          model: imageModel,
          responseFormat: env.BERRY_ROUTER_IMAGE_RESPONSE_FORMAT === "url" ? "url" : "b64_json",
          costMicros: imageCostMicros,
        }
      : null,
    providerMaxOutputTokens: positiveInteger(env.BERRY_CLOUD_MODEL_MAX_OUTPUT_TOKENS) ?? (live ? 16_384 : undefined),
  };
}

function parseCompletionTransport(value: string | undefined): "stream" | "buffered" {
  const normalized = value?.trim().toLowerCase() || "stream";
  if (normalized === "stream" || normalized === "buffered") return normalized;
  throw new Error("BERRY_ROUTER_COMPLETION_TRANSPORT must be stream or buffered");
}

function positiveInteger(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  if (!/^\d+$/.test(value.trim())) throw new Error("BERRY_CLOUD_MODEL_MAX_OUTPUT_TOKENS must be a positive integer");
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 32_000) {
    throw new Error("BERRY_CLOUD_MODEL_MAX_OUTPUT_TOKENS must be between 1 and 32000");
  }
  return parsed;
}

function parseModels(raw: string | undefined): RemoteModel[] {
  if (!raw?.trim()) return [];
  return z.array(RemoteModelSchema).parse(JSON.parse(raw));
}

function parseMcpServers(raw: string | undefined, env: NodeJS.ProcessEnv): McpServerSpec[] {
  if (!raw?.trim()) return [];
  return z.array(CloudMcpServerSchema).parse(JSON.parse(raw)).map((server) => {
    const credential = server.credentialEnv ? first(env[server.credentialEnv]) : server.credential ?? undefined;
    const result: McpServerSpec = {
      id: server.id,
      name: server.name,
      transport: server.transport,
      command: server.command,
      args: server.args,
      url: server.url,
      env: server.env,
      enabled: server.enabled,
      trusted: server.trusted,
      credentialKey: server.credentialKey ?? null,
      ...(server.cachedTools ? { cachedTools: server.cachedTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        ...(tool.annotations ? { annotations: compactAnnotations(tool.annotations) } : {}),
      })) } : {}),
      ...(credential ? { credential } : {}),
    };
    return result;
  });
}

function compactAnnotations(value: { readOnlyHint?: boolean | undefined; destructiveHint?: boolean | undefined; idempotentHint?: boolean | undefined; openWorldHint?: boolean | undefined }) {
  return {
    ...(value.readOnlyHint !== undefined ? { readOnlyHint: value.readOnlyHint } : {}),
    ...(value.destructiveHint !== undefined ? { destructiveHint: value.destructiveHint } : {}),
    ...(value.idempotentHint !== undefined ? { idempotentHint: value.idempotentHint } : {}),
    ...(value.openWorldHint !== undefined ? { openWorldHint: value.openWorldHint } : {}),
  };
}

function parseSkills(raw: string | undefined): AgentSkill[] {
  if (!raw?.trim()) return [];
  return z.array(CloudSkillSchema).parse(JSON.parse(raw))
    .filter((skill) => skill.enabled)
    .map((skill) => ({
      name: skill.name,
      description: skill.description,
      content: skill.content,
      filePath: `/cloud-skills/${safeSegment(skill.name)}/SKILL.md`,
      scope: "registered" as const,
      disableModelInvocation: skill.disableModelInvocation,
      resources: [],
    }));
}

function decodeBase64(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  return Buffer.from(value, "base64").toString("utf8");
}

function safeSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "skill";
}

function csv(value: string | undefined): string[] {
  return value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
}

function first(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value?.trim())?.trim();
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function joinUrl(baseUrl: string, path: string): string {
  return `${stripTrailingSlash(baseUrl)}/${path.replace(/^\/+/, "")}`;
}

function nonnegativeIntegerString(value: string | undefined, required: boolean): string {
  const normalized = value?.trim();
  if (!normalized) {
    if (required) throw new Error("BERRY_ROUTER_IMAGE_COST_MICROS is required when image generation is enabled in live mode");
    return "0";
  }
  if (!/^\d+$/.test(normalized)) throw new Error("BERRY_ROUTER_IMAGE_COST_MICROS must be a non-negative integer");
  return normalized;
}

export type CloudStartTurnOverrides = Pick<StartTurnOptions, "provider" | "apiKey" | "mcpServers" | "extraSkills" | "networkPolicy">;
