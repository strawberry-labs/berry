import * as React from "react";
import type { ManagementScreenProps } from "./management-context";
import { GeneralSettingsScreen } from "./general-settings-screen";

const AccountSettingsScreen = React.lazy(async () => ({
  default: (await import("./account-settings-screen")).AccountSettingsScreen,
}));
const PersonalSkillsScreen = React.lazy(async () => ({
  default: (await import("./personal-capability-screens")).PersonalSkillsScreen,
}));
const PersonalMcpScreen = React.lazy(async () => ({
  default: (await import("./personal-capability-screens")).PersonalMcpScreen,
}));
const PersonalizationSettingsScreen = React.lazy(async () => ({
  default: (await import("./personalization-settings-screen")).PersonalizationSettingsScreen,
}));
const PersonalUsageScreen = React.lazy(async () => ({
  default: (await import("./personal-usage-screen")).PersonalUsageScreen,
}));
const ArchivedChatsScreen = React.lazy(async () => ({
  default: (await import("./archived-chats-screen")).ArchivedChatsScreen,
}));

export function PersonalSettingsScreen({ tab, ...props }: ManagementScreenProps & { tab: string }) {
  if (tab === "general") return <GeneralSettingsScreen />;
  if (tab === "account") return <AccountSettingsScreen {...props} />;
  if (tab === "personalization") return <PersonalizationSettingsScreen {...props} />;
  if (tab === "skills") return <PersonalSkillsScreen {...props} />;
  if (tab === "mcp") return <PersonalMcpScreen {...props} />;
  if (tab === "usage") return <PersonalUsageScreen {...props} />;
  if (tab === "archived") return <ArchivedChatsScreen {...props} />;
  return <GeneralSettingsScreen />;
}
