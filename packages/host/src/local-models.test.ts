import { describe, expect, it } from "vitest";
import {
  discoverLocalProviders,
  downloadLmStudioModel,
  listLmStudioModels,
  listOllamaModels,
  loadLmStudioModel,
  lmStudioNativeBaseUrl,
  ollamaNativeBaseUrl,
  pullOllamaModel,
  unloadLmStudioModel,
} from "./local-models.ts";

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

describe("Ollama native model API", () => {
  it("combines tags, show, ps, and version metadata", async () => {
    const requests: Array<{ path: string; body: unknown }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requests.push({ path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.pathname === "/api/version") return json({ version: "0.13.5" });
      if (url.pathname === "/api/tags") {
        return json({
          models: [
            {
              name: "qwen3:8b",
              model: "qwen3:8b",
              digest: "sha256:qwen",
              size: 5_200_000_000,
              details: { format: "gguf", family: "qwen3", families: ["qwen3"], parameter_size: "8.2B", quantization_level: "Q4_K_M" },
            },
          ],
        });
      }
      if (url.pathname === "/api/ps") {
        return json({ models: [{ model: "qwen3:8b", digest: "sha256:qwen", size_vram: 4_900_000_000, context_length: 8192, expires_at: "2026-07-09T12:00:00.000Z" }] });
      }
      if (url.pathname === "/api/show") {
        return json({
          capabilities: ["completion", "tools", "thinking"],
          details: { format: "gguf", family: "qwen3", families: ["qwen3"], parameter_size: "8.2B", quantization_level: "Q4_K_M" },
          model_info: { "qwen3.context_length": 131072 },
        });
      }
      return new Response("not found", { status: 404 });
    };

    const result = await listOllamaModels({ baseUrl: "http://localhost:11434/v1", fetchImpl });
    expect(result?.version).toBe("0.13.5");
    expect(result?.models).toEqual([
      expect.objectContaining({
        id: "qwen3:8b",
        family: "qwen3",
        parameterSize: "8.2B",
        quantization: "Q4_K_M",
        contextWindow: 131072,
        loaded: true,
        sizeVramBytes: 4_900_000_000,
        capabilities: { tools: true, vision: false, reasoning: true, json: true },
      }),
    ]);
    expect(requests.find((request) => request.path === "/api/show")?.body).toEqual({ model: "qwen3:8b", verbose: false });
    expect(requests.map((request) => request.path)).toEqual(expect.arrayContaining(["/api/tags", "/api/ps", "/api/version", "/api/show"]));
  });

  it("parses streamed pull progress and preserves remote host paths", async () => {
    const progress: Array<{ status: string; percent?: number }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      expect(new URL(input instanceof Request ? input.url : String(input)).toString()).toBe("https://models.example.test/ollama/api/pull");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
      return new Response(
        ['{"status":"pulling manifest"}', '{"status":"downloading","completed":25,"total":100}', '{"status":"success","completed":100,"total":100}', ""].join("\n"),
        { status: 200, headers: { "content-type": "application/x-ndjson" } },
      );
    };
    await pullOllamaModel({
      baseUrl: "https://models.example.test/ollama/v1",
      model: "qwen3:8b",
      apiKey: "secret",
      fetchImpl,
      onProgress: (event) => progress.push(event),
    });
    expect(ollamaNativeBaseUrl("https://models.example.test/ollama/v1")).toBe("https://models.example.test/ollama");
    expect(progress).toEqual([
      { status: "pulling manifest" },
      { status: "downloading", completed: 25, total: 100, percent: 25 },
      { status: "success", completed: 100, total: 100, percent: 100 },
    ]);
  });

  it("degrades discovery to the OpenAI-compatible catalog when native endpoints are unavailable", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.port === "11434" && url.pathname === "/v1/models") {
        return json({ data: [{ id: "legacy-model", owned_by: "library" }] });
      }
      if (url.port === "1234" && url.pathname === "/v1/models") {
        return json({ data: [{ id: "lm-compat-model", owned_by: "lmstudio-community" }] });
      }
      return new Response("not found", { status: 404 });
    };
    const found = await discoverLocalProviders({ fetchImpl, timeoutMs: 50 });
    expect(found.find((provider) => provider.presetId === "ollama")).toMatchObject({
      kind: "ollama",
      nativeApi: false,
      models: [{ id: "legacy-model", ownedBy: "library" }],
    });
    expect(found.find((provider) => provider.presetId === "lm-studio")).toMatchObject({
      kind: "lm-studio",
      nativeApi: false,
      models: [{ id: "lm-compat-model", ownedBy: "lmstudio-community" }],
    });
  });
});

