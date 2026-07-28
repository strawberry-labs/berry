import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import {
  GroundingContextSchema,
  RetrievalCandidateSchema,
  durableContextConfigFromEnv,
  reciprocalRankFusion,
  selectRetrievalCandidates,
  type EmbeddingProvider,
  type GroundingContext,
  type RetrievalCandidate,
} from "@berry/shared";
import { createHash, randomUUID } from "node:crypto";
import { CloudDatabaseService, type SqlExecutor } from "../db/cloud-database.service.js";

export const KNOWLEDGE_EMBEDDING_PROVIDER = Symbol("KNOWLEDGE_EMBEDDING_PROVIDER");

type RetrievalRow = {
  chunk_id: string;
  source_id: string;
  source_original_id: string;
  source_type: "file" | "task_outcome" | "message" | "checkpoint" | "memory";
  title: string;
  text_content: string;
  token_estimate: number;
  metadata: unknown;
  authority: string | number;
  created_at: Date | string;
  rank: string | number;
};

@Injectable()
export class KnowledgeService {
  readonly #config = durableContextConfigFromEnv(process.env);

  constructor(
    @Inject(CloudDatabaseService) private readonly database: CloudDatabaseService,
    @Inject(KNOWLEDGE_EMBEDDING_PROVIDER) private readonly embeddings: EmbeddingProvider | null,
  ) {}

  async enqueueTaskOutcome(input: {
    tenantId: string;
    workspaceId: string;
    taskId: string;
    sessionId: string;
    revision: string;
  }): Promise<void> {
    await this.database.withTenant(input.tenantId, async (executor) => {
      const [task] = await executor.query<{ id: string }>(`
        SELECT id FROM tasks
        WHERE tenant_id = $1::uuid AND id = $2::uuid
          AND workspace_id = $3::uuid AND status = 'completed'
          AND deleted_at IS NULL
      `, [input.tenantId, input.taskId, input.workspaceId]);
      if (!task) return;
      const dedupeKey = `knowledge.index-task:${input.taskId}:${input.revision}`;
      await executor.execute(`
        INSERT INTO runtime_outbox (
          tenant_id, event_type, aggregate_id, dedupe_key, payload
        ) VALUES ($1::uuid, 'knowledge.index-task', $2, $3, $4::jsonb)
        ON CONFLICT (tenant_id, dedupe_key) DO NOTHING
      `, [
        input.tenantId,
        input.taskId,
        dedupeKey,
        JSON.stringify(input),
      ]);
    });
  }

  async listTaskOutcomes(input: {
    tenantId: string;
    userId: string;
    workspaceId: string;
  }): Promise<Array<{
    sourceId: string;
    taskId: string;
    title: string;
    revision: string;
    status: string;
    vectorReady: boolean;
    failureReason: string | null;
    updatedAt: string;
  }>> {
    return this.database.withTenant(input.tenantId, async (executor) => {
      await requireWorkspace(executor, input);
      const rows = await executor.query<{
        id: string;
        source_id: string;
        title: string;
        source_revision: string;
        index_status: string;
        vector_ready: boolean;
        failure_reason: string | null;
        updated_at: Date | string;
      }>(`
        SELECT id,source_id,title,source_revision,index_status,vector_ready,
               failure_reason,updated_at
        FROM knowledge_sources
        WHERE tenant_id=$1::uuid AND workspace_id=$2::uuid
          AND source_type='task_outcome' AND tombstoned_at IS NULL
        ORDER BY updated_at DESC,id DESC
        LIMIT 200
      `, [input.tenantId, input.workspaceId]);
      return rows.map((row) => ({
        sourceId: row.id,
        taskId: row.source_id,
        title: row.title,
        revision: row.source_revision,
        status: row.index_status,
        vectorReady: row.vector_ready,
        failureReason: row.failure_reason,
        updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
      }));
    });
  }

