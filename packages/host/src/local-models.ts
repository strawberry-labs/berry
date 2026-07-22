import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DiscoveredLocalProvider, JsonValue, ModelCapabilities, RemoteModel } from "@berry/shared";

const JAN_CLI_PATH = "/Applications/Jan.app/Contents/MacOS/jan-cli";
const JAN_BASE_URL = "http://localhost:6767/v1";
const OLLAMA_BASE_URL = "http://localhost:11434/v1";
const LM_STUDIO_BASE_URL = "http://localhost:1234/v1";

interface OllamaDetails {
  format?: string;
  family?: string;
  families?: string[];
  parameter_size?: string;
  quantization_level?: string;
}

interface OllamaModelEntry {
  name?: string;
  model?: string;
  digest?: string;
  size?: number;
  size_vram?: number;
  context_length?: number;
  expires_at?: string;
  details?: OllamaDetails;
}

interface OllamaShowResponse {
  capabilities?: string[];
  details?: OllamaDetails;
  model_info?: Record<string, unknown>;
  modified_at?: string;
}

interface LmStudioModelEntry {
  type?: string;
  publisher?: string;
  key?: string;
  display_name?: string;
  architecture?: string | null;
  quantization?: { name?: string | null; bits_per_weight?: number | null } | null;
  size_bytes?: number;
  params_string?: string | null;
  loaded_instances?: Array<{ id?: string; config?: Record<string, unknown> }>;
  max_context_length?: number;
  format?: string | null;
  capabilities?: {
    vision?: boolean;
    trained_for_tool_use?: boolean;
    reasoning?: { allowed_options?: string[]; default?: string };
  };
  description?: string | null;
  variants?: string[];
  selected_variant?: string;
  stats?: Record<string, unknown>;
  performance?: Record<string, unknown>;
}

interface LmStudioDownloadStatus {
  job_id?: string;
  status?: "downloading" | "paused" | "completed" | "failed" | "already_downloaded";
  total_size_bytes?: number;
  downloaded_bytes?: number;
  bytes_per_second?: number;
  estimated_completion?: string;
}

export interface OllamaPullProgress {
  status: string;
  completed?: number;
  total?: number;
  percent?: number;
}

function janSettingsPath(): string {
  return join(homedir(), "Library", "Application Support", "Jan", "settings.json");
}

function runJanCli(args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(JAN_CLI_PATH, args, { timeout: timeoutMs }, (error, stdout) => resolve(error ? null : stdout));
  });
}

