import * as React from "react";
import { StyleSheet, View } from "react-native";
import { BottomSheetBackdrop, BottomSheetModal, BottomSheetScrollView, BottomSheetView, type BottomSheetBackdropProps } from "@gorhom/bottom-sheet";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../theme/theme";
import { Text } from "./text";

/**
 * The phone counterpart of the web's dialogs and popovers: a bottom sheet
 * that sizes to its content and dismisses by swipe, tap outside, or back.
 */
export function Sheet({ open, onOpenChange, title, description, scroll = false, children }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  description?: string;
  scroll?: boolean;
  children: React.ReactNode;
}) {
  const ref = React.useRef<BottomSheetModal>(null);
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  React.useEffect(() => {
    if (open) ref.current?.present();
    else ref.current?.dismiss();
  }, [open]);
  const renderBackdrop = React.useCallback(
    (props: BottomSheetBackdropProps) => <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} pressBehavior="close" />,
    [],
  );
  const Body = scroll ? BottomSheetScrollView : BottomSheetView;
  return (
    <BottomSheetModal
      ref={ref}
      onDismiss={() => onOpenChange(false)}
      backdropComponent={renderBackdrop}
      backgroundStyle={{ backgroundColor: colors.panel }}
      handleIndicatorStyle={{ backgroundColor: colors.borderStrong }}
      enablePanDownToClose
      enableDynamicSizing
    >
      <Body style={[styles.body, { paddingBottom: Math.max(insets.bottom, 16) }]}>
        {title || description ? (
          <View style={styles.header}>
            {title ? <Text variant="body" weight="semibold" accessibilityRole="header">{title}</Text> : null}
            {description ? <Text variant="secondary" tone="tertiary">{description}</Text> : null}
          </View>
        ) : null}
        {children}
      </Body>
    </BottomSheetModal>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: 16, paddingTop: 4, gap: 12 },
  header: { gap: 4, paddingHorizontal: 4, paddingBottom: 4 },
});
