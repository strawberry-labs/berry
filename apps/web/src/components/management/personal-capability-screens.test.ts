import { BerryApiError } from "@berry/api-client";
import { describe, expect, it, vi } from "vitest";
import {
  loadPersonalSkillResource,
  loadSkillPackageForDownload,
  isManagedSkillDuplicate,
  skillControlHint,
  skillMarkdownBody,
  skillPackageTreeEntries,
} from "./personal-skills-screen";
import {
  personalMcpManualCredential,
  personalMcpNeedsManualCredential,
} from "./personal-mcp-screen";

describe("personal capability screens", () => {
  it("keeps personal skills available when organization capability metadata is forbidden", async () => {
    const client = {
      listPersonalSkills: vi.fn(async () => []),
      effectiveCapabilities: vi.fn(async () => {
        throw new BerryApiError("Forbidden", 403, null);
      }),
    };

    await expect(loadPersonalSkillResource(client, "tenant_1")).resolves.toEqual({
      personal: [],
      effective: [],
    });
  });

  it("surfaces non-permission failures", async () => {
    const client = {
      listPersonalSkills: vi.fn(async () => []),
      effectiveCapabilities: vi.fn(async () => {
        throw new BerryApiError("Unavailable", 503, null);
      }),
    };

    await expect(loadPersonalSkillResource(client, "tenant_1")).rejects.toMatchObject({ status: 503 });
  });

  it("downloads organization skills from their retained package", async () => {
    const resourceFiles = [{ path: "assets/template.docx", contentBase64: "ZG9jeA==" }];
    const client = {
      personalSkillPackage: vi.fn(),
      organizationSkillPackage: vi.fn(async () => ({
        content: "---\nname: memo\ndescription: Memo\n---\nUse the template.",
        resourceFiles,
      })),
    };

    await expect(loadSkillPackageForDownload(client as never, "tenant_1", {
      capabilityId: "memo",
      content: "cached markdown",
      provenance: "organization",
    })).resolves.toMatchObject({ resourceFiles });
    expect(client.organizationSkillPackage).toHaveBeenCalledWith("tenant_1", "memo");
    expect(client.personalSkillPackage).not.toHaveBeenCalled();
  });

  it("explains managed and offline skill controls", () => {
    expect(skillControlHint({ enabled: true, locked: true }, true)).toBe("Required by your organization");
    expect(skillControlHint({ enabled: false, locked: true }, true)).toBe("Disabled by your organization");
    expect(skillControlHint({ enabled: false, locked: false, personal: {} as never }, true)).toBe("Off");
    expect(skillControlHint({ enabled: false, locked: false }, false)).toBe("Connect to Berry to change this setting");
  });

  it("renders the skill body without exposing YAML frontmatter", () => {
    expect(skillMarkdownBody("---\nname: research\ndescription: Research\n---\n\n# Research\n\nUse sources.")).toBe("# Research\n\nUse sources.");
    expect(skillMarkdownBody("# Plain Markdown")).toBe("# Plain Markdown");
  });

  it("shows nested package folders and files instead of collapsing everything to SKILL.md", () => {
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
  });

  it("recognizes organization skills republished by the runtime catalog", () => {
    const effective = [{
      kind: "skill",
      capabilityId: "aesg-branding",
      name: "AESG branding",
      provenance: "organization",
    }] as never;
    expect(isManagedSkillDuplicate("aesg-branding", effective)).toBe(true);
    expect(isManagedSkillDuplicate("research", effective)).toBe(false);
  });

  it("only asks for and submits a manual credential for bearer authentication", () => {
    expect(personalMcpNeedsManualCredential("bearer")).toBe(true);
    expect(personalMcpNeedsManualCredential("oauth")).toBe(false);
    expect(personalMcpNeedsManualCredential("none")).toBe(false);
    expect(personalMcpManualCredential("bearer", "  token-value  ")).toBe("token-value");
    expect(personalMcpManualCredential("oauth", "stale-token")).toBeUndefined();
  });
});
