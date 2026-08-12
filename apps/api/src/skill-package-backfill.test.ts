import { describe, expect, it } from "vitest";
import {
  legacyInputReferences,
  legacyInputSourcePath,
  legacyRelativePackageReferences,
  missingLegacyRelativePackageReferences,
  replaceLegacyInputPath,
  safeLegacyInputFileName,
  uniqueRecoveredPackagePath,
} from "./skill-package-backfill.js";

const fileId = "8c96a708-3ca5-4665-a902-d7ab635fbe14";

describe("legacy skill package backfill", () => {
  it("does not consume Markdown punctuation or following prose", () => {
    const content = [
      `- Template: /workspace/inputs/${fileId}/HR Memo Template.docx (preferred).`,
      `Use \`/workspace/inputs/${fileId}/HR Memo Template.docx\` when asked.`,
    ].join("\n");
    const [reference] = legacyInputReferences(content);
    expect(reference).toEqual({
      fileId,
      prefix: `/workspace/inputs/${fileId}/`,
    });
    const sourcePath = legacyInputSourcePath(reference!, "HR Memo Template.docx");
    const replaced = replaceLegacyInputPath(content, sourcePath, "assets/templates/HR Memo Template.docx");
    expect(replaced).toContain("assets/templates/HR Memo Template.docx (preferred).");
    expect(replaced).toContain("`assets/templates/HR Memo Template.docx` when asked.");
  });

  it("deduplicates repeated file references and mirrors staged filename safety", () => {
    const content = `${`/workspace/inputs/${fileId}/`}one\n${`/workspace/inputs/${fileId}/`}two`;
    expect(legacyInputReferences(content)).toHaveLength(1);
    expect(safeLegacyInputFileName(" ../../Project  Brief?.docx ")).toBe("Project Brief-.docx");
  });

  it("reports relative ancillary references whose bytes need a manual re-upload", () => {
    const content = [
      "Run `scripts/build-memo.ts`.",
      "Use [the template](assets/templates/AESG Memo.docx).",
      "Read references/style.md before writing.",
      "Do not flag /workspace/assets/transient.txt.",
    ].join("\n");
    expect(legacyRelativePackageReferences(content)).toEqual([
      "assets/templates/AESG Memo.docx",
      "references/style.md",
      "scripts/build-memo.ts",
    ]);
    expect(missingLegacyRelativePackageReferences(content, new Set([
      "references/style.md",
      "scripts/build-memo.ts",
    ]))).toEqual(["assets/templates/AESG Memo.docx"]);
  });

  it("keeps searching when both the preferred and first recovered path are occupied", () => {
    const occupied = new Set([
      "assets/templates/template.docx",
      `assets/templates/${fileId}-template.docx`,
    ]);
    expect(uniqueRecoveredPackagePath("assets/templates", "template.docx", fileId, occupied))
      .toBe(`assets/templates/${fileId}-2-template.docx`);
    expect(occupied).toContain(`assets/templates/${fileId}-2-template.docx`);
  });
});
