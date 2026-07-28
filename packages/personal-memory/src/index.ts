import {
  MemoryItemSchema,
  normalizeMemoryStableKey,
  type MemoryItem,
  type MemoryOperation,
} from "@berry/shared";

export type PersonalMemoryIdentity = {
  tenantId: string;
  userId: string;
};

export type PersonalMemorySource = {
  actorUserId: string | null;
  taskId: string | null;
  sessionId: string | null;
  messageId: string | null;
  extractorVersion: string;
};

export type PersonalMemoryMutation = {
  operation: "ADD" | "SUPERSEDE" | "REFRESH" | "NOOP";
  reason: string;
  item: MemoryItem | null;
};

export type PersonalMemoryMessage = {
  role: "user" | "assistant";
  content: string;
};

export type PersonalMemoryRecord = {
  id: string;
  memory: string;
  score?: number;
  hash?: string;
  createdAt?: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
};

export interface PersonalMemoryProvider {
  remember(input: PersonalMemoryIdentity & {
    kind: string;
    stableKey: string;
    content: string;
    value: Record<string, unknown>;
    confidence: number;
    salience: number;
    explicit: boolean;
    expiresAt: string | null;
    source: PersonalMemorySource;
  }): Promise<PersonalMemoryMutation>;
  ingestConversation(input: PersonalMemoryIdentity & {
    messages: readonly PersonalMemoryMessage[];
    source: PersonalMemorySource;
    idempotencyKey: string;
  }): Promise<{ items: MemoryItem[]; replayed: boolean }>;
  list(input: PersonalMemoryIdentity & {
    status?: string;
    search?: string;
    cursor?: string;
    limit: number;
  }): Promise<{ items: MemoryItem[]; nextCursor: string | null }>;
  get(identity: PersonalMemoryIdentity, memoryId: string): Promise<MemoryItem | null>;
  search(input: PersonalMemoryIdentity & {
    query: string;
    limit: number;
  }): Promise<MemoryItem[]>;
  update(input: PersonalMemoryIdentity & {
    memoryId: string;
    content: string;
    kind?: string;
    value?: Record<string, unknown>;
    confidence?: number;
    salience?: number;
    expiresAt?: string | null;
    source: PersonalMemorySource;
  }): Promise<PersonalMemoryMutation>;
  forget(identity: PersonalMemoryIdentity, memoryId: string): Promise<MemoryItem | null>;
  clear(identity: PersonalMemoryIdentity): Promise<{ forgotten: number }>;
  export(identity: PersonalMemoryIdentity): Promise<{ items: MemoryItem[]; versions: unknown[] }>;
  health(): Promise<boolean>;
}

export class PersonalMemoryHttpError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "PersonalMemoryHttpError";
  }
}

