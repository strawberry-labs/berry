import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutionEnv } from "@berry/harness/node";
import { afterEach, describe, expect, it } from "vitest";
import { SandboxEnforcer, assertShellWritePolicy, seatbeltProfile } from "./sandbox.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function workspace(): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), "berry-sandbox-"));
  roots.push(root);
  const path = join(root, "workspace");
  mkdirSync(join(path, ".berry"), { recursive: true });
  return { root, path };
}

describe("sandbox enforcement", () => {
  it("maps supported and fallback mechanisms explicitly", () => {
    const policy = { tier: "workspace-write" as const, writableRoots: ["/workspace"], network: "off" as const };
    expect(new SandboxEnforcer({ platform: "darwin", commandExists: () => true }).status(policy)).toMatchObject({ platform: "macos", enforcement: "enforced", mechanism: "seatbelt" });
    expect(new SandboxEnforcer({ platform: "linux", commandExists: () => true }).status(policy)).toMatchObject({ platform: "linux", enforcement: "enforced", mechanism: "bubblewrap" });
    expect(new SandboxEnforcer({ platform: "win32", commandExists: () => false }).status(policy)).toMatchObject({ platform: "windows", enforcement: "approval-only", mechanism: "none", reason: expect.stringContaining("restricted-token") });
  });

  it("keeps Windows launch posture approval-only instead of pretending to wrap commands", () => {
    const policy = { tier: "workspace-write" as const, writableRoots: ["C:\\workspace"], network: "off" as const };
    const enforcer = new SandboxEnforcer({ platform: "win32", commandExists: () => false });
    const invocation = { command: "cmd.exe", args: ["/c", "echo", "ok"], options: { cwd: "C:\\workspace" } };
    expect(enforcer.status(policy)).toMatchObject({
      platform: "windows",
      enforcement: "approval-only",
      mechanism: "none",
      reason: "Windows restricted-token enforcement is not available yet; approvals remain active.",
    });
    expect(enforcer.wrap(invocation, policy)).toBe(invocation);
  });

  it("builds deny-default profiles and rejects protected shell paths", () => {
    const { path } = workspace();
    const canonicalPath = realpathSync(path);
    const profile = seatbeltProfile({ tier: "workspace-write", writableRoots: [path], network: "off" });
    expect(profile).toContain("(deny default)");
    expect(profile).toContain(`(subpath ${JSON.stringify(canonicalPath)})`);
    expect(profile).toContain(JSON.stringify(join(canonicalPath, ".git", "hooks")));
    expect(profile).not.toContain("(allow network*)");
    expect(() => assertShellWritePolicy("printf x > .git/hooks/pre-commit")).toThrow("protected credential/config path");
    expect(() => assertShellWritePolicy("cat .env.production")).toThrow("protected credential/config path");
    expect(() => assertShellWritePolicy("pnpm test")).not.toThrow();
  });

  it("constructs a read-only bubblewrap root with network isolation", () => {
    const wrapped = new SandboxEnforcer({ platform: "linux", commandExists: (path) => path === "/usr/bin/bwrap" }).wrap(
      { command: "/bin/sh", args: ["-lc", "echo ok"], options: { cwd: "/workspace" } },
      { tier: "read-only" },
    );
    expect(wrapped.command).toBe("/usr/bin/bwrap");
    expect(wrapped.args).toEqual(expect.arrayContaining(["--ro-bind", "/", "/", "--unshare-net", "--chdir", "/workspace"]));
  });

  it.runIf(process.platform === "darwin")("enforces workspace roots, protected paths, and read-only writes with Seatbelt", async () => {
    const { root, path } = workspace();
    const enforcer = new SandboxEnforcer();
    const writable = new NodeExecutionEnv({ cwd: path, commandWrapper: enforcer.commandWrapper({ tier: "workspace-write", writableRoots: [path], network: "off" }) });
    const outside = join(root, "outside.txt");
    const allowed = join(path, "allowed.txt");
    const protectedPath = join(path, ".berry", "blocked.txt");
    const result = await writable.exec(`printf allowed > ${JSON.stringify(allowed)}; printf blocked > ${JSON.stringify(outside)}; printf blocked > ${JSON.stringify(protectedPath)}`);
    expect(result.ok && result.value.exitCode).not.toBe(0);
    expect(readFileSync(allowed, "utf8")).toBe("allowed");
    expect(existsSync(outside)).toBe(false);
    expect(existsSync(protectedPath)).toBe(false);

    const readOnly = new NodeExecutionEnv({ cwd: path, commandWrapper: enforcer.commandWrapper({ tier: "read-only" }) });
    const denied = join(path, "read-only.txt");
    const readOnlyResult = await readOnly.exec(`printf denied > ${JSON.stringify(denied)}`);
    expect(readOnlyResult.ok && readOnlyResult.value.exitCode).not.toBe(0);
    expect(existsSync(denied)).toBe(false);
  });

  it.runIf(process.platform === "darwin")("blocks localhost network egress when workspace network is off", async () => {
    const { path } = workspace();
    const server = createServer((_request, response) => response.end("reachable"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server did not bind");
      const env = new NodeExecutionEnv({
        cwd: path,
        commandWrapper: new SandboxEnforcer().commandWrapper({ tier: "workspace-write", writableRoots: [path], network: "off" }),
      });
      const code = `fetch("http://127.0.0.1:${address.port}").then(()=>process.exit(0),()=>process.exit(7))`;
      const result = await env.exec(`${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}`, { timeout: 5 });
      expect(result.ok && result.value.exitCode).toBe(7);
    } finally {
      server.close();
    }
  });
});
