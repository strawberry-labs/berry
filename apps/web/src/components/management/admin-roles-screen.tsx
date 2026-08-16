import * as React from "react";
import {
  Activity,
  Check,
  Copy,
  Download,
  Plus,
  Save,
  ShieldCheck,
  Trash2,
  Upload,
} from "lucide-react";
import {
  ORGANIZATION_SKILL_PACKAGE_MAX_BYTES,
  OrgPermissionSchema,
  type OrgCapabilityAssignment,
  type OrgPermission,
  type PersonalSkillReview,
} from "@berry/shared";
import { readBrowserSkillImport } from "@/lib/skill-import";
import {
  AsyncState,
  Button,
  Checkbox,
  DataTable,
  DefinitionList,
  DetailDrawer,
  FilterSelect,
  FormSelect,
  Input,
  ManagementDialog,
  ManagementPage,
  ManagementSwitch,
  MetricGrid,
  PermissionDenied,
  SearchInput,
  Section,
  StatusPill,
  SuccessMessage,
  TabBar,
  Textarea,
  Toolbar,
  formatDate,
  formatDateTime,
  formatNumber,
} from "./management-primitives";
import { useResource, type ManagementScreenProps } from "./management-context";

/* ------------------------------------------------------------------ helpers */
const ALL_PERMISSIONS = OrgPermissionSchema.options as OrgPermission[];
const PERMISSION_DOMAINS: Array<{ id: string; label: string }> = [
  { id: "org", label: "Organization" },
  { id: "org_settings", label: "Organization settings" },
  { id: "members", label: "People" },
  { id: "departments", label: "Departments" },
  { id: "rbac", label: "Roles" },
  { id: "acl", label: "Resource access" },
  { id: "models", label: "Models" },
  { id: "skills", label: "Skills" },
  { id: "mcp", label: "MCP" },
  { id: "feature_flags", label: "Feature access" },
  { id: "guardrails", label: "Execution & network" },
  { id: "usage", label: "Usage" },
  { id: "budgets", label: "Budgets" },
  { id: "billing", label: "Billing" },
  { id: "reports", label: "Reports" },
  { id: "alerts", label: "Alerts" },
  { id: "sso", label: "SSO & SCIM" },
  { id: "policy", label: "Managed policy" },
  { id: "auth_policy", label: "Authentication" },
  { id: "data_policy", label: "Data governance" },
  { id: "service_accounts", label: "Service accounts" },
  { id: "audit", label: "Audit" },
];
function humanize(value: string) {
  return value
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
function domainOf(permission: string) {
  return permission.split(":")[0];
}
function actionOf(permission: string) {
  return permission.split(":")[1] ?? "read";
}
function copyText(value: string) {
  void navigator.clipboard?.writeText(value).catch(() => {});
}
function formatPackageBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* -------------------------------------------------------------------- roles */
export function AdminRolesScreen({
  client,
  config,
  tenantId,
  permissions,
}: ManagementScreenProps) {
  const canWrite = permissions.includes("rbac:write");
  const r = useResource(
    `roles:${tenantId}`,
    async () =>
      client
        ? client.listRolePermissions(tenantId)
        : config.rolePermissions.filter((x) => x.tenantId === tenantId),
    [] as any[],
  );
  const [selected, setSelected] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState<Set<OrgPermission> | null>(null);
  const [message, setMessage] = React.useState("");
  const roleOrder = new Map([["owner", 0], ["admin", 1], ["member", 2]]);
  const roles = [...r.data].sort((left: any, right: any) => (roleOrder.get(left.role) ?? 99) - (roleOrder.get(right.role) ?? 99) || left.role.localeCompare(right.role));
  const active = r.data.find((role: any) => role.role === selected) ?? null;
  const isSystem = active?.source === "system";
  React.useEffect(() => {
    if (roles.length > 0 && !roles.some((role: any) => role.role === selected)) setSelected(roles[0].role);
  }, [r.data, selected]);
  React.useEffect(() => {
    setDraft(active ? new Set(active.permissions) : null);
    setMessage("");
  }, [selected, r.data]);
  const dirty =
    Boolean(active && draft) &&
    (draft!.size !== active!.permissions.length ||
      active!.permissions.some((p: OrgPermission) => !draft!.has(p)));
  const toggle = (permission: OrgPermission) => {
    if (!draft || isSystem || !canWrite) return;
    const next = new Set(draft);
    next.has(permission) ? next.delete(permission) : next.add(permission);
    setDraft(next);
  };
  const save = async () => {
    if (!active || !draft) return;
    const nextPermissions = [...draft];
    await client?.updateRolePermissions(tenantId, active.role, {
      permissions: nextPermissions,
    });
    r.setData(
      r.data.map((role: any) =>
        role.role === active.role
          ? {
              ...role,
              permissions: nextPermissions,
              updatedAt: new Date().toISOString(),
            }
          : role,
      ),
    );
    setMessage("Role permissions saved and recorded in the audit log.");
  };
  return (
    <ManagementPage
      title="Roles & permissions"
      description="Review organization roles horizontally, then inspect each permission group below."
      eyebrow="Access"
    >
      <AsyncState loading={r.loading} error={r.error} onRetry={r.retry} empty={roles.length === 0} emptyTitle="No roles configured">
        <div className="grid min-w-0 gap-4">
          <TabBar
            label="Organization roles"
            active={selected ?? ""}
            onSelect={setSelected}
            tabs={roles.map((role: any) => ({ id: role.role, label: `${humanize(role.role)} · ${role.permissions.length}` }))}
          />
          {active && draft ? (
            <Section
              title={humanize(active.role)}
              description={
                isSystem
                  ? "System role — permissions are managed by Berry and cannot be changed."
                  : "Toggle the permissions granted to this role."
              }
              actions={
                canWrite && !isSystem ? (
                  <Button onClick={save} disabled={!dirty}>
                    <Save aria-hidden />
                    Save role
                  </Button>
                ) : null
              }
            >
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {PERMISSION_DOMAINS.map((domain) => {
                  const perms = ALL_PERMISSIONS.filter(
                    (p) => domainOf(p) === domain.id,
                  );
                  if (!perms.length) return null;
                  return (
                    <fieldset
                      key={domain.id}
                      className="grid gap-1.5 border-0 p-0 [&_legend]:mb-1 [&_legend]:text-xs [&_legend]:font-semibold"
                    >
                      <legend>{domain.label}</legend>
                      {perms.map((permission) => (
                        <label
                          key={permission}
                          className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-2.5 py-2 text-xs [&_code]:ml-auto [&_code]:font-mono [&_code]:text-xs [&_code]:text-muted-foreground"
                        >
                          <Checkbox
                            checked={draft.has(permission)}
                            disabled={isSystem || !canWrite}
                            onCheckedChange={() => toggle(permission)}
                          />
                          <span>{humanize(actionOf(permission))}</span>
                          <code>{permission}</code>
                        </label>
                      ))}
                    </fieldset>
                  );
                })}
              </div>
              {message ? <SuccessMessage>{message}</SuccessMessage> : null}
            </Section>
          ) : (
            <div className="flex min-h-48 items-center justify-center rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              <p>Select a role to review or edit its permissions.</p>
            </div>
          )}
        </div>
      </AsyncState>
    </ManagementPage>
  );
}

/* --------------------------------------------------------- resource access */
