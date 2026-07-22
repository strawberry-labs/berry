import { createHash, randomUUID } from "node:crypto";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  CloudAuditEventSchema,
  CloudAuditExportConfigSchema,
  CloudAuditExportResultSchema,
  CloudAuditSettingsSchema,
  type CloudAuditEvent,
  type CloudAuditExportConfig,
  type CloudAuditExportConfigUpsert,
  type CloudAuditExportResult,
  type CloudAuditIngestRequest,
  type CloudAuditSettings,
  type CloudAuditSettingsUpdate,
  type JsonValue,
} from "@berry/shared";
import type { CloudDatabaseService, SqlExecutor } from "../db/cloud-database.service.ts";

export const AUDIT_SERVICE = Symbol("AUDIT_SERVICE");
export const AUDIT_EXPORT_DISPATCHER = Symbol("AUDIT_EXPORT_DISPATCHER");

export type AuditEventFilter = {
  from?: Date | undefined;
  to?: Date | undefined;
  category?: string | undefined;
  action?: string | undefined;
  targetType?: string | undefined;
  actorUserId?: string | undefined;
  sessionId?: string | undefined;
  limit?: number | undefined;
};

export type AppendAuditInput = {
  tenantId: string;
  actorUserId?: string | null | undefined;
  category: string;
  action: string;
  targetType?: string | null | undefined;
  targetId?: string | null | undefined;
  workspaceId?: string | null | undefined;
  taskId?: string | null | undefined;
  sessionId?: string | null | undefined;
  before?: JsonValue | null | undefined;
  after?: JsonValue | null | undefined;
  metadata?: JsonValue | undefined;
  ts?: string | undefined;
};

export interface AuditRepository {
  getSettings(tenantId: string): Promise<CloudAuditSettings>;
  updateSettings(tenantId: string, actorUserId: string | null, input: CloudAuditSettingsUpdate): Promise<CloudAuditSettings>;
  append(input: AppendAuditInput): Promise<CloudAuditEvent>;
  ingest(tenantId: string, actorUserId: string | null, input: CloudAuditIngestRequest): Promise<CloudAuditEvent[]>;
  listEvents(tenantId: string, filter?: AuditEventFilter | undefined): Promise<CloudAuditEvent[]>;
  listExportConfigs(tenantId: string): Promise<CloudAuditExportConfig[]>;
  upsertExportConfig(tenantId: string, actorUserId: string | null, input: CloudAuditExportConfigUpsert): Promise<CloudAuditExportConfig>;
  markExported(tenantId: string, configId: string, exportedAt: string): Promise<void>;
}

export interface AuditExportDispatcher {
  dispatch(input: {
    tenantId: string;
    config: CloudAuditExportConfig;
    events: CloudAuditEvent[];
    format: "json" | "csv";
    payload: string;
  }): Promise<{ destination: string; delivered: boolean }>;
}

export class AuditService {
  constructor(
    private readonly repository: AuditRepository,
    private readonly dispatcher: AuditExportDispatcher = new NoopAuditExportDispatcher(),
  ) {}

  getSettings(tenantId: string): Promise<CloudAuditSettings> {
    return this.repository.getSettings(tenantId);
  }

  async updateSettings(tenantId: string, actorUserId: string | null, input: CloudAuditSettingsUpdate): Promise<CloudAuditSettings> {
    const settings = await this.repository.updateSettings(tenantId, actorUserId, input);
    await this.append({
      tenantId,
      actorUserId,
      category: "audit",
      action: "settings-updated",
      targetType: "audit_settings",
      targetId: tenantId,
      after: settings as unknown as JsonValue,
      metadata: { retentionDays: settings.retentionDays, clientIngestEnabled: settings.clientIngestEnabled },
    });
    return settings;
  }

  append(input: AppendAuditInput): Promise<CloudAuditEvent> {
    return this.repository.append(input);
  }

  async ingestClientEvents(tenantId: string, actorUserId: string | null, input: CloudAuditIngestRequest): Promise<CloudAuditEvent[]> {
    const settings = await this.repository.getSettings(tenantId);
    if (!settings.clientIngestEnabled) throw new Error("Client audit ingestion is disabled by organization policy");
    const events = await this.repository.ingest(tenantId, actorUserId, input);
    await this.append({
      tenantId,
      actorUserId,
      category: "audit",
      action: "client-events-ingested",
      targetType: "audit_events",
      targetId: input.source,
      metadata: { source: input.source, count: events.length },
    });
    return events;
  }

