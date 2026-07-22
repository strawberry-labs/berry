export const USER_SETTINGS_TABS = ["general", "providers", "skills", "mcp", "prompts", "privacy", "usage", "archived"] as const;
export type UserSettingsTab = (typeof USER_SETTINGS_TABS)[number];
export const ARTIFACT_LIBRARY_TABS = ["images", "documents"] as const;
export type ArtifactLibraryTab = (typeof ARTIFACT_LIBRARY_TABS)[number];
export const ADMIN_TABS=["overview","members","departments","roles","resource-access","models","skills-mcp","feature-access","execution-network","analytics","spend-limits","credits-billing","reports-alerts","sso-scim","managed-policy","authentication","data-governance","service-accounts","audit-log","profile-domains"]as const;
export const PLATFORM_TABS=["overview","organizations","router-health","billing-operations","feature-rollout"]as const;

export type CloudShellLocation =
  | { kind: "home" }
  | { kind: "task"; taskId: string }
  | { kind: "settings"; tab: UserSettingsTab }
  | { kind: "library"; tab: ArtifactLibraryTab }
  | { kind: "admin"; tab: string }
  | { kind: "platform"; tab: string };

export function parseCloudShellLocation(pathname: string): CloudShellLocation {
  const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "tasks" && parts[1]) return { kind: "task", taskId: parts[1] };
  if (parts[0] === "settings") {
    const tab = USER_SETTINGS_TABS.find((candidate) => candidate === parts[1]) ?? "general";
    return { kind: "settings", tab };
  }
  if (parts[0] === "library") {
    const tab = ARTIFACT_LIBRARY_TABS.find((candidate) => candidate === parts[1]) ?? "images";
    return { kind: "library", tab };
  }
  if (parts[0] === "admin") return { kind: "admin", tab: ADMIN_TABS.find((candidate)=>candidate===parts[1]) ?? "overview" };
  if (parts[0] === "platform") return { kind: "platform", tab: PLATFORM_TABS.find((candidate)=>candidate===parts[1]) ?? "overview" };
  return { kind: "home" };
}

export function settingsPath(tab: UserSettingsTab): "/settings/$tab" {
  void tab;
  return "/settings/$tab";
}
