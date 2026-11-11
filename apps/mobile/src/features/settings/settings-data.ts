import * as React from "react";
import { AppState } from "react-native";
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import type { MemoryItem, MobileDeviceRegistration, PersonalizationProfile, Task, TaskPage } from "@berry/shared";
import { useSignedInSession } from "../../session/session";
import { mergeTasks, shellKeys, useOrganizationId } from "../data/shell-data";
import type { ArchiveState, ProfileFields } from "./settings-model";

/** Query keys for the settings screens, scoped per paired server like `shellKeys`. */
export const settingsKeys = {
  organizations: (server: string) => ["settings", server, "organizations"] as const,
  permissions: (server: string, tenantId: string) => ["settings", server, "permissions", tenantId] as const,
  devices: (server: string) => ["settings", server, "mobile-devices"] as const,
  personalization: (server: string) => ["settings", server, "personalization"] as const,
  memorySettings: (server: string) => ["settings", server, "memory", "settings"] as const,
  memories: (server: string) => ["settings", server, "memory", "items"] as const,
  usage: (server: string, tenantId: string, from: string, to: string) => ["settings", server, "usage", tenantId, from, to] as const,
  usageRequests: (server: string, tenantId: string, from: string, to: string) => ["settings", server, "usage-requests", tenantId, from, to] as const,
  archive: (server: string, filters: ArchiveFilters) => ["settings", server, "archive", filters.workspace, filters.state, filters.q] as const,
  archiveAll: (server: string) => ["settings", server, "archive"] as const,
  connectors: (server: string) => ["settings", server, "connectors"] as const,
  connectorRequests: (server: string) => ["settings", server, "connector-requests"] as const,
  mcpServers: (server: string) => ["settings", server, "mcp-servers"] as const,
};

/** The organization the shell works in (the web uses the first one too). */
export function useOrganization() {
  const { client, profile } = useSignedInSession();
  return useQuery({
    queryKey: settingsKeys.organizations(profile.serverUrl),
    queryFn: async () => (await client.listOrganizations())[0] ?? null,
    staleTime: 5 * 60_000,
  });
}

/** `permissions/me`, which decides who sees the admin console on the web. */
export function useEffectivePermissions() {
  const { client, profile } = useSignedInSession();
  const tenantId = useOrganizationId();
  return useQuery({
    queryKey: settingsKeys.permissions(profile.serverUrl, tenantId ?? "none"),
    queryFn: () => client.effectivePermissions(tenantId!),
    enabled: Boolean(tenantId),
    staleTime: 60_000,
  });
}

// Mobile devices -----------------------------------------------------------------

export function useMobileDevices() {
  const { client, profile } = useSignedInSession();
  return useQuery({
    queryKey: settingsKeys.devices(profile.serverUrl),
    queryFn: () => client.listPairedMobileDevices(),
    staleTime: 30_000,
  });
}

export function useRevokeDevice() {
  const { client, profile } = useSignedInSession();
  const queryClient = useQueryClient();
  const key = settingsKeys.devices(profile.serverUrl);
  return useMutation({
    mutationFn: async (device: MobileDeviceRegistration) => client.revokePairedMobileDevice(device.deviceId),
    onSuccess: (_result, device) => {
      queryClient.setQueryData<MobileDeviceRegistration[]>(key, (devices) => devices?.filter((item) => item.deviceId !== device.deviceId));
    },
  });
}

// Personalization ----------------------------------------------------------------

export function usePersonalizationProfile() {
  const { client, profile } = useSignedInSession();
  return useQuery({
    queryKey: settingsKeys.personalization(profile.serverUrl),
    queryFn: () => client.personalizationProfile(),
  });
}

export function useSavePersonalization() {
  const { client, profile } = useSignedInSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ProfileFields) => client.updatePersonalizationProfile(input),
    onSuccess: (next) => queryClient.setQueryData<PersonalizationProfile>(settingsKeys.personalization(profile.serverUrl), next),
  });
}

// Memory ----------------------------------------------------------------------

type MemoryPage = { items: MemoryItem[]; nextCursor: string | null };

export function useMemorySettings() {
  const { client, profile } = useSignedInSession();
  return useQuery({
    queryKey: settingsKeys.memorySettings(profile.serverUrl),
    queryFn: () => client.memorySettings(),
  });
}

