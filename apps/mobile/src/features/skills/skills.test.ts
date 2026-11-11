import { describe, expect, it, vi } from "vitest";
import { BerryApiError } from "@berry/api-client";
import type { EffectiveCapability, PersonalSkill } from "@berry/shared";
import {
  buildSkillRows,
  decodeSkillTextFile,
  filterSkillRows,
  isManagedSkillDuplicate,
  loadPersonalSkillResource,
  loadSkillPackageForDownload,
  safeSkillFileStem,
  skillAboutLabel,
  skillControlHint,
  skillDisplayName,
  skillMarkdownBody,
  skillPackagePaths,
  skillPackageTreeEntries,
  skillPolicyLabel,
  skillProviderLabel,
  tryInTaskPrompt,
  validateSkillImportFile,
} from "./skill-model";
import { createStoredZip, crc32 } from "./stored-zip";

const personal = (name: string, extra: Partial<PersonalSkill> = {}) => ({
  id: `p-${name}`, name, description: `${name} skill`, content: `# ${name}`, enabled: true, resources: [], packageBytes: 10, ...extra,
}) as PersonalSkill;

const organization = (name: string, extra: Partial<EffectiveCapability> = {}) => ({
  kind: "skill", capabilityId: name, name, enabled: true, locked: false, assignment: "default-on", provenance: "organization", reason: "default", contentHash: null, ...extra,
}) as EffectiveCapability;

