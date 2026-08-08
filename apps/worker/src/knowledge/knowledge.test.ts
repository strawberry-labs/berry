import { describe, expect, it, vi } from "vitest";
import { reciprocalRankFusion, selectRetrievalCandidates } from "@berry/shared";
import type { SqlExecutor } from "../sql-repositories.js";
import {
  buildTaskOutcomeText,
  redactProjectKnowledgeText,
  SqlKnowledgeRepository,
} from "./repository.js";
import { KnowledgeProcessor } from "./processor.js";
import { DocumentExtractor, KnowledgeChunker, type KnowledgeObjectStore } from "./services.js";

const tenantId = "00000000-0000-7000-8000-000000000001";
const sourceId = "00000000-0000-7000-8000-000000000002";

const fixture = {
  a: { chunkId: "a", sourceId: "source-a", text: "alpha", tokenEstimate: 4, authority: 0.5, createdAt: "2026-07-01T00:00:00.000Z" },
  b: { chunkId: "b", sourceId: "source-b", text: "beta", tokenEstimate: 4, authority: 0.5, createdAt: "2026-07-01T00:00:00.000Z" },
  c: { chunkId: "c", sourceId: "source-a", text: "gamma", tokenEstimate: 4, authority: 0.5, createdAt: "2026-07-01T00:00:00.000Z" },
};

class FakeExecutor implements SqlExecutor {
  readonly calls: Array<{ kind: "execute" | "query"; sql: string; params: readonly unknown[] }> = [];

  async execute(sql: string, params: readonly unknown[] = []): Promise<void> {
    this.calls.push({ kind: "execute", sql, params });
  }

  async query<T>(sql: string, params: readonly unknown[] = []): Promise<readonly T[]> {
    this.calls.push({ kind: "query", sql, params });
    return [];
  }

  async transaction<T>(callback: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    return callback(this);
  }
}