  listEvents(tenantId: string, filter: AuditEventFilter = {}): Promise<CloudAuditEvent[]> {
    return this.repository.listEvents(tenantId, filter);
  }

  listExportConfigs(tenantId: string): Promise<CloudAuditExportConfig[]> {
    return this.repository.listExportConfigs(tenantId);
  }

  async upsertExportConfig(tenantId: string, actorUserId: string | null, input: CloudAuditExportConfigUpsert): Promise<CloudAuditExportConfig> {
    const config = await this.repository.upsertExportConfig(tenantId, actorUserId, input);
    await this.append({
      tenantId,
      actorUserId,
      category: "audit",
      action: "export-config-upserted",
      targetType: "audit_export_config",
      targetId: config.id,
      after: config as unknown as JsonValue,
      metadata: { kind: config.kind, destination: config.destination, status: config.status },
    });
    return config;
  }

  async export(tenantId: string, input: {
    format: "json" | "csv";
    filter?: AuditEventFilter | undefined;
    configId?: string | null | undefined;
  }): Promise<{ result: CloudAuditExportResult; payload: string }> {
    const events = await this.repository.listEvents(tenantId, input.filter ?? {});
    const chainValid = auditChainValid(events);
    const payload = input.format === "csv" ? auditEventsCsv(events) : JSON.stringify(events, null, 2);
    const exportedAt = new Date().toISOString();
    const config = input.configId
      ? (await this.repository.listExportConfigs(tenantId)).find((entry) => entry.id === input.configId) ?? null
      : null;
    let destination: string | null = null;
    let delivered = false;
    let kind: "download" | "webhook" | "s3" = "download";
    if (config) {
      kind = config.kind;
      const delivery = await this.dispatcher.dispatch({ tenantId, config, events, format: input.format, payload });
      destination = delivery.destination;
      delivered = delivery.delivered;
      if (delivered) await this.repository.markExported(tenantId, config.id, exportedAt);
    }
    return {
      payload,
      result: CloudAuditExportResultSchema.parse({
        tenantId,
        configId: config?.id ?? null,
        kind,
        format: input.format,
        count: events.length,
        chainValid,
        destination,
        delivered,
        exportedAt,
      }),
    };
  }
}

export class NoopAuditExportDispatcher implements AuditExportDispatcher {
  async dispatch(input: { config: CloudAuditExportConfig }): Promise<{ destination: string; delivered: boolean }> {
    return { destination: input.config.destination, delivered: false };
  }
}

export class WebhookAuditExportDispatcher implements AuditExportDispatcher {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async dispatch(input: { tenantId: string; config: CloudAuditExportConfig; format: "json" | "csv"; payload: string }): Promise<{ destination: string; delivered: boolean }> {
    if (input.config.status !== "enabled") return { destination: input.config.destination, delivered: false };
    if (input.config.kind !== "webhook") return { destination: input.config.destination, delivered: false };
    const response = await this.fetchImpl(input.config.destination, {
      method: "POST",
      headers: {
        "content-type": input.format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
        "x-berry-tenant-id": input.tenantId,
      },
      body: input.payload,
    });
    return { destination: input.config.destination, delivered: response.ok };
  }
}

export class S3AuditExportDispatcher implements AuditExportDispatcher {
  constructor(
    private readonly client: Pick<S3Client, "send">,
    private readonly options: { bucket: string; prefix?: string | undefined },
  ) {}

  async dispatch(input: { tenantId: string; config: CloudAuditExportConfig; format: "json" | "csv"; payload: string }): Promise<{ destination: string; delivered: boolean }> {
    if (input.config.status !== "enabled") return { destination: input.config.destination, delivered: false };
    if (input.config.kind !== "s3") return { destination: input.config.destination, delivered: false };
    const key = s3AuditKey(input.tenantId, input.config, input.format, this.options.prefix);
    await this.client.send(new PutObjectCommand({
      Bucket: this.options.bucket,
      Key: key,
      Body: input.payload,
      ContentType: input.format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
      Metadata: { tenant_id: input.tenantId, audit_export_config_id: input.config.id },
    }));
    return { destination: `s3://${this.options.bucket}/${key}`, delivered: true };
  }
}

