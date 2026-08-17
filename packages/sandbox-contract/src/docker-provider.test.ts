import { describe, expect, it } from "vitest";
import {
  DockerSandboxProvider,
  imageAllowed,
  type DockerCommandExecutor,
  type DockerCommandResult,
  type DockerStreamEvent,
} from "./docker-provider.js";
import { collectSandboxExecEvents } from "./provider.js";

const tenantId = "00000000-0000-7000-8000-000000000001";

class FakeDockerExecutor implements DockerCommandExecutor {
  readonly runs: Array<{ args: readonly string[]; stdin?: string | Buffer | undefined; signal?: AbortSignal | undefined }> = [];
  readonly streams: Array<{ args: readonly string[]; stdin?: string | Buffer | undefined; signal?: AbortSignal | undefined }> = [];
  nextRun: DockerCommandResult[] = [];
  nextStream: DockerStreamEvent[] = [
    { stream: "stdout", data: "ok\n" },
    { stream: "exit", exitCode: 0 },
  ];
  onRun: ((args: readonly string[]) => void | Promise<void>) | undefined;

  async run(args: readonly string[], options: { stdin?: string | Buffer | undefined; signal?: AbortSignal | undefined } = {}): Promise<DockerCommandResult> {
    this.runs.push({ args, stdin: options.stdin, signal: options.signal });
    const result = this.nextRun.shift() ?? { stdout: "", stderr: "", exitCode: 0 };
    await this.onRun?.(args);
    return result;
  }

  async *stream(args: readonly string[], options: { stdin?: string | Buffer | undefined; signal?: AbortSignal | undefined } = {}): AsyncIterable<DockerStreamEvent> {
    this.streams.push({ args, stdin: options.stdin, signal: options.signal });
    for (const event of this.nextStream) yield event;
  }
}

