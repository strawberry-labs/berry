import { router } from "expo-router";
import { Archive, CalendarClock, ChartColumn, Plug, Server, SlidersHorizontal, User, Wand2, type Icon } from "../../ui/icons";
import { Sparkles } from "../../ui/icons";
import type { SettingsTab, SettingsTabId } from "./settings-model";

/** The web settings navigation's icons, mapped to the phone's Hugeicons set. */
export const SETTINGS_TAB_ICONS: Readonly<Record<SettingsTabId, Icon>> = {
  general: SlidersHorizontal,
  account: User,
  personalization: Sparkles,
  connectors: Plug,
  skills: Wand2,
  mcp: Server,
  schedules: CalendarClock,
  usage: ChartColumn,
  archived: Archive,
};

/** Opens a settings tab: pushed inside settings, or the sidebar's own screen for Skills and Scheduled. */
export function openSettingsTab(tab: Pick<SettingsTab, "id" | "href">, mode: "push" | "navigate" = "push"): void {
  if (tab.href) router.navigate(tab.href);
  else if (mode === "push") router.push({ pathname: "/(app)/settings/[tab]", params: { tab: tab.id } });
  else router.navigate({ pathname: "/(app)/settings/[tab]", params: { tab: tab.id } });
}
