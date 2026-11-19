import * as React from "react";
import { Stack } from "expo-router";
import { useTheme } from "../../../src/theme/theme";

// A deep link straight to a tab (e.g. the sidebar's "View personal usage")
// still gets the settings home underneath, so Back lands there.
export const unstable_settings = { initialRouteName: "index" };

/** Settings pages push inside the drawer's Settings screen; each draws its own header. */
export default function SettingsLayout() {
  const { colors } = useTheme();
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }} />;
}
