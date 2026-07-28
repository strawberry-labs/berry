import type { PersonalMemoryProvider } from "@berry/personal-memory";
import { sanitizePersonalMemorySource } from "@berry/shared";
import type { MemoryExtractJobPayload } from "../jobs.js";
import type { MemoryOperationGenerator } from "./generator.js";
import { SqlWorkerMemoryRepository } from "./repository.js";

export class MemoryProcessor {
  constructor(
    private readonly repository: SqlWorkerMemoryRepository,
    private readonly generator: MemoryOperationGenerator | null,
    private readonly personalMemory: PersonalMemoryProvider | null = null,
  ) {}

  async process(payload: MemoryExtractJobPayload): Promise<{ applied: number; noops: number; degraded?: boolean }> {
    if (!this.generator && !this.personalMemory) return { applied: 0, noops: 0, degraded: true };
    const [operations, personal] = await Promise.all([
      this.generator
        ? this.generator.generate(payload, this.personalMemory ? ["project"] : ["personal", "project"])
        : Promise.resolve([]),
      this.personalMemory ? this.ingestPersonal(payload) : Promise.resolve({ applied: 0, noops: 0 }),
    ]);
    const berryOperations = this.personalMemory
      ? operations.filter((operation) => operation.scope === "project")
      : operations;
    const project = berryOperations.length > 0
      ? await this.repository.apply(payload, berryOperations)
      : { applied: 0, noops: 0 };
    return {
      applied: personal.applied + project.applied,
      noops: personal.noops + project.noops,
      ...(!this.generator ? { degraded: true } : {}),
    };
  }

  private async ingestPersonal(payload: MemoryExtractJobPayload): Promise<{ applied: number; noops: number }> {
    const userText = sanitizePersonalMemorySource(payload.userText);
    const assistantText = sanitizePersonalMemorySource(payload.assistantText);
    if (!userText) return { applied: 0, noops: 1 };
    const result = await this.personalMemory!.ingestConversation({
      tenantId: payload.tenantId,
      userId: payload.userId,
      messages: [
        { role: "user", content: userText },
        ...(assistantText ? [{ role: "assistant" as const, content: assistantText }] : []),
      ],
      source: {
        actorUserId: null,
        taskId: payload.taskId,
        sessionId: payload.sessionId,
        messageId: payload.userMessageId,
        extractorVersion: `mem0-oss:${payload.extractorVersion}`,
      },
      idempotencyKey: [
        payload.tenantId,
        payload.userId,
        payload.userMessageId,
        payload.assistantMessageId,
        payload.revision,
        payload.extractorVersion,
      ].join(":"),
    });
    return {
      applied: result.replayed ? 0 : result.items.length,
      noops: result.replayed || result.items.length === 0 ? 1 : 0,
    };
  }
}
