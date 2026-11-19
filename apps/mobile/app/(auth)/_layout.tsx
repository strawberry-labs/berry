import { Stack } from "expo-router";
import { useTheme } from "../../src/theme/theme";

export default function AuthLayout() {
  const { colors } = useTheme();
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}>
      <Stack.Screen name="welcome" />
      <Stack.Screen name="scan" options={{ presentation: "fullScreenModal", animation: "slide_from_bottom" }} />
      <Stack.Screen name="enter-code" />
      <Stack.Screen name="pairing" options={{ gestureEnabled: false }} />
    </Stack>
  );
}