export class CompositeAuditExportDispatcher implements AuditExportDispatcher {
  constructor(private readonly dispatchers: AuditExportDispatcher[]) {}

  async dispatch(input: { tenantId: string; config: CloudAuditExportConfig; events: CloudAuditEvent[]; format: "json" | "csv"; payload: string }): Promise<{ destination: string; delivered: boolean }> {
    for (const dispatcher of this.dispatchers) {
      const result = await dispatcher.dispatch(input);
      if (result.delivered || result.destination !== input.config.destination) return result;
    }
    return { destination: input.config.destination, delivered: false };
  }
}

export function createAuditExportDispatcherFromEnv(env: NodeJS.ProcessEnv): AuditExportDispatcher {
  const dispatchers: AuditExportDispatcher[] = [new WebhookAuditExportDispatcher()];
  const endpoint = env.BERRY_AUDIT_S3_ENDPOINT;
  const bucket = env.BERRY_AUDIT_S3_BUCKET;
  const accessKeyId = env.BERRY_AUDIT_S3_ACCESS_KEY_ID;
  const secretAccessKey = env.BERRY_AUDIT_S3_SECRET_ACCESS_KEY;
  if (endpoint && bucket && accessKeyId && secretAccessKey) {
    dispatchers.push(new S3AuditExportDispatcher(new S3Client({
      endpoint,
      region: env.BERRY_AUDIT_S3_REGION ?? "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
    }), { bucket, prefix: env.BERRY_AUDIT_S3_PREFIX ?? "audit" }));
  }
  return new CompositeAuditExportDispatcher(dispatchers);
}

export class InMemoryAuditRepository implements AuditRepository {
  readonly #events = new Map<string, CloudAuditEvent[]>();
  readonly #settings = new Map<string, CloudAuditSettings>();
  readonly #configs = new Map<string, CloudAuditExportConfig[]>();

  async getSettings(tenantId: string): Promise<CloudAuditSettings> {
    const existing = this.#settings.get(tenantId);
    if (existing) return existing;
    const now = new Date().toISOString();
    const settings = CloudAuditSettingsSchema.parse({ tenantId, retentionDays: 90, clientIngestEnabled: false, updatedBy: null, updatedAt: now });
    this.#settings.set(tenantId, settings);
    return settings;
  }

  async updateSettings(tenantId: string, actorUserId: string | null, input: CloudAuditSettingsUpdate): Promise<CloudAuditSettings> {
    const current = await this.getSettings(tenantId);
    const settings = CloudAuditSettingsSchema.parse({
      ...current,
      retentionDays: input.retentionDays ?? current.retentionDays,
      clientIngestEnabled: input.clientIngestEnabled ?? current.clientIngestEnabled,
      updatedBy: actorUserId,
      updatedAt: new Date().toISOString(),
    });
    this.#settings.set(tenantId, settings);
    return settings;
  }

  async append(input: AppendAuditInput): Promise<CloudAuditEvent> {
    const events = this.#events.get(input.tenantId) ?? [];
    const event = createAuditEvent(input, events.at(-1) ?? null, (await this.getSettings(input.tenantId)).retentionDays);
    events.push(event);
    this.#events.set(input.tenantId, events);
    return event;
  }

  async ingest(tenantId: string, actorUserId: string | null, input: CloudAuditIngestRequest): Promise<CloudAuditEvent[]> {
    const created: CloudAuditEvent[] = [];
    for (const event of input.events) {
      created.push(await this.append({
        tenantId,
        actorUserId,
        category: event.category,
        action: event.action,
        targetType: event.targetType ?? null,
        targetId: event.targetId ?? null,
        workspaceId: event.workspaceId ?? null,
        taskId: event.taskId ?? null,
        sessionId: event.sessionId ?? null,
        before: event.before ?? null,
        after: event.after ?? null,
        metadata: scrubJson({ source: input.source, clientActor: event.actor ?? null, ...(isRecord(event.metadata) ? event.metadata : {}) }),
        ts: event.ts,
      }));
    }
    return created;
  }

