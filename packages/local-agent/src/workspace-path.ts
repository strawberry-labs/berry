import { basename, relative, resolve, sep } from "node:path";

export class WorkspacePathError extends Error {
  readonly code = "path_outside_workspace";

  constructor(readonly path: string) {
    super(`Path escapes the workspace root: ${path}`);
    this.name = "WorkspacePathError";
  }
}

export class WorkspaceWritePolicyError extends Error {
  readonly code = "protected_workspace_path";

  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`${reason}: ${path}`);
    this.name = "WorkspaceWritePolicyError";
  }
}

export interface WorkspaceWritePolicyOptions {
  allowProtectedWrite?: boolean;
}

const PROTECTED_SEGMENTS = new Set([".git", ".berry", ".codex", ".agents", ".ssh"]);
const PROTECTED_ROOT_PREFIXES = [
  "apps/desktop/src-tauri/binaries/",
  "apps/desktop/src-tauri/target/",
  "crates/berry-pty/target/",
];
const PROTECTED_BASENAMES = new Set([
  ".env",
  ".npmrc",
  ".netrc",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "known_hosts",
  "authorized_keys",
]);
const PROTECTED_EXTENSIONS = [".pem", ".key", ".p12", ".pfx"];

/**
 * Resolve a requested path against the workspace root and reject anything
 * that escapes it. Shared by the Berry tools and the host file/terminal
 * endpoints.
 */
export function safeWorkspacePath(workspaceRoot: string, requestedPath: string): string {
  const root = resolve(workspaceRoot);
  const target = resolve(root, requestedPath);
  if (target !== root && !target.startsWith(`${root}/`)) throw new WorkspacePathError(target);
  return target;
}

export function workspaceWritePolicyReason(workspaceRoot: string, targetPath: string): string | undefined {
  const root = resolve(workspaceRoot);
  const target = resolve(targetPath);
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith("..") || resolve(root, rel) !== target) return undefined;

  const normalized = rel.split(sep).join("/");
  const parts = normalized.split("/").filter(Boolean);
  const protectedSegment = parts.find((part) => PROTECTED_SEGMENTS.has(part));
  if (protectedSegment) return `Writes to ${protectedSegment} are protected`;
  if (PROTECTED_ROOT_PREFIXES.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix))) {
    return "Writes to generated sidecar/build outputs are protected";
  }

  const name = basename(normalized);
  const lowerName = name.toLowerCase();
  if (PROTECTED_BASENAMES.has(name) || lowerName.startsWith(".env.")) return "Writes to credential/config files are protected";
  if (PROTECTED_EXTENSIONS.some((extension) => lowerName.endsWith(extension))) return "Writes to private key/certificate files are protected";
  return undefined;
}

export function assertWritableWorkspacePath(
  workspaceRoot: string,
  requestedPath: string,
  options: WorkspaceWritePolicyOptions = {},
): string {
  const target = safeWorkspacePath(workspaceRoot, requestedPath);
  if (options.allowProtectedWrite === true) return target;
  const reason = workspaceWritePolicyReason(workspaceRoot, target);
  if (reason) throw new WorkspaceWritePolicyError(target, reason);
  return target;
}
