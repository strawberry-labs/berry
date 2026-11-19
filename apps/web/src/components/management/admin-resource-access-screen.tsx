import * as React from "react";
import { Plus, Save, ShieldCheck } from "lucide-react";
import { OrgPermissionSchema, type OrgPermission } from "@berry/shared";
import {
  AsyncState,
  Button,
  CellStack,
  DataTable,
  DefinitionList,
  DetailDrawer,
  EmptyPanel,
  FormSelect,
  InlineNotice,
  Input,
  ManagementDialog,
  ManagementPage,
  StatusPill,
  SuccessMessage,
  formatDate,
  formatDateTime,
} from "./management-primitives";
import { useResource, type ManagementScreenProps } from "./management-context";

const KNOWN_PERMISSIONS = new Set<string>(OrgPermissionSchema.options);
const PRINCIPAL_LABEL: Record<string, string> = { user: "Member", role: "Role", department: "Department" };
const fieldLabel = "grid gap-1.5 text-xs font-medium text-muted-foreground";
const help = "text-xs font-normal leading-4";
const drawerHeading = "text-xs font-medium text-muted-foreground";

function sentence(value: string) {
  const text = String(value ?? "").replaceAll("_", " ").replaceAll("-", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
/** Long opaque ids are shortened; short readable ones are shown whole. */
function shortId(value: string) {
  const text = String(value ?? "");
  return text.length > 18 ? `${text.slice(0, 8)}…${text.slice(-4)}` : text;
}
function parseKeys(value: FormDataEntryValue | null) {
  return String(value ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

/**
 * This screen loads only the rules, not the member or department directory, so
 * a principal is named by its kind with the id as the quiet second line. Role
 * principals are stored by role name and can be shown directly.
 */
function PrincipalCell({ rule }: { rule: any }) {
  if (rule.principalType === "role") return <CellStack primary={sentence(rule.principalId)} secondary="Role" />;
  return <CellStack primary={PRINCIPAL_LABEL[rule.principalType] ?? sentence(rule.principalType)} secondary={<span className="font-mono" title={rule.principalId}>{shortId(rule.principalId)}</span>} />;
}

function PermissionCodes({ values }: { values: string[] }) {
  if (!values.length) return <span className="text-muted-foreground">—</span>;
  const shown = values.slice(0, 2);
  return (
    <span className="font-mono text-xs" title={values.join(", ")}>
      {shown.join(", ")}
      {values.length > shown.length ? <span className="font-sans text-muted-foreground"> +{values.length - shown.length}</span> : null}
    </span>
  );
}

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
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [formError, setFormError] = React.useState("");
  const [message, setMessage] = React.useState("");
  // Most recently changed rules first: that is what an administrator is checking.
  const rows = [...r.data].sort((left: any, right: any) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  const activeIndex = rows.findIndex((rule: any) => rule.id === activeId);
  const detail = activeIndex >= 0 ? rows[activeIndex] : null;
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const allow = parseKeys(form.get("allow"));
    const deny = parseKeys(form.get("deny"));
    const unknown = [...allow, ...deny].filter((key) => !KNOWN_PERMISSIONS.has(key));
    if (unknown.length) {
      setFormError(`Unknown permission ${unknown.length === 1 ? "key" : "keys"}: ${unknown.join(", ")}. Keys look like acl:read; the full list is under Roles & permissions.`);
      return;
    }
    const input = {
      resourceType: String(form.get("resourceType")),
      resourceId: String(form.get("resourceId")),
      principalType: String(form.get("principalType")) as any,
      principalId: String(form.get("principalId")),
      allow: allow as OrgPermission[],
      deny: deny as OrgPermission[],
    };
    setBusy(true);
    setFormError("");
    try {
      const saved = await client?.upsertResourceAcl(tenantId, input);
      r.setData([
        saved ?? {
          id: crypto.randomUUID(),
          tenantId,
          ...input,
          updatedAt: new Date().toISOString(),
        },
        ...r.data.filter((rule: any) =>
          rule.resourceType !== input.resourceType
          || rule.resourceId !== input.resourceId
          || rule.principalType !== input.principalType
          || rule.principalId !== input.principalId,
        ),
      ]);
      setAdding(false);
      setMessage("Access rule saved and recorded in the audit log.");
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : "The access rule could not be saved.");
    } finally {
      setBusy(false);
    }
  };
  const addButton = canWrite ? (
    <Button onClick={() => { setFormError(""); setAdding(true); }}>
      <Plus aria-hidden />
      Add rule
    </Button>
  ) : null;
  return (
    <ManagementPage
      title="Resource access"
      description="Exceptions to role permissions for one resource: allow or deny specific permissions for a member, role, or department."
      eyebrow="Access"
      actions={addButton}
    >
      {message ? <SuccessMessage>{message}</SuccessMessage> : null}
      <AsyncState loading={r.loading} error={r.error} onRetry={r.retry}>
        {rows.length === 0 ? (
          <EmptyPanel
            icon={ShieldCheck}
            title="No access rules"
            description="Everyone’s access follows their role. Add a rule when one workspace, agent, or skill needs a different set of permissions."
            action={addButton}
          />
        ) : (
          <DataTable
            label="Resource access rules"
            columns={["Resource", "Applies to", "Allows", "Denies", "Updated"]}
            onRowSelect={(index) => setActiveId(rows[index]?.id ?? null)}
            activeRow={activeIndex >= 0 ? activeIndex : null}
            rowLabel={(i) => `${sentence(rows[i].resourceType)} ${rows[i].resourceId}`}
            rows={rows.map((x: any) => [
              <CellStack primary={sentence(x.resourceType)} secondary={<span className="font-mono" title={x.resourceId}>{shortId(x.resourceId)}</span>} />,
              <PrincipalCell rule={x} />,
              <PermissionCodes values={x.allow ?? []} />,
              <PermissionCodes values={x.deny ?? []} />,
              formatDate(x.updatedAt),
            ])}
          />
        )}
      </AsyncState>
      {detail ? (
        <DetailDrawer
          title={`${sentence(detail.resourceType)} rule`}
          subtitle={<code>{detail.resourceId}</code>}
          badge={<StatusPill tone="neutral">{PRINCIPAL_LABEL[detail.principalType] ?? sentence(detail.principalType)}</StatusPill>}
          onClose={() => setActiveId(null)}
        >
          <DefinitionList
            items={[
              { term: "Resource type", detail: sentence(detail.resourceType) },
              { term: "Resource ID", detail: <code className="break-all">{detail.resourceId}</code> },
              {
                term: "Applies to",
                detail: detail.principalType === "role"
                  ? `${sentence(detail.principalId)} role`
                  : <>{PRINCIPAL_LABEL[detail.principalType] ?? sentence(detail.principalType)} <code className="break-all text-muted-foreground">{detail.principalId}</code></>,
              },
              { term: "Updated", detail: formatDateTime(detail.updatedAt) },
            ]}
          />
          <h3 className={drawerHeading}>Allows</h3>
          {detail.allow?.length ? (
            <div className="flex flex-wrap gap-1.5">
              {detail.allow.map((p: string) => <StatusPill key={p} tone="good">{p}</StatusPill>)}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Nothing beyond the role’s own permissions.</p>
          )}
          <h3 className={drawerHeading}>Denies</h3>
          {detail.deny?.length ? (
            <div className="flex flex-wrap gap-1.5">
              {detail.deny.map((p: string) => <StatusPill key={p} tone="danger">{p}</StatusPill>)}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Nothing is denied by this rule.</p>
          )}
          <p className="text-xs leading-5 text-muted-foreground">A deny always wins over an allow. To change this rule, add a rule for the same resource and principal; it replaces this one.</p>
        </DetailDrawer>
      ) : null}
      <ManagementDialog
        open={adding}
        onOpenChange={(next) => { if (!busy) setAdding(next); }}
        title="Add access rule"
        description="Allow or deny specific permissions on one resource for a member, role, or department. A rule for the same resource and principal replaces the existing one."
        size="lg"
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setAdding(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" form="create-resource-rule-form" disabled={busy}>
              <Save aria-hidden />
              {busy ? "Saving…" : "Save rule"}
            </Button>
          </>
        }
      >
        <form id="create-resource-rule-form" className="grid gap-3 sm:grid-cols-2" onSubmit={submit}>
          <label className={fieldLabel}>
            Resource type
            <Input name="resourceType" placeholder="workspace" autoFocus required />
            <small className={help}>For example workspace, agent, prompt, skill, or task.</small>
          </label>
          <label className={fieldLabel}>
            Resource ID
            <Input name="resourceId" required />
            <small className={help}>The ID shown in the resource’s own details.</small>
          </label>
          <label className={fieldLabel}>
            Applies to
            <FormSelect
              name="principalType"
              defaultValue="user"
              options={[
                { value: "user", label: "Member" },
                { value: "role", label: "Role" },
                { value: "department", label: "Department" },
              ]}
            />
          </label>
          <label className={fieldLabel}>
            Member, role, or department ID
            <Input name="principalId" required />
            <small className={help}>For a role, enter its name (owner, admin, or member).</small>
          </label>
          <label className={fieldLabel}>
            Allow
            <Input name="allow" placeholder="acl:read, skills:read" />
            <small className={help}>Permission keys, separated by commas.</small>
          </label>
          <label className={fieldLabel}>
            Deny
            <Input name="deny" placeholder="skills:write" />
            <small className={help}>A deny wins over any allow.</small>
          </label>
        </form>
        {formError ? <div className="mt-3"><InlineNotice tone="danger">{formError}</InlineNotice></div> : null}
      </ManagementDialog>
    </ManagementPage>
  );
}