  async listEvents(tenantId: string, filter: AuditEventFilter = {}): Promise<CloudAuditEvent[]> {
    return (this.#events.get(tenantId) ?? [])
      .filter((event) => matchesFilter(event, filter))
      .slice(-(filter.limit ?? 1000))
      .sort((left, right) => left.sequence - right.sequence);
  }

  async listExportConfigs(tenantId: string): Promise<CloudAuditExportConfig[]> {
    return this.#configs.get(tenantId) ?? [];
  }

  async upsertExportConfig(tenantId: string, actorUserId: string | null, input: CloudAuditExportConfigUpsert): Promise<CloudAuditExportConfig> {
    const configs = this.#configs.get(tenantId) ?? [];
    const existing = configs.find((config) => config.kind === input.kind && config.destination === input.destination);
    const config = CloudAuditExportConfigSchema.parse({
      id: existing?.id ?? randomUUID(),
      tenantId,
      kind: input.kind,
      status: input.status ?? existing?.status ?? "enabled",
      destination: input.destination,
      format: input.format ?? existing?.format ?? "json",
      config: scrubJson(input.config ?? existing?.config ?? {}),
      lastExportedAt: existing?.lastExportedAt ?? null,
      updatedBy: actorUserId,
      updatedAt: new Date().toISOString(),
    });
    const next = existing ? configs.map((entry) => entry.id === existing.id ? config : entry) : [...configs, config];
    this.#configs.set(tenantId, next);
    return config;
  }

  async markExported(tenantId: string, configId: string, exportedAt: string): Promise<void> {
    const configs = this.#configs.get(tenantId) ?? [];
    this.#configs.set(tenantId, configs.map((config) => config.id === configId ? { ...config, lastExportedAt: exportedAt } : config));
  }
}

export class PostgresAuditRepository implements AuditRepository {
  constructor(private readonly database: CloudDatabaseService) {}

  async getSettings(tenantId: string): Promise<CloudAuditSettings> {
    return this.database.withTenant(tenantId, async (executor) => {
      const rows = await executor.query<AuditSettingsRow>("SELECT * FROM audit_settings WHERE tenant_id = $1::uuid LIMIT 1", [tenantId]);
      if (rows[0]) return settingsFromRow(rows[0]);
      const inserted = await executor.query<AuditSettingsRow>(
        "INSERT INTO audit_settings (tenant_id) VALUES ($1::uuid) ON CONFLICT (tenant_id) DO UPDATE SET updated_at = audit_settings.updated_at RETURNING *",
        [tenantId],
      );
      return settingsFromRow(inserted[0]!);
    });
  }

  async updateSettings(tenantId: string, actorUserId: string | null, input: CloudAuditSettingsUpdate): Promise<CloudAuditSettings> {
    return this.database.withTenant(tenantId, async (executor) => {
      const current = await this.settingsForExecutor(executor, tenantId);
      const rows = await executor.query<AuditSettingsRow>(
        `INSERT INTO audit_settings (tenant_id, retention_days, client_ingest_enabled, updated_by, updated_at)
         VALUES ($1::uuid, $2, $3, $4::uuid, now())
         ON CONFLICT (tenant_id)
         DO UPDATE SET retention_days = excluded.retention_days, client_ingest_enabled = excluded.client_ingest_enabled, updated_by = excluded.updated_by, updated_at = now()
         RETURNING *`,
        [tenantId, input.retentionDays ?? current.retention_days, input.clientIngestEnabled ?? current.client_ingest_enabled, uuidOrNull(actorUserId)],
      );
      return settingsFromRow(rows[0]!);
    });
  }

  async append(input: AppendAuditInput): Promise<CloudAuditEvent> {
    return this.database.withTenant(input.tenantId, async (executor) => {
      const settings = await this.settingsForExecutor(executor, input.tenantId);
      return this.appendWithExecutor(executor, input, settings.retention_days);
    });
  }

