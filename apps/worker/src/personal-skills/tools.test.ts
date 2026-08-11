import { describe, expect, it, vi } from "vitest";
import type { DurableTurnSnapshot, DurableTurnToolExecutor } from "../turn-runner.js";
import { DurablePersonalSkillToolExecutor } from "./tools.js";

describe("DurablePersonalSkillToolExecutor", () => {
  it("upserts an enabled skill for the durable turn's tenant and user without approval", async () => {
    const execute = vi.fn(async () => undefined);
    const query = vi.fn(async () => []);
    const base: DurableTurnToolExecutor = {
      execute: vi.fn(async () => ({ output: {}, summary: "base" })),
    };
    const tools = new DurablePersonalSkillToolExecutor(base, { execute, query });
    const snapshot = {
      tenantId: "00000000-0000-7000-8000-000000000001",
      userId: "user_1",
    } as DurableTurnSnapshot;
    const content = "---\nname: decision-brief\ndescription: Create a decision brief from meeting notes\n---\n\nExtract decisions and actions.";

    expect(tools.policy(snapshot, "save_personal_skill", "full-access")).toEqual({
      retryClass: "idempotent_with_key",
      requiresApproval: false,
      approvalKind: "file-edit",
    });
    const result = await tools.execute(snapshot, {
      id: "step_1",
      type: "tool.save_personal_skill",
      input: { toolName: "save_personal_skill", arguments: { content } },
    } as never);

    expect(result.summary).toContain("$decision-brief");
    expect(result.output).toMatchObject({
      skill: { name: "decision-brief", enabled: true },
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("FROM personal_skills"),
      [snapshot.tenantId, snapshot.userId, "decision-brief"],
    );
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("trusted=true"),
      expect.arrayContaining([snapshot.tenantId, snapshot.userId, "decision-brief", content]),
    );
  });

  it("rejects invalid SKILL.md before writing", async () => {
    const execute = vi.fn(async () => undefined);
    const tools = new DurablePersonalSkillToolExecutor({
      execute: vi.fn(async () => ({ output: {}, summary: "base" })),
    }, { execute, query: vi.fn(async () => []) });

    await expect(tools.execute({ tenantId: "tenant", userId: "user" } as never, {
      type: "tool.save_personal_skill",
      input: { toolName: "save_personal_skill", arguments: { content: "# Missing frontmatter" } },
    } as never)).rejects.toThrow("YAML frontmatter");
    expect(execute).not.toHaveBeenCalled();
  });
});
