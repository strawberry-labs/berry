import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PERSONAL_SKILL_PACKAGE_MAX_BYTES } from "@berry/shared";
import type { FilePlatformService } from "../files/file-platform.service.ts";
import type { PersonalCapabilitiesService } from "./personal-capabilities.service.ts";
import { extractOrganizationSkillArchive } from "./skill-package-archive.ts";

export async function installPersonalSkillArchive(files: FilePlatformService, capabilities: PersonalCapabilitiesService, tenantId: string, actorId: string, ownerId: string, fileId: string) {
  const root = await mkdtemp(join(tmpdir(), "berry-personal-skill-"));
  try {
    const archive = join(root, "package.skill");
    await files.downloadContentToFile(tenantId, actorId, fileId, PERSONAL_SKILL_PACKAGE_MAX_BYTES, archive);
    return await capabilities.saveStagedSkill(tenantId, ownerId, await extractOrganizationSkillArchive(archive, join(root, "entries")));
  } finally { await rm(root, { recursive: true, force: true }); }
}
