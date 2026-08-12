import { describe, expect, it, vi } from "vitest";
import type { DurableTurnSnapshot, DurableTurnToolExecutor } from "../turn-runner.js";
import { DurablePersonalSkillToolExecutor } from "./tools.js";

describe("DurablePersonalSkillToolExecutor", () => {
  it("preserves inherited dynamic tool definitions", async () => {
    const snapshot = {
      tenantId: "00000000-0000-7000-8000-000000000001",
      userId: "user_1",
    } as DurableTurnSnapshot;
    const definitions = [{
      type: "function" as const,
      function: {
        name: "remember_memory",
        description: "Remember a durable preference",
        parameters: { type: "object" },
      },
    }];
    const base: DurableTurnToolExecutor = {
      definitions: vi.fn(async () => definitions),
      execute: vi.fn(async () => ({ output: {}, summary: "base" })),
    };
    const tools = new DurablePersonalSkillToolExecutor(base, {
      execute: vi.fn(async () => undefined),
      query: vi.fn(async () => []),
    });

    await expect(tools.definitions(snapshot)).resolves.toEqual(definitions);
    expect(base.definitions).toHaveBeenCalledWith(snapshot);
  });

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

  it("imports a large skill from a completed workspace SKILL.md path", async () => {
    const content = "---\nname: imported-skill\ndescription: Imported from the durable workspace\n---\n\nUse the supplied workflow.";
    const execute = vi.fn(async () => undefined);
    const read = vi.fn(async () => ({
      output: { path: "/workspace/skills/imported/SKILL.md", content, sizeBytes: content.length },
      summary: "read",
    }));
    const tools = new DurablePersonalSkillToolExecutor({ execute: read }, {
      execute,
      query: vi.fn(async () => []),
    });

    await expect(tools.execute({ tenantId: "tenant", userId: "user" } as never, {
      id: "step_path",
      type: "tool.save_personal_skill",
      input: {
        toolName: "save_personal_skill",
        arguments: { path: "/workspace/skills/imported/SKILL.md" },
      },
    } as never)).resolves.toMatchObject({
      output: { skill: { name: "imported-skill" } },
    });
    expect(read).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      type: "tool.read_file",
      input: expect.objectContaining({
        toolName: "read_file",
        arguments: { path: "/workspace/skills/imported/SKILL.md" },
      }),
    }));
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO personal_skills"),
      expect.arrayContaining([content]),
    );
  });

  it("persists scripts and assets from a workspace skill package", async () => {
    const content = "---\nname: packaged-skill\ndescription: Uses a retained template and script\n---\n\nRun scripts/build.py with assets/template.docx.";
    const execute = vi.fn(async () => undefined);
    const base: DurableTurnToolExecutor = {
      execute: vi.fn(async () => ({ output: {}, summary: "base" })),
      readSkillPackage: vi.fn(async () => [
        { path: "SKILL.md", contentBase64: Buffer.from(content).toString("base64"), mode: 0o644 },
        { path: "scripts/build.py", contentBase64: Buffer.from("print('ok')\n").toString("base64"), mode: 0o755 },
        { path: "assets/template.docx", contentBase64: Buffer.from("docx-bytes").toString("base64"), mode: 0o644 },
      ]),
    };
    const tools = new DurablePersonalSkillToolExecutor(base, { execute, query: vi.fn(async () => []) });

    await expect(tools.execute({ tenantId: "tenant", userId: "user" } as never, {
      id: "step_package",
      type: "tool.save_personal_skill",
      input: { toolName: "save_personal_skill", arguments: { path: "/workspace/skills/packaged-skill" } },
    } as never)).resolves.toMatchObject({
      output: { skill: { name: "packaged-skill", resources: ["scripts/build.py", "assets/template.docx"] } },
    });
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO personal_skill_files"),
      expect.arrayContaining(["scripts/build.py", 0o755]),
    );
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO personal_skill_files"),
      expect.arrayContaining(["assets/template.docx", 0o644]),
    );
  });
});
