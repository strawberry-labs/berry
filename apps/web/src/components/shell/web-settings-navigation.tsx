import { ArrowLeft } from "lucide-react";
import type { OrgPermission } from "@berry/shared";
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@berry/desktop-ui/components/ui/sidebar";
import {
  ADMIN_NAV,
  PERSONAL_NAV,
  PLATFORM_NAV,
  adminAreaForTab,
  visibleNavigationGroups,
  type ManagementKind,
} from "../management/management-navigation";

export function WebSettingsNavigation({
  kind,
  tab,
  permissions,
  platformAuthorized,
  onNavigate,
  onBack,
}: {
  kind: ManagementKind;
  tab: string;
  permissions: OrgPermission[];
  platformAuthorized: boolean;
  onNavigate: (kind: ManagementKind, tab: string) => void;
  onBack: () => void;
}) {
  const adminGroups = visibleNavigationGroups(ADMIN_NAV, permissions);

  return (
    <>
      <SidebarHeader className="berry-sidebar-header berry-settings-sidebar-header pt-[var(--berry-titlebar-height)]">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton type="button" onClick={onBack} className="berry-sidebar-command">
              <ArrowLeft aria-hidden />
              <span>Back to workspace</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent className="scroll-fade berry-settings-sidebar-content">
        <nav aria-label="Settings and administration">
          {PERSONAL_NAV.map((group) => (
            <NavigationGroup
              key={`settings:${group.label}`}
              group={group}
              kind="settings"
              activeKind={kind}
              activeTab={tab}
              onNavigate={onNavigate}
            />
          ))}
          {adminGroups.map((group, index) => (
            <NavigationGroup
              key={`admin:${group.label || "overview"}`}
              group={group}
              label={group.label || (index === 0 ? "Organization" : "")}
              kind="admin"
              activeKind={kind}
              activeTab={tab}
              onNavigate={onNavigate}
              startsConsole={index === 0}
            />
          ))}
          {platformAuthorized
            ? PLATFORM_NAV.map((group, index) => (
              <NavigationGroup
                key={`platform:${group.label}`}
                group={group}
                kind="platform"
                activeKind={kind}
                activeTab={tab}
                onNavigate={onNavigate}
                startsConsole={index === 0}
              />
            ))
            : null}
        </nav>
      </SidebarContent>
    </>
  );
}

function NavigationGroup({
  group,
  label = group.label,
  kind,
  activeKind,
  activeTab,
  onNavigate,
  startsConsole = false,
}: {
  group: (typeof PERSONAL_NAV)[number];
  label?: string;
  kind: ManagementKind;
  activeKind: ManagementKind;
  activeTab: string;
  onNavigate: (kind: ManagementKind, tab: string) => void;
  startsConsole?: boolean;
}) {
  return (
    <SidebarGroup className="berry-settings-nav-group" data-console-start={startsConsole || undefined}>
      {label ? <SidebarGroupLabel>{label}</SidebarGroupLabel> : null}
      <SidebarMenu>
        {group.items.map((item) => {
          const Icon = item.icon;
          const effectiveActiveTab =
            kind === "admin" ? adminAreaForTab(activeTab).id : activeTab;
          const active = kind === activeKind && item.id === effectiveActiveTab;
          return (
            <SidebarMenuItem key={`${kind}:${item.id}`}>
              <SidebarMenuButton
                type="button"
                isActive={active}
                aria-current={active ? "page" : undefined}
                onClick={() => onNavigate(kind, item.id)}
              >
                <Icon aria-hidden />
                <span>{item.label}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          );
        })}
      </SidebarMenu>
    </SidebarGroup>
  );
}
