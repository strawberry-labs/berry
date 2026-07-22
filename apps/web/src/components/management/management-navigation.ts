import type { OrgPermission } from "@berry/shared";
import {
  Activity, Blocks, Boxes, Building2, CreditCard, Database, FileClock, Flag, GitBranch,
  KeyRound, Landmark, LayoutDashboard, LineChart, ListChecks, Lock, MessageSquareText,
  Network, Puzzle, ScrollText, ShieldCheck, SlidersHorizontal, Terminal, UserCog, Users, Wallet,
  type LucideIcon,
} from "lucide-react";
export type ManagementKind = "settings" | "admin" | "platform";
export type NavItem = { id: string; label: string; icon: LucideIcon; permission?: OrgPermission };
export type NavGroup = { label: string; items: NavItem[] };
export const PERSONAL_NAV: NavGroup[] = [
  { label: "Personal", items: [
    { id: "general", label: "General", icon: SlidersHorizontal },
    { id: "providers", label: "Models", icon: Boxes },
  ] },
  { label: "Capabilities", items: [
    { id: "skills", label: "Skills", icon: Puzzle },
    { id: "mcp", label: "MCP servers", icon: Network },
    { id: "prompts", label: "Prompts & commands", icon: Terminal },
  ] },
  { label: "Account & data", items: [
    { id: "privacy", label: "Privacy & permissions", icon: ShieldCheck },
    { id: "usage", label: "My usage", icon: LineChart },
    { id: "archived", label: "Archived chats", icon: MessageSquareText },
  ] },
];
export const ADMIN_NAV: NavGroup[] = [
  { label: "", items: [
    { id: "overview", label: "Overview", icon: LayoutDashboard, permission: "org:read" },
  ] },
  { label: "People", items: [
    { id: "members", label: "Members", icon: Users, permission: "members:read" },
    { id: "departments", label: "Departments", icon: Building2, permission: "departments:read" },
  ] },
  { label: "Access", items: [
    { id: "roles", label: "Roles & permissions", icon: UserCog, permission: "rbac:read" },
    { id: "resource-access", label: "Resource access", icon: Lock, permission: "acl:read" },
  ] },
  { label: "AI controls", items: [
    { id: "models", label: "Models", icon: Boxes, permission: "models:read" },
    { id: "skills-mcp", label: "Skills & MCP", icon: Blocks, permission: "org:read" },
    { id: "feature-access", label: "Feature access", icon: Flag, permission: "feature_flags:read" },
    { id: "execution-network", label: "Execution & network", icon: Terminal, permission: "guardrails:read" },
  ] },
  { label: "Finance", items: [
    { id: "analytics", label: "Analytics", icon: LineChart, permission: "usage:read" },
    { id: "spend-limits", label: "Spend limits", icon: Wallet, permission: "budgets:read" },
    { id: "credits-billing", label: "Credits & billing", icon: CreditCard, permission: "billing:read" },
    { id: "reports-alerts", label: "Reports & alerts", icon: ListChecks, permission: "reports:read" },
  ] },
  { label: "Security & data", items: [
    { id: "sso-scim", label: "SSO & SCIM", icon: KeyRound, permission: "sso:read" },
    { id: "managed-policy", label: "Managed policy", icon: ScrollText, permission: "policy:read" },
    { id: "authentication", label: "Authentication", icon: Lock, permission: "auth_policy:read" },
    { id: "data-governance", label: "Data governance", icon: Database, permission: "data_policy:read" },
    { id: "service-accounts", label: "Service accounts", icon: KeyRound, permission: "service_accounts:read" },
    { id: "audit-log", label: "Audit log", icon: FileClock, permission: "audit:read" },
  ] },
  { label: "Organization", items: [
    { id: "profile-domains", label: "Profile & domains", icon: Landmark, permission: "org_settings:read" },
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
