import { actionErrorMessage } from "@/lib/action-error";
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
  supportView?: boolean;
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
export const ManagementResourceScope = React.createContext("self");

export function useResource<T>(
  key: string,
  loader: (signal?: AbortSignal) => Promise<T>,
  fallback: T,
) {
  const queryClient = useQueryClient();
  const scope = React.useContext(ManagementResourceScope);
  const queryKey = [...managementQueryKeys.resource(key), scope] as const;
  const query = useQuery<T, Error>({
    queryKey,
    queryFn: ({ signal }) => loader(signal),
  });
  return {
    data: query.data ?? fallback,
    loading: query.isPending || (query.isFetching && query.dataUpdatedAt === 0),
    error: query.error ? actionErrorMessage(query.error, "Could not load this page. Please try again.") : null,
    retry: () => { void query.refetch(); },
    invalidate: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
    setData: (next: T | ((current: T) => T)) => {
      queryClient.setQueryData<T>(queryKey, (current) => {
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
