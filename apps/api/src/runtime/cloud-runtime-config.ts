import { BadGatewayException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import {
  mcpServerSpecsFromJson,
  type AgentSkill,
  type BerryModelProviderInfo,
  type McpServerSpec,
  type StartTurnOptions,
} from "@berry/local-agent";
import {
  NetworkPolicySchema,
  ProviderCapabilitiesSchema,
  RemoteModelSchema,
  imageSizeForAspectRatio,
  type ImageGenerationRequest,
  type NetworkPolicy,
  type RemoteModel,
} from "@berry/shared";
import { z } from "zod";
import type { OrganizationProviderRuntime } from "../model-governance/organization-provider-runtime.service.ts";

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
  capabilities: ProviderCapabilitiesSchema.optional(),
  models: z.array(RemoteModelSchema).optional(),
}).passthrough();

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

const IMAGE_GENERATION_REQUEST_TIMEOUT_MS = 15 * 60_000;

interface CloudImageGenerationConfig {
  endpoint: string;
  editsEndpoint: string;
  model: string;
  responseFormat: "url" | "b64_json";
  costMicros: string;
}

export interface CloudRuntimeConfig {
  managed: boolean;
  workspacePath: string;
  promptCacheEnabled: boolean;
  provider: BerryModelProviderInfo | null;
  apiKey: string | undefined;
  credentialRef?: string | undefined;
  mcpServers: McpServerSpec[];
  extraSkills: AgentSkill[];
  networkPolicy: NetworkPolicy | undefined;
  imageGeneration: CloudImageGenerationConfig | null;
  providerMaxOutputTokens: number | undefined;
}

export interface ResolvedCloudTurnConfig {
  provider: BerryModelProviderInfo;
  apiKey: string | undefined;
  credentialRef?: string | undefined;
  mcpServers: McpServerSpec[];
  extraSkills: AgentSkill[];
  networkPolicy: NetworkPolicy | undefined;
  providerMaxOutputTokens: number | undefined;
}

@Injectable()
export class CloudRuntimeConfigService {
  readonly config: CloudRuntimeConfig;

  constructor(
    env: NodeJS.ProcessEnv = process.env,
    private readonly organizationProviders?: OrganizationProviderRuntime,
  ) {
    this.config = createCloudRuntimeConfigFromEnv(env);
  }

