import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { MarkdownTextSplitter, RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import type { EmbeddingProfile, EmbeddingProvider } from "@berry/shared";
import { createHash } from "node:crypto";

export type KnowledgeObject = {
  bucket: string;
  key: string;
  mediaType: string;
  name: string;
};

export interface KnowledgeObjectStore {
  read(input: KnowledgeObject, maxBytes?: number): Promise<Uint8Array>;
  write(input: { bucket: string; key: string; mediaType: string; body: Uint8Array }): Promise<void>;
}

export class S3KnowledgeObjectStore implements KnowledgeObjectStore {
  constructor(
    private readonly client: S3Client,
    private readonly maxReadBytes = 100 * 1024 * 1024,
  ) {}

  static fromEnv(env: NodeJS.ProcessEnv): S3KnowledgeObjectStore {
    const endpoint = required(env.BERRY_ARTIFACT_S3_ENDPOINT, "BERRY_ARTIFACT_S3_ENDPOINT");
    const accessKeyId = required(env.BERRY_ARTIFACT_S3_ACCESS_KEY_ID, "BERRY_ARTIFACT_S3_ACCESS_KEY_ID");
    const secretAccessKey = required(env.BERRY_ARTIFACT_S3_SECRET_ACCESS_KEY, "BERRY_ARTIFACT_S3_SECRET_ACCESS_KEY");
    return new S3KnowledgeObjectStore(
      new S3Client({
        endpoint,
        region: env.BERRY_ARTIFACT_S3_REGION ?? "us-east-1",
        forcePathStyle: true,
        credentials: { accessKeyId, secretAccessKey },
      }),
      positiveInteger(env.BERRY_KNOWLEDGE_MAX_INPUT_BYTES, 100 * 1024 * 1024),
    );
  }

  async read(input: KnowledgeObject, maxBytes = this.maxReadBytes): Promise<Uint8Array> {
    const object = await this.client.send(new GetObjectCommand({ Bucket: input.bucket, Key: input.key }));
    if (!object.Body) throw new Error(`Knowledge object ${input.key} has no body`);
    if (object.ContentLength !== undefined && object.ContentLength > maxBytes) {
      throw new Error(`Knowledge object ${input.key} exceeds the ${maxBytes}-byte read limit`);
    }
    return readBoundedBody(object.Body as AsyncIterable<Uint8Array>, maxBytes, input.key);
  }

  async write(input: { bucket: string; key: string; mediaType: string; body: Uint8Array }): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: input.bucket,
      Key: input.key,
      ContentType: input.mediaType,
      Body: input.body,
    }));
  }
}

async function readBoundedBody(
  body: AsyncIterable<Uint8Array>,
  maxBytes: number,
  label: string,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const raw of body) {
    const chunk = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    total += chunk.byteLength;
    if (total > maxBytes) throw new Error(`Knowledge object ${label} exceeds the ${maxBytes}-byte read limit`);
    chunks.push(chunk);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

const DIRECT_TEXT_MEDIA = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/tab-separated-values",
  "application/json",
  "application/x-ndjson",
  "application/xml",
  "text/xml",
  "text/html",
]);

export class DocumentExtractor {
  constructor(
    private readonly tikaUrl: string,
    private readonly limits: { timeoutMs: number; maxInputBytes: number; maxOutputBytes: number } = {
      timeoutMs: 60_000,
      maxInputBytes: 100 * 1024 * 1024,
      maxOutputBytes: 25 * 1024 * 1024,
    },
  ) {}