  async retrieve(input: {
    tenantId: string;
    userId: string;
    workspaceId: string;
    taskId?: string;
    sessionId?: string;
    runId?: string;
    request: string;
    taskTitle?: string;
    checkpointGoal?: string;
    constraints?: string[];
    openItems?: string[];
    tokenBudget?: number;
  }): Promise<GroundingContext> {
    const query = buildRetrievalQuery(input);
    const queryHash = sha256(query);
    const tokenBudget = input.tokenBudget ?? this.#config.retrievalTokenBudget;
    if (!this.#config.projectKnowledgeEnabled || !query) {
      return emptyGrounding(queryHash, tokenBudget, "knowledge_disabled");
    }
    let queryVector: readonly number[] | null = null;
    let degradedReason: GroundingContext["retrieval"]["degradedReason"] = "none";
    if (this.embeddings) {
      try {
        queryVector = (await this.embeddings.embed([query]))[0] ?? null;
      } catch {
        degradedReason = "embeddings_unavailable";
      }
    } else {
      degradedReason = "embeddings_unavailable";
    }
    return this.database.withTenant(input.tenantId, async (executor) => {
      await requireWorkspace(executor, input);
      const exactRows = await this.exact(executor, input, query);
      const fullTextRows = await this.fullText(executor, input, query);
      const vectorRows = queryVector ? await this.vector(executor, input, queryVector) : [];
      const fullText = uniqueRows([...exactRows, ...fullTextRows]).map(rowToRanked);
      const vector = vectorRows.map(rowToRanked);
      const fused = reciprocalRankFusion(fullText, vector);
      const selection = selectRetrievalCandidates(fused, { tokenBudget, maxPerSource: 3 });
      const candidates: RetrievalCandidate[] = fused.map((candidate) => {
        const selected = selection.selected.some((item) => item.chunkId === candidate.chunkId);
        return RetrievalCandidateSchema.parse({
          chunkId: candidate.chunkId,
          sourceId: candidate.sourceId,
          sourceType: candidate.sourceType,
          title: candidate.title,
          text: candidate.text,
          citationLabel: candidate.citationLabel,
          tokenEstimate: candidate.tokenEstimate,
          ftsRank: candidate.ftsRank,
          vectorRank: candidate.vectorRank,
          fusedScore: candidate.fusedScore,
          authority: candidate.authority,
          selected,
          selectionReason: selected ? "rrf_ranked_within_budget" : "not_selected",
          metadata: candidate.metadata,
        });
      });
      const snapshotId = randomUUID();
      await executor.execute(`
        INSERT INTO retrieval_snapshots (
          id, tenant_id, user_id, workspace_id, task_id, session_id, run_id,
          query_hash, candidates, selected_source_ids, selected_chunk_ids,
          component_scores, selection_reason, token_budget, tokens_selected,
          retrieval_version, embedding_profile_id
        ) VALUES (
          $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid,
          $8, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, $13, $14, $15,
          'hybrid-rrf-v1', $16
        )
      `, [
        snapshotId,
        input.tenantId,
        input.userId,
        input.workspaceId,
        input.taskId ?? null,
        input.sessionId ?? null,
        input.runId ?? null,
        queryHash,
        JSON.stringify(candidates),
        JSON.stringify([...new Set(selection.selected.map((item) => item.sourceId))]),
        JSON.stringify(selection.selected.map((item) => item.chunkId)),
        JSON.stringify(Object.fromEntries(fused.map((item) => [item.chunkId, {
          ftsRank: item.ftsRank,
          vectorRank: item.vectorRank,
          fusedScore: item.fusedScore,
        }]))),
        "rrf_with_authority_recency_and_diversity",
        tokenBudget,
        selection.tokensSelected,
        this.embeddings?.profile.id ?? null,
      ]);
      return GroundingContextSchema.parse({
        personalMemory: [],
        projectFacts: selection.selected.map((item) => ({
          sourceId: item.sourceId,
          chunkId: item.chunkId,
          content: item.text,
          citationLabel: item.citationLabel,
        })),
        citations: selection.selected.map((item) => ({
          sourceId: item.sourceId,
          chunkId: item.chunkId,
          label: item.citationLabel,
          href: item.sourceType === "file" ? `/v1/files/${item.sourceOriginalId}` : null,
        })),
        retrieval: {
          snapshotId,
          queryHash,
          tokenBudget,
          tokensSelected: selection.tokensSelected,
          degradedReason,
        },
      });
    });
  }

