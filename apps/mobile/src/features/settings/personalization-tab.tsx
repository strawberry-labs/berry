import * as React from "react";
import { StyleSheet, View } from "react-native";
import type { PersonalizationProfile } from "@berry/shared";
import { apiErrorMessage } from "../../api/client";
import { Button } from "../../ui/button";
import { Input } from "../../ui/primitives";
import { Section } from "../../ui/screen";
import { MemorySection } from "./memory-section";
import { usePersonalizationProfile, useSavePersonalization } from "./settings-data";
import { PROFILE_LIMITS, profileInput, sameProfile, type ProfileFields } from "./settings-model";
import { AsyncContent, Field, InlineMessage, SectionBody, SegmentedControl, SettingsPage } from "./settings-ui";

type PersonalizationView = "profile" | "memory";

const VIEWS: ReadonlyArray<{ value: PersonalizationView; label: string }> = [
  { value: "profile", label: "Profile" },
  { value: "memory", label: "Memory" },
];

function fields(profile: PersonalizationProfile): ProfileFields {
  return { nickname: profile.nickname, occupation: profile.occupation, about: profile.about, customInstructions: profile.customInstructions };
}

/** Settings › Personalization: the web's Profile and Memory tabs. */
export function PersonalizationTab({ initialView = "profile" }: { initialView?: PersonalizationView }) {
  const [view, setView] = React.useState<PersonalizationView>(initialView);
  return (
    <SettingsPage title="Personalization" description="Set explicit profile context and control what Berry remembers.">
      <SegmentedControl value={view} options={VIEWS} onChange={setView} accessibilityLabel="Personalization sections" />
      {view === "profile" ? <ProfileSection /> : <MemorySection />}
    </SettingsPage>
  );
}

function ProfileSection() {
  const query = usePersonalizationProfile();
  const save = useSavePersonalization();
  const saved = query.data ? fields(query.data) : null;
  const [draft, setDraft] = React.useState<ProfileFields | null>(saved);
  const [status, setStatus] = React.useState<{ tone: "danger" | "success"; text: string } | null>(null);

  React.useEffect(() => {
    if (query.data) setDraft(fields(query.data));
  }, [query.data]);

  const dirty = Boolean(saved && draft && !sameProfile(draft, saved));
  const update = (field: keyof ProfileFields, value: string) => {
    setStatus(null);
    setDraft((current) => (current ? { ...current, [field]: value } : current));
  };
  const submit = () => {
    if (!draft || !dirty || save.isPending) return;
    setStatus(null);
    save.mutate(profileInput(draft), {
      onSuccess: () => setStatus({ tone: "success", text: "Saved. New tasks will use this context." }),
      onError: (cause) => setStatus({ tone: "danger", text: apiErrorMessage(cause, "Unable to save personalization.") }),
    });
  };

  return (
    <Section title="Profile context" description="Berry uses this explicit context when starting your tasks." footer={status ? <InlineMessage tone={status.tone} onDismiss={() => setStatus(null)}>{status.text}</InlineMessage> : undefined}>
      <AsyncContent
        loading={query.isPending}
        error={query.isError ? apiErrorMessage(query.error, "Could not load your profile context.") : null}
        onRetry={() => void query.refetch()}
        rows={4}
      >
        {draft ? (
          <SectionBody>
            <Field label="Nickname">
              <Input value={draft.nickname} maxLength={PROFILE_LIMITS.nickname} onChangeText={(value) => update("nickname", value)} placeholder="What should Berry call you?" accessibilityLabel="Nickname" returnKeyType="next" />
            </Field>
            <Field label="Occupation">
              <Input value={draft.occupation} maxLength={PROFILE_LIMITS.occupation} onChangeText={(value) => update("occupation", value)} placeholder="Your role or area of work" accessibilityLabel="Occupation" />
            </Field>
            <Field label="More about you">
              <Input value={draft.about} maxLength={PROFILE_LIMITS.about} onChangeText={(value) => update("about", value)} placeholder="Stable context that helps Berry work with you" accessibilityLabel="More about you" multiline textAlignVertical="top" style={styles.textarea} />
            </Field>
            <Field label="Custom instructions">
              <Input value={draft.customInstructions} maxLength={PROFILE_LIMITS.customInstructions} onChangeText={(value) => update("customInstructions", value)} placeholder="How should Berry approach your work and responses?" accessibilityLabel="Custom instructions" multiline textAlignVertical="top" style={[styles.textarea, styles.tall]} />
            </Field>
            {dirty ? (
              <View style={styles.actions}>
                <Button variant="secondary" label="Discard" disabled={save.isPending} onPress={() => { if (saved) setDraft(saved); setStatus(null); }} />
                <Button label={save.isPending ? "Saving…" : "Save changes"} disabled={save.isPending} accessibilityState={{ busy: save.isPending }} onPress={submit} />
              </View>
            ) : null}
          </SectionBody>
        ) : null}
      </AsyncContent>
    </Section>
  );
}

const styles = StyleSheet.create({
  textarea: { minHeight: 96, paddingTop: 12, paddingBottom: 12 },
  tall: { minHeight: 144 },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
});
