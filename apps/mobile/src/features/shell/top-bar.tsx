import * as React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useNavigation } from "expo-router";
import { DrawerActions } from "expo-router/react-navigation";
import { useTheme } from "../../theme/theme";
import { Button } from "../../ui/button";
import { LayoutAlignLeft } from "../../ui/icons";
import { Text } from "../../ui/text";

/**
 * The phone header from the web (D6): the sidebar toggle alone on the left,
 * an optional title (the task header on task screens), and trailing actions.
 */
export function TopBar({ title, subtitle, onTitlePress, trailing }: {
  title?: string | undefined;
  subtitle?: string | undefined;
  onTitlePress?: (() => void) | undefined;
  trailing?: React.ReactNode;
}) {
  const navigation = useNavigation();
  const { layout } = useTheme();
  return (
    <View style={[styles.bar, { height: layout.titlebarHeight }]}>
      <Button
        variant="ghost"
        size="icon-lg"
        icon={LayoutAlignLeft}
        accessibilityLabel="Open sidebar"
        onPress={() => navigation.dispatch(DrawerActions.openDrawer())}
      />
      {title ? (
        <Pressable accessibilityRole={onTitlePress ? "button" : "header"} onPress={onTitlePress} disabled={!onTitlePress} style={styles.title}>
          <Text variant="body" weight="semibold" numberOfLines={1}>{title}</Text>
          {subtitle ? <Text variant="meta" tone="tertiary" numberOfLines={1}>{subtitle}</Text> : null}
        </Pressable>
      ) : <View style={styles.title} />}
      <View style={styles.trailing}>{trailing}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", paddingHorizontal: 4, gap: 4 },
  title: { flex: 1, minWidth: 0, paddingHorizontal: 4 },
  trailing: { flexDirection: "row", alignItems: "center" },
});
