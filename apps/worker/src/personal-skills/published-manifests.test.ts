import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SKILL_DEPENDENCY_MANIFEST_PATH, parseSkillDependencyManifest } from "./dependencies.js";

const skillsRoot = fileURLToPath(new URL("../../../../deploy/skills/", import.meta.url));
const managedSkills = ["aesg-branding", "cv-creator", "docx", "pdf", "pptx", "skill-creator", "xlsx"];

describe("AESG skill dependency manifests", () => {
  it("name only entry points and resources the published packages contain", () => {
    const declared: string[] = [];
    for (const skill of managedSkills) {
      const manifestPath = `${skillsRoot}${skill}/${SKILL_DEPENDENCY_MANIFEST_PATH}`;
      if (!existsSync(manifestPath)) continue;
      const manifest = parseSkillDependencyManifest(readFileSync(manifestPath));
      for (const [entryPoint, { requires }] of Object.entries(manifest.entryPoints)) {
        declared.push(`${skill}/${entryPoint}`);
        expect(existsSync(`${skillsRoot}${skill}/${entryPoint}`), `${skill}/${entryPoint}`).toBe(true);
        for (const requirement of requires) {
          const owner = requirement.skill ?? skill;
          expect(managedSkills, `${skill}/${entryPoint} needs ${owner}`).toContain(owner);
          for (const resource of requirement.resources) {
            expect(existsSync(`${skillsRoot}${owner}/${resource}`), `${owner}/${resource}`).toBe(true);
          }
        }
      }
    }
    expect(declared.sort()).toEqual([
      "docx/scripts/create_aesg_docx.py",
      "docx/scripts/repair_aesg_docx.py",
      "pdf/scripts/create_aesg_pdf.py",
      "pptx/scripts/create_aesg_pptx.py",
      "xlsx/scripts/create_aesg_xlsx.py",
    ]);
  });
});
