import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalizeCommand, ExecPolicyEngine, loadExecPolicy, validateRule } from "./index.ts";

const tempDirs: string[] = [];
afterEach(() => {
  delete process.env.BERRY_HOME;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("execpolicy canonicalization", () => {
  it.each([
    ["npm test", ["npm", "test"]],
    ['bash -lc "npm test"', ["npm", "test"]],
    ["FOO=bar /usr/bin/git status --short", ["git", "status", "--short"]],
    ["env -i FOO=bar /opt/homebrew/bin/rg pattern .", ["rg", "pattern", "."]],
  ])("canonicalizes %s", (command, argv) => expect(canonicalizeCommand(command)).toMatchObject({ argv, ambiguous: false }));

  it("marks operators, substitutions, and malformed quoting ambiguous", () => {
    for (const command of ["git status && rm -rf /", "echo $(whoami)", "echo `whoami`", "echo 'unterminated"]) {
      expect(canonicalizeCommand(command).ambiguous).toBe(true);
    }
  });

  it("preserves canonicalization across generated env and executable-path variants", () => {
    for (const envPrefix of ["", "A=1 ", "env A=1 ", "env -i A=1 "]) {
      for (const executable of ["git", "/usr/bin/git", "/opt/homebrew/bin/git"]) {
        expect(canonicalizeCommand(`${envPrefix}${executable} status --short`).argv).toEqual(["git", "status", "--short"]);
      }
    }
  });

  it("treats unknown and execution-affecting flags conservatively", () => {
    for (const command of ["git diff --ext-diff", "git status --unknown", "rg --pre build.sh pattern"]) {
      expect(canonicalizeCommand(command)).toMatchObject({ ambiguous: true });
      expect(new ExecPolicyEngine().evaluate(command).decision).toBe("prompt");
    }
    expect(new ExecPolicyEngine().evaluate("git diff --stat").decision).toBe("allow");
  });
});

describe("ExecPolicyEngine", () => {
  it("uses strictest matching decision across layers and forbids never prompt", () => {
    const engine = new ExecPolicyEngine([
      { id: "user-allow", kind: "prefix_rule", decision: "allow", pattern: ["git", "reset"], layer: "user" },
      { id: "managed-forbid", kind: "exact", decision: "forbid", pattern: ["git", "reset", "--hard"], layer: "managed" },
    ]);
    expect(engine.evaluate("git reset --hard")).toMatchObject({ decision: "forbid", matchedRules: expect.arrayContaining([expect.objectContaining({ id: "managed-forbid" })]) });
  });

  it("loads validated user and workspace layers while isolating invalid files", () => {
    const root = mkdtempSync(join(tmpdir(), "berry-execpolicy-"));
    tempDirs.push(root);
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    mkdirSync(join(workspace, ".berry"), { recursive: true });
    mkdirSync(home, { recursive: true });
    process.env.BERRY_HOME = home;
    writeFileSync(join(home, "execpolicy.json"), JSON.stringify({ rules: [{ id: "user-npm", kind: "exact", decision: "allow", pattern: ["npm", "test"] }] }));
    writeFileSync(join(workspace, ".berry", "execpolicy.json"), JSON.stringify({ rules: "invalid" }));
    const loaded = loadExecPolicy(workspace);
    expect(loaded.rules).toEqual([expect.objectContaining({ id: "user-npm", layer: "user" })]);
    expect(loaded.diagnostics).toHaveLength(1);
    expect(new ExecPolicyEngine(loaded.rules).evaluate("bash -lc 'npm test'").decision).toBe("allow");
  });

  it("auto-allows curated reads, prompts unknown commands, and never allows ambiguous compounds", () => {
    const engine = new ExecPolicyEngine();
    expect(engine.evaluate("git status --short").decision).toBe("allow");
    expect(engine.evaluate("npm test").decision).toBe("prompt");
    expect(engine.evaluate("git status && npm test").decision).toBe("prompt");
    expect(engine.evaluate("git status && sudo rm -rf /").decision).toBe("forbid");
  });

  it("prompts for GitHub PR writes and forbids every curated merge form", () => {
    const engine = new ExecPolicyEngine([{ id: "user-merge", kind: "prefix_rule", decision: "allow", pattern: ["gh", "pr", "merge"], layer: "user" }]);
    for (const command of ["gh pr create --draft", "/usr/bin/gh pr comment 42 --body review", "gh api --method POST repos/o/r/pulls/42/comments"]) {
      expect(engine.evaluate(command)).toMatchObject({ decision: "prompt", matchedRules: expect.arrayContaining([expect.objectContaining({ decision: "prompt", layer: "base" })]) });
    }
    expect(engine.evaluate("gh pr merge 42 --squash")).toMatchObject({ decision: "forbid", matchedRules: expect.arrayContaining([expect.objectContaining({ id: "base-gh-pr-merge" })]) });
    expect(engine.evaluate("gh api --method PUT repos/o/r/pulls/42/merge")).toMatchObject({ decision: "forbid", matchedRules: expect.arrayContaining([expect.objectContaining({ id: "base-gh-api-pr-merge" })]) });
    expect(engine.evaluate("gh api graphql -f query='mutation { mergePullRequest(input: {}) { clientMutationId } }'")).toMatchObject({ decision: "forbid", matchedRules: expect.arrayContaining([expect.objectContaining({ id: "base-gh-api-graphql-merge" })]) });
  });

  it("rejects overpowered or invalid regex-lite rules at load time", () => {
    expect(() => validateRule({ id: "bad", kind: "regex-lite", decision: "allow", pattern: "(?=npm)", layer: "user" })).toThrow("regex-lite forbids");
    expect(() => validateRule({ id: "bad", kind: "exact", decision: "allow", pattern: [], layer: "user" })).toThrow("non-empty string array");
    expect(() => validateRule({ id: "bad-network", kind: "network", decision: "allow", pattern: "https://example.com/path", layer: "user" })).toThrow("exact domain");
  });

  it("applies strict network rules to exact and wildcard domains", () => {
    const engine = new ExecPolicyEngine([
      { id: "allow-docs", kind: "network", decision: "allow", pattern: "*.example.com", layer: "user" },
      { id: "block-admin", kind: "network", decision: "forbid", pattern: "admin.example.com", layer: "managed" },
    ]);
    expect(engine.evaluateNetwork("https://docs.example.com/start")).toMatchObject({ decision: "allow", hostname: "docs.example.com" });
    expect(engine.evaluateNetwork("https://admin.example.com")).toMatchObject({ decision: "forbid" });
    expect(engine.evaluateNetwork("https://example.com")).toMatchObject({ decision: "prompt" });
  });
});
