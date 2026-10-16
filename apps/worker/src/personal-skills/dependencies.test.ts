import { describe, expect, it } from "vitest";
import { parseSkillDependencyManifest, pythonImports, siblingImportPaths } from "./dependencies.js";

describe("skill dependency resolution", () => {
  const available = new Set([
    "scripts/main.py", "scripts/helpers.py", "scripts/fmt.py", "scripts/pkg/__init__.py", "scripts/pkg/tables.py",
    "scripts/lazy.py", "scripts/aliased.py", "lib/shared.py", "assets/templates/large.docx",
  ]);

  it("finds plain, from, parenthesised, aliased, relative and function-local sibling imports", () => {
    const source = [
      "from __future__ import annotations",
      "import os, json as j",
      "import helpers",
      "from fmt import (",
      "    a,",
      "    b,",
      ")",
      "from pkg.tables import render",
      "import aliased as alias  # comment",
      "def later():",
      "    from . import lazy",
      "    from .. import nothing",
      "text = 'import fake_module'",
    ].join("\n");
    expect(siblingImportPaths("scripts/main.py", source, available)).toEqual([
      "scripts/aliased.py", "scripts/fmt.py", "scripts/helpers.py", "scripts/lazy.py", "scripts/pkg/__init__.py", "scripts/pkg/tables.py",
    ]);
  });

  it("ignores standard-library and third-party modules that have no package file", () => {
    expect(siblingImportPaths("scripts/main.py", "import docx\nfrom lxml import etree\nimport zipfile\n", available)).toEqual([]);
  });

  it("does not treat a string mentioning import as an import", () => {
    expect(pythonImports("message = 'import helpers'\n")).toEqual([]);
  });

  it("validates the manifest and rejects paths that escape the package", () => {
    expect(parseSkillDependencyManifest(Buffer.from(JSON.stringify({
      version: 1,
      entryPoints: { "scripts/main.py": { requires: [{ skill: "branding", resources: ["scripts/office_converter.py"] }] } },
    }))).entryPoints["scripts/main.py"]?.requires[0]?.skill).toBe("branding");
    expect(() => parseSkillDependencyManifest(Buffer.from(JSON.stringify({
      version: 1,
      entryPoints: { "scripts/main.py": { requires: [{ resources: ["../other/secret.py"] }] } },
    })))).toThrow("package-relative");
    expect(() => parseSkillDependencyManifest(Buffer.from("{"))).toThrow("not valid JSON");
  });
});
