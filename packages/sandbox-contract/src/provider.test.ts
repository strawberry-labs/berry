import { describe, expect, it } from "vitest";
import { FixtureSandboxProvider } from "./fixture-provider.js";
import { collectSandboxExecEvents, exerciseSandboxProviderContract } from "./provider.js";

const tenantId = "00000000-0000-7000-8000-000000000001";

describe("SandboxProvider contract", () => {
  it("exercises create, exec streaming, files, expose-port, and destroy", async () => {
    const provider = new FixtureSandboxProvider();
    const result = await exerciseSandboxProviderContract(provider, {
      requestId: "req_contract",
      tenantId,
    });

    expect(result.sandbox).toMatchObject({
      request_id: "req_contract",
      tenant_id: tenantId,
      provider: "fixture",
      provider_kind: "fixture",
      status: "running",
    });
    expect(result.file).toMatchObject({ path: "/workspace/result.txt", content: "contract-ok" });
    expect(result.list.entries.map((entry) => entry.path)).toEqual(["/workspace/result.txt"]);
    expect(result.execEvents).toEqual([
      expect.objectContaining({ kind: "started", sandbox_id: result.sandbox.sandbox_id }),
      { kind: "stdout", data: "echo contract-ok" },
      { kind: "exit", exit_code: 0, signal: null },
    ]);
    expect(result.port.url).toBe(`https://${result.sandbox.sandbox_id}-3000.sandbox.invalid`);
    expect(result.destroy).toEqual({ sandbox_id: result.sandbox.sandbox_id, destroyed: true, status: "stopped" });
  });

  it("supports file encoding conversion and missing-sandbox failure", async () => {
    const provider = new FixtureSandboxProvider();
    const sandbox = await provider.create({
      request_id: "req_files",
      tenant_id: tenantId,
      image: "berry/contract-fixture:latest",
    });

    await provider.files.write({
      sandbox_id: sandbox.sandbox_id,
      path: "/workspace/data.bin",
      encoding: "base64",
      content: Buffer.from("hello").toString("base64"),
    });
    await expect(provider.files.read({
      sandbox_id: sandbox.sandbox_id,
      path: "/workspace/data.bin",
      encoding: "utf8",
    })).resolves.toMatchObject({ content: "hello" });
    await expect(collectSandboxExecEvents(provider.exec({
      sandbox_id: "missing",
      request_id: "req_missing",
      command: ["true"],
    }))).rejects.toThrow("Sandbox not found");
  });
});
