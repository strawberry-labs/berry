import { describe, expect, it } from "vitest";
import { CloudDatabaseService, type SqlExecutor } from "../db/cloud-database.service.js";
import { KnowledgeService } from "./knowledge.service.js";

const tenantId = "00000000-0000-7000-8000-000000000001";
const userId = "00000000-0000-7000-8000-000000000002";
const workspaceId = "00000000-0000-7000-8000-000000000003";
const taskId = "00000000-0000-7000-8000-000000000004";
const chunkId = "00000000-0000-7000-8000-000000000005";
const sourceId = "00000000-0000-7000-8000-000000000006";
const fileId = "00000000-0000-7000-8000-000000000007";

class RetrievalExecutor implements SqlExecutor {
  readonly calls: Array<{ kind: "execute" | "query"; sql: string; params: readonly unknown[] }> = [];

  async execute(sql: string, params: readonly unknown[] = []): Promise<void> {
    this.calls.push({ kind: "execute", sql, params });
  }

  async query<T>(sql: string, params: readonly unknown[] = []): Promise<readonly T[]> {
    this.calls.push({ kind: "query", sql, params });
    if (sql.includes("FROM workspaces w")) return [{ id: workspaceId }] as T[];
    if (sql.includes("lower(ks.title) = lower")) return [];
    if (sql.includes("search_document @@")) {
      return [{
        chunk_id: chunkId,
        source_id: sourceId,
        source_original_id: fileId,
        source_type: "file",
        title: "Architecture.pdf",
        text_content: "The durable runner renews a database lease before it resumes a turn.",
        token_estimate: 18,
        metadata: { page: 4, fileId },
        authority: "0.9",
        created_at: "2026-07-20T00:00:00.000Z",
        rank: "0.7",
      }] as T[];
    }
    return [];
  }

  async transaction<T>(callback: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    return callback(this);
  }
}