  private async exact(executor: SqlExecutor, input: {
    tenantId: string;
    userId: string;
    workspaceId: string;
    taskId?: string;
  }, query: string): Promise<readonly RetrievalRow[]> {
    return executor.query<RetrievalRow>(`
      SELECT kc.id AS chunk_id, ks.id AS source_id, ks.source_id AS source_original_id,
             ks.source_type, ks.title, kc.text_content, kc.token_estimate, kc.metadata,
             ks.authority, ks.created_at, 1::double precision AS rank
      FROM knowledge_chunks kc
      JOIN knowledge_sources ks ON ks.id = kc.source_id
      WHERE kc.tenant_id = $1::uuid AND kc.workspace_id = $2::uuid
        AND ks.tenant_id = $1::uuid AND ks.workspace_id = $2::uuid
        AND ks.tombstoned_at IS NULL AND ks.index_status = 'indexed'
        AND (
          ks.visibility = 'project' OR
          (ks.visibility = 'private' AND ks.user_id = $3::uuid) OR
          (ks.visibility = 'task_only' AND EXISTS (
            SELECT 1
            FROM workspace_files task_file
            WHERE task_file.tenant_id = ks.tenant_id
              AND task_file.workspace_id = ks.workspace_id
              AND task_file.file_id::text = ks.source_id
              AND task_file.originating_task_id::text = $4
              AND task_file.deleted_at IS NULL
          ))
        )
        AND (
          lower(ks.title) = lower($5) OR
          ks.source_id = $5 OR
          ks.metadata->>'artifactId' = $5 OR
          ks.metadata->>'stableKey' = $5
        )
      ORDER BY ks.authority DESC, kc.ordinal ASC, kc.id
      LIMIT 20
    `, [input.tenantId, input.workspaceId, input.userId, input.taskId ?? "", query]);
  }

  private async fullText(executor: SqlExecutor, input: {
    tenantId: string;
    userId: string;
    workspaceId: string;
    taskId?: string;
  }, query: string): Promise<readonly RetrievalRow[]> {
    return executor.query<RetrievalRow>(`
      SELECT kc.id AS chunk_id, ks.id AS source_id, ks.source_id AS source_original_id, ks.source_type,
             ks.title, kc.text_content, kc.token_estimate, kc.metadata,
             ks.authority, ks.created_at,
             ts_rank_cd(kc.search_document, websearch_to_tsquery('simple', $5)) AS rank
      FROM knowledge_chunks kc
      JOIN knowledge_sources ks ON ks.id = kc.source_id
      WHERE kc.tenant_id = $1::uuid AND kc.workspace_id = $2::uuid
        AND ks.tenant_id = $1::uuid AND ks.workspace_id = $2::uuid
        AND ks.tombstoned_at IS NULL AND ks.index_status = 'indexed'
        AND (
          ks.visibility = 'project' OR
          (ks.visibility = 'private' AND ks.user_id = $3::uuid) OR
          (ks.visibility = 'task_only' AND EXISTS (
            SELECT 1
            FROM workspace_files task_file
            WHERE task_file.tenant_id = ks.tenant_id
              AND task_file.workspace_id = ks.workspace_id
              AND task_file.file_id::text = ks.source_id
              AND task_file.originating_task_id::text = $4
              AND task_file.deleted_at IS NULL
          ))
        )
        AND kc.search_document @@ websearch_to_tsquery('simple', $5)
      ORDER BY rank DESC, ks.authority DESC, kc.id
      LIMIT 60
    `, [input.tenantId, input.workspaceId, input.userId, input.taskId ?? "", query]);
  }

  private async vector(executor: SqlExecutor, input: {
    tenantId: string;
    userId: string;
    workspaceId: string;
    taskId?: string;
  }, queryVector: readonly number[]): Promise<readonly RetrievalRow[]> {
    return executor.query<RetrievalRow>(`
      SELECT kc.id AS chunk_id, ks.id AS source_id, ks.source_id AS source_original_id, ks.source_type,
             ks.title, kc.text_content, kc.token_estimate, kc.metadata,
             ks.authority, ks.created_at,
             1 - (kc.embedding <=> $5::vector) AS rank
      FROM knowledge_chunks kc
      JOIN knowledge_sources ks ON ks.id = kc.source_id
      WHERE kc.tenant_id = $1::uuid AND kc.workspace_id = $2::uuid
        AND ks.tenant_id = $1::uuid AND ks.workspace_id = $2::uuid
        AND ks.tombstoned_at IS NULL AND ks.index_status = 'indexed'
        AND kc.vector_ready = true AND kc.embedding IS NOT NULL
        AND (
          ks.visibility = 'project' OR
          (ks.visibility = 'private' AND ks.user_id = $3::uuid) OR
          (ks.visibility = 'task_only' AND EXISTS (
            SELECT 1
            FROM workspace_files task_file
            WHERE task_file.tenant_id = ks.tenant_id
              AND task_file.workspace_id = ks.workspace_id
              AND task_file.file_id::text = ks.source_id
              AND task_file.originating_task_id::text = $4
              AND task_file.deleted_at IS NULL
          ))
        )
      ORDER BY kc.embedding <=> $5::vector, ks.authority DESC, kc.id
      LIMIT 60
    `, [input.tenantId, input.workspaceId, input.userId, input.taskId ?? "", `[${queryVector.join(",")}]`]);
  }
}

