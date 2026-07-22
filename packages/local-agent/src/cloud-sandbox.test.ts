import { Buffer } from "node:buffer";
import type { AgentTool } from "@berry/harness";
import { FixtureSandboxProvider, type SandboxProvider as ContractSandboxProvider } from "@berry/sandbox-contract";
import { describe, expect, it, vi } from "vitest";
import { CloudSandboxProvider, S3CompatibleArtifactStore, type ObjectPutClient } from "./cloud-sandbox.ts";
import { createBerryTools } from "./tools.ts";

const tenantId = "00000000-0000-7000-8000-000000000001";

async function sandboxTools() {
  const contractProvider = new FixtureSandboxProvider();
  const provider = new CloudSandboxProvider({
    provider: contractProvider,
    tenantId,
    image: "berry/python:3.12",
  });
  const session = await provider.createSession({
    sessionId: "sess_cloud",
    taskId: "task_cloud",
    workspacePath: "/local/workspace/not-used",
    policy: { tier: "workspace-write", writableRoots: ["/workspace"], network: "off" },
    enforceEscalated: true,
  });
  const tools = new Map(createBerryTools({ workspacePath: "/local/workspace/not-used", env: session.env, escalatedEnv: session.escalatedEnv }).map((tool) => [tool.name, tool]));
  return { provider, session, tools };
}

async function run(tools: Map<string, AgentTool>, name: string, params: Record<string, unknown>): Promise<string> {
  const tool = tools.get(name);
  if (!tool) throw new Error(`missing tool ${name}`);
  const result = await tool.execute(`call_${name}`, params as never, undefined, undefined);
  const text = result.content.find((part) => part.type === "text");
  return text && text.type === "text" ? text.text : "";
}

