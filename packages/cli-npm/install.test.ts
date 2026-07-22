import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { installBinary, platformTarget } from "./install.js";

const tempDirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolveClose) => server.close(() => resolveClose()))));
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("npm CLI binary installer", () => {
  it("maps supported Node platforms to release target triples", () => {
    expect(platformTarget("darwin", "arm64")).toBe("aarch64-apple-darwin");
    expect(platformTarget("linux", "x64")).toBe("x86_64-unknown-linux-gnu");
    expect(platformTarget("win32", "x64")).toBe("x86_64-pc-windows-msvc");
    expect(() => platformTarget("freebsd", "x64")).toThrow("does not publish");
    const shimVersion = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;
    const cliVersion = JSON.parse(readFileSync(new URL("../../apps/cli/package.json", import.meta.url), "utf8")).version;
    expect(shimVersion).toBe(cliVersion);
  });

  it("downloads and verifies the npm shim binary", async () => {
    const fixture = Buffer.from("berry fixture binary");
    const target = platformTarget();
    const name = `berry-${target}${process.platform === "win32" ? ".exe" : ""}`;
    const baseUrl = await fixtureServer(name, fixture);
    const dir = mkdtempSync(join(tmpdir(), "berry-npm-install-"));
    tempDirs.push(dir);
    const destination = join(dir, process.platform === "win32" ? "berry.exe" : "berry");
    await installBinary({ baseUrl, target, destination });
    expect(readFileSync(destination)).toEqual(fixture);
  });

  it("rejects a binary whose release checksum does not match", async () => {
    const fixture = Buffer.from("tampered berry binary");
    const target = platformTarget();
    const name = `berry-${target}${process.platform === "win32" ? ".exe" : ""}`;
    const baseUrl = await fixtureServer(name, fixture, "0".repeat(64));
    const dir = mkdtempSync(join(tmpdir(), "berry-npm-checksum-"));
    tempDirs.push(dir);
    await expect(installBinary({ baseUrl, target, destination: join(dir, "berry") })).rejects.toThrow("checksum mismatch");
  });

  it.skipIf(process.platform === "win32")("installs the shell release with the same checksum contract", async () => {
    const fixture = Buffer.from("#!/bin/sh\necho berry fixture\n");
    const target = platformTarget();
    const name = `berry-${target}`;
    const baseUrl = await fixtureServer(name, fixture);
    const dir = mkdtempSync(join(tmpdir(), "berry-shell-install-"));
    tempDirs.push(dir);
    const script = resolve(import.meta.dirname, "../../scripts/install-berry.sh");
    const result = await run("sh", [script], {
      ...process.env,
      BERRY_DOWNLOAD_BASE_URL: baseUrl,
      BERRY_INSTALL_DIR: dir,
      BERRY_TARGET: target,
      BERRY_VERSION: "0.1.0",
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Installed berry 0.1.0 to ${dir}/berry`);
    expect(readFileSync(join(dir, "berry"))).toEqual(fixture);
  });

  it.skipIf(process.platform === "win32")("forwards arguments and exit status through the npm bin shim", async () => {
    const dir = mkdtempSync(join(tmpdir(), "berry-npm-shim-"));
    tempDirs.push(dir);
    const fixture = join(dir, "berry-fixture");
    writeFileSync(fixture, "#!/bin/sh\nprintf '%s' \"$*\"\nexit 7\n");
    chmodSync(fixture, 0o755);
    const result = await run(process.execPath, [resolve(import.meta.dirname, "bin/berry.js"), "run", "--json"], {
      ...process.env,
      BERRY_CLI_BINARY: fixture,
    });
    expect(result).toMatchObject({ code: 7, stdout: "run --json" });
  });
});

async function fixtureServer(name: string, binary: Buffer, checksum = createHash("sha256").update(binary).digest("hex")): Promise<string> {
  const server = createServer((request, response) => {
    if (request.url?.endsWith(`/${name}`)) response.end(binary);
    else if (request.url?.endsWith(`/${name}.sha256`)) response.end(`${checksum}  ${name}\n`);
    else {
      response.statusCode = 404;
      response.end();
    }
  });
  servers.push(server);
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not bind a TCP port");
  return `http://127.0.0.1:${address.port}`;
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectRun);
    child.once("exit", (code) => resolveRun({ code, stdout, stderr }));
  });
}
