import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { BerryApiClient } from "@berry/api-client";
import type { OrgPermission, PersonalizationProfile, Task, Workspace } from "@berry/shared";
import type { WebConfig } from "@/lib/config";
import { managementQueryKeys } from "@/lib/management-query-keys";
export type ManagementScreenProps = {
  client: BerryApiClient | null;
  config: WebConfig;
  tenantId: string;
  userId: string | null;
  user: { id: string; email: string; name?: string | null; image?: string | null } | null;
  personalization: PersonalizationProfile;
  onPersonalizationChange: (profile: PersonalizationProfile) => void;
  permissions: OrgPermission[];
  tasks: Task[];
  workspaces: Workspace[];
  onArchiveTask: (task: Task, archived: boolean) => Promise<void>;
  onDeleteTask: (task: Task) => Promise<void>;
  onRestoreTask: (task: Task) => Promise<void>;
};
export function useResource<T>(
  key: string,
  loader: (signal?: AbortSignal) => Promise<T>,
  fallback: T,
) {
  const queryClient = useQueryClient();
  const query = useQuery<T, Error, T, ReturnType<typeof managementQueryKeys.resource>>({
    queryKey: managementQueryKeys.resource(key),
    queryFn: ({ signal }) => loader(signal),
  });
  return {
    data: query.data ?? fallback,
    loading: query.isPending || (query.isFetching && query.dataUpdatedAt === 0),
    error: query.error ? (query.error instanceof Error ? query.error.message : "Unable to load data") : null,
    retry: () => { void query.refetch(); },
    invalidate: () => {
      void queryClient.invalidateQueries({ queryKey: managementQueryKeys.resource(key) });
    },
    setData: (next: T | ((current: T) => T)) => {
      queryClient.setQueryData<T>(managementQueryKeys.resource(key), (current) => {
        const value = current ?? fallback;
        return typeof next === "function" ? (next as (current: T) => T)(value) : next;
      });
    },
  };
}
export function useLocalSetting(key: string, fallback: string) {
  const [value, setValue] = React.useState(fallback);
  React.useEffect(
    () => setValue(localStorage.getItem(key) ?? fallback),
    [key, fallback],
  );
  return [
    value,
    (next: string) => {
      setValue(next);
      localStorage.setItem(key, next);
    },
  ] as const;
}