  async resolve(
    tenantId: string,
    request: { provider?: unknown; apiKey?: string | undefined; model?: string | undefined },
  ): Promise<ResolvedCloudTurnConfig> {
    if (this.organizationProviders) {
      try {
        const organizationProvider = await this.organizationProviders.resolve(tenantId, {
          providerId: requestProviderId(request.provider),
          model: request.model,
        });
        if (organizationProvider) {
          const provider = withAuthoritativeRuntimeCatalog(
            organizationProvider.provider,
            this.config.provider,
          );
          return {
            provider: this.config.promptCacheEnabled
              ? provider
              : withoutPromptCaching(provider),
            apiKey: organizationProvider.apiKey,
            ...(organizationProvider.credentialRef ? { credentialRef: organizationProvider.credentialRef } : {}),
            mcpServers: this.config.mcpServers,
            extraSkills: this.config.extraSkills,
            networkPolicy: this.config.networkPolicy,
            providerMaxOutputTokens: this.config.providerMaxOutputTokens,
          };
        }
      } catch (cause) {
        throw new ServiceUnavailableException(
          cause instanceof Error ? cause.message : "Organization provider is unavailable",
        );
      }
    }
    if (this.config.provider) {
      return {
        provider: this.config.promptCacheEnabled
          ? this.config.provider
          : withoutPromptCaching(this.config.provider),
        apiKey: this.config.apiKey,
        ...(this.config.credentialRef ? { credentialRef: this.config.credentialRef } : {}),
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
      provider: this.config.promptCacheEnabled ? provider : withoutPromptCaching(provider),
      apiKey: request.apiKey,
      mcpServers: [],
      extraSkills: [],
      networkPolicy: undefined,
      providerMaxOutputTokens: undefined,
    };
  }

  async catalog(tenantId: string): Promise<{ providerId: string; name: string; defaultModel: string; models: RemoteModel[]; skills: Array<{ id: string; name: string; description: string; content: string; enabled: true }>; mcpServers: Array<{ id: string; name: string; url: string; auth: "none" | "bearer"; enabled: boolean }> } | null> {
    let provider = this.config.provider;
    if (this.organizationProviders) {
      try {
        const organizationProvider = (await this.organizationProviders.resolve(tenantId))?.provider;
        provider = organizationProvider
          ? withAuthoritativeRuntimeCatalog(organizationProvider, provider)
          : provider;
      } catch (cause) {
        throw new ServiceUnavailableException(
          cause instanceof Error ? cause.message : "Organization provider catalog is unavailable",
        );
      }
    }
    if (!provider) return null;
    return {
      providerId: provider.id,
      name: provider.name,
      defaultModel: provider.defaultModel,
      models: provider.models ?? [],
      skills: this.config.extraSkills.map((skill) => ({
        id: safeSegment(skill.name),
        name: skill.name,
        description: skill.description,
        content: skill.content,
        enabled: true,
      })),
      mcpServers: this.config.mcpServers.flatMap((server) => server.url ? [{ id: server.id, name: server.name, url: server.url, auth: server.credential ? "bearer" as const : "none" as const, enabled: server.enabled }] : []),
    };
  }

  async generateImage(
    input: ImageGenerationRequest,
    onPartial?: (partial: { index: number; b64: string; mimeType: string }) => void,
  ) {
    const image = this.config.imageGeneration;
    if (!image) {
      throw new ServiceUnavailableException("Image generation is not configured on this deployment");
    }
    const size = input.size ?? (input.aspectRatio ? imageSizeForAspectRatio(input.aspectRatio) : "1024x1024");
    const stream = input.stream === true && Boolean(onPartial);
    const referenceImageUrls = input.referenceImageUrls?.filter(Boolean).slice(0, 16) ?? [];
    const endpoint = referenceImageUrls.length > 0 ? image.editsEndpoint : image.endpoint;
    const upstreamModel = image.model.split("/").at(-1) ?? image.model;
    const isGptImageModel = upstreamModel.startsWith("gpt-image-");
    const isGptImage2Model = upstreamModel.startsWith("gpt-image-2");
    const requestBody = {
      model: image.model,
      prompt: input.prompt,
      ...(referenceImageUrls.length > 0
        ? {
            images: referenceImageUrls.map((imageUrl) => ({ image_url: imageUrl })),
            ...(!isGptImage2Model ? { input_fidelity: "high" } : {}),
          }
        : {}),
      n: 1,
      size,
      ...(!isGptImageModel ? { response_format: image.responseFormat } : {}),
      ...(input.transparentBackground ? { background: "transparent", output_format: "png" } : { background: "auto" }),
      ...(stream ? { stream: true, partial_images: input.partialImages ?? 3 } : {}),
    };
    const request = (body: Record<string, unknown>, acceptsStream: boolean) => fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: acceptsStream ? "text/event-stream" : "application/json",
        ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(IMAGE_GENERATION_REQUEST_TIMEOUT_MS),
    });
    let response = await request(requestBody, stream);
    if (!response.ok && stream && [400, 404, 415, 422].includes(response.status)) {
      const { stream: _stream, partial_images: _partialImages, ...bufferedBody } = requestBody;
      response = await request(bufferedBody, false);
    }
    if (!response.ok) {
      const payload = await response.text().catch(() => "");
      const upstreamMessage = imageProviderErrorMessage(payload);
      throw new BadGatewayException({
        code: "image_generation_failed",
        message: upstreamMessage
          ? `BerryRouter rejected the image generation request: ${upstreamMessage}`
          : "BerryRouter rejected the image generation request",
        upstreamStatus: response.status,
        ...(payload ? { upstreamMessage: payload.slice(0, 500) } : {}),
      });
    }
    if (stream && response.headers.get("content-type")?.includes("text/event-stream")) {
      let completed: string | undefined;
      for await (const data of parseEventStream(response)) {
        let event: unknown;
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }
        if (!event || typeof event !== "object" || Array.isArray(event)) continue;
        const record = event as Record<string, unknown>;
        if ((record.type === "image_generation.partial_image" || record.type === "image_edit.partial_image") && typeof record.b64_json === "string") {
          onPartial?.({
            index: typeof record.partial_image_index === "number" ? record.partial_image_index : 0,
            b64: record.b64_json,
            mimeType: "image/png",
          });
        } else if ((record.type === "image_generation.completed" || record.type === "image_edit.completed") && typeof record.b64_json === "string") {
          completed = record.b64_json;
        }
      }
      if (!completed) throw new BadGatewayException("BerryRouter image stream ended without a completed image");
      return { model: image.model, data: [{ b64_json: completed }] };
    }
    const payload: unknown = await response.json().catch(() => null);
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

function withAuthoritativeRuntimeCatalog(
  organizationProvider: BerryModelProviderInfo,
  runtimeProvider: BerryModelProviderInfo | null,
): BerryModelProviderInfo {
  if (!runtimeProvider || runtimeProvider.id !== organizationProvider.id) {
    return organizationProvider;
  }
  const models = runtimeProvider.models ?? organizationProvider.models;
  return {
    ...organizationProvider,
    name: runtimeProvider.name,
    kind: runtimeProvider.kind,
    defaultModel: runtimeProvider.defaultModel,
    ...(models ? { models } : {}),
  };
}

function requestProviderId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const id = (value as Record<string, unknown>).id;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

function imageProviderErrorMessage(payload: string): string | null {
  if (!payload.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(payload);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const error = (parsed as Record<string, unknown>).error;
    if (!error || typeof error !== "object" || Array.isArray(error)) return null;
    const message = (error as Record<string, unknown>).message;
    return typeof message === "string" && message.trim() ? message.trim() : null;
  } catch {
    return null;
  }
}

