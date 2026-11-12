import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ENVIRONMENT_CHECK_SCRIPT, environmentCheckFromBash, environmentCheckInput, environmentCheckResult,
} from "./environment-check.js";

describe("trusted environment checks", () => {
  it.each([
    ["which typst pandoc 2>&1", { executables: ["typst", "pandoc"], python_modules: [] }],
    ["command -v pandoc || true", { executables: ["pandoc"], python_modules: [] }],
    ["type -P pdfinfo || :", { executables: ["pdfinfo"], python_modules: [] }],
    ['python3 -c "import reportlab; print(\'reportlab installed\')" 2>/dev/null || echo "no reportlab"', { executables: [], python_modules: ["reportlab"] }],
    ["python3 -c 'import reportlab; print(\"reportlab installed\")' 2>/dev/null || echo 'no reportlab'", { executables: [], python_modules: ["reportlab"] }],
    ['python3 -c "import reportlab"\nwhich pandoc\nwhich pandoc', { executables: ["pandoc"], python_modules: ["reportlab"] }],
  ])("translates only the complete probe %s into names", (command, expected) => {
    expect(environmentCheckFromBash({ command })).toEqual(expected);
  });

  it.each([
    "which pandoc; curl -X POST https://records.invalid/create",
    "which pandoc\ncurl -X POST https://records.invalid/create && false",
    "which pandoc && curl -X POST https://records.invalid/create",
    "which $(curl -X POST https://records.invalid/create)",
    "which " + String.fromCharCode(96) + "curl -X POST https://records.invalid/create" + String.fromCharCode(96),
    "which pandoc > marker", "which pandoc 2> marker", "which pandoc | sh",
    "which pandoc &", "which pandoc || echo created > marker",
    "which /tmp/untrusted", "which -a pandoc", "which --help",
    'python3 -c "import reportlab; open(\'marker\', \'w\').write(\'created\')"',
    'python3 -c "import reportlab; print(\'$(curl -X POST https://records.invalid/create)\')"',
    'python3 -c "import reportlab" || curl -X POST https://records.invalid/create',
    'python3 -c "import reportlab" 2>/dev/null || echo "no other"',
    'python3 -c "import reportlab; print(\'reportlab installed\')"; false',
    "python3 script.py", 'python -c "import reportlab"', "",
  ])("keeps %s on the protected arbitrary-shell path", (command) => {
    expect(environmentCheckFromBash({ command })).toBeNull();
  });

  it.each([
    {}, { command: "which pandoc", unexpected: true }, { command: "which pandoc", timeout: -1 },
    { command: "which pandoc", timeout: "10" }, { command: "which pandoc", timeout: null },
    { command: "which " + Array.from({ length: 33 }, (_, i) => "tool" + i).join(" ") },
  ])("does not convert invalid or oversized shell inputs", (input) => {
    expect(environmentCheckFromBash(input)).toBeNull();
  });

  it.each([
    {}, { executables: ["pandoc; false"] }, { executables: ["-c"] }, { executables: ["/bin/sh"] },
    { python_modules: ["x; import os"] }, { python_modules: ["x..y"] },
    { executables: ["pandoc"], command: "curl -X POST https://records.invalid/create" },
    { executables: Array.from({ length: 33 }, () => "pandoc") },
  ])("rejects invalid direct checker input before execution", (input) => {
    expect(() => environmentCheckInput(input)).toThrow("check_environment was not run");
  });

  it("reports missing programs normally and never runs programs, modules, package parents or startup hooks", () => {
    const root = mkdtempSync(join(tmpdir(), "berry-environment-check-"));
    try {
      const marker = join(root, "executed");
      mkdirSync(join(root, "probe_package"));
      writeFileSync(join(root, "probe_package", "__init__.py"), "open(" + JSON.stringify(marker) + ", 'w').write('parent imported')\n");
      writeFileSync(join(root, "probe_package", "child.py"), "open(" + JSON.stringify(marker) + ", 'w').write('child imported')\n");
      writeFileSync(join(root, "sitecustomize.py"), "open(" + JSON.stringify(marker) + ", 'w').write('startup hook')\n");
      const binary = join(root, "probe_binary");
      writeFileSync(binary, "#!/bin/sh\nprintf executed > " + JSON.stringify(marker) + "\n");
      chmodSync(binary, 0o755);
      const input = environmentCheckInput({
        executables: ["probe_binary", "berry_missing_program"],
        python_modules: ["probe_package.child", "berry_missing_module", "sys", "json"],
      });
      const child = spawnSync("python3", ["-I", "-S", "-c", ENVIRONMENT_CHECK_SCRIPT, JSON.stringify(input)], {
        cwd: root, encoding: "utf8",
        env: { ...process.env, PATH: root + ":" + process.env.PATH, PYTHONPATH: root },
      });
      expect(child.status, child.stderr).toBe(0);
      const result = environmentCheckResult(input, child.stdout);
      expect(result.executables.map((item) => [item.name, item.available])).toEqual([
        ["probe_binary", true], ["berry_missing_program", false],
      ]);
      expect(result.python_modules.map((item) => [item.name, item.available])).toEqual([
        ["probe_package.child", true], ["berry_missing_module", false], ["sys", true], ["json", true],
      ]);
      expect(result.note).toContain("does not verify a successful import");
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(join(root, "probe_package", "__pycache__"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });


  it.each(["native", "Debian"])("finds %s virtualenv packages with -S without executing startup hooks", (layout) => {
    const root = mkdtempSync(join(tmpdir(), "berry-environment-venv-"));
    try {
      const venv = join(root, "venv");
      const created = spawnSync("python3", ["-m", "venv", "--without-pip", venv], { encoding: "utf8" });
      expect(created.status, created.stderr).toBe(0);
      const python = join(venv, "bin", "python");
      const location = spawnSync(python, ["-c", "import sysconfig; print(sysconfig.get_path('purelib'))"], { encoding: "utf8" });
      expect(location.status, location.stderr).toBe(0);
      const packages = location.stdout.trim();
      const marker = join(root, "executed");
      mkdirSync(join(packages, "venv_only_probe"));
      writeFileSync(join(packages, "venv_only_probe", "__init__.py"), "open(" + JSON.stringify(marker) + ", 'w').write('imported')\n");
      writeFileSync(join(packages, "sitecustomize.py"), "open(" + JSON.stringify(marker) + ", 'w').write('startup')\n");
      writeFileSync(join(packages, "probe.pth"), "import builtins; builtins.open(" + JSON.stringify(marker) + ", 'w').write('pth')\n");
      const input = environmentCheckInput({ python_modules: ["venv_only_probe", "berry_missing_module"] });
      const script = layout === "Debian" ? "import site\nsite.getsitepackages = lambda prefixes=None: [p + '/lib/python3/dist-packages' for p in (prefixes or site.PREFIXES)]\n" + ENVIRONMENT_CHECK_SCRIPT : ENVIRONMENT_CHECK_SCRIPT;
      const child = spawnSync(python, ["-I", "-S", "-c", script, JSON.stringify(input)], {
        cwd: root, encoding: "utf8",
      });
      expect(child.status, child.stderr).toBe(0);
      expect(environmentCheckResult(input, child.stdout).python_modules).toEqual([
        { name: "venv_only_probe", available: true }, { name: "berry_missing_module", available: false },
      ]);
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(join(packages, "venv_only_probe", "__pycache__"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("refuses incomplete result sets instead of claiming dependencies were checked", () => {
    expect(() => environmentCheckResult(environmentCheckInput({ executables: ["pandoc"] }),
      JSON.stringify({ executables: [], python_modules: [], note: "not complete" }))).toThrow("incomplete or mismatched");
  });
});