export function ollamaNativeBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.pathname = url.pathname.replace(/\/?v1\/?$/, "/");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function ollamaUrl(baseUrl: string, path: string): URL {
  return new URL(path.replace(/^\//, ""), `${ollamaNativeBaseUrl(baseUrl)}/`);
}

function ollamaHeaders(apiKey?: string): Headers {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (apiKey?.trim()) headers.set("Authorization", `Bearer ${apiKey.trim()}`);
  return headers;
}

export function lmStudioNativeBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.pathname = url.pathname.replace(/\/?v1\/?$/, "/");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function lmStudioUrl(baseUrl: string, path: string): URL {
  return new URL(path.replace(/^\//, ""), `${lmStudioNativeBaseUrl(baseUrl)}/`);
}

function lmStudioHeaders(apiKey?: string): Headers {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (apiKey?.trim()) headers.set("Authorization", `Bearer ${apiKey.trim()}`);
  return headers;
}

async function fetchJson<T>(
  fetchImpl: typeof fetch,
  url: string | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<T | null> {
  try {
    const response = await fetchImpl(url, { ...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

async function probeOpenAiModels(baseUrl: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<RemoteModel[] | null> {
  const payload = await fetchJson<{ data?: Array<{ id?: string; owned_by?: string }> }>(
    fetchImpl,
    new URL("models", `${baseUrl}/`),
    {},
    timeoutMs,
  );
  if (!payload) return null;
  return (Array.isArray(payload.data) ? payload.data : [])
    .filter((entry): entry is { id: string; owned_by?: string } => typeof entry?.id === "string" && entry.id.length > 0)
    .map((entry) => ({ id: entry.id, name: entry.id, ...(entry.owned_by ? { ownedBy: entry.owned_by } : {}) }));
}

function inferOllamaCapabilities(show: OllamaShowResponse | null, details: OllamaDetails): ModelCapabilities {
  const advertised = Array.isArray(show?.capabilities) ? show.capabilities.map((value) => value.toLowerCase()) : null;
  const families = [details.family, ...(details.families ?? [])].filter((value): value is string => Boolean(value));
  const family = families.join(" ");
  const inferredTools = /(?:llama3\.[123]|qwen(?:2\.5|3)|mistral|mixtral|command-r|hermes|firefunction)/i.test(family);
  return {
    tools: advertised ? advertised.includes("tools") : inferredTools,
    vision: advertised ? advertised.includes("vision") : /(?:vision|vl|llava|gemma3)/i.test(family),
    reasoning: advertised ? advertised.includes("thinking") : /(?:deepseek-r1|qwen3)/i.test(family),
    json: advertised ? advertised.includes("completion") : true,
  };
}

function contextWindowFrom(show: OllamaShowResponse | null, loaded: OllamaModelEntry | undefined): number | undefined {
  const values = Object.entries(show?.model_info ?? {})
    .filter(([key, value]) => key.endsWith(".context_length") && typeof value === "number" && value > 0)
    .map(([, value]) => value as number);
  return values[0] ?? (typeof loaded?.context_length === "number" && loaded.context_length > 0 ? loaded.context_length : undefined);
}

function toOllamaRemoteModel(entry: OllamaModelEntry, show: OllamaShowResponse | null, loaded: OllamaModelEntry | undefined): RemoteModel | null {
  const id = entry.model ?? entry.name;
  if (!id) return null;
  const details = show?.details ?? entry.details ?? {};
  const contextWindow = contextWindowFrom(show, loaded);
  return {
    id,
    name: entry.name ?? id,
    ...(contextWindow ? { contextWindow } : {}),
    capabilities: inferOllamaCapabilities(show, details),
    ...(details.family ? { family: details.family } : {}),
    ...(details.families ? { families: details.families } : {}),
    ...(details.parameter_size ? { parameterSize: details.parameter_size } : {}),
    ...(details.quantization_level ? { quantization: details.quantization_level } : {}),
    ...(details.format ? { format: details.format } : {}),
    ...(typeof entry.size === "number" ? { sizeBytes: entry.size } : {}),
    ...(typeof loaded?.size_vram === "number" ? { sizeVramBytes: loaded.size_vram } : {}),
    loaded: Boolean(loaded),
    ...(loaded?.expires_at ? { expiresAt: loaded.expires_at } : {}),
    raw: {
      engine: "ollama",
      digest: entry.digest ?? null,
      modifiedAt: show?.modified_at ?? null,
      advertisedCapabilities: show?.capabilities ?? [],
    } as JsonValue,
  };
}

export async function listOllamaModels(options: {
  baseUrl: string;
  apiKey?: string | undefined;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<{ models: RemoteModel[]; version?: string } | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 900;
  const headers = ollamaHeaders(options.apiKey);
  const [tags, ps, version] = await Promise.all([
    fetchJson<{ models?: OllamaModelEntry[] }>(fetchImpl, ollamaUrl(options.baseUrl, "/api/tags"), { headers }, timeoutMs),
    fetchJson<{ models?: OllamaModelEntry[] }>(fetchImpl, ollamaUrl(options.baseUrl, "/api/ps"), { headers }, timeoutMs),
    fetchJson<{ version?: string }>(fetchImpl, ollamaUrl(options.baseUrl, "/api/version"), { headers }, timeoutMs),
  ]);
  if (!tags) return null;
  const entries = Array.isArray(tags.models) ? tags.models : [];
  const loadedEntries = Array.isArray(ps?.models) ? ps.models : [];
  const shows = await Promise.all(
    entries.map((entry) =>
      fetchJson<OllamaShowResponse>(
        fetchImpl,
        ollamaUrl(options.baseUrl, "/api/show"),
        { method: "POST", headers, body: JSON.stringify({ model: entry.model ?? entry.name, verbose: false }) },
        timeoutMs,
      ),
    ),
  );
  const models = entries.flatMap((entry, index) => {
    const loaded = loadedEntries.find(
      (candidate) =>
        (entry.digest && candidate.digest === entry.digest) ||
        (candidate.model ?? candidate.name) === (entry.model ?? entry.name),
    );
    const model = toOllamaRemoteModel(entry, shows[index] ?? null, loaded);
    return model ? [model] : [];
  });
  models.sort((a, b) => a.id.localeCompare(b.id));
  return { models, ...(typeof version?.version === "string" ? { version: version.version } : {}) };
}

export async function listLmStudioModels(options: {
  baseUrl: string;
  apiKey?: string | undefined;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<RemoteModel[] | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 900;
  const payload = await fetchJson<{ models?: LmStudioModelEntry[] }>(
    fetchImpl,
    lmStudioUrl(options.baseUrl, "/api/v1/models"),
    { headers: lmStudioHeaders(options.apiKey) },
    timeoutMs,
  );
  if (!payload) return null;
  const models = (Array.isArray(payload.models) ? payload.models : []).flatMap((entry): RemoteModel[] => {
    if (entry.type !== "llm" || !entry.key) return [];
    const loadedInstances = Array.isArray(entry.loaded_instances) ? entry.loaded_instances : [];
    const loadedInstanceIds = loadedInstances.flatMap((instance) => typeof instance.id === "string" ? [instance.id] : []);
    const model: RemoteModel = {
      id: entry.key,
      name: entry.display_name ?? entry.key,
      ...(entry.publisher ? { ownedBy: entry.publisher } : {}),
      ...(typeof entry.max_context_length === "number" && entry.max_context_length > 0 ? { contextWindow: entry.max_context_length } : {}),
      capabilities: {
        tools: entry.capabilities?.trained_for_tool_use === true,
        vision: entry.capabilities?.vision === true,
        reasoning: Boolean(entry.capabilities?.reasoning),
        json: true,
      },
      ...(entry.architecture ? { family: entry.architecture, families: [entry.architecture] } : {}),
      ...(entry.params_string ? { parameterSize: entry.params_string } : {}),
      ...(entry.quantization?.name ? { quantization: entry.quantization.name } : {}),
      ...(entry.format ? { format: entry.format } : {}),
      ...(typeof entry.size_bytes === "number" ? { sizeBytes: entry.size_bytes } : {}),
      loaded: loadedInstanceIds.length > 0,
      loadedInstanceIds,
      raw: {
        engine: "lm-studio",
        type: entry.type,
        bitsPerWeight: entry.quantization?.bits_per_weight ?? null,
        loadedInstances: loadedInstances as unknown as JsonValue,
        variants: entry.variants ?? [],
        selectedVariant: entry.selected_variant ?? null,
        description: entry.description ?? null,
        reasoning: (entry.capabilities?.reasoning ?? null) as JsonValue,
        performance: (entry.performance ?? entry.stats ?? null) as JsonValue,
      },
    };
    if (entry.capabilities?.vision) model.inputModalities = ["text", "image"];
    return [model];
  });
  models.sort((a, b) => a.id.localeCompare(b.id));
  return models;
}

async function lmStudioRequest<T>(options: {
  baseUrl: string;
  path: string;
  apiKey?: string | undefined;
  body?: Record<string, unknown>;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<T> {
  const response = await (options.fetchImpl ?? fetch)(lmStudioUrl(options.baseUrl, options.path), {
    method: options.body ? "POST" : "GET",
    headers: lmStudioHeaders(options.apiKey),
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) throw new Error(`LM Studio request failed with ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return (await response.json()) as T;
}

export async function loadLmStudioModel(options: {
  baseUrl: string;
  model: string;
  contextLength?: number | undefined;
  apiKey?: string | undefined;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<{ instanceId: string }> {
  const result = await lmStudioRequest<{ instance_id?: string }>({
    ...options,
    path: "/api/v1/models/load",
    body: {
      model: options.model,
      echo_load_config: true,
      ...(options.contextLength ? { context_length: options.contextLength } : {}),
    },
  });
  if (!result.instance_id) throw new Error("LM Studio load response omitted instance_id");
  return { instanceId: result.instance_id };
}

export async function unloadLmStudioModel(options: {
  baseUrl: string;
  instanceId: string;
  apiKey?: string | undefined;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<{ instanceId: string }> {
  const result = await lmStudioRequest<{ instance_id?: string }>({
    ...options,
    path: "/api/v1/models/unload",
    body: { instance_id: options.instanceId },
  });
  if (!result.instance_id) throw new Error("LM Studio unload response omitted instance_id");
  return { instanceId: result.instance_id };
}

export async function downloadLmStudioModel(options: {
  baseUrl: string;
  model: string;
  quantization?: string | undefined;
  apiKey?: string | undefined;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  onProgress?: (progress: OllamaPullProgress) => void;
}): Promise<void> {
  let status = await lmStudioRequest<LmStudioDownloadStatus>({
    ...options,
    path: "/api/v1/models/download",
    body: { model: options.model, ...(options.quantization ? { quantization: options.quantization } : {}) },
  });
  while (true) {
    if (status.status === "failed") throw new Error("LM Studio model download failed");
    const completed = status.downloaded_bytes;
    const total = status.total_size_bytes;
    options.onProgress?.({
      status: status.status ?? "downloading",
      ...(typeof completed === "number" ? { completed } : {}),
      ...(typeof total === "number" ? { total } : {}),
      ...(typeof completed === "number" && typeof total === "number" && total > 0
        ? { percent: Math.min(100, Math.max(0, (completed / total) * 100)) }
        : {}),
    });
    if (status.status === "completed" || status.status === "already_downloaded") return;
    if (!status.job_id) throw new Error("LM Studio download response omitted job_id");
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      };
      const timer = setTimeout(() => {
        options.signal?.removeEventListener("abort", onAbort);
        resolve();
      }, options.pollIntervalMs ?? 500);
      if (options.signal?.aborted) onAbort();
      else options.signal?.addEventListener("abort", onAbort, { once: true });
    });
    status = await lmStudioRequest<LmStudioDownloadStatus>({
      ...options,
      path: `/api/v1/models/download/status/${encodeURIComponent(status.job_id)}`,
    });
  }
}

export async function pullOllamaModel(options: {
  baseUrl: string;
  model: string;
  apiKey?: string | undefined;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  onProgress?: (progress: OllamaPullProgress) => void;
}): Promise<void> {
  const response = await (options.fetchImpl ?? fetch)(ollamaUrl(options.baseUrl, "/api/pull"), {
    method: "POST",
    headers: ollamaHeaders(options.apiKey),
    body: JSON.stringify({ model: options.model, stream: true }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) throw new Error(`Ollama pull failed with ${response.status}: ${(await response.text()).slice(0, 300)}`);
  if (!response.body) throw new Error("Ollama pull returned no progress stream");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const consume = (line: string) => {
    if (!line.trim()) return;
    const payload = JSON.parse(line) as { status?: string; completed?: number; total?: number; error?: string };
    if (payload.error) throw new Error(payload.error);
    const progress: OllamaPullProgress = { status: payload.status ?? "pulling" };
    if (typeof payload.completed === "number") progress.completed = payload.completed;
    if (typeof payload.total === "number") progress.total = payload.total;
    if (progress.completed !== undefined && progress.total && progress.total > 0) {
      progress.percent = Math.min(100, Math.max(0, (progress.completed / progress.total) * 100));
    }
    options.onProgress?.(progress);
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      consume(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
    if (done) break;
  }
  consume(buffer);
}

async function discoverJan(fetchImpl: typeof fetch, timeoutMs: number): Promise<DiscoveredLocalProvider | null> {
  const installed = existsSync(JAN_CLI_PATH) || existsSync(janSettingsPath());
  if (!installed) return null;
  const live = await probeOpenAiModels(JAN_BASE_URL, fetchImpl, timeoutMs);
  let models: RemoteModel[] = live ?? [];
  if (!live && existsSync(JAN_CLI_PATH)) {
    const output = await runJanCli(["models", "list"], 5000);
    if (output) {
      try {
        const parsed = JSON.parse(output) as Array<{ id?: string; name?: string }>;
        if (Array.isArray(parsed)) {
          models = parsed
            .filter((entry): entry is { id: string; name?: string } => typeof entry?.id === "string" && entry.id.length > 0)
            .map((entry) => ({ id: entry.id, name: entry.name ?? entry.id }));
        }
      } catch {
        // Non-JSON CLI output leaves the model list empty.
      }
    }
  }
  const result: DiscoveredLocalProvider = {
    presetId: "jan-llamacpp",
    kind: "local",
    name: "Jan llama.cpp",
    baseUrl: JAN_BASE_URL,
    apiType: "openai-chat-completions",
    authType: "none",
    running: live !== null,
    models,
    nativeApi: false,
  };
  const first = models[0];
  if (!result.running && first) result.helpCommand = `jan-cli serve ${first.id} --port 6767`;
  return result;
}

async function discoverOllama(fetchImpl: typeof fetch, timeoutMs: number): Promise<DiscoveredLocalProvider | null> {
  const discovery = await listOllamaModels({ baseUrl: OLLAMA_BASE_URL, fetchImpl, timeoutMs });
  const compatibilityModels = discovery ? null : await probeOpenAiModels(OLLAMA_BASE_URL, fetchImpl, timeoutMs);
  if (!discovery && compatibilityModels === null) return null;
  return {
    presetId: "ollama",
    kind: "ollama",
    name: "Ollama",
    baseUrl: OLLAMA_BASE_URL,
    apiType: "openai-chat-completions",
    authType: "none",
    running: true,
    models: discovery?.models ?? compatibilityModels ?? [],
    ...(discovery?.version ? { version: discovery.version } : {}),
    nativeApi: Boolean(discovery),
  };
}

async function discoverLmStudio(fetchImpl: typeof fetch, timeoutMs: number): Promise<DiscoveredLocalProvider | null> {
  const nativeModels = await listLmStudioModels({ baseUrl: LM_STUDIO_BASE_URL, fetchImpl, timeoutMs });
  const compatibilityModels = nativeModels ? null : await probeOpenAiModels(LM_STUDIO_BASE_URL, fetchImpl, timeoutMs);
  if (!nativeModels && compatibilityModels === null) return null;
  return {
    presetId: "lm-studio",
    kind: "lm-studio",
    name: "LM Studio",
    baseUrl: LM_STUDIO_BASE_URL,
    apiType: "openai-chat-completions",
    authType: "optional-bearer",
    running: true,
    models: nativeModels ?? compatibilityModels ?? [],
    nativeApi: Boolean(nativeModels),
  };
}

export async function discoverLocalProviders(
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<DiscoveredLocalProvider[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 900;
  const results = await Promise.all([
    discoverJan(fetchImpl, timeoutMs),
    discoverOllama(fetchImpl, timeoutMs),
    discoverLmStudio(fetchImpl, timeoutMs),
  ]);
  return results.filter((result): result is DiscoveredLocalProvider => result !== null);
}