export function useUpdateMemorySettings() {
  const { client, profile } = useSignedInSession();
  const queryClient = useQueryClient();
  const key = settingsKeys.memorySettings(profile.serverUrl);
  return useMutation({
    mutationFn: (patch: { memoryEnabled?: boolean; implicitMemoryEnabled?: boolean }) => client.updateMemorySettings(patch),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<{ memoryEnabled: boolean; implicitMemoryEnabled: boolean }>(key);
      if (previous) queryClient.setQueryData(key, { ...previous, ...patch });
      return { previous };
    },
    onError: (_error, _patch, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
    },
    onSuccess: (settings) => queryClient.setQueryData(key, settings),
  });
}

export function useMemories() {
  const { client, profile } = useSignedInSession();
  return useInfiniteQuery({
    queryKey: settingsKeys.memories(profile.serverUrl),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }): Promise<MemoryPage> => client.listMemories({ scope: "personal", status: "active", limit: 50, ...(pageParam ? { cursor: pageParam } : {}) }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

/** Rewrites the cached memory pages after a mutation, like the web's local list updates. */
function useMemoryCache() {
  const { profile } = useSignedInSession();
  const queryClient = useQueryClient();
  const key = settingsKeys.memories(profile.serverUrl);
  return React.useCallback((update: (items: MemoryItem[], pageIndex: number) => MemoryItem[]) => {
    queryClient.setQueryData<InfiniteData<MemoryPage, string | undefined>>(key, (data) => data
      ? { ...data, pages: data.pages.map((page, index) => ({ ...page, items: update(page.items, index) })) }
      : data);
  }, [key, queryClient]);
}

export type MemoryDraft = { id: string | null; kind: string; content: string; expiresAt: string | null };

export function useSaveMemory() {
  const { client, profile } = useSignedInSession();
  const queryClient = useQueryClient();
  const updateCache = useMemoryCache();
  return useMutation({
    mutationFn: async (draft: MemoryDraft) => {
      const result = draft.id
        ? await client.updateMemory(draft.id, { content: draft.content, kind: draft.kind, expiresAt: draft.expiresAt })
        : await client.rememberMemory({ scope: "personal", kind: draft.kind, content: draft.content, expiresAt: draft.expiresAt });
      return result.item;
    },
    onSuccess: (item, draft) => {
      // A NOOP consolidation returns no item; reload to show the server's view.
      if (!item) return queryClient.invalidateQueries({ queryKey: settingsKeys.memories(profile.serverUrl) });
      // The saved entry moves to the top; a superseded one disappears.
      updateCache((items, pageIndex) => {
        const rest = items.filter((existing) => existing.id !== item.id && existing.id !== draft.id);
        return pageIndex === 0 ? [item, ...rest] : rest;
      });
    },
  });
}

export function useForgetMemory() {
  const { client } = useSignedInSession();
  const updateCache = useMemoryCache();
  return useMutation({
    mutationFn: (memory: MemoryItem) => client.forgetMemory(memory.id),
    onSuccess: (_result, memory) => updateCache((items) => items.filter((item) => item.id !== memory.id)),
  });
}

export function useClearMemories() {
  const { client, profile } = useSignedInSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => client.clearMemories({ scope: "personal" }),
    onSuccess: () => {
      queryClient.setQueryData<InfiniteData<MemoryPage, string | undefined>>(settingsKeys.memories(profile.serverUrl), (data) => data
        ? { pages: [{ items: [], nextCursor: null }], pageParams: [undefined] }
        : data);
    },
  });
}

// Usage -----------------------------------------------------------------------

export function useMyUsage(tenantId: string | null, range: { from: string; to: string }) {
  const { client, profile } = useSignedInSession();
  return useQuery({
    queryKey: settingsKeys.usage(profile.serverUrl, tenantId ?? "none", range.from, range.to),
    queryFn: () => client.myUsage(tenantId!, { ...range, limit: 50 }),
    enabled: Boolean(tenantId),
    staleTime: 30_000,
    // Keep the last period on screen while the next one loads.
    placeholderData: keepPreviousData,
  });
}

