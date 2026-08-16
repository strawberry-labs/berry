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
export function AdminFeatureAccessScreen({
  client,
  config,
  tenantId,
  permissions,
}: ManagementScreenProps) {
  const canWrite = permissions.includes("feature_flags:write");
  const r = useResource(
    `features:${tenantId}`,
    async () =>
      client
        ? client.listFeatureFlags(tenantId)
        : config.featureFlags.filter((x) => x.tenantId === tenantId),
    [] as any[],
  );
  const [query, setQuery] = React.useState("");
  const [active, setActive] = React.useState<number | null>(null);
  const [message, setMessage] = React.useState("");
  const rows = r.data.filter((f: any) =>
    humanize(f.flag).toLowerCase().includes(query.toLowerCase()),
  );
  const detail = active != null ? rows[active] : null;
  const setEnabled = async (flag: any, enabled: boolean) => {
    await client?.upsertFeatureFlag(tenantId, flag.flag, {
      enabled,
      roleDefaults: flag.roleDefaults,
    });
    r.setData(
      r.data.map((f: any) =>
        f.flag === flag.flag
          ? { ...f, enabled, updatedAt: new Date().toISOString() }
          : f,
      ),
    );
    setMessage(
      `Feature “${humanize(flag.flag)}” turned ${enabled ? "on" : "off"} and recorded in the audit log.`,
    );
  };
  return (
    <ManagementPage
      title="Feature access"
      description="Roll features out across the organization and refine access by role."
      eyebrow="AI controls"
    >
      <Toolbar>
        <SearchInput
          label="Search features"
          value={query}
          onChange={setQuery}
          placeholder="Search features"
        />
      </Toolbar>
      {message ? <SuccessMessage>{message}</SuccessMessage> : null}
      <div className={detail ? "min-w-0" : undefined}>
        <AsyncState
          loading={r.loading}
          error={r.error}
          onRetry={r.retry}
          empty={rows.length === 0}
        >
          <DataTable
            label="Feature access"
            columns={[
              "Feature",
              "Organization default",
              "Role overrides",
              "Updated",
            ]}
            onRowSelect={setActive}
            activeRow={active}
            rowLabel={(i) => humanize(rows[i].flag)}
            rows={rows.map((f: any) => [
              <b>{humanize(f.flag)}</b>,
              <StatusPill tone={f.enabled ? "good" : "neutral"}>
                {f.enabled ? "On" : "Off"}
              </StatusPill>,
              formatNumber(Object.keys(f.roleDefaults ?? {}).length),
              formatDate(f.updatedAt),
            ])}
          />
        </AsyncState>
        {detail ? (
          <DetailDrawer
            title={humanize(detail.flag)}
            subtitle={detail.flag}
            badge={
              <StatusPill tone={detail.enabled ? "good" : "neutral"}>
                {detail.enabled ? "On" : "Off"}
              </StatusPill>
            }
            onClose={() => setActive(null)}
          >
            <label className="flex items-center justify-between gap-4 rounded-lg border border-border px-3 py-2.5 text-sm">
              <span>
                Organization default
                <small>Turn this feature on for the whole organization.</small>
              </span>
              <ManagementSwitch
                checked={Boolean(detail.enabled)}
                disabled={!canWrite}
                onCheckedChange={(checked) => setEnabled(detail, checked)}
                aria-label="Organization default"
              />
            </label>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Role overrides
            </h3>
            {Object.keys(detail.roleDefaults ?? {}).length ? (
              <DefinitionList
                items={Object.entries(detail.roleDefaults).map(
                  ([role, perms]) => ({
                    term: humanize(role),
                    detail: (perms as string[]).join(", ") || "—",
                  }),
                )}
              />
            ) : (
              <p className="text-xs text-muted-foreground">
                No role overrides. All roles inherit the organization default.
              </p>
            )}
            {!canWrite ? (
              <p className="text-xs text-muted-foreground">
                Read-only — feature_flags:write required to edit.
              </p>
            ) : null}
          </DetailDrawer>
        ) : null}
      </div>
    </ManagementPage>
  );
}

/* --------------------------------------------------------------- sso & scim */
