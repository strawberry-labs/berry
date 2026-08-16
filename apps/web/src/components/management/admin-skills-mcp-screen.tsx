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
export function AdminSkillsMcpScreen({
  client,
  tenantId,
  permissions,
}: ManagementScreenProps) {
  const canWriteSkills = permissions.includes("skills:write");
  const canWriteMcp = permissions.includes("mcp:write");
  const r = useResource(
    `capabilities:${tenantId}`,
    async () => (client ? client.listOrganizationCapabilities(tenantId) : []),
    [] as any[],
  );
  const policy = useResource(
    `capability-policy:${tenantId}`,
    async () =>
      client
        ? client.organizationCapabilitySettings(tenantId)
        : { skills: true, mcp: true },
    { skills: true, mcp: true },
  );
  const [tab, setTab] = React.useState("skill");
  const [skillSource, setSkillSource] = React.useState<"upload" | "paste">("upload");
  const [query, setQuery] = React.useState("");
  const [assignment, setAssignment] = React.useState("all");
  const [active, setActive] = React.useState<number | null>(null);
  const [message, setMessage] = React.useState("");
  const [adding, setAdding] = React.useState(false);
  const [review, setReview] = React.useState<PersonalSkillReview | null>(null);
  const [importError, setImportError] = React.useState("");
  const [skillArchiveFile, setSkillArchiveFile] = React.useState<File | null>(null);
  const [skillArchiveFileId, setSkillArchiveFileId] = React.useState<string | null>(null);
  const [skillUploadProgress, setSkillUploadProgress] = React.useState(0);
  const [skillOperation, setSkillOperation] = React.useState<"uploading" | "reviewing" | "saving" | null>(null);
  const skillOperationGeneration = React.useRef(0);
  const skillUploadController = React.useRef<AbortController | null>(null);
  const [skillDraft, setSkillDraft] = React.useState({
    content: "",
    packageFiles: [] as string[],
    resourceFiles: [] as Array<{ path: string; contentBase64: string; mode?: number | undefined }>,
    fileName: "",
    assignment: "default-on" as OrgCapabilityAssignment,
    allowUserDisable: true,
  });
  const [mcpDraft, setMcpDraft] = React.useState({
    name: "",
    description: "",
    url: "",
    assignment: "available" as OrgCapabilityAssignment,
    allowUserDisable: true,
  });
  const canWrite = tab === "skill" ? canWriteSkills : canWriteMcp;
  const scoped = r.data.filter((c: any) => c.kind === tab);
  const rows = scoped.filter(
    (c: any) =>
      `${c.name} ${c.capabilityId}`
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (assignment === "all" || c.assignment === assignment),
  );
  const detail = active != null ? rows[active] : null;
  const counts = (value: string) =>
    r.data.filter((c: any) => c.assignment === value).length;
  const assignmentTone = (value: string) =>
    value === "required"
      ? "info"
      : value === "blocked"
        ? "danger"
        : value === "default-on"
          ? "good"
          : "neutral";
  const setAllowDisable = async (capability: any, allow: boolean) => {
    await client?.upsertOrganizationCapability(tenantId, {
      kind: capability.kind,
      capabilityId: capability.capabilityId,
      name: capability.name,
      description: capability.description,
      assignment: capability.assignment,
      allowUserDisable: allow,
    });
    r.setData(
      r.data.map((c: any) =>
        c.id === capability.id ? { ...c, allowUserDisable: allow } : c,
      ),
    );
    setMessage("Capability updated and recorded in the audit log.");
  };
  const setAssignmentValue = async (capability: any, value: string) => {
    await client?.upsertOrganizationCapability(tenantId, {
      kind: capability.kind,
      capabilityId: capability.capabilityId,
      name: capability.name,
      description: capability.description,
      assignment: value as any,
      allowUserDisable: capability.allowUserDisable,
    });
    r.setData(
      r.data.map((c: any) =>
        c.id === capability.id ? { ...c, assignment: value } : c,
      ),
    );
    setMessage("Capability assignment updated and recorded in the audit log.");
  };
  const discardSkillArchive = (fileId = skillArchiveFileId) => {
    skillUploadController.current?.abort();
    skillUploadController.current = null;
    skillOperationGeneration.current += 1;
    setSkillOperation(null);
    setSkillArchiveFile(null);
    setSkillArchiveFileId(null);
    setSkillUploadProgress(0);
    if (client && fileId) void client.removeFileFromLibrary(fileId).catch(() => undefined);
  };
  const closeSkillDialog = () => {
    discardSkillArchive();
    setAdding(false);
    setReview(null);
    setImportError("");
  };
  const requestCloseSkillDialog = () => {
    if (skillOperation === "reviewing" || skillOperation === "saving") return;
    closeSkillDialog();
  };
  const reviewSkill = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!client || skillOperation) return;
    const generation = ++skillOperationGeneration.current;
    setImportError("");
    try {
      if (skillArchiveFile) {
        let fileId = skillArchiveFileId;
        if (!fileId) {
          setSkillOperation("uploading");
          const controller = new AbortController();
          skillUploadController.current = controller;
          const stored = await client.uploadFile(skillArchiveFile, {
            origin: "user_upload",
            associationRole: "reference",
            onProgress: ({ ratio }) => setSkillUploadProgress(ratio),
            signal: controller.signal,
          });
          if (generation !== skillOperationGeneration.current) {
            await client.removeFileFromLibrary(stored.id).catch(() => undefined);
            return;
          }
          fileId = stored.id;
          setSkillArchiveFileId(fileId);
        }
        setSkillOperation("reviewing");
        const result = await client.reviewOrganizationSkillArchive(tenantId, fileId);
        if (generation === skillOperationGeneration.current) setReview(result);
      } else {
        setSkillOperation("reviewing");
        const result = await client.reviewOrganizationSkill(tenantId, {
          content: skillDraft.content,
          source: skillDraft.fileName ? "upload" : "text",
          packageFiles: skillDraft.packageFiles,
          resourceFiles: skillDraft.resourceFiles,
        });
        if (generation === skillOperationGeneration.current) setReview(result);
      }
    } catch (cause) {
      if (generation !== skillOperationGeneration.current) return;
      setImportError(
        cause instanceof Error ? cause.message : "Skill review failed",
      );
    } finally {
      if (generation === skillOperationGeneration.current) {
        skillUploadController.current = null;
        setSkillOperation(null);
      }
    }
  };
  const selectSkillFile = async (file: File | undefined) => {
    if (!file || skillOperation) return;
    discardSkillArchive();
    setImportError("");
    setReview(null);
    try {
      if (/\.(skill|zip)$/i.test(file.name)) {
        if (file.size > ORGANIZATION_SKILL_PACKAGE_MAX_BYTES) throw new Error("Organization skill archives are limited to 100 MB");
        setSkillArchiveFile(file);
        setSkillArchiveFileId(null);
        setSkillUploadProgress(0);
        setSkillDraft((current) => ({ ...current, content: "", packageFiles: [], resourceFiles: [], fileName: file.name }));
        setSkillSource("upload");
        return;
      }
      const imported = await readBrowserSkillImport(file);
      setSkillArchiveFile(null);
      setSkillArchiveFileId(null);
      setSkillUploadProgress(0);
      setSkillDraft((current) => ({
        ...current,
        content: imported.content,
        packageFiles: imported.packageFiles,
        resourceFiles: imported.resourceFiles,
        fileName: imported.fileName,
      }));
      setSkillSource("upload");
    } catch (cause) {
      setImportError(
        cause instanceof Error
          ? cause.message
          : "Could not read this skill package",
      );
    }
  };
  const saveSkill = async () => {
    if (!client || !review || skillOperation) return;
    setImportError("");
    setSkillOperation("saving");
    try {
      const allowUserDisable = skillDraft.assignment === "required" || skillDraft.assignment === "blocked"
        ? false
        : skillDraft.allowUserDisable;
      const uploadedFileId = skillArchiveFileId;
      const saved = uploadedFileId ? await client.installOrganizationSkillArchive(tenantId, {
        fileId: uploadedFileId,
        assignment: skillDraft.assignment,
        allowUserDisable,
      }) : await client.upsertOrganizationCapability(tenantId, {
        kind: "skill",
        capabilityId: review.name,
        name: review.name,
        description: review.description,
        assignment: skillDraft.assignment,
        allowUserDisable,
        contentHash: review.hash,
        config: { content: skillDraft.content },
        resourceFiles: skillDraft.resourceFiles,
      });
      r.setData([saved, ...r.data.filter((item: any) => !(item.kind === saved.kind && item.capabilityId === saved.capabilityId))]);
      if (uploadedFileId) await client.removeFileFromLibrary(uploadedFileId).catch(() => undefined);
      setAdding(false);
      setReview(null);
      setSkillArchiveFile(null);
      setSkillArchiveFileId(null);
      setSkillUploadProgress(0);
      setSkillDraft({ content: "", packageFiles: [], resourceFiles: [], fileName: "", assignment: "default-on", allowUserDisable: true });
      setMessage(`$${saved.name} is now available to the organization.`);
    } catch (cause) {
      setImportError(cause instanceof Error ? cause.message : "Could not add this skill to the organization.");
    } finally {
      setSkillOperation(null);
    }
  };
  const saveMcp = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!client) return;
    setImportError("");
    try {
      const url = new URL(mcpDraft.url);
      if (url.protocol !== "https:") throw new Error("Remote MCP servers must use HTTPS.");
      const capabilityId = `${mcpDraft.name}-${url.hostname}`.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "");
      const saved = await client.upsertOrganizationCapability(tenantId, {
        kind: "mcp",
        capabilityId,
        name: mcpDraft.name.trim(),
        description: mcpDraft.description.trim(),
        assignment: mcpDraft.assignment,
        allowUserDisable: mcpDraft.assignment === "required" || mcpDraft.assignment === "blocked" ? false : mcpDraft.allowUserDisable,
        config: { url: url.toString(), transport: "streamable-http" },
      });
      r.setData([saved, ...r.data.filter((item: any) => !(item.kind === saved.kind && item.capabilityId === saved.capabilityId))]);
      setAdding(false);
      setMcpDraft({ name: "", description: "", url: "", assignment: "available", allowUserDisable: true });
      setMessage(`${saved.name} MCP server is now available to the organization.`);
    } catch (cause) {
      setImportError(cause instanceof Error ? cause.message : "Could not add this MCP server.");
    }
  };
  const removeCapability = async (capability: any) => {
    if (!client) return;
    await client.deleteOrganizationCapability(tenantId, capability.id);
    r.setData(r.data.filter((item: any) => item.id !== capability.id));
    setActive(null);
    setMessage(`${capability.name} was removed from the organization catalog.`);
  };
  const updatePersonalPolicy = async (next: {
    skills: boolean;
    mcp: boolean;
  }) => {
    if (!client) return;
    policy.setData(
      await client.updateOrganizationCapabilitySettings(tenantId, next),
    );
    setMessage("Personal capability policy saved.");
  };
  return (
    <ManagementPage
      title="Skills & MCP"
      description="Choose organization capabilities and how they are assigned to members."
      eyebrow="AI controls"
      actions={
        canWrite ? (
          <Button
            onClick={() => {
              setAdding(true);
              setReview(null);
              setImportError("");
            }}
          >
            <Plus aria-hidden />
            {tab === "skill" ? "Add organization skill" : "Add MCP server"}
          </Button>
        ) : null
      }
    >
      <MetricGrid
        items={[
          {
            label: "Required",
            value: formatNumber(counts("required")),
            hint: "Cannot be disabled",
            status: "info" as any,
          },
          {
            label: "Default on",
            value: formatNumber(counts("default-on")),
            hint: "Enabled by default",
            status: "good",
          },
          {
            label: "Available",
            value: formatNumber(counts("available")),
            hint: "Can be enabled",
          },
          {
            label: "Blocked",
            value: formatNumber(counts("blocked")),
            hint: "Not available",
            status: "danger",
          },
        ]}
      />
      <TabBar
        label="Capability kind"
        active={tab}
        onSelect={(id) => {
          setTab(id);
          setActive(null);
        }}
        tabs={[
          { id: "skill", label: "Skills" },
          { id: "mcp", label: "MCP servers" },
        ]}
      />
      <ManagementDialog
        open={adding && tab === "skill"}
        onOpenChange={(open) => open ? setAdding(true) : requestCloseSkillDialog()}
        title={review ? "Review organization skill" : "Add organization skill"}
        description={review ? "Confirm the reviewed package and organization assignment." : "Select one source, provide the skill, then review it before publishing."}
        size="lg"
        footer={!review ? <>
          <Button type="button" variant="secondary" disabled={skillOperation === "reviewing"} onClick={requestCloseSkillDialog}>Cancel</Button>
          <Button type="submit" form="organization-skill-source-form" disabled={skillOperation !== null}><ShieldCheck aria-hidden />{skillOperation === "uploading" ? "Uploading…" : skillOperation === "reviewing" ? "Reviewing…" : "Review skill"}</Button>
        </> : <>
          <Button type="button" variant="secondary" disabled={skillOperation !== null} onClick={() => setReview(null)}>Back</Button>
          <Button type="button" disabled={skillOperation !== null} onClick={() => void saveSkill()}><Check aria-hidden />{skillOperation === "saving" ? "Adding…" : "Add to organization"}</Button>
        </>}
      >
        {!review ? (
          <form
            id="organization-skill-source-form"
            className="grid gap-4"
            onSubmit={reviewSkill}
          >
            <TabBar label="Skill source" active={skillSource} onSelect={(value) => {
              const source = value as "upload" | "paste";
              setSkillSource(source);
              setReview(null);
              setImportError("");
              if (source === "paste") {
                discardSkillArchive();
                setSkillDraft((current) => ({ ...current, fileName: "", packageFiles: [], resourceFiles: [] }));
              }
            }} tabs={[{ id: "upload", label: "Upload package" }, { id: "paste", label: "Paste SKILL.md" }]} />
            {skillSource === "upload" ? (
              <label
                className="settings-skill-dropzone"
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  if (skillOperation) return;
                  void selectSkillFile(event.dataTransfer.files[0]);
                }}
              >
                <input type="file" disabled={skillOperation !== null} accept=".skill,.zip,.md,text/markdown,application/zip" onChange={(event) => void selectSkillFile(event.currentTarget.files?.[0])} />
                <Upload aria-hidden />
                <span className="grid gap-0.5">
                  <b>{skillDraft.fileName || "Choose or drop a .skill package"}</b>
                  <small>.skill or .zip up to 100 MB · SKILL.md up to 256 KB</small>
                  {skillUploadProgress > 0 && skillUploadProgress < 1 ? <small>Uploading {Math.round(skillUploadProgress * 100)}%</small> : null}
                </span>
              </label>
            ) : (
              <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                SKILL.md content
                <Textarea
                  className="min-h-48 resize-y font-mono text-xs"
                  required
                  value={skillDraft.content}
                  placeholder="---\nname: example\ndescription: ...\n---"
                  onChange={(event) => {
                    if (skillArchiveFile || skillArchiveFileId) discardSkillArchive();
                    setSkillDraft({ ...skillDraft, content: event.currentTarget.value, fileName: "", packageFiles: [], resourceFiles: [] });
                  }}
                />
              </label>
            )}
            {importError ? (
              <div
                className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
                role="alert"
              >
                {importError}
              </div>
            ) : null}
          </form>
        ) : (
          <div className="grid gap-3 [&_dl]:grid [&_dl]:gap-3 sm:[&_dl]:grid-cols-3 [&_dt]:text-xs [&_dt]:text-muted-foreground [&_dd]:text-sm">
            <dl>
              <div>
                <dt>Skill</dt>
                <dd>${review.name}</dd>
              </div>
              <div>
                <dt>Description</dt>
                <dd>{review.description}</dd>
              </div>
              <div>
                <dt>Content hash</dt>
                <dd>
                  <code>{review.hash}</code>
                </dd>
              </div>
              <div>
                <dt>Package</dt>
                <dd>
                  {review.resources.length
                    ? `${review.resources.length + 1} files`
                    : "SKILL.md only"}
                </dd>
              </div>
            </dl>
            {review.warnings.length ? (
              <div
                className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
                role="alert"
              >
                {review.warnings.join(" · ")}
              </div>
            ) : (
              <p className="flex items-center gap-2 rounded-lg border border-[var(--berry-success)]/25 bg-[var(--berry-success)]/5 px-3 py-2 text-xs text-[var(--berry-success)]">
                <Check aria-hidden />
                No review warnings found.
              </p>
            )}
            <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
              Assignment
              <FormSelect
                value={skillDraft.assignment}
                onChange={(assignment) =>
                  setSkillDraft({
                    ...skillDraft,
                    assignment: assignment as OrgCapabilityAssignment,
                  })
                }
                options={[
                  { value: "required", label: "Required" },
                  { value: "default-on", label: "Default on" },
                  { value: "available", label: "Available" },
                  { value: "blocked", label: "Blocked" },
                ]}
              />
            </label>
            <label className="flex items-center justify-between gap-4 rounded-lg border border-border px-3 py-2.5 text-sm">
              <span className="grid min-w-0 gap-0.5">
                Allow user disable
                <small className="text-xs font-normal text-muted-foreground">Members can turn off default-on skills.</small>
              </span>
              <ManagementSwitch
                checked={skillDraft.allowUserDisable}
                disabled={
                  skillDraft.assignment === "required" ||
                  skillDraft.assignment === "blocked"
                }
                onCheckedChange={(allowUserDisable) =>
                  setSkillDraft({ ...skillDraft, allowUserDisable })
                }
                aria-label="Allow user disable"
              />
            </label>
          </div>
        )}
      </ManagementDialog>
      <ManagementDialog
        open={adding && tab === "mcp"}
        onOpenChange={setAdding}
        title="Add organization MCP server"
        description="Register a remote HTTPS MCP endpoint, then choose how it is assigned to members."
        size="lg"
        footer={<><Button type="button" variant="secondary" onClick={() => setAdding(false)}>Cancel</Button><Button type="submit" form="organization-mcp-form"><Plus aria-hidden />Add MCP server</Button></>}
      >
        <form id="organization-mcp-form" className="grid gap-3 sm:grid-cols-2 [&>label]:grid [&>label]:gap-1.5 [&>label]:text-xs [&>label]:font-medium [&>label]:text-muted-foreground" onSubmit={saveMcp}>
          <label>Name<Input required autoFocus value={mcpDraft.name} onChange={(event) => setMcpDraft({ ...mcpDraft, name: event.currentTarget.value })} placeholder="Company knowledge" /></label>
          <label>Assignment<FormSelect value={mcpDraft.assignment} onChange={(assignment) => setMcpDraft({ ...mcpDraft, assignment: assignment as OrgCapabilityAssignment })} options={[{ value: "required", label: "Required" }, { value: "default-on", label: "Default on" }, { value: "available", label: "Available" }, { value: "blocked", label: "Blocked" }]} /></label>
          <label className="sm:col-span-2">Remote MCP URL<Input required type="url" value={mcpDraft.url} onChange={(event) => setMcpDraft({ ...mcpDraft, url: event.currentTarget.value })} placeholder="https://mcp.example.com/mcp" /></label>
          <label className="sm:col-span-2">Description<Textarea className="min-h-24 resize-y" value={mcpDraft.description} onChange={(event) => setMcpDraft({ ...mcpDraft, description: event.currentTarget.value })} /></label>
          <label className="sm:col-span-2 flex-row items-center justify-between rounded-lg border border-border px-3 py-2.5 text-sm text-foreground">
            <span className="grid gap-0.5">Allow member disable<small className="text-xs font-normal text-muted-foreground">Members can turn off this server unless it is required.</small></span>
            <ManagementSwitch checked={mcpDraft.allowUserDisable} disabled={mcpDraft.assignment === "required" || mcpDraft.assignment === "blocked"} onCheckedChange={(allowUserDisable) => setMcpDraft({ ...mcpDraft, allowUserDisable })} aria-label="Allow member disable" />
          </label>
          {importError ? <p className="sm:col-span-2 text-xs text-destructive" role="alert">{importError}</p> : null}
        </form>
      </ManagementDialog>
      <Section
        title="Personal MCP servers"
        description="Personal skills are always available. Control whether members can add remote MCP servers."
      >
        <div className="grid gap-2">
          <label className="flex items-center justify-between gap-4 rounded-lg border border-border px-3 py-2.5 text-sm">
            <span className="grid min-w-0 gap-0.5">
              Personal MCP servers
              <small className="text-xs font-normal text-muted-foreground">Members can add their own remote MCP servers.</small>
            </span>
            <ManagementSwitch
              checked={policy.data.mcp}
              disabled={!canWriteMcp}
              onCheckedChange={(mcp) =>
                void updatePersonalPolicy({ ...policy.data, mcp })
              }
              aria-label="Allow personal MCP servers"
            />
          </label>
        </div>
      </Section>
      <Toolbar>
        <SearchInput
          label="Search capabilities"
          value={query}
          onChange={setQuery}
          placeholder="Search capabilities"
        />
        <FilterSelect
          label="Assignment"
          value={assignment}
          onChange={setAssignment}
          options={[
            { value: "all", label: "All" },
            { value: "required", label: "Required" },
            { value: "default-on", label: "Default on" },
            { value: "available", label: "Available" },
            { value: "blocked", label: "Blocked" },
          ]}
        />
      </Toolbar>
      {message ? <SuccessMessage>{message}</SuccessMessage> : null}
      <div className={detail ? "min-w-0" : undefined}>
        <AsyncState
          loading={r.loading}
          error={r.error}
          onRetry={r.retry}
          empty={rows.length === 0}
          emptyTitle="No organization capabilities"
          emptyText="Skills and MCP servers assigned to the organization will appear here."
        >
          <DataTable
            label="Organization capabilities"
            columns={["Capability", "Assignment", "User override", "Package"]}
            onRowSelect={setActive}
            activeRow={active}
            rowLabel={(i) => rows[i].name}
            rows={rows.map((c: any) => [
              <span className="grid min-w-0 gap-0.5 [&_b]:truncate [&_b]:text-sm [&_small]:text-xs [&_small]:text-muted-foreground">
                <b>{c.name}</b>
                <small>{c.capabilityId}</small>
              </span>,
              <StatusPill tone={assignmentTone(c.assignment) as any}>
                {humanize(c.assignment)}
              </StatusPill>,
              c.allowUserDisable ? "Allowed" : "Not allowed",
              c.kind === "skill" ? `${Number(c.resources?.length ?? 0) + 1} files · ${formatPackageBytes(Number(c.packageBytes ?? 0))}` : c.contentHash ? "Signed" : "Unsigned",
            ])}
          />
        </AsyncState>
        {detail ? (
          <DetailDrawer
            title={detail.name}
            subtitle={detail.capabilityId}
            badge={
              <StatusPill tone={assignmentTone(detail.assignment) as any}>
                {humanize(detail.assignment)}
              </StatusPill>
            }
            onClose={() => setActive(null)}
          >
            {detail.description ? (
              <p className="text-sm leading-6 text-muted-foreground">
                {detail.description}
              </p>
            ) : null}
            <DefinitionList
              items={[
                {
                  term: "Type",
                  detail: detail.kind === "skill" ? "Skill" : "MCP server",
                },
                {
                  term: "Content hash",
                  detail: detail.contentHash ? (
                    <code className="inline-flex items-center gap-1 font-mono text-xs">
                      {detail.contentHash.slice(0, 20)}…
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => copyText(detail.contentHash)}
                        aria-label="Copy hash"
                      >
                        <Copy aria-hidden />
                      </Button>
                    </code>
                  ) : (
                    "Unsigned"
                  ),
                },
                ...(detail.kind === "skill" ? [{
                  term: "Package",
                  detail: `${Number(detail.resources?.length ?? 0) + 1} files · ${formatPackageBytes(Number(detail.packageBytes ?? 0))}`,
                }] : []),
                { term: "Updated", detail: formatDateTime(detail.updatedAt) },
              ]}
            />
            <fieldset className="grid gap-3 border-0 p-0" disabled={!canWrite}>
              <legend>Assignment</legend>
              <FilterSelect
                label="Assignment"
                value={detail.assignment}
                onChange={(v) => setAssignmentValue(detail, v)}
                options={[
                  { value: "required", label: "Required" },
                  { value: "default-on", label: "Default on" },
                  { value: "available", label: "Available" },
                  { value: "blocked", label: "Blocked" },
                ]}
              />
            </fieldset>
            <label className="flex items-center justify-between gap-4 rounded-lg border border-border px-3 py-2.5 text-sm">
              <span className="grid min-w-0 gap-0.5">
                Allow user disable
                <small className="text-xs font-normal text-muted-foreground">Members can turn this off for themselves.</small>
              </span>
              <ManagementSwitch
                checked={Boolean(detail.allowUserDisable)}
                disabled={!canWrite || detail.assignment === "required"}
                onCheckedChange={(checked) => setAllowDisable(detail, checked)}
                aria-label="Allow user disable"
              />
            </label>
            {canWrite ? (
              <Button
                variant="secondary"
                onClick={() => void removeCapability(detail)}
              >
                <Trash2 aria-hidden />
                Remove capability
              </Button>
            ) : null}
          </DetailDrawer>
        ) : null}
      </div>
    </ManagementPage>
  );
}

/* ----------------------------------------------------------- feature access */
