import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalProcessExecutor } from "@berry/harness/node";
import type { CommandHook } from "@berry/shared";
import { afterEach, describe, expect, it } from "vitest";
import { HookRunner, parseHookConfig } from "./hooks.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "berry-hooks-"));
  roots.push(root);
  return root;
}

function script(root: string, name: string, source: string): string {
  const path = join(root, name);
  writeFileSync(path, source);
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(path)}`;
}

function hook(command: string, overrides: Partial<CommandHook> = {}): CommandHook {
  return {
    id: "test-hook",
    event: "PreToolUse",
    matcher: "^bash$",
    command,
    timeoutMs: 1_000,
    failurePolicy: "block",
    source: "workspace",
    ...overrides,
  };
}

const payload = (root: string) => ({
  sessionId: "session-1",
  turnId: "turn-1",
  workspacePath: root,
  toolCallId: "call-1",
  toolName: "bash",
  input: { command: "echo original" },
});

describe("command hooks", () => {
  it("parses ecosystem-style grouped command hooks", () => {
    expect(parseHookConfig({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "check.sh", timeout: 2 }] }] } }, "user")).toEqual([
      expect.objectContaining({ event: "PreToolUse", matcher: "Bash", command: "check.sh", timeoutMs: 2_000, source: "user" }),
    ]);
  });

  it("rewrites arguments in order and blocks with the hook reason", async () => {
    const root = fixture();
    const rewrite = script(root, "rewrite.mjs", `process.stdin.on("data", c => { const p=JSON.parse(c); process.stdout.write(JSON.stringify({updatedInput:{command:p.input.command+" && echo rewritten"}})); });`);
    const block = script(root, "block.mjs", `process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(JSON.stringify({decision:"block",reason:"policy hook rejected command"})));`);
    const executor = new LocalProcessExecutor();
    try {
      const runner = new HookRunner([hook(rewrite), hook(block, { id: "block-hook" })], executor);
      await expect(runner.preTool(payload(root))).resolves.toEqual({
        block: true,
        reason: "policy hook rejected command",
        input: { command: "echo original && echo rewritten" },
      });
    } finally {
      await executor.dispose();
    }
  });

  it("redacts post-tool output before it reaches observers", async () => {
    const root = fixture();
    const redact = script(root, "redact.mjs", `process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(JSON.stringify({redact:["secret-token"]})));`);
    const executor = new LocalProcessExecutor();
    try {
      const runner = new HookRunner([hook(redact, { event: "PostToolUse" })], executor);
      await expect(runner.postTool({ ...payload(root), output: { content: [{ type: "text", text: "token=secret-token" }] } })).resolves.toEqual({
        output: { content: [{ type: "text", text: "token=[REDACTED]" }] },
      });
    } finally {
      await executor.dispose();
    }
  });

  it("fails closed on timeout unless the hook policy says continue", async () => {
    const root = fixture();
    const slow = script(root, "slow.mjs", `process.stdin.resume(); setTimeout(() => process.stdout.write("{}"), 5000);`);
    const executor = new LocalProcessExecutor();
    try {
      const blocked = await new HookRunner([hook(slow, { timeoutMs: 100 })], executor).preTool(payload(root));
      expect(blocked).toMatchObject({ block: true, reason: expect.stringContaining("timed out") });
      const continued = await new HookRunner([hook(slow, { id: "continue-hook", timeoutMs: 100, failurePolicy: "continue" })], executor).preTool(payload(root));
      expect(continued).toEqual({ input: { command: "echo original" } });
    } finally {
      await executor.dispose();
    }
  });

  it("delivers turn lifecycle JSON to command hooks", async () => {
    const root = fixture();
    const output = join(root, "events.txt");
    const capture = script(root, "capture.mjs", `import {appendFileSync} from "node:fs"; let s=""; process.stdin.on("data", c=>s+=c); process.stdin.on("end",()=>{appendFileSync(${JSON.stringify(output)}, JSON.parse(s).hookEventName+"\\n"); process.stdout.write("{}");});`);
    const executor = new LocalProcessExecutor();
    try {
      const runner = new HookRunner([
        hook(capture, { event: "TurnStart", matcher: ".*" }),
        hook(capture, { id: "turn-end", event: "TurnEnd", matcher: ".*" }),
      ], executor);
      await runner.lifecycle("TurnStart", payload(root));
      await runner.lifecycle("TurnEnd", { ...payload(root), status: "completed" });
      expect(readFileSync(output, "utf8")).toBe("TurnStart\nTurnEnd\n");
    } finally {
      await executor.dispose();
    }
  });
});
