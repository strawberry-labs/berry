import * as React from "react";
import type { ManagementScreenProps } from "./management-context";
import { AccountSettingsSkeleton, ManagementScreenFallback } from "./management-screen-skeletons";

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

const ScheduledTasksScreen = React.lazy(async () => ({ default: (await import("../schedules/scheduled-tasks-screen")).ScheduledTasksScreen }));

const SETTINGS_TABS = new Set(["general", "account", "personalization", "connectors", "skills", "mcp", "schedules", "usage", "archived"]);

export function PersonalSettingsScreen({ tab, ...props }: ManagementScreenProps & { tab: string }) {
  let screen: React.ReactNode;
  if (tab === "general") screen = <GeneralSettingsScreen />;
  else if (tab === "account") screen = <AccountSettingsScreen {...props} />;
  else if (tab === "personalization") screen = <PersonalizationSettingsScreen {...props} />;
  else if (tab === "connectors") screen = <PersonalConnectorsScreen {...props} />;
  else if (tab === "skills") screen = <PersonalSkillsScreen {...props} />;
  else if (tab === "mcp") screen = <PersonalMcpScreen {...props} />;
  else if (tab === "schedules") screen = <ScheduledTasksScreen {...props} />;
  else if (tab === "usage") screen = <PersonalUsageScreen {...props} />;
  else if (tab === "archived") screen = <ArchivedTasksScreen {...props} />;
  else screen = <GeneralSettingsScreen />;
  return (
    <React.Suspense fallback={<ManagementScreenFallback area="settings" tab={SETTINGS_TABS.has(tab) ? tab : "general"} body={tab === "account" ? <AccountSettingsSkeleton accessRows={accessAreaCount(props)} /> : undefined} />}>
      {screen}
    </React.Suspense>
  );
}

/** Permission areas the account page lists, so its placeholder has as many rows. */
function accessAreaCount({ config, tenantId }: ManagementScreenProps): number {
  const permissions = config.rolePermissions.find((entry) => entry.tenantId === tenantId)?.permissions ?? [];
  return new Set(permissions.map((permission) => permission.split(":")[0])).size;
}
