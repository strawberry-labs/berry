import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractOrganizationSkillArchive, readOrganizationSkillArchive } from "./skill-package-archive.ts";

describe("readOrganizationSkillArchive", () => {
  it("retains nested scripts, references, templates, and executable modes", async () => {
    const archive = new JSZip();
    archive.file("cv-creator/SKILL.md", "---\nname: cv-creator\ndescription: Create a CV\n---\nRun scripts/render.py with assets/template.docx.");
    archive.file("cv-creator/scripts/render.py", "print('render')", { unixPermissions: 0o755 });
    archive.file("cv-creator/references/schema.md", "# Input schema");
    archive.file("cv-creator/assets/template.docx", Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const bytes = await archive.generateAsync({ type: "uint8array", platform: "UNIX" });

    const parsed = await readOrganizationSkillArchive(bytes);

    expect(parsed.packageFiles).toEqual([
      "SKILL.md",
      "assets/template.docx",
      "references/schema.md",
      "scripts/render.py",
    ]);
    expect(parsed.resourceFiles.find((file) => file.path === "scripts/render.py")?.mode).toBe(0o755);
    expect(Buffer.from(parsed.resourceFiles.find((file) => file.path === "assets/template.docx")!.contentBase64, "base64")).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  });

  it("rejects traversal paths even when JSZip exposes a sanitized name", async () => {
    const archive = new JSZip();
    archive.file("SKILL.md", "---\nname: unsafe\ndescription: Unsafe\n---\n");
    archive.file("../outside.txt", "no");
    const bytes = await archive.generateAsync({ type: "uint8array" });

    await expect(readOrganizationSkillArchive(bytes)).rejects.toThrow("unsafe file path");
  });

  it("requires exactly one root or single-folder SKILL.md", async () => {
    const archive = new JSZip();
    archive.file("one/SKILL.md", "---\nname: one\ndescription: One\n---\n");
    archive.file("two/SKILL.md", "---\nname: two\ndescription: Two\n---\n");

    await expect(readOrganizationSkillArchive(await archive.generateAsync({ type: "uint8array" }))).rejects.toThrow("more than one SKILL.md");
  });

  it("retains the optional top-level directory for Agent Skills name validation", async () => {
    const root = await mkdtemp(join(tmpdir(), "berry-skill-directory-test-"));
    try {
      const archive = new JSZip();
      archive.file("package-name/SKILL.md", "---\nname: different-name\ndescription: Mismatch\n---\n");
      const archivePath = join(root, "mismatch.skill");
      await writeFile(archivePath, await archive.generateAsync({ type: "uint8array" }));

      await expect(extractOrganizationSkillArchive(archivePath, join(root, "entries"))).resolves.toMatchObject({
        rootDirectory: "package-name",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("extracts large resources to bounded temporary files instead of base64 payloads", async () => {
    const root = await mkdtemp(join(tmpdir(), "berry-skill-archive-test-"));
    try {
      const archive = new JSZip();
      const resource = Buffer.alloc(2 * 1024 * 1024, 0x5a);
      archive.file("branding/SKILL.md", "---\nname: branding\ndescription: Brand files\n---\n");
      archive.file("branding/assets/template.pptx", resource);
      const archivePath = join(root, "branding.skill");
      await writeFile(archivePath, await archive.generateAsync({ type: "uint8array" }));

      const staged = await extractOrganizationSkillArchive(archivePath, join(root, "entries"));

      expect(staged.resourceFiles).toHaveLength(1);
      expect(staged.resourceFiles[0]).not.toHaveProperty("contentBase64");
      expect(staged.resourceFiles[0]?.sizeBytes).toBe(resource.byteLength);
      expect(await readFile(staged.resourceFiles[0]!.absolutePath)).toEqual(resource);
      expect(staged.bytes).toBeGreaterThan(resource.byteLength);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
});
