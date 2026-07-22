import {
  ArrowLeft,
  ChartColumn,
  CodeXml,
  Plug,
  Server,
  ShieldCheck,
  ShieldQuestion,
  SlidersHorizontal,
  SquareTerminal,
  Users,
  WandSparkles,
  Wrench,
  type LucideIcon,
} from "@berry/desktop-ui/lib/icons";
import {
  SidebarContent,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@berry/desktop-ui/components/ui/sidebar";

import { useWorkbench, type SettingsPage } from "@/lib/berry";

interface NavItem {
  page: SettingsPage;
  label: string;
  icon: LucideIcon;
}

const NAV_ITEMS: NavItem[] = [
  { page: "general", label: "General", icon: SlidersHorizontal },
  { page: "code-preview", label: "Code preview", icon: CodeXml },
  { page: "models", label: "Model settings", icon: Server },
  { page: "skills", label: "Skills", icon: WandSparkles },
  { page: "subagents", label: "Sub-agents", icon: Users },
  { page: "mcp", label: "MCP Servers", icon: Plug },
  { page: "commands", label: "Commands", icon: SquareTerminal },
  { page: "plugins", label: "Plugins", icon: Wrench },
  { page: "security", label: "Security", icon: ShieldQuestion },
  { page: "indexing", label: "Indexing", icon: ShieldCheck },
  { page: "usage", label: "Usage", icon: ChartColumn },
];

/**
 * Settings navigation, rendered inside the app sidebar (replacing the workspace
 * nav) while a settings page is open. Mirrors the workspace sidebar styling so
 * the switch reads as the same sidebar, not a second one.
 */
export function SettingsNav({ page }: { page: SettingsPage }) {
  const { setView, openHome } = useWorkbench();
  return (
    <>
      <SidebarHeader className="berry-sidebar-header pt-[var(--berry-titlebar-height)]">
        <SidebarMenu className="berry-sidebar-commands">
          <SidebarMenuItem>
            <SidebarMenuButton onClick={openHome} className="berry-sidebar-command">
              <ArrowLeft />
              <span>Back to workspace</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent className="scroll-fade">
        <SidebarGroup className="berry-sidebar-project-group">
          <nav aria-label="Settings">
            <SidebarMenu className="berry-sidebar-tree gap-0.5">
              {NAV_ITEMS.map((item) => (
                <SidebarMenuItem key={item.page}>
                  <SidebarMenuButton
                    isActive={item.page === page}
                    aria-current={item.page === page ? "page" : undefined}
                    onClick={() => setView({ kind: "settings", page: item.page })}
                    className="berry-sidebar-workspace-row"
                  >
                    <item.icon />
                    <span className="truncate">{item.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </nav>
        </SidebarGroup>
      </SidebarContent>
    </>
  );
}
