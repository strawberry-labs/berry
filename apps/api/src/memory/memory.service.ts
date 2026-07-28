import { Inject, Injectable } from "@nestjs/common";
import {
  MemoryOperationSchema,
  durableContextConfigFromEnv,
  normalizeMemoryStableKey,
  type MemoryItem,
  type MemoryOperation,
  type MemoryScope,
} from "@berry/shared";
import { createHash } from "node:crypto";
import { CloudDatabaseService } from "../db/cloud-database.service.js";
import {
  SqlMemoryRepository,
  type MemoryIdentity,
  type MemoryMutationResult,
  type MemoryRepository,
  type MemorySource,
} from "./memory.repository.js";

export const MEMORY_REPOSITORY = Symbol("MEMORY_REPOSITORY");

export type MemoryRecall = {
  personal: MemoryItem[];
  project: MemoryItem[];
  personalTokens: number;
  projectTokens: number;
};

@Injectable()
export class MemoryService {
  readonly #config = durableContextConfigFromEnv(process.env);

  constructor(
    @Inject(MEMORY_REPOSITORY) private readonly repository: MemoryRepository,
    @Inject(CloudDatabaseService) private readonly database: CloudDatabaseService,
  ) {}

  list(input: {
    tenantId: string;
    userId: string;
    scope: MemoryScope;
    workspaceId?: string | null;
    status?: string;
    search?: string;
    cursor?: string;
    limit?: number;
  }) {
    const identity = memoryIdentity(input);
    return this.repository.list({
      ...identity,
      ...(input.status ? { status: input.status } : {}),
      ...(input.search ? { search: input.search } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {}),
      limit: Math.min(100, Math.max(1, input.limit ?? 50)),
    });
  }

  get(tenantId: string, userId: string, memoryId: string): Promise<MemoryItem> {
    return this.repository.get(tenantId, userId, memoryId);
  }

  settings(tenantId: string, userId: string) {
    return this.repository.settings(tenantId, userId);
  }

  updateSettings(tenantId: string, userId: string, input: {
    memoryEnabled?: boolean;
    implicitMemoryEnabled?: boolean;
  }) {
    return this.repository.updateSettings(tenantId, userId, input);
  }

  async remember(input: {
    tenantId: string;
    userId: string;
    scope: MemoryScope;
    workspaceId?: string | null;
    kind: string;
    stableKey?: string;
    content: string;
    value?: Record<string, unknown>;
    confidence?: number;
    salience?: number;
    expiresAt?: string | null;
    source?: Partial<MemorySource>;
  }): Promise<MemoryMutationResult> {
    const identity = memoryIdentity(input);
    if (identity.scope === "project") {
      await this.repository.assertWorkspaceAccess(identity.tenantId, identity.userId, identity.workspaceId!);
    }
    const stableKey = normalizedOrDerivedKey(input.stableKey, input.kind, input.content);
    const operation = MemoryOperationSchema.parse({
      operation: "ADD",
      stableKey,
      kind: input.kind.trim(),
      content: input.content.trim(),
      value: input.value ?? {},
      confidence: input.confidence ?? 1,
      salience: input.salience ?? 0.8,
      explicit: true,
      targetItemId: null,
      expiresAt: input.expiresAt ?? null,
      reason: "explicit_user_memory",
    });
    return this.repository.apply(identity, operation, sourceWithDefaults(input.userId, input.source, "explicit-v1"));
  }

  async update(input: {
    tenantId: string;
    userId: string;
    memoryId: string;
    content: string;
    kind?: string;
    value?: Record<string, unknown>;
    confidence?: number;
    salience?: number;
    expiresAt?: string | null;
  }): Promise<MemoryMutationResult> {
    const current = await this.repository.get(input.tenantId, input.userId, input.memoryId);
    const operation = MemoryOperationSchema.parse({
      operation: "SUPERSEDE",
      stableKey: current.stableKey,
      kind: input.kind ?? current.kind,
      content: input.content.trim(),
      value: input.value ?? current.value,
      confidence: input.confidence ?? Math.max(current.confidence, 0.9),
      salience: input.salience ?? current.salience,
      explicit: true,
      targetItemId: current.id,
      expiresAt: input.expiresAt === undefined ? current.expiresAt : input.expiresAt,
      reason: "explicit_user_update",
    });
    return this.repository.apply({
      tenantId: current.tenantId,
      userId: current.userId,
      workspaceId: current.workspaceId,
      scope: current.scope,
    }, operation, sourceWithDefaults(input.userId, {}, "explicit-v1"));
  }

