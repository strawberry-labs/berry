import * as React from "react";
import { Check, LockKeyhole, Minus, Save } from "lucide-react";
import { OrgPermissionSchema, type OrgPermission } from "@berry/shared";
import {
  AsyncState,
  Button,
  Checkbox,
  InlineNotice,
  ManagementPage,
  Section,
  SuccessMessage,
} from "./management-primitives";
import { useResource, type ManagementScreenProps } from "./management-context";
import { AdminRolesSkeleton } from "./management-screen-skeletons";

const ALL_PERMISSIONS = OrgPermissionSchema.options as OrgPermission[];
const PERMISSION_DOMAINS: Array<{ id: string; label: string }> = [
  { id: "org", label: "Organization" },
  { id: "org_settings", label: "Organization settings" },
  { id: "members", label: "Members" },
  { id: "departments", label: "Departments" },
  { id: "rbac", label: "Roles & permissions" },
  { id: "acl", label: "Resource access" },
  { id: "models", label: "Providers & models" },
  { id: "skills", label: "Skills" },
  { id: "mcp", label: "Connectors & MCP" },
  { id: "feature_flags", label: "Feature access" },
  { id: "guardrails", label: "Execution & network" },
  { id: "usage", label: "Usage" },
  { id: "budgets", label: "Allowances" },
  { id: "billing", label: "Billing" },
  { id: "reports", label: "Reports" },
  { id: "alerts", label: "Alerts" },
  { id: "sso", label: "SSO & SCIM" },
  { id: "policy", label: "Managed policy" },
  { id: "auth_policy", label: "Sign-in" },
  { id: "data_policy", label: "Data governance" },
  { id: "service_accounts", label: "Service accounts" },
  { id: "audit", label: "Audit log" },
];
const ACTION_LABELS: Record<string, string> = { read: "View", write: "Manage", admin: "Administer" };
const ROLE_ORDER = new Map([["owner", 0], ["admin", 1], ["member", 2]]);

