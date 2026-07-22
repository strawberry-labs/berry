import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderFormula } from "../../scripts/render-homebrew-formula.mjs";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Homebrew formula renderer", () => {
  it("fills every platform URL and checksum from release artifacts", () => {
    const dir = mkdtempSync(join(tmpdir(), "berry-formula-"));
    tempDirs.push(dir);
    const artifactDir = join(dir, "artifacts");
    mkdirSync(artifactDir);
    const targets = ["aarch64-apple-darwin", "x86_64-apple-darwin", "aarch64-unknown-linux-gnu", "x86_64-unknown-linux-gnu"];
    for (const [index, target] of targets.entries()) {
      writeFileSync(join(artifactDir, `berry-${target}.sha256`), `${String(index + 1).repeat(64)}  berry-${target}\n`);
    }
    const formula = renderFormula({
      version: "0.1.0",
      repository: "example/berry",
      artifactDir,
      baseUrl: "https://downloads.example.test/cli-v0.1.0",
      templatePath: resolve(import.meta.dirname, "../../distribution/homebrew/berry.rb.template"),
    });
    expect(formula).toContain('homepage "https://github.com/example/berry"');
    expect(formula).toContain('version "0.1.0"');
    for (const target of targets) expect(formula).toContain(`https://downloads.example.test/cli-v0.1.0/berry-${target}`);
    expect(formula).not.toMatch(/__[A-Z0-9_]+__/);
  });
});
