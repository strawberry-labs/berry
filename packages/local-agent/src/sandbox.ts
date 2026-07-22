import { accessSync, constants, existsSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { CommandInvocation, CommandWrapper } from "@berry/harness/node";
import type { SandboxPolicy, SandboxStatus } from "@berry/shared";

export interface SandboxEnforcerOptions {
  platform?: NodeJS.Platform;
  commandExists?: (path: string) => boolean;
}

export class SandboxEnforcer {
  readonly #platform: NodeJS.Platform;
  readonly #commandExists: (path: string) => boolean;

  constructor(options: SandboxEnforcerOptions = {}) {
    this.#platform = options.platform ?? process.platform;
    this.#commandExists = options.commandExists ?? executableExists;
  }

  status(policy: SandboxPolicy): SandboxStatus {
    const platform = platformName(this.#platform);
    const network = policy.tier === "workspace-write" ? policy.network : policy.tier === "read-only" ? "off" : "unrestricted";
    if (policy.tier === "danger-full-access") return { platform, tier: policy.tier, enforcement: "enforced", mechanism: "none", network, reason: null };
    if (this.#platform === "darwin" && this.#commandExists("/usr/bin/sandbox-exec")) {
      return { platform, tier: policy.tier, enforcement: "enforced", mechanism: "seatbelt", network, reason: null };
    }
    if (this.#platform === "linux" && (this.#commandExists("/usr/bin/bwrap") || this.#commandExists("/bin/bwrap"))) {
      return { platform, tier: policy.tier, enforcement: "enforced", mechanism: "bubblewrap", network, reason: null };
    }
    const reason = this.#platform === "win32"
      ? "Windows restricted-token enforcement is not available yet; approvals remain active."
      : this.#platform === "linux"
        ? "bubblewrap is not installed; approvals remain active."
        : this.#platform === "darwin"
          ? "sandbox-exec is unavailable; approvals remain active."
          : "OS sandbox enforcement is unavailable on this platform; approvals remain active.";
    return { platform, tier: policy.tier, enforcement: "approval-only", mechanism: "none", network, reason };
  }

  commandWrapper(policy: SandboxPolicy): CommandWrapper {
    return (invocation) => this.wrap(invocation, policy);
  }

  wrap(invocation: CommandInvocation, policy: SandboxPolicy): CommandInvocation {
    const status = this.status(policy);
    if (policy.tier === "danger-full-access" || status.enforcement !== "enforced") return invocation;
    const target = invocation.options.shell
      ? { command: process.platform === "win32" ? invocation.command : "/bin/sh", args: process.platform === "win32" ? invocation.args : ["-lc", invocation.command] }
      : { command: invocation.command, args: invocation.args };
    const options = invocation.options.shell ? { ...invocation.options, shell: false } : invocation.options;
    const helper = resolveSandboxHelper();
    if (helper) {
      return {
        command: helper,
        args: ["--policy-base64", Buffer.from(JSON.stringify(policy)).toString("base64"), "--", target.command, ...target.args],
        options,
      };
    }
    if (status.mechanism === "seatbelt") {
      return { command: "/usr/bin/sandbox-exec", args: ["-p", seatbeltProfile(policy), target.command, ...target.args], options };
    }
    if (status.mechanism === "bubblewrap") {
      const cwd = typeof invocation.options.cwd === "string" ? invocation.options.cwd : process.cwd();
      const args = ["--die-with-parent", "--new-session", "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev"];
      if (policy.tier === "workspace-write") {
        for (const root of canonicalRoots(policy.writableRoots)) args.push("--bind", root, root);
        if (policy.network === "off") args.push("--unshare-net");
      } else {
        args.push("--unshare-net");
      }
      args.push("--chdir", cwd, "--", target.command, ...target.args);
      return { command: this.#commandExists("/usr/bin/bwrap") ? "/usr/bin/bwrap" : "/bin/bwrap", args, options };
    }
    return invocation;
  }
}

export function resolveSandboxHelper(): string | null {
  const configured = process.env.BERRY_SANDBOX_BIN;
  if (configured && executableExists(configured)) return configured;
  const executableDir = dirname(process.execPath);
  try {
    const bundled = readdirSync(executableDir).find((name) => /^berry-sandbox(?:-|\.exe$)/.test(name));
    if (bundled) {
      const path = join(executableDir, bundled);
      if (executableExists(path)) return path;
    }
  } catch {
    // Development runtimes do not keep sidecars beside the Node executable.
  }
  const binary = process.platform === "win32" ? "berry-sandbox.exe" : "berry-sandbox";
  for (const path of [
    resolve(process.cwd(), "crates", "berry-sandbox", "target", "release", binary),
    resolve(process.cwd(), "crates", "berry-sandbox", "target", "debug", binary),
  ]) {
    if (executableExists(path)) return path;
  }
  return null;
}

export function seatbeltProfile(policy: SandboxPolicy): string {
  const lines = [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow file-read*)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow signal)",
    "(allow ipc-posix-shm)",
    '(allow file-write* (literal "/dev/null"))',
  ];
  if (policy.tier === "workspace-write") {
    const roots = canonicalRoots(policy.writableRoots);
    if (roots.length > 0) lines.push(`(allow file-write* ${roots.map((root) => `(subpath ${JSON.stringify(root)})`).join(" ")})`);
    for (const root of roots) {
      lines.push(`(deny file-write* (subpath ${JSON.stringify(resolve(root, ".git", "hooks"))}) (subpath ${JSON.stringify(resolve(root, ".berry"))}) (subpath ${JSON.stringify(resolve(root, ".codex"))}) (subpath ${JSON.stringify(resolve(root, ".agents"))}) (subpath ${JSON.stringify(resolve(root, ".ssh"))}))`);
    }
    if (policy.network === "on") lines.push("(allow network*)");
  }
  return lines.join("\n");
}

export function assertShellWritePolicy(command: string): void {
  const protectedPattern = /(^|[\s'"`=/:])(?:\.git\/hooks|\.berry|\.codex|\.agents|\.ssh|\.env(?:\.[^\s'"`]*)?|\.npmrc|\.netrc|id_(?:rsa|dsa|ecdsa|ed25519)|[^\s'"`]+\.(?:pem|key|p12|pfx))(?=$|[\s'"`/;&|)])/i;
  const match = command.match(protectedPattern);
  if (match) throw new Error(`Shell command references protected credential/config path: ${match[0]!.trim()}`);
}

function canonicalRoots(roots: string[]): string[] {
  return [...new Set(roots.map((root) => existsSync(root) ? realpathSync(root) : resolve(root)))];
}

function executableExists(path: string): boolean {
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
}

function platformName(platform: NodeJS.Platform): SandboxStatus["platform"] {
  if (platform === "darwin") return "macos";
  if (platform === "linux") return "linux";
  if (platform === "win32") return "windows";
  return "other";
}
