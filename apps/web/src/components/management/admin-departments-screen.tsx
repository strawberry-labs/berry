import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { Copy, Download, FileUp, Plus, Save, Search, UserPlus, Users } from "lucide-react";
import {
  AsyncState, Button, Checkbox, DataTable, FormSelect, Input, ManagementDialog,
  ManagementPage, MetricGrid, SearchInput, Section, StatusPill, SuccessMessage,
  Switch, Toolbar, formatDateTime, formatMoney, formatNumber,
} from "./management-primitives";
import { useResource, type ManagementScreenProps } from "./management-context";
import {
  calculateCacheMetric, UsageRangeControl, usageRangeForPreset,
  type UsageDateRange, type UsageRangePreset,
} from "./usage-controls";
import { parseMemberImportCsv, type MemberImportRow } from "../../lib/member-import";
import { memberAccessStatusOptions, memberStatusUpdate } from "../../lib/member-administration";
export function AdminDepartmentsScreen({
  client,
  config,
  tenantId,
  permissions,
}: ManagementScreenProps) {
  const [open, setOpen] = React.useState(false);
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
    await client?.createDepartment(tenantId, {
      name: String(f.get("name")),
      slug: String(f.get("slug")),
      parentId: parentId === "none" ? null : parentId,
    });
    setOpen(false);
    r.retry();
  };
  return (
    <ManagementPage
      title="Departments"
      description="Nested ownership, membership, inherited policies, and departmental spend controls."
      eyebrow="People"
      actions={
        permissions.includes("departments:write") ? (
          <Button onClick={() => setOpen(true)}>
            <Plus />
            New department
          </Button>
        ) : null
      }
    >
      <ManagementDialog
        open={open}
        onOpenChange={setOpen}
        title="Create department"
        description="Add a department to organize ownership, policy inheritance, membership, and spend controls."
        footer={
          <>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" form="create-department-form">
              Create department
            </Button>
          </>
        }
      >
        <form
          id="create-department-form"
          className="grid gap-3 sm:grid-cols-2 [&>label]:grid [&>label]:gap-1.5 [&>label]:text-xs [&>label]:font-medium [&>label]:text-muted-foreground"
          onSubmit={submit}
        >
          <label>
            Name
            <Input name="name" autoFocus required />
          </label>
          <label>
            Slug
            <Input name="slug" pattern="[a-z0-9-]+" required />
          </label>
          <label>
            Parent
            <FormSelect
              name="parentId"
              defaultValue="none"
              options={[
                { value: "none", label: "Top level" },
                ...r.data.map((d: any) => ({ value: d.id, label: d.name })),
              ]}
            />
          </label>
        </form>
      </ManagementDialog>
      <AsyncState
        loading={r.loading}
        error={r.error}
        onRetry={r.retry}
        empty={r.data.length === 0}
      >
        <DataTable
          label="Departments"
          columns={["Department", "Parent", "Status", "Updated"]}
          rows={r.data.map((d: any) => [
            <b>{d.name}</b>,
            r.data.find((x: any) => x.id === d.parentId)?.name ??
              "Organization",
            <StatusPill tone={d.status === "active" ? "good" : "neutral"}>
              {d.status}
            </StatusPill>,
            new Date(d.updatedAt).toLocaleDateString(),
          ])}
        />
      </AsyncState>
    </ManagementPage>
  );
}