describe("LM Studio native model API", () => {
  it("normalizes v1 catalog metadata and loaded instances", async () => {
    const fetchImpl: typeof fetch = async (input, init) => {
      expect(new URL(input instanceof Request ? input.url : String(input)).pathname).toBe("/api/v1/models");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer lm-token");
      return json({
        models: [
          {
            type: "llm",
            publisher: "google",
            key: "google/gemma-4-26b",
            display_name: "Gemma 4 26B",
            architecture: "gemma4",
            quantization: { name: "Q4_K_M", bits_per_weight: 4 },
            size_bytes: 17_990_911_801,
            params_string: "26B",
            loaded_instances: [{ id: "gemma-loaded", config: { context_length: 4096, parallel: 4 } }],
            max_context_length: 262144,
            format: "gguf",
            capabilities: { vision: true, trained_for_tool_use: true, reasoning: { allowed_options: ["off", "on"], default: "on" } },
            variants: ["google/gemma-4-26b@q4_k_m"],
            selected_variant: "google/gemma-4-26b@q4_k_m",
          },
          { type: "embedding", key: "embed-only", loaded_instances: [], max_context_length: 2048 },
        ],
      });
    };
    expect(await listLmStudioModels({ baseUrl: "http://localhost:1234/v1", apiKey: "lm-token", fetchImpl })).toEqual([
      expect.objectContaining({
        id: "google/gemma-4-26b",
        name: "Gemma 4 26B",
        family: "gemma4",
        quantization: "Q4_K_M",
        parameterSize: "26B",
        contextWindow: 262144,
        loaded: true,
        loadedInstanceIds: ["gemma-loaded"],
        capabilities: { tools: true, vision: true, reasoning: true, json: true },
      }),
    ]);
    expect(lmStudioNativeBaseUrl("http://localhost:1234/v1")).toBe("http://localhost:1234");
  });

  it("loads, unloads, and polls a model download job", async () => {
    const requests: Array<{ path: string; body: unknown }> = [];
    let statusCalls = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ path, body });
      if (path.endsWith("/load")) return json({ status: "loaded", instance_id: "instance-1" });
      if (path.endsWith("/unload")) return json({ instance_id: "instance-1" });
      if (path.endsWith("/download")) return json({ job_id: "job-1", status: "downloading", downloaded_bytes: 10, total_size_bytes: 100 });
      if (path.endsWith("/status/job-1")) {
        statusCalls += 1;
        return json({ job_id: "job-1", status: "completed", downloaded_bytes: 100, total_size_bytes: 100 });
      }
      return new Response("not found", { status: 404 });
    };
    expect(await loadLmStudioModel({ baseUrl: "http://localhost:1234/v1", model: "google/gemma", contextLength: 16384, fetchImpl })).toEqual({ instanceId: "instance-1" });
    expect(await unloadLmStudioModel({ baseUrl: "http://localhost:1234/v1", instanceId: "instance-1", fetchImpl })).toEqual({ instanceId: "instance-1" });
    const progress: number[] = [];
    await downloadLmStudioModel({
      baseUrl: "http://localhost:1234/v1",
      model: "google/gemma",
      quantization: "Q4_K_M",
      fetchImpl,
      pollIntervalMs: 0,
      onProgress: (event) => progress.push(event.percent ?? 0),
    });
    expect(statusCalls).toBe(1);
    expect(progress).toEqual([10, 100]);
    expect(requests).toEqual(expect.arrayContaining([
      { path: "/api/v1/models/load", body: { model: "google/gemma", echo_load_config: true, context_length: 16384 } },
      { path: "/api/v1/models/unload", body: { instance_id: "instance-1" } },
      { path: "/api/v1/models/download", body: { model: "google/gemma", quantization: "Q4_K_M" } },
      { path: "/api/v1/models/download/status/job-1", body: null },
    ]));
  });
});
