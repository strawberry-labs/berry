import type { MemoryItem } from "@berry/shared";
import { describe, expect, it } from "vitest";
import { groupActiveMemories, withoutMemory } from "./memory-settings-screen";

function memory(id: string, kind: string, status: MemoryItem["status"] = "active"): MemoryItem {
  const timestamp = "2026-07-28T00:00:00.000Z";
  return {
    id,
    tenantId: "tenant-1",
    userId: "user-1",
    workspaceId: null,
    scope: "personal",
    kind,
    stableKey: id,
    content: `Memory ${id}`,
    value: {},
    status,
    explicit: true,
    confidence: 1,
    salience: 1,
    validFrom: null,
    validUntil: null,
    expiresAt: null,
    extractorVersion: "manual-v1",
    sourceTaskId: null,
    sourceSessionId: null,
    sourceMessageId: null,
    supersededItemId: null,
    lastSeenAt: timestamp,
    lastUsedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

describe("personal memory view helpers", () => {
  it("groups active memories deterministically and omits forgotten versions", () => {
    const groups = groupActiveMemories([
      memory("b", "profile"),
      memory("a", "preference"),
      memory("old", "profile", "forgotten"),
    ]);

    expect(groups.map((group) => group.kind)).toEqual(["preference", "profile"]);
    expect(groups.flatMap((group) => group.items.map((item) => item.id))).toEqual(["a", "b"]);
  });

  it("removes only the confirmed memory", () => {
    expect(withoutMemory([memory("a", "profile"), memory("b", "profile")], "a").map((item) => item.id)).toEqual(["b"]);
  });
});
