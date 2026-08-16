import * as React from "react";
import type { ManagementScreenProps } from "./management-context";

const GeneralSettingsScreen = React.lazy(async () => ({
  default: (await import("./general-settings-screen")).GeneralSettingsScreen,
}));

const AccountSettingsScreen = React.lazy(async () => ({
  default: (await import("./account-settings-screen")).AccountSettingsScreen,
}));
const PersonalSkillsScreen = React.lazy(async () => ({
  default: (await import("./personal-skills-screen")).PersonalSkillsScreen,
}));
const PersonalMcpScreen = React.lazy(async () => ({
  default: (await import("./personal-mcp-screen")).PersonalMcpScreen,
}));
const PersonalConnectorsScreen = React.lazy(async () => ({
  default: (await import("./personal-connectors-screen")).PersonalConnectorsScreen,
}));
const PersonalizationSettingsScreen = React.lazy(async () => ({
  default: (await import("./personalization-settings-screen")).PersonalizationSettingsScreen,
}));
const PersonalUsageScreen = React.lazy(async () => ({
  default: (await import("./personal-usage-screen")).PersonalUsageScreen,
}));
const ArchivedTasksScreen = React.lazy(async () => ({
  default: (await import("./archived-chats-screen")).ArchivedTasksScreen,
}));

export function PersonalSettingsScreen({ tab, ...props }: ManagementScreenProps & { tab: string }) {
  let screen: React.ReactNode;
  if (tab === "general") screen = <GeneralSettingsScreen />;
  else if (tab === "account") screen = <AccountSettingsScreen {...props} />;
  else if (tab === "personalization") screen = <PersonalizationSettingsScreen {...props} />;
  else if (tab === "connectors") screen = <PersonalConnectorsScreen {...props} />;
  else if (tab === "skills") screen = <PersonalSkillsScreen {...props} />;
  else if (tab === "mcp") screen = <PersonalMcpScreen {...props} />;
  else if (tab === "usage") screen = <PersonalUsageScreen {...props} />;
  else if (tab === "archived") screen = <ArchivedTasksScreen {...props} />;
  else screen = <GeneralSettingsScreen />;
  return (
    <React.Suspense
      fallback={
        <div className="flex min-h-24 items-center justify-center text-sm text-muted-foreground" role="status" aria-live="polite">
          Loading settings section…
        </div>
      }
    >
      {screen}
    </React.Suspense>
  );
}