  forget(tenantId: string, userId: string, memoryId: string): Promise<MemoryItem> {
    return this.repository.forget(tenantId, userId, memoryId, sourceWithDefaults(userId, {}, "explicit-v1"));
  }

  async forgetMatching(input: {
    tenantId: string;
    userId: string;
    scope: MemoryScope;
    workspaceId?: string | null;
    stableKey: string;
  }): Promise<MemoryItem | null> {
    const identity = memoryIdentity(input);
    const page = await this.repository.list({
      ...identity,
      status: "active",
      search: normalizeMemoryStableKey(input.stableKey),
      limit: 20,
    });
    const item = page.items.find((candidate) => candidate.stableKey === normalizeMemoryStableKey(input.stableKey));
    return item ? this.forget(input.tenantId, input.userId, item.id) : null;
  }

  export(tenantId: string, userId: string) {
    return this.repository.export(tenantId, userId);
  }

  async clear(input: {
    tenantId: string;
    userId: string;
    scope: MemoryScope;
    workspaceId?: string | null;
  }): Promise<{ ok: true; forgotten: number }> {
    const identity = memoryIdentity(input);
    if (identity.scope === "project") {
      await this.repository.assertWorkspaceAccess(identity.tenantId, identity.userId, identity.workspaceId!);
    }
    let forgotten = 0;
    for (let batch = 0; batch < 1_000; batch += 1) {
      const page = await this.repository.list({ ...identity, status: "active", limit: 100 });
      if (page.items.length === 0) return { ok: true, forgotten };
      for (const item of page.items) {
        await this.repository.forget(
          input.tenantId,
          input.userId,
          item.id,
          sourceWithDefaults(input.userId, {}, "explicit-v1"),
        );
        forgotten += 1;
      }
    }
    throw new Error("Memory clear exceeded the bounded 100,000-item safety limit");
  }

  async applyImplicit(input: {
    tenantId: string;
    userId: string;
    scope: MemoryScope;
    workspaceId?: string | null;
    operations: readonly MemoryOperation[];
    source: MemorySource;
  }): Promise<MemoryMutationResult[]> {
    const identity = memoryIdentity(input);
    const results: MemoryMutationResult[] = [];
    for (const raw of input.operations) {
      const operation = MemoryOperationSchema.parse({
        ...raw,
        stableKey: normalizeMemoryStableKey(raw.stableKey),
        explicit: false,
      });
      results.push(await this.repository.apply(identity, operation, input.source));
    }
    return results;
  }

