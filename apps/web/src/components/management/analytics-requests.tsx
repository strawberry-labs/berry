import type { BerryApiClient } from "@berry/api-client";
import type { UsageAnalyticsQuery } from "@berry/shared";
import { AsyncState, CellStack, DataTable, Num, StatusPill, formatDateTime, formatDuration } from "./management-primitives";
import { formatUsageLabel as label } from "./usage-controls";
import { UsageRequestPager, useUsageRequestPages } from "./usage-request-pages";

export function AnalyticsRequests({
  client, tenantId, query, onSelect,
}: {
  client: BerryApiClient | null;
  tenantId: string;
  query: UsageAnalyticsQuery;
  onSelect: (id: string) => void;
}) {
  const { pages: requests, items: requestItems } = useUsageRequestPages(client, tenantId, "organization", query);
  return (
    <AsyncState
      loading={requests.isLoading}
      error={requests.error && !requests.isFetchNextPageError ? "Requests could not be loaded." : null}
      onRetry={() => void requests.refetch()}
      empty={!requestItems.length}
      emptyTitle="No requests match"
      emptyText="Request records hold metadata only. Prompts and responses are never stored here."
    >
      <DataTable
        label="Requests"
        initialPageSize={25}
        columns={[
          "Time",
          "Member",
          "Model",
          "Feature",
          "Status",
          "Input",
          "Output",
          "Cache read",
          "Billed",
          "Latency",
        ]}
        onRowSelect={(index) => {
          const row = requestItems[index];
          if (row) onSelect(row.id);
        }}
        rowLabel={(index) => `Request ${requestItems[index]?.requestId ?? ""}`}
        rows={requestItems.map((row) => [
          <span data-sort={new Date(row.ts).getTime()} className="whitespace-nowrap text-muted-foreground">{formatDateTime(row.ts)}</span>,
          <CellStack
            primary={row.userName || row.userEmail || "Unattributed"}
            secondary={row.departmentName ?? undefined}
          />,
          <CellStack primary={row.model ?? "Unknown model"} secondary={row.provider ?? undefined} />,
          label(String(row.feature ?? "—")),
          <StatusPill tone={["completed", "success", "succeeded"].includes(row.status) ? "good" : "danger"}>
            {label(String(row.status))}
          </StatusPill>,
          <Num value={row.tokensIn} />,
          <Num value={row.tokensOut} />,
          <Num value={row.cacheReadTokens} />,
          <Num value={row.billedCostMicros} kind="money" />,
          <span data-sort={Number(row.latencyMs ?? 0)}>{formatDuration(row.latencyMs)}</span>,
        ])}
      />
      <UsageRequestPager
        hasMore={requests.hasNextPage}
        loading={requests.isFetchingNextPage}
        error={requests.isFetchNextPageError ? "Older requests could not be loaded." : null}
        onLoadMore={() => void requests.fetchNextPage({ cancelRefetch: false })}
      />
    </AsyncState>
  );
}