export class SelfHostedMem0PersonalMemoryProvider implements PersonalMemoryProvider {
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: {
    baseUrl: string;
    apiKey: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
  }) {
    this.#baseUrl = `${options.baseUrl.trim().replace(/\/+$/, "")}/`;
    this.#apiKey = options.apiKey.trim();
    this.#timeoutMs = Math.max(1_000, options.timeoutMs ?? 30_000);
    this.#fetch = options.fetchImpl ?? fetch;
    if (!this.#baseUrl.startsWith("http://") && !this.#baseUrl.startsWith("https://")) {
      throw new Error("BERRY_MEM0_BASE_URL must use http:// or https://");
    }
    if (this.#apiKey.length < 16) throw new Error("BERRY_MEM0_API_KEY must be at least 16 characters");
  }

  async remember(input: PersonalMemoryIdentity & {
    kind: string;
    stableKey: string;
    content: string;
    value: Record<string, unknown>;
    confidence: number;
    salience: number;
    explicit: boolean;
    expiresAt: string | null;
    source: PersonalMemorySource;
  }): Promise<PersonalMemoryMutation> {
    const response = await this.request<Mem0MutationResponse>("v1/memories", {
      method: "POST",
      body: JSON.stringify({
        tenantId: input.tenantId,
        userId: input.userId,
        messages: [{ role: "user", content: input.content }],
        infer: false,
        stableKey: input.stableKey,
        metadata: berryMetadata(input),
        expirationDate: expirationDate(input.expiresAt),
      }),
    });
    return {
      operation: response.operation ?? "ADD",
      reason: response.operation === "SUPERSEDE" ? "mem0_explicit_upsert" : "mem0_personal_memory",
      item: response.results[0] ? memoryItemFromRecord(response.results[0], input) : null,
    };
  }

  async ingestConversation(input: PersonalMemoryIdentity & {
    messages: readonly PersonalMemoryMessage[];
    source: PersonalMemorySource;
    idempotencyKey: string;
  }): Promise<{ items: MemoryItem[]; replayed: boolean }> {
    const response = await this.request<Mem0MutationResponse>("v1/memories", {
      method: "POST",
      body: JSON.stringify({
        tenantId: input.tenantId,
        userId: input.userId,
        messages: input.messages,
        infer: true,
        idempotencyKey: input.idempotencyKey,
        metadata: berryMetadata({
          ...input,
          kind: "profile",
          stableKey: "",
          value: {},
          confidence: 0.75,
          salience: 0.7,
          explicit: false,
          expiresAt: null,
        }),
      }),
    });
    return {
      items: response.results.map((record) => memoryItemFromRecord(record, input)),
      replayed: response.operation === "NOOP",
    };
  }

  async list(input: PersonalMemoryIdentity & {
    status?: string;
    search?: string;
    cursor?: string;
    limit: number;
  }): Promise<{ items: MemoryItem[]; nextCursor: string | null }> {
    if (input.status && input.status !== "active") return { items: [], nextCursor: null };
    const offset = decodeCursor(input.cursor);
    const query = new URLSearchParams({
      tenantId: input.tenantId,
      userId: input.userId,
      limit: String(Math.min(10_000, offset + input.limit + 1)),
    });
    const response = await this.request<Mem0ListResponse>(`v1/memories?${query}`, { method: "GET" }, true);
    const search = input.search?.trim().toLocaleLowerCase();
    const all = response.results
      .map((record) => memoryItemFromRecord(record, input))
      .filter((item) => !search || item.content.toLocaleLowerCase().includes(search) || item.stableKey.includes(search));
    const items = all.slice(offset, offset + input.limit);
    return {
      items,
      nextCursor: all.length > offset + input.limit ? encodeCursor(offset + input.limit) : null,
    };
  }

  async get(identity: PersonalMemoryIdentity, memoryId: string): Promise<MemoryItem | null> {
    const query = new URLSearchParams(identity);
    const response = await this.request<PersonalMemoryRecord | null>(
      `v1/memories/${encodeURIComponent(memoryId)}?${query}`,
      { method: "GET" },
      true,
      true,
    );
    return response ? memoryItemFromRecord(response, identity) : null;
  }

  async search(input: PersonalMemoryIdentity & { query: string; limit: number }): Promise<MemoryItem[]> {
    const response = await this.request<Mem0ListResponse>("v1/search", {
      method: "POST",
      body: JSON.stringify({
        tenantId: input.tenantId,
        userId: input.userId,
        query: input.query,
        limit: input.limit,
      }),
    }, true);
    return response.results.map((record) => memoryItemFromRecord(record, input));
  }

  async update(input: PersonalMemoryIdentity & {
    memoryId: string;
    content: string;
    kind?: string;
    value?: Record<string, unknown>;
    confidence?: number;
    salience?: number;
    expiresAt?: string | null;
    source: PersonalMemorySource;
  }): Promise<PersonalMemoryMutation> {
    const current = await this.get(input, input.memoryId);
    if (!current) return { operation: "NOOP", reason: "memory_not_found", item: null };
    const metadata = berryMetadata({
      ...input,
      kind: input.kind ?? current.kind,
      stableKey: current.stableKey,
      value: input.value ?? current.value,
      confidence: input.confidence ?? Math.max(current.confidence, 0.9),
      salience: input.salience ?? current.salience,
      explicit: true,
      expiresAt: input.expiresAt === undefined ? current.expiresAt : input.expiresAt,
    });
    const response = await this.request<PersonalMemoryRecord>(
      `v1/memories/${encodeURIComponent(input.memoryId)}`,
      {
        method: "PUT",
        body: JSON.stringify({
          tenantId: input.tenantId,
          userId: input.userId,
          text: input.content,
          metadata,
          ...(input.expiresAt !== undefined ? { expirationDate: expirationDate(input.expiresAt) } : {}),
        }),
      },
    );
    return {
      operation: "SUPERSEDE",
      reason: "mem0_explicit_update",
      item: memoryItemFromRecord(response, input),
    };
  }

  async forget(identity: PersonalMemoryIdentity, memoryId: string): Promise<MemoryItem | null> {
    const response = await this.request<PersonalMemoryRecord | null>(
      `v1/memories/${encodeURIComponent(memoryId)}`,
      {
        method: "DELETE",
        body: JSON.stringify(identity),
      },
      false,
      true,
    );
    return response ? MemoryItemSchema.parse({ ...memoryItemFromRecord(response, identity), status: "forgotten" }) : null;
  }

  async clear(identity: PersonalMemoryIdentity): Promise<{ forgotten: number }> {
    const query = new URLSearchParams(identity);
    return this.request<{ forgotten: number }>(`v1/memories?${query}`, { method: "DELETE" });
  }

  async export(identity: PersonalMemoryIdentity): Promise<{ items: MemoryItem[]; versions: unknown[] }> {
    const page = await this.list({ ...identity, limit: 10_000 });
    return { items: page.items, versions: [] };
  }

  async health(): Promise<boolean> {
    try {
      const response = await this.request<{ ok: boolean }>("healthz", { method: "GET" }, true);
      return response.ok;
    } catch {
      return false;
    }
  }

  private async request<T>(
    path: string,
    init: RequestInit,
    retryRead = false,
    notFoundIsNull = false,
  ): Promise<T> {
    const attempts = retryRead ? 2 : 1;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await this.#fetch(new URL(path, this.#baseUrl), {
          ...init,
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${this.#apiKey}`,
            ...(init.body ? { "Content-Type": "application/json" } : {}),
            ...init.headers,
          },
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
        if (response.status === 404 && notFoundIsNull) return null as T;
        if (!response.ok) {
          const body = (await response.text()).slice(0, 2_000);
          const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
          const error = new PersonalMemoryHttpError(
            `Self-hosted Mem0 returned ${response.status}: ${body || response.statusText}`,
            response.status,
            retryable,
          );
          if (!retryable || attempt + 1 >= attempts) throw error;
          lastError = error;
          continue;
        }
        return await response.json() as T;
      } catch (error) {
        lastError = error;
        const retryable = !(error instanceof PersonalMemoryHttpError) || error.retryable;
        if (!retryable || attempt + 1 >= attempts) {
          if (error instanceof PersonalMemoryHttpError) throw error;
          throw new PersonalMemoryHttpError(
            `Self-hosted Mem0 request failed: ${error instanceof Error ? error.message : String(error)}`,
            null,
            true,
          );
        }
      }
    }
    throw lastError;
  }
}

