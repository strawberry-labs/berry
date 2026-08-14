import { createHash } from "node:crypto";
import {
  DEFERRED_SKILL_RESOURCE_INSTRUCTIONS,
  DURABLE_BASE_BUILT_IN_TOOLS,
  DurableTurnRuntimeRequestSchema,
} from "@berry/shared";
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
      type: "tool.read",
      input: expect.objectContaining({
        toolName: "read",
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
      expect.arrayContaining([
        ["scripts/build.py", "assets/template.docx"],
        [0o755, 0o644],
      ]),
    );
  });

  it("activates instructions without resource bytes, then bulk-loads only requested files", async () => {
    const resources = [
      { path: "scripts/build.py", content: Buffer.from("print('ok')\n"), mode: 0o755 },
      { path: "assets/template.docx", content: Buffer.from("template-bytes"), mode: 0o644 },
    ].map((resource) => ({
      ...resource,
      size_bytes: resource.content.byteLength,
      sha256: createHash("sha256").update(resource.content).digest("hex"),
    }));
    const query = vi.fn(async (sql: string, params?: readonly unknown[]) => {
      if (sql.includes("SELECT path,size_bytes,sha256,mode")) {
        return resources.map(({ content: _content, ...resource }) => resource);
      }
      if (sql.includes("SELECT path,content")) {
        const selected = new Set(params?.[1] as string[] | undefined);
        return resources.filter((resource) => selected.has(resource.path)).map(({ path, content }) => ({ path, content }));
      }
      return [];
    });
    const stageSkillPackage = vi.fn(async (
      _snapshot: DurableTurnSnapshot,
      _packageId: string,
      _files: unknown,
      options?: Parameters<NonNullable<DurableTurnToolExecutor["stageSkillPackage"]>>[3],
    ) => {
      const requested = options?.resourcePaths ?? resources.map((resource) => resource.path);
      if (requested.length > 0) await options?.loadContentBytes?.(requested);
      return {
        filePath: "/workspace/runtime-skills/branding-revision/SKILL.md",
        resources: resources.map((resource) => `/workspace/runtime-skills/branding-revision/${resource.path}`),
        stagedResources: requested.map((path) => `/workspace/runtime-skills/branding-revision/${path}`),
        stagingSandboxId: "sandbox-branding",
      };
    });
    const base: DurableTurnToolExecutor = {
      execute: vi.fn(async () => ({ output: {}, summary: "base" })),
      stageSkillPackage: stageSkillPackage as NonNullable<DurableTurnToolExecutor["stageSkillPackage"]>,
    };
    const tools = new DurablePersonalSkillToolExecutor(base, {
      execute: vi.fn(),
      query: query as never,
    });
    const snapshot = storedSkillSnapshot();

    const activated = await tools.execute(snapshot, {
      id: "activate-1",
      type: "tool.activate_skill",
      input: { toolName: "activate_skill", arguments: { name: "branding" } },
    } as never);

    expect(activated.output).toMatchObject({
      skill: "branding",
      directory: "/workspace/runtime-skills/branding-revision",
      availableResources: ["scripts/build.py", "assets/template.docx"],
      deferredResources: ["scripts/build.py", "assets/template.docx"],
      stagedRelativeResources: [],
      stagedResources: [],
      stagedResourcePaths: [],
      stagingSandboxId: "sandbox-branding",
    });
    expect(JSON.stringify(activated.output)).toContain(DEFERRED_SKILL_RESOURCE_INSTRUCTIONS);
    expect(JSON.stringify(activated.output)).toContain('location=\\"/workspace/runtime-skills/branding-revision/SKILL.md\\"');
    expect(JSON.stringify(activated.output)).toContain('<staged_resources empty=\\"true\\" />');
    expect(query.mock.calls.filter(([sql]) => String(sql).includes("SELECT path,content"))).toHaveLength(0);

    snapshot.steps = [{
      id: "activate-1",
      sequence: 1,
      type: "tool.activate_skill",
      state: "completed",
      attempt: 1,
      input: { toolName: "activate_skill", arguments: { name: "branding" } },
      output: activated.output,
      error: null,
      retryClass: "idempotent_with_key",
      idempotencyKey: "activate-1",
    }];
    const loaded = await tools.execute(snapshot, {
      id: "activate-2",
      type: "tool.activate_skill",
      input: {
        toolName: "activate_skill",
        arguments: { name: "branding", resources: ["scripts/build.py", "assets/template.docx"] },
      },
    } as never);

    expect(loaded.summary).toBe("Loaded 2 branding resource files");
    expect(loaded.output).toMatchObject({
      alreadyActive: true,
      deferredResources: [],
      stagedRelativeResources: ["scripts/build.py", "assets/template.docx"],
      stagedResources: [
        "/workspace/runtime-skills/branding-revision/scripts/build.py",
        "/workspace/runtime-skills/branding-revision/assets/template.docx",
      ],
    });
    expect(stageSkillPackage.mock.calls[1]?.[3]).toMatchObject({
      resourcePaths: ["scripts/build.py", "assets/template.docx"],
    });
    expect(query.mock.calls.filter(([sql]) => String(sql).includes("SELECT path,content"))).toHaveLength(1);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("path=ANY($2::text[])"),
      ["org-capability", ["scripts/build.py", "assets/template.docx"]],
    );

    snapshot.steps = [
      ...snapshot.steps,
      {
        id: "activate-2",
        sequence: 2,
        type: "tool.activate_skill",
        state: "completed",
        attempt: 1,
        input: {
          toolName: "activate_skill",
          arguments: { name: "branding", resources: ["scripts/build.py", "assets/template.docx"] },
        },
        output: loaded.output,
        error: null,
        retryClass: "idempotent_with_key",
        idempotencyKey: "activate-2",
      },
    ];
    await tools.execute(snapshot, {
      id: "read-staged",
      sequence: 3,
      type: "tool.read",
      input: {
        toolName: "read",
        arguments: { path: "/workspace/runtime-skills/branding-revision/scripts/build.py" },
      },
    } as never);
    expect(stageSkillPackage).toHaveBeenCalledTimes(2);
  });

  it("materializes an exact known deferred resource before delegating any direct file tool", async () => {
    const resource = {
      path: "references/brand.md",
      content: Buffer.from("brand rules"),
      size_bytes: 11,
      sha256: createHash("sha256").update("brand rules").digest("hex"),
      mode: 0o644,
    };
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT path,size_bytes,sha256,mode")) {
        const { content: _content, ...metadata } = resource;
        return [metadata];
      }
      if (sql.includes("SELECT path,content")) return [{ path: resource.path, content: resource.content }];
      return [];
    });
    const stageSkillPackage = vi.fn(async (
      _snapshot: DurableTurnSnapshot,
      _packageId: string,
      _files: unknown,
      options?: Parameters<NonNullable<DurableTurnToolExecutor["stageSkillPackage"]>>[3],
    ) => {
      const requested = options?.resourcePaths ?? [];
      if (requested.length > 0) await options?.loadContentBytes?.(requested);
      return {
        filePath: "/workspace/runtime-skills/branding-revision/SKILL.md",
        resources: ["/workspace/runtime-skills/branding-revision/references/brand.md"],
        stagedResources: requested.map((path) => `/workspace/runtime-skills/branding-revision/${path}`),
        stagingSandboxId: "sandbox-branding",
      };
    });
    const baseExecute = vi.fn(async () => ({ output: { content: "brand rules" }, summary: "read" }));
    const tools = new DurablePersonalSkillToolExecutor({
      execute: baseExecute,
      stageSkillPackage: stageSkillPackage as NonNullable<DurableTurnToolExecutor["stageSkillPackage"]>,
    }, { execute: vi.fn(), query: query as never });
    const snapshot = storedSkillSnapshot();
    const activated = await tools.execute(snapshot, {
      id: "activate-read",
      sequence: 1,
      type: "tool.activate_skill",
      input: { toolName: "activate_skill", arguments: { name: "branding" } },
    } as never);
    snapshot.steps = [{
      id: "activate-read",
      sequence: 1,
      type: "tool.activate_skill",
      state: "completed",
      attempt: 1,
      input: { toolName: "activate_skill", arguments: { name: "branding" } },
      output: activated.output,
      error: null,
      retryClass: "idempotent_with_key",
      idempotencyKey: "activate-read",
    }];

    await expect(tools.execute(snapshot, {
      id: "read-brand",
      sequence: 2,
      type: "tool.read",
      input: {
        toolName: "read",
        arguments: { path: "/workspace/runtime-skills/branding-revision/references/brand.md" },
      },
    } as never)).resolves.toMatchObject({ summary: "read" });

    expect(stageSkillPackage).toHaveBeenCalledTimes(2);
    expect(stageSkillPackage.mock.calls[1]?.[3]).toMatchObject({ resourcePaths: ["references/brand.md"] });
    expect(baseExecute).toHaveBeenCalledTimes(1);
    expect(baseExecute).toHaveBeenCalledWith(snapshot, expect.objectContaining({ type: "tool.read" }));
    expect(stageSkillPackage.mock.invocationCallOrder[1])
      .toBeLessThan(baseExecute.mock.invocationCallOrder[0]!);

    for (const [index, toolName] of ["grep", "find", "ls"].entries()) {
      await expect(tools.execute(snapshot, {
        id: `${toolName}-brand`,
        sequence: 3 + index,
        type: `tool.${toolName}`,
        input: {
          toolName,
          arguments: { path: "/workspace/runtime-skills/branding-revision/references/brand.md" },
        },
      } as never)).resolves.toMatchObject({ summary: "read" });
    }

    expect(stageSkillPackage).toHaveBeenCalledTimes(5);
    expect(baseExecute).toHaveBeenCalledTimes(4);
    for (let index = 1; index < 5; index += 1) {
      expect(stageSkillPackage.mock.invocationCallOrder[index])
        .toBeLessThan(baseExecute.mock.invocationCallOrder[index - 1]!);
    }
  });

  it("does not materialize an unknown or out-of-scope read path", async () => {
    const query = vi.fn(async (sql: string) => sql.includes("SELECT path,size_bytes,sha256,mode")
      ? [{ path: "references/brand.md", size_bytes: 11, sha256: "a".repeat(64), mode: 0o644 }]
      : []);
    const stageSkillPackage = vi.fn(async () => ({
      filePath: "/workspace/runtime-skills/branding-revision/SKILL.md",
      resources: ["/workspace/runtime-skills/branding-revision/references/brand.md"],
      stagedResources: [],
      stagingSandboxId: "sandbox-branding",
    }));
    const baseExecute = vi.fn(async () => ({ output: { content: "not found" }, summary: "base behavior" }));
    const tools = new DurablePersonalSkillToolExecutor({
      execute: baseExecute,
      stageSkillPackage: stageSkillPackage as never,
    }, { execute: vi.fn(), query: query as never });
    const snapshot = storedSkillSnapshot();
    const activated = await tools.execute(snapshot, {
      id: "activate-unknown",
      sequence: 1,
      type: "tool.activate_skill",
      input: { toolName: "activate_skill", arguments: { name: "branding" } },
    } as never);
    snapshot.steps = [{
      id: "activate-unknown",
      sequence: 1,
      type: "tool.activate_skill",
      state: "completed",
      attempt: 1,
      input: { toolName: "activate_skill", arguments: { name: "branding" } },
      output: activated.output,
      error: null,
      retryClass: "idempotent_with_key",
      idempotencyKey: "activate-unknown",
    }];

    await tools.execute(snapshot, {
      id: "read-unknown",
      sequence: 2,
      type: "tool.read",
      input: {
        toolName: "read",
        arguments: { path: "/workspace/runtime-skills/branding-revision/secrets/not-authorized.txt" },
      },
    } as never);

    expect(stageSkillPackage).toHaveBeenCalledTimes(1);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("SELECT path,content"))).toBe(false);
    expect(baseExecute).toHaveBeenCalledTimes(1);
  });
});

