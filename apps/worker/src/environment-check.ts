import { z } from "zod";
import type { ChatToolDefinition } from "@berry/router-client";
import { ToolArgumentError, notRunMessage } from "./tool-arguments.js";

const executableName = /^[A-Za-z0-9_][A-Za-z0-9_.+-]{0,79}$/;
const moduleName = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const InputSchema = z.object({
  executables: z.array(z.string().max(80).regex(executableName)).max(32).default([]),
  python_modules: z.array(z.string().max(160).regex(moduleName)).max(32).default([]),
}).strict().refine((value) => value.executables.length + value.python_modules.length > 0, {
  message: "Provide at least one executable or Python module to check",
});
export type EnvironmentCheckInput = z.infer<typeof InputSchema>;

export function environmentCheckInput(value: unknown): EnvironmentCheckInput {
  const parsed = InputSchema.safeParse(value);
  if (!parsed.success) throw new ToolArgumentError(notRunMessage("check_environment", parsed.error.issues.map((issue) => issue.message).join("; ")));
  return {
    executables: [...new Set(parsed.data.executables)],
    python_modules: [...new Set(parsed.data.python_modules)],
  };
}

export const environmentCheckDefinition: ChatToolDefinition = {
  type: "function",
  function: {
    name: "check_environment",
    description: "Check installed executable names and discoverable Python modules without running them or importing their code. Missing optional dependencies are normal results. This does not verify that a module imports successfully. Use before choosing a document renderer or installing dependencies.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        executables: { type: "array", maxItems: 32, items: { type: "string", maxLength: 80 }, description: "Bare program names, for example typst, pandoc, libreoffice, pdfinfo. No paths or shell syntax." },
        python_modules: { type: "array", maxItems: 32, items: { type: "string", maxLength: 160 }, description: "Python import names, for example reportlab, fpdf, weasyprint. Names only; no Python code." },
      },
    },
  },
};

/**
 * Translate a small, complete grammar of legacy availability probes into data
 * for our own checker. The original shell/Python text is NEVER executed.
 * A single unrecognised line, operator, substitution or redirection leaves
 * the entire command on the ordinary non-idempotent bash path.
 */