export function createPersonalMemoryProviderFromEnv(
  env: NodeJS.ProcessEnv,
  fetchImpl?: typeof fetch,
): PersonalMemoryProvider | null {
  const provider = (env.BERRY_PERSONAL_MEMORY_PROVIDER?.trim().toLocaleLowerCase() || "auto");
  if (provider === "berry") return null;
  if (provider !== "auto" && provider !== "mem0") {
    throw new Error("BERRY_PERSONAL_MEMORY_PROVIDER must be auto, mem0, or berry");
  }
  const baseUrl = env.BERRY_MEM0_BASE_URL?.trim();
  const apiKey = env.BERRY_MEM0_API_KEY?.trim();
  if (!baseUrl || !apiKey) {
    if (provider === "mem0") {
      throw new Error("BERRY_MEM0_BASE_URL and BERRY_MEM0_API_KEY are required when personal memory provider is mem0");
    }
    return null;
  }
  return new SelfHostedMem0PersonalMemoryProvider({
    baseUrl,
    apiKey,
    timeoutMs: positiveInteger(env.BERRY_MEM0_TIMEOUT_MS, 30_000),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

export function personalMemoryScopeId(identity: PersonalMemoryIdentity): string {
  return `berry:${identity.tenantId}:${identity.userId}`;
}

export function memoryItemFromRecord(
  record: PersonalMemoryRecord,
  identity: PersonalMemoryIdentity,
): MemoryItem {
  const metadata = asRecord(record.metadata);
  const createdAt = dateTime(record.createdAt ?? metadata.berry_created_at) ?? new Date().toISOString();
  const updatedAt = dateTime(record.updatedAt ?? metadata.berry_updated_at) ?? createdAt;
  return MemoryItemSchema.parse({
    id: record.id,
    tenantId: identity.tenantId,
    userId: identity.userId,
    workspaceId: null,
    scope: "personal",
    kind: stringValue(metadata.berry_kind) ?? "profile",
    stableKey: normalizeMemoryStableKey(stringValue(metadata.berry_stable_key) ?? `mem0:${record.id}`),
    content: record.memory.trim(),
    value: asRecord(metadata.berry_value),
    status: "active",
    explicit: booleanValue(metadata.berry_explicit) ?? false,
    confidence: unitNumber(metadata.berry_confidence, 0.75),
    salience: unitNumber(metadata.berry_salience, 0.7),
    validFrom: null,
    validUntil: null,
    expiresAt: dateTime(metadata.berry_expires_at),
    extractorVersion: stringValue(metadata.berry_extractor_version) ?? "mem0-oss",
    sourceTaskId: stringValue(metadata.berry_source_task_id),
    sourceSessionId: stringValue(metadata.berry_source_session_id),
    sourceMessageId: stringValue(metadata.berry_source_message_id),
    supersededItemId: null,
    lastSeenAt: updatedAt,
    lastUsedAt: record.score === undefined ? null : new Date().toISOString(),
    createdAt,
    updatedAt,
  });
}

export function operationToPersonalMemoryInput(
  identity: PersonalMemoryIdentity,
  operation: MemoryOperation,
  source: PersonalMemorySource,
) {
  return {
    ...identity,
    kind: operation.kind,
    stableKey: operation.stableKey,
    content: operation.content,
    value: operation.value,
    confidence: operation.confidence,
    salience: operation.salience,
    explicit: operation.explicit,
    expiresAt: operation.expiresAt,
    source,
  };
}

function berryMetadata(input: PersonalMemoryIdentity & {
  kind: string;
  stableKey: string;
  value: Record<string, unknown>;
  confidence: number;
  salience: number;
  explicit: boolean;
  expiresAt: string | null;
  source: PersonalMemorySource;
}): Record<string, unknown> {
  return {
    berry_tenant_id: input.tenantId,
    berry_user_id: input.userId,
    berry_kind: input.kind,
    ...(input.stableKey ? { berry_stable_key: normalizeMemoryStableKey(input.stableKey) } : {}),
    berry_value: input.value,
    berry_confidence: input.confidence,
    berry_salience: input.salience,
    berry_explicit: input.explicit,
    berry_expires_at: input.expiresAt,
    berry_extractor_version: input.source.extractorVersion,
    berry_source_task_id: input.source.taskId,
    berry_source_session_id: input.source.sessionId,
    berry_source_message_id: input.source.messageId,
    berry_updated_at: new Date().toISOString(),
  };
}

function expirationDate(value: string | null): string | null {
  return value ? value.slice(0, 10) : null;
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const parsed = Number(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("Invalid personal memory cursor");
  return parsed;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function unitNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : fallback;
}

function dateTime(value: unknown): string | null {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

type Mem0ListResponse = {
  results: PersonalMemoryRecord[];
};

type Mem0MutationResponse = Mem0ListResponse & {
  operation?: "ADD" | "SUPERSEDE" | "REFRESH" | "NOOP";
};
