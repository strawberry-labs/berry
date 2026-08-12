import { describe, expect, it } from "vitest";
import { PersonalMemoryHttpError, type PersonalMemoryProvider } from "@berry/personal-memory";
import type { GroundingContext, MemoryItem } from "@berry/shared";
import { CloudDatabaseService, type SqlExecutor } from "../db/cloud-database.service.js";
import type { KnowledgeService } from "../knowledge/knowledge.service.js";
import type { MemoryRepository } from "./memory.repository.js";
import {
  ContextAssemblyService,
  DEFAULT_CONTEXT_ASSEMBLY_TIMEOUT_MS,
  type ContextAssemblyInput,
} from "./context-assembly.service.js";
import { MemoryService } from "./memory.service.js";

const tenantId = "00000000-0000-7000-8000-000000000001";
const userId = "00000000-0000-7000-8000-000000000002";
const workspaceId = "00000000-0000-7000-8000-000000000003";
const taskId = "00000000-0000-7000-8000-000000000004";
const sessionId = "00000000-0000-7000-8000-000000000005";

class NoopExecutor implements SqlExecutor {
  async execute(): Promise<void> {}
  async query<T>(): Promise<readonly T[]> { return []; }
}

describe("ContextAssemblyService", () => {
  it("preserves normally completed memory and knowledge retrieval", async () => {
    let memorySignal: AbortSignal | undefined;
    let knowledgeSignal: AbortSignal | undefined;
    const personal = {
      id: "memory-1",
      kind: "preference",
      content: "The user prefers concise answers.",
      explicit: true,
      confidence: 1,
      sourceTaskId: null,
      sourceMessageId: null,
      updatedAt: "2026-08-12T00:00:00.000Z",
    } as MemoryItem;
    const memory = {
      async recall(input: { signal?: AbortSignal }) {
        memorySignal = input.signal;
        return { personal: [personal], project: [], personalTokens: 8, projectTokens: 0, personalDegraded: false };
      },
    } as unknown as MemoryService;
    const knowledge = {
      async retrieve(input: { signal?: AbortSignal }) {
        knowledgeSignal = input.signal;
        return knowledgeGrounding();
      },
    } as unknown as KnowledgeService;
    const service = new ContextAssemblyService(memory, knowledge, database());

    const grounding = await service.assemble(input());

    expect(grounding.personalMemory).toEqual([
      expect.objectContaining({ memoryId: "memory-1", content: "The user prefers concise answers." }),
    ]);
    expect(grounding.projectFacts).toEqual([
      expect.objectContaining({ sourceId: "source-1", content: "Releases use the stable branch." }),
    ]);
    expect(grounding.retrieval).toMatchObject({
      degradedReason: "none",
      tokenBudget: 6_800,
      tokensSelected: 16,
    });
    expect(memorySignal).toBeInstanceOf(AbortSignal);
    expect(knowledgeSignal).toBe(memorySignal);
  });

  it("aborts hung Mem0 retrieval and fails open before two seconds", async () => {
    let mem0Aborted = false;
    const personalMemory = {
      async search(search: Parameters<PersonalMemoryProvider["search"]>[0]) {
        return new Promise<MemoryItem[]>((_resolve, reject) => {
          const abort = () => {
            mem0Aborted = true;
            reject(new PersonalMemoryHttpError("context deadline", null, false));
          };
          if (search.signal?.aborted) abort();
          else search.signal?.addEventListener("abort", abort, { once: true });
        });
      },
    } as unknown as PersonalMemoryProvider;
    const memory = new MemoryService(memoryRepository(), database(), personalMemory);
    const knowledge = { async retrieve() { return knowledgeGrounding(); } } as unknown as KnowledgeService;
    const service = new ContextAssemblyService(memory, knowledge, database());
    const startedAt = performance.now();

    const grounding = await service.assemble(input());
    const elapsedMs = performance.now() - startedAt;

    expect(DEFAULT_CONTEXT_ASSEMBLY_TIMEOUT_MS).toBe(1_500);
    expect(elapsedMs).toBeLessThan(2_000);
    expect(mem0Aborted).toBe(true);
    expect(grounding).toMatchObject({
      personalMemory: [],
      projectFacts: [],
      citations: [],
      retrieval: {
        tokenBudget: 0,
        tokensSelected: 0,
        degradedReason: "context_timeout",
      },
    });
  }, 3_000);

  it("handles retrieval rejection that settles after the deadline", async () => {
    let rejectRecall: ((error: Error) => void) | undefined;
    const memory = {
      async recall() {
        return new Promise<never>((_resolve, reject) => { rejectRecall = reject; });
      },
    } as unknown as MemoryService;
    const knowledge = { async retrieve() { return knowledgeGrounding(); } } as unknown as KnowledgeService;
    const service = new ContextAssemblyService(memory, knowledge, database());

    const grounding = await service.assemble(input(), { timeoutMs: 10 });
    rejectRecall?.(new Error("late retrieval failure"));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(grounding.retrieval.degradedReason).toBe("context_timeout");
  });
});

function input(): ContextAssemblyInput {
  return {
    tenantId,
    userId,
    workspaceId,
    taskId,
    sessionId,
    request: "How do we prepare a release?",
    taskTitle: "Release planning",
  };
}

function database(): CloudDatabaseService {
  return new CloudDatabaseService(new NoopExecutor());
}

function memoryRepository(): MemoryRepository {
  return {
    async settings() { return { memoryEnabled: true, implicitMemoryEnabled: true }; },
    async recall() { return []; },
  } as unknown as MemoryRepository;
}

function knowledgeGrounding(): GroundingContext {
  return {
    personalMemory: [],
    projectFacts: [{
      sourceId: "source-1",
      chunkId: "chunk-1",
      content: "Releases use the stable branch.",
      citationLabel: "Release process",
    }],
    citations: [{
      sourceId: "source-1",
      chunkId: "chunk-1",
      label: "Release process",
      href: null,
    }],
    retrieval: {
      snapshotId: null,
      queryHash: "knowledge-query",
      tokenBudget: 5_000,
      tokensSelected: 8,
      degradedReason: "none",
    },
  };
}