function storedSkillSnapshot(): DurableTurnSnapshot {
  const runtimeRequest = DurableTurnRuntimeRequestSchema.parse({
    capabilityVersion: 1,
    providerId: "router",
    provider: {
      id: "router",
      name: "Router",
      kind: "berry-router",
      baseUrl: "https://router.example/v1",
      defaultModel: "test-model",
    },
    model: "test-model",
    workspacePath: "/workspace",
    workspaceId: "workspace-1",
    permissionMode: "full-access",
    reasoning: "off",
    maxTokens: 4_096,
    contextWindowTokens: 128_000,
    builtInTools: [...DURABLE_BASE_BUILT_IN_TOOLS, "activate_skill"],
    extraSkills: [{
      name: "branding",
      description: "Apply the approved brand",
      content: "---\nname: branding\ndescription: Apply the approved brand\n---\n\nUse requested resources only.",
      filePath: "/organization-skills/org-capability/SKILL.md",
      resources: ["scripts/build.py", "assets/template.docx"],
    }],
  });
  return {
    id: "00000000-0000-7000-8000-000000000901",
    tenantId: "00000000-0000-7000-8000-000000000001",
    userId: "user-1",
    steps: [],
    runtimeRequest,
  } as unknown as DurableTurnSnapshot;
}
