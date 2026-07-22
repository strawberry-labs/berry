import type { ModelApiType, ModelProviderKind, ProviderAuthType } from "./index.ts";

/**
 * A provider preset: everything needed to prefill the Add-provider flow (and
 * for local engines, the discovery flow). Presets are design-time data shared
 * by the host, the desktop dev simulator, and tests — never a copy of another
 * app's catalog.
 */
export interface ModelProviderPreset {
  /** Stable preset id; doubles as the provider row id when saved unmodified. */
  id: string;
  kind: ModelProviderKind;
  name: string;
  apiType: ModelApiType;
  baseUrl: string;
  endpointPath: string | null;
  /** null = no list endpoint; models are manual/cached (e.g. Anthropic default). */
  modelsPath: string | null;
  defaultModel: string;
  authType: ProviderAuthType;
  /** Suggested keychain reference when the user supplies a key. */
  credentialRef: string | null;
  /** Env var names checked by the host as key fallbacks, in order. */
  apiKeyEnv: string[];
  /** Short description shown in the Add-provider picker. */
  description: string;
  /** True for engines that run on this machine (no key, may be offline). */
  local: boolean;
}

export const MODEL_PROVIDER_PRESETS: ModelProviderPreset[] = [
  {
    id: "berry-router",
    kind: "berry-router",
    name: "Berry Router",
    apiType: "openai-chat-completions",
    baseUrl: "https://router.berry.dev/v1",
    endpointPath: "/chat/completions",
    modelsPath: "/models",
    defaultModel: "berry/auto",
    authType: "bearer",
    credentialRef: "berry-router",
    apiKeyEnv: ["BERRY_ROUTER_API_KEY"],
    description: "Berry's managed gateway. One key routes every request to the best available model.",
    local: false,
  },
  {
    id: "openai-responses",
    kind: "openai",
    name: "OpenAI",
    apiType: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    endpointPath: "/responses",
    modelsPath: "/models",
    defaultModel: "gpt-4.1-mini",
    authType: "bearer",
    credentialRef: "openai",
    apiKeyEnv: ["OPENAI_API_KEY"],
    description: "OpenAI's Responses API — the current-generation OpenAI endpoint.",
    local: false,
  },
  {
    id: "openai-chat",
    kind: "openai",
    name: "OpenAI Chat",
    apiType: "openai-chat-completions",
    baseUrl: "https://api.openai.com/v1",
    endpointPath: "/chat/completions",
    modelsPath: "/models",
    defaultModel: "gpt-4.1-mini",
    authType: "bearer",
    credentialRef: "openai",
    apiKeyEnv: ["OPENAI_API_KEY"],
    description: "OpenAI's classic Chat Completions API.",
    local: false,
  },
  {
    id: "anthropic",
    kind: "anthropic",
    name: "Anthropic",
    apiType: "anthropic-messages",
    baseUrl: "https://api.anthropic.com/v1",
    endpointPath: "/messages",
    modelsPath: "/models",
    defaultModel: "claude-sonnet-5",
    authType: "x-api-key",
    credentialRef: "anthropic",
    apiKeyEnv: ["ANTHROPIC_API_KEY"],
    description: "Anthropic's Messages API for Claude models.",
    local: false,
  },
  {
    id: "gemini",
    kind: "openai-compatible",
    name: "Google Gemini",
    apiType: "openai-chat-completions",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    endpointPath: "/chat/completions",
    modelsPath: "/models",
    defaultModel: "gemini-3.5-flash",
    authType: "bearer",
    credentialRef: "gemini",
    apiKeyEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    description: "Google's Gemini models via the OpenAI-compatible endpoint.",
    local: false,
  },
  {
    id: "openrouter",
    kind: "openai-compatible",
    name: "OpenRouter",
    apiType: "openai-chat-completions",
    baseUrl: "https://openrouter.ai/api/v1",
    endpointPath: "/chat/completions",
    modelsPath: "/models",
    defaultModel: "openai/gpt-4.1-mini",
    authType: "bearer",
    credentialRef: "openrouter",
    apiKeyEnv: ["OPENROUTER_API_KEY"],
    description: "OpenRouter's multi-provider gateway.",
    local: false,
  },
  {
    id: "fireworks",
    kind: "openai-compatible",
    name: "Fireworks",
    apiType: "openai-chat-completions",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    endpointPath: "/chat/completions",
    modelsPath: "/models",
    defaultModel: "accounts/fireworks/routers/glm-5p2-fast",
    authType: "bearer",
    credentialRef: "fireworks-api-key",
    apiKeyEnv: ["FIREWORKS_API_KEY"],
    description: "Fireworks AI's OpenAI-compatible inference endpoint.",
    local: false,
  },
  {
    id: "groq",
    kind: "openai-compatible",
    name: "Groq",
    apiType: "openai-chat-completions",
    baseUrl: "https://api.groq.com/openai/v1",
    endpointPath: "/chat/completions",
    modelsPath: "/models",
    defaultModel: "llama-3.3-70b-versatile",
    authType: "bearer",
    credentialRef: "groq",
    apiKeyEnv: ["GROQ_API_KEY"],
    description: "Groq's LPU-accelerated inference for open models.",
    local: false,
  },
  {
    id: "deepseek",
    kind: "openai-compatible",
    name: "DeepSeek",
    apiType: "openai-chat-completions",
    baseUrl: "https://api.deepseek.com/v1",
    endpointPath: "/chat/completions",
    modelsPath: "/models",
    defaultModel: "deepseek-chat",
    authType: "bearer",
    credentialRef: "deepseek",
    apiKeyEnv: ["DEEPSEEK_API_KEY"],
    description: "DeepSeek's first-party API.",
    local: false,
  },
  {
    id: "mistral",
    kind: "openai-compatible",
    name: "Mistral",
    apiType: "openai-chat-completions",
    baseUrl: "https://api.mistral.ai/v1",
    endpointPath: "/chat/completions",
    modelsPath: "/models",
    defaultModel: "mistral-large-latest",
    authType: "bearer",
    credentialRef: "mistral",
    apiKeyEnv: ["MISTRAL_API_KEY"],
    description: "Mistral's La Plateforme API.",
    local: false,
  },
  {
    id: "xai",
    kind: "openai-compatible",
    name: "xAI",
    apiType: "openai-chat-completions",
    baseUrl: "https://api.x.ai/v1",
    endpointPath: "/chat/completions",
    modelsPath: "/models",
    defaultModel: "grok-4",
    authType: "bearer",
    credentialRef: "xai",
    apiKeyEnv: ["XAI_API_KEY"],
    description: "xAI's Grok models.",
    local: false,
  },
  {
    id: "moonshot",
    kind: "openai-compatible",
    name: "Moonshot AI",
    apiType: "openai-chat-completions",
    baseUrl: "https://api.moonshot.ai/v1",
    endpointPath: "/chat/completions",
    modelsPath: "/models",
    defaultModel: "kimi-k2-turbo-preview",
    authType: "bearer",
    credentialRef: "moonshot",
    apiKeyEnv: ["MOONSHOT_API_KEY"],
    description: "Moonshot's Kimi models.",
    local: false,
  },
  {
    id: "together",
    kind: "openai-compatible",
    name: "Together AI",
    apiType: "openai-chat-completions",
    baseUrl: "https://api.together.xyz/v1",
    endpointPath: "/chat/completions",
    modelsPath: "/models",
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    authType: "bearer",
    credentialRef: "together",
    apiKeyEnv: ["TOGETHER_API_KEY"],
    description: "Together AI's open-model inference cloud.",
    local: false,
  },
  {
    id: "jan-llamacpp",
    kind: "local",
    name: "Jan llama.cpp",
    apiType: "openai-chat-completions",
    baseUrl: "http://localhost:6767/v1",
    endpointPath: "/chat/completions",
    modelsPath: "/models",
    defaultModel: "",
    authType: "none",
    credentialRef: null,
    apiKeyEnv: [],
    description: "Jan's local llama.cpp server (jan-cli serve).",
    local: true,
  },
  {
    id: "ollama",
    kind: "ollama",
    name: "Ollama",
    apiType: "openai-chat-completions",
    baseUrl: "http://localhost:11434/v1",
    endpointPath: "/chat/completions",
    modelsPath: "/models",
    defaultModel: "",
    authType: "none",
    credentialRef: null,
    apiKeyEnv: [],
    description: "Ollama's local OpenAI-compatible endpoint.",
    local: true,
  },
  {
    id: "ollama-cloud",
    kind: "ollama",
    name: "Remote Ollama / cloud",
    apiType: "openai-chat-completions",
    baseUrl: "https://ollama.com/v1",
    endpointPath: "/chat/completions",
    modelsPath: "/models",
    defaultModel: "gpt-oss:120b",
    authType: "bearer",
    credentialRef: "ollama-api-key",
    apiKeyEnv: ["OLLAMA_API_KEY"],
    description: "Ollama's hosted API or another remote Ollama host; edit the URL for self-hosted servers.",
    local: false,
  },
  {
    id: "lm-studio",
    kind: "lm-studio",
    name: "LM Studio",
    apiType: "openai-chat-completions",
    baseUrl: "http://localhost:1234/v1",
    endpointPath: "/chat/completions",
    modelsPath: "/models",
    defaultModel: "",
    authType: "optional-bearer",
    credentialRef: "lm-studio-api-token",
    apiKeyEnv: ["LM_STUDIO_API_TOKEN"],
    description: "LM Studio's native model lifecycle and OpenAI-compatible inference server.",
    local: true,
  },
  {
    id: "custom-openai-compatible",
    kind: "custom",
    name: "OpenAI-compatible endpoint",
    apiType: "openai-chat-completions",
    baseUrl: "",
    endpointPath: "/chat/completions",
    modelsPath: "/models",
    defaultModel: "",
    authType: "none",
    credentialRef: null,
    apiKeyEnv: [],
    description: "Any OpenAI-compatible endpoint. Add an API key if the server needs one.",
    local: false,
  },
];

export function findModelProviderPreset(id: string): ModelProviderPreset | undefined {
  return MODEL_PROVIDER_PRESETS.find((preset) => preset.id === id);
}

/** Default request path for an API type when a provider has no explicit endpointPath. */
export function defaultEndpointPath(apiType: ModelApiType): string {
  switch (apiType) {
    case "openai-responses":
      return "/responses";
    case "anthropic-messages":
      return "/messages";
    default:
      return "/chat/completions";
  }
}