  async ingest(tenantId: string, actorUserId: string | null, input: CloudAuditIngestRequest): Promise<CloudAuditEvent[]> {
    return this.database.withTenant(tenantId, async (executor) => {
      const settings = await this.settingsForExecutor(executor, tenantId);
      const created: CloudAuditEvent[] = [];
      for (const event of input.events) {
        created.push(await this.appendWithExecutor(executor, {
          tenantId,
          actorUserId,
          category: event.category,
          action: event.action,
          targetType: event.targetType ?? null,
          targetId: event.targetId ?? null,
          workspaceId: event.workspaceId ?? null,
          taskId: event.taskId ?? null,
          sessionId: event.sessionId ?? null,
          before: event.before ?? null,
          after: event.after ?? null,
          metadata: scrubJson({ source: input.source, clientActor: event.actor ?? null, ...(isRecord(event.metadata) ? event.metadata : {}) }),
          ts: event.ts,
        }, settings.retention_days));
      }
      return created;
    });
  }

  async listEvents(tenantId: string, filter: AuditEventFilter = {}): Promise<CloudAuditEvent[]> {
    return this.database.withTenant(tenantId, async (executor) => {
      const { where, params } = auditWhere(tenantId, filter);
      const rows = await executor.query<AuditEventRow>(`SELECT * FROM audit_events ${where} ORDER BY sequence ASC LIMIT ${Math.min(filter.limit ?? 1000, 5000)}`, params);
      return rows.map(auditEventFromRow);
    });
  }

  async listExportConfigs(tenantId: string): Promise<CloudAuditExportConfig[]> {
    return this.database.withTenant(tenantId, async (executor) => {
      const rows = await executor.query<AuditExportConfigRow>("SELECT * FROM audit_export_configs WHERE tenant_id = $1::uuid ORDER BY updated_at DESC", [tenantId]);
      return rows.map(exportConfigFromRow);
    });
  }

  async upsertExportConfig(tenantId: string, actorUserId: string | null, input: CloudAuditExportConfigUpsert): Promise<CloudAuditExportConfig> {
    return this.database.withTenant(tenantId, async (executor) => {
      const rows = await executor.query<AuditExportConfigRow>(
        `INSERT INTO audit_export_configs (tenant_id, kind, status, destination, format, config, updated_by, updated_at)
         VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, $7::uuid, now())
         ON CONFLICT (tenant_id, kind, destination)
         DO UPDATE SET status = excluded.status, format = excluded.format, config = excluded.config, updated_by = excluded.updated_by, updated_at = now()
         RETURNING *`,
        [tenantId, input.kind, input.status ?? "enabled", input.destination, input.format ?? "json", JSON.stringify(scrubJson(input.config ?? {})), uuidOrNull(actorUserId)],
      );
      return exportConfigFromRow(rows[0]!);
    });
  }

  async markExported(tenantId: string, configId: string, exportedAt: string): Promise<void> {
    await this.database.withTenant(tenantId, async (executor) => {
      await executor.execute("UPDATE audit_export_configs SET last_exported_at = $3, updated_at = now() WHERE tenant_id = $1::uuid AND id = $2::uuid", [tenantId, configId, exportedAt]);
    });
  }

  private async settingsForExecutor(executor: SqlExecutor, tenantId: string): Promise<AuditSettingsRow> {
    const rows = await executor.query<AuditSettingsRow>(
      "INSERT INTO audit_settings (tenant_id) VALUES ($1::uuid) ON CONFLICT (tenant_id) DO UPDATE SET updated_at = audit_settings.updated_at RETURNING *",
      [tenantId],
    );
    return rows[0]!;
  }

