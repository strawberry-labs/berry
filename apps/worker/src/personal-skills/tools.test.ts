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
  it("declares activation abort support, keeps saving non-abortable, and delegates other tools", () => {
    const baseSupportsAbort = vi.fn(() => true);
    const tools = new DurablePersonalSkillToolExecutor({
      supportsAbort: baseSupportsAbort,
      execute: vi.fn(async () => ({ output: {}, summary: "base" })),
    }, { execute: vi.fn(), query: vi.fn(async () => []) });
    const snapshot = storedSkillSnapshot();

    expect(tools.supportsAbort(snapshot, {
      type: "tool.activate_skill",
      input: { toolName: "activate_skill", arguments: { name: "branding" } },
    } as never)).toBe(true);
    expect(tools.supportsAbort(snapshot, {
      type: "tool.save_personal_skill",
      input: { toolName: "save_personal_skill", arguments: { content: "x" } },
    } as never)).toBe(false);
    expect(tools.supportsAbort(snapshot, {
      type: "tool.read",
      input: { toolName: "read", arguments: { path: "/workspace/file.txt" } },
    } as never)).toBe(true);
    expect(baseSupportsAbort).toHaveBeenCalledTimes(1);
  });

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

  it("activates instructions without sandbox calls, then bulk-loads only requested files", async () => {
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
        filePath: "/workspace/runtime-skills/branding-0123456789abcdef/SKILL.md",
        resources: resources.map((resource) => `/workspace/runtime-skills/branding-0123456789abcdef/${resource.path}`),
        stagedResources: requested.map((path) => `/workspace/runtime-skills/branding-0123456789abcdef/${path}`),
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
      location: "/organization-skills/org-capability/SKILL.md",
      directory: "/organization-skills/org-capability",
      availableResources: ["scripts/build.py", "assets/template.docx"],
      deferredResources: ["scripts/build.py", "assets/template.docx"],
      stagedRelativeResources: [],
      stagedResources: [],
      stagedResourcePaths: [],
    });
    expect(activated.output).not.toHaveProperty("stagingSandboxId");
    expect(stageSkillPackage).not.toHaveBeenCalled();
    expect(JSON.stringify(activated.output)).toContain(DEFERRED_SKILL_RESOURCE_INSTRUCTIONS);
    expect(JSON.stringify(activated.output)).toContain('location=\\"/organization-skills/org-capability/SKILL.md\\"');
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
    const repeated = await tools.execute(snapshot, {
      id: "activate-repeat",
      type: "tool.activate_skill",
      input: { toolName: "activate_skill", arguments: { name: "branding" } },
    } as never);
    expect(repeated.output).toMatchObject({ alreadyActive: true, location: "/organization-skills/org-capability/SKILL.md" });
    expect(query.mock.calls.filter(([sql]) => String(sql).includes("SELECT path,size_bytes,sha256,mode"))).toHaveLength(1);

    const activationSignal = new AbortController();
    const activationProgress = vi.fn();
    const loaded = await tools.execute(snapshot, {
      id: "activate-2",
      type: "tool.activate_skill",
      input: {
        toolName: "activate_skill",
        arguments: { name: "branding", resources: ["scripts/build.py", "assets/template.docx"] },
      },
    } as never, activationSignal.signal, activationProgress);

    expect(loaded.summary).toBe("Loaded 2 branding resource files");
    expect(loaded.output).toMatchObject({
      alreadyActive: true,
      deferredResources: [],
      stagedRelativeResources: ["scripts/build.py", "assets/template.docx"],
      stagedResources: [
        "/workspace/runtime-skills/branding-0123456789abcdef/scripts/build.py",
        "/workspace/runtime-skills/branding-0123456789abcdef/assets/template.docx",
      ],
    });
    expect(stageSkillPackage.mock.calls[0]?.[3]).toMatchObject({
      resourcePaths: ["scripts/build.py", "assets/template.docx"],
      signal: activationSignal.signal,
      reportProgress: activationProgress,
    });
    expect(stageSkillPackage).toHaveBeenCalledTimes(1);
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
    snapshot.sandboxId = "sandbox-branding";
    const queriesBeforeStagedReuse = query.mock.calls.length;
    const repeatedAfterStaging = await tools.execute(snapshot, {
      id: "activate-repeat-staged",
      sequence: 3,
      type: "tool.activate_skill",
      input: { toolName: "activate_skill", arguments: { name: "branding" } },
    } as never);
    expect(repeatedAfterStaging.output).toMatchObject({
      alreadyActive: true,
      location: "/workspace/runtime-skills/branding-0123456789abcdef/SKILL.md",
      deferredResources: [],
      stagedRelativeResources: ["scripts/build.py", "assets/template.docx"],
      stagedResourcePaths: [
        "/workspace/runtime-skills/branding-0123456789abcdef/scripts/build.py",
        "/workspace/runtime-skills/branding-0123456789abcdef/assets/template.docx",
      ],
      stagingSandboxId: "sandbox-branding",
    });
    expect(query).toHaveBeenCalledTimes(queriesBeforeStagedReuse);
    expect(stageSkillPackage).toHaveBeenCalledTimes(1);

    await tools.execute(snapshot, {
      id: "read-staged",
      sequence: 3,
      type: "tool.read",
      input: {
        toolName: "read",
        arguments: { path: "/workspace/runtime-skills/branding-0123456789abcdef/scripts/build.py" },
      },
    } as never);
    expect(stageSkillPackage).toHaveBeenCalledTimes(1);
  });

  it("rejects an exact known deferred resource until explicit activation", async () => {
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
    const runtimeRequest = snapshot.runtimeRequest as { extraSkills: Array<{ resources?: string[] | undefined }> };
    runtimeRequest.extraSkills[0]!.resources = [`/organization-skills/org-capability/${resource.path}`];
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
        arguments: { path: "/organization-skills/org-capability/references/brand.md" },
      },
    } as never)).rejects.toMatchObject({
      name: "ResourceNotStagedError",
      code: "RESOURCE_NOT_STAGED",
      message: expect.stringContaining('activate_skill with {"name":"branding","resources":["references/brand.md"]}'),
    });
    expect(stageSkillPackage).not.toHaveBeenCalled();
    expect(baseExecute).not.toHaveBeenCalled();

    const loaded = await tools.execute(snapshot, {
      id: "activate-read-resource",
      sequence: 3,
      type: "tool.activate_skill",
      input: { toolName: "activate_skill", arguments: { name: "branding", resources: ["references/brand.md"] } },
    } as never);
    expect(stageSkillPackage).toHaveBeenCalledTimes(1);
    expect(stageSkillPackage.mock.calls[0]?.[3]).toMatchObject({ resourcePaths: ["references/brand.md"] });
    snapshot.steps = [...snapshot.steps, {
      id: "activate-read-resource",
      sequence: 3,
      type: "tool.activate_skill",
      state: "completed",
      attempt: 1,
      input: { toolName: "activate_skill", arguments: { name: "branding", resources: ["references/brand.md"] } },
      output: loaded.output,
      error: null,
      retryClass: "idempotent_with_key",
      idempotencyKey: "activate-read-resource",
    }];
    snapshot.sandboxId = "sandbox-branding";

    await expect(tools.execute(snapshot, {
      id: "read-brand-staged",
      sequence: 4,
      type: "tool.read",
      input: {
        toolName: "read",
        arguments: { path: "/workspace/runtime-skills/branding-revision/references/brand.md" },
      },
    } as never)).resolves.toMatchObject({ summary: "read" });

    expect(baseExecute).toHaveBeenCalledTimes(1);
    expect(baseExecute).toHaveBeenCalledWith(snapshot, expect.objectContaining({ type: "tool.read" }));

    snapshot.sandboxId = "sandbox-replacement";
    const queriesBeforeReplacementReuse = query.mock.calls.length;
    const repeatedAfterReplacement = await tools.execute(snapshot, {
      id: "activate-after-replacement",
      sequence: 5,
      type: "tool.activate_skill",
      input: { toolName: "activate_skill", arguments: { name: "branding" } },
    } as never);
    expect(repeatedAfterReplacement.output).toMatchObject({
      alreadyActive: true,
      location: "/organization-skills/org-capability/SKILL.md",
      deferredResources: ["references/brand.md"],
      stagedRelativeResources: [],
      stagedResourcePaths: [],
    });
    expect(stageSkillPackage).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(queriesBeforeReplacementReuse);

    await expect(tools.execute(snapshot, {
      id: "read-brand-after-replacement",
      sequence: 6,
      type: "tool.read",
      input: {
        toolName: "read",
        arguments: { path: "/workspace/runtime-skills/branding-revision/references/brand.md" },
      },
    } as never)).rejects.toMatchObject({
      code: "RESOURCE_NOT_STAGED",
      message: expect.stringContaining('activate_skill with {"name":"branding","resources":["references/brand.md"]}'),
    });

    snapshot.sandboxId = "sandbox-branding";
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

    expect(stageSkillPackage).toHaveBeenCalledTimes(1);
    expect(baseExecute).toHaveBeenCalledTimes(4);
  });

  it("reuses metadata-only activation for production-shaped personal skill resources", async () => {
    const query = vi.fn(async (sql: string) => sql.includes("SELECT path,size_bytes,sha256,mode")
      ? [{
          path: "references/preferences.md",
          size_bytes: 11,
          sha256: createHash("sha256").update("preferences").digest("hex"),
          mode: 0o644,
        }]
      : []);
    const stageSkillPackage = vi.fn();
    const tools = new DurablePersonalSkillToolExecutor({
      execute: vi.fn(async () => ({ output: {}, summary: "base" })),
      stageSkillPackage,
    }, { execute: vi.fn(), query: query as never });
    const snapshot = storedSkillSnapshot();
    const runtimeRequest = snapshot.runtimeRequest as {
      extraSkills: Array<{ filePath: string; resources?: string[] | undefined }>;
    };
    runtimeRequest.extraSkills[0]!.filePath = "/personal-skills/personal-skill/SKILL.md";
    runtimeRequest.extraSkills[0]!.resources = [
      "/personal-skills/personal-skill/references/preferences.md",
    ];

    const activated = await tools.execute(snapshot, {
      id: "activate-personal",
      sequence: 1,
      type: "tool.activate_skill",
      input: { toolName: "activate_skill", arguments: { name: "branding" } },
    } as never);
    snapshot.steps = [{
      id: "activate-personal",
      sequence: 1,
      type: "tool.activate_skill",
      state: "completed",
      attempt: 1,
      input: { toolName: "activate_skill", arguments: { name: "branding" } },
      output: activated.output,
      error: null,
      retryClass: "idempotent_with_key",
      idempotencyKey: "activate-personal",
    }];
    const queryCount = query.mock.calls.length;

    await expect(tools.execute(snapshot, {
      id: "activate-personal-repeat",
      sequence: 2,
      type: "tool.activate_skill",
      input: { toolName: "activate_skill", arguments: { name: "branding" } },
    } as never)).resolves.toMatchObject({
      output: {
        alreadyActive: true,
        location: "/personal-skills/personal-skill/SKILL.md",
        availableResources: ["references/preferences.md"],
      },
    });
    expect(query).toHaveBeenCalledTimes(queryCount);
    expect(stageSkillPackage).not.toHaveBeenCalled();
  });

  it("does not stage an unknown or out-of-scope read path", async () => {
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

    expect(stageSkillPackage).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => String(sql).includes("SELECT path,content"))).toBe(false);
    expect(baseExecute).toHaveBeenCalledTimes(1);
  });

  it("tells the model not to retry a resource that belongs to another skill package", async () => {
    const query = vi.fn(async (sql: string) => sql.includes("SELECT path,size_bytes,sha256,mode")
      ? [{ path: "scripts/validate_artifact.py", size_bytes: 11, sha256: "a".repeat(64), mode: 0o755 }]
      : []);
    const stageSkillPackage = vi.fn();
    const tools = new DurablePersonalSkillToolExecutor({
      execute: vi.fn(async () => ({ output: {}, summary: "base" })),
      stageSkillPackage,
    }, { execute: vi.fn(), query: query as never });

    await expect(tools.execute(storedSkillSnapshot(), {
      id: "activate-wrong-package",
      sequence: 1,
      type: "tool.activate_skill",
      input: {
        toolName: "activate_skill",
        arguments: { name: "branding", resources: ["scripts/create_aesg_docx.py"] },
      },
    } as never)).rejects.toThrow(
      "Resource paths belong to exactly one skill package. Do not retry this activation with the same resource.",
    );
    expect(stageSkillPackage).not.toHaveBeenCalled();
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
      resources: [
        "/organization-skills/org-capability/scripts/build.py",
        "/organization-skills/org-capability/assets/template.docx",
      ],
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
