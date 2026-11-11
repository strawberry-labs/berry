import * as React from "react";
import { StyleSheet, View } from "react-native";
import type { UsageRequestSummary } from "@berry/shared";
import { apiErrorMessage } from "../../api/client";
import { useSignedInSession } from "../../session/session";
import { Button } from "../../ui/button";
import { ArrowDownIcon, ArrowUp, DollarSign, FileDown, GaugeIcon, LayoutList, Server } from "../../ui/icons";
import { Spinner, StatusPill } from "../../ui/primitives";
import { Section } from "../../ui/screen";
import { Text } from "../../ui/text";
import { useOrganizationId } from "../data/shell-data";
import { useMyUsage, useMyUsageRequests } from "./settings-data";
import {
  USAGE_RANGES,
  cacheSummary,
  compactNumber,
  formatDateTime,
  formatMoney,
  formatNumber,
  requestTone,
  usageRange,
  usageRangeLabel,
  type UsageRangeKey,
} from "./settings-model";
import { datedFileName, shareTextFile } from "./share-file";
import { AsyncContent, InlineMessage, ListRow, SectionBody, SelectField, SettingsPage } from "./settings-ui";
import { MetricGrid, MetricTile, OutcomeBars, ShareBars, TrendBars } from "./usage-charts";

/** Settings › Usage: the web's PersonalUsageScreen laid out for a phone. */
export function UsageTab() {
  const { client } = useSignedInSession();
  const tenantId = useOrganizationId();
  const [rangeKey, setRangeKey] = React.useState<UsageRangeKey>("1mo");
  const [anchor, setAnchor] = React.useState(() => Date.now());
  const range = React.useMemo(() => usageRange(rangeKey, anchor), [anchor, rangeKey]);
  const analytics = useMyUsage(tenantId, range);
  const requests = useMyUsageRequests(tenantId, range);
  const [exporting, setExporting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pulling, setPulling] = React.useState(false);
  const fetching = analytics.isFetching || requests.isFetching;
  React.useEffect(() => {
    if (!fetching) setPulling(false);
  }, [fetching]);

  const data = analytics.data;
  const cache = data ? cacheSummary(data.performance) : null;
  const models = data?.breakdowns.models ?? [];
  const logs = React.useMemo(() => requests.data?.pages.flatMap((page) => page.items) ?? [], [requests.data]);

  const refresh = () => {
    // Moving the anchor to now re-runs both queries for the latest window.
    setPulling(true);
    setAnchor(Date.now());
  };

  const exportCsv = async () => {
    if (!tenantId) return;
    setExporting(true);
    setError(null);
    try {
      const csv = await client.exportMyUsageCsv(tenantId, range);
      await shareTextFile(datedFileName("berry-usage", "csv"), csv, "text/csv");
    } catch (cause) {
      setError(apiErrorMessage(cause, "Could not export usage. Try again."));
    } finally {
      setExporting(false);
    }
  };

  return (
    <SettingsPage
      title="Usage"
      description="Understand your model activity, token consumption, and billed usage for any period."
      refreshing={pulling}
      onRefresh={refresh}
    >
      <View style={styles.toolbar}>
        <View style={{ flex: 1 }}>
          <SelectField label="Period" value={rangeKey} options={USAGE_RANGES} onChange={(value) => { setRangeKey(value); setAnchor(Date.now()); }} compact />
        </View>
        {fetching && !pulling && data ? <Spinner /> : null}
        <Button variant="secondary" size="sm" icon={FileDown} label="Export CSV" loading={exporting} disabled={!tenantId} onPress={() => void exportCsv()} />
      </View>
      {error ? <InlineMessage tone="danger" onDismiss={() => setError(null)}>{error}</InlineMessage> : null}

      <AsyncContent
        loading={!tenantId || analytics.isPending}
        error={analytics.isError ? apiErrorMessage(analytics.error, "Could not load usage. Try again.") : null}
        onRetry={() => void analytics.refetch()}
        rows={6}
      >
        {data && cache ? (
          <>
            <MetricGrid>
              <MetricTile label="Billed usage" value={formatMoney(data.totals.billedCostMicros)} icon={DollarSign} />
              <MetricTile label="Requests" value={compactNumber(data.totals.requests)} hint={formatNumber(data.totals.requests)} icon={LayoutList} />
              <MetricTile label="Cache hit rate" value={cache.hitRate === null ? "—" : `${Math.round(cache.hitRate * 100)}%`} hint={`${cache.hits} hits · ${cache.misses} misses`} icon={GaugeIcon} />
              <MetricTile label="Cache-read tokens" value={compactNumber(data.performance.cacheReadTokens)} hint={formatNumber(data.performance.cacheReadTokens)} icon={Server} />
              <MetricTile label="Input tokens" value={compactNumber(data.totals.inputTokens)} hint={formatNumber(data.totals.inputTokens)} icon={ArrowDownIcon} />
              <MetricTile label="Output tokens" value={compactNumber(data.totals.outputTokens)} hint={formatNumber(data.totals.outputTokens)} icon={ArrowUp} />
            </MetricGrid>

            <Section title="Usage over time" description={usageRangeLabel(rangeKey)}>
              <SectionBody>
                {data.series.length ? (
                  <TrendBars
                    values={data.series.map((point) => Number(point.billedCostMicros))}
                    accessibilityLabel={`Billed usage over ${usageRangeLabel(rangeKey).toLowerCase()}: ${formatMoney(data.totals.billedCostMicros)} across ${formatNumber(data.totals.requests)} requests`}
                  />
                ) : <Text variant="secondary" tone="tertiary">No usage in this period.</Text>}
              </SectionBody>
            </Section>

            <Section title="Request outcomes">
              <SectionBody>
                {data.series.length ? <OutcomeBars points={data.series} /> : <Text variant="secondary" tone="tertiary">No requests in this period.</Text>}
              </SectionBody>
            </Section>

            <Section title="Model spend distribution">
              <SectionBody>
                <ShareBars rows={models.map((model) => ({ label: model.label, value: Number(model.billedCostMicros) }))} format={formatMoney} />
              </SectionBody>
            </Section>

            <Section title="Models">
              {models.length ? models.map((model, index) => (
                <ListRow key={`${model.id ?? model.label}:${index}`} last={index === models.length - 1}>
                  <View style={styles.rowBody}>
                    <Text variant="body" weight="medium" numberOfLines={1}>{model.label}</Text>
                    <Text variant="meta" tone="tertiary" style={styles.numeric}>
                      {formatNumber(model.requests)} requests · in {compactNumber(model.inputTokens)} · out {compactNumber(model.outputTokens)} · cache {compactNumber(model.cacheReadTokens)}
                    </Text>
                  </View>
                  <Text variant="secondary" weight="medium" style={styles.numeric}>{formatMoney(model.billedCostMicros)}</Text>
                </ListRow>
              )) : <SectionBody><Text variant="secondary" tone="tertiary">No model usage in this period.</Text></SectionBody>}
            </Section>
          </>
        ) : null}
      </AsyncContent>

      <Section title="Logs" description="Request-level usage for the selected period.">
        <AsyncContent
          loading={!tenantId || requests.isPending}
          error={requests.isError ? apiErrorMessage(requests.error, "Could not load request logs.") : null}
          onRetry={() => void requests.refetch()}
        >
          {logs.length ? logs.map((request, index) => <RequestRow key={request.id} request={request} last={index === logs.length - 1 && !requests.hasNextPage} />) : (
            <SectionBody><Text variant="secondary" tone="tertiary">No request logs are available for this period.</Text></SectionBody>
          )}
          {requests.hasNextPage ? (
            <SectionBody>
              <Button variant="outline" size="sm" label={requests.isFetchingNextPage ? "Loading…" : "Load more"} disabled={requests.isFetchingNextPage} onPress={() => void requests.fetchNextPage()} />
            </SectionBody>
          ) : null}
        </AsyncContent>
      </Section>
    </SettingsPage>
  );
}

