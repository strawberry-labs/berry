import * as React from "react";
import { ScrollView, StyleSheet, View, type ScrollViewProps, type StyleProp, type ViewStyle } from "react-native";
import { SafeAreaView, type Edge } from "react-native-safe-area-context";
import { useTheme } from "../theme/theme";
import { Text } from "./text";

/** A full-height surface on the main background, respecting safe areas. */
export function Screen({ children, edges = ["top", "bottom"], background = "background", style }: {
  children: React.ReactNode;
  edges?: Edge[];
  background?: "background" | "sidebar" | "surfaceUnder";
  style?: StyleProp<ViewStyle>;
}) {
  const { colors } = useTheme();
  return <SafeAreaView edges={edges} style={[{ flex: 1, backgroundColor: colors[background] }, style]}>{children}</SafeAreaView>;
}

/** The ManagementPage pattern: title, description, then sections. */
export function PageScroll({ title, description, children, ...props }: ScrollViewProps & { title?: string; description?: string; children: React.ReactNode }) {
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardDismissMode="on-drag" {...props} contentContainerStyle={[styles.page, props.contentContainerStyle]}>
      {title ? (
        <View style={styles.header}>
          <Text variant="pageTitle">{title}</Text>
          {description ? <Text variant="secondary" tone="tertiary">{description}</Text> : null}
        </View>
      ) : null}
      {children}
    </ScrollView>
  );
}

/** The management `Section`: a titled card. */
export function Section({ title, description, children, footer }: { title?: string; description?: string; children: React.ReactNode; footer?: React.ReactNode }) {
  const { colors, layout } = useTheme();
  return (
    <View style={{ gap: 8 }}>
      {title || description ? (
        <View style={{ gap: 2, paddingHorizontal: 4 }}>
          {title ? <Text variant="sectionHeading">{title}</Text> : null}
          {description ? <Text variant="secondary" tone="tertiary">{description}</Text> : null}
        </View>
      ) : null}
      <View style={{ borderRadius: layout.panelRadius, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, backgroundColor: colors.surfaceUnder, overflow: "hidden" }}>
        {children}
      </View>
      {footer ? <View style={{ paddingHorizontal: 4 }}>{footer}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 48, gap: 24 },
  header: { gap: 6, paddingHorizontal: 4 },
});
