import { describe, expect, it } from "vitest";
import { reciprocalRankFusion, selectRetrievalCandidates } from "@berry/shared";
import type { SqlExecutor } from "../sql-repositories.js";
import {
  buildTaskOutcomeText,
  redactProjectKnowledgeText,
  SqlKnowledgeRepository,
} from "./repository.js";
import { DocumentExtractor, KnowledgeChunker } from "./services.js";

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
