import * as React from "react";
import { Bell, BellRing, Languages, MonitorCog, Volume2 } from "lucide-react";
import { FormSelect, ManagementPage, ManagementSwitch, Section, SettingList, SettingRow } from "./management-primitives";
import { applyDocumentTheme, DEFAULT_BERRY_THEME, normalizeThemePreference } from "@/lib/theme";
import { useLocalSetting } from "./management-context";
import {
  BROWSER_NOTIFICATIONS_KEY,
  SOUND_ALERTS_KEY,
  notificationPermission,
  requestBrowserNotificationPermission,
  unlockCompletionSound,
  type BrowserPermissionState,
} from "@/lib/task-notifications";

export function GeneralSettingsScreen() {
  const [theme, setTheme] = useLocalSetting("berry.web.theme", DEFAULT_BERRY_THEME);
  const [browserNotifications, setBrowserNotifications] = useLocalSetting(BROWSER_NOTIFICATIONS_KEY, "on");
  const [soundAlerts, setSoundAlerts] = useLocalSetting(SOUND_ALERTS_KEY, "on");
  const [permission, setPermission] = React.useState<BrowserPermissionState>("unsupported");
  const [languageName, setLanguageName] = React.useState("System default");

  React.useEffect(() => {
    applyDocumentTheme(normalizeThemePreference(theme));
  }, [theme]);
  React.useEffect(() => {
    document.documentElement.lang = navigator.language.split("-")[0] || "en";
    setPermission(notificationPermission());
    try {
      const name = new Intl.DisplayNames([navigator.language], { type: "language" }).of(navigator.language);
      if (name) setLanguageName(name);
    } catch {
      // Keep the generic label when the browser cannot name its own locale.
    }
  }, []);

  const toggleBrowserNotifications = async (checked: boolean) => {
    setBrowserNotifications(checked ? "on" : "off");
    if (checked) setPermission(await requestBrowserNotificationPermission());
  };

  const toggleSoundAlerts = (checked: boolean) => {
    setSoundAlerts(checked ? "on" : "off");
    if (checked) void unlockCompletionSound();
  };

  return <ManagementPage width="narrow" title="General" description="Choose how Berry looks and how it gets your attention.">
    <Section title="Appearance" flush>
      <SettingList>
        <SettingRow icon={MonitorCog} title="Theme" description="Follow your system setting, or always use light or dark.">
          <div className="w-40"><FormSelect ariaLabel="Theme" value={theme} onChange={setTheme} options={[{ value: "system", label: "System" }, { value: "dark", label: "Dark" }, { value: "light", label: "Light" }]} /></div>
        </SettingRow>
        <SettingRow icon={Languages} title="Language" description="Berry uses your browser’s language.">
          <span className="text-md text-muted-foreground">{languageName}</span>
        </SettingRow>
      </SettingList>
    </Section>
    <Section title="Notifications" flush>
      <SettingList>
        <SettingRow icon={browserNotifications === "on" ? BellRing : Bell} title="Browser notifications" description={permissionText(permission, browserNotifications === "on")}>
          <ManagementSwitch checked={browserNotifications === "on" && permission === "granted"} onCheckedChange={(checked) => void toggleBrowserNotifications(checked)} aria-label="Browser notifications" />
        </SettingRow>
        <SettingRow icon={Volume2} title="Completion sound" description="Play a sound when a task finishes while you are in another tab.">
          <ManagementSwitch checked={soundAlerts === "on"} onCheckedChange={toggleSoundAlerts} aria-label="Completion sound" />
        </SettingRow>
      </SettingList>
    </Section>
  </ManagementPage>;
}

function permissionText(permission: BrowserPermissionState, enabled: boolean): string {
  if (!enabled) return "Notifications are off in this browser.";
  if (permission === "granted") return "Notify you about background progress and completed tasks.";
  if (permission === "denied") return "Blocked by your browser. Allow notifications in site settings.";
  if (permission === "unsupported") return "This browser does not support desktop notifications.";
  return "On. Your browser will ask for permission when you enable it.";
}
