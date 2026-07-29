import * as React from "react";
import { FormSelect, ManagementPage, ManagementSwitch, Section } from "./management-primitives";
import { applyDocumentTheme, DEFAULT_BERRY_THEME, normalizeThemePreference } from "@/lib/theme";
import { useLocalSetting } from "./management-context";

export function GeneralSettingsScreen() {
  const [theme, setTheme] = useLocalSetting("berry.web.theme", DEFAULT_BERRY_THEME);
  const [language, setLanguage] = useLocalSetting("berry.web.language", "system");
  const [followUps, setFollowUps] = useLocalSetting("berry.web.followUps", "on");

  React.useEffect(() => {
    applyDocumentTheme(normalizeThemePreference(theme));
  }, [theme]);
  React.useEffect(() => { document.documentElement.lang = language === "system" ? navigator.language.split("-")[0] || "en" : language; }, [language]);

  return <ManagementPage title="Appearance & behavior" description="Choose how Berry looks and how conversations behave in this browser." eyebrow="Preferences">
    <Section title="Appearance" description="These preferences are stored in this browser."><div className="grid divide-y divide-border">
      <label className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0"><span className="grid gap-0.5"><b className="text-sm font-medium text-foreground">Theme</b><small className="text-xs text-muted-foreground">Use Berry’s light, dark, or system appearance.</small></span><div className="w-40"><FormSelect value={theme} onChange={setTheme} options={[{ value: "system", label: "System" }, { value: "dark", label: "Dark" }, { value: "light", label: "Light" }]} /></div></label>
      <label className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0"><span className="grid gap-0.5"><b className="text-sm font-medium text-foreground">Language</b><small className="text-xs text-muted-foreground">Controls dates, numbers, and screen-reader pronunciation.</small></span><div className="w-40"><FormSelect value={language} onChange={setLanguage} options={[{ value: "system", label: "System default" }, { value: "en", label: "English" }]} /></div></label>
    </div></Section>
    <Section title="Conversation behavior"><div className="grid divide-y divide-border">
      <label className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0"><span className="grid gap-0.5"><b className="text-sm font-medium text-foreground">Queued follow-ups</b><small className="text-xs text-muted-foreground">Keep follow-up messages ready while a turn is running.</small></span><ManagementSwitch checked={followUps === "on"} onCheckedChange={(checked) => setFollowUps(checked ? "on" : "off")} aria-label="Queued follow-ups" /></label>
    </div></Section>
  </ManagementPage>;
}