function RequestRow({ request, last }: { request: UsageRequestSummary; last: boolean }) {
  return (
    <ListRow last={last} style={styles.requestRow}>
      <View style={styles.rowBody}>
        <View style={styles.requestTitle}>
          <Text variant="secondary" weight="medium" numberOfLines={1} style={{ flexShrink: 1 }}>{request.model ?? request.provider ?? "—"}</Text>
          <StatusPill tone={requestTone(request.status)}>{request.finishReason ?? request.status}</StatusPill>
        </View>
        <Text variant="meta" tone="tertiary" style={styles.numeric}>
          {formatDateTime(request.ts)} · in {formatNumber(request.tokensIn)} · out {formatNumber(request.tokensOut)}
          {request.cacheReadTokens ? ` · cache read ${formatNumber(request.cacheReadTokens)}` : ""}
          {request.cacheWriteTokens ? ` · cache write ${formatNumber(request.cacheWriteTokens)}` : ""}
        </Text>
      </View>
      <Text variant="secondary" style={styles.numeric}>{formatMoney(request.billedCostMicros)}</Text>
    </ListRow>
  );
}

const styles = StyleSheet.create({
  toolbar: { flexDirection: "row", alignItems: "center", gap: 8 },
  rowBody: { flex: 1, minWidth: 0, gap: 3 },
  requestRow: { minHeight: 60 },
  requestTitle: { flexDirection: "row", alignItems: "center", gap: 8 },
  numeric: { fontVariant: ["tabular-nums"] },
});

