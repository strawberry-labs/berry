import type { BerryDatabase } from "@berry/desktop-db";
import {
  getEntriesToFork,
  Session,
  SessionError,
  uuidv7,
  type LeafEntry,
  type SessionCreateOptions,
  type SessionForkOptions,
  type SessionMetadata,
  type SessionRepo,
  type SessionStorage,
  type SessionTreeEntry,
} from "@berry/harness";
import { nowIso, type JsonValue } from "@berry/shared";

function leafIdAfterEntry(entry: SessionTreeEntry): string | null {
  return entry.type === "leaf" ? entry.targetId : entry.id;
}

function updateLabelCache(labelsById: Map<string, string>, entry: SessionTreeEntry): void {
  if (entry.type !== "label") return;
  const label = entry.label?.trim();
  if (label) labelsById.set(entry.targetId, label);
  else labelsById.delete(entry.targetId);
}

function generateEntryId(byId: { has(id: string): boolean }): string {
  for (let i = 0; i < 100; i++) {
    const id = uuidv7().slice(0, 8);
    if (!byId.has(id)) return id;
  }
  return uuidv7();
}

/**
 * Harness SessionStorage backed by the desktop SQLite database
 * (`session_entries` append-only table). Every SessionTreeEntry round-trips
 * through its JSON payload.
 */
export class SqliteSessionStorage implements SessionStorage<SessionMetadata> {
  readonly #db: BerryDatabase;
  readonly #metadata: SessionMetadata;
  #entries: SessionTreeEntry[];
  #byId: Map<string, SessionTreeEntry>;
  #labelsById: Map<string, string>;
  #leafId: string | null;

  constructor(db: BerryDatabase, sessionId: string) {
    this.#db = db;
    const rows = db.sessionEntries().list(sessionId);
    this.#entries = rows.map((row) => row.payload as unknown as SessionTreeEntry);
    this.#byId = new Map(this.#entries.map((entry) => [entry.id, entry]));
    this.#labelsById = new Map();
    this.#leafId = null;
    for (const entry of this.#entries) {
      updateLabelCache(this.#labelsById, entry);
      this.#leafId = leafIdAfterEntry(entry);
    }
    if (this.#leafId !== null && !this.#byId.has(this.#leafId)) {
      throw new SessionError("invalid_session", `Entry ${this.#leafId} not found`);
    }
    this.#metadata = { id: sessionId, createdAt: this.#entries[0]?.timestamp ?? nowIso() };
  }

  #persist(entry: SessionTreeEntry): void {
    this.#db.sessionEntries().append(this.#metadata.id, {
      id: entry.id,
      parentId: entry.parentId,
      type: entry.type,
      timestamp: entry.timestamp,
      payload: entry as unknown as JsonValue,
    });
  }

  async getMetadata(): Promise<SessionMetadata> {
    return this.#metadata;
  }

  async getLeafId(): Promise<string | null> {
    if (this.#leafId !== null && !this.#byId.has(this.#leafId)) {
      throw new SessionError("invalid_session", `Entry ${this.#leafId} not found`);
    }
    return this.#leafId;
  }

  async setLeafId(leafId: string | null): Promise<void> {
    if (leafId !== null && !this.#byId.has(leafId)) {
      throw new SessionError("not_found", `Entry ${leafId} not found`);
    }
    const entry: LeafEntry = {
      type: "leaf",
      id: generateEntryId(this.#byId),
      parentId: this.#leafId,
      timestamp: new Date().toISOString(),
      targetId: leafId,
    };
    this.#persist(entry);
    this.#entries.push(entry);
    this.#byId.set(entry.id, entry);
    this.#leafId = leafId;
  }

  async createEntryId(): Promise<string> {
    return generateEntryId(this.#byId);
  }

  async appendEntry(entry: SessionTreeEntry): Promise<void> {
    this.#persist(entry);
    this.#entries.push(entry);
    this.#byId.set(entry.id, entry);
    updateLabelCache(this.#labelsById, entry);
    this.#leafId = leafIdAfterEntry(entry);
  }

  async getEntry(id: string): Promise<SessionTreeEntry | undefined> {
    return this.#byId.get(id);
  }

  async findEntries<TType extends SessionTreeEntry["type"]>(
    type: TType,
  ): Promise<Array<Extract<SessionTreeEntry, { type: TType }>>> {
    return this.#entries.filter((entry): entry is Extract<SessionTreeEntry, { type: TType }> => entry.type === type);
  }

  async getLabel(id: string): Promise<string | undefined> {
    return this.#labelsById.get(id);
  }

  async getPathToRoot(leafId: string | null): Promise<SessionTreeEntry[]> {
    if (leafId === null) return [];
    const path: SessionTreeEntry[] = [];
    let current = this.#byId.get(leafId);
    if (!current) throw new SessionError("not_found", `Entry ${leafId} not found`);
    while (current) {
      path.unshift(current);
      if (!current.parentId) break;
      const parent = this.#byId.get(current.parentId);
      if (!parent) throw new SessionError("invalid_session", `Entry ${current.parentId} not found`);
      current = parent;
    }
    return path;
  }

  async getEntries(): Promise<SessionTreeEntry[]> {
    return [...this.#entries];
  }
}

export interface SqliteSessionCreateOptions extends SessionCreateOptions {}

/** Harness SessionRepo over `session_entries`. Sessions are keyed by Berry session ids. */
export class SqliteSessionRepo implements SessionRepo<SessionMetadata, SqliteSessionCreateOptions, void> {
  readonly #db: BerryDatabase;

  constructor(db: BerryDatabase) {
    this.#db = db;
  }

  async create(options: SqliteSessionCreateOptions = {}): Promise<Session<SessionMetadata>> {
    const id = options.id ?? uuidv7();
    return new Session(new SqliteSessionStorage(this.#db, id));
  }

  async open(metadata: SessionMetadata): Promise<Session<SessionMetadata>> {
    return new Session(new SqliteSessionStorage(this.#db, metadata.id));
  }

  async openById(sessionId: string): Promise<Session<SessionMetadata>> {
    return new Session(new SqliteSessionStorage(this.#db, sessionId));
  }

  async list(): Promise<SessionMetadata[]> {
    const ids = this.#db.sessionEntries().listSessionIds();
    const metadata: SessionMetadata[] = [];
    for (const id of ids) {
      const storage = new SqliteSessionStorage(this.#db, id);
      metadata.push(await storage.getMetadata());
    }
    return metadata;
  }

  async delete(metadata: SessionMetadata): Promise<void> {
    this.#db.sessionEntries().deleteSession(metadata.id);
  }

  async fork(
    source: SessionMetadata,
    options: SessionForkOptions & SqliteSessionCreateOptions,
  ): Promise<Session<SessionMetadata>> {
    const sourceStorage = new SqliteSessionStorage(this.#db, source.id);
    const forkedEntries = await getEntriesToFork(sourceStorage, options);
    const id = options.id ?? uuidv7();
    if (this.#db.sessionEntries().list(id).length > 0) {
      throw new SessionError("invalid_fork_target", `Session ${id} already has entries`);
    }
    const storage = new SqliteSessionStorage(this.#db, id);
    for (const entry of forkedEntries) {
      await storage.appendEntry(entry);
    }
    return new Session(storage);
  }
}
