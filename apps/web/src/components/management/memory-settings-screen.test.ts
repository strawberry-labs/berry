import type { MemoryItem } from "@berry/shared";
import { describe, expect, it } from "vitest";
import { groupActiveMemories, importMemoryEntries, parseMemoryImport, withoutMemory } from "./memory-settings-screen";

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

  it("parses a categorized cross-provider export and preserves known source dates", () => {
    expect(parseMemoryImport(`\`\`\`
## Instructions
[2024-01-04] - Use concise headings.
## Identity
[unknown] - My name is Sam.
## Career
[2025-03-02] - I work in sustainability consulting.
## Projects
[unknown] - Atlas: a live reporting tool.
## Preferences
[2026-01-01] - I prefer tables for comparisons.
\`\`\`
This is the complete set.`)).toEqual([
      { kind: "working_convention", content: "Use concise headings.", sourceDate: "2024-01-04" },
      { kind: "profile", content: "My name is Sam.", sourceDate: null },
      { kind: "career", content: "I work in sustainability consulting.", sourceDate: "2025-03-02" },
      { kind: "project", content: "Atlas: a live reporting tool.", sourceDate: null },
      { kind: "preference", content: "I prefer tables for comparisons.", sourceDate: "2026-01-01" },
    ]);
  });

  it("parses ChatGPT's numbered section format and skips empty-section statements", () => {
    expect(parseMemoryImport(`
1. Instructions

[unknown] – No explicit long-term instruction/rule records were found in the stored-memory set.

2. Identity

[2025-05-01] – Personal interest: nomading and backpacking around countries.
[2025-05-14] – Name: Chirag Asarpota. In a user-authored visa draft,
the wording was “I, Chirag Asarpota”.
[unknown] – I found no reliable explicit record of your age or education.

3. Career

[2026-04-27] – An email signature used the title “Founder & CEO”.
`)).toEqual([
      {
        kind: "profile",
        content: "Personal interest: nomading and backpacking around countries.",
        sourceDate: "2025-05-01",
      },
      {
        kind: "profile",
        content: "Name: Chirag Asarpota. In a user-authored visa draft, the wording was “I, Chirag Asarpota”.",
        sourceDate: "2025-05-14",
      },
      {
        kind: "career",
        content: "An email signature used the title “Founder & CEO”.",
        sourceDate: "2026-04-27",
      },
    ]);
  });

  it("accepts raw copied memory lines and removes duplicates", () => {
    expect(parseMemoryImport(`- Prefers UK English
- Prefers UK English
• Keep responses concise`)).toEqual([
      { kind: "preference", content: "Prefers UK English", sourceDate: null },
      { kind: "preference", content: "Keep responses concise", sourceDate: null },
    ]);
  });

  it("accepts Berry JSON exports but skips project and inactive entries", () => {
    expect(parseMemoryImport(JSON.stringify({ items: [
      { kind: "profile", content: "Personal", scope: "personal", status: "active" },
      { kind: "project", content: "Project only", scope: "project", status: "active" },
      { kind: "preference", content: "Old", scope: "personal", status: "forgotten" },
    ] }))).toEqual([{ kind: "profile", content: "Personal", sourceDate: null }]);
  });

  it("splits oversized Berry JSON entries without losing content", () => {
    const content = `${"A".repeat(19_900)} ${"B".repeat(200)}`;
    const entries = parseMemoryImport(JSON.stringify({ items: [
      { kind: "profile", content, scope: "personal", status: "active" },
    ] }));

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.content).join(" ")).toBe(content);
    expect(entries.every((entry) => entry.content.length <= 20_000)).toBe(true);
  });

  it("does not cap the number of imported entries", () => {
    const exportText = [
      "5. Preferences",
      ...Array.from({ length: 350 }, (_, index) => `[2026-01-01] - Preference ${index + 1}`),
    ].join("\n");

    expect(parseMemoryImport(exportText)).toHaveLength(350);
  });

  it("writes every parsed entry and preserves import metadata", async () => {
    const entries = parseMemoryImport([
      "2. Identity",
      ...Array.from({ length: 350 }, (_, index) => `[2026-01-01] - Identity ${index + 1}`),
    ].join("\n"));
    const calls: Array<Record<string, unknown>> = [];
    const client = {
      rememberMemory: async (input: Record<string, unknown>) => {
        calls.push(input);
        return {
          operation: "ADD" as const,
          reason: "explicit_user_memory",
          item: memory(`imported-${calls.length}`, String(input.kind)),
        };
      },
    };

    const result = await importMemoryEntries(client, entries);

    expect(result.failures).toEqual([]);
    expect(result.imported).toHaveLength(350);
    expect(calls).toHaveLength(350);
    expect(calls[0]).toMatchObject({
      scope: "personal",
      kind: "profile",
      content: "Identity 1",
      value: { importedFrom: "assistant_export", sourceDate: "2026-01-01" },
    });
    expect(calls[349]).toMatchObject({ content: "Identity 350" });
  });
});
