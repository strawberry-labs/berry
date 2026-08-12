import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { createBrowserSkillExport, readBrowserSkillImport } from "./skill-import";

const skill = "---\nname: release-notes\ndescription: Write release notes\n---\nBody";

describe("browser skill imports", () => {
  it("loads a SKILL.md file", async () => {
    const result = await readBrowserSkillImport(new File([skill], "SKILL.md", { type: "text/markdown" }));
    expect(result).toEqual({ content: skill, fileName: "SKILL.md", packageFiles: ["SKILL.md"], resourceFiles: [] });
  });

  it("loads one top-level skill directory and inventories resources", async () => {
    const zip = new JSZip();
    zip.file("release-notes/SKILL.md", skill);
    zip.file("release-notes/scripts/check.sh", "#!/bin/sh");
    zip.file("release-notes/references/style.md", "Concise.");
    const archive = await zip.generateAsync({ type: "arraybuffer" });
    const result = await readBrowserSkillImport(new File([archive], "release-notes.skill", { type: "application/zip" }));
    expect(result.content).toBe(skill);
    expect(result.packageFiles).toEqual(["SKILL.md", "references/style.md", "scripts/check.sh"]);
    expect(result.resourceFiles.map((file) => file.path)).toEqual(["references/style.md", "scripts/check.sh"]);
    expect(atob(result.resourceFiles[0]!.contentBase64)).toBe("Concise.");
  });

  it("rejects packages with more than one skill root", async () => {
    const zip = new JSZip();
    zip.file("one/SKILL.md", skill);
    zip.file("two/SKILL.md", skill);
    const archive = await zip.generateAsync({ type: "arraybuffer" });
    await expect(readBrowserSkillImport(new File([archive], "ambiguous.skill"))).rejects.toThrow("more than one SKILL.md");
  });

  it("exports a portable .skill archive that can be imported again", async () => {
    const exported = await createBrowserSkillExport("Release Notes / Weekly", skill);
    expect(exported.fileName).toBe("Release-Notes-Weekly.skill");

    const imported = await readBrowserSkillImport(new File([exported.blob], exported.fileName, {
      type: "application/zip",
    }));
    expect(imported).toEqual({
      content: skill,
      fileName: "Release-Notes-Weekly.skill",
      packageFiles: ["SKILL.md"],
      resourceFiles: [],
    });
  });

  it("exports and re-imports resource bytes", async () => {
    const exported = await createBrowserSkillExport("release-notes", skill, [{
      path: "scripts/check.sh",
      contentBase64: btoa("#!/bin/sh\necho ok\n"),
      mode: 0o755,
    }]);
    const imported = await readBrowserSkillImport(new File([exported.blob], exported.fileName));
    expect(imported.resourceFiles).toEqual([{
      path: "scripts/check.sh",
      contentBase64: btoa("#!/bin/sh\necho ok\n"),
      mode: 0o755,
    }]);
  });

  it("preserves the exact SKILL.md text and avoids hidden download names", async () => {
    const windowsSkill = skill.replaceAll("\n", "\r\n");
    const exported = await createBrowserSkillExport("...", windowsSkill);
    expect(exported.fileName).toBe("skill.skill");

    const archive = await JSZip.loadAsync(await exported.blob.arrayBuffer());
    await expect(archive.file("SKILL.md")?.async("string")).resolves.toBe(windowsSkill);
  });
});
