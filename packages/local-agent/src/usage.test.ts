import { BerryDatabase } from "@berry/desktop-db";
import { describe, expect, it } from "vitest";
import { recordUsage } from "./usage.ts";
import { buildPromptManifest } from "./prompt-cache.ts";

describe("recordUsage", () => {
  it("drops cloud-only task and session references that are absent from the runtime database", () => {
    const db = new BerryDatabase(":memory:");
    db.migrate();

    expect(() => recordUsage(db, {
      providerId: "router",
      taskId: "cloud-task-id",
      sessionId: "cloud-session-id",
      model: "model-id",
      inputTokens: 12,
      outputTokens: 4,
    })).not.toThrow();

    expect(db.db.prepare("SELECT task_id, session_id FROM usage_records").get()).toEqual({ task_id: null, session_id: null });
    db.close();
  });

  it("keeps manifest hashes stable for canonical schemas and changes the affected component", () => {
    const input = {
      provider: "openai",
      model: "gpt-test",
      route: "/responses",
      retention: "long" as const,
      context: {
        systemPrompt: "stable instructions",
        messages: [],
        tools: [{
          name: "lookup",
          description: "Lookup",
          parameters: { type: "object", properties: { b: { type: "number" }, a: { type: "string" } } } as never,
        }],
      },
    };
    const first = buildPromptManifest(input);
    const semanticallyEqual = buildPromptManifest({
      ...input,
      context: {
        ...input.context,
        tools: [{
          ...input.context.tools[0]!,
          parameters: { properties: { a: { type: "string" }, b: { type: "number" } }, type: "object" } as never,
        }],
      },
    });
    const changed = buildPromptManifest({ ...input, context: { ...input.context, systemPrompt: "changed instructions" } });
    expect(semanticallyEqual.manifestHash).toBe(first.manifestHash);
    expect(changed.manifestHash).not.toBe(first.manifestHash);
    expect(changed.components.find((component) => component.id === "system:stable")?.hash)
      .not.toBe(first.components.find((component) => component.id === "system:stable")?.hash);
  });
});
