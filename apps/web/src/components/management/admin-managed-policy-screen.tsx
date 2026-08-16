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
export function AdminManagedPolicyScreen({
  client,
  config,
  tenantId,
}: ManagementScreenProps) {
  const r = useResource(
    `policy:${tenantId}`,
    async () =>
      client
        ? client.listPolicyVersions(tenantId)
        : config.policyVersions.filter((x) => x.tenantId === tenantId),
    [] as any[],
  );
  const [active, setActive] = React.useState<number | null>(null);
  const versions = [...r.data].sort((a: any, b: any) => b.version - a.version);
  const current =
    versions.find((v: any) => v.status === "active") ?? versions[0] ?? null;
  const detail = active != null ? versions[active] : null;
  const locksOf = (v: any) =>
    v?.bundle?.policy
      ? Object.keys(v.bundle.policy).filter((k) => v.bundle.policy[k])
      : (v?.locks ?? []);
  return (
    <ManagementPage
      title="Managed policy"
      description="Signed policy bundles that lock client behavior across the organization."
      eyebrow="Security & data"
    >
      <AsyncState
        loading={r.loading}
        error={r.error}
        onRetry={r.retry}
        empty={versions.length === 0}
        emptyTitle="No managed policy"
        emptyText="Published policy bundles will appear here."
      >
        {current ? (
          <Section title="Current policy">
            <MetricGrid
              items={[
                {
                  label: "Version",
                  value: `v${current.version}`,
                  status: current.status === "active" ? "good" : "warning",
                },
                {
                  label: "Status",
                  value: humanize(current.status),
                  status:
                    current.status === "active"
                      ? "good"
                      : current.status === "revoked"
                        ? "danger"
                        : "warning",
                },
                { label: "Signing key", value: current.keyId ?? "—" },
                {
                  label: "Published",
                  value: formatDate(current.publishedAt ?? current.createdAt),
                },
              ]}
            />
          </Section>
        ) : null}
        <div className={detail ? "min-w-0" : undefined}>
          <Section title="Versions">
            <DataTable
              label="Policy versions"
              columns={[
                "Version",
                "Status",
                "Signing key",
                "Published",
                "Note",
              ]}
              onRowSelect={setActive}
              activeRow={active}
              rowLabel={(i) => `Version ${versions[i].version}`}
              rows={versions.map((v: any) => [
                <b>v{v.version}</b>,
                <StatusPill
                  tone={
                    v.status === "active"
                      ? "good"
                      : v.status === "revoked"
                        ? "danger"
                        : "neutral"
                  }
                >
                  {humanize(v.status)}
                </StatusPill>,
                v.keyId ?? "—",
                formatDateTime(v.publishedAt ?? v.createdAt),
                v.note ?? "—",
              ])}
            />
          </Section>
          {detail ? (
            <DetailDrawer
              title={`Version ${detail.version}`}
              badge={
                <StatusPill
                  tone={
                    detail.status === "active"
                      ? "good"
                      : detail.status === "revoked"
                        ? "danger"
                        : "neutral"
                  }
                >
                  {humanize(detail.status)}
                </StatusPill>
              }
              onClose={() => setActive(null)}
            >
              <DefinitionList
                items={[
                  {
                    term: "Bundle hash",
                    detail: detail.bundleHash ? (
                      <code className="inline-flex items-center gap-1 font-mono text-xs">
                        {detail.bundleHash.slice(0, 24)}…
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => copyText(detail.bundleHash)}
                          aria-label="Copy hash"
                        >
                          <Copy aria-hidden />
                        </Button>
                      </code>
                    ) : (
                      "—"
                    ),
                  },
                  { term: "Signing key", detail: detail.keyId ?? "—" },
                  {
                    term: "Published",
                    detail: formatDateTime(
                      detail.publishedAt ?? detail.createdAt,
                    ),
                  },
                  {
                    term: "Published by",
                    detail: detail.publishedBy ?? "System",
                  },
                  ...(detail.revokedAt
                    ? [
                        {
                          term: "Revoked",
                          detail: formatDateTime(detail.revokedAt),
                        },
                      ]
                    : []),
                ]}
              />
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Locks enforced
              </h3>
              <div className="flex flex-wrap gap-1.5">
                {locksOf(detail).length ? (
                  locksOf(detail).map((lock: string) => (
                    <StatusPill key={lock} tone="info">
                      {humanize(lock)}
                    </StatusPill>
                  ))
                ) : (
                  <span className="text-xs text-muted-foreground">
                    No locks
                  </span>
                )}
              </div>
              {detail.bundlePath ? (
                <>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Bundle
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    {detail.bundlePath}
                  </p>
                </>
              ) : null}
            </DetailDrawer>
          ) : null}
        </div>
      </AsyncState>
    </ManagementPage>
  );
}

/* -------------------------------------------------------------- audit log */
