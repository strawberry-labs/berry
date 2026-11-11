import * as React from "react";
import { useFocusEffect, useLocalSearchParams, useNavigation } from "expo-router";
import { SettingsTabScreen } from "../../../src/features/settings/settings-tab-screen";
import { resolveSettingsTab } from "../../../src/features/settings/settings-model";

/** `/settings/<tab>` with the web's tab ids, e.g. `{ tab: "usage" }`. */
export default function SettingsTabRoute() {
  const params = useLocalSearchParams<{ tab?: string; view?: string }>();
  const raw = Array.isArray(params.tab) ? params.tab[0] : params.tab;
  const navigation = useNavigation();

  // On a pushed page the left-edge swipe should go back, not open the sidebar.
  useFocusEffect(React.useCallback(() => {
    const drawer = navigation.getParent();
    drawer?.setOptions({ swipeEnabled: false });
    return () => drawer?.setOptions({ swipeEnabled: true });
  }, [navigation]));

  // The web's old /settings/memory link opened Personalization's Memory tab.
  const view = raw === "memory" ? "memory" : typeof params.view === "string" ? params.view : undefined;
  return <SettingsTabScreen tab={resolveSettingsTab(raw)} view={view} />;
}
