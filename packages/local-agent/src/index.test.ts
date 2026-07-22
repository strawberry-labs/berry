import { describe, expect, it } from "vitest";
import { GrantStore, SlashCommandRegistry, ToolGuard } from "./index.ts";

describe("ToolGuard", () => {
  it("blocks mutating operations in plan mode", () => {
    const decision = new ToolGuard().decide({
      permissionMode: "plan",
      risk: "file-edit",
      toolName: "file.write",
      summary: "write file",
    });
    expect(decision).toMatchObject({
      type: "block",
      reason: "plan mode does not allow mutating tools or command execution",
      trace: [expect.objectContaining({ stage: "permission-mode", decision: "forbid" })],
    });
  });

  it("allows file edits in auto-edit mode but asks for shell", () => {
    const guard = new ToolGuard();
    expect(
      guard.decide({
        permissionMode: "auto-edit",
        risk: "file-edit",
        toolName: "file.write",
        summary: "write file",
      }).type,
    ).toBe("allow");
    expect(
      guard.decide({
        permissionMode: "auto-edit",
        risk: "shell",
        toolName: "terminal.exec",
        summary: "run command",
      }).type,
    ).toBe("approval-required");
  });

  it("routes explicit danger escalation through approval before grants", () => {
    const request = {
      permissionMode: "auto-edit" as const,
      risk: "shell" as const,
      toolName: "bash",
      summary: "run outside the workspace sandbox",
      payload: { command: "make install", sandbox_permissions: "require_escalated" },
      sandboxPolicy: { tier: "workspace-write" as const, writableRoots: ["/workspace"], network: "off" as const },
    };
    expect(new ToolGuard().decide(request)).toMatchObject({
      type: "approval-required",
      approvalKind: "shell",
      reason: "bash requests danger-full-access for this tool call",
      subject: "sandbox:danger-full-access:bash",
      trace: expect.arrayContaining([expect.objectContaining({ stage: "sandbox", decision: "prompt" })]),
    });
    expect(new ToolGuard().decide({ ...request, permissionMode: "plan" })).toMatchObject({ type: "block" });
  });

  it("blocks forbidden commands before sandbox, grants, and full-access mode", () => {
    const decision = new ToolGuard().decide({
      permissionMode: "full-access",
      risk: "shell",
      toolName: "bash",
      summary: "reset repository",
      payload: { command: "git reset --hard" },
      sandboxPolicy: { tier: "danger-full-access" },
    });
    expect(decision).toMatchObject({
      type: "block",
      trace: expect.arrayContaining([expect.objectContaining({ stage: "execpolicy", decision: "forbid", ruleId: "base-git-reset-hard" })]),
    });
    expect(decision.trace.some((entry) => entry.stage === "sandbox" || entry.stage === "grant")).toBe(false);
  });

  it("enforces network policy before origin approvals", () => {
    const base = {
      permissionMode: "ask" as const,
      risk: "browser" as const,
      toolName: "fetch_url",
      summary: "fetch docs",
      payload: { url: "https://docs.example.com/start" },
    };
    expect(new ToolGuard().decide({ ...base, networkPolicy: { egress: "off", allowedDomains: [] } })).toMatchObject({
      type: "block",
      trace: expect.arrayContaining([expect.objectContaining({ stage: "sandbox", decision: "forbid" })]),
    });
    expect(new ToolGuard().decide({ ...base, networkPolicy: { egress: "on", allowedDomains: ["api.example.com"] } })).toMatchObject({
      type: "block",
      reason: "docs.example.com is not in the network domain allowlist",
    });
    expect(new ToolGuard().decide({ ...base, networkPolicy: { egress: "on", allowedDomains: ["*.example.com"] } })).toMatchObject({
      type: "approval-required",
      subject: "browser:https://docs.example.com",
    });
  });

  it("applies execpolicy network forbids before sandbox policy", () => {
    const decision = new ToolGuard().decide({
      permissionMode: "full-access",
      risk: "browser",
      toolName: "browser_navigate",
      summary: "open admin",
      payload: { url: "https://admin.example.com" },
      networkPolicy: { egress: "unrestricted", allowedDomains: [] },
      execPolicyRules: [{ id: "managed-admin", kind: "network", decision: "forbid", pattern: "admin.example.com", layer: "managed" }],
    });
    expect(decision).toMatchObject({ type: "block", reason: "execpolicy forbids network access to admin.example.com" });
    expect(decision.trace.some((entry) => entry.stage === "sandbox")).toBe(false);
  });

  it("does not treat a trusted remote MCP tool argument as a direct Berry network destination", () => {
    const decision = new ToolGuard().decide({
      permissionMode: "full-access",
      risk: "mcp",
      toolName: "mcp__BerryCrawl__scrape_url",
      summary: "scrape an article through BerryCrawl",
      payload: { url: "https://news.example.com/article" },
      networkPolicy: { egress: "on", allowedDomains: ["api.berrycrawl.com"] },
    });
    expect(decision).toMatchObject({ type: "allow", reason: "full-access mode" });
  });

  it("uses conservative session grants for identical shell commands", () => {
    const grants = new GrantStore();
    const request = {
      workspaceId: "ws_1",
      permissionMode: "ask" as const,
      risk: "shell" as const,
      toolName: "bash",
      summary: "FOO=bar /usr/bin/npm test",
      payload: { command: "FOO=bar /usr/bin/npm test" },
    };
    grants.allowForSession(request);
    const guard = new ToolGuard(grants);
    expect(guard.decide(request)).toMatchObject({ type: "allow", subject: "bash:npm test" });
    expect(
      guard.decide({
        ...request,
        payload: { command: "npm run lint" },
      }).type,
    ).toBe("approval-required");
  });

  it("canonicalizes browser grants by origin", () => {
    const grants = new GrantStore();
    const navigate = {
      workspaceId: "ws_1",
      permissionMode: "ask" as const,
      risk: "browser" as const,
      toolName: "browser_navigate",
      summary: "Allow agent to browse github.com this session",
      payload: { url: "https://github.com/berry/repo" },
    };
    expect(new ToolGuard(grants).decide(navigate)).toMatchObject({
      type: "approval-required",
      approvalKind: "browser",
      subject: "browser:https://github.com",
    });
    grants.allowForSession(navigate);
    const guard = new ToolGuard(grants);
    expect(guard.decide({
      ...navigate,
      toolName: "browser_click",
      payload: { url: "https://github.com/settings", session_id: "browser_1", selector: "@e1" },
    })).toMatchObject({ type: "allow", subject: "browser:https://github.com" });
    expect(guard.decide({ ...navigate, payload: { url: "https://example.com" } }).type).toBe("approval-required");
  });
});

describe("SlashCommandRegistry", () => {
  it("parses built-in slash commands", () => {
    const parsed = new SlashCommandRegistry("2026-07-01T00:00:00.000Z").parse("/model openai/gpt-4.1");
    expect(parsed?.command.name).toBe("model");
    expect(parsed?.args).toEqual(["openai/gpt-4.1"]);
    expect(new SlashCommandRegistry("2026-07-01T00:00:00.000Z").parse("/goal ship parity")?.args).toEqual(["ship", "parity"]);
    expect(new SlashCommandRegistry("2026-07-01T00:00:00.000Z").parse("/pr")?.command.name).toBe("pr");
  });
});
