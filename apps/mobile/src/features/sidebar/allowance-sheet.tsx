import * as React from "react";
import { StyleSheet, View } from "react-native";
import { allowanceProgress, formatAllowanceResetDate, formatCurrencyMicros } from "@berry/client-core/format";
import type { MobileSessionUser } from "@berry/shared";
import { useTheme } from "../../theme/theme";
import { Button } from "../../ui/button";
import { DollarSign } from "../../ui/icons";
import { Progress } from "../../ui/primitives";
import { Sheet } from "../../ui/sheet";
import { Text } from "../../ui/text";
import { useAllowance, useOrganizationId } from "../data/shell-data";

/** The web sidebar's account popover: who you are and this cycle's allowance. */
export function AllowanceSheet({ open, onOpenChange, user, onViewUsage }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: MobileSessionUser;
  onViewUsage: () => void;
}) {
  const { colors, layout } = useTheme();
  const tenantId = useOrganizationId();
  const allowance = useAllowance(open ? tenantId : null);
  const data = allowance.data;
  const loading = allowance.isPending && allowance.fetchStatus !== "idle";
  const progress = data?.effectiveLimitMicros ? allowanceProgress(data) : null;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <View style={{ gap: 2, paddingHorizontal: 4 }}>
        <Text variant="body" weight="semibold" numberOfLines={1}>{user.name || "Berry account"}</Text>
        <Text variant="secondary" tone="tertiary" numberOfLines={1}>{user.email}</Text>
      </View>
      <View style={[styles.card, { borderColor: colors.border, backgroundColor: colors.control, borderRadius: layout.radius }]}>
        <Row label="Available this cycle" value={loading ? "…" : data?.availableMicros === null ? "Unlimited" : formatCurrencyMicros(data?.availableMicros)} />
        <Row label="Used" value={loading ? "…" : formatCurrencyMicros(data ? String(BigInt(data.usedMicros) + BigInt(data.reservedMicros)) : null)} />
        {progress !== null ? (
          <View style={{ gap: 6 }}>
            <View style={styles.row}>
              <Text variant="meta" tone="secondary">Cycle usage</Text>
              <Text variant="meta" tone="secondary" style={styles.numeric}>{Math.round(progress)}%</Text>
            </View>
            <Progress value={progress} accessibilityLabel={`${Math.round(progress)}% of allowance used`} />
          </View>
        ) : null}
        <Text variant="meta" tone="secondary">{data ? `Resets ${formatAllowanceResetDate(data.cycleEnd)}` : allowance.isError ? "Allowance information is unavailable." : " "}</Text>
      </View>
      <Button variant="ghost" icon={DollarSign} label="View personal usage" onPress={() => { onOpenChange(false); onViewUsage(); }} style={{ alignSelf: "flex-start" }} />
    </Sheet>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text variant="secondary" tone="secondary">{label}</Text>
      <Text variant="body" weight="semibold" style={styles.numeric}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, padding: 12, gap: 10 },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 },
  numeric: { fontVariant: ["tabular-nums"] },
});
