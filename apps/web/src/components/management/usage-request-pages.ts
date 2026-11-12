import * as React from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { BerryApiClient } from "@berry/api-client";
import type { UsageAnalyticsQuery } from "@berry/shared";
import { ManagementResourceScope } from "./management-context";

export function useUsageRequestPages(
  client: BerryApiClient | null,
  tenantId: string,
  scope: "personal" | "organization",
  query: UsageAnalyticsQuery,
  enabled = true,
) {
  const resourceScope = React.useContext(ManagementResourceScope);
  const pages = useInfiniteQuery({
    queryKey: ["usage-requests", resourceScope, tenantId, scope, query],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => {
      if (!client) throw new Error("Usage client is unavailable");
      const pageQuery = { ...query, ...(pageParam ? { cursor: pageParam } : {}) };
      return scope === "personal"
        ? client.myUsageRequests(tenantId, pageQuery, { signal })
        : client.usageRequests(tenantId, pageQuery, { signal });
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: Boolean(client) && enabled,
  });
  const items = React.useMemo(() => pages.data?.pages.flatMap((page) => page.items) ?? [], [pages.data]);
  return { pages, items };
}
