import * as React from "react";
import { Building2, Plus } from "lucide-react";
import {
  AsyncState, Button, CellStack, DataTable, EmptyPanel, FormSelect, InlineNotice, Input,
  ManagementDialog, ManagementPage, StatusPill, formatDate,
} from "./management-primitives";
import { useResource, type ManagementScreenProps } from "./management-context";

const fieldLabel = "grid gap-1.5 text-xs font-medium text-muted-foreground";
const help = "text-xs font-normal leading-4";

export function AdminDepartmentsScreen({
  client,
  config,
  tenantId,
  permissions,
}: ManagementScreenProps) {
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const canWrite = permissions.includes("departments:write");
  const r = useResource(
    `departments:${tenantId}`,
    async () =>
      client
        ? client.listDepartments(tenantId)
        : config.departments.filter((d) => d.tenantId === tenantId),
    [] as any[],
  );
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const parentId = String(f.get("parentId"));
    setBusy(true);
    setError("");
    try {
      await client?.createDepartment(tenantId, {
        name: String(f.get("name")),
        slug: String(f.get("slug")),
        parentId: parentId === "none" ? null : parentId,
      });
      setOpen(false);
      r.retry();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The department could not be created.");
    } finally {
      setBusy(false);
    }
  };
  const names = new Map<string, string>(r.data.map((d: any) => [d.id, d.name]));
  const childCount = (id: string) => r.data.filter((d: any) => d.parentId === id).length;
  // Inactive departments first (they need a decision), then top-level before nested, then by name.
  const rows = [...r.data].sort((left: any, right: any) =>
    Number(left.status === "active") - Number(right.status === "active")
    || Number(Boolean(left.parentId)) - Number(Boolean(right.parentId))
    || String(left.name).localeCompare(String(right.name)),
  );
  const createButton = canWrite ? (
    <Button onClick={() => { setError(""); setOpen(true); }}>
      <Plus />
      New department
    </Button>
  ) : null;
  return (
    <ManagementPage
      title="Departments"
      description="Departments group members so model access, allowances, and usage reports can be set and read per team."
      eyebrow="People"
      actions={createButton}
    >
      <ManagementDialog
        open={open}
        onOpenChange={(next) => { if (!busy) setOpen(next); }}
        title="New department"
        description="Members are assigned to departments from People → Members."
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" form="create-department-form" disabled={busy}>
              {busy ? "Creating…" : "Create department"}
            </Button>
          </>
        }
      >
        <form id="create-department-form" className="grid gap-3 sm:grid-cols-2" onSubmit={submit}>
          <label className={fieldLabel}>
            Name
            <Input name="name" autoFocus required placeholder="Finance" />
          </label>
          <label className={fieldLabel}>
            Slug
            <Input name="slug" pattern="[a-z0-9-]+" required placeholder="finance" />
            <small className={help}>Lowercase letters, numbers, and hyphens. Used in exports and SCIM mapping.</small>
          </label>
          <label className={`${fieldLabel} sm:col-span-2`}>
            Parent department
            <FormSelect
              name="parentId"
              defaultValue="none"
              options={[
                { value: "none", label: "None (top level)" },
                ...r.data.map((d: any) => ({ value: d.id, label: d.name })),
              ]}
            />
          </label>
        </form>
        {error ? <div className="mt-3"><InlineNotice tone="danger">{error}</InlineNotice></div> : null}
      </ManagementDialog>
      <AsyncState loading={r.loading} error={r.error} onRetry={r.retry}>
        {rows.length === 0 ? (
          <EmptyPanel
            icon={Building2}
            title="No departments yet"
            description="Create departments to set model access and allowances per team and to break usage down by team."
            action={createButton}
          />
        ) : (
          <DataTable
            label="Departments"
            columns={["Department", "Parent", "Sub-departments", "Status", "Updated"]}
            rows={rows.map((d: any) => [
              <CellStack primary={d.name} secondary={d.slug} />,
              d.parentId ? names.get(d.parentId) ?? "Unknown department" : <span className="text-muted-foreground">Top level</span>,
              <span data-sort={childCount(d.id)} className="tabular-nums">{childCount(d.id) || "—"}</span>,
              <StatusPill tone={d.status === "active" ? "good" : "neutral"}>
                {sentence(String(d.status ?? "active"))}
              </StatusPill>,
              formatDate(d.updatedAt),
            ])}
          />
        )}
      </AsyncState>
    </ManagementPage>
  );
}

function sentence(value: string) {
  const text = value.replaceAll("_", " ").replaceAll("-", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