  private async appendWithExecutor(executor: SqlExecutor, input: AppendAuditInput, retentionDays: number): Promise<CloudAuditEvent> {
    const previousRows = await executor.query<{ sequence: number; event_hash: string }>(
      "SELECT sequence, event_hash FROM audit_events WHERE tenant_id = $1::uuid ORDER BY sequence DESC LIMIT 1",
      [input.tenantId],
    );
    const previous = previousRows[0] ? { sequence: previousRows[0].sequence, eventHash: previousRows[0].event_hash } : null;
    const event = createAuditEvent(input, previous ? {
      sequence: previous.sequence,
      eventHash: previous.eventHash,
    } : null, retentionDays);
    const rows = await executor.query<AuditEventRow>(
      `INSERT INTO audit_events (
        id, tenant_id, sequence, actor_user_id, category, action, target_type, target_id, workspace_id, task_id, session_id,
        before, after, metadata, previous_hash, event_hash, ts, expires_at
      ) VALUES (
        $1::uuid, $2::uuid, $3, $4::uuid, $5, $6, $7, $8, $9::uuid, $10::uuid, $11::uuid,
        $12::jsonb, $13::jsonb, $14::jsonb, $15, $16, $17, $18
      ) RETURNING *`,
      [
        event.id,
        event.tenantId,
        event.sequence,
        uuidOrNull(event.actorUserId),
        event.category,
        event.action,
        event.targetType,
        event.targetId,
        uuidOrNull(event.workspaceId),
        uuidOrNull(event.taskId),
        uuidOrNull(event.sessionId),
        event.before === null ? null : JSON.stringify(event.before),
        event.after === null ? null : JSON.stringify(event.after),
        JSON.stringify(event.metadata),
        event.previousHash,
        event.eventHash,
        event.ts,
        event.expiresAt,
      ],
    );
    return auditEventFromRow(rows[0]!);
  }
}

export function auditEventsCsv(events: CloudAuditEvent[]): string {
  const headers = ["ts", "sequence", "actor_user_id", "category", "action", "target_type", "target_id", "session_id", "event_hash"];
  const rows = events.map((event) => [
    event.ts,
    String(event.sequence),
    event.actorUserId ?? "",
    event.category,
    event.action,
    event.targetType ?? "",
    event.targetId ?? "",
    event.sessionId ?? "",
    event.eventHash,
  ]);
  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
}

export function auditChainValid(events: CloudAuditEvent[]): boolean {
  let previousHash = "0".repeat(64);
  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
    if (event.previousHash !== previousHash) return false;
    const expected = hashAuditEvent(event);
    if (expected !== event.eventHash) return false;
    previousHash = event.eventHash;
  }
  return true;
}

function createAuditEvent(input: AppendAuditInput, previous: Pick<CloudAuditEvent, "sequence" | "eventHash"> | null, retentionDays: number): CloudAuditEvent {
  const ts = input.ts ?? new Date().toISOString();
  const expiresAt = new Date(new Date(ts).getTime() + retentionDays * 86_400_000).toISOString();
  const event = CloudAuditEventSchema.parse({
    id: randomUUID(),
    tenantId: input.tenantId,
    sequence: (previous?.sequence ?? 0) + 1,
    actorUserId: input.actorUserId ?? null,
    category: input.category,
    action: input.action,
    targetType: input.targetType ?? null,
    targetId: input.targetId ?? null,
    workspaceId: input.workspaceId ?? null,
    taskId: input.taskId ?? null,
    sessionId: input.sessionId ?? null,
    before: input.before ?? null,
    after: input.after ?? null,
    metadata: scrubJson(input.metadata ?? {}),
    previousHash: previous?.eventHash ?? "0".repeat(64),
    eventHash: "pending",
    ts,
    expiresAt,
    createdAt: new Date().toISOString(),
  });
  return CloudAuditEventSchema.parse({ ...event, eventHash: hashAuditEvent(event) });
}

function hashAuditEvent(event: Pick<CloudAuditEvent, "id" | "tenantId" | "sequence" | "actorUserId" | "category" | "action" | "targetType" | "targetId" | "workspaceId" | "taskId" | "sessionId" | "before" | "after" | "metadata" | "previousHash" | "ts" | "expiresAt">): string {
  return createHash("sha256").update(canonicalJson({
    id: event.id,
    tenantId: event.tenantId,
    sequence: event.sequence,
    actorUserId: event.actorUserId,
    category: event.category,
    action: event.action,
    targetType: event.targetType,
    targetId: event.targetId,
    workspaceId: event.workspaceId,
    taskId: event.taskId,
    sessionId: event.sessionId,
    before: event.before,
    after: event.after,
    metadata: event.metadata,
    previousHash: event.previousHash,
    ts: event.ts,
    expiresAt: event.expiresAt,
  })).digest("hex");
}

function matchesFilter(event: CloudAuditEvent, filter: AuditEventFilter): boolean {
  const ts = new Date(event.ts);
  return (!filter.from || ts >= filter.from)
    && (!filter.to || ts < filter.to)
    && (!filter.category || event.category === filter.category)
    && (!filter.action || event.action === filter.action)
    && (!filter.targetType || event.targetType === filter.targetType)
    && (!filter.actorUserId || event.actorUserId === filter.actorUserId)
    && (!filter.sessionId || event.sessionId === filter.sessionId);
}

