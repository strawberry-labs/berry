import type {
	JsonValue,
} from "@berry/shared";
import type {
	LeafEntry,
	SessionMetadata,
	SessionStorage,
	SessionTreeEntry,
} from "../types.ts";
import { SessionError } from "../types.ts";
import { uuidv7 } from "./uuid.ts";

export interface PostgresSessionExecutor {
	execute(sql: string, params?: readonly unknown[]): Promise<unknown>;
	query<T>(sql: string, params?: readonly unknown[]): Promise<readonly T[]>;
	transaction?<T>(callback: (executor: PostgresSessionExecutor) => Promise<T>): Promise<T>;
}

interface EntryRow {
	entry_id: string;
	payload: unknown;
	is_leaf_marker: boolean;
	created_at: Date | string;
}

/**
 * Cloud/web SessionStorage backed by the append-only Postgres session journal.
 * The caller is responsible for setting the tenant RLS context on the supplied
 * executor.
 */
export class PostgresSessionStorage implements SessionStorage<SessionMetadata> {
	constructor(
		private readonly executor: PostgresSessionExecutor,
		private readonly tenantId: string,
		private readonly sessionId: string,
	) {}

	async getMetadata(): Promise<SessionMetadata> {
		const rows = await this.executor.query<{ created_at: Date | string }>(
			"SELECT created_at FROM sessions WHERE tenant_id = $1::uuid AND id = $2::uuid",
			[this.tenantId, this.sessionId],
		);
		const row = rows[0];
		if (!row) throw new SessionError("not_found", `Session ${this.sessionId} not found`);
		return {
			id: this.sessionId,
			createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
		};
	}

	async getLeafId(): Promise<string | null> {
		const rows = await this.executor.query<EntryRow>(
			`
SELECT entry_id, payload, is_leaf_marker, created_at
FROM session_entries
WHERE tenant_id = $1::uuid AND session_id = $2::uuid AND is_leaf_marker = true
ORDER BY sequence DESC
LIMIT 1
			`.trim(),
			[this.tenantId, this.sessionId],
		);
		const entry = rows[0] ? parseEntry(rows[0]) : null;
		return entry ? leafIdAfterEntry(entry) : null;
	}

	async setLeafId(leafId: string | null): Promise<void> {
		if (leafId !== null && !(await this.getEntry(leafId))) {
			throw new SessionError("not_found", `Entry ${leafId} not found`);
		}
		const entry: LeafEntry = {
			type: "leaf",
			id: await this.createEntryId(),
			parentId: await this.getLeafId(),
			timestamp: new Date().toISOString(),
			targetId: leafId,
		};
		await this.appendEntry(entry);
	}

	async createEntryId(): Promise<string> {
		for (let attempt = 0; attempt < 10; attempt += 1) {
			const id = uuidv7();
			const rows = await this.executor.query<{ present: boolean }>(
				`
SELECT EXISTS (
  SELECT 1 FROM session_entries
  WHERE tenant_id = $1::uuid AND session_id = $2::uuid AND entry_id = $3
) AS present
				`.trim(),
				[this.tenantId, this.sessionId, id],
			);
			if (!rows[0]?.present) return id;
		}
		throw new SessionError("invalid_session", "Unable to allocate a unique session entry id");
	}

	async appendEntry(entry: SessionTreeEntry): Promise<void> {
		const run = async (executor: PostgresSessionExecutor): Promise<void> => {
			await executor.query(
				"SELECT id FROM sessions WHERE tenant_id = $1::uuid AND id = $2::uuid FOR UPDATE",
				[this.tenantId, this.sessionId],
			);
			const next = await executor.query<{ sequence: number | string }>(
				`
SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
FROM session_entries
WHERE tenant_id = $1::uuid AND session_id = $2::uuid
				`.trim(),
				[this.tenantId, this.sessionId],
			);
			await executor.execute(
				`
UPDATE session_entries
SET is_leaf_marker = false
WHERE tenant_id = $1::uuid AND session_id = $2::uuid AND is_leaf_marker = true
				`.trim(),
				[this.tenantId, this.sessionId],
			);
			await executor.execute(
				`
INSERT INTO session_entries (
  tenant_id, session_id, entry_id, parent_entry_id, entry_type, sequence,
  payload, is_leaf_marker, created_at
) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, true, $8)
				`.trim(),
				[
					this.tenantId,
					this.sessionId,
					entry.id,
					entry.parentId,
					entry.type,
					Number(next[0]?.sequence ?? 1),
					JSON.stringify(entry as unknown as JsonValue),
					entry.timestamp,
				],
			);
			await executor.execute(
				`
UPDATE sessions
SET updated_at = now(),
    runtime_metadata = runtime_metadata || jsonb_build_object(
      'leafId', $3::text,
      'journalSequence', $4::bigint
    )
WHERE tenant_id = $1::uuid AND id = $2::uuid
				`.trim(),
				[this.tenantId, this.sessionId, leafIdAfterEntry(entry), Number(next[0]?.sequence ?? 1)],
			);
		};
		if (this.executor.transaction) await this.executor.transaction(run);
		else await run(this.executor);
	}

	async getEntry(id: string): Promise<SessionTreeEntry | undefined> {
		const rows = await this.executor.query<EntryRow>(
			`
SELECT entry_id, payload, is_leaf_marker, created_at
FROM session_entries
WHERE tenant_id = $1::uuid AND session_id = $2::uuid AND entry_id = $3
			`.trim(),
			[this.tenantId, this.sessionId, id],
		);
		return rows[0] ? parseEntry(rows[0]) : undefined;
	}

	async findEntries<TType extends SessionTreeEntry["type"]>(
		type: TType,
	): Promise<Array<Extract<SessionTreeEntry, { type: TType }>>> {
		return (await this.getEntries()).filter(
			(entry): entry is Extract<SessionTreeEntry, { type: TType }> => entry.type === type,
		);
	}

	async getLabel(id: string): Promise<string | undefined> {
		const labels = await this.findEntries("label");
		for (let index = labels.length - 1; index >= 0; index -= 1) {
			const label = labels[index];
			if (label?.targetId === id) return label.label?.trim() || undefined;
		}
		return undefined;
	}

	async getPathToRoot(leafId: string | null): Promise<SessionTreeEntry[]> {
		if (leafId === null) return [];
		const entries = await this.getEntries();
		const byId = new Map(entries.map((entry) => [entry.id, entry]));
		const path: SessionTreeEntry[] = [];
		let current = byId.get(leafId);
		if (!current) throw new SessionError("not_found", `Entry ${leafId} not found`);
		while (current) {
			path.unshift(current);
			if (!current.parentId) break;
			const parent = byId.get(current.parentId);
			if (!parent) throw new SessionError("invalid_session", `Entry ${current.parentId} not found`);
			current = parent;
		}
		return path;
	}

	async getEntries(): Promise<SessionTreeEntry[]> {
		const rows = await this.executor.query<EntryRow>(
			`
SELECT entry_id, payload, is_leaf_marker, created_at
FROM session_entries
WHERE tenant_id = $1::uuid AND session_id = $2::uuid
ORDER BY sequence ASC
			`.trim(),
			[this.tenantId, this.sessionId],
		);
		return rows.map(parseEntry);
	}
}

function parseEntry(row: EntryRow): SessionTreeEntry {
	const parsed = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new SessionError("invalid_session", `Entry ${row.entry_id} has an invalid payload`);
	}
	return parsed as SessionTreeEntry;
}

function leafIdAfterEntry(entry: SessionTreeEntry): string | null {
	return entry.type === "leaf" ? entry.targetId : entry.id;
}
