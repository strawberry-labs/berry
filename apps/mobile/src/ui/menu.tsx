import * as React from "react";
import { ActionSheetIOS, Platform, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import * as Haptics from "expo-haptics";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { MenuView, type MenuAction } from "@react-native-menu/menu";
import { useTheme } from "../theme/theme";
import { Sheet } from "./sheet";
import { Text } from "./text";

export type MenuItem = {
  id: string;
  title: string;
  /** SF Symbol name on iOS; ignored on Android, which shows text-only menus. */
  systemImage?: string;
  destructive?: boolean;
  disabled?: boolean;
  checked?: boolean;
};

/**
 * Native menus stand in for the web's Radix dropdowns (tap) and hover row
 * actions (long press). Tap menus are UIMenu / the platform popup. Long-press
 * menus use a gesture-handler long press, so a plain tap still reaches the
 * row underneath, and show the native action sheet (iOS) or a bottom sheet.
 */
export function Menu({ items, onSelect, children, title, longPress = false, style }: {
  items: MenuItem[];
  onSelect: (id: string) => void;
  children: React.ReactNode;
  title?: string;
  longPress?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  if (longPress) return <LongPressMenu items={items} onSelect={onSelect} title={title} style={style}>{children}</LongPressMenu>;
  return <TapMenu items={items} onSelect={onSelect} title={title} style={style}>{children}</TapMenu>;
}

function TapMenu({ items, onSelect, children, title, style }: { items: MenuItem[]; onSelect: (id: string) => void; children: React.ReactNode; title?: string | undefined; style?: StyleProp<ViewStyle> }) {
  const { scheme } = useTheme();
  const actions: MenuAction[] = items.map((item) => ({
    id: item.id,
    title: item.title,
    ...(Platform.OS === "ios" && item.systemImage ? { image: item.systemImage } : {}),
    ...(item.checked !== undefined ? { state: item.checked ? "on" : "off" } : {}),
    attributes: { destructive: Boolean(item.destructive), disabled: Boolean(item.disabled) },
  }));
  return (
    <MenuView
      actions={actions}
      onPressAction={({ nativeEvent }) => onSelect(nativeEvent.event)}
      themeVariant={scheme}
      {...(title ? { title } : {})}
      {...(style ? { style } : {})}
    >
      {children}
    </MenuView>
  );
}

function LongPressMenu({ items, onSelect, children, title, style }: { items: MenuItem[]; onSelect: (id: string) => void; children: React.ReactNode; title?: string | undefined; style?: StyleProp<ViewStyle> }) {
  const { scheme, colors, layout } = useTheme();
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const enabled = items.filter((item) => !item.disabled);
  const open = React.useCallback(() => {
    if (enabled.length === 0) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (Platform.OS === "ios") {
      const options = [...items.map((item) => item.checked ? `✓ ${item.title}` : item.title), "Cancel"];
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options,
          cancelButtonIndex: items.length,
          destructiveButtonIndex: items.flatMap((item, index) => item.destructive ? [index] : []),
          disabledButtonIndices: items.flatMap((item, index) => item.disabled ? [index] : []),
          ...(title ? { title } : {}),
          userInterfaceStyle: scheme,
        },
        (index) => {
          const item = items[index];
          if (item && !item.disabled) onSelect(item.id);
        },
      );
      return;
    }
    setSheetOpen(true);
  }, [enabled.length, items, onSelect, scheme, title]);
  const gesture = React.useMemo(() => Gesture.LongPress().minDuration(350).runOnJS(true).onStart(open), [open]);
  return (
    <>
      <GestureDetector gesture={gesture}>
        <View collapsable={false} style={style} accessibilityActions={[{ name: "longpress", label: "More actions" }]} onAccessibilityAction={(event) => { if (event.nativeEvent.actionName === "longpress") open(); }}>
          {children}
        </View>
      </GestureDetector>
      {Platform.OS !== "ios" ? (
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen} {...(title ? { title } : {})}>
          <View>
            {items.map((item) => (
              <Pressable
                key={item.id}
                disabled={item.disabled}
                accessibilityRole="menuitem"
                onPress={() => {
                  setSheetOpen(false);
                  onSelect(item.id);
                }}
                style={({ pressed }) => [styles.sheetRow, { borderRadius: layout.radius, backgroundColor: pressed ? colors.hover : "transparent", opacity: item.disabled ? 0.5 : 1 }]}
              >
                <Text variant="body" tone={item.destructive ? "danger" : "primary"}>{item.title}</Text>
                {item.checked ? <Text variant="body" tone="accent">✓</Text> : null}
              </Pressable>
            ))}
          </View>
        </Sheet>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  sheetRow: { minHeight: 48, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 12 },
});
