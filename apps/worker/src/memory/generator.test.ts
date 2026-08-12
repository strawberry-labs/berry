import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAIChatCompletionsClient, RouterClientError } from "@berry/router-client";
import type { MemoryExtractJobPayload } from "../jobs.js";
import { WorkerRuntimeMetrics } from "../runtime-metrics.js";
import {
  createMemoryOperationGenerator,
  DEFAULT_MEMORY_MODEL,
  RouterMemoryOperationGenerator,
} from "./generator.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("memory operation generator model selection", () => {
  it("uses the tool-capable Kimi default instead of the router default", async () => {
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", completionFetch(requests));
    const generator = createMemoryOperationGenerator({
      BERRY_ROUTER_INFERENCE_BASE_URL: "https://router.example/v1",
      BERRY_ROUTER_API_KEY: "router-key",
      BERRY_ROUTER_DEFAULT_MODEL: "canopywave/deepseek/deepseek-v4-flash",
    });

    await expect(generator?.generate(payload())).resolves.toEqual([]);
    expect(requests[0]?.model).toBe(DEFAULT_MEMORY_MODEL);
    expect(requests[0]?.model).not.toBe("canopywave/deepseek/deepseek-v4-flash");
  });

  it("honors an explicit memory model override", async () => {
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", completionFetch(requests));
    const generator = createMemoryOperationGenerator({
      BERRY_ROUTER_INFERENCE_BASE_URL: "https://router.example/v1",
      BERRY_ROUTER_API_KEY: "router-key",
      BERRY_MEMORY_MODEL: "verified/tool-model",
      BERRY_ROUTER_DEFAULT_MODEL: "general/default-model",
    });

    await expect(generator?.generate(payload())).resolves.toEqual([]);
    expect(requests[0]?.model).toBe("verified/tool-model");
  });

  it("stays disabled when router connectivity is not configured", () => {
    expect(createMemoryOperationGenerator({ BERRY_ROUTER_API_KEY: "router-key" })).toBeNull();
    expect(createMemoryOperationGenerator({ BERRY_ROUTER_INFERENCE_BASE_URL: "https://router.example/v1" })).toBeNull();
  });

  it("records the model, success status, and latency for implicit extraction calls", async () => {
    const metrics = new WorkerRuntimeMetrics();
    const clock = sequenceClock(1_000, 1_125);
    const client = {
      complete: vi.fn(async () => ({
        id: "memory-success",
        model: "served-memory-model",
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "memory-operations",
          type: "function" as const,
          function: { name: "memory_operations", arguments: JSON.stringify({ operations: [] }) },
        }],
        raw: {},
      })),
    } as unknown as OpenAIChatCompletionsClient;
    const generator = new RouterMemoryOperationGenerator(client, "requested-memory-model", metrics, clock);

    await expect(generator.generate(payload())).resolves.toEqual([]);
    expect(metrics.render()).toContain(
      'berry_worker_provider_requests_total{model="served-memory-model",outcome="success",status="200"} 1',
    );
    expect(metrics.render()).toContain(
      'berry_worker_provider_request_duration_seconds_sum{model="served-memory-model",outcome="success",status="200"} 0.125',
    );
  });

  it("records one observable 400 failure for the implicit extractor", async () => {
    const metrics = new WorkerRuntimeMetrics();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failure = new RouterClientError("tool_choice is unsupported", 400, "sensitive body", {
      code: "unsupported_tool_choice",
      requestId: "memory-request-400",
    });
    const client = {
      complete: vi.fn(async () => { throw failure; }),
    } as unknown as OpenAIChatCompletionsClient;
    const generator = new RouterMemoryOperationGenerator(
      client,
      "memory-model",
      metrics,
      sequenceClock(2_000, 2_250),
    );

    await expect(generator.generate(payload())).rejects.toBe(failure);
    expect(metrics.render()).toContain(
      'berry_worker_provider_requests_total{model="memory-model",outcome="failure",status="400"} 1',
    );
    expect(warning).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warning.mock.calls[0]?.[0]))).toMatchObject({
      event: "berry.memory.provider_failure",
      jobName: "memory.extract",
      model: "memory-model",
      status: 400,
      code: "UNSUPPORTED_TOOL_CHOICE",
      requestId: "memory-request-400",
      latencyMs: 250,
    });
  });
});

function sequenceClock(...values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}

function completionFetch(requests: Array<Record<string, unknown>>): typeof fetch {
  return vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({
      id: "memory-completion",
      model: DEFAULT_MEMORY_MODEL,
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: "memory-operations",
            type: "function",
            function: { name: "memory_operations", arguments: JSON.stringify({ operations: [] }) },
          }],
        },
        finish_reason: "tool_calls",
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

function payload(): MemoryExtractJobPayload {
  return {
    tenantId: "00000000-0000-7000-8000-000000000001",
    userId: "00000000-0000-7000-8000-000000000002",
    workspaceId: "00000000-0000-7000-8000-000000000003",
    taskId: "00000000-0000-7000-8000-000000000004",
    sessionId: "00000000-0000-7000-8000-000000000005",
    userMessageId: "00000000-0000-7000-8000-000000000006",
    assistantMessageId: "00000000-0000-7000-8000-000000000007",
    revision: "rev-1",
    extractorVersion: "memory-extractor-v1",
    userText: "Remember that I prefer short answers.",
    assistantText: "Understood.",
  };
}