describe("KnowledgeService", () => {
  it("keeps retrieval tenant/workspace/ACL scoped and degrades to citation-ready FTS", async () => {
    const executor = new RetrievalExecutor();
    const service = new KnowledgeService(new CloudDatabaseService(executor), null);

    const grounding = await service.retrieve({
      tenantId,
      userId,
      workspaceId,
      taskId,
      request: "How does the durable runner renew its lease?",
      taskTitle: "Durable task recovery",
      checkpointGoal: "Resume safely",
    });

    expect(grounding.retrieval.degradedReason).toBe("embeddings_unavailable");
    expect(grounding.projectFacts).toEqual([
      expect.objectContaining({ chunkId, sourceId, citationLabel: "Architecture.pdf, page 4" }),
    ]);
    expect(grounding.citations[0]).toMatchObject({ href: `/v1/files/${fileId}` });

    const retrievalSql = executor.calls
      .filter((call) => call.kind === "query" && call.sql.includes("knowledge_chunks"))
      .map((call) => call.sql);
    expect(retrievalSql.length).toBeGreaterThanOrEqual(2);
    for (const sql of retrievalSql) {
      expect(sql).toContain("kc.tenant_id = $1::uuid");
      expect(sql).toContain("kc.workspace_id = $2::uuid");
      expect(sql).toContain("ks.tombstoned_at IS NULL");
      expect(sql).toContain("ks.visibility = 'project'");
      expect(sql).toContain("ks.user_id = $3::uuid");
      expect(sql).toContain("FROM workspace_files task_file");
      expect(sql).toContain("task_file.originating_task_id::text = $4");
      expect(sql).not.toContain("ks.metadata->>'taskId'");
    }
    const snapshotWrite = executor.calls.find((call) =>
      call.kind === "execute" && call.sql.includes("INSERT INTO retrieval_snapshots")
    );
    expect(snapshotWrite).toBeDefined();
    expect(String(snapshotWrite!.params[8])).not.toContain("renews a database lease");
    expect(String(snapshotWrite!.params[8])).toContain('"contentHash"');
  });

  it("enables filtered HNSW iteration and keeps vector ordering index-compatible", async () => {
    const executor = new RetrievalExecutor();
    const service = new KnowledgeService(new CloudDatabaseService(executor), {
      profile: { id: "profile", provider: "fixture", model: "fixture", dimensions: 3, version: 1 },
      embed: async () => [[0.1, 0.2, 0.3]],
    });

    await service.retrieve({
      tenantId,
      userId,
      workspaceId,
      taskId,
      request: "lease recovery",
    });

    expect(executor.calls).toContainEqual(expect.objectContaining({
      kind: "execute",
      sql: "SET LOCAL hnsw.iterative_scan = 'strict_order'",
    }));
    const vectorQuery = executor.calls.find((call) => call.kind === "query" && call.sql.includes("<=>"));
    expect(vectorQuery?.sql).toContain("ORDER BY kc.embedding <=> $5::vector\n      LIMIT 60");
  });

  it("gates earlier task answers by relevance, labels them and keeps them below files (H-040)", async () => {
    const row = (id: string, sourceType: "file" | "task_outcome", rank: string, title: string) => ({
      chunk_id: `00000000-0000-7000-8000-0000000001${id}`,
      source_id: `00000000-0000-7000-8000-0000000002${id}`,
      source_original_id: `00000000-0000-7000-8000-0000000003${id}`,
      source_type: sourceType,
      title,
      text_content: `${title} content`,
      token_estimate: 10,
      metadata: {},
      authority: sourceType === "task_outcome" ? "0.8" : "0.5",
      created_at: "2026-10-01T00:00:00.000Z",
      rank,
    });
    const closeFile = row("01", "file", "0.52", "Spec.pdf");
    const unrelatedFile = row("02", "file", "0.08", "Menu.pdf");
    const closeAnswer = row("03", "task_outcome", "0.61", "Earlier spec review");
    const looseAnswer = row("04", "task_outcome", "0.31", "Unrelated CV task");
    class VectorExecutor extends RetrievalExecutor {
      override async query<T>(sql: string, params: readonly unknown[] = []): Promise<readonly T[]> {
        if (sql.includes("FROM workspaces w")) return [{ id: workspaceId }] as T[];
        this.calls.push({ kind: "query", sql, params });
        if (sql.includes("<=> $5::vector")) return [closeFile, unrelatedFile, closeAnswer, looseAnswer] as T[];
        if (sql.includes("search_document @@")) return [{ ...looseAnswer, rank: "0.9" }] as T[];
        return [];
      }
    }
    const executor = new VectorExecutor();
    const embeddings = { profile: { id: "profile" }, embed: async () => [[0.1, 0.2]] };
    const service = new KnowledgeService(new CloudDatabaseService(executor), embeddings as never);

    const grounding = await service.retrieve({ tenantId, userId, workspaceId, taskId, request: "Review the spec" });

    const labels = grounding.projectFacts.map((fact) => fact.citationLabel);
    expect(labels).toContain("Spec.pdf");
    expect(labels).toContain("Earlier Berry answer (not confirmed by the user): Earlier spec review, 2026-10-01");
    expect(labels.some((label) => label.includes("Menu.pdf") || label.includes("Unrelated CV task"))).toBe(false);
    const sql = executor.calls.filter((call) => call.sql.includes("knowledge_chunks")).map((call) => call.sql);
    for (const lane of sql) expect(lane).toContain("ks.source_id = $4 OR NOT EXISTS");
    const snapshot = executor.calls.find((call) => call.sql.includes("INSERT INTO retrieval_snapshots"));
    const candidates = JSON.parse(String(snapshot?.params[8])) as Array<{ authority: number; similarity: number | null; sourceType: string }>;
    expect(candidates.find((candidate) => candidate.sourceType === "task_outcome")).toMatchObject({ authority: 0.3, similarity: 0.61 });
  });
});
