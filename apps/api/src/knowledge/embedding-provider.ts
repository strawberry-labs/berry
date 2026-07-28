import type { EmbeddingProfile, EmbeddingProvider } from "@berry/shared";

export function createApiEmbeddingProvider(
  env: NodeJS.ProcessEnv,
  config: { provider: string; model: string; dimensions: number; version: number },
): EmbeddingProvider | null {
  const baseUrl = env.BERRY_EMBEDDING_BASE_URL ?? env.BERRY_ROUTER_INFERENCE_BASE_URL;
  const apiKey = env.BERRY_EMBEDDING_API_KEY ?? env.BERRY_ROUTER_API_KEY;
  if (!baseUrl || !apiKey) return null;
  if (config.provider !== "openai-compatible") return null;
  return new FetchEmbeddingProvider(baseUrl, apiKey, {
    id: `${config.provider}:${config.model}:${config.dimensions}:v${config.version}`,
    provider: config.provider,
    model: config.model,
    dimensions: config.dimensions,
    version: config.version,
  });
}

class FetchEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    readonly profile: EmbeddingProfile,
  ) {}

  async embed(texts: readonly string[], options: { signal?: AbortSignal } = {}): Promise<readonly number[][]> {
    const response = await fetch(`${this.baseUrl.replace(/\/+$/, "")}/embeddings`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.profile.model, input: texts, dimensions: this.profile.dimensions }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok) throw new Error(`Embedding request failed with ${response.status}`);
    const payload = await response.json() as { data?: Array<{ index?: number; embedding?: number[] }> };
    const vectors = [...(payload.data ?? [])]
      .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
      .map((item) => item.embedding ?? []);
    if (vectors.length !== texts.length || vectors.some((vector) => vector.length !== this.profile.dimensions)) {
      throw new Error(`Embedding response must contain ${texts.length} vectors with ${this.profile.dimensions} dimensions`);
    }
    return vectors;
  }
}