export function environmentCheckFromBash(value: unknown): EnvironmentCheckInput | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const args = value as Record<string, unknown>;
  if (Object.keys(args).some((key) => key !== "command" && key !== "timeout")) return null;
  if (args.timeout !== undefined && (typeof args.timeout !== "number" || !Number.isFinite(args.timeout) || args.timeout < 0)) return null;
  if (typeof args.command !== "string" || args.command.length > 16_000) return null;
  const lines = args.command.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0 || lines.length > 64) return null;
  const executables: string[] = [];
  const python_modules: string[] = [];
  for (const line of lines) {
    const lookup = /^(?:which|command[ \t]+-v|type[ \t]+-P)[ \t]+([A-Za-z0-9_.+ \t-]+?)(?:[ \t]+2>&1)?(?:[ \t]+\|\|[ \t]+(?:true|:))?$/.exec(line);
    if (lookup) {
      const names = lookup[1]!.trim().split(/[ \t]+/);
      if (names.some((name) => !executableName.test(name))) return null;
      executables.push(...names);
      continue;
    }
    const python = /^python3[ \t]+-c[ \t]+(["'])(.*?)\1(?:[ \t]+2>\/dev\/null)?(?:[ \t]+\|\|[ \t]+echo[ \t]+(["'])no ([A-Za-z0-9_.]+)\3)?$/.exec(line);
    if (!python) return null;
    const body = /^import ([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)(?:;[ \t]*print\((["'])([A-Za-z0-9_. ]+)\2\))?$/.exec(python[2]!);
    if (!body || (body[2] && body[2] === python[1])
      || (body[3] !== undefined && body[3] !== body[1] + " installed")
      || (python[4] !== undefined && python[4] !== body[1])) return null;
    python_modules.push(body[1]!);
  }
  const parsed = InputSchema.safeParse({ executables, python_modules });
  return parsed.success ? environmentCheckInput(parsed.data) : null;
}

// -I -S ignores Python environment/startup hooks, sitecustomize and .pth code.
// PathFinder inspects package paths without executing __init__.py, including
// for dotted names. shutil.which only locates programs; none are launched.
export const ENVIRONMENT_CHECK_SCRIPT = String.raw`import importlib.machinery
import json
import os
import shutil
import site
import sys
import sysconfig

request = json.loads(sys.argv[1])
# On Python <= 3.13, -S also suppresses virtualenv prefix initialization.
# Read its data-only config rather than enabling site/.pth/startup execution.
executable_dir = os.path.dirname(os.path.abspath(sys.executable))
venv = None
include_system = True
for candidate in (executable_dir, os.path.dirname(executable_dir)):
    try:
        with open(os.path.join(candidate, "pyvenv.cfg"), encoding="utf-8") as config:
            settings = config.read(65536)
    except FileNotFoundError:
        continue
    venv = candidate
    include_system = any(
        key.strip().lower() == "include-system-site-packages" and value.strip().lower() == "true"
        for line in settings.splitlines()
        for key, separator, value in [line.partition("=")]
        if separator
    )
    break
prefixes = [venv] if venv else [sys.prefix, sys.exec_prefix]
if venv and include_system:
    prefixes.extend([sys.base_prefix, sys.base_exec_prefix])
package_paths = site.getsitepackages(list(dict.fromkeys(prefixes)))
if venv:
    # Debian's site helper omits virtualenv site-packages when -S left the
    # interpreter's prefixes at their base values. Include the PEP 405 layout.
    version = "python%d.%d%s" % (sys.version_info.major, sys.version_info.minor, "t" if "t" in sys.abiflags else "")
    package_paths[:0] = [os.path.join(venv, lib, version, "site-packages") for lib in dict.fromkeys(["lib", sys.platlibdir])]
if not venv or include_system:
    package_paths.extend(p for k, p in sysconfig.get_paths().items() if k in ("purelib", "platlib"))
    package_paths.append(site.getusersitepackages())
paths = list(dict.fromkeys([os.getcwd(), *sys.path, *package_paths]))
def discover(name):
    search = paths
    spec = None
    parts = name.split(".")
    for index in range(len(parts)):
        full = ".".join(parts[:index + 1])
        spec = None
        if index == 0:
            spec = importlib.machinery.BuiltinImporter.find_spec(full)
            if spec is None:
                spec = importlib.machinery.FrozenImporter.find_spec(full)
        if spec is None:
            spec = importlib.machinery.PathFinder.find_spec(full, search)
        if spec is None:
            return False
        if index + 1 < len(parts):
            search = spec.submodule_search_locations
            if search is None:
                return False
    return spec is not None

print(json.dumps({
    "executables": [{"name": name, "available": (path := shutil.which(name)) is not None, "path": path} for name in request["executables"]],
    "python_modules": [{"name": name, "available": discover(name)} for name in request["python_modules"]],
    "note": "Module discovery only: no requested program was run and no requested module was imported. Availability does not verify a successful import.",
}))
`;

const ResultSchema = z.object({
  executables: z.array(z.object({ name: z.string(), available: z.boolean(), path: z.string().nullable() }).strict()).max(32),
  python_modules: z.array(z.object({ name: z.string(), available: z.boolean() }).strict()).max(32),
  note: z.string().max(500),
}).strict();

export function environmentCheckResult(input: EnvironmentCheckInput, text: string) {
  const result = ResultSchema.parse(JSON.parse(text));
  for (const key of ["executables", "python_modules"] as const) {
    if (JSON.stringify(result[key].map((item) => item.name)) !== JSON.stringify(input[key])) {
      throw new Error("Environment check returned incomplete or mismatched results");
    }
  }
  return result;
}
