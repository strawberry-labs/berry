import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@berry/shared";
import { BerryHostService } from "./service.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("extension native messaging registration", () => {
  it("writes and removes a user-scoped manifest behind the desktop setting", async () => {
    const dir = mkdtempSync(join(tmpdir(), "berry-extension-native-"));
    tempDirs.push(dir);
    const manifestPath = join(dir, "com.berry.desktop_host.json");
    const configPath = join(dir, "extension-native-host.json");
    const nativeHostPath = join(dir, "berry-extension-host.mjs");
    const socketPath = join(dir, "host.sock");
    const service = new BerryHostService({ dbPath: join(dir, "desktop.db"), expectedNonce: "nonce" });

    await withEnv({
      BERRY_EXTENSION_NATIVE_MANIFEST_PATH: manifestPath,
      BERRY_EXTENSION_NATIVE_CONFIG: configPath,
      BERRY_EXTENSION_NATIVE_HOST_PATH: nativeHostPath,
      BERRY_HOST_SOCKET: socketPath,
    }, async () => {
      await service.initialize();
      await service.handle("host.handshake", { nonce: "nonce", protocolVersion: PROTOCOL_VERSION });
      const status = await service.handle("extension.nativeMessaging.setEnabled", {
        enabled: true,
        extensionIds: ["abcdefghijklmnopabcdefghijklmnop"],
      }) as { enabled: boolean; manifestPaths: string[]; configPath: string; allowedOrigins: string[] };

      expect(status.enabled).toBe(true);
      expect(status.manifestPaths).toEqual([manifestPath]);
      expect(status.allowedOrigins).toEqual(["chrome-extension://abcdefghijklmnopabcdefghijklmnop/"]);
      expect(statSync(configPath).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({ socketPath, tokenPath: `${socketPath}.token` });
      expect(JSON.parse(readFileSync(manifestPath, "utf8"))).toMatchObject({
        name: "com.berry.desktop_host",
        path: nativeHostPath,
        type: "stdio",
        allowed_origins: ["chrome-extension://abcdefghijklmnopabcdefghijklmnop/"],
      });

      await service.handle("extension.nativeMessaging.setEnabled", { enabled: false });
      expect(existsSync(manifestPath)).toBe(false);
    });

    await service.shutdown();
  });
});

async function withEnv<T>(values: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
