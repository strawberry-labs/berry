import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { DURABLE_BASE_BUILT_IN_TOOLS, DurableTurnRuntimeRequestSchema } from "@berry/shared";
import type { SandboxProvider } from "@berry/sandbox-contract";
import { DurablePersonalSkillToolExecutor } from "./personal-skills/tools.js";
import { SandboxContinuityManager, type SandboxSnapshotRepository } from "./sandbox-continuity.js";
import type { DurableTurnSnapshot, DurableTurnStep } from "./turn-runner.js";

/*
 * End-to-end skill preparation (H-064/H-007): real activate_skill and
 * SandboxContinuityManager staging against an in-memory sandbox. Fixtures are
 * generated, including the multi-megabyte template; nothing binary is committed.
 */

const MB = 1024 * 1024;
const template = Buffer.alloc(6 * MB, 0x5a);
template.write("PK\u0003\u0004", 0);
const letterhead = Buffer.alloc(1 * MB, 0x6c);

type PackageFile = { path: string; content: Buffer };
const packages: Record<string, { name: string; files: PackageFile[] }> = {
  "org-docx": {
    name: "docx",
    files: [
      { path: "scripts/create_report.py", content: Buffer.from([
        "import argparse",
        "import sys",
        "from pathlib import Path",
        "from helpers import title_case",
        "",
        "def main():",
        "    parser = argparse.ArgumentParser()",
        "    parser.add_argument('--branding-skill-dir', required=True, type=Path)",
        "    parser.add_argument('--output', required=True, type=Path)",
        "    args = parser.parse_args()",
        "    sys.path.insert(0, str(args.branding_skill_dir / 'scripts'))",
        "    from report_structure import structure  # declared cross-skill dependency",
        "    args.output.write_text(title_case(structure()))",
        "",
        "if __name__ == '__main__':",
        "    main()",
        "",
      ].join("\n")) },
      { path: "scripts/helpers.py", content: Buffer.from("from formatting import (\n    upper_words,\n)\n\ndef title_case(value):\n    return upper_words(value)\n") },
      { path: "scripts/formatting.py", content: Buffer.from("def upper_words(value):\n    return value.title()\n") },
      { path: "scripts/unused_tool.py", content: Buffer.from("raise SystemExit('not part of this operation')\n") },
      { path: "skill-dependencies.json", content: Buffer.from(JSON.stringify({
        version: 1,
        entryPoints: { "scripts/create_report.py": { requires: [{ skill: "branding", resources: ["scripts/report_structure.py"] }] } },
      })) },
    ],
  },
  "org-branding": {
    name: "branding",
    files: [
      { path: "scripts/report_structure.py", content: Buffer.from("from office_converter import ready\n\ndef structure():\n    return 'report ' + ready()\n") },
      { path: "scripts/office_converter.py", content: Buffer.from("def ready():\n    return 'ready'\n") },
      { path: "assets/templates/report.docx", content: template },
      { path: "assets/templates/letterhead.docx", content: letterhead },
    ],
  },
};

const measurements: Array<{ scenario: string; providerCalls: number; transferredBytes: number; reusedBytes: number; durationMs: number }> = [];
afterAll(() => {
  // Synthetic provider: bytes and round trips are meaningful; wall time is not a real sandbox latency.
  console.table(measurements);
});

