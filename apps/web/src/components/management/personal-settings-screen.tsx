import * as React from "react";
import type { ManagementScreenProps } from "./management-context";
import { GeneralSettingsScreen } from "./general-settings-screen";

const ModelSettingsScreen = React.lazy(async () => ({
  default: (await import("./model-settings-screen")).ModelSettingsScreen,
}));
const PersonalSkillsScreen = React.lazy(async () => ({
  default: (await import("./personal-capability-screens")).PersonalSkillsScreen,
}));
const PersonalMcpScreen = React.lazy(async () => ({
  default: (await import("./personal-capability-screens")).PersonalMcpScreen,
}));
const PromptsSettingsScreen = React.lazy(async () => ({
  default: (await import("./prompts-settings-screen")).PromptsSettingsScreen,
}));
const MemorySettingsScreen = React.lazy(async () => ({
  default: (await import("./memory-settings-screen")).MemorySettingsScreen,
}));
const PrivacySettingsScreen = React.lazy(async () => ({
  default: (await import("./privacy-settings-screen")).PrivacySettingsScreen,
}));
const PersonalUsageScreen = React.lazy(async () => ({
  default: (await import("./personal-usage-screen")).PersonalUsageScreen,
}));
const ArchivedChatsScreen = React.lazy(async () => ({
  default: (await import("./archived-chats-screen")).ArchivedChatsScreen,
}));

export function PersonalSettingsScreen({ tab, ...props }: ManagementScreenProps & { tab: string }) {
  if (tab === "general") return <GeneralSettingsScreen />;
  if (tab === "providers") return <ModelSettingsScreen {...props} />;
  if (tab === "skills") return <PersonalSkillsScreen {...props} />;
  if (tab === "mcp") return <PersonalMcpScreen {...props} />;
  if (tab === "prompts") return <PromptsSettingsScreen onUsePrompt={props.onUsePrompt} />;
  if (tab === "memory") return <MemorySettingsScreen {...props} />;
  if (tab === "privacy") return <PrivacySettingsScreen {...props} />;
  if (tab === "usage") return <PersonalUsageScreen {...props} />;
  if (tab === "archived") return <ArchivedChatsScreen {...props} />;
  return <GeneralSettingsScreen />;
}
