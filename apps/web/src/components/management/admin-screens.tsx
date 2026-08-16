import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  ManagementPageTabsProvider,
  PermissionDenied,
} from "./management-primitives";
import { type ManagementScreenProps } from "./management-context";
import { adminAreaForTab, resolvedAdminTab } from "./management-navigation";

const AdminOverviewScreen = React.lazy(async () => ({
  default: (await import("./admin-overview-screen")).AdminOverviewScreen,
}));
const AdminMembersScreen = React.lazy(async () => ({
  default: (await import("./admin-members-screen")).AdminMembersScreen,
}));
const AdminDepartmentsScreen = React.lazy(async () => ({
  default: (await import("./admin-departments-screen")).AdminDepartmentsScreen,
}));
const AdminSpendLimitsScreen = React.lazy(async () => ({
  default: (await import("./admin-spend-limits-screen")).AdminSpendLimitsScreen,
}));
const AdminBillingScreen = React.lazy(async () => ({
  default: (await import("./admin-billing-screen")).AdminBillingScreen,
}));
const AdminPolicyScreen = React.lazy(async () => ({
  default: (await import("./admin-policy-screen")).AdminPolicyScreen,
}));
const AdminServiceAccountsScreen = React.lazy(async () => ({
  default: (await import("./admin-service-accounts-screen")).AdminServiceAccountsScreen,
}));
const AnalyticsScreen = React.lazy(async () => ({
  default: (await import("./analytics-screen")).AnalyticsScreen,
}));
const ReportsAlertsScreen = React.lazy(async () => ({
  default: (await import("./reports-alerts-screen")).ReportsAlertsScreen,
}));
const AdminConnectorsScreen = React.lazy(async () => ({
  default: (await import("./admin-connectors-screen")).AdminConnectorsScreen,
}));
const OrganizationProfileScreen = React.lazy(async () => ({
  default: (await import("./organization-profile-screen")).OrganizationProfileScreen,
}));
const AdminRolesScreen = React.lazy(async () => ({ default: (await import("./admin-roles-screen")).AdminRolesScreen }));
const AdminResourceAccessScreen = React.lazy(async () => ({ default: (await import("./admin-resource-access-screen")).AdminResourceAccessScreen }));
const AdminProvidersScreen = React.lazy(async () => ({ default: (await import("./admin-providers-screen")).AdminProvidersScreen }));
const AdminModelsScreen = React.lazy(async () => ({ default: (await import("./admin-models-screen")).AdminModelsScreen }));
const AdminSkillsMcpScreen = React.lazy(async () => ({ default: (await import("./admin-skills-mcp-screen")).AdminSkillsMcpScreen }));
const AdminFeatureAccessScreen = React.lazy(async () => ({ default: (await import("./admin-feature-access-screen")).AdminFeatureAccessScreen }));
const AdminSsoScimScreen = React.lazy(async () => ({ default: (await import("./admin-sso-scim-screen")).AdminSsoScimScreen }));
const AdminManagedPolicyScreen = React.lazy(async () => ({ default: (await import("./admin-managed-policy-screen")).AdminManagedPolicyScreen }));
const AdminAuditLogScreen = React.lazy(async () => ({ default: (await import("./admin-audit-log-screen")).AdminAuditLogScreen }));

const fallback = (
  <div
    className="flex min-h-24 items-center justify-center text-sm text-muted-foreground"
    role="status"
    aria-live="polite"
  >
    Loading administration section…
  </div>
);

