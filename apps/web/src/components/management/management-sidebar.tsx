import { Building2, ShieldCheck, SquareArrowOutUpRight } from "lucide-react";
import type { OrgPermission } from "@berry/shared";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@berry/desktop-ui/components/ui/sidebar";
import { ADMIN_NAV, PERSONAL_NAV, PLATFORM_NAV, type ManagementKind } from "./management-navigation";
import { Button } from "./management-primitives";

export function ManagementSidebar({ kind, tab, permissions, platformAuthorized, onNavigate, onBack }: {
  kind: ManagementKind; tab: string; permissions: OrgPermission[]; platformAuthorized: boolean;
  onNavigate: (kind: ManagementKind, tab: string) => void; onBack: () => void;
}) {
  const { isMobile, setOpenMobile } = useSidebar();
  const groups = kind === "settings" ? PERSONAL_NAV : kind === "admin" ? ADMIN_NAV : PLATFORM_NAV;
  const visible = groups.map((group) => ({ ...group, items: group.items.filter((item) => !item.permission || permissions.includes(item.permission)) })).filter((group) => group.items.length);
  const canOpenAdmin = ADMIN_NAV.some((group) => group.items.some((item) => !item.permission || permissions.includes(item.permission)));
  const navigate = (nextKind: ManagementKind, nextTab: string) => {
    onNavigate(nextKind, nextTab);
    if (isMobile) setOpenMobile(false);
  };

  return (
    <Sidebar variant="inset" className="berry-app-sidebar berry-management-sidebar">
      <SidebarHeader className="berry-sidebar-header mgmt-sidebar-top pt-[var(--berry-titlebar-height)]">
        <Button type="button" size="sm" variant="ghost" className="mgmt-back" onClick={onBack}><span aria-hidden="true">←</span><span>Back to workspace</span></Button>
        {kind === "platform" ? <div className="mgmt-environment"><ShieldCheck aria-hidden /><span>Platform console</span><b>Production</b></div> : null}
      </SidebarHeader>
      <SidebarContent className="scroll-fade berry-app-sidebar berry-management-sidebar">
        <nav aria-label={kind === "settings" ? "Personal settings" : kind === "admin" ? "Organization administration" : "Platform administration"}>
          {visible.map((group) => (
            <SidebarGroup key={group.label || "overview"} className="mgmt-nav-group">
              {group.label ? <SidebarGroupLabel>{group.label}</SidebarGroupLabel> : null}
              <SidebarMenu>
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const active = tab === item.id;
                  return <SidebarMenuItem key={item.id}><SidebarMenuButton type="button" isActive={active} aria-current={active ? "page" : undefined} onClick={() => navigate(kind, item.id)}><Icon aria-hidden /><span>{item.label}</span></SidebarMenuButton></SidebarMenuItem>;
                })}
              </SidebarMenu>
            </SidebarGroup>
          ))}
          {kind === "settings" && (canOpenAdmin || platformAuthorized) ? (
            <SidebarGroup className="mgmt-nav-group mgmt-admin-link">
              <SidebarGroupLabel>Administration</SidebarGroupLabel>
              <SidebarMenu>
                {canOpenAdmin ? <SidebarMenuItem><SidebarMenuButton type="button" onClick={() => navigate("admin", "overview")}><ShieldCheck aria-hidden /><span>Open admin console</span><SquareArrowOutUpRight aria-hidden className="mgmt-nav-external" /></SidebarMenuButton></SidebarMenuItem> : null}
                {platformAuthorized ? <SidebarMenuItem><SidebarMenuButton type="button" onClick={() => navigate("platform", "overview")}><Building2 aria-hidden /><span>Open platform console</span><SquareArrowOutUpRight aria-hidden className="mgmt-nav-external" /></SidebarMenuButton></SidebarMenuItem> : null}
              </SidebarMenu>
            </SidebarGroup>
          ) : null}
        </nav>
      </SidebarContent>
    </Sidebar>
  );
}
