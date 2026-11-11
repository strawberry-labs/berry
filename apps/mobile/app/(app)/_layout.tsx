import * as React from "react";
import { Drawer } from "expo-router/drawer";
import { useTheme } from "../../src/theme/theme";
import { AppSidebar } from "../../src/features/sidebar/app-sidebar";

/** The web's sidebar as a swipe drawer; screens draw their own top bars. */
export default function AppLayout() {
  const { colors } = useTheme();
  return (
    <Drawer
      drawerContent={(props) => <AppSidebar navigation={props.navigation} />}
      screenOptions={{
        headerShown: false,
        drawerType: "front",
        drawerStyle: { backgroundColor: colors.sidebar, width: 300 },
        overlayColor: colors.overlay,
        swipeEdgeWidth: 32,
        sceneStyle: { backgroundColor: colors.background },
      }}
    >
      <Drawer.Screen name="index" />
    </Drawer>
  );
}
