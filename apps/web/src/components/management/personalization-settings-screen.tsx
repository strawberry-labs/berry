import * as React from "react";
import type { PersonalizationProfile } from "@berry/shared";
import { Save } from "lucide-react";
import { cn } from "@berry/desktop-ui/lib/utils";
import { Button, InlineNotice, Input, ManagementPage, Section, SegmentedControl, Textarea } from "./management-primitives";
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

  const selectTab = (next: PersonalizationTab) => {
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

  const tabs = <SegmentedControl
    label="Personalization sections"
    value={tab}
    onChange={selectTab}
    options={[{ value: "profile", label: "About you" }, { value: "memory", label: "Memory" }]}
  />;

  return <ManagementPage width="narrow" title="Personalization" description="Tell Berry about yourself and how you like to work, and manage what it remembers.">
    {tab === "profile" ? <>
      <div>{tabs}</div>
      <Section title="About you" description="Berry reads this at the start of every task. Leave a field empty if it doesn’t apply.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="personalization-nickname" label="Nickname">
            <Input id="personalization-nickname" value={draft.nickname} maxLength={80} onChange={(event) => updateDraft("nickname", event.currentTarget.value)} placeholder="What should Berry call you?" />
          </Field>
          <Field id="personalization-occupation" label="Occupation">
            <Input id="personalization-occupation" value={draft.occupation} maxLength={160} onChange={(event) => updateDraft("occupation", event.currentTarget.value)} placeholder="Your role or area of work" />
          </Field>
          <Field className="sm:col-span-2" id="personalization-about" label="More about you" help="Background that stays true across tasks: your team, your projects, the tools you use.">
            <Textarea id="personalization-about" aria-describedby="personalization-about-help" className="min-h-24 resize-y" value={draft.about} maxLength={4_000} onChange={(event) => updateDraft("about", event.currentTarget.value)} />
          </Field>
          <Field className="sm:col-span-2" id="personalization-instructions" label="Custom instructions" help="How Berry should work and respond for you, such as tone, format, or things to always or never do.">
            <Textarea id="personalization-instructions" aria-describedby="personalization-instructions-help" className="min-h-36 resize-y" value={draft.customInstructions} maxLength={12_000} onChange={(event) => updateDraft("customInstructions", event.currentTarget.value)} />
          </Field>
        </div>
        {error ? <div className="mt-3"><InlineNotice tone="danger">{error}</InlineNotice></div> : null}
        {dirty ? <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button variant="secondary" disabled={saving} onClick={() => { setDraft(props.personalization); setError(""); }}>Discard</Button>
          <Button disabled={saving} onClick={() => void save()}><Save />{saving ? "Saving…" : "Save changes"}</Button>
        </div> : null}
      </Section>
    </> : <MemorySettingsScreen {...props} embedded lead={tabs} />}
  </ManagementPage>;
}

function Field({ id, label, help, className, children }: { id: string; label: string; help?: string; className?: string; children: React.ReactNode }) {
  return <div className={cn("grid content-start gap-1.5", className)}>
    <label htmlFor={id} className="text-xs font-medium text-foreground">{label}</label>
    {children}
    {help ? <p id={`${id}-help`} className="text-xs leading-5 text-muted-foreground">{help}</p> : null}
  </div>;
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
