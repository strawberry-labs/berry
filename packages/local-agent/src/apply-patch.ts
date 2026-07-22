import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExecutionEnv } from "@berry/harness";
import { assertWritableWorkspacePath } from "./workspace-path.ts";

const BEGIN_MARKER = "*** Begin Patch";
const END_MARKER = "*** End Patch";
const ADD_PREFIX = "*** Add File: ";
const UPDATE_PREFIX = "*** Update File: ";
const DELETE_PREFIX = "*** Delete File: ";
const MOVE_PREFIX = "*** Move to: ";

export interface PatchHunk {
  context: string[];
  removed: string[];
  added: string[];
}

export type PatchOperation =
  | { kind: "add"; path: string; content: string }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; moveTo?: string; hunks: PatchHunk[] };

export class ApplyPatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApplyPatchError";
  }
}

/** Parse the structured `*** Begin Patch` grammar into file operations. */
export function parsePatch(patch: string): PatchOperation[] {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  let index = lines.findIndex((line) => line.trim() === BEGIN_MARKER);
  if (index < 0) throw new ApplyPatchError(`Patch must start with "${BEGIN_MARKER}"`);
  index += 1;
  const operations: PatchOperation[] = [];

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === END_MARKER) return operations;
    if (line.startsWith(ADD_PREFIX)) {
      const path = line.slice(ADD_PREFIX.length).trim();
      index += 1;
      const content: string[] = [];
      while (index < lines.length && lines[index]!.startsWith("+")) {
        content.push(lines[index]!.slice(1));
        index += 1;
      }
      operations.push({ kind: "add", path, content: content.join("\n") });
      continue;
    }
    if (line.startsWith(DELETE_PREFIX)) {
      operations.push({ kind: "delete", path: line.slice(DELETE_PREFIX.length).trim() });
      index += 1;
      continue;
    }
    if (line.startsWith(UPDATE_PREFIX)) {
      const path = line.slice(UPDATE_PREFIX.length).trim();
      index += 1;
      let moveTo: string | undefined;
      if (lines[index]?.startsWith(MOVE_PREFIX)) {
        moveTo = lines[index]!.slice(MOVE_PREFIX.length).trim();
        index += 1;
      }
      const hunks: PatchHunk[] = [];
      let hunk: PatchHunk | null = null;
      const flush = () => {
        if (hunk && (hunk.removed.length > 0 || hunk.added.length > 0 || hunk.context.length > 0)) hunks.push(hunk);
        hunk = null;
      };
      while (index < lines.length) {
        const bodyLine = lines[index] ?? "";
        if (bodyLine.startsWith("*** ")) break;
        if (bodyLine.startsWith("@@")) {
          flush();
          hunk = { context: [], removed: [], added: [] };
          index += 1;
          continue;
        }
        hunk ??= { context: [], removed: [], added: [] };
        if (bodyLine.startsWith("+")) hunk.added.push(bodyLine.slice(1));
        else if (bodyLine.startsWith("-")) hunk.removed.push(bodyLine.slice(1));
        else hunk.context.push(bodyLine.startsWith(" ") ? bodyLine.slice(1) : bodyLine);
        index += 1;
      }
      flush();
      if (hunks.length === 0) throw new ApplyPatchError(`Update for ${path} has no hunks`);
      const operation: PatchOperation = { kind: "update", path, hunks };
      if (moveTo) operation.moveTo = moveTo;
      operations.push(operation);
      continue;
    }
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    throw new ApplyPatchError(`Unexpected patch line: ${line}`);
  }
  throw new ApplyPatchError(`Patch is missing "${END_MARKER}"`);
}

function applyHunksToContent(path: string, content: string, hunks: PatchHunk[]): string {
  let lines = content.split("\n");
  let searchFrom = 0;
  for (const hunk of hunks) {
    const pattern = [...hunk.context.slice(0, findRemovalOffset(hunk)), ...hunk.removed];
    const anchor = hunk.removed.length > 0 ? hunk.removed : hunk.context;
    if (anchor.length === 0) {
      lines = [...lines, ...hunk.added];
      continue;
    }
    const matchIndex = findSequence(lines, anchor, searchFrom);
    if (matchIndex < 0) {
      throw new ApplyPatchError(`Could not locate hunk in ${path}:\n${pattern.join("\n")}`);
    }
    if (hunk.removed.length > 0) {
      lines.splice(matchIndex, hunk.removed.length, ...hunk.added);
      searchFrom = matchIndex + hunk.added.length;
    } else {
      const insertAt = matchIndex + anchor.length;
      lines.splice(insertAt, 0, ...hunk.added);
      searchFrom = insertAt + hunk.added.length;
    }
  }
  return lines.join("\n");
}

