import { BerryDatabase } from "@berry/desktop-db";
import { describe, expect, it } from "vitest";
import { recordUsage } from "./usage.ts";

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
});
