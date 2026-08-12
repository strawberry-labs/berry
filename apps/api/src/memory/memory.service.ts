import { Inject, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import {
  PersonalMemoryHttpError,
  createPersonalMemoryProviderFromEnv,
  operationToPersonalMemoryInput,
  type PersonalMemoryProvider,
} from "@berry/personal-memory";
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
import { apiRuntimeMetrics } from "../runtime/runtime-metrics.js";
import {
  SqlMemoryRepository,
  type MemoryIdentity,
  type MemoryMutationResult,
  type MemoryRepository,
  type MemorySource,
} from "./memory.repository.js";

export const MEMORY_REPOSITORY = Symbol("MEMORY_REPOSITORY");
export const PERSONAL_MEMORY_PROVIDER = Symbol("PERSONAL_MEMORY_PROVIDER");

export type MemoryRecall = {
  personal: MemoryItem[];
  project: MemoryItem[];
  personalTokens: number;
  projectTokens: number;
  personalDegraded: boolean;
};

@Injectable()
export class MemoryService {
  readonly #config = durableContextConfigFromEnv(process.env);

  constructor(
    @Inject(MEMORY_REPOSITORY) private readonly repository: MemoryRepository,
    @Inject(CloudDatabaseService) private readonly database: CloudDatabaseService,
    @Inject(PERSONAL_MEMORY_PROVIDER) private readonly personalMemory: PersonalMemoryProvider | null = null,
  ) {}

  async list(input: {
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
    const pageInput = {
      ...identity,
      ...(input.status ? { status: input.status } : {}),
      ...(input.search ? { search: input.search } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {}),
      limit: Math.min(100, Math.max(1, input.limit ?? 50)),
    };
    if (identity.scope === "personal" && this.personalMemory) {
      return this.callPersonal(() => this.personalMemory!.list({
        tenantId: identity.tenantId,
        userId: identity.userId,
        ...(input.status ? { status: input.status } : {}),
        ...(input.search ? { search: input.search } : {}),
        ...(input.cursor ? { cursor: input.cursor } : {}),
        limit: pageInput.limit,
      }));
    }
    return this.repository.list(pageInput);
  }

  async get(tenantId: string, userId: string, memoryId: string): Promise<MemoryItem> {
    const berry = await this.findBerry(tenantId, userId, memoryId);
    if (berry) return berry;
    if (this.personalMemory) {
      const personal = await this.callPersonal(() => this.personalMemory!.get({ tenantId, userId }, memoryId));
      if (personal) return personal;
    }
    throw new NotFoundException("Memory item not found");
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
    if (identity.scope === "personal" && this.personalMemory) {
      return this.callPersonal(() => this.personalMemory!.remember(operationToPersonalMemoryInput(
        { tenantId: identity.tenantId, userId: identity.userId },
        operation,
        sourceWithDefaults(input.userId, input.source, "explicit-v1"),
      )));
    }
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
    const berry = await this.findBerry(input.tenantId, input.userId, input.memoryId);
    if (berry) return this.updateBerry(berry, input);
    if (this.personalMemory) {
      const current = await this.callPersonal(() => this.personalMemory!.get({
        tenantId: input.tenantId,
        userId: input.userId,
      }, input.memoryId));
      if (current) {
        return this.callPersonal(() => this.personalMemory!.update({
          tenantId: input.tenantId,
          userId: input.userId,
          memoryId: input.memoryId,
          content: input.content.trim(),
          ...(input.kind ? { kind: input.kind } : {}),
          ...(input.value ? { value: input.value } : {}),
          ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
          ...(input.salience !== undefined ? { salience: input.salience } : {}),
          ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
          source: sourceWithDefaults(input.userId, {}, "explicit-v1"),
        }));
      }
    }
    throw new NotFoundException("Memory item not found");
  }

  private async updateBerry(current: MemoryItem, input: {
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

  async forget(tenantId: string, userId: string, memoryId: string): Promise<MemoryItem> {
    const berry = await this.findBerry(tenantId, userId, memoryId);
    if (berry) {
      return this.repository.forget(tenantId, userId, memoryId, sourceWithDefaults(userId, {}, "explicit-v1"));
    }
    if (this.personalMemory) {
      const forgotten = await this.callPersonal(() => this.personalMemory!.forget({ tenantId, userId }, memoryId));
      if (forgotten) return forgotten;
    }
    throw new NotFoundException("Memory item not found");
  }

  async forgetMatching(input: {
    tenantId: string;
    userId: string;
    scope: MemoryScope;
    workspaceId?: string | null;
    stableKey: string;
  }): Promise<MemoryItem | null> {
    const identity = memoryIdentity(input);
    const page = await this.list({
      tenantId: identity.tenantId,
      userId: identity.userId,
      scope: identity.scope,
      ...(identity.workspaceId ? { workspaceId: identity.workspaceId } : {}),
      status: "active",
      search: normalizeMemoryStableKey(input.stableKey),
      limit: 20,
    });
    const item = page.items.find((candidate) => candidate.stableKey === normalizeMemoryStableKey(input.stableKey));
    return item ? this.forget(input.tenantId, input.userId, item.id) : null;
  }

  async export(tenantId: string, userId: string) {
    const berry = await this.repository.export(tenantId, userId);
    if (!this.personalMemory) return berry;
    const mem0 = await this.callPersonal(() => this.personalMemory!.export({ tenantId, userId }));
    return {
      items: dedupeMemoryItems([...mem0.items, ...berry.items]),
      versions: [...berry.versions, ...mem0.versions],
    };
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
    if (identity.scope === "personal" && this.personalMemory) {
      const result = await this.callPersonal(() => this.personalMemory!.clear({
        tenantId: identity.tenantId,
        userId: identity.userId,
      }));
      forgotten += result.forgotten;
    }
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
      if (identity.scope === "personal" && this.personalMemory) {
        results.push(await this.callPersonal(() => this.personalMemory!.remember(operationToPersonalMemoryInput(
          { tenantId: identity.tenantId, userId: identity.userId },
          operation,
          input.source,
        ))));
      } else {
        results.push(await this.repository.apply(identity, operation, input.source));
      }
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
    signal?: AbortSignal;
  }): Promise<MemoryRecall> {
    if (!this.#config.memoryEnabled) {
      return { personal: [], project: [], personalTokens: 0, projectTokens: 0, personalDegraded: false };
    }
    const settings = await this.repository.settings(input.tenantId, input.userId);
    if (!settings.memoryEnabled) {
      return { personal: [], project: [], personalTokens: 0, projectTokens: 0, personalDegraded: false };
    }
    const [berryCandidates, personalRecall] = await Promise.all([
      this.repository.recall({
        tenantId: input.tenantId,
        userId: input.userId,
        workspaceId: input.workspaceId,
        query: input.query,
        limit: 40,
      }),
      this.personalMemory
        ? this.recallPersonal(() => this.personalMemory!.search({
            tenantId: input.tenantId,
            userId: input.userId,
            query: input.query,
            limit: 40,
            ...(input.signal ? { signal: input.signal } : {}),
          }))
        : Promise.resolve({ items: [], degraded: false }),
    ]);
    const candidates = this.personalMemory
      ? [
          ...dedupeMemoryItems([
            ...personalRecall.items,
            ...berryCandidates.filter((item) => item.scope === "personal"),
          ]),
          ...berryCandidates.filter((item) => item.scope === "project"),
        ]
      : berryCandidates;
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
      personalDegraded: personalRecall.degraded,
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

  private async callPersonal<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof PersonalMemoryHttpError) {
        throw new ServiceUnavailableException("The self-hosted personal memory service is unavailable");
      }
      throw error;
    }
  }

  private async recallPersonal(
    operation: () => Promise<MemoryItem[]>,
  ): Promise<{ items: MemoryItem[]; degraded: boolean }> {
    const startedAt = Date.now();
    try {
      const items = await operation();
      apiRuntimeMetrics.personalMemoryRecall("success", Date.now() - startedAt);
      return { items, degraded: false };
    } catch (error) {
      apiRuntimeMetrics.personalMemoryRecall(
        isPersonalMemoryTimeout(error) ? "timeout" : "unavailable",
        Date.now() - startedAt,
      );
      if (error instanceof PersonalMemoryHttpError) {
        return { items: [], degraded: true };
      }
      throw error;
    }
  }

  private async findBerry(tenantId: string, userId: string, memoryId: string): Promise<MemoryItem | null> {
    try {
      return await this.repository.get(tenantId, userId, memoryId);
    } catch (error) {
      if (error instanceof NotFoundException) return null;
      throw error;
    }
  }
}

function isPersonalMemoryTimeout(error: unknown): boolean {
  if (error instanceof PersonalMemoryHttpError && error.status === 408) return true;
  if (!(error instanceof Error)) return false;
  return /(?:timed?\s*out|timeout|deadline)/i.test(`${error.name} ${error.message}`);
}

export function createSqlMemoryRepository(database: CloudDatabaseService): SqlMemoryRepository {
  return new SqlMemoryRepository(database);
}

export function createConfiguredPersonalMemoryProvider(
  env: NodeJS.ProcessEnv = process.env,
): PersonalMemoryProvider | null {
  return createPersonalMemoryProviderFromEnv(env);
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

function dedupeMemoryItems(items: readonly MemoryItem[]): MemoryItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.scope}:${item.workspaceId ?? ""}:${item.stableKey}:${item.content.trim().toLocaleLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