describe("CloudSandboxProvider", () => {
  it("suspends durable providers when a session is disposed", async () => {
    const fixture = new FixtureSandboxProvider();
    const create = vi.fn(fixture.create.bind(fixture));
    const suspend = vi.fn((input: Parameters<NonNullable<ContractSandboxProvider["suspend"]>>[0]) => fixture.destroy(input));
    const contractProvider: ContractSandboxProvider = {
      kind: fixture.kind,
      files: fixture.files,
      create,
      exec: fixture.exec.bind(fixture),
      exposePort: fixture.exposePort.bind(fixture),
      suspend,
      destroy: fixture.destroy.bind(fixture),
    };
    const provider = new CloudSandboxProvider({ provider: contractProvider, tenantId, image: "berry/python:3.12", cwd: "/home/user/workspace" });
    const session = await provider.createSession({
      sessionId: "sess_suspend",
      taskId: "task_suspend",
      workspacePath: "/unused",
      policy: { tier: "workspace-write", writableRoots: ["/workspace"], network: "off" },
      enforceEscalated: true,
    });

    await session.dispose();

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/home/user/workspace",
      writable_roots: ["/home/user/workspace"],
    }));
    expect(suspend).toHaveBeenCalledWith(expect.objectContaining({ reason: "session disposed" }));
  });

  it("maps file, patch, and bash tools onto the session sandbox", async () => {
    const { provider, session, tools } = await sandboxTools();

    await expect(run(tools, "write_file", { path: "main.txt", content: "old\n" })).resolves.toContain("Wrote");
    await expect(run(tools, "read_file", { path: "main.txt" })).resolves.toContain("old");
    await expect(run(tools, "edit_file", { path: "main.txt", old_string: "old", new_string: "new" })).resolves.toContain("Replaced");
    await expect(run(tools, "apply_patch", {
      patch: ["*** Begin Patch", "*** Update File: main.txt", "@@", "-new", "+patched", "*** Add File: nested/artifact.txt", "+artifact", "*** End Patch"].join("\n"),
    })).resolves.toContain("added nested/artifact.txt");
    await expect(run(tools, "list_dir", { path: "." })).resolves.toContain("main.txt");
    await expect(run(tools, "glob", { pattern: "*.txt" })).resolves.toContain("main.txt");

    const output = await run(tools, "bash", { command: "echo cloud" });
    expect(output).toContain("bash -lc echo cloud");

    await session.dispose();
    await provider.dispose();
  });

  it("persists sandbox files to an S3-compatible artifact store", async () => {
    const contractProvider = new FixtureSandboxProvider();
    const provider = new CloudSandboxProvider({ provider: contractProvider, tenantId, image: "berry/python:3.12" });
    const session = await provider.createSession({
      sessionId: "sess_artifact",
      taskId: "task_artifact",
      workspacePath: "/unused",
      policy: { tier: "workspace-write", writableRoots: ["/workspace"], network: "off" },
      enforceEscalated: true,
    });
    const puts: Array<{ key: string; body: string; contentType: string }> = [];
    const client: ObjectPutClient = {
      async putObject(input) {
        puts.push({ key: input.key, body: Buffer.from(input.body).toString("utf8"), contentType: input.contentType });
        return { url: `https://objects.example.test/${input.key}` };
      },
    };
    const artifactStore = new S3CompatibleArtifactStore({ bucket: "berry-artifacts", prefix: "tenant-a", client });
    const tools = new Map(createBerryTools({ workspacePath: "/unused", env: session.env, artifactStore }).map((tool) => [tool.name, tool]));

    await run(tools, "write_file", { path: "report.txt", content: "cloud artifact" });
    const tool = tools.get("persist_artifact")!;
    const result = await tool.execute("call_artifact", { path: "report.txt", name: "report.txt", media_type: "text/plain" } as never, undefined, undefined);

    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ body: "cloud artifact", contentType: "text/plain" });
    expect(result.details).toMatchObject({
      artifact: {
        kind: "file",
        name: "report.txt",
        mediaType: "text/plain",
        storage: "s3://berry-artifacts",
        path: expect.stringContaining("https://objects.example.test/tenant-a/"),
      },
    });
  });

  it("streams large sandbox outputs to a presigned object URL instead of buffering them through the API", async () => {
    const { session } = await sandboxTools();
    await session.env.writeFile("/workspace/large.pdf", Buffer.from("pdf-payload"));
    const putObject = vi.fn<ObjectPutClient["putObject"]>();
    const createUploadUrl = vi.fn(async (input: { key: string }) => ({
      uploadUrl: `https://files.example.test/${input.key}?signature=fixture`,
      url: `https://app.example.test/v1/artifacts/${input.key}`,
    }));
    const artifactStore = new S3CompatibleArtifactStore({
      bucket: "berry-artifacts",
      prefix: "outputs",
      client: { putObject, createUploadUrl },
    });

    const stored = await artifactStore.persistFile({ env: session.env, path: "/workspace/large.pdf", mediaType: "application/pdf" });

    expect(createUploadUrl).toHaveBeenCalledWith(expect.objectContaining({ contentType: "application/pdf", key: expect.stringMatching(/^outputs\/.+-large\.pdf$/) }));
    expect(putObject).not.toHaveBeenCalled();
    expect(stored).toMatchObject({ storage: "s3://berry-artifacts", size: 11, url: expect.stringContaining("/v1/artifacts/outputs/") });
  });

  it("persists browser screenshot artifacts through the configured store", async () => {
    const { session } = await sandboxTools();
    await session.env.writeFile("/workspace/shot.png", Buffer.from("png-bytes"));
    const client: ObjectPutClient = {
      async putObject(input) {
        return { url: `https://objects.example.test/${input.key}?bytes=${input.body.byteLength}` };
      },
    };
    const artifactStore = new S3CompatibleArtifactStore({ bucket: "berry-artifacts", client });
    const tools = new Map(createBerryTools({
      workspacePath: "/unused",
      env: session.env,
      artifactStore,
      browser: {
        currentUrl: () => "https://example.test/page",
        async call(method) {
          if (method === "browser.screenshot") return { path: "/workspace/shot.png", name: "shot.png", mediaType: "image/png", size: 9 };
          return { stdout: "@e1 [heading] Example" };
        },
      },
    }).map((tool) => [tool.name, tool]));

    const result = await tools.get("browser_screenshot")!.execute("call_shot", { session_id: "browser_1", url: "https://example.test/page" } as never, undefined, undefined);

    expect(result.details).toMatchObject({
      artifact: {
        kind: "browser-screenshot",
        name: "shot.png",
        mediaType: "image/png",
        storage: "s3://berry-artifacts",
        path: expect.stringContaining("https://objects.example.test/artifacts/"),
      },
    });
  });
});