export function useMyUsageRequests(tenantId: string | null, range: { from: string; to: string }) {
  const { client, profile } = useSignedInSession();
  return useInfiniteQuery({
    queryKey: settingsKeys.usageRequests(profile.serverUrl, tenantId ?? "none", range.from, range.to),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => client.myUsageRequests(tenantId!, { ...range, limit: 50, ...(pageParam ? { cursor: pageParam } : {}) }),
    getNextPageParam: (last) => (last.hasMore ? last.nextCursor ?? undefined : undefined),
    enabled: Boolean(tenantId),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}

// Archived tasks ----------------------------------------------------------------

export type ArchiveFilters = { q: string; workspace: string; state: ArchiveState };

export function useArchivedTasks(filters: ArchiveFilters) {
  const { client, profile } = useSignedInSession();
  return useInfiniteQuery({
    queryKey: settingsKeys.archive(profile.serverUrl, filters),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }): Promise<TaskPage> => client.listArchivedTasksPage({
      workspaceId: filters.workspace === "all" ? undefined : filters.workspace,
      search: filters.q || undefined,
      state: filters.state,
      cursor: pageParam,
      limit: 50,
    }, { signal }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 15_000,
  });
}

export type ArchiveAction = "unarchive" | "delete" | "restore";

/** Unarchive, delete, or restore one task, keeping the sidebar's task cache in step. */
export function useArchiveTaskAction() {
  const { client, profile } = useSignedInSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ task, action }: { task: Task; action: ArchiveAction }): Promise<Task> => {
      if (action === "unarchive") return client.updateTask(task.id, { archived: false });
      if (action === "delete") return client.deleteTask(task.id);
      return client.restoreTask(task.id);
    },
    onSuccess: (updated) => mergeTasks(queryClient, profile.serverUrl, [updated]),
    onSettled: () => queryClient.invalidateQueries({ queryKey: settingsKeys.archiveAll(profile.serverUrl) }),
  });
}

export function useDeleteAllArchived() {
  const { client, profile } = useSignedInSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (filters: ArchiveFilters) => client.deleteAllArchivedTasks({
      ...(filters.workspace !== "all" ? { workspaceId: filters.workspace } : {}),
      ...(filters.q ? { search: filters.q } : {}),
    }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: settingsKeys.archiveAll(profile.serverUrl) });
      void queryClient.invalidateQueries({ queryKey: shellKeys.tasks(profile.serverUrl) });
    },
  });
}

// Connectors and MCP ------------------------------------------------------------

export function useConnectors() {
  const { client, profile } = useSignedInSession();
  return useQuery({ queryKey: settingsKeys.connectors(profile.serverUrl), queryFn: () => client.listConnectors() });
}

export function useConnectorRequests() {
  const { client, profile } = useSignedInSession();
  return useQuery({ queryKey: settingsKeys.connectorRequests(profile.serverUrl), queryFn: () => client.listConnectorRequests() });
}

export function usePersonalMcpServers() {
  const { client, profile } = useSignedInSession();
  return useQuery({ queryKey: settingsKeys.mcpServers(profile.serverUrl), queryFn: () => client.listPersonalMcpServers() });
}

/** Refreshes connector state; tools changes also refresh the composer's model catalog (skills, MCP). */
export function useRefreshConnections() {
  const { profile } = useSignedInSession();
  const queryClient = useQueryClient();
  return React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: settingsKeys.connectors(profile.serverUrl) });
    void queryClient.invalidateQueries({ queryKey: settingsKeys.connectorRequests(profile.serverUrl) });
    void queryClient.invalidateQueries({ queryKey: settingsKeys.mcpServers(profile.serverUrl) });
    void queryClient.invalidateQueries({ queryKey: shellKeys.modelCatalog(profile.serverUrl) });
  }, [profile.serverUrl, queryClient]);
}

/**
 * OAuth finishes in the browser, so refresh when the app comes back to the
 * foreground (Android's custom tab returns before the person finishes).
 */
export function useRefreshOnForeground(refresh: () => void, enabled = true) {
  React.useEffect(() => {
    if (!enabled) return;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });
    return () => subscription.remove();
  }, [enabled, refresh]);
}

/** Polls while an MCP approval is pending, as the web does every 15 s. */
export function usePollWhile(active: boolean, refresh: () => void, intervalMs = 15_000) {
  React.useEffect(() => {
    if (!active) return;
    const timer = setInterval(refresh, intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs, refresh]);
}