function findRemovalOffset(hunk: PatchHunk): number {
  return hunk.context.length;
}

function findSequence(haystack: string[], needle: string[], from: number): number {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  // Retry from the start in case hunks are not strictly ordered.
  if (from > 0) return findSequence(haystack, needle, 0);
  return -1;
}

export interface ApplyPatchResult {
  added: string[];
  updated: string[];
  deleted: string[];
}

export interface ApplyPatchOptions {
  allowProtectedWrite?: boolean;
}

/** Apply a parsed patch to files under the workspace root. */
export function applyPatch(workspaceRoot: string, patch: string, options: ApplyPatchOptions = {}): ApplyPatchResult {
  const operations = parsePatch(patch);
  const result: ApplyPatchResult = { added: [], updated: [], deleted: [] };
  for (const operation of operations) {
    const target = assertWritableWorkspacePath(workspaceRoot, operation.path, options);
    if (operation.kind === "add") {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, operation.content, "utf8");
      result.added.push(operation.path);
      continue;
    }
    if (operation.kind === "delete") {
      if (!existsSync(target)) throw new ApplyPatchError(`Cannot delete missing file: ${operation.path}`);
      rmSync(target);
      result.deleted.push(operation.path);
      continue;
    }
    if (!existsSync(target)) throw new ApplyPatchError(`Cannot update missing file: ${operation.path}`);
    const content = readFileSync(target, "utf8");
    const next = applyHunksToContent(operation.path, content, operation.hunks);
    if (operation.moveTo) {
      const moved = assertWritableWorkspacePath(workspaceRoot, operation.moveTo, options);
      mkdirSync(dirname(moved), { recursive: true });
      writeFileSync(moved, next, "utf8");
      rmSync(target);
      result.updated.push(operation.moveTo);
    } else {
      writeFileSync(target, next, "utf8");
      result.updated.push(operation.path);
    }
  }
  return result;
}

/** Apply a parsed patch through an ExecutionEnv filesystem. */
export async function applyPatchWithEnv(env: ExecutionEnv, workspaceRoot: string, patch: string, options: ApplyPatchOptions = {}): Promise<ApplyPatchResult> {
  const operations = parsePatch(patch);
  const result: ApplyPatchResult = { added: [], updated: [], deleted: [] };
  for (const operation of operations) {
    const target = assertWritableWorkspacePath(workspaceRoot, operation.path, options);
    if (operation.kind === "add") {
      const written = await env.writeFile(target, operation.content);
      if (!written.ok) throw written.error;
      result.added.push(operation.path);
      continue;
    }
    if (operation.kind === "delete") {
      const exists = await env.exists(target);
      if (!exists.ok) throw exists.error;
      if (!exists.value) throw new ApplyPatchError(`Cannot delete missing file: ${operation.path}`);
      const removed = await env.remove(target, { force: false });
      if (!removed.ok) throw removed.error;
      result.deleted.push(operation.path);
      continue;
    }
    const existing = await env.readTextFile(target);
    if (!existing.ok) {
      if (existing.error.code === "not_found") throw new ApplyPatchError(`Cannot update missing file: ${operation.path}`);
      throw existing.error;
    }
    const next = applyHunksToContent(operation.path, existing.value, operation.hunks);
    if (operation.moveTo) {
      const moved = assertWritableWorkspacePath(workspaceRoot, operation.moveTo, options);
      const written = await env.writeFile(moved, next);
      if (!written.ok) throw written.error;
      const removed = await env.remove(target, { force: false });
      if (!removed.ok) throw removed.error;
      result.updated.push(operation.moveTo);
    } else {
      const written = await env.writeFile(target, next);
      if (!written.ok) throw written.error;
      result.updated.push(operation.path);
    }
  }
  return result;
}
