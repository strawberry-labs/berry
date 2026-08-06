import { createHash } from "node:crypto";
import type { EmbeddingProvider } from "@berry/shared";
import type { KnowledgeIndexTaskJobPayload, KnowledgeRevisionJobPayload } from "../jobs.js";
import { knowledgeDerivativeKey, SqlKnowledgeRepository } from "./repository.js";
import { DocumentExtractor, KnowledgeChunker, type KnowledgeObjectStore } from "./services.js";

const EMBEDDING_BATCH_SIZE = 32;

export type KnowledgeJobName =
  | "knowledge.extract"
  | "knowledge.chunk"
  | "knowledge.embed"
  | "knowledge.index-task"
  | "knowledge.delete"
  | "knowledge.reindex";

export type KnowledgeProcessorDependencies = {
  repository: SqlKnowledgeRepository;
  objects: KnowledgeObjectStore;
  extractor: DocumentExtractor;
  chunker: KnowledgeChunker;
  embeddings: EmbeddingProvider | null;
};

export class KnowledgeProcessor {
  constructor(private readonly dependencies: KnowledgeProcessorDependencies) {}

  async process(name: KnowledgeJobName, payload: KnowledgeRevisionJobPayload | KnowledgeIndexTaskJobPayload): Promise<unknown> {
    if (name === "knowledge.index-task") return this.indexTask(payload as KnowledgeIndexTaskJobPayload);
    const revisionPayload = payload as KnowledgeRevisionJobPayload;
    if (name === "knowledge.extract") return this.extract(revisionPayload);
    if (name === "knowledge.chunk") return this.chunk(revisionPayload);
    if (name === "knowledge.embed") return this.embed(revisionPayload);
    if (name === "knowledge.delete") return this.dependencies.repository.deleteSource(revisionPayload.tenantId, revisionPayload.sourceId, revisionPayload.revision);
    return this.dependencies.repository.resetForReindex(revisionPayload.tenantId, revisionPayload.sourceId, revisionPayload.revision);
  }

  private async extract(payload: KnowledgeRevisionJobPayload): Promise<{ stale: boolean; bytes?: number }> {
    const claimed = await this.dependencies.repository.markExtracting(payload.tenantId, payload.sourceId, payload.revision);
    if (!claimed) {
      await this.dependencies.repository.cleanupUnclaimedExtraction(
        payload.tenantId,
        payload.sourceId,
        payload.revision,
      );
      return { stale: true };
    }
    const source = await this.dependencies.repository.loadSource(payload.tenantId, payload.sourceId, payload.revision);
    if (!source || source.tombstonedAt) return { stale: true };
    if (source.sourceType !== "file" || !source.bucket || !source.objectKey) {
      await this.dependencies.repository.markFailed(payload.tenantId, payload.sourceId, payload.revision, "Source has no file object");
      throw new Error("Knowledge file source has no object-storage location");
    }
    try {
      if (source.derivativeObjectKey) {
        await this.dependencies.repository.reuseExtraction(payload.tenantId, source);
        return { stale: false };
      }
      const bytes = await this.dependencies.objects.read({
        bucket: source.bucket,
        key: source.objectKey,
        mediaType: source.mediaType,
        name: source.title,
      });
      const text = await this.dependencies.extractor.extract({ bytes, mediaType: source.mediaType });
      if (!text) throw new Error("Document extraction produced no text");
      const encoded = new TextEncoder().encode(text);
      const derivativeObjectKey = knowledgeDerivativeKey(source.objectKey, source.revision);
      await this.dependencies.objects.write({
        bucket: source.bucket,
        key: derivativeObjectKey,
        mediaType: "text/plain; charset=utf-8",
        body: encoded,
      });
      const saved = await this.dependencies.repository.saveExtraction({
        tenantId: payload.tenantId,
        source,
        derivativeObjectKey,
        mediaType: "text/plain; charset=utf-8",
        sizeBytes: encoded.byteLength,
        contentHash: createHash("sha256").update(encoded).digest("hex"),
      });
      return saved ? { stale: false, bytes: encoded.byteLength } : { stale: true };
    } catch (error) {
      await this.dependencies.repository.markFailed(
        payload.tenantId,
        payload.sourceId,
        payload.revision,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  private async chunk(payload: KnowledgeRevisionJobPayload): Promise<{ stale: boolean; chunks?: number }> {
    const source = await this.dependencies.repository.loadSource(payload.tenantId, payload.sourceId, payload.revision);
    if (!source || source.tombstonedAt) return { stale: true };
    try {
      let text = source.inlineText;
      if (!text && source.bucket && source.derivativeObjectKey) {
        const bytes = await this.dependencies.objects.read({
          bucket: source.bucket,
          key: source.derivativeObjectKey,
          mediaType: "text/plain",
          name: source.title,
        });
        text = new TextDecoder().decode(bytes);
      }
      if (!text) throw new Error("Extracted source text is unavailable");
      const chunks = await this.dependencies.chunker.chunk(text, source.mediaType);
      if (chunks.length === 0) throw new Error("Chunking produced no searchable text");
      await this.dependencies.repository.replaceChunks({ tenantId: payload.tenantId, source, chunks });
      return { stale: false, chunks: chunks.length };
    } catch (error) {
      await this.dependencies.repository.markFailed(
        payload.tenantId,
        payload.sourceId,
        payload.revision,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  private async embed(payload: KnowledgeRevisionJobPayload): Promise<{ stale: boolean; vectors?: number; degraded?: boolean }> {
    const source = await this.dependencies.repository.loadSource(payload.tenantId, payload.sourceId, payload.revision);
    if (!source || source.tombstonedAt) return { stale: true };
    const chunks = await this.dependencies.repository.listChunks(payload.tenantId, payload.sourceId, payload.revision);
    if (chunks.length === 0) return { stale: true };
    if (!this.dependencies.embeddings) {
      await this.dependencies.repository.markEmbeddingRetryable(payload.tenantId, payload.sourceId, payload.revision, "Embedding provider is unavailable; full-text search remains active");
      return { stale: false, degraded: true };
    }
    try {
      const vectors: number[][] = [];
      for (let offset = 0; offset < chunks.length; offset += EMBEDDING_BATCH_SIZE) {
        const batch = chunks.slice(offset, offset + EMBEDDING_BATCH_SIZE);
        vectors.push(...await this.dependencies.embeddings.embed(batch.map((chunk) => chunk.text)) as number[][]);
      }
      await this.dependencies.repository.saveEmbeddings({
        tenantId: payload.tenantId,
        source,
        chunks,
        vectors,
        profile: this.dependencies.embeddings.profile,
      });
      return { stale: false, vectors: vectors.length };
    } catch (error) {
      await this.dependencies.repository.markEmbeddingRetryable(
        payload.tenantId,
        payload.sourceId,
        payload.revision,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  private async indexTask(payload: KnowledgeIndexTaskJobPayload): Promise<{ stale: boolean; chunks?: number }> {
    const result = await this.dependencies.repository.createTaskOutcomeSource(payload);
    if (!result) return { stale: true };
    const chunks = await this.dependencies.chunker.chunk(result.text, "text/markdown");
    await this.dependencies.repository.replaceChunks({ tenantId: payload.tenantId, source: result.source, chunks });
    return { stale: false, chunks: chunks.length };
  }
}
