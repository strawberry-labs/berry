import * as React from "react";
import type { PersonalizationProfile } from "@berry/shared";
import { Save } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@berry/desktop-ui/components/ui/tabs";
import { Button, Input, ManagementPage, Section, Textarea } from "./management-primitives";
import type { ManagementScreenProps } from "./management-context";
import { MemorySettingsScreen } from "./memory-settings-screen";

type PersonalizationTab = "profile" | "memory";

export function PersonalizationSettingsScreen(props: ManagementScreenProps) {
  const [tab, setTab] = React.useState<PersonalizationTab>(() => selectedTab());
  const [draft, setDraft] = React.useState(props.personalization);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState("");
  const dirty = !sameProfile(draft, props.personalization);

  React.useEffect(() => setDraft(props.personalization), [props.personalization]);

  const selectTab = (value: string) => {
    const next = value === "memory" ? "memory" : "profile";
    setTab(next);
    const url = new URL(window.location.href);
    if (next === "profile") url.searchParams.delete("tab");
    else url.searchParams.set("tab", next);
    window.history.replaceState(window.history.state, "", url);
  };

  const save = async () => {
    if (saving || !dirty) return;
    setSaving(true);
    setError("");
    try {
      const next = props.client
        ? await props.client.updatePersonalizationProfile(profileInput(draft))
        : { ...draft, updatedAt: new Date().toISOString() };
      props.onPersonalizationChange(next);
      setDraft(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save personalization");
    } finally {
      setSaving(false);
    }
  };

  const updateDraft = (field: keyof ReturnType<typeof profileInput>, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
  };

  return <ManagementPage title="Personalization" description="Set explicit profile context and control what Berry remembers.">
    <Tabs value={tab} onValueChange={selectTab}>
      <TabsList variant="line" aria-label="Personalization sections">
        <TabsTrigger value="profile">Profile</TabsTrigger>
        <TabsTrigger value="memory">Memory</TabsTrigger>
      </TabsList>
    </Tabs>
    {tab === "profile" ? <Section title="Profile context" description="Berry uses this explicit context when starting your tasks.">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Nickname"><Input value={draft.nickname} maxLength={80} onChange={(event) => updateDraft("nickname", event.currentTarget.value)} placeholder="What should Berry call you?" /></Field>
        <Field label="Occupation"><Input value={draft.occupation} maxLength={160} onChange={(event) => updateDraft("occupation", event.currentTarget.value)} placeholder="Your role or area of work" /></Field>
        <Field className="sm:col-span-2" label="More about you"><Textarea className="min-h-24 resize-y" value={draft.about} maxLength={4_000} onChange={(event) => updateDraft("about", event.currentTarget.value)} placeholder="Stable context that helps Berry work with you" /></Field>
        <Field className="sm:col-span-2" label="Custom instructions"><Textarea className="min-h-36 resize-y" value={draft.customInstructions} maxLength={12_000} onChange={(event) => updateDraft("customInstructions", event.currentTarget.value)} placeholder="How should Berry approach your work and responses?" /></Field>
      </div>
      {error ? <p className="mt-3 text-xs text-destructive" role="alert">{error}</p> : null}
      {dirty ? <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={() => { setDraft(props.personalization); setError(""); }}>Discard</Button>
        <Button disabled={saving} onClick={() => void save()}><Save />{saving ? "Saving…" : "Save changes"}</Button>
      </div> : null}
    </Section> : <MemorySettingsScreen {...props} embedded />}
  </ManagementPage>;
}

function Field({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  return <label className={`grid gap-1.5 text-xs font-medium text-muted-foreground ${className ?? ""}`}><span>{label}</span>{children}</label>;
}

function selectedTab(): PersonalizationTab {
  if (typeof window === "undefined") return "profile";
  return new URLSearchParams(window.location.search).get("tab") === "memory" ? "memory" : "profile";
}

function profileInput(profile: PersonalizationProfile) {
  return { nickname: profile.nickname.trim(), occupation: profile.occupation.trim(), about: profile.about.trim(), customInstructions: profile.customInstructions.trim() };
}

function sameProfile(left: PersonalizationProfile, right: PersonalizationProfile): boolean {
  return JSON.stringify(profileInput(left)) === JSON.stringify(profileInput(right));
}