function sentence(value: string) {
  const text = value.replaceAll("_", " ").replaceAll("-", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
function domainOf(permission: string) {
  return permission.split(":")[0] ?? permission;
}
function actionLabel(permission: string) {
  const action = permission.split(":")[1] ?? "read";
  return ACTION_LABELS[action] ?? sentence(action);
}
function joinNames(names: string[]) {
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Every known permission grouped by area; unknown domains fall into a last group. */
const PERMISSION_GROUPS = (() => {
  const known = new Set(PERMISSION_DOMAINS.map((domain) => domain.id));
  const groups = PERMISSION_DOMAINS
    .map((domain) => ({ ...domain, permissions: ALL_PERMISSIONS.filter((permission) => domainOf(permission) === domain.id) }))
    .filter((group) => group.permissions.length > 0);
  const other = ALL_PERMISSIONS.filter((permission) => !known.has(domainOf(permission)));
  return other.length ? [...groups, { id: "other", label: "Other", permissions: other }] : groups;
})();

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
  const [drafts, setDrafts] = React.useState<Record<string, Set<OrgPermission>>>({});
  const [message, setMessage] = React.useState("");
  const [error, setError] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const roles = [...r.data].sort((left: any, right: any) => (ROLE_ORDER.get(left.role) ?? 99) - (ROLE_ORDER.get(right.role) ?? 99) || left.role.localeCompare(right.role));
  React.useEffect(() => {
    setDrafts({});
  }, [r.data]);
  const granted = (role: any): Set<OrgPermission> => drafts[role.role] ?? new Set<OrgPermission>(role.permissions);
  const isDirty = (role: any) => {
    const draft = drafts[role.role];
    return Boolean(draft) && (draft!.size !== role.permissions.length || role.permissions.some((p: OrgPermission) => !draft!.has(p)));
  };
  const dirtyRoles = roles.filter(isDirty);
  const toggle = (role: any, permission: OrgPermission) => {
    if (role.source === "system" || !canWrite || saving) return;
    const next = new Set(granted(role));
    next.has(permission) ? next.delete(permission) : next.add(permission);
    setDrafts((current) => ({ ...current, [role.role]: next }));
    setMessage("");
  };
  const save = async () => {
    if (dirtyRoles.length === 0) return;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      let next = r.data;
      for (const role of dirtyRoles) {
        const nextPermissions = [...drafts[role.role]!];
        await client?.updateRolePermissions(tenantId, role.role, {
          permissions: nextPermissions,
        });
        next = next.map((item: any) =>
          item.role === role.role
            ? { ...item, permissions: nextPermissions, updatedAt: new Date().toISOString() }
            : item,
        );
      }
      r.setData(next);
      setMessage(`${joinNames(dirtyRoles.map((role: any) => sentence(role.role)))} permissions saved and recorded in the audit log.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Role permissions could not be saved.");
    } finally {
      setSaving(false);
    }
  };
  const systemRoles = roles.filter((role: any) => role.source === "system");
  const editableRoles = roles.filter((role: any) => role.source !== "system");
  return (
    <ManagementPage width="wide"
      title="Roles & permissions"
      description="What each role can see and change in organization administration. A member’s role is set under People → Members."
      eyebrow="Access"
    >
      <AsyncState loading={r.loading} error={r.error} onRetry={r.retry} skeleton={<AdminRolesSkeleton />} empty={roles.length === 0} emptyTitle="No roles configured" emptyText="Roles appear here once the organization has been set up.">
        {systemRoles.length ? (
          <InlineNotice tone="info" title={`${joinNames(systemRoles.map((role: any) => sentence(role.role)))} ${systemRoles.length === 1 ? "is a built-in role" : "are built-in roles"}`}>
            Berry maintains {systemRoles.length === 1 ? "its" : "their"} permissions, so {systemRoles.length === 1 ? "it is" : "they are"} shown for reference and cannot be edited.
            {editableRoles.length ? ` You can change ${joinNames(editableRoles.map((role: any) => sentence(role.role)))}.` : ""}
          </InlineNotice>
        ) : null}
        {!canWrite && editableRoles.length ? (
          <InlineNotice tone="info">You can view roles. Changing permissions needs the “Roles &amp; permissions: manage” permission.</InlineNotice>
        ) : null}
        {message ? <SuccessMessage>{message}</SuccessMessage> : null}
        {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}
        <Section
          flush
          title="Permissions by role"
          description="Each row is one permission; a tick means the role has it."
          actions={
            canWrite && editableRoles.length ? (
              <>
                {dirtyRoles.length ? <Button variant="ghost" onClick={() => setDrafts({})} disabled={saving}>Discard</Button> : null}
                <Button onClick={() => void save()} disabled={dirtyRoles.length === 0 || saving}>
                  <Save aria-hidden />
                  {saving ? "Saving…" : "Save permissions"}
                </Button>
              </>
            ) : null
          }
        >
          <div className="max-h-[40rem] overflow-auto" role="region" aria-label="Permission matrix" tabIndex={0}>
            <table className="w-full border-collapse text-md" style={{ minWidth: `${260 + roles.length * 96}px` }}>
              <thead className="sticky top-0 z-10 bg-[var(--berry-surface-under)]">
                <tr className="border-b border-border">
                  <th scope="col" className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">Permission</th>
                  {roles.map((role: any) => (
                    <th key={role.role} scope="col" className="w-24 px-2 py-2 text-center align-bottom">
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-foreground">
                        {role.source === "system" ? <LockKeyhole className="size-3 text-muted-foreground" aria-label="Built-in role" /> : null}
                        {sentence(role.role)}
                      </span>
                      <span className="block text-xs font-normal tabular-nums text-muted-foreground">
                        {granted(role).size} of {ALL_PERMISSIONS.length}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              {PERMISSION_GROUPS.map((group) => (
                <tbody key={group.id}>
                  <tr className="border-b border-border">
                    <th scope="colgroup" colSpan={roles.length + 1} className="px-4 pb-1.5 pt-4 text-left text-xs font-semibold text-foreground">
                      {group.label}
                    </th>
                  </tr>
                  {group.permissions.map((permission) => (
                    <tr key={permission} className="border-b border-border last:border-b-0 hover:bg-[var(--berry-hover)]">
                      <th scope="row" className="px-4 py-1.5 text-left font-normal">
                        <span className="flex flex-wrap items-baseline gap-x-2">
                          <span className="text-foreground">{actionLabel(permission)}</span>
                          <code className="text-muted-foreground">{permission}</code>
                        </span>
                      </th>
                      {roles.map((role: any) => {
                        const has = granted(role).has(permission);
                        const locked = role.source === "system" || !canWrite;
                        return (
                          <td key={role.role} className="px-2 py-1.5 text-center">
                            {locked ? (
                              has ? (
                                <Check className="mx-auto size-4 text-foreground" aria-label="Granted" />
                              ) : (
                                <Minus className="mx-auto size-3.5 text-muted-foreground opacity-50" aria-label="Not granted" />
                              )
                            ) : (
                              <Checkbox
                                className="mx-auto"
                                checked={has}
                                disabled={saving}
                                onCheckedChange={() => toggle(role, permission)}
                                aria-label={`${sentence(role.role)}: ${group.label}, ${actionLabel(permission).toLowerCase()}`}
                              />
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
          </div>
        </Section>
      </AsyncState>
    </ManagementPage>
  );
}
