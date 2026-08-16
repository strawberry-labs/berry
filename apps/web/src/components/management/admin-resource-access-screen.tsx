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
export function AdminResourceAccessScreen({
  client,
  config,
  tenantId,
  permissions,
}: ManagementScreenProps) {
  const canWrite = permissions.includes("acl:write");
  const r = useResource(
    `acls:${tenantId}`,
    async () =>
      client
        ? client.listResourceAcls(tenantId)
        : config.resourceAcls.filter((x) => x.tenantId === tenantId),
    [] as any[],
  );
  const [query, setQuery] = React.useState("");
  const [resourceType, setResourceType] = React.useState("all");
  const [principalType, setPrincipalType] = React.useState("all");
  const [active, setActive] = React.useState<number | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const resourceTypes = [...new Set(r.data.map((x: any) => x.resourceType))];
  const rows = r.data.filter(
    (x: any) =>
      `${x.resourceId} ${x.principalId}`
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (resourceType === "all" || x.resourceType === resourceType) &&
      (principalType === "all" || x.principalType === principalType),
  );
  const detail = active != null ? rows[active] : null;
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const input = {
      resourceType: String(form.get("resourceType")),
      resourceId: String(form.get("resourceId")),
      principalType: String(form.get("principalType")) as any,
      principalId: String(form.get("principalId")),
      allow: String(form.get("allow"))
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean) as OrgPermission[],
      deny: String(form.get("deny"))
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean) as OrgPermission[],
    };
    const saved = await client?.upsertResourceAcl(tenantId, input);
    r.setData([
      saved ?? {
        id: crypto.randomUUID(),
        tenantId,
        ...input,
        updatedAt: new Date().toISOString(),
      },
      ...r.data,
    ]);
    setAdding(false);
    setMessage("Access rule saved and recorded in the audit log.");
  };
  return (
    <ManagementPage
      title="Resource access"
      description="Inspect and override sharing for workspaces, agents, prompts, skills, and tasks."
      eyebrow="Access"
      actions={
        canWrite ? (
          <Button onClick={() => setAdding(true)}>
            <Plus data-icon="inline-start" aria-hidden />
            Add rule
          </Button>
        ) : null
      }
    >
      <Toolbar>
        <SearchInput
          label="Search resources"
          value={query}
          onChange={setQuery}
          placeholder="Search resource or principal"
        />
        <FilterSelect
          label="Resource type"
          value={resourceType}
          onChange={setResourceType}
          options={[
            { value: "all", label: "All" },
            ...resourceTypes.map((t) => ({
              value: String(t),
              label: humanize(String(t)),
            })),
          ]}
        />
        <FilterSelect
          label="Principal"
          value={principalType}
          onChange={setPrincipalType}
          options={[
            { value: "all", label: "All" },
            { value: "user", label: "User" },
            { value: "role", label: "Role" },
            { value: "department", label: "Department" },
          ]}
        />
      </Toolbar>
      {message ? <SuccessMessage>{message}</SuccessMessage> : null}
      <ManagementDialog
        open={adding}
        onOpenChange={setAdding}
        title="Add resource access rule"
        description="Grant or deny specific permissions for a user, role, or department on one Berry resource."
        size="lg"
        footer={
          <>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setAdding(false)}
            >
              Cancel
            </Button>
            <Button type="submit" form="create-resource-rule-form">
              <Save aria-hidden />
              Save rule
            </Button>
          </>
        }
      >
        <form
          id="create-resource-rule-form"
          className="grid gap-3 sm:grid-cols-2 [&>label]:grid [&>label]:gap-1.5 [&>label]:text-xs [&>label]:font-medium [&>label]:text-muted-foreground"
          onSubmit={submit}
        >
          <label>
            Resource type
            <Input
              name="resourceType"
              placeholder="workspace"
              autoFocus
              required
            />
          </label>
          <label>
            Resource ID
            <Input name="resourceId" required />
          </label>
          <label>
            Principal type
            <FormSelect
              name="principalType"
              defaultValue="user"
              options={[
                { value: "user", label: "User" },
                { value: "role", label: "Role" },
                { value: "department", label: "Department" },
              ]}
            />
          </label>
          <label>
            Principal ID
            <Input name="principalId" required />
          </label>
          <label>
            Allow (comma-separated keys)
            <Input name="allow" placeholder="acl:read" />
          </label>
          <label>
            Deny (comma-separated keys)
            <Input name="deny" />
          </label>
        </form>
      </ManagementDialog>
      <div className={detail ? "min-w-0" : undefined}>
        <AsyncState
          loading={r.loading}
          error={r.error}
          onRetry={r.retry}
          empty={rows.length === 0}
        >
          <DataTable
            label="Resource access rules"
            columns={["Resource", "Principal", "Allowed", "Denied", "Updated"]}
            onRowSelect={setActive}
            activeRow={active}
            rowLabel={(i) => `${rows[i].resourceType} ${rows[i].resourceId}`}
            rows={rows.map((x: any) => [
              <span className="grid min-w-0 gap-0.5 [&_b]:truncate [&_b]:text-sm [&_small]:text-xs [&_small]:text-muted-foreground">
                <b>{x.resourceId}</b>
                <small>{humanize(x.resourceType)}</small>
              </span>,
              <span className="grid min-w-0 gap-0.5 [&_b]:truncate [&_b]:text-sm [&_small]:text-xs [&_small]:text-muted-foreground">
                <b>{x.principalId}</b>
                <small>{humanize(x.principalType)}</small>
              </span>,
              x.allow.length ? (
                <span className="flex flex-wrap gap-1.5">
                  {x.allow.map((p: string) => (
                    <StatusPill key={p} tone="good">
                      {p}
                    </StatusPill>
                  ))}
                </span>
              ) : (
                "—"
              ),
              x.deny.length ? (
                <span className="flex flex-wrap gap-1.5">
                  {x.deny.map((p: string) => (
                    <StatusPill key={p} tone="danger">
                      {p}
                    </StatusPill>
                  ))}
                </span>
              ) : (
                "—"
              ),
              formatDate(x.updatedAt),
            ])}
          />
        </AsyncState>
        {detail ? (
          <DetailDrawer
            title={detail.resourceId}
            subtitle={humanize(detail.resourceType)}
            badge={
              <StatusPill tone="info">
                {humanize(detail.principalType)}
              </StatusPill>
            }
            onClose={() => setActive(null)}
          >
            <DefinitionList
              items={[
                {
                  term: "Resource",
                  detail: `${humanize(detail.resourceType)} · ${detail.resourceId}`,
                },
                {
                  term: "Principal",
                  detail: `${humanize(detail.principalType)} · ${detail.principalId}`,
                },
                { term: "Updated", detail: formatDateTime(detail.updatedAt) },
              ]}
            />
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Effective permissions
            </h3>
            <div className="flex flex-wrap gap-1.5">
              {detail.allow.length ? (
                detail.allow.map((p: string) => (
                  <StatusPill key={p} tone="good">
                    {p}
                  </StatusPill>
                ))
              ) : (
                <span className="text-xs text-muted-foreground">
                  No explicit grants
                </span>
              )}
            </div>
            {detail.deny.length ? (
              <>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Denied
                </h3>
                <div className="flex flex-wrap gap-1.5">
                  {detail.deny.map((p: string) => (
                    <StatusPill key={p} tone="danger">
                      {p}
                    </StatusPill>
                  ))}
                </div>
              </>
            ) : null}
          </DetailDrawer>
        ) : null}
      </div>
    </ManagementPage>
  );
}

/* --------------------------------------------------------------- providers */