function sha(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function harness(options: { interruptNextWrite?: boolean } = {}) {
  const files = new Map<string, Buffer>();
  const calls = { create: 0, resume: 0, exec: 0, write: 0, list: 0 };
  let interrupt = options.interruptNextWrite ?? false;
  const provider = {
    kind: "e2b",
    create: vi.fn(async () => { calls.create += 1; return { sandbox_id: "sandbox-skills", provider: "e2b", status: "running" }; }),
    resume: vi.fn(async () => { calls.resume += 1; return { sandbox_id: "sandbox-skills", provider: "e2b", status: "running" }; }),
    exec: vi.fn(async function* (input: { command: string[] }) {
      calls.exec += 1;
      const [shell, flag, script, , ...paths] = input.command;
      if (shell === "sh" && flag === "-c" && script?.includes("sha256sum")) {
        const lines = paths.flatMap((path) => files.has(path) ? [`${sha(files.get(path)!)}  ${path}\n`] : []);
        if (lines.length) yield { kind: "stdout", data: lines.join("") };
      }
      yield { kind: "exit", exit_code: 0, signal: null };
    }),
    files: {
      read: vi.fn(async ({ path }: { path: string }) => ({ path, content: files.get(path)!.toString("base64"), size_bytes: files.get(path)!.byteLength, mtime: null })),
      write: vi.fn(),
      list: vi.fn(async ({ path }: { path: string }) => { calls.list += 1; return { path, entries: [] }; }),
      writeManyBytes: vi.fn(async ({ files: batch }: { files: Array<{ path: string; content: Uint8Array }> }) => {
        calls.write += 1;
        if (interrupt) {
          interrupt = false;
          const [first] = batch;
          // The connection drops after half of the first file reached the sandbox.
          if (first) files.set(first.path, Buffer.from(first.content).subarray(0, Math.floor(first.content.byteLength / 2)));
          throw new Error("Connection reset while uploading");
        }
        for (const file of batch) files.set(file.path, Buffer.from(file.content));
        return batch.map((file) => ({ path: file.path, size_bytes: file.content.byteLength, mtime: null }));
      }),
    },
  } as unknown as SandboxProvider;
  const repository = {
    loadRun: vi.fn(), continuity: vi.fn(async () => null), latest: vi.fn(async () => null), inputFiles: vi.fn(async () => []),
    persistOutput: vi.fn(), persist: vi.fn(), recordSandbox: vi.fn(async () => undefined),
  } satisfies SandboxSnapshotRepository;
  const manager = new SandboxContinuityManager(provider, repository, null, { image: "berry-sandbox", cwd: "/workspace" });
  const contentQueries: string[][] = [];
  const query = vi.fn(async (sql: string, params?: readonly unknown[]) => {
    const pkg = packages[String(params?.[0])];
    if (!pkg) return [];
    if (sql.includes("SELECT path,size_bytes,sha256,mode")) {
      return pkg.files.map((file) => ({ path: file.path, size_bytes: file.content.byteLength, sha256: sha(file.content), mode: file.path.startsWith("scripts/") ? 0o755 : 0o644 }));
    }
    if (sql.includes("SELECT path,content")) {
      const wanted = new Set(params?.[1] as string[]);
      contentQueries.push([...wanted]);
      return pkg.files.filter((file) => wanted.has(file.path)).map(({ path, content }) => ({ path, content }));
    }
    return [];
  });
  const tools = new DurablePersonalSkillToolExecutor(manager, { execute: vi.fn(), query: query as never });
  const providerCalls = () => calls.create + calls.resume + calls.exec + calls.write + calls.list;
  return { files, calls, tools, provider, providerCalls, contentQueries, interrupt: () => { interrupt = true; } };
}

function skill(id: string) {
  const pkg = packages[id]!;
  return {
    name: pkg.name,
    description: `${pkg.name} fixture`,
    content: `---\nname: ${pkg.name}\ndescription: ${pkg.name} fixture\n---\n\nUse requested resources only.`,
    filePath: `/organization-skills/${id}/SKILL.md`,
    resources: pkg.files.map((file) => `/organization-skills/${id}/${file.path}`),
  };
}

function runSnapshot(admitted = ["org-docx", "org-branding"]): DurableTurnSnapshot {
  return {
    id: `run-${Math.random()}`,
    tenantId: "00000000-0000-7000-8000-000000000001",
    userId: "user-1",
    sandboxId: "sandbox-skills",
    sandboxProvider: "e2b",
    sandboxState: "running",
    steps: [],
    runtimeRequest: DurableTurnRuntimeRequestSchema.parse({
      capabilityVersion: 1,
      providerId: "router",
      provider: { id: "router", name: "Router", kind: "berry-router", baseUrl: "https://router.example/v1", defaultModel: "test-model" },
      model: "test-model",
      workspacePath: "/workspace",
      workspaceId: "workspace-1",
      permissionMode: "full-access",
      reasoning: "off",
      maxTokens: 4_096,
      contextWindowTokens: 128_000,
      builtInTools: [...DURABLE_BASE_BUILT_IN_TOOLS, "activate_skill"],
      extraSkills: admitted.map(skill),
    }),
  } as unknown as DurableTurnSnapshot;
}

async function activate(
  context: ReturnType<typeof harness>,
  snapshot: DurableTurnSnapshot,
  name: string,
  resources: string[] | undefined,
  scenario: string,
) {
  const before = context.providerCalls();
  const started = performance.now();
  const result = await context.tools.execute(snapshot, {
    id: `activate-${Math.random()}`,
    sequence: snapshot.steps.length + 1,
    type: "tool.activate_skill",
    state: "running",
    input: { toolName: "activate_skill", arguments: { name, ...(resources ? { resources } : {}) } },
  } as unknown as DurableTurnStep);
  const output = result.output as Record<string, unknown>;
  const transfer = (output.transfer ?? { bytes: 0, reusedBytes: 0 }) as { bytes: number; reusedBytes: number };
  measurements.push({
    scenario,
    providerCalls: context.providerCalls() - before,
    transferredBytes: transfer.bytes,
    reusedBytes: transfer.reusedBytes,
    durationMs: Math.round(performance.now() - started),
  });
  snapshot.steps = [...snapshot.steps, {
    id: `done-${snapshot.steps.length}`, sequence: snapshot.steps.length + 1, type: "tool.activate_skill", state: "completed",
    input: { toolName: "activate_skill", arguments: { name, ...(resources ? { resources } : {}) } }, output,
  } as unknown as DurableTurnStep];
  return output;
}

describe("progressive skill staging", () => {
  it("activates metadata without creating, resuming or writing a sandbox", async () => {
    const context = harness();
    const output = await activate(context, runSnapshot(), "docx", undefined, "metadata-only activation");

    expect(context.providerCalls()).toBe(0);
    expect(output.deferredResources).toContain("scripts/create_report.py");
    expect(context.contentQueries).toEqual([]);
  });

  it("stages a script with its sibling imports and declared cross-skill helpers, and the first execution works", async () => {
    const context = harness();
    const output = await activate(context, runSnapshot(), "docx", ["scripts/create_report.py"], "script + siblings + declared dependency");

    expect(output.readiness).toBe("ready");
    expect(output.addedResources).toEqual(["scripts/helpers.py", "scripts/formatting.py"]);
    const [branding] = output.dependencies as Array<{ skill: string; directory: string; resources: string[] }>;
    expect(branding).toMatchObject({ skill: "branding", resources: ["scripts/report_structure.py", "scripts/office_converter.py"] });
    expect(String(output.content)).toContain(`<skill name="branding" directory=${JSON.stringify(branding!.directory)}`);
    const staged = [...context.files.keys()];
    expect(staged.some((path) => path.endsWith("/scripts/unused_tool.py"))).toBe(false);
    expect(staged.some((path) => path.includes("/assets/templates/"))).toBe(false);
    expect((output.transfer as { bytes: number }).bytes).toBeLessThan(10_000);
    expect(context.contentQueries.flat()).not.toContain("assets/templates/report.docx");

    // Materialize the sandbox and run the entry point exactly as the guide says.
    const root = mkdtempSync(join(tmpdir(), "berry-skill-staging-"));
    try {
      for (const [path, content] of context.files) {
        const local = join(root, path);
        mkdirSync(dirname(local), { recursive: true });
        writeFileSync(local, content);
      }
      const docxDirectory = String(output.directory);
      const run = spawnSync("python3", [
        join(root, docxDirectory, "scripts/create_report.py"),
        "--branding-skill-dir", join(root, branding!.directory),
        "--output", join(root, "workspace/out.txt"),
      ], { encoding: "utf8" });
      expect(run.stderr).toBe("");
      expect(run.status).toBe(0);
      expect(readFileSync(join(root, "workspace/out.txt"), "utf8")).toBe("Report Ready");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stages a large template only for an operation that needs it, then reuses it in a later run", async () => {
    const context = harness();
    const first = await activate(context, runSnapshot(), "branding", ["assets/templates/report.docx"], "large template, cold");
    expect(first.transfer).toMatchObject({ files: 2, reusedFiles: 0 });
    expect((first.transfer as { bytes: number }).bytes).toBeGreaterThan(6 * MB);
    expect([...context.files.keys()].some((path) => path.endsWith("letterhead.docx"))).toBe(false);

    const writesBefore = context.calls.write;
    const later = await activate(context, runSnapshot(), "branding", ["assets/templates/report.docx"], "large template, warm reuse in a later run");
    expect(later.transfer).toMatchObject({ files: 0, bytes: 0, reusedFiles: 2 });
    expect((later.transfer as { reusedBytes: number }).reusedBytes).toBeGreaterThan(6 * MB);
    expect(context.calls.write).toBe(writesBefore);
  });

  it("stages a changed package version into a new directory instead of reusing old bytes", async () => {
    const context = harness();
    const before = await activate(context, runSnapshot(), "docx", ["scripts/create_report.py"], "dependency, version A");
    const original = packages["org-branding"]!.files[1]!.content;
    packages["org-branding"]!.files[1]!.content = Buffer.from("def ready():\n    return 'ready v2'\n");
    try {
      const after = await activate(context, runSnapshot(), "docx", ["scripts/create_report.py"], "dependency, version B");
      const oldDirectory = (before.dependencies as Array<{ directory: string }>)[0]!.directory;
      const newDirectory = (after.dependencies as Array<{ directory: string }>)[0]!.directory;
      expect(newDirectory).not.toBe(oldDirectory);
      expect(context.files.get(`${newDirectory}/scripts/office_converter.py`)?.toString()).toContain("ready v2");
      expect(context.files.get(`${oldDirectory}/scripts/office_converter.py`)?.toString()).not.toContain("ready v2");
    } finally {
      packages["org-branding"]!.files[1]!.content = original;
    }
  });

  it("never reuses a partially written file after an interrupted transfer", async () => {
    const context = harness({ interruptNextWrite: true });
    await expect(activate(context, runSnapshot(), "branding", ["assets/templates/report.docx"], "interrupted transfer"))
      .rejects.toThrow("Connection reset");
    const partial = [...context.files.entries()].find(([path]) => path.endsWith("report.docx"));
    if (partial) expect(partial[1].byteLength).toBeLessThan(template.byteLength);

    const retried = await activate(context, runSnapshot(), "branding", ["assets/templates/report.docx"], "retry after interruption");
    expect(retried.readiness).toBe("ready");
    const staged = [...context.files.entries()].find(([path]) => path.endsWith("report.docx"))!;
    expect(sha(staged[1])).toBe(sha(template));
  });

  it("shares one transfer between concurrent activations of the same template", async () => {
    const context = harness();
    const snapshot = runSnapshot();
    await Promise.all([
      activate(context, snapshot, "branding", ["assets/templates/report.docx"], "concurrent activation 1"),
      activate(context, snapshot, "branding", ["assets/templates/report.docx"], "concurrent activation 2"),
    ]);
    const templateWrites = (context.provider.files.writeManyBytes as unknown as { mock: { calls: Array<[{ files: Array<{ path: string }> }]> } })
      .mock.calls.flatMap(([input]) => input.files.map((file) => file.path)).filter((path) => path.endsWith("report.docx"));
    expect(templateWrites).toHaveLength(1);
  });

  it("fails before execution when a declared dependency skill is not admitted", async () => {
    const context = harness();
    await expect(activate(context, runSnapshot(["org-docx"]), "docx", ["scripts/create_report.py"], "missing dependency skill"))
      .rejects.toThrow("requires the branding skill (scripts/report_structure.py), which is not available to this task");
    expect(context.calls.exec).toBe(0);
  });
});

