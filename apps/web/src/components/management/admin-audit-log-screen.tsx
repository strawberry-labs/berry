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
export function AdminAuditLogScreen({ client, config, tenantId, permissions }: ManagementScreenProps) {
  const r = useResource(
    `audit:${tenantId}`,
    async () =>
      client
        ? Promise.all([
            client.listAuditEvents(tenantId, { limit: 100 }),
            permissions.includes("members:read") ? client.listOrgMembers(tenantId) : Promise.resolve([]),
          ])
        : [config.auditEvents.filter((x) => x.tenantId === tenantId), []],
    [[], []] as any,
  );
  const [events, members]: [any[], any[]] = r.data;
  const memberById = new Map((members ?? []).map((member) => [member.userId, member]));
  const actorLabel = (actorUserId: string | null) => {
    if (!actorUserId) return "System";
    const member = memberById.get(actorUserId);
    return member ? member.name || member.email : actorUserId;
  };
  const [query, setQuery] = React.useState("");
  const [category, setCategory] = React.useState("all");
  const [active, setActive] = React.useState<number | null>(null);
  const categories = [...new Set(events.map((x: any) => x.category))];
  const rows = events.filter(
    (x: any) =>
      `${x.action} ${x.category} ${actorLabel(x.actorUserId)} ${memberById.get(x.actorUserId)?.email ?? ""} ${x.targetId ?? ""} ${x.workspaceId ?? ""} ${x.taskId ?? ""} ${x.sessionId ?? ""}`
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (category === "all" || x.category === category),
  );
  const detail = active != null ? rows[active] : null;
  const exportCsv = () => {
    const header = [
      "sequence",
      "ts",
      "actorName",
      "actorUserId",
      "category",
      "action",
      "targetType",
      "targetId",
    ];
    const body = rows.map((x: any) =>
      [
        x.sequence,
        x.ts ?? x.createdAt,
        actorLabel(x.actorUserId),
        x.actorUserId ?? "system",
        x.category,
        x.action,
        x.targetType ?? "",
        x.targetId ?? "",
      ].map((value) => `"${String(value).replaceAll('"', '""')}"`).join(","),
    );
    const csv = [header.join(","), ...body].join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = "audit-log.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <ManagementPage
      title="Audit log"
      description="Tamper-evident administration activity with a verifiable hash chain."
      eyebrow="Security & data"
      actions={
        <Button variant="secondary" onClick={exportCsv}>
          <Download aria-hidden />
          Export
        </Button>
      }
    >
      <Toolbar>
        <SearchInput
          label="Search audit events"
          value={query}
          onChange={setQuery}
          placeholder="Search action, actor, or target"
        />
        <FilterSelect
          label="Category"
          value={category}
          onChange={setCategory}
          options={[
            { value: "all", label: "All categories" },
            ...categories.map((c) => ({
              value: String(c),
              label: humanize(String(c)),
            })),
          ]}
        />
      </Toolbar>
      <div className={detail ? "min-w-0" : undefined}>
        <AsyncState
          loading={r.loading}
          error={r.error}
          onRetry={r.retry}
          empty={rows.length === 0}
        >
          <DataTable
            label="Audit events"
            columns={["Time", "Actor", "Category", "Action", "Target", "Context", "Sequence"]}
            onRowSelect={setActive}
            activeRow={active}
            rowLabel={(i) => `${rows[i].category} ${rows[i].action}`}
            rows={rows.map((x: any) => [
              formatDateTime(x.ts ?? x.createdAt),
              <span className="grid min-w-0 gap-0.5 [&_b]:truncate [&_small]:text-xs [&_small]:text-muted-foreground"><b>{actorLabel(x.actorUserId)}</b><small>{memberById.get(x.actorUserId)?.email ?? x.actorUserId ?? "Service initiated"}</small></span>,
              humanize(x.category),
              <span className="grid min-w-0 gap-0.5 [&_b]:truncate [&_b]:text-sm [&_small]:text-xs [&_small]:text-muted-foreground">
                <b>{humanize(x.action)}</b>
                <small>
                  {x.category}.{x.action}
                </small>
              </span>,
              x.targetId
                ? `${humanize(x.targetType ?? "")}: ${x.targetId}`
                : "—",
              x.workspaceId ? `Workspace ${x.workspaceId}` : x.taskId ? `Task ${x.taskId}` : x.sessionId ? `Session ${x.sessionId}` : "Organization",
              <code>#{x.sequence}</code>,
            ])}
          />
        </AsyncState>
        {detail ? (
          <DetailDrawer
            title={humanize(detail.action)}
            subtitle={`${detail.category}.${detail.action}`}
            badge={<code>#{detail.sequence}</code>}
            onClose={() => setActive(null)}
          >
            <DefinitionList
              items={[
                {
                  term: "Time",
                  detail: formatDateTime(detail.ts ?? detail.createdAt),
                },
                { term: "Actor", detail: actorLabel(detail.actorUserId) },
                { term: "Actor ID", detail: detail.actorUserId ?? "System" },
                {
                  term: "Target",
                  detail: detail.targetId
                    ? `${humanize(detail.targetType ?? "")}: ${detail.targetId}`
                    : "—",
                },
                { term: "Event ID", detail: detail.id },
                { term: "Workspace", detail: detail.workspaceId ?? "—" },
                { term: "Task", detail: detail.taskId ?? "—" },
                { term: "Session", detail: detail.sessionId ?? "—" },
                { term: "Retained until", detail: formatDateTime(detail.expiresAt) },
              ]}
            />
            {detail.before || detail.after ? (
              <>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Change
                </h3>
                <div className="grid gap-2 sm:grid-cols-2 [&>div]:min-w-0 [&>div]:rounded-lg [&>div]:border [&>div]:border-border [&>div]:bg-muted/30 [&>div]:p-2 [&_span]:mb-1 [&_span]:block [&_span]:text-xs [&_span]:font-semibold [&_span]:uppercase [&_span]:text-muted-foreground [&_pre]:max-h-52 [&_pre]:overflow-auto [&_pre]:whitespace-pre-wrap [&_pre]:break-words [&_pre]:font-mono [&_pre]:text-xs">
                  <div>
                    <span>Before</span>
                    <pre>{JSON.stringify(detail.before ?? null, null, 2)}</pre>
                  </div>
                  <div>
                    <span>After</span>
                    <pre>{JSON.stringify(detail.after ?? null, null, 2)}</pre>
                  </div>
                </div>
              </>
            ) : null}
            {detail.metadata && Object.keys(detail.metadata).length ? (
              <>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Metadata
                </h3>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words bg-transparent font-mono text-xs leading-5 text-muted-foreground">
                  {JSON.stringify(detail.metadata, null, 2)}
                </pre>
              </>
            ) : null}
            {detail.eventHash ? (
              <>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Hash chain
                </h3>
                <DefinitionList
                  items={[
                    {
                      term: "Previous hash",
                      detail: (
                        <code className="inline-flex items-center gap-1 font-mono text-xs">
                          <span className="break-all">{String(detail.previousHash ?? "—")}</span>
                        </code>
                      ),
                    },
                    {
                      term: "Event hash",
                      detail: (
                        <code className="inline-flex items-center gap-1 font-mono text-xs">
                          <span className="break-all">{String(detail.eventHash)}</span>
                        </code>
                      ),
                    },
                  ]}
                />
              </>
            ) : null}
          </DetailDrawer>
        ) : null}
      </div>
    </ManagementPage>
  );
}

/* ------------------------------------------------------------- dispatcher */
const PERMISSION_FOR: Record<string, OrgPermission> = {
  roles: "rbac:read",
  "resource-access": "acl:read",
  providers: "models:read",
  models: "models:read",
  "skills-mcp": "org:read",
  "feature-access": "feature_flags:read",
  "sso-scim": "sso:read",
  "managed-policy": "policy:read",
  "audit-log": "audit:read",
};
