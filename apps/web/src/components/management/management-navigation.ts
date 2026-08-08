import type { OrgPermission } from "@berry/shared";
import {
  Activity, Bot, Building2, Database, FileClock, GitBranch, KeyRound, Landmark,
  LayoutDashboard, LineChart, Lock, MessageSquareText, Network, PlugZap, Puzzle, ScrollText,
  ShieldCheck, SlidersHorizontal, Sparkles, User, Users,
  type LucideIcon,
} from "lucide-react";
export type ManagementKind = "settings" | "admin" | "platform";
export type NavItem = {
  id: string;
  label: string;
  icon: LucideIcon;
  permission?: OrgPermission;
  permissions?: readonly OrgPermission[];
};
export type NavGroup = { label: string; items: NavItem[] };

export type AdminAreaId =
  | "overview"
  | "people"
  | "access-control"
  | "ai-tools"
  | "usage-billing"
  | "identity-security"
  | "data-privacy"
  | "audit-log"
  | "organization";

export type AdminAreaTab = {
  id: string;
  label: string;
  permission?: OrgPermission;
};

export type AdminArea = {
  id: AdminAreaId;
  label: string;
  tabs: readonly AdminAreaTab[];
};

export const ADMIN_AREAS: readonly AdminArea[] = [
  {
    id: "overview",
    label: "Overview",
    tabs: [{ id: "overview", label: "Summary", permission: "org:read" }],
  },
  {
    id: "people",
    label: "People",
    tabs: [
      { id: "members", label: "Members", permission: "members:read" },
      { id: "departments", label: "Departments", permission: "departments:read" },
    ],
  },
  {
    id: "access-control",
    label: "Access control",
    tabs: [
      { id: "roles", label: "Roles & permissions", permission: "rbac:read" },
      { id: "resource-access", label: "Resource access", permission: "acl:read" },
    ],
  },
  {
    id: "ai-tools",
    label: "AI & tools",
    tabs: [
      { id: "providers", label: "Providers", permission: "models:read" },
      { id: "models", label: "Models", permission: "models:read" },
      { id: "connectors", label: "Connectors", permission: "mcp:read" },
      { id: "skills-mcp", label: "Skills & MCP", permission: "org:read" },
      { id: "feature-access", label: "Feature access", permission: "feature_flags:read" },
      { id: "execution-network", label: "Execution & network", permission: "guardrails:read" },
    ],
  },
  {
    id: "usage-billing",
    label: "Usage & billing",
    tabs: [
      { id: "analytics", label: "Usage", permission: "usage:read" },
      { id: "spend-limits", label: "Allowances", permission: "budgets:read" },
      { id: "credits-billing", label: "Billing", permission: "billing:read" },
      { id: "reports-alerts", label: "Reports & alerts", permission: "reports:read" },
    ],
  },
  {
    id: "identity-security",
    label: "Identity & security",
    tabs: [
      { id: "authentication", label: "Sign-in", permission: "auth_policy:read" },
      { id: "managed-policy", label: "Managed policy", permission: "policy:read" },
      { id: "service-accounts", label: "Service accounts", permission: "service_accounts:read" },
    ],
  },
  {
    id: "data-privacy",
    label: "Data & privacy",
    tabs: [{ id: "data-governance", label: "Governance", permission: "data_policy:read" }],
  },
  {
    id: "audit-log",
    label: "Audit log",
    tabs: [{ id: "audit-log", label: "Events", permission: "audit:read" }],
  },
  {
    id: "organization",
    label: "Organization",
    tabs: [{ id: "profile-domains", label: "Profile & domains", permission: "org_settings:read" }],
  },
] as const;

const ADMIN_AREA_BY_ID = new Map(ADMIN_AREAS.map((area) => [area.id, area]));

export function adminAreaForTab(tab: string): AdminArea {
  return (
    ADMIN_AREA_BY_ID.get(tab as AdminAreaId) ??
    ADMIN_AREAS.find((area) => area.tabs.some((item) => item.id === tab)) ??
    ADMIN_AREAS[0]!
  );
}

export function resolvedAdminTab(
  tab: string,
  permissions: readonly OrgPermission[],
): string {
  const area = adminAreaForTab(tab);
  if (area.id !== tab) return tab;
  return (
    area.tabs.find((item) => !item.permission || permissions.includes(item.permission))?.id ??
    area.tabs[0]!.id
  );
}
export const PERSONAL_NAV: NavGroup[] = [
  { label: "", items: [
    { id: "general", label: "General", icon: SlidersHorizontal },
    { id: "account", label: "Account", icon: User },
    { id: "personalization", label: "Personalization", icon: Sparkles },
    { id: "connectors", label: "Connectors", icon: PlugZap },
    { id: "skills", label: "Skills", icon: Puzzle },
    { id: "mcp", label: "MCP servers", icon: Network },
    { id: "usage", label: "Usage", icon: LineChart },
    { id: "archived", label: "Archived chats", icon: MessageSquareText },
  ] },
];
export const ADMIN_NAV: NavGroup[] = [
  { label: "", items: [
    { id: "overview", label: "Overview", icon: LayoutDashboard, permission: "org:read" },
    { id: "people", label: "People", icon: Users, permissions: ["members:read", "departments:read"] },
    { id: "access-control", label: "Access control", icon: Lock, permissions: ["rbac:read", "acl:read"] },
    { id: "ai-tools", label: "AI & tools", icon: Bot, permissions: ["models:read", "mcp:read", "org:read", "feature_flags:read", "guardrails:read"] },
    { id: "usage-billing", label: "Usage & billing", icon: LineChart, permissions: ["usage:read", "budgets:read", "billing:read", "reports:read"] },
    { id: "identity-security", label: "Identity & security", icon: ShieldCheck, permissions: ["auth_policy:read", "policy:read", "service_accounts:read"] },
    { id: "data-privacy", label: "Data & privacy", icon: Database, permission: "data_policy:read" },
    { id: "audit-log", label: "Audit log", icon: FileClock, permission: "audit:read" },
    { id: "organization", label: "Organization", icon: Landmark, permission: "org_settings:read" },
  ] },
];
export const PLATFORM_NAV: NavGroup[] = [
  { label: "Platform", items: [
    { id: "overview", label: "Overview", icon: LayoutDashboard },
    { id: "organizations", label: "Organizations", icon: Building2 },
    { id: "router-health", label: "Router health", icon: Activity },
    { id: "billing-operations", label: "Billing operations", icon: Landmark },
    { id: "feature-rollout", label: "Feature rollout", icon: GitBranch },
  ] },
];
export const PERSONAL_TABS = PERSONAL_NAV.flatMap((g) => g.items.map((i) => i.id));
export const ADMIN_TABS = ADMIN_NAV.flatMap((g) => g.items.map((i) => i.id));
export const PLATFORM_TABS = PLATFORM_NAV.flatMap((g) => g.items.map((i) => i.id));

export function visibleNavigationGroups(groups: NavGroup[], permissions: readonly OrgPermission[]): NavGroup[] {
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter(
        (item) =>
          (!item.permission || permissions.includes(item.permission)) &&
          (!item.permissions || item.permissions.some((permission) => permissions.includes(permission))),
      ),
    }))
    .filter((group) => group.items.length > 0);
}

export function visibleAdministrationGroups(permissions: readonly OrgPermission[]): NavGroup[] {
  if (!permissions.includes("org:admin")) return [];
  return visibleNavigationGroups(ADMIN_NAV, permissions);
}
