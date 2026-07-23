import * as React from "react";
import { Save } from "lucide-react";
import { Button, FormSelect, ManagementPage, ManagementSwitch, Section, SuccessMessage, Textarea } from "./management-primitives";
import { applyDocumentTheme, DEFAULT_BERRY_THEME, normalizeThemePreference } from "@/lib/theme";
import { useLocalSetting } from "./management-context";

export function GeneralSettingsScreen() {
  const [theme, setTheme] = useLocalSetting("berry.web.theme", DEFAULT_BERRY_THEME);
  const [language, setLanguage] = useLocalSetting("berry.web.language", "system");
  const [instructions, setInstructions] = useLocalSetting("berry.web.customInstructions", "");
  const [followUps, setFollowUps] = useLocalSetting("berry.web.followUps", "on");
  const [draft, setDraft] = React.useState("");
  const [dirty, setDirty] = React.useState(false);
  const [saved, setSaved] = React.useState(false);

  React.useEffect(() => { if (!dirty) setDraft(instructions); }, [dirty, instructions]);
  React.useEffect(() => {
    applyDocumentTheme(normalizeThemePreference(theme));
  }, [theme]);
  React.useEffect(() => { document.documentElement.lang = language === "system" ? navigator.language.split("-")[0] || "en" : language; }, [language]);

  return <ManagementPage title="General" description="Browser appearance, conversation behavior, and instructions used for new tasks." eyebrow="Personal settings">
    <Section title="Appearance" description="These preferences are stored in this browser."><div className="mgmt-setting-list">
      <label><span><b>Theme</b><small>Use Berry’s light, dark, or system appearance.</small></span><FormSelect value={theme} onChange={setTheme} options={[{ value: "system", label: "System" }, { value: "dark", label: "Dark" }, { value: "light", label: "Light" }]} /></label>
      <label><span><b>Language</b><small>Controls dates, numbers, and screen-reader pronunciation.</small></span><FormSelect value={language} onChange={setLanguage} options={[{ value: "system", label: "System default" }, { value: "en", label: "English" }]} /></label>
    </div></Section>
    <Section title="Conversation behavior"><div className="mgmt-setting-list">
      <label><span><b>Queued follow-ups</b><small>Keep follow-up messages ready while a turn is running.</small></span><ManagementSwitch checked={followUps === "on"} onCheckedChange={(checked) => setFollowUps(checked ? "on" : "off")} aria-label="Queued follow-ups" /></label>
    </div></Section>
    <Section title="Custom instructions" description="Applied to new conversations; existing task history is unchanged.">
      <Textarea className="mgmt-textarea" value={draft} onChange={(event) => { setDraft(event.currentTarget.value); setDirty(event.currentTarget.value !== instructions); setSaved(false); }} placeholder="Tell Berry how you prefer to work…" aria-label="Custom instructions" />
      {dirty ? <div className="mgmt-sticky-save"><span>Unsaved changes</span><Button variant="secondary" onClick={() => { setDraft(instructions); setDirty(false); }}>Discard</Button><Button onClick={() => { setInstructions(draft); setDirty(false); setSaved(true); }}><Save />Save changes</Button></div> : null}
      {saved ? <SuccessMessage>Preferences saved in this browser.</SuccessMessage> : null}
    </Section>
  </ManagementPage>;
}