describe("DockerSandboxProvider", () => {
  it("matches exact and prefix image allowlist entries", () => {
    expect(imageAllowed("berry/python:latest", ["berry/python:latest"])).toBe(true);
    expect(imageAllowed("berry/python:3.12", ["berry/python:*"])).toBe(true);
    expect(imageAllowed("ubuntu:latest", ["berry/python:*"])).toBe(false);
  });

  it("creates a no-egress sandbox with resources and workspace mounts", async () => {
    const executor = new FakeDockerExecutor();
    executor.nextRun = [
      { stdout: "container_123\n", stderr: "", exitCode: 0 },
      { stdout: "container_123\n", stderr: "", exitCode: 0 },
    ];
    const provider = new DockerSandboxProvider({
      executor,
      imageAllowlist: ["berry/python:*"],
      now: () => new Date("2026-07-10T00:00:00.000Z"),
    });

    const sandbox = await provider.create({
      request_id: "req_create",
      tenant_id: tenantId,
      image: "berry/python:3.12",
      resources: { cpuCount: 2, memoryMiB: 4096, storageMiB: 20_480 },
      mounts: [{ host_path: "/srv/workspaces/task-1", sandbox_path: "/workspace", readonly: false }],
      env: { BERRY_TASK_ID: "task_1" },
    });

    expect(sandbox).toMatchObject({
      sandbox_id: "container_123",
      provider: "docker",
      provider_kind: "docker",
      expires_at: "2026-07-10T01:00:00.000Z",
    });
    expect(executor.runs[0]?.args).toEqual([
      "create",
      "--name", "berry-sandbox-req_create",
      "--label", "berry.managed=true",
      "--label", "berry.request_id=req_create",
      "--label", `berry.tenant_id=${tenantId}`,
      "--workdir", "/workspace",
      "--cpus", "2",
      "--memory", "4096m",
      "--network", "none",
      "--stop-timeout", "2",
      "--env", "BERRY_TASK_ID=task_1",
      "--mount", "type=bind,src=/srv/workspaces/task-1,dst=/workspace",
      "berry/python:3.12",
      "sleep",
      "infinity",
    ]);
    expect(executor.runs[1]?.args).toEqual(["start", "berry-sandbox-req_create"]);
  });

  it("rejects images outside the configured self-host allowlist", async () => {
    const provider = new DockerSandboxProvider({
      executor: new FakeDockerExecutor(),
      imageAllowlist: ["berry/python:*"],
    });

    await expect(provider.create({
      request_id: "req_bad",
      tenant_id: tenantId,
      image: "ubuntu:latest",
    })).rejects.toThrow("not allowlisted");
  });

  it("maps exec streams and file APIs to docker commands", async () => {
    const executor = new FakeDockerExecutor();
    executor.nextRun = [
      { stdout: "container_123\n", stderr: "", exitCode: 0 },
      { stdout: "", stderr: "", exitCode: 0 },
      { stdout: "hello", stderr: "", exitCode: 0 },
      { stdout: "", stderr: "", exitCode: 0 },
      { stdout: "f\t5\t1783641600.0000000000\t/workspace/a.txt\n", stderr: "", exitCode: 0 },
      { stdout: "172.18.0.2\n", stderr: "", exitCode: 0 },
      { stdout: "", stderr: "", exitCode: 0 },
    ];
    const provider = new DockerSandboxProvider({
      executor,
      imageAllowlist: ["berry/python:*"],
      now: () => new Date("2026-07-10T00:00:00.000Z"),
    });
    const sandbox = await provider.create({
      request_id: "req_api",
      tenant_id: tenantId,
      image: "berry/python:3.12",
      network_policy: { egress: "on", allowedDomains: ["example.com"] },
    });

    const events = await collectSandboxExecEvents(provider.exec({
      sandbox_id: sandbox.sandbox_id,
      request_id: "req_exec",
      command: ["python", "-V"],
      env: { FOO: "1" },
    }));
    expect(events).toEqual([
      { kind: "started", sandbox_id: sandbox.sandbox_id, request_id: "req_exec", pid: null },
      { kind: "stdout", data: "ok\n" },
      { kind: "exit", exit_code: 0, signal: null },
    ]);
    expect(executor.streams[0]?.args).toEqual([
      "exec",
      "--workdir", "/workspace",
      "--env", "FOO=1",
      "berry-sandbox-req_api",
      "python",
      "-V",
    ]);

    await expect(provider.files.read({
      sandbox_id: sandbox.sandbox_id,
      path: "/workspace/a.txt",
    })).resolves.toMatchObject({ content: "hello", size_bytes: 5 });
    await expect(provider.files.write({
      sandbox_id: sandbox.sandbox_id,
      path: "/workspace/a.txt",
      content: "hello",
    })).resolves.toMatchObject({ path: "/workspace/a.txt", size_bytes: 5 });
    await expect(provider.files.list({
      sandbox_id: sandbox.sandbox_id,
      path: "/workspace",
      recursive: true,
    })).resolves.toMatchObject({
      entries: [{ path: "/workspace/a.txt", type: "file", size_bytes: 5, mtime: "2026-07-10T00:00:00.000Z" }],
    });
    await expect(provider.exposePort({
      sandbox_id: sandbox.sandbox_id,
      port: 3000,
      protocol: "http",
    })).resolves.toMatchObject({ url: "http://172.18.0.2:3000" });
    await expect(provider.destroy({ sandbox_id: sandbox.sandbox_id })).resolves.toEqual({
      sandbox_id: sandbox.sandbox_id,
      destroyed: true,
      status: "stopped",
    });
  });

  it("reads binary files as base64 inside the container without UTF-8 corruption", async () => {
    const executor = new FakeDockerExecutor();
    executor.nextRun = [
      { stdout: "container_123\n", stderr: "", exitCode: 0 },
      { stdout: "", stderr: "", exitCode: 0 },
      { stdout: "AP+AQQ==", stderr: "", exitCode: 0 },
    ];
    const provider = new DockerSandboxProvider({
      executor,
      imageAllowlist: ["berry/python:*"],
    });
    const sandbox = await provider.create({
      request_id: "req_binary",
      tenant_id: tenantId,
      image: "berry/python:3.12",
    });

    await expect(provider.files.read({
      sandbox_id: sandbox.sandbox_id,
      path: "/workspace/binary.pdf",
      encoding: "base64",
    })).resolves.toMatchObject({
      content: "AP+AQQ==",
      size_bytes: 4,
    });
    expect(executor.runs[2]?.args).toEqual([
      "exec",
      "berry-sandbox-req_binary",
      "base64",
      "-w",
      "0",
      "--",
      "/workspace/binary.pdf",
    ]);
  });

  it("forwards the operation signal to Docker creation and file commands", async () => {
    const executor = new FakeDockerExecutor();
    executor.nextRun = [
      { stdout: "container_signal\n", stderr: "", exitCode: 0 },
      { stdout: "", stderr: "", exitCode: 0 },
      { stdout: "hello", stderr: "", exitCode: 0 },
    ];
    const provider = new DockerSandboxProvider({ executor, imageAllowlist: ["berry/python:*"] });
    const controller = new AbortController();
    const sandbox = await provider.create(
      { request_id: "req_signal", tenant_id: tenantId, image: "berry/python:3.12" },
      { signal: controller.signal },
    );

    await provider.files.read({ sandbox_id: sandbox.sandbox_id, path: "/workspace/a.txt" }, { signal: controller.signal });

    expect(executor.runs[0]?.signal).toBe(controller.signal);
    expect(executor.runs[1]?.signal).toBe(controller.signal);
    expect(executor.runs[2]?.signal).toBe(controller.signal);
  });

  it("removes a created container when cancellation arrives before start", async () => {
    const executor = new FakeDockerExecutor();
    executor.nextRun = [
      { stdout: "container_cancelled\n", stderr: "", exitCode: 0 },
      { stdout: "", stderr: "", exitCode: 0 },
    ];
    const controller = new AbortController();
    executor.onRun = (args) => {
      if (args[0] === "create") controller.abort(new Error("cancel creation"));
    };
    const provider = new DockerSandboxProvider({ executor, imageAllowlist: ["berry/python:*"] });

    await expect(provider.create(
      { request_id: "req_cancel", tenant_id: tenantId, image: "berry/python:3.12" },
      { signal: controller.signal },
    )).rejects.toThrow("cancel creation");

    expect(executor.runs.map(({ args }) => args)).toEqual([
      expect.arrayContaining(["create", "--name", "berry-sandbox-req_cancel"]),
      ["rm", "-f", "berry-sandbox-req_cancel"],
    ]);
    expect(executor.runs[1]?.signal).toBeUndefined();
  });

  it("does not delete a pre-existing container when cancellation rejects an ambiguous create", async () => {
    const executor = new FakeDockerExecutor();
    executor.nextRun = [{
      stdout: "",
      stderr: "Conflict: the container name berry-sandbox-req_in_flight_cancel is already in use",
      exitCode: 1,
    }];
    const controller = new AbortController();
    executor.onRun = (args) => {
      if (args[0] !== "create") return;
      controller.abort(new Error("cancel in-flight creation"));
    };
    const provider = new DockerSandboxProvider({ executor, imageAllowlist: ["berry/python:*"] });

    await expect(provider.create(
      { request_id: "req_in_flight_cancel", tenant_id: tenantId, image: "berry/python:3.12" },
      { signal: controller.signal },
    )).rejects.toThrow("already in use");

    expect(executor.runs.map(({ args }) => args)).toEqual([
      expect.arrayContaining(["create", "--name", "berry-sandbox-req_in_flight_cancel"]),
    ]);
  });

  it("removes a created container when start fails", async () => {
    const executor = new FakeDockerExecutor();
    executor.nextRun = [
      { stdout: "container_failed_start\n", stderr: "", exitCode: 0 },
      { stdout: "", stderr: "start failed", exitCode: 1 },
      { stdout: "", stderr: "", exitCode: 0 },
    ];
    const provider = new DockerSandboxProvider({ executor, imageAllowlist: ["berry/python:*"] });

    await expect(provider.create({
      request_id: "req_start_failure",
      tenant_id: tenantId,
      image: "berry/python:3.12",
    })).rejects.toThrow("start failed");

    expect(executor.runs[2]?.args).toEqual(["rm", "-f", "berry-sandbox-req_start_failure"]);
  });
});