  async extract(input: { bytes: Uint8Array; mediaType: string }): Promise<string> {
    if (input.bytes.byteLength > this.limits.maxInputBytes) throw new Error("Document exceeds the extraction size limit");
    if (DIRECT_TEXT_MEDIA.has(input.mediaType) || input.mediaType.startsWith("text/")) {
      return normalizeExtractedText(new TextDecoder("utf-8", { fatal: false }).decode(input.bytes));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Tika extraction timed out")), this.limits.timeoutMs);
    timer.unref?.();
    try {
      const response = await fetch(`${this.tikaUrl.replace(/\/+$/, "")}/tika`, {
        method: "PUT",
        headers: { Accept: "text/plain", "Content-Type": input.mediaType || "application/octet-stream" },
        body: Buffer.from(input.bytes),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Tika extraction failed with ${response.status}`);
      const length = Number(response.headers.get("content-length") ?? 0);
      if (length > this.limits.maxOutputBytes) throw new Error("Tika extraction response exceeds the size limit");
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > this.limits.maxOutputBytes) throw new Error("Tika extraction response exceeds the size limit");
      return normalizeExtractedText(text);
    } finally {
      clearTimeout(timer);
    }
  }
}

export type TextChunk = {
  ordinal: number;
  text: string;
  tokenEstimate: number;
  metadata: { heading?: string; sourceStart?: number; sourceEnd?: number; contentHash: string };
};

export class KnowledgeChunker {
  constructor(private readonly chunkTokens = 600, private readonly overlapTokens = 80) {}

  async chunk(text: string, mediaType: string): Promise<TextChunk[]> {
    const splitterOptions = {
      chunkSize: this.chunkTokens,
      chunkOverlap: this.overlapTokens,
      keepSeparator: true,
      lengthFunction: estimateTokens,
    };
    const splitter = mediaType === "text/markdown"
      ? new MarkdownTextSplitter(splitterOptions)
      : new RecursiveCharacterTextSplitter(splitterOptions);
    const chunks = await splitter.splitText(text);
    let cursor = 0;
    return chunks.flatMap((chunk, ordinal) => {
      const normalized = chunk.trim();
      if (!normalized) return [];
      const sourceStart = Math.max(0, text.indexOf(normalized.slice(0, 120), cursor));
      const sourceEnd = sourceStart + normalized.length;
      cursor = Math.max(sourceStart, sourceEnd - this.overlapTokens * 4);
      const heading = normalized.match(/^#{1,6}\s+(.+)$/m)?.[1]?.trim();
      return [{
        ordinal,
        text: normalized,
        tokenEstimate: estimateTokens(normalized),
        metadata: {
          ...(heading ? { heading } : {}),
          sourceStart,
          sourceEnd,
          contentHash: createHash("sha256").update(normalized).digest("hex"),
        },
      }];
    });
  }
}

export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly profile: EmbeddingProfile;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    profile: EmbeddingProfile,
  ) {
    this.profile = profile;
  }

  async embed(texts: readonly string[], options: { signal?: AbortSignal } = {}): Promise<readonly number[][]> {
    if (texts.length === 0) return [];
    const response = await fetch(`${this.baseUrl.replace(/\/+$/, "")}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: this.profile.model, input: texts, dimensions: this.profile.dimensions }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok) throw new Error(`Embedding request failed with ${response.status}`);
    const payload = await response.json() as { data?: Array<{ index?: number; embedding?: number[] }> };
    const vectors = [...(payload.data ?? [])]
      .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
      .map((item) => item.embedding ?? []);
    if (vectors.length !== texts.length) throw new Error("Embedding response count does not match the request");
    for (const vector of vectors) {
      if (vector.length !== this.profile.dimensions || vector.some((value) => !Number.isFinite(value))) {
        throw new Error(`Embedding dimension mismatch: expected ${this.profile.dimensions}`);
      }
    }
    return vectors;
  }
}

export function createEmbeddingProviderFromEnv(env: NodeJS.ProcessEnv, input: {
  provider: string;
  model: string;
  dimensions: number;
  version: number;
}): EmbeddingProvider | null {
  if (input.provider !== "openai-compatible") throw new Error(`Unsupported embedding provider: ${input.provider}`);
  const baseUrl = env.BERRY_EMBEDDING_BASE_URL ?? env.BERRY_ROUTER_INFERENCE_BASE_URL;
  const apiKey = env.BERRY_EMBEDDING_API_KEY ?? env.BERRY_ROUTER_API_KEY;
  if (!baseUrl || !apiKey) return null;
  return new OpenAICompatibleEmbeddingProvider(baseUrl, apiKey, {
    id: `${input.provider}:${input.model}:${input.dimensions}:v${input.version}`,
    provider: input.provider,
    model: input.model,
    dimensions: input.dimensions,
    version: input.version,
  });
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function normalizeExtractedText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\0/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required for knowledge ingestion`);
  return value.trim();
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
