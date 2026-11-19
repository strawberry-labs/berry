import * as React from "react";
import { File } from "expo-file-system";
import { userCacheDirectory } from "../../storage/user-files";
import * as Sharing from "expo-sharing";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { BerryApiClient } from "@berry/api-client";
import type { PersonalSkill } from "@berry/shared";
import { useSignedInSession } from "../../session/session";
import type { PickedFile } from "../composer/attachments";
import { shellKeys } from "../data/shell-data";
import {
  base64ToBytes,
  buildSkillRows,
  loadPersonalSkillResource,
  loadSkillPackageForDownload,
  safeSkillFileStem,
  type SkillCatalogRow,
  type SkillResource,
} from "./skill-model";
import { createStoredZip } from "./stored-zip";

export const skillKeys = {
  all: (server: string) => ["skills", server] as const,
  resource: (server: string, tenantId: string | null) => ["skills", server, "resource", tenantId ?? "none"] as const,
};

/** Same key and loader as the sidebar's useOrganizationId, but exposing load state. */
function useOrganizationQuery() {
  const { client, profile } = useSignedInSession();
  return useQuery({
    queryKey: shellKeys.organization(profile.serverUrl),
    queryFn: async () => (await client.listOrganizations())[0]?.id ?? null,
    staleTime: 5 * 60_000,
  });
}

/**
 * The web's skill catalog: personal skills, organization capabilities, and
 * the deployment's own skills from the model catalog (the web reads those
 * from its config; the API republishes them in /v1/models/catalog).
 */
export function useSkillCatalog() {
  const { client, profile } = useSignedInSession();
  const organization = useOrganizationQuery();
  const tenantId = organization.data ?? null;
  const resource = useQuery({
    queryKey: skillKeys.resource(profile.serverUrl, tenantId),
    queryFn: () => loadPersonalSkillResource(client, tenantId),
    enabled: !organization.isPending,
  });
  const catalog = useQuery({ queryKey: shellKeys.modelCatalog(profile.serverUrl), queryFn: () => client.modelCatalog(), staleTime: 60_000 });
  const rows = React.useMemo(
    () => buildSkillRows(resource.data?.personal ?? [], resource.data?.effective ?? [], catalog.data?.skills ?? []),
    [catalog.data, resource.data],
  );
  const refetch = React.useCallback(async () => {
    await Promise.all([organization.refetch(), resource.refetch(), catalog.refetch()]);
  }, [catalog, organization, resource]);
  return {
    tenantId,
    rows,
    loading: organization.isPending || resource.isPending,
    error: resource.error,
    refetch,
  };
}

export type SkillAction =
  | { kind: "toggle"; skill: SkillCatalogRow; enabled: boolean }
  | { kind: "uninstall"; skill: PersonalSkill };

/** Enable, disable, and uninstall, applied to the cached catalog right away and reconciled after. */
export function useSkillActions(tenantId: string | null) {
  const { client, profile } = useSignedInSession();
  const queryClient = useQueryClient();
  const key = skillKeys.resource(profile.serverUrl, tenantId);
  return useMutation({
    mutationFn: async (action: SkillAction): Promise<unknown> => {
      if (action.kind === "uninstall") return client.deletePersonalSkill(action.skill.id);
      if (action.skill.personal) return client.updatePersonalSkill(action.skill.personal.id, { enabled: action.enabled });
      if (!tenantId) throw new Error("Organization skills can't be changed right now. Try again in a moment.");
      return client.setCapabilityOverride(tenantId, "skill", action.skill.capabilityId, action.enabled);
    },
    onMutate: async (action) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<SkillResource>(key);
      queryClient.setQueryData<SkillResource>(key, (data) => {
        if (!data) return data;
        if (action.kind === "uninstall") return { ...data, personal: data.personal.filter((skill) => skill.id !== action.skill.id) };
        if (action.skill.personal) {
          return { ...data, personal: data.personal.map((skill) => skill.id === action.skill.personal!.id ? { ...skill, enabled: action.enabled } : skill) };
        }
        return { ...data, effective: data.effective.map((item) => item.kind === "skill" && item.capabilityId === action.skill.capabilityId ? { ...item, enabled: action.enabled } : item) };
      });
      return { previous };
    },
    onError: (_error, _action, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: key });
      // The composer's $skill menu comes from the model catalog.
      void queryClient.invalidateQueries({ queryKey: shellKeys.modelCatalog(profile.serverUrl) });
    },
  });
}

export function useRefreshSkills() {
  const { profile } = useSignedInSession();
  const queryClient = useQueryClient();
  return React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: skillKeys.all(profile.serverUrl) });
    void queryClient.invalidateQueries({ queryKey: shellKeys.modelCatalog(profile.serverUrl) });
  }, [profile.serverUrl, queryClient]);
}

/** Uploads a skill package as a reference file, like the web import dialog. */
export async function uploadSkillPackage(
  client: BerryApiClient,
  file: PickedFile,
  options: { signal: AbortSignal; onProgress: (ratio: number) => void },
) {
  const blob = await (await fetch(file.uri)).blob();
  const fileLike = { name: file.name, type: file.mediaType, size: blob.size, slice: (start?: number, end?: number) => blob.slice(start, end) } as unknown as globalThis.File;
  return client.uploadFile(fileLike, { origin: "user_upload", associationRole: "reference", signal: options.signal, onProgress: ({ ratio }) => options.onProgress(ratio) });
}

export async function readLocalText(uri: string): Promise<string> {
  return new File(uri).text();
}

/** "Download .skill": builds the portable package and hands it to the share sheet. */
export async function shareSkillPackage(
  client: BerryApiClient,
  tenantId: string | null,
  skill: SkillCatalogRow,
): Promise<void> {
  const skillPackage = await loadSkillPackageForDownload(client, tenantId, skill);
  const archive = createStoredZip([
    { path: "SKILL.md", bytes: new TextEncoder().encode(skillPackage.content) },
    ...skillPackage.resourceFiles.map((file) => ({ path: file.path, bytes: base64ToBytes(file.contentBase64), mode: file.mode })),
  ]);
  const folder = userCacheDirectory("skills");
  if (folder.exists) folder.delete();
  folder.create({ intermediates: true, idempotent: true });
  const output = new File(folder, `${safeSkillFileStem(skill.name)}.skill`);
  output.create({ overwrite: true });
  output.write(archive);
  if (!(await Sharing.isAvailableAsync())) throw new Error("Sharing isn't available on this device.");
  await Sharing.shareAsync(output.uri, { mimeType: "application/zip", UTI: "public.zip-archive", dialogTitle: `${skill.name}.skill` });
}