  async recall(input: {
    tenantId: string;
    userId: string;
    workspaceId: string;
    query: string;
    personalTokenBudget?: number;
    projectTokenBudget?: number;
  }): Promise<MemoryRecall> {
    if (!this.#config.memoryEnabled) return { personal: [], project: [], personalTokens: 0, projectTokens: 0 };
    const candidates = await this.repository.recall({
      tenantId: input.tenantId,
      userId: input.userId,
      workspaceId: input.workspaceId,
      query: input.query,
      limit: 40,
    });
    const personalSelection = selectMemoryBudget(
      candidates.filter((item) => item.scope === "personal"),
      input.personalTokenBudget ?? 900,
    );
    const projectSelection = selectMemoryBudget(
      candidates.filter((item) => item.scope === "project"),
      input.projectTokenBudget ?? 900,
    );
    return {
      personal: personalSelection.items,
      project: projectSelection.items,
      personalTokens: personalSelection.tokens,
      projectTokens: projectSelection.tokens,
    };
  }

  async enqueueExtraction(input: {
    tenantId: string;
    userId: string;
    workspaceId: string;
    taskId: string;
    sessionId: string;
    revision: string;
  }): Promise<void> {
    if (!this.#config.memoryEnabled || !this.#config.implicitMemoryEnabled) return;
    await this.database.withTenant(input.tenantId, async (executor) => {
      const [settings] = await executor.query<{ memory_enabled: boolean; implicit_memory_enabled: boolean }>(`
        SELECT memory_enabled, implicit_memory_enabled
        FROM memory_settings
        WHERE tenant_id = $1::uuid AND user_id = $2::uuid
      `, [input.tenantId, input.userId]);
      if (settings && (!settings.memory_enabled || !settings.implicit_memory_enabled)) return;
      const rows = await executor.query<{ id: string; role: "user" | "assistant"; text_content: string }>(`
        SELECT m.id, m.role::text,
               string_agg(
                 CASE
                   WHEN jsonb_typeof(mp.content) = 'string' THEN mp.content #>> '{}'
                   ELSE COALESCE(mp.content->>'text', mp.content->>'content', '')
                 END,
                 E'\n' ORDER BY mp.ordinal
               ) AS text_content
        FROM messages m
        JOIN message_parts mp ON mp.message_id = m.id AND mp.tenant_id = m.tenant_id
        WHERE m.tenant_id = $1::uuid AND m.session_id = $2::uuid
          AND m.status = 'complete' AND m.role IN ('user', 'assistant')
          AND mp.type = 'text'
        GROUP BY m.id, m.role, m.sequence_id
        ORDER BY m.sequence_id DESC
        LIMIT 8
      `, [input.tenantId, input.sessionId]);
      const user = rows.find((row) => row.role === "user" && row.text_content.trim());
      const assistant = rows.find((row) => row.role === "assistant" && row.text_content.trim());
      if (!user || !assistant) return;
      const extractorVersion = "memory-extractor-v1";
      const dedupeKey = sha256([
        input.tenantId,
        input.userId,
        user.id,
        assistant.id,
        input.revision,
        extractorVersion,
      ].join(":"));
      await executor.execute(`
        INSERT INTO runtime_outbox (
          tenant_id, event_type, aggregate_id, dedupe_key, payload
        ) VALUES ($1::uuid, 'memory.extract', $2, $3, $4::jsonb)
        ON CONFLICT (tenant_id, dedupe_key) DO NOTHING
      `, [
        input.tenantId,
        input.taskId,
        `memory.extract:${dedupeKey}`,
        JSON.stringify({
          tenantId: input.tenantId,
          userId: input.userId,
          workspaceId: input.workspaceId,
          taskId: input.taskId,
          sessionId: input.sessionId,
          userMessageId: user.id,
          assistantMessageId: assistant.id,
          revision: input.revision,
          extractorVersion,
          userText: clipExtractionText(user.text_content),
          assistantText: clipExtractionText(assistant.text_content),
        }),
      ]);
    });
  }
}

export function createSqlMemoryRepository(database: CloudDatabaseService): SqlMemoryRepository {
  return new SqlMemoryRepository(database);
}

function memoryIdentity(input: {
  tenantId: string;
  userId: string;
  scope: MemoryScope;
  workspaceId?: string | null;
}): MemoryIdentity {
  if (input.scope === "personal") {
    return { tenantId: input.tenantId, userId: input.userId, scope: "personal", workspaceId: null };
  }
  if (!input.workspaceId) throw new Error("Project memory requires a workspace");
  return { tenantId: input.tenantId, userId: input.userId, scope: "project", workspaceId: input.workspaceId };
}

function sourceWithDefaults(
  actorUserId: string,
  source: Partial<MemorySource> | undefined,
  extractorVersion: string,
): MemorySource {
  return {
    actorUserId: source?.actorUserId ?? actorUserId,
    taskId: source?.taskId ?? null,
    sessionId: source?.sessionId ?? null,
    messageId: source?.messageId ?? null,
    extractorVersion: source?.extractorVersion ?? extractorVersion,
  };
}

function normalizedOrDerivedKey(value: string | undefined, kind: string, content: string): string {
  const normalized = normalizeMemoryStableKey(value ?? "");
  if (normalized) return normalized;
  return `${normalizeMemoryStableKey(kind) || "memory"}:${sha256(content.trim().toLocaleLowerCase()).slice(0, 24)}`;
}

function selectMemoryBudget(items: readonly MemoryItem[], tokenBudget: number): { items: MemoryItem[]; tokens: number } {
  const selected: MemoryItem[] = [];
  let tokens = 0;
  for (const item of items) {
    const estimate = Math.max(1, Math.ceil((item.content.length + item.kind.length + item.stableKey.length) / 4));
    if (tokens + estimate > tokenBudget) continue;
    selected.push(item);
    tokens += estimate;
  }
  return { items: selected, tokens };
}

function clipExtractionText(value: string): string {
  return value.normalize("NFKC").replace(/\0/g, "").trim().slice(0, 16_000);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
