import * as React from "react";
import { Bell, BellRing, Languages, MonitorCog, Volume2 } from "lucide-react";
import { FormSelect, ManagementPage, ManagementSwitch, Section } from "./management-primitives";
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

  React.useEffect(() => {
    applyDocumentTheme(normalizeThemePreference(theme));
  }, [theme]);
  React.useEffect(() => {
    document.documentElement.lang = navigator.language.split("-")[0] || "en";
    setPermission(notificationPermission());
  }, []);

  const toggleBrowserNotifications = async (checked: boolean) => {
    setBrowserNotifications(checked ? "on" : "off");
    if (checked) setPermission(await requestBrowserNotificationPermission());
  };

  const toggleSoundAlerts = (checked: boolean) => {
    setSoundAlerts(checked ? "on" : "off");
    if (checked) void unlockCompletionSound();
  };

  return <ManagementPage title="General" description="Choose how Berry looks and how it gets your attention.">
    <Section title="Appearance"><div className="grid divide-y divide-border">
      <SettingRow icon={MonitorCog} title="Theme" description="Use Berry’s light, dark, or system appearance."><div className="w-40"><FormSelect ariaLabel="Theme" value={theme} onChange={setTheme} options={[{ value: "system", label: "System" }, { value: "dark", label: "Dark" }, { value: "light", label: "Light" }]} /></div></SettingRow>
      <SettingRow icon={Languages} title="Language" description="Berry follows your browser and operating system."><span className="text-sm text-muted-foreground">System default</span></SettingRow>
    </div></Section>
    <Section title="Communication preferences"><div className="grid divide-y divide-border">
      <SettingRow icon={browserNotifications === "on" ? BellRing : Bell} title="Browser notifications" description={permissionText(permission, browserNotifications === "on")}>
        <ManagementSwitch checked={browserNotifications === "on" && permission === "granted"} onCheckedChange={(checked) => void toggleBrowserNotifications(checked)} aria-label="Browser notifications" />
      </SettingRow>
      <SettingRow icon={Volume2} title="Sound alert" description="Play one sound when a task completes while you are away.">
        <ManagementSwitch checked={soundAlerts === "on"} onCheckedChange={toggleSoundAlerts} aria-label="Sound alert" />
      </SettingRow>
    </div></Section>
  </ManagementPage>;
}

function SettingRow({ icon: Icon, title, description, children }: { icon: typeof Bell; title: string; description: string; children: React.ReactNode }) {
  return <div className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
    <span className="flex min-w-0 items-start gap-3">
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/35 text-muted-foreground"><Icon className="size-4" aria-hidden /></span>
      <span className="grid gap-0.5"><b className="text-sm font-medium text-foreground">{title}</b><small className="text-xs leading-5 text-muted-foreground">{description}</small></span>
    </span>
    <span className="shrink-0">{children}</span>
  </div>;
}

function permissionText(permission: BrowserPermissionState, enabled: boolean): string {
  if (!enabled) return "Notifications are off in this browser.";
  if (permission === "granted") return "Notify you about background progress and completed tasks.";
  if (permission === "denied") return "Blocked by your browser. Allow notifications in site settings.";
  if (permission === "unsupported") return "This browser does not support desktop notifications.";
  return "On. Your browser will ask for permission when you enable it.";
}
