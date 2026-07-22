import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BerryDatabase } from "@berry/desktop-db";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteSessionRepo } from "./session-store.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function testDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "berry-session-store-"));
  tempDirs.push(dir);
  return join(dir, "desktop.db");
}

function openDb(path: string): BerryDatabase {
  const db = new BerryDatabase(path);
  db.migrate();
  return db;
}

function assistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "berry",
    model: "test-model",
    usage: {
      input: 3,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 8,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

describe("SqliteSessionRepo", () => {
  it("round-trips every entry type across a database reopen", async () => {
    const path = testDbPath();
    let db = openDb(path);
    let repo = new SqliteSessionRepo(db);
    const session = await repo.create({ id: "session_rt" });
    await session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
    await session.appendMessage(assistantMessage("hi there"));
    await session.appendThinkingLevelChange("high");
    await session.appendModelChange("berry", "test-model");
    await session.appendActiveToolsChange(["read_file", "bash"]);
    await session.appendCustomEntry("berry-note", { detail: 42 });
    await session.appendCustomMessageEntry("status", "working", true, { step: 1 });
    const entries = await session.getEntries();
    const firstId = entries[0]!.id;
    await session.appendLabel(firstId, "start");
    const before = await session.getEntries();

    db.close();
    db = openDb(path);
    repo = new SqliteSessionRepo(db);
    const reopened = await repo.openById("session_rt");
    const after = await reopened.getEntries();
    expect(after).toEqual(before);
    expect(await reopened.getLabel(firstId)).toBe("start");
    expect((await reopened.getMetadata()).id).toBe("session_rt");

    const context = await reopened.buildContext();
    expect(context.thinkingLevel).toBe("high");
    expect(context.model).toEqual({ provider: "berry", modelId: "test-model" });
    expect(context.activeToolNames).toEqual(["read_file", "bash"]);
    expect(context.messages.length).toBeGreaterThanOrEqual(2);
    db.close();
  });

  it("supports moveTo and getBranch across reopen", async () => {
    const path = testDbPath();
    let db = openDb(path);
    let repo = new SqliteSessionRepo(db);
    const session = await repo.create({ id: "session_branch" });
    const firstId = await session.appendMessage({ role: "user", content: "one", timestamp: 1 });
    await session.appendMessage(assistantMessage("answer one"));
    await session.appendMessage({ role: "user", content: "two", timestamp: 2 });

    expect((await session.getBranch()).map((entry) => entry.id)).toHaveLength(3);
    await session.moveTo(firstId);
    expect(await session.getLeafId()).toBe(firstId);
    expect((await session.getBranch()).map((entry) => entry.id)).toEqual([firstId]);

    const branched = await session.appendMessage({ role: "user", content: "alternate", timestamp: 3 });
    const branch = await session.getBranch();
    expect(branch.map((entry) => entry.id)).toEqual([firstId, branched]);

    db.close();
    db = openDb(path);
    repo = new SqliteSessionRepo(db);
    const reopened = await repo.openById("session_branch");
    expect(await reopened.getLeafId()).toBe(branched);
    expect((await reopened.getBranch()).map((entry) => entry.id)).toEqual([firstId, branched]);
    db.close();
  });

  it("forks a session at an entry", async () => {
    const db = openDb(testDbPath());
    const repo = new SqliteSessionRepo(db);
    const session = await repo.create({ id: "session_src" });
    const firstId = await session.appendMessage({ role: "user", content: "one", timestamp: 1 });
    await session.appendMessage(assistantMessage("answer"));

    const fork = await repo.fork({ id: "session_src", createdAt: "2026-07-01T00:00:00.000Z" }, { id: "session_fork", entryId: firstId, position: "at" });
    expect((await fork.getMetadata()).id).toBe("session_fork");
    expect((await fork.getEntries()).map((entry) => entry.id)).toEqual([firstId]);
    expect(await fork.getLeafId()).toBe(firstId);

    const ids = new SqliteSessionRepo(db);
    expect((await ids.list()).map((meta) => meta.id)).toEqual(expect.arrayContaining(["session_src", "session_fork"]));
    db.close();
  });
});
