import { DockerSandboxProvider, type DockerSandboxProviderOptions } from "./docker-provider.js";
import { E2BSandboxProvider, type E2BSandboxProviderOptions } from "./e2b-provider.js";
import { FixtureSandboxProvider } from "./fixture-provider.js";
import type { SandboxProvider } from "./provider.js";
import { RouterSandboxProvider, type RouterSandboxProviderOptions } from "./router-provider.js";

export type SandboxProviderSelection = "docker" | "e2b" | "router" | "commercial" | "fixture";

export interface SandboxProviderConfig {
  provider: SandboxProviderSelection;
  docker?: DockerSandboxProviderOptions | undefined;
  e2b?: E2BSandboxProviderOptions | undefined;
  router?: RouterSandboxProviderOptions | undefined;
}

export function createSandboxProviderFromConfig(config: SandboxProviderConfig): SandboxProvider {
  if (config.provider === "fixture") return new FixtureSandboxProvider();
  if (config.provider === "docker") {
    if (!config.docker) throw new Error("Docker sandbox provider config is required");
    return new DockerSandboxProvider(config.docker);
  }
  if (config.provider === "e2b") {
    if (!config.e2b) throw new Error("E2B sandbox provider config is required");
    return new E2BSandboxProvider(config.e2b);
  }
  if (!config.router) throw new Error("Router sandbox provider config is required");
  return new RouterSandboxProvider({
    ...config.router,
    kind: config.provider === "commercial" ? "commercial" : "router",
  });
}

export function sandboxProviderConfigFromEnv(env: Record<string, string | undefined>): SandboxProviderConfig {
  const provider = parseProviderSelection(env.BERRY_SANDBOX_PROVIDER);
  if (provider === "e2b") {
    const apiKey = env.E2B_API_KEY;
    if (!apiKey) throw new Error("E2B_API_KEY is required for the E2B sandbox provider");
    return {
      provider,
      e2b: {
        apiKey,
        template: env.BERRY_E2B_TEMPLATE_ID ?? "base",
        ...(env.BERRY_E2B_DOMAIN ? { domain: env.BERRY_E2B_DOMAIN } : {}),
        ...(env.BERRY_E2B_REQUEST_TIMEOUT_MS ? { requestTimeoutMs: positiveInteger(env.BERRY_E2B_REQUEST_TIMEOUT_MS, "BERRY_E2B_REQUEST_TIMEOUT_MS") } : {}),
        ...(env.BERRY_E2B_ESTIMATED_HOURLY_COST_MICROS ? { estimatedHourlyCostMicros: nonnegativeInteger(env.BERRY_E2B_ESTIMATED_HOURLY_COST_MICROS, "BERRY_E2B_ESTIMATED_HOURLY_COST_MICROS") } : {}),
        ...(env.BERRY_E2B_MINIMUM_EXEC_COST_MICROS ? { minimumExecCostMicros: nonnegativeInteger(env.BERRY_E2B_MINIMUM_EXEC_COST_MICROS, "BERRY_E2B_MINIMUM_EXEC_COST_MICROS") } : {}),
        keepMemoryOnPause: booleanValue(env.BERRY_E2B_KEEP_MEMORY_ON_PAUSE, false),
      },
    };
  }
  if (provider === "router" || provider === "commercial") {
    const baseUrl = env.BERRY_ROUTER_URL ?? env.BERRY_ROUTER_BASE_URL;
    const serviceToken = env.BERRY_ROUTER_SERVICE_TOKEN;
    if (!baseUrl) throw new Error("BERRY_ROUTER_URL is required for Router sandbox providers");
    if (!serviceToken) throw new Error("BERRY_ROUTER_SERVICE_TOKEN is required for Router sandbox providers");
    return {
      provider,
      router: {
        baseUrl,
        serviceToken,
        providerHint: env.BERRY_ROUTER_SANDBOX_PROVIDER ?? env.BERRY_SANDBOX_COMMERCIAL_PROVIDER,
        contractVersion: env.BERRY_ROUTER_CONTRACT_VERSION,
      },
    };
  }
  return { provider };
}

function parseProviderSelection(value: string | undefined): SandboxProviderSelection {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return "docker";
  if (normalized === "docker" || normalized === "e2b" || normalized === "router" || normalized === "commercial" || normalized === "fixture") return normalized;
  throw new Error(`Unsupported sandbox provider: ${value}`);
}

function booleanValue(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  if (value.trim().toLowerCase() === "true") return true;
  if (value.trim().toLowerCase() === "false") return false;
  throw new Error(`Expected a boolean value, received: ${value}`);
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function nonnegativeInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative safe integer`);
  return parsed;
}