function auditWhere(tenantId: string, filter: AuditEventFilter): { where: string; params: unknown[] } {
  const clauses = ["tenant_id = $1::uuid"];
  const params: unknown[] = [tenantId];
  for (const [column, value] of [
    ["ts >=", filter.from?.toISOString()],
    ["ts <", filter.to?.toISOString()],
    ["category =", filter.category],
    ["action =", filter.action],
    ["target_type =", filter.targetType],
    ["actor_user_id =", uuidOrNull(filter.actorUserId)],
    ["session_id =", uuidOrNull(filter.sessionId)],
  ] as const) {
    if (!value) continue;
    params.push(value);
    clauses.push(`${column} $${params.length}${column.endsWith("_id =") ? "::uuid" : ""}`);
  }
  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

function auditEventFromRow(row: AuditEventRow): CloudAuditEvent {
  return CloudAuditEventSchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    sequence: row.sequence,
    actorUserId: row.actor_user_id,
    category: row.category,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    workspaceId: row.workspace_id,
    taskId: row.task_id,
    sessionId: row.session_id,
    before: row.before ?? null,
    after: row.after ?? null,
    metadata: row.metadata ?? {},
    previousHash: row.previous_hash,
    eventHash: row.event_hash,
    ts: iso(row.ts),
    expiresAt: iso(row.expires_at),
    createdAt: iso(row.created_at),
  });
}

function settingsFromRow(row: AuditSettingsRow): CloudAuditSettings {
  return CloudAuditSettingsSchema.parse({
    tenantId: row.tenant_id,
    retentionDays: row.retention_days,
    clientIngestEnabled: row.client_ingest_enabled,
    updatedBy: row.updated_by,
    updatedAt: iso(row.updated_at),
  });
}

function exportConfigFromRow(row: AuditExportConfigRow): CloudAuditExportConfig {
  return CloudAuditExportConfigSchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    kind: row.kind,
    status: row.status,
    destination: row.destination,
    format: row.format,
    config: row.config ?? {},
    lastExportedAt: row.last_exported_at ? iso(row.last_exported_at) : null,
    updatedBy: row.updated_by,
    updatedAt: iso(row.updated_at),
  });
}

function scrubJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(scrubJson) as JsonValue;
  if (!value || typeof value !== "object") {
    if (typeof value === "string") return scrubString(value) as JsonValue;
    return value;
  }
  const out: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = /secret|token|password|authorization|cookie|api[-_]?key|private[-_]?key/i.test(key) ? "[redacted]" : scrubJson(entry);
  }
  return out;
}

function scrubString(value: string): string {
  return value.replace(/\b(Bearer|sk-[A-Za-z0-9_-]+)\s+[A-Za-z0-9._~+/=-]+/g, "[redacted]");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function s3AuditKey(tenantId: string, config: CloudAuditExportConfig, format: "json" | "csv", prefix?: string | undefined): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = (prefix ?? "audit").replace(/^\/+|\/+$/g, "");
  return `${base}/${tenantId}/${config.id}/${stamp}.${format}`;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function uuidOrNull(value: string | null | undefined): string | null {
  return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

type AuditEventRow = {
  id: string;
  tenant_id: string;
  sequence: number;
  actor_user_id: string | null;
  category: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  workspace_id: string | null;
  task_id: string | null;
  session_id: string | null;
  before: JsonValue | null;
  after: JsonValue | null;
  metadata: JsonValue;
  previous_hash: string;
  event_hash: string;
  ts: Date | string;
  expires_at: Date | string;
  created_at: Date | string;
};

type AuditSettingsRow = {
  tenant_id: string;
  retention_days: number;
  client_ingest_enabled: boolean;
  updated_by: string | null;
  updated_at: Date | string;
};

type AuditExportConfigRow = {
  id: string;
  tenant_id: string;
  kind: "webhook" | "s3";
  status: "enabled" | "disabled";
  destination: string;
  format: "json" | "csv";
  config: JsonValue;
  last_exported_at: Date | string | null;
  updated_by: string | null;
  updated_at: Date | string;
};