function rowToRanked(row: RetrievalRow) {
  const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
    ? row.metadata as Record<string, unknown>
    : {};
  const page = typeof metadata.page === "number" ? metadata.page : null;
  const sourceOriginalId = typeof metadata.fileId === "string" ? metadata.fileId : row.source_original_id;
  const sourceDate = new Date(row.created_at);
  const timestamp = Number.isNaN(sourceDate.getTime()) ? "" : sourceDate.toISOString().slice(0, 10);
  const citationLabel = page
    ? `${row.title}, page ${page}`
    : row.source_type === "task_outcome" && timestamp
      ? `${row.title}, ${timestamp}`
      : row.title;
  return {
    chunkId: row.chunk_id,
    sourceId: row.source_id,
    sourceOriginalId,
    sourceType: row.source_type,
    title: row.title,
    text: row.text_content,
    tokenEstimate: row.token_estimate,
    authority: Number(row.authority),
    createdAt: new Date(row.created_at).toISOString(),
    citationLabel,
    metadata: {
      page,
      heading: typeof metadata.heading === "string" ? metadata.heading : null,
      slide: typeof metadata.slide === "number" ? metadata.slide : null,
      sheet: typeof metadata.sheet === "string" ? metadata.sheet : null,
      rowStart: typeof metadata.rowStart === "number" ? metadata.rowStart : null,
      rowEnd: typeof metadata.rowEnd === "number" ? metadata.rowEnd : null,
      turnId: typeof metadata.turnId === "string" ? metadata.turnId : null,
      sourceStart: typeof metadata.sourceStart === "number" ? metadata.sourceStart : null,
      sourceEnd: typeof metadata.sourceEnd === "number" ? metadata.sourceEnd : null,
    },
  };
}

function buildRetrievalQuery(input: {
  request: string;
  taskTitle?: string;
  checkpointGoal?: string;
  constraints?: string[];
  openItems?: string[];
}): string {
  return [
    input.request.trim(),
    input.taskTitle?.trim(),
    input.checkpointGoal?.trim(),
    ...(input.constraints ?? []).map((item) => item.trim()),
    ...(input.openItems ?? []).map((item) => item.trim()),
  ].filter((value): value is string => Boolean(value)).join("\n").slice(0, 12_000);
}

function emptyGrounding(
  queryHash: string,
  tokenBudget: number,
  degradedReason: GroundingContext["retrieval"]["degradedReason"],
): GroundingContext {
  return GroundingContextSchema.parse({
    personalMemory: [],
    projectFacts: [],
    citations: [],
    retrieval: { snapshotId: null, queryHash, tokenBudget, tokensSelected: 0, degradedReason },
  });
}

async function requireWorkspace(executor: SqlExecutor, input: {
  tenantId: string;
  userId: string;
  workspaceId: string;
}) {
  const rows = await executor.query<{ id: string }>(`
    SELECT w.id
    FROM workspaces w
    WHERE w.tenant_id = $1::uuid AND w.id = $2::uuid AND w.deleted_at IS NULL
      AND (
        w.owner_id = $3::uuid OR w.owner_id IS NULL OR
        EXISTS (
          SELECT 1 FROM tasks access_task
          WHERE access_task.tenant_id = w.tenant_id AND access_task.workspace_id = w.id
            AND access_task.user_id = $3::uuid AND access_task.deleted_at IS NULL
        )
      )
  `, [input.tenantId, input.workspaceId, input.userId]);
  if (rows.length === 0) throw new ForbiddenException("Workspace is not accessible");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function uniqueRows(rows: readonly RetrievalRow[]): RetrievalRow[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.chunk_id)) return false;
    seen.add(row.chunk_id);
    return true;
  });
}
