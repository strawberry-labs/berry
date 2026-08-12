import { Inject, Injectable } from "@nestjs/common";
import { GroundingContextSchema, SessionCheckpointV2Schema, type GroundingContext, type SessionCheckpointV2 } from "@berry/shared";
import { createHash } from "node:crypto";
import { CloudDatabaseService } from "../db/cloud-database.service.js";
import { KnowledgeService } from "../knowledge/knowledge.service.js";
import { MemoryService } from "./memory.service.js";

export const DEFAULT_CONTEXT_ASSEMBLY_TIMEOUT_MS = 1_500;

export type ContextAssemblyInput = {
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
};

export type ContextAssemblyOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
};

type AssemblyOutcome =
  | { kind: "assembled"; context: GroundingContext }
  | { kind: "failed" }
  | { kind: "timeout" }
  | { kind: "aborted"; error: Error };

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
          AND kind = 'rolling'
          AND split_part(validation_status, ':', 1) IN ('valid','repaired','fallback')
        ORDER BY created_at DESC
        LIMIT 1
      `, [tenantId, sessionId]);
      const parsed = SessionCheckpointV2Schema.safeParse(row?.checkpoint);
      return parsed.success ? parsed.data : undefined;
    });
  }

  async assemble(
    input: ContextAssemblyInput,
    options: ContextAssemblyOptions = {},
  ): Promise<GroundingContext> {
    const startedAt = Date.now();
    if (options.signal?.aborted) throw contextAbortError(options.signal);
    const timeoutMs = normalizedTimeoutMs(options.timeoutMs);
    const controller = new AbortController();
    let timedOut = false;
    let externallyAborted = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let onExternalAbort: (() => void) | null = null;

    const work: Promise<AssemblyOutcome> = this.assembleWithSignal(input, controller.signal).then(
      (context) => ({ kind: "assembled", context }),
      () => ({ kind: "failed" }),
    );
    const deadline = new Promise<AssemblyOutcome>((resolve) => {
      timeout = setTimeout(() => {
        timedOut = true;
        controller.abort(new DOMException("Context assembly exceeded its deadline", "TimeoutError"));
        resolve({ kind: "timeout" });
      }, timeoutMs);
      timeout.unref?.();
    });
    const candidates: Promise<AssemblyOutcome>[] = [work, deadline];
    if (options.signal) {
      candidates.push(new Promise<AssemblyOutcome>((resolve) => {
        onExternalAbort = () => {
          externallyAborted = true;
          const error = contextAbortError(options.signal!);
          if (!controller.signal.aborted) controller.abort(error);
          resolve({ kind: "aborted", error });
        };
        if (options.signal!.aborted) onExternalAbort();
        else options.signal!.addEventListener("abort", onExternalAbort, { once: true });
      }));
    }

    let outcome: AssemblyOutcome;
    try {
      outcome = await Promise.race(candidates);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (options.signal && onExternalAbort) {
        options.signal.removeEventListener("abort", onExternalAbort);
      }
    }
    if (outcome.kind === "aborted") {
      logContextAssembly("aborted", startedAt);
      throw outcome.error;
    }
    if (externallyAborted && options.signal) {
      logContextAssembly("aborted", startedAt);
      throw contextAbortError(options.signal);
    }
    if (timedOut) {
      logContextAssembly("context_timeout", startedAt);
      return unavailableGroundingContext(input, "context_timeout");
    }
    if (outcome.kind === "assembled") {
      logContextAssembly(outcome.context.retrieval.degradedReason, startedAt);
      return outcome.context;
    }
    logContextAssembly(outcome.kind === "timeout" ? "context_timeout" : "context_unavailable", startedAt);
    return unavailableGroundingContext(input, outcome.kind === "timeout"
      ? "context_timeout"
      : "context_unavailable");
  }

  private async assembleWithSignal(
    input: ContextAssemblyInput,
    signal: AbortSignal,
  ): Promise<GroundingContext> {
    const query = contextQuery(input);
    const [memory, knowledge] = await Promise.all([
      this.memory.recall({
        tenantId: input.tenantId,
        userId: input.userId,
        workspaceId: input.workspaceId,
        query,
        signal,
      }),
      this.knowledge.retrieve({ ...input, signal }),
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

function logContextAssembly(outcome: string, startedAt: number): void {
  console.info(JSON.stringify({
    event: "berry.context_assembly",
    outcome: outcome.slice(0, 128),
    durationMs: Math.max(0, Date.now() - startedAt),
  }));
}

function contextQuery(input: ContextAssemblyInput): string {
  return [
    input.request,
    input.taskTitle,
    input.checkpointGoal,
    ...(input.constraints ?? []),
    ...(input.openItems ?? []),
  ].filter((value): value is string => Boolean(value?.trim())).join("\n");
}

function unavailableGroundingContext(
  input: ContextAssemblyInput,
  degradedReason: "context_timeout" | "context_unavailable",
): GroundingContext {
  return GroundingContextSchema.parse({
    personalMemory: [],
    projectFacts: [],
    citations: [],
    retrieval: {
      snapshotId: null,
      queryHash: createHash("sha256").update(contextQuery(input)).digest("hex"),
      tokenBudget: 0,
      tokensSelected: 0,
      degradedReason,
    },
  });
}

function normalizedTimeoutMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) return DEFAULT_CONTEXT_ASSEMBLY_TIMEOUT_MS;
  return Math.max(1, Math.floor(timeoutMs));
}

function contextAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Context assembly was cancelled", "AbortError");
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
