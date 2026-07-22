import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxPolicyForPermission } from "@berry/shared";
import { afterEach, describe, expect, it } from "vitest";

import { LocalProvider } from "./sandbox-provider.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("LocalProvider", () => {
  it("creates a local execution session and releases provider-owned processes", async () => {
    const root = mkdtempSync(join(tmpdir(), "berry-local-provider-"));
    roots.push(root);
    const provider = new LocalProvider();
    const session = await provider.createSession({
      sessionId: "session_local_1",
      taskId: "task_local_1",
      workspacePath: root,
      policy: sandboxPolicyForPermission("full-access", root),
      enforceEscalated: false,
    });

    const result = await session.env.exec("printf provider-ok");
    expect(result.ok && result.value).toMatchObject({ stdout: "provider-ok", exitCode: 0 });
    expect(session.status.tier).toBe("danger-full-access");
    await session.dispose();
    await provider.dispose();
  });
});