async function* parseEventStream(response: Response): AsyncGenerator<string> {
  if (!response.body) return;
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data && data !== "[DONE]") yield data;
      boundary = buffer.indexOf("\n\n");
    }
  }
  buffer += decoder.decode();
  const tail = buffer
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (tail && tail !== "[DONE]") yield tail;
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
  const mcpServers = mcpServerSpecsFromJson(env.BERRY_CLOUD_MCP_SERVERS_JSON, env);
  const allowedDomains = csv(env.BERRY_CLOUD_NETWORK_ALLOWED_DOMAINS);
  const egress = env.BERRY_CLOUD_NETWORK_EGRESS?.trim() || (live ? "on" : "off");
  const networkPolicy = live || mcpServers.length > 0
    ? NetworkPolicySchema.parse({ egress, allowedDomains })
    : undefined;
  const imageModel = env.BERRY_ROUTER_IMAGE_MODEL?.trim();
  const imageCostMicros = imageModel ? nonnegativeIntegerString(env.BERRY_ROUTER_IMAGE_COST_MICROS, live) : null;
  return {
    managed: provider !== null,
    workspacePath: absoluteWorkspacePath(env.BERRY_SANDBOX_CWD),
    promptCacheEnabled: env.BERRY_PROMPT_CACHE_ENABLED?.trim().toLowerCase() !== "false",
    provider,
    apiKey: first(env.BERRY_ROUTER_API_KEY, env.BERRY_INFERENCE_API_KEY),
    credentialRef: env.BERRY_ROUTER_API_KEY?.trim()
      ? "env:BERRY_ROUTER_API_KEY"
      : env.BERRY_INFERENCE_API_KEY?.trim()
        ? "env:BERRY_INFERENCE_API_KEY"
        : undefined,
    mcpServers,
    extraSkills: parseSkills(first(env.BERRY_CLOUD_SKILLS_JSON, decodeBase64(env.BERRY_CLOUD_SKILLS_BASE64))),
    networkPolicy,
    imageGeneration: baseUrl && imageModel && imageCostMicros !== null
      ? {
          endpoint: first(env.BERRY_ROUTER_IMAGE_GENERATIONS_URL) ?? joinUrl(baseUrl, env.BERRY_ROUTER_IMAGE_GENERATIONS_PATH?.trim() || "/images/generations"),
          editsEndpoint: first(env.BERRY_ROUTER_IMAGE_EDITS_URL) ?? joinUrl(baseUrl, env.BERRY_ROUTER_IMAGE_EDITS_PATH?.trim() || "/images/edits"),
          model: imageModel,
          responseFormat: env.BERRY_ROUTER_IMAGE_RESPONSE_FORMAT === "url" ? "url" : "b64_json",
          costMicros: imageCostMicros,
        }
      : null,
    providerMaxOutputTokens: positiveInteger(env.BERRY_CLOUD_MODEL_MAX_OUTPUT_TOKENS),
  };
}

function absoluteWorkspacePath(value: string | undefined): string {
  const normalized = (value?.trim() || "/workspace").replaceAll("\\", "/").replace(/\/+$/, "");
  const parts = normalized.split("/").filter(Boolean);
  if (!normalized.startsWith("/") || parts.length === 0 || parts.includes(".") || parts.includes("..")) {
    throw new Error("BERRY_SANDBOX_CWD must be an absolute path without traversal segments");
  }
  return `/${parts.join("/")}`;
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
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1_000_000) {
    throw new Error("BERRY_CLOUD_MODEL_MAX_OUTPUT_TOKENS must be between 1 and 1000000");
  }
  return parsed;
}

function parseModels(raw: string | undefined): RemoteModel[] {
  if (!raw?.trim()) return [];
  return z.array(RemoteModelSchema).parse(JSON.parse(raw));
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

function withoutPromptCaching(provider: BerryModelProviderInfo): BerryModelProviderInfo {
  const capabilities = provider.capabilities
    ? (({ promptCaching: _promptCaching, ...rest }) => rest)(provider.capabilities)
    : undefined;
  return {
    ...provider,
    ...(capabilities ? { capabilities } : {}),
    ...(provider.models ? {
      models: provider.models.map((model) => {
        const modelCapabilities = model.capabilities
          ? (({ promptCaching: _promptCaching, ...rest }) => rest)(model.capabilities)
          : undefined;
        const capabilityOverrides = model.capabilityOverrides
          ? (({ promptCaching: _promptCaching, ...rest }) => rest)(model.capabilityOverrides)
          : undefined;
        return {
          ...model,
          ...(modelCapabilities ? { capabilities: modelCapabilities } : {}),
          ...(capabilityOverrides ? { capabilityOverrides } : {}),
        };
      }),
    } : {}),
  };
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
