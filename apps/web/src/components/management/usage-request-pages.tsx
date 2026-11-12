import * as React from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { BerryApiClient } from "@berry/api-client";
import type { UsageAnalyticsQuery } from "@berry/shared";
import { ManagementResourceScope } from "./management-context";
import { Button } from "./management-primitives";

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

export function UsageRequestPager({
  hasMore, loading, error, onLoadMore,
}: {
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  onLoadMore: () => void;
}) {
  if (!hasMore) return null;
  return (
    <div className="flex items-center justify-center gap-2 border-t border-border p-2 text-xs text-muted-foreground" aria-live="polite">
      {error ? <span>{error}</span> : null}
      <Button size="sm" variant="ghost" onClick={onLoadMore} disabled={loading}>
        {loading ? "Loading more…" : error ? "Try again" : "Load more requests"}
      </Button>
    </div>
  );
}