export function AdminScreen({
  tab,
  ...p
}: ManagementScreenProps & { tab: string }) {
  const navigate = useNavigate();
  const area = adminAreaForTab(tab);
  const resolvedTab = resolvedAdminTab(tab, p.permissions);
  if (!p.permissions.includes("org:admin"))
    return <PermissionDenied label="Organization administration" />;
  const read = permissionFor(resolvedTab);
  if (read && !p.permissions.includes(read as any))
    return <PermissionDenied label={titleFor(resolvedTab)} />;

  const visibleTabs = area.tabs.filter(
    (item) => !item.permission || p.permissions.includes(item.permission),
  );
  let screen: React.ReactNode;
  if (resolvedTab === "overview") screen = <AdminOverviewScreen {...p} />;
  else if (resolvedTab === "members") screen = <AdminMembersScreen {...p} />;
  else if (resolvedTab === "departments") screen = <AdminDepartmentsScreen {...p} />;
  else if (resolvedTab === "analytics") screen = <AnalyticsScreen {...p} />;
  else if (resolvedTab === "spend-limits") screen = <AdminSpendLimitsScreen {...p} />;
  else if (resolvedTab === "credits-billing") screen = <AdminBillingScreen {...p} />;
  else if (resolvedTab === "reports-alerts") screen = <ReportsAlertsScreen {...p} />;
  else if (["execution-network", "authentication", "data-governance"].includes(resolvedTab)) {
    screen = <AdminPolicyScreen kind={resolvedTab === "execution-network" ? "execution" : resolvedTab === "authentication" ? "authentication" : "data"} {...p} />;
  } else if (resolvedTab === "service-accounts") screen = <AdminServiceAccountsScreen {...p} />;
  else if (resolvedTab === "connectors") screen = <AdminConnectorsScreen {...p} />;
  else if (resolvedTab === "profile-domains") screen = <OrganizationProfileScreen {...p} />;
  else if (resolvedTab === "roles") screen = <AdminRolesScreen {...p} />;
  else if (resolvedTab === "resource-access") screen = <AdminResourceAccessScreen {...p} />;
  else if (resolvedTab === "providers") screen = <AdminProvidersScreen {...p} />;
  else if (resolvedTab === "models") screen = <AdminModelsScreen {...p} />;
  else if (resolvedTab === "skills-mcp") screen = <AdminSkillsMcpScreen {...p} />;
  else if (resolvedTab === "feature-access") screen = <AdminFeatureAccessScreen {...p} />;
  else if (resolvedTab === "sso-scim") screen = <AdminSsoScimScreen {...p} />;
  else if (resolvedTab === "managed-policy") screen = <AdminManagedPolicyScreen {...p} />;
  else if (resolvedTab === "audit-log") screen = <AdminAuditLogScreen {...p} />;
  else screen = <PermissionDenied label={titleFor(resolvedTab)} />;

  return (
    <ManagementPageTabsProvider
      value={{
        activeTab: resolvedTab,
        ariaLabel: `${area.label} sections`,
        tabs: visibleTabs,
        onTabChange: (nextTab) => {
          void navigate({
            to: "/admin/$tab",
            params: { tab: nextTab },
            search: {},
          });
        },
      }}
    >
      <React.Suspense fallback={fallback}>{screen}</React.Suspense>
    </ManagementPageTabsProvider>
  );
}

export function permissionFor(tab: string) {
  return ({
    overview: "org:read",
    members: "members:read",
    departments: "departments:read",
    roles: "rbac:read",
    "resource-access": "acl:read",
    providers: "models:read",
    models: "models:read",
    "skills-mcp": "org:read",
    analytics: "usage:read",
    "spend-limits": "budgets:read",
    "credits-billing": "billing:read",
    "reports-alerts": "reports:read",
    "execution-network": "guardrails:read",
    authentication: "auth_policy:read",
    "data-governance": "data_policy:read",
    "service-accounts": "service_accounts:read",
    connectors: "mcp:read",
    "profile-domains": "org_settings:read",
    "feature-access": "feature_flags:read",
    "sso-scim": "sso:read",
    "managed-policy": "policy:read",
    "audit-log": "audit:read",
  } as Record<string, string>)[tab];
}

function titleFor(tab: string) {
  return tab
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (value) => value.toUpperCase());
}
