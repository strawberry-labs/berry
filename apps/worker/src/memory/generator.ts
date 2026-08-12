import { MemoryOperationSchema, type JsonValue, type MemoryOperation, type MemoryScope } from "@berry/shared";
import { OpenAIChatCompletionsClient } from "@berry/router-client";
import { z } from "zod";
import type { MemoryExtractJobPayload } from "../jobs.js";
import { classifyProviderFailure } from "../provider-retry.js";
import { workerRuntimeMetrics, type WorkerRuntimeMetrics } from "../runtime-metrics.js";

export const ExtractedMemoryOperationSchema = MemoryOperationSchema.extend({
  scope: z.enum(["personal", "project"]),
});
export type ExtractedMemoryOperation = MemoryOperation & { scope: MemoryScope };
const EnvelopeSchema = z.object({
  operations: z.array(ExtractedMemoryOperationSchema).max(20),
}).strict();

export interface MemoryOperationGenerator {
  generate(
    input: MemoryExtractJobPayload,
    scopes?: readonly MemoryScope[],
  ): Promise<readonly ExtractedMemoryOperation[]>;
}

export const DEFAULT_MEMORY_MODEL = "canopywave/moonshotai/kimi-k2.6";

export class RouterMemoryOperationGenerator implements MemoryOperationGenerator {
  constructor(
    private readonly client: OpenAIChatCompletionsClient,
    private readonly model: string,
    private readonly metrics: Pick<WorkerRuntimeMetrics, "providerRequest"> = workerRuntimeMetrics,
    private readonly now: () => number = Date.now,
  ) {}

  async generate(
    input: MemoryExtractJobPayload,
    scopes: readonly MemoryScope[] = ["personal", "project"],
  ): Promise<readonly ExtractedMemoryOperation[]> {
    const allowedScopes = new Set(scopes);
    const messages = [
      {
        role: "system" as const,
        content: [
          `Extract only durable memory candidates for these scopes: ${scopes.join(", ")}.`,
          ...(allowedScopes.has("personal")
            ? ["Eligible personal facts are preferences, stable profile facts, recurring working conventions, durable relationships, accessibility needs, and communication style."]
            : []),
          ...(allowedScopes.has("project")
            ? ["Eligible project facts are explicit reusable project decisions or conventions."]
            : []),
          "Reject credentials, secrets, copied documents, temporary task details, hidden reasoning, and anything known only from assistant speculation.",
          "Return ADD candidates; consolidation decides whether they become ADD, REFRESH, SUPERSEDE, or NOOP.",
        ].join("\n"),
      },
      {
        role: "user" as const,
        content: [
          `USER MESSAGE (${input.userMessageId}):`,
          input.userText,
          "",
          `ASSISTANT FINAL (${input.assistantMessageId}):`,
          input.assistantText,
        ].join("\n"),
      },
    ];
    const first = await this.complete(messages);
    const parsed = parseEnvelope(first);
    if (parsed.success) return parsed.data.operations.filter((operation) => allowedScopes.has(operation.scope));
    const repaired = await this.complete([
      ...messages,
      {
        role: "user" as const,
        content: `The previous structured output failed validation: ${parsed.error.issues.map((issue) => issue.message).join("; ")}. Return one corrected memory_operations tool call only.`,
      },
    ]);
    const repairedParsed = parseEnvelope(repaired);
    return repairedParsed.success
      ? repairedParsed.data.operations.filter((operation) => allowedScopes.has(operation.scope))
      : [];
  }

  private async complete(messages: Array<{ role: "system" | "user"; content: string }>) {
    const startedAt = this.now();
    try {
      const result = await this.client.complete({
        model: this.model,
        messages,
        temperature: 0,
        maxTokens: 2_000,
        tools: [{
          type: "function",
          function: {
            name: "memory_operations",
            description: "Return validated durable memory candidates.",
            parameters: MEMORY_OPERATIONS_JSON_SCHEMA,
          },
        }],
        toolChoice: { type: "function", function: { name: "memory_operations" } },
      });
      this.metrics.providerRequest({
        model: result.model || this.model,
        outcome: "success",
        status: 200,
        latencyMs: Math.max(0, this.now() - startedAt),
      });
      const call = result.toolCalls?.find((candidate) => candidate.function.name === "memory_operations");
      return call?.function.arguments ?? result.content;
    } catch (error) {
      const failure = classifyProviderFailure(error);
      const diagnostics = {
        event: "berry.memory.provider_failure",
        jobName: "memory.extract",
        model: this.model,
        outcome: "failure",
        status: failure.status ?? null,
        code: failure.code ?? null,
        requestId: failure.requestId ?? null,
        latencyMs: Math.max(0, this.now() - startedAt),
      };
      this.metrics.providerRequest(diagnostics);
      console.warn(JSON.stringify(diagnostics));
      throw error;
    }
  }
}

export function createMemoryOperationGenerator(env: NodeJS.ProcessEnv): MemoryOperationGenerator | null {
  const baseUrl = env.BERRY_ROUTER_INFERENCE_BASE_URL?.trim();
  const apiKey = env.BERRY_ROUTER_API_KEY?.trim();
  const model = env.BERRY_MEMORY_MODEL?.trim() || DEFAULT_MEMORY_MODEL;
  if (!baseUrl || !apiKey) return null;
  const client = new OpenAIChatCompletionsClient({
    provider: {
      baseUrl,
      defaultModel: model,
      kind: "openai-compatible",
      name: "Berry Router memory extractor",
      apiType: "openai-chat-completions",
    },
    apiKey,
  });
  return new RouterMemoryOperationGenerator(client, model);
}

function parseEnvelope(value: string) {
  try {
    return EnvelopeSchema.safeParse(JSON.parse(stripCodeFence(value)));
  } catch (error) {
    return EnvelopeSchema.safeParse({ invalid: error instanceof Error ? error.message : String(error) });
  }
}

function stripCodeFence(value: string): string {
  return value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}

const MEMORY_OPERATIONS_JSON_SCHEMA: JsonValue = {
  type: "object",
  additionalProperties: false,
  required: ["operations"],
  properties: {
    operations: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["scope", "operation", "stableKey", "kind", "content", "value", "confidence", "salience", "explicit", "targetItemId", "expiresAt", "reason"],
        properties: {
          scope: { type: "string", enum: ["personal", "project"] },
          operation: { type: "string", enum: ["ADD", "SUPERSEDE", "REFRESH", "NOOP"] },
          stableKey: { type: "string", minLength: 1, maxLength: 240 },
          kind: { type: "string", minLength: 1, maxLength: 80 },
          content: { type: "string", maxLength: 20_000 },
          value: { type: "object", additionalProperties: true },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          salience: { type: "number", minimum: 0, maximum: 1 },
          explicit: { type: "boolean", const: false },
          targetItemId: { type: ["string", "null"] },
          expiresAt: { type: ["string", "null"] },
          reason: { type: "string", maxLength: 2_000 },
        },
      },
    },
  },
};
