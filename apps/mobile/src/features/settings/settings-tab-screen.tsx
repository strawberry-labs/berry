import * as React from "react";
import { Redirect } from "expo-router";
import { hasCapability } from "../../session/compatibility";
import { useSignedInSession } from "../../session/session";
import { EmptyState } from "../../ui/primitives";
import { Section } from "../../ui/screen";
import { AccountTab } from "./account-tab";
import { ArchivedTab } from "./archived-tab";
import { ConnectorsTab } from "./connectors-tab";
import { GeneralTab } from "./general-tab";
import { McpTab } from "./mcp-tab";
import { PersonalizationTab } from "./personalization-tab";
import { settingsTab, type SettingsTabId } from "./settings-model";
import { SettingsPage } from "./settings-ui";
import { UsageTab } from "./usage-tab";

/** Renders one settings tab by its web id (`/settings/<id>` on the web). */
export function SettingsTabScreen({ tab, view }: { tab: SettingsTabId; view?: string | undefined }) {
  const { serverInfo } = useSignedInSession();
  const definition = settingsTab(tab);
  if (definition.href) return <Redirect href={definition.href} />;
  if (serverInfo && definition.capability && !hasCapability(serverInfo, definition.capability)) {
    return (
      <SettingsPage title={definition.label}>
        <Section>
          <EmptyState title="Not available on this server" message="Ask your administrator to update Berry to use this on your phone." />
        </Section>
      </SettingsPage>
    );
  }
  switch (tab) {
    case "general": return <GeneralTab />;
    case "account": return <AccountTab />;
    case "personalization": return <PersonalizationTab initialView={view === "memory" ? "memory" : "profile"} />;
    case "connectors": return <ConnectorsTab />;
    case "mcp": return <McpTab />;
    case "usage": return <UsageTab />;
    case "archived": return <ArchivedTab />;
    default: return <GeneralTab />;
  }
}