describe("skills catalog (web parity)", () => {
  it("keeps personal skills when organization metadata is forbidden, and surfaces other failures", async () => {
    const forbidden = { listPersonalSkills: vi.fn(async () => []), effectiveCapabilities: vi.fn(async () => { throw new BerryApiError("Forbidden", 403, null); }) };
    await expect(loadPersonalSkillResource(forbidden, "tenant")).resolves.toEqual({ personal: [], effective: [] });
    const unavailable = { listPersonalSkills: vi.fn(async () => []), effectiveCapabilities: vi.fn(async () => { throw new BerryApiError("Unavailable", 503, null); }) };
    await expect(loadPersonalSkillResource(unavailable, "tenant")).rejects.toMatchObject({ status: 503 });
    const noTenant = { listPersonalSkills: vi.fn(async () => [personal("a")]), effectiveCapabilities: vi.fn() };
    await expect(loadPersonalSkillResource(noTenant, null)).resolves.toMatchObject({ effective: [] });
    expect(noTenant.effectiveCapabilities).not.toHaveBeenCalled();
  });

  it("downloads organization skills from their retained package", async () => {
    const resourceFiles = [{ path: "assets/template.docx", contentBase64: "ZG9jeA==" }];
    const client = { personalSkillPackage: vi.fn(), organizationSkillPackage: vi.fn(async () => ({ content: "Use the template.", resourceFiles })) };
    await expect(loadSkillPackageForDownload(client as never, "tenant", { capabilityId: "memo", content: "cached", provenance: "organization" })).resolves.toMatchObject({ resourceFiles });
    expect(client.organizationSkillPackage).toHaveBeenCalledWith("tenant", "memo");
    await expect(loadSkillPackageForDownload(client as never, "tenant", { capabilityId: "x", content: "body", provenance: "self-host-bootstrap" })).resolves.toEqual({ content: "body", resourceFiles: [] });
    await expect(loadSkillPackageForDownload(client as never, "tenant", { capabilityId: "x", content: null, provenance: "self-host-bootstrap" })).rejects.toThrow("no downloadable content");
  });

  it("merges organization, personal, and deployment skills without duplicates", () => {
    const rows = buildSkillRows(
      [personal("writer")],
      [organization("research", { description: "" }), organization("hidden", { kind: "mcp" })],
      [
        { id: "/skills/research/SKILL.md", name: "research", description: "Deployed research", enabled: true },
        { id: "/skills/writer/SKILL.md", name: "writer", description: "dup", enabled: true },
        { id: "deck", name: "$deck", description: "Slides", enabled: true, content: "abc" },
      ],
    );
    expect(rows.map((row) => [row.provenance, row.name])).toEqual([
      ["organization", "research"],
      ["personal", "writer"],
      ["self-host-bootstrap", "deck"],
    ]);
    expect(rows[0]?.description).toBe("Deployed research");
    expect(rows[2]).toMatchObject({ locked: true, reason: "deployment", packageBytes: 3 });
    expect(filterSkillRows(rows, "SLIDES").map((row) => row.name)).toEqual(["deck"]);
    expect(filterSkillRows(rows, "  ")).toHaveLength(3);
  });

  it("labels providers, policies, and controls", () => {
    expect(skillControlHint({ enabled: true, locked: true })).toBe("Required by your organization");
    expect(skillControlHint({ enabled: false, locked: true })).toBe("Disabled by your organization");
    expect(skillControlHint({ enabled: false, locked: false, personal: {} as never })).toBe("Off");
    expect(skillControlHint({ enabled: false, locked: false }, false)).toBe("Connect to Berry to change this setting");
    expect(skillDisplayName("research")).toBe("$research");
    expect(skillDisplayName("$research")).toBe("$research");
    expect(skillProviderLabel({ provenance: "self-host-bootstrap" })).toBe("Deployment");
    expect(skillPolicyLabel({ assignment: "default-on", reason: "default" })).toBe("default on");
    expect(skillPolicyLabel({ assignment: null, reason: "personal" })).toBe("personal");
    expect(skillAboutLabel({ assignment: null, reason: "user-enabled" })).toBe("user enabled skill");
    expect(tryInTaskPrompt({ capabilityId: "research" })).toBe("$research ");
  });

  it("recognizes organization skills republished by the runtime catalog", () => {
    const effective = [organization("AESG branding", { capabilityId: "aesg-branding" })];
    expect(isManagedSkillDuplicate("aesg-branding", effective)).toBe(true);
    expect(isManagedSkillDuplicate("research", effective)).toBe(false);
  });

  it("renders the body without frontmatter and lists nested package files", () => {
    expect(skillMarkdownBody("---\nname: research\ndescription: Research\n---\n\n# Research\n\nUse sources.")).toBe("# Research\n\nUse sources.");
    expect(skillMarkdownBody("# Plain Markdown")).toBe("# Plain Markdown");
    expect(skillPackageTreeEntries(["SKILL.md", "assets/templates/cv.docx", "scripts/render.py", "references/schema.md"])).toEqual([
      { kind: "file", name: "SKILL.md", path: "SKILL.md", depth: 0 },
      { kind: "folder", name: "assets", path: "assets", depth: 0 },
      { kind: "folder", name: "templates", path: "assets/templates", depth: 1 },
      { kind: "file", name: "cv.docx", path: "assets/templates/cv.docx", depth: 2 },
      { kind: "folder", name: "references", path: "references", depth: 0 },
      { kind: "file", name: "schema.md", path: "references/schema.md", depth: 1 },
      { kind: "folder", name: "scripts", path: "scripts", depth: 0 },
      { kind: "file", name: "render.py", path: "scripts/render.py", depth: 1 },
    ]);
    expect(skillPackagePaths(["SKILL.md", "a.md"], [{ path: "b.py" }, { path: "a.md" }])).toEqual(["SKILL.md", "a.md", "b.py"]);
  });

  it("decodes only UTF-8 text resources", () => {
    expect(decodeSkillTextFile({ path: "notes.md", contentBase64: btoa("hello") })).toBe("hello");
    expect(decodeSkillTextFile({ path: "image.png", contentBase64: btoa("hello") })).toBeNull();
    expect(decodeSkillTextFile({ path: "bad.txt", contentBase64: btoa(String.fromCharCode(0xff, 0xfe)) })).toBeNull();
  });

  it("validates import files and export names like the web", () => {
    expect(validateSkillImportFile("pkg.skill", 1024)).toBeNull();
    expect(validateSkillImportFile("SKILL.md", 300 * 1024)).toContain("256 KB");
    expect(validateSkillImportFile("notes.pdf", 10)).toBe("Choose a .skill, .zip, or SKILL.md file.");
    expect(validateSkillImportFile("huge.zip", 600 * 1024 * 1024)).toBe("Skill packages can be up to 500 MB.");
    expect(safeSkillFileStem(" Deep Research.skill ")).toBe("Deep-Research");
    expect(safeSkillFileStem("...")).toBe("skill");
  });
});

describe("stored zip export", () => {
  it("computes standard CRC-32", () => {
    expect(crc32(new TextEncoder().encode("hello"))).toBe(0x3610a686);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it("writes local headers, a central directory, and an end record", () => {
    const zip = createStoredZip([
      { path: "SKILL.md", bytes: new TextEncoder().encode("# Skill") },
      { path: "scripts/run.sh", bytes: new TextEncoder().encode("echo hi"), mode: 0o755 },
    ]);
    const view = new DataView(zip.buffer);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    const end = zip.length - 22;
    expect(view.getUint32(end, true)).toBe(0x06054b50);
    expect(view.getUint16(end + 10, true)).toBe(2);
    const centralOffset = view.getUint32(end + 16, true);
    expect(view.getUint32(centralOffset, true)).toBe(0x02014b50);
    expect(view.getUint32(centralOffset + 38, true) >>> 16).toBe(0o100644);
    const second = centralOffset + 46 + "SKILL.md".length;
    expect(view.getUint32(second + 38, true) >>> 16).toBe(0o100755);
    expect(view.getUint32(second + 42, true)).toBe(30 + "SKILL.md".length + "# Skill".length);
    expect(new TextDecoder().decode(zip.slice(30, 38))).toBe("SKILL.md");
    expect(() => createStoredZip([{ path: "../escape", bytes: new Uint8Array() }])).toThrow("unsafe");
  });
});