describe("knowledge ingestion and ranking", () => {
  it("produces stable RRF order and honors token/source diversity", () => {
    const fused = reciprocalRankFusion(
      [fixture.a, fixture.b, fixture.c],
      [fixture.b, fixture.c, fixture.a],
      { now: new Date("2026-07-28T00:00:00.000Z") },
    );
    expect(fused.map((item) => item.chunkId)).toEqual(["b", "a", "c"]);

    const selection = selectRetrievalCandidates(fused, { tokenBudget: 8, maxPerSource: 1 });
    expect(selection.selected.map((item) => item.chunkId)).toEqual(["b", "a"]);
    expect(selection.tokensSelected).toBe(8);
  });

  it("normalizes and chunks fixture text without external extraction services", async () => {
    const extractor = new DocumentExtractor("http://tika.invalid");
    const text = await extractor.extract({
      bytes: new TextEncoder().encode("# Heading\r\n\r\nA compact project fact.\0"),
      mediaType: "text/markdown",
    });
    const chunks = await new KnowledgeChunker(12, 2).chunk(text, "text/markdown");

    expect(text).toBe("# Heading\n\nA compact project fact.");
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]?.metadata.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("deletes chunks and tombstones the exact tenant/source revision", async () => {
    const executor = new FakeExecutor();
    await new SqlKnowledgeRepository(executor).deleteSource(tenantId, sourceId, "revision-1");

    const sql = executor.calls.map((call) => call.sql).join("\n");
    expect(sql).toContain("SELECT berry_set_tenant_id($1::uuid)");
    expect(sql).toContain("DELETE FROM knowledge_chunks");
    expect(sql).toContain("tenant_id = $1::uuid");
    expect(sql).toContain("tombstoned_at = COALESCE(tombstoned_at, now())");
    expect(executor.calls.at(-1)?.params).toEqual([tenantId, sourceId, "revision-1"]);
  });

  it("casts metadata parameters before passing them to polymorphic JSON builders", async () => {
    class CurrentSourceExecutor extends FakeExecutor {
      override async query<T>(sql: string, params: readonly unknown[] = []): Promise<readonly T[]> {
        this.calls.push({ kind: "query", sql, params });
        if (sql.includes("SELECT ks.id, ks.source_revision")) {
          return [{
            id: sourceId,
            source_revision: "revision-1",
            tombstoned_at: null,
            file_deleted_at: null,
          }] as T[];
        }
        return [];
      }
    }
    const executor = new CurrentSourceExecutor();
    const repository = new SqlKnowledgeRepository(executor);
    await expect(repository.saveExtraction({
      tenantId,
      source: {
        id: sourceId,
        tenantId,
        workspaceId: "00000000-0000-7000-8000-000000000003",
        userId: null,
        sourceType: "file",
        sourceId: "00000000-0000-7000-8000-000000000004",
        revision: "revision-1",
        contentHash: "source-hash",
        title: "Fixture source",
        visibility: "project",
        status: "extracting",
        mediaType: "text/plain",
        bucket: "test",
        objectKey: "fixture.txt",
        derivativeObjectKey: null,
        inlineText: null,
        tombstonedAt: null,
      },
      derivativeObjectKey: "fixture.extract.txt",
      mediaType: "text/plain; charset=utf-8",
      sizeBytes: 12,
      contentHash: "extracted-hash",
    })).resolves.toBe(true);

    const derivativeInsert = executor.calls.find((call) => call.sql.includes("INSERT INTO file_derivatives"));
    expect(derivativeInsert?.sql).toContain("jsonb_build_object('contentHash', $6::text)");
  });

  it("preserves a completed derivative when only one project source was unlinked", async () => {
    class UnlinkedSourceExecutor extends FakeExecutor {
      override async query<T>(sql: string, params: readonly unknown[] = []): Promise<readonly T[]> {
        this.calls.push({ kind: "query", sql, params });
        if (sql.includes("SELECT ks.id, ks.source_revision")) {
          return [{
            id: sourceId,
            source_revision: "revision-1",
            tombstoned_at: new Date(),
            file_deleted_at: null,
          }] as T[];
        }
        return [];
      }
    }
    const executor = new UnlinkedSourceExecutor();
    const repository = new SqlKnowledgeRepository(executor);

    await expect(repository.saveExtraction({
      tenantId,
      source: {
        id: sourceId,
        tenantId,
        workspaceId: "00000000-0000-7000-8000-000000000003",
        userId: null,
        sourceType: "file",
        sourceId: "00000000-0000-7000-8000-000000000004",
        revision: "revision-1",
        contentHash: "source-hash",
        title: "Unlinked source",
        visibility: "project",
        status: "extracting",
        mediaType: "text/plain",
        bucket: "berry-test",
        objectKey: "artifacts/original.txt",
        derivativeObjectKey: null,
        inlineText: null,
        tombstonedAt: null,
      },
      derivativeObjectKey: "artifacts/derivatives/text-revision.txt",
      mediaType: "text/plain; charset=utf-8",
      sizeBytes: 12,
      contentHash: "extracted-hash",
    })).resolves.toBe(false);

    expect(executor.calls.some((call) => call.sql.includes("INSERT INTO file_derivatives"))).toBe(true);
    expect(executor.calls.some((call) => call.sql.includes("'file.delete-object'"))).toBe(false);
    expect(executor.calls.some((call) => call.sql.includes("'knowledge.chunk'"))).toBe(false);
  });

  it("durably deletes a derivative written after its source was tombstoned", async () => {
    const executor = new FakeExecutor();
    const repository = new SqlKnowledgeRepository(executor);
    const fileId = "00000000-0000-7000-8000-000000000004";

    await expect(repository.saveExtraction({
      tenantId,
      source: {
        id: sourceId,
        tenantId,
        workspaceId: "00000000-0000-7000-8000-000000000003",
        userId: null,
        sourceType: "file",
        sourceId: fileId,
        revision: "revision-1",
        contentHash: "source-hash",
        title: "Deleted source",
        visibility: "project",
        status: "extracting",
        mediaType: "text/plain",
        bucket: "berry-test",
        objectKey: "artifacts/original.txt",
        derivativeObjectKey: null,
        inlineText: null,
        tombstonedAt: null,
      },
      derivativeObjectKey: "artifacts/derivatives/text-revision.txt",
      mediaType: "text/plain; charset=utf-8",
      sizeBytes: 12,
      contentHash: "extracted-hash",
    })).resolves.toBe(false);

    expect(executor.calls.some((call) => call.sql.includes("INSERT INTO file_derivatives"))).toBe(false);
    const cleanup = executor.calls.find((call) => call.sql.includes("'file.delete-object'"));
    expect(cleanup?.params[1]).toBe(fileId);
    expect(String(cleanup?.params[2])).toContain(`file.delete-object:${fileId}:stale-derivative:`);
    expect(JSON.parse(String(cleanup?.params[3]))).toEqual({
      tenantId,
      fileId,
      bucket: "berry-test",
      keys: ["artifacts/derivatives/text-revision.txt"],
    });
  });

  it("reports a late extraction as stale without marking the deleted source failed", async () => {
    const source = {
      id: sourceId,
      tenantId,
      workspaceId: "00000000-0000-7000-8000-000000000003",
      userId: null,
      sourceType: "file" as const,
      sourceId: "00000000-0000-7000-8000-000000000004",
      revision: "revision-1",
      contentHash: "source-hash",
      title: "Deleted source.txt",
      visibility: "project" as const,
      status: "extracting",
      mediaType: "text/plain",
      bucket: "berry-test",
      objectKey: "artifacts/original.txt",
      objectVersionId: "version-7",
      derivativeObjectKey: null,
      inlineText: null,
      tombstonedAt: null,
    };
    let wroteDerivative = false;
    const markFailed = vi.fn(async () => undefined);
    const repository = {
      markExtracting: async () => true,
      loadSource: async () => source,
      saveExtraction: async () => false,
      markFailed,
    } as unknown as SqlKnowledgeRepository;
    const read = vi.fn(async () => new TextEncoder().encode("project fact"));
    const processor = new KnowledgeProcessor({
      repository,
      objects: {
        read,
        write: async () => { wroteDerivative = true; },
      },
      extractor: new DocumentExtractor("http://tika.invalid"),
      chunker: new KnowledgeChunker(),
      embeddings: null,
    });

    await expect(processor.process("knowledge.extract", {
      tenantId,
      sourceId,
      revision: "revision-1",
    })).resolves.toEqual({ stale: true });
    expect(read).toHaveBeenCalledWith(expect.objectContaining({ versionId: "version-7" }));
    expect(wroteDerivative).toBe(true);
    expect(markFailed).not.toHaveBeenCalled();
  });

  it("re-enqueues deterministic derivative cleanup when a tombstoned extraction job retries", async () => {
    const cleanupUnclaimedExtraction = vi.fn(async () => undefined);
    const repository = {
      markExtracting: async () => false,
      cleanupUnclaimedExtraction,
    } as unknown as SqlKnowledgeRepository;
    const processor = new KnowledgeProcessor({
      repository,
      objects: {} as KnowledgeObjectStore,
      extractor: new DocumentExtractor("http://tika.invalid"),
      chunker: new KnowledgeChunker(),
      embeddings: null,
    });

    await expect(processor.process("knowledge.extract", {
      tenantId,
      sourceId,
      revision: "revision-1",
    })).resolves.toEqual({ stale: true });
    expect(cleanupUnclaimedExtraction).toHaveBeenCalledWith(
      tenantId,
      sourceId,
      "revision-1",
    );
  });

  it("retries cleanup only when the file was deleted or the attempted revision is obsolete", async () => {
    class CleanupGuardExecutor extends FakeExecutor {
      constructor(private readonly fileDeletedAt: Date | null, private readonly currentRevision = "revision-1") {
        super();
      }

      override async query<T>(sql: string, params: readonly unknown[] = []): Promise<readonly T[]> {
        this.calls.push({ kind: "query", sql, params });
        if (sql.includes("SELECT ks.source_type, ks.source_id")) {
          return [{
            source_type: "file",
            source_id: "00000000-0000-7000-8000-000000000004",
            source_revision: this.currentRevision,
            bucket: "berry-test",
            object_key: "artifacts/original/deleted.txt",
            file_deleted_at: this.fileDeletedAt,
          }] as T[];
        }
        return [];
      }
    }
    const activeExecutor = new CleanupGuardExecutor(null);
    await new SqlKnowledgeRepository(activeExecutor).cleanupUnclaimedExtraction(
      tenantId,
      sourceId,
      "revision-1",
    );
    expect(activeExecutor.calls.some((call) => call.sql.includes("'file.delete-object'"))).toBe(false);

    const deletedExecutor = new CleanupGuardExecutor(new Date());
    await new SqlKnowledgeRepository(deletedExecutor).cleanupUnclaimedExtraction(
      tenantId,
      sourceId,
      "revision-1",
    );
    const deletedCleanup = deletedExecutor.calls.find((call) => call.sql.includes("'file.delete-object'"));
    expect(JSON.parse(String(deletedCleanup?.params[3]))).toMatchObject({
      tenantId,
      fileId: "00000000-0000-7000-8000-000000000004",
      bucket: "berry-test",
      keys: [expect.stringMatching(/^artifacts\/derivatives\/text-[a-f0-9]{16}\.txt$/)],
    });

    const revisedExecutor = new CleanupGuardExecutor(null, "revision-2");
    await new SqlKnowledgeRepository(revisedExecutor).cleanupUnclaimedExtraction(
      tenantId,
      sourceId,
      "revision-1",
    );
    expect(revisedExecutor.calls.some((call) => call.sql.includes("'file.delete-object'"))).toBe(true);
  });

  it("schedules a fresh extraction wake-up for every reindex request", async () => {
    const executor = new FakeExecutor();
    const repository = new SqlKnowledgeRepository(executor);

    await repository.resetForReindex(tenantId, sourceId, "revision-1");
    await repository.resetForReindex(tenantId, sourceId, "revision-1");

    const wakeUps = executor.calls.filter((call) => call.sql.includes("INSERT INTO runtime_outbox"));
    expect(wakeUps).toHaveLength(2);
    expect(wakeUps[0]?.params[3]).not.toBe(wakeUps[1]?.params[3]);
    expect(wakeUps.every((call) => String(call.params[3]).startsWith(`knowledge.extract:${sourceId}:revision-1:reindex-`))).toBe(true);
  });

  it("writes large chunk and embedding sets in bounded SQL batches", async () => {
    class ExistingSourceExecutor extends FakeExecutor {
      override async query<T>(sql: string, params: readonly unknown[] = []): Promise<readonly T[]> {
        this.calls.push({ kind: "query", sql, params });
        if (sql.includes("SELECT id FROM knowledge_sources")) return [{ id: sourceId }] as T[];
        return [];
      }
    }
    const executor = new ExistingSourceExecutor();
    const repository = new SqlKnowledgeRepository(executor);
    const source = {
      id: sourceId,
      tenantId,
      workspaceId: "00000000-0000-7000-8000-000000000003",
      userId: null,
      sourceType: "file" as const,
      sourceId: "00000000-0000-7000-8000-000000000004",
      revision: "revision-1",
      contentHash: "source-hash",
      title: "Large source",
      visibility: "project" as const,
      status: "chunking",
      mediaType: "text/plain",
      bucket: "test",
      objectKey: "large.txt",
      derivativeObjectKey: null,
      inlineText: null,
      tombstonedAt: null,
    };
    const chunks = Array.from({ length: 501 }, (_, ordinal) => ({
      text: `chunk-${ordinal}`,
      ordinal,
      tokenEstimate: 2,
      metadata: { contentHash: `hash-${ordinal}` },
    }));
    await repository.replaceChunks({ tenantId, source, chunks });
    const inserts = executor.calls.filter((call) => call.kind === "execute" && call.sql.includes("INSERT INTO knowledge_chunks"));
    expect(inserts).toHaveLength(2);
    expect(JSON.parse(String(inserts[0]?.params[3]))).toHaveLength(500);
    expect(JSON.parse(String(inserts[1]?.params[3]))).toHaveLength(1);

    const stored = Array.from({ length: 101 }, (_, index) => ({
      id: `00000000-0000-7000-8000-${String(index + 10).padStart(12, "0")}`,
      text: `chunk-${index}`,
      ordinal: index,
      tokenEstimate: 2,
    }));
    await repository.saveEmbeddings({
      tenantId,
      source,
      chunks: stored,
      vectors: stored.map(() => [0.25, 0.75]),
      profile: { id: "profile-v2", provider: "fixture", model: "fixture", dimensions: 2, version: 2 },
    });
    const updates = executor.calls.filter((call) => call.kind === "execute" && call.sql.includes("UPDATE knowledge_chunks AS target"));
    expect(updates).toHaveLength(2);
    expect(JSON.parse(String(updates[0]?.params[2]))).toHaveLength(100);
    expect(JSON.parse(String(updates[1]?.params[2]))).toHaveLength(1);
  });

  it("keeps embedding requests within the production provider batch limit", async () => {
    const source = {
      id: sourceId,
      tenantId,
      workspaceId: "00000000-0000-7000-8000-000000000003",
      userId: null,
      sourceType: "file" as const,
      sourceId: "00000000-0000-7000-8000-000000000004",
      revision: "revision-1",
      contentHash: "source-hash",
      title: "Large source",
      visibility: "project" as const,
      status: "indexed",
      mediaType: "text/plain",
      bucket: "test",
      objectKey: "large.txt",
      derivativeObjectKey: "large.extract.txt",
      inlineText: null,
      tombstonedAt: null,
    };
    const chunks = Array.from({ length: 65 }, (_, ordinal) => ({
      id: `chunk-${ordinal}`,
      text: `chunk-${ordinal}`,
      ordinal,
      tokenEstimate: 2,
    }));
    const requestSizes: number[] = [];
    let savedVectorCount = 0;
    const repository = {
      loadSource: async () => source,
      listChunks: async () => chunks,
      saveEmbeddings: async (input: { vectors: readonly number[][] }) => {
        savedVectorCount = input.vectors.length;
      },
      markEmbeddingRetryable: async () => undefined,
    } as unknown as SqlKnowledgeRepository;
    const processor = new KnowledgeProcessor({
      repository,
      objects: {} as KnowledgeObjectStore,
      extractor: new DocumentExtractor("http://tika.invalid"),
      chunker: new KnowledgeChunker(),
      embeddings: {
        profile: { id: "profile-v2", provider: "fixture", model: "fixture", dimensions: 2, version: 2 },
        embed: async (texts) => {
          requestSizes.push(texts.length);
          return texts.map(() => [0.25, 0.75]);
        },
      },
    });

    await processor.process("knowledge.embed", { tenantId, sourceId, revision: "revision-1" });

    expect(requestSizes).toEqual([32, 32, 1]);
    expect(savedVectorCount).toBe(65);
  });

  it("builds a bounded task outcome and removes credentials before project indexing", () => {
    const outcome = buildTaskOutcomeText({
      checkpoint: {
        goal: "Deploy the service",
        narrative: "Deployment completed with password='checkpoint-secret'.",
        completedWork: ["Configured api_key=checkpoint-key"],
        decisions: [],
        artifacts: [],
        nextAction: "",
      },
      assistantParts: [{
        text: [
          "Deployment completed.",
          "Authorization: Bearer sk-live-secret",
          "AWS key: AKIAIOSFODNN7EXAMPLE",
          "-----BEGIN PRIVATE KEY-----",
          "private-material",
          "-----END PRIVATE KEY-----",
        ].join("\n"),
      }],
    });

    expect(outcome).toContain("Portable checkpoint:");
    expect(outcome).toContain("Final assistant result:");
    expect(outcome).toContain("Deployment completed.");
    expect(outcome).not.toContain("checkpoint-secret");
    expect(outcome).not.toContain("checkpoint-key");
    expect(outcome).not.toContain("sk-live-secret");
    expect(outcome).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(outcome).not.toContain("private-material");
    expect(outcome.length).toBeLessThanOrEqual(16_000);
  });

  it("redacts URL credentials and common provider token formats", () => {
    const redacted = redactProjectKnowledgeText(
      "https://alice:password@example.test xoxb-1234567890123456 ghp_abcdefghijklmnopqrstuvwxyz",
    );

    expect(redacted).not.toContain("alice:password");
    expect(redacted).not.toContain("xoxb-1234567890123456");
    expect(redacted).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
  });
});
