import { z } from "zod";

/**
 * Optional per-package declaration of what an entry point needs beyond its own
 * Python imports: same-package files it opens by path, and resources from
 * another skill package (staged into that package's own activated directory).
 * Large optional assets stay out unless an entry point declares them required.
 */
export const SKILL_DEPENDENCY_MANIFEST_PATH = "skill-dependencies.json";

const RelativePathSchema = z.string().trim().min(1).max(512)
  .refine((path) => !path.startsWith("/") && !path.split("/").includes(".."), "Dependency paths must be package-relative");

export const SkillDependencyManifestSchema = z.object({
  version: z.literal(1),
  entryPoints: z.record(RelativePathSchema, z.object({
    requires: z.array(z.object({
      skill: z.string().trim().min(1).max(64).optional(),
      resources: z.array(RelativePathSchema).min(1).max(100),
    })).max(20),
  })),
});
export type SkillDependencyManifest = z.infer<typeof SkillDependencyManifestSchema>;

export function parseSkillDependencyManifest(bytes: Uint8Array): SkillDependencyManifest {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new Error(`${SKILL_DEPENDENCY_MANIFEST_PATH} is not valid JSON`);
  }
  const parsed = SkillDependencyManifestSchema.safeParse(decoded);
  if (!parsed.success) throw new Error(`${SKILL_DEPENDENCY_MANIFEST_PATH} is invalid: ${parsed.error.issues[0]?.message ?? "unknown error"}`);
  return parsed.data;
}

/** Module references from Python import statements, including function-local imports. */
export function pythonImports(source: string): Array<{ module: string; level: number; names: string[] }> {
  const imports: Array<{ module: string; level: number; names: string[] }> = [];
  // Join parenthesised continuation lines so `from x import (a,\n b)` parses.
  const text = source.replace(/\(\s*([^()]*?)\s*\)/gs, (_match, inner: string) => inner.replace(/\s*\n\s*/g, " "));
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const from = /^from\s+(\.*)([\w.]*)\s+import\s+(.+)$/.exec(line);
    if (from) {
      imports.push({
        module: from[2] ?? "",
        level: from[1]!.length,
        names: from[3]!.split(",").map((name) => name.trim().split(/\s+as\s+/)[0]!.trim()).filter((name) => /^\w+$/.test(name)),
      });
      continue;
    }
    const plain = /^import\s+(.+)$/.exec(line);
    if (plain) {
      for (const part of plain[1]!.split(",")) {
        const module = part.trim().split(/\s+as\s+/)[0]!.trim();
        if (/^[\w.]+$/.test(module)) imports.push({ module, level: 0, names: [] });
      }
    }
  }
  return imports;
}

/**
 * Package files a Python script imports from its own directory tree (sibling
 * helpers). Third-party and standard-library modules have no package file and
 * are ignored; nothing outside the package is guessed.
 */
export function siblingImportPaths(scriptPath: string, source: string, available: ReadonlySet<string>): string[] {
  const directory = scriptPath.includes("/") ? scriptPath.slice(0, scriptPath.lastIndexOf("/")) : "";
  const found = new Set<string>();
  const join = (base: string, relative: string) => [base, relative].filter(Boolean).join("/");
  const consider = (base: string, dotted: string) => {
    if (!dotted) return;
    const modulePath = join(base, dotted.replace(/\./g, "/"));
    for (const candidate of [`${modulePath}.py`, `${modulePath}/__init__.py`]) {
      if (available.has(candidate)) found.add(candidate);
    }
    // A dotted import also executes each parent package's __init__.py.
    const parts = dotted.split(".");
    for (let index = 1; index < parts.length; index += 1) {
      const init = `${join(base, parts.slice(0, index).join("/"))}/__init__.py`;
      if (available.has(init)) found.add(init);
    }
  };
  for (const entry of pythonImports(source)) {
    let base = directory;
    for (let level = 1; level < entry.level; level += 1) base = base.includes("/") ? base.slice(0, base.lastIndexOf("/")) : "";
    consider(base, entry.module);
    // `from . import helper` / `from pkg import submodule` may name modules.
    for (const name of entry.names) consider(base, entry.module ? `${entry.module}.${name}` : name);
  }
  found.delete(scriptPath);
  return [...found].sort();
}
