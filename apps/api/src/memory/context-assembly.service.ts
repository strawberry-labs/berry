import { Inject, Injectable } from "@nestjs/common";
import { GroundingContextSchema, SessionCheckpointV2Schema, type GroundingContext, type SessionCheckpointV2 } from "@berry/shared";
import { CloudDatabaseService } from "../db/cloud-database.service.js";
import { KnowledgeService } from "../knowledge/knowledge.service.js";
import { MemoryService } from "./memory.service.js";

@Injectable()
export class ContextAssemblyService {
  constructor(
    @Inject(MemoryService) private readonly memory: MemoryService,
    @Inject(KnowledgeService) private readonly knowledge: KnowledgeService,
    @Inject(CloudDatabaseService) private readonly database: CloudDatabaseService,
  ) {}

  async portableCheckpoint(tenantId: string, sessionId: string): Promise<SessionCheckpointV2 | undefined> {
    return this.database.withTenant(tenantId, async (executor) => {
      const [row] = await executor.query<{ checkpoint: unknown }>(`
        SELECT checkpoint
        FROM session_checkpoints
        WHERE tenant_id = $1::uuid AND session_id = $2::uuid
          AND kind = 'rolling' AND validation_status = 'valid'
        ORDER BY created_at DESC
        LIMIT 1
      `, [tenantId, sessionId]);
      const parsed = SessionCheckpointV2Schema.safeParse(row?.checkpoint);
      return parsed.success ? parsed.data : undefined;
    });
  }

  async assemble(input: {
    tenantId: string;
    userId: string;
    workspaceId: string;
    taskId: string;
    sessionId: string;
    runId?: string;
    request: string;
    taskTitle?: string;
    checkpointGoal?: string;
    constraints?: string[];
    openItems?: string[];
  }): Promise<GroundingContext> {
    const query = [
      input.request,
      input.taskTitle,
      input.checkpointGoal,
      ...(input.constraints ?? []),
      ...(input.openItems ?? []),
    ].filter((value): value is string => Boolean(value?.trim())).join("\n");
    const [memory, knowledge] = await Promise.all([
      this.memory.recall({
        tenantId: input.tenantId,
        userId: input.userId,
        workspaceId: input.workspaceId,
        query,
      }),
      this.knowledge.retrieve(input),
    ]);
    const projectMemoryFacts = memory.project.map((item) => ({
      sourceId: item.id,
      chunkId: item.id,
      content: item.content,
      citationLabel: memoryLabel(item),
    }));
    const projectMemoryCitations = memory.project.map((item) => ({
      sourceId: item.id,
      chunkId: item.id,
      label: memoryLabel(item),
      href: `/v1/memory/${item.id}`,
    }));
    return GroundingContextSchema.parse({
      personalMemory: memory.personal.map((item) => ({
        memoryId: item.id,
        content: item.content,
        label: memoryLabel(item),
        explicit: item.explicit,
        confidence: item.confidence,
        sourceTaskId: item.sourceTaskId,
        sourceMessageId: item.sourceMessageId,
      })),
      projectFacts: [...projectMemoryFacts, ...knowledge.projectFacts],
      citations: [...projectMemoryCitations, ...knowledge.citations],
      retrieval: {
        ...knowledge.retrieval,
        degradedReason: memory.personalDegraded && knowledge.retrieval.degradedReason === "none"
          ? "personal_memory_unavailable"
          : knowledge.retrieval.degradedReason,
        tokenBudget: knowledge.retrieval.tokenBudget + 1_800,
        tokensSelected: knowledge.retrieval.tokensSelected + memory.personalTokens + memory.projectTokens,
      },
    });
  }
}

function memoryLabel(item: {
  kind: string;
  explicit: boolean;
  sourceTaskId: string | null;
  updatedAt: string;
}): string {
  const source = item.sourceTaskId ? `task ${item.sourceTaskId}` : item.explicit ? "explicit memory" : "learned memory";
  return `${item.kind.replaceAll("_", " ")} — ${source}, ${item.updatedAt.slice(0, 10)}`;
}
