import type { PersonalMemoryProvider } from "@berry/personal-memory";
import type { MemoryOperation } from "@berry/shared";
import { describe, expect, it } from "vitest";
import type { MemoryExtractJobPayload } from "../jobs.js";
import type { MemoryOperationGenerator } from "./generator.js";
import { MemoryProcessor } from "./processor.js";
import type { SqlWorkerMemoryRepository } from "./repository.js";

describe("MemoryProcessor with self-hosted Mem0", () => {
  it("delegates personal extraction to Mem0 and sends only project facts to Berry", async () => {
    let generatorScopes: readonly string[] = [];
    const captured: { mem0Input?: Parameters<PersonalMemoryProvider["ingestConversation"]>[0] } = {};
    let projectOperations: readonly (MemoryOperation & { scope: "personal" | "project" })[] = [];

    const generator: MemoryOperationGenerator = {
      async generate(_payload, scopes) {
        generatorScopes = scopes ?? [];
        return [
          { ...operation("personal", "response-style"), content: "The user prefers concise answers." },
          { ...operation("project", "release-branch"), content: "Releases use the stable branch." },
        ];
      },
    };
    const personalMemory = {
      async ingestConversation(input: Parameters<PersonalMemoryProvider["ingestConversation"]>[0]) {
        captured.mem0Input = input;
        return { items: [{} as never], replayed: true };
      },
    } as unknown as PersonalMemoryProvider;
    const repository = {
      async apply(
        _payload: MemoryExtractJobPayload,
        operations: readonly (MemoryOperation & { scope: "personal" | "project" })[],
      ) {
        projectOperations = operations;
        return { applied: operations.length, noops: 0 };
      },
    } as unknown as SqlWorkerMemoryRepository;

    const result = await new MemoryProcessor(repository, generator, personalMemory).process(payload());

    expect(generatorScopes).toEqual(["project"]);
    expect(projectOperations.map((candidate) => candidate.scope)).toEqual(["project"]);
    expect(captured.mem0Input?.messages).toEqual([
      { role: "user", content: "Please remember that I prefer concise answers." },
      { role: "assistant", content: "Understood." },
    ]);
    expect(captured.mem0Input?.idempotencyKey).toContain("memory-extractor-v1");
    expect(result).toEqual({ applied: 1, noops: 1 });
  });
});

function operation(scope: "personal" | "project", stableKey: string) {
  return {
    scope,
    operation: "ADD" as const,
    stableKey,
    kind: scope === "personal" ? "preference" : "project_convention",
    content: "",
    value: {},
    confidence: 0.8,
    salience: 0.8,
    explicit: false,
    targetItemId: null,
    expiresAt: null,
    reason: "fixture",
  };
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
    userText: "api_key=must-not-survive\nPlease remember that I prefer concise answers.",
    assistantText: "Understood.",
  };
}
