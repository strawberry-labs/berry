import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BottomSheetModalProvider } from "@gorhom/bottom-sheet";
import { JetBrainsMono_400Regular } from "@expo-google-fonts/jetbrains-mono/400Regular";
import { SourceSerif4_600SemiBold } from "@expo-google-fonts/source-serif-4/600SemiBold";
import { useFonts } from "expo-font";
import { DarkTheme, DefaultTheme, Stack, ThemeProvider as NavigationThemeProvider } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import * as SystemUI from "expo-system-ui";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { SessionProvider, useSession } from "../src/session/session";
import { ThemeProvider, useTheme } from "../src/theme/theme";

void SplashScreen.preventAutoHideAsync().catch(() => undefined);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 15_000, retry: (count, error) => count < 2 && !(error as { status?: number }).status?.toString().startsWith("4") },
  },
});

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({ JetBrainsMono_400Regular, SourceSerif4_600SemiBold });
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <KeyboardProvider>
          <QueryClientProvider client={queryClient}>
            <SessionProvider>
              <BrandedTheme>
                <BottomSheetModalProvider>
                  <RootNavigator ready={fontsLoaded || Boolean(fontError)} />
                </BottomSheetModalProvider>
              </BrandedTheme>
            </SessionProvider>
          </QueryClientProvider>
        </KeyboardProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

/** Applies the paired organization's accent, as the web applies its deployment brand. */
function BrandedTheme({ children }: { children: React.ReactNode }) {
  const { state } = useSession();
  const accent = state.status === "signed-in" ? (state.serverInfo?.brand.accentColor ?? state.profile.brand.accentColor) : null;
  return <ThemeProvider accentColor={accent}>{children}</ThemeProvider>;
}

function RootNavigator({ ready }: { ready: boolean }) {
  const { state } = useSession();
  const theme = useTheme();
  const loading = state.status === "loading" || !ready;

  React.useEffect(() => {
    void SystemUI.setBackgroundColorAsync(theme.colors.background);
  }, [theme.colors.background]);
  React.useEffect(() => {
    if (!loading) void SplashScreen.hideAsync().catch(() => undefined);
  }, [loading]);

  const navigationTheme = React.useMemo(() => {
    const base = theme.scheme === "dark" ? DarkTheme : DefaultTheme;
    return {
      ...base,
      colors: { ...base.colors, primary: theme.colors.accent, background: theme.colors.background, card: theme.colors.header, text: theme.colors.textPrimary, border: theme.colors.border, notification: theme.colors.danger },
    };
  }, [theme]);

  if (loading) return null;
  const signedIn = state.status === "signed-in";
  return (
    <NavigationThemeProvider value={navigationTheme}>
      <StatusBar style={theme.scheme === "dark" ? "light" : "dark"} />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.colors.background } }}>
        <Stack.Protected guard={signedIn}>
          <Stack.Screen name="(app)" />
        </Stack.Protected>
        <Stack.Protected guard={!signedIn}>
          <Stack.Screen name="(auth)" />
        </Stack.Protected>
        <Stack.Screen name="pair" options={{ animation: "none" }} />
      </Stack>
    </NavigationThemeProvider>
  );
}
