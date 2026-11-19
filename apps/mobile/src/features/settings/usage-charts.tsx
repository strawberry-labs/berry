import * as React from "react";
import { StyleSheet, View } from "react-native";
import { useTheme } from "../../theme/theme";
import type { Icon } from "../../ui/icons";
import { Text } from "../../ui/text";
import { relativeHeights } from "./settings-model";

/** One metric card from the web's compact MetricGrid. */
export function MetricTile({ label, value, hint, icon: IconComponent }: { label: string; value: string; hint?: string | undefined; icon: Icon }) {
  const { colors, layout } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={`${label}: ${value}${hint ? `, ${hint}` : ""}`}
      style={[styles.tile, { borderColor: colors.border, backgroundColor: colors.surfaceUnder, borderRadius: layout.radius + 2 }]}
    >
      <View style={styles.tileHeader}>
        <Text variant="meta" tone="tertiary" numberOfLines={1} style={{ flex: 1 }}>{label}</Text>
        <IconComponent size={14} color={colors.textTertiary} />
      </View>
      <Text variant="pageTitle" weight="medium" numberOfLines={1} adjustsFontSizeToFit style={styles.numeric}>{value}</Text>
      {hint ? <Text variant="meta" tone="tertiary" numberOfLines={1}>{hint}</Text> : null}
    </View>
  );
}

export function MetricGrid({ children }: { children: React.ReactNode }) {
  return <View style={styles.grid}>{React.Children.map(children, (child) => <View style={styles.cell}>{child}</View>)}</View>;
}

/** The web's DualTrend reduced to bars: one per period, scaled to the busiest. */
export function TrendBars({ values, accessibilityLabel, height = 88 }: { values: number[]; accessibilityLabel: string; height?: number }) {
  const { colors } = useTheme();
  const heights = relativeHeights(values);
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={accessibilityLabel} style={[styles.bars, { height, gap: values.length > 48 ? 1 : 2 }]}>
      {heights.map((ratio, index) => (
        <View key={index} style={styles.barSlot}>
          <View style={{ height: Math.max(ratio > 0 ? 2 : 1, ratio * height), borderRadius: 2, backgroundColor: ratio > 0 ? colors.accent : colors.border }} />
        </View>
      ))}
    </View>
  );
}

/** The web's OutcomeBars: successes stacked over failures per period. */
export function OutcomeBars({ points, height = 72 }: { points: Array<{ successes: number; failures: number }>; height?: number }) {
  const { colors } = useTheme();
  const totals = relativeHeights(points.map((point) => point.successes + point.failures));
  const successes = points.reduce((sum, point) => sum + point.successes, 0);
  const failures = points.reduce((sum, point) => sum + point.failures, 0);
  return (
    <View style={{ gap: 10 }}>
      <View accessible accessibilityRole="image" accessibilityLabel={`${successes} successful and ${failures} failed requests`} style={[styles.bars, { height, gap: points.length > 48 ? 1 : 2 }]}>
        {points.map((point, index) => {
          const total = point.successes + point.failures;
          const barHeight = Math.max(total > 0 ? 2 : 1, (totals[index] ?? 0) * height);
          const failureShare = total > 0 ? point.failures / total : 0;
          return (
            <View key={index} style={styles.barSlot}>
              <View style={{ height: barHeight, borderRadius: 2, overflow: "hidden", backgroundColor: total > 0 ? colors.textSecondary : colors.border }}>
                {failureShare > 0 ? <View style={{ height: `${failureShare * 100}%`, backgroundColor: colors.danger }} /> : null}
              </View>
            </View>
          );
        })}
      </View>
      <View style={styles.legend}>
        <LegendDot color={colors.textSecondary} label={`Succeeded ${successes}`} />
        <LegendDot color={colors.danger} label={`Failed ${failures}`} />
      </View>
    </View>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <View style={styles.legendItem}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text variant="meta" tone="secondary" style={styles.numeric}>{label}</Text>
    </View>
  );
}

/** The web's ModelSpendRings as share bars, largest first. */
export function ShareBars({ rows, format }: { rows: Array<{ label: string; value: number }>; format: (value: number) => string }) {
  const { colors } = useTheme();
  const sorted = [...rows].sort((left, right) => right.value - left.value);
  const total = sorted.reduce((sum, row) => sum + row.value, 0);
  if (!sorted.length || total <= 0) return <Text variant="secondary" tone="tertiary">No billed model usage in this period.</Text>;
  return (
    <View style={{ gap: 12 }}>
      {sorted.map((row) => {
        const share = row.value / total;
        return (
          <View key={row.label} style={{ gap: 6 }} accessible accessibilityLabel={`${row.label}: ${format(row.value)}, ${Math.round(share * 100)}%`}>
            <View style={styles.shareHeader}>
              <Text variant="secondary" numberOfLines={1} style={{ flex: 1 }}>{row.label}</Text>
              <Text variant="secondary" tone="tertiary" style={styles.numeric}>{format(row.value)} · {Math.round(share * 100)}%</Text>
            </View>
            <View style={[styles.track, { backgroundColor: colors.command }]}>
              <View style={{ width: `${Math.max(1, share * 100)}%`, height: 6, borderRadius: 3, backgroundColor: colors.accent }} />
            </View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: "row", flexWrap: "wrap", marginHorizontal: -4 },
  cell: { width: "50%", padding: 4 },
  tile: { borderWidth: StyleSheet.hairlineWidth, padding: 12, gap: 4, minHeight: 84 },
  tileHeader: { flexDirection: "row", alignItems: "center", gap: 6 },
  numeric: { fontVariant: ["tabular-nums"] },
  bars: { flexDirection: "row", alignItems: "flex-end" },
  barSlot: { flex: 1, justifyContent: "flex-end" },
  legend: { flexDirection: "row", gap: 16 },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  shareHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  track: { height: 6, borderRadius: 3, overflow: "hidden" },
});
