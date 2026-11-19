import * as React from "react";
import { useRefreshModelCatalog } from "@/lib/model-catalog";
import { Check, Copy, Plus, ShieldCheck, Trash2, Upload } from "lucide-react";
import {
  ORGANIZATION_SKILL_PACKAGE_MAX_BYTES,
  type OrgCapabilityAssignment,
  type PersonalSkillReview,
} from "@berry/shared";
import { readBrowserSkillImport } from "@/lib/skill-import";
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
  ManagementSwitch,
  Section,
  SegmentedControl,
  SettingList,
  SettingRow,
  StatusPill,
  SuccessMessage,
  Textarea,
  formatDate,
  formatDateTime,
} from "./management-primitives";
import { useResource, type ManagementScreenProps } from "./management-context";

const ASSIGNMENTS: Array<{ value: OrgCapabilityAssignment; label: string; tone: "info" | "good" | "neutral" | "danger"; help: string }> = [
  { value: "required", label: "Required", tone: "info", help: "Always on. Members cannot turn it off." },
  { value: "default-on", label: "On by default", tone: "good", help: "On for every member until they turn it off." },
  { value: "available", label: "Available", tone: "neutral", help: "Off until a member turns it on." },
  { value: "blocked", label: "Blocked", tone: "danger", help: "Nobody in the organization can use it." },
];
const ASSIGNMENT_OPTIONS = ASSIGNMENTS.map(({ value, label }) => ({ value, label }));
const assignmentInfo = (value: string) => ASSIGNMENTS.find((item) => item.value === value) ?? { value, label: value, tone: "neutral" as const, help: "" };
/** Required and blocked items leave the member no choice, so the opt-out switch does not apply. */
const optOutFixed = (assignment: string) => assignment === "required" || assignment === "blocked";
const fieldLabel = "grid gap-1.5 text-xs font-medium text-muted-foreground";
const help = "text-xs font-normal leading-4";

function AssignmentPill({ value }: { value: string }) {
  const info = assignmentInfo(value);
  return <StatusPill tone={info.tone}>{info.label}</StatusPill>;
}
function copyText(value: string) {
  void navigator.clipboard?.writeText(value).catch(() => {});
}
function formatPackageBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function packageSummary(capability: any) {
  const files = Number(capability.resources?.length ?? 0) + 1;
  return `${files} ${files === 1 ? "file" : "files"} · ${formatPackageBytes(Number(capability.packageBytes ?? 0))}`;
}
function serverUrl(capability: any): string | null {
  const url = capability?.config && typeof capability.config === "object" ? (capability.config as any).url : null;
  return typeof url === "string" && url ? url : null;
}

export function AdminSkillsMcpScreen({
  client,
  tenantId,
  permissions,
}: ManagementScreenProps) {
  const refreshCatalog = useRefreshModelCatalog();
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
  const [tab, setTab] = React.useState<"skill" | "mcp">("skill");
  const [skillSource, setSkillSource] = React.useState<"upload" | "paste">("upload");
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState("");
  const [actionBusy, setActionBusy] = React.useState(false);
  const [removing, setRemoving] = React.useState<any>(null);
  const [message, setMessage] = React.useState("");
  const [adding, setAdding] = React.useState(false);
  const [review, setReview] = React.useState<PersonalSkillReview | null>(null);
  const [importError, setImportError] = React.useState("");
  const [skillArchiveFile, setSkillArchiveFile] = React.useState<File | null>(null);
  const [skillArchiveFileId, setSkillArchiveFileId] = React.useState<string | null>(null);
  const [skillUploadProgress, setSkillUploadProgress] = React.useState(0);
  const [skillOperation, setSkillOperation] = React.useState<"uploading" | "reviewing" | "saving" | null>(null);
  const skillOperationGeneration = React.useRef(0);
  const skillOperationLock = React.useRef(false);
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
  const ASSIGNMENT_ORDER: Record<string, number> = { blocked: 0, required: 1, "default-on": 2, available: 3 };
  // Restrictions first (blocked, required), then by name.
  const rows = r.data
    .filter((c: any) => c.kind === tab)
    .sort((left: any, right: any) =>
      (ASSIGNMENT_ORDER[left.assignment] ?? 9) - (ASSIGNMENT_ORDER[right.assignment] ?? 9)
      || String(left.name).localeCompare(String(right.name)),
    );
  const activeIndex = rows.findIndex((c: any) => c.id === activeId);
  const detail = activeIndex >= 0 ? rows[activeIndex] : null;
  /** Runs a quick change and shows a failure instead of dropping it. */
  const guarded = async (action: () => Promise<void>, fallback: string) => {
    setActionBusy(true);
    setActionError("");
    try {
      await action();
    } catch (cause) {
      setActionError(cause instanceof Error && cause.message ? cause.message : fallback);
    } finally {
      setActionBusy(false);
    }
  };
  const setAllowDisable = (capability: any, allow: boolean) => guarded(async () => {
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
    refreshCatalog();
    setMessage(`${capability.name} updated and recorded in the audit log.`);
  }, "The change could not be saved.");
  const setAssignmentValue = (capability: any, value: string) => guarded(async () => {
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
    refreshCatalog();
    setMessage(`${capability.name} is now ${assignmentInfo(value).label.toLowerCase()}. Recorded in the audit log.`);
  }, "The assignment could not be saved.");
  const discardSkillArchive = (fileId = skillArchiveFileId) => {
    skillUploadController.current?.abort();
    skillUploadController.current = null;
    skillOperationGeneration.current += 1;
    skillOperationLock.current = false;
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
    if (skillOperationLock.current && !skillUploadController.current) return;
    closeSkillDialog();
  };
  const reviewSkill = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!client || skillOperationLock.current) return;
    skillOperationLock.current = true;
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
        skillOperationLock.current = false;
        skillUploadController.current = null;
        setSkillOperation(null);
      }
    }
  };
  const selectSkillFile = async (file: File | undefined) => {
    if (!file || skillOperationLock.current) return;
    discardSkillArchive();
    const generation = skillOperationGeneration.current;
    skillOperationLock.current = true;
    setSkillOperation("reviewing");
    setImportError("");
    setReview(null);
    try {
      if (/\.(skill|zip)$/i.test(file.name)) {
        if (file.size > ORGANIZATION_SKILL_PACKAGE_MAX_BYTES) throw new Error("Organization skill archives are limited to 500 MB");
        setSkillArchiveFile(file);
        setSkillArchiveFileId(null);
        setSkillUploadProgress(0);
        setSkillDraft((current) => ({ ...current, content: "", packageFiles: [], resourceFiles: [], fileName: file.name }));
        setSkillSource("upload");
        return;
      }
      const imported = await readBrowserSkillImport(file);
      if (generation !== skillOperationGeneration.current) return;
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
    } finally {
      if (generation === skillOperationGeneration.current) {
        skillOperationLock.current = false;
        setSkillOperation(null);
      }
    }
  };
  const saveSkill = async () => {
    if (!client || !review || skillOperationLock.current) return;
    skillOperationLock.current = true;
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
      refreshCatalog();
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
      skillOperationLock.current = false;
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
      refreshCatalog();
      r.setData([saved, ...r.data.filter((item: any) => !(item.kind === saved.kind && item.capabilityId === saved.capabilityId))]);
      setAdding(false);
      setMcpDraft({ name: "", description: "", url: "", assignment: "available", allowUserDisable: true });
      setMessage(`${saved.name} MCP server is now available to the organization.`);
    } catch (cause) {
      setImportError(cause instanceof Error ? cause.message : "Could not add this MCP server.");
    }
  };
  const removeCapability = (capability: any) => guarded(async () => {
    if (!client) return;
    await client.deleteOrganizationCapability(tenantId, capability.id);
    refreshCatalog();
    r.setData(r.data.filter((item: any) => item.id !== capability.id));
    setActiveId(null);
    setRemoving(null);
    setMessage(`${capability.name} was removed from the organization.`);
  }, "The item could not be removed.");
  const updatePersonalPolicy = (next: {
    skills: boolean;
    mcp: boolean;
  }) => guarded(async () => {
    if (!client) return;
    policy.setData(
      await client.updateOrganizationCapabilitySettings(tenantId, next),
    );
    refreshCatalog();
    setMessage(next.mcp ? "Members can now add their own MCP servers." : "Members can no longer add their own MCP servers.");
  }, "The setting could not be saved.");
  const noun = tab === "skill" ? "skill" : "MCP server";
  const openAdd = () => {
    setAdding(true);
    setReview(null);
    setImportError("");
  };
  const addButton = canWrite ? (
    <Button onClick={openAdd}>
      <Plus aria-hidden />
      {tab === "skill" ? "Add skill" : "Add MCP server"}
    </Button>
  ) : null;
  const optOutRow = (checked: boolean, assignment: string, disabled: boolean, onChange: (next: boolean) => void, label: string) => (
    <div className="flex items-center justify-between gap-4">
      <span className="grid gap-0.5">
        <b className="text-md font-medium text-foreground">Members can turn it off</b>
        <small className="text-xs leading-5 text-muted-foreground">
          {assignment === "required" ? "Does not apply: required items are always on."
            : assignment === "blocked" ? "Does not apply: blocked items are never on."
            : "Each member can switch this off for themselves."}
        </small>
      </span>
      <ManagementSwitch
        checked={optOutFixed(assignment) ? false : checked}
        disabled={disabled || optOutFixed(assignment)}
        onCheckedChange={onChange}
        aria-label={label}
      />
    </div>
  );
  return (
    <ManagementPage
      title="Skills & MCP"
      description="The skills and MCP servers the organization gives its members, and whether each one is required, on by default, optional, or blocked."
      eyebrow="AI & tools"
      actions={addButton}
    >
      <SegmentedControl
        label="Kind"
        value={tab}
        onChange={(id) => {
          setTab(id);
          setActiveId(null);
          setActionError("");
        }}
        options={[
          { value: "skill", label: "Skills" },
          { value: "mcp", label: "MCP servers" },
        ]}
      />
      {message ? <SuccessMessage>{message}</SuccessMessage> : null}
      {actionError && !detail && !removing ? <InlineNotice tone="danger">{actionError}</InlineNotice> : null}
      <AsyncState loading={r.loading} error={r.error} onRetry={r.retry}>
        {rows.length === 0 ? (
          <EmptyPanel
            title={tab === "skill" ? "No organization skills" : "No organization MCP servers"}
            description={tab === "skill"
              ? "Add a skill package to give every member the same instructions and tools."
              : "Add a remote MCP server to assign it to members as required, on by default, or optional."}
            action={addButton}
          />
        ) : (
          <DataTable
            label={tab === "skill" ? "Organization skills" : "Organization MCP servers"}
            columns={[tab === "skill" ? "Skill" : "Server", "Assignment", "Members can turn off", tab === "skill" ? "Package" : "Address", "Updated"]}
            onRowSelect={(index) => { setActionError(""); setActiveId(rows[index]?.id ?? null); }}
            activeRow={activeIndex >= 0 ? activeIndex : null}
            rowLabel={(i) => rows[i].name}
            rows={rows.map((c: any) => [
              <CellStack primary={c.name} secondary={c.description || <span className="font-mono">{c.capabilityId}</span>} />,
              <AssignmentPill value={c.assignment} />,
              optOutFixed(c.assignment) ? <span className="text-muted-foreground">—</span> : c.allowUserDisable ? "Yes" : "No",
              c.kind === "skill"
                ? packageSummary(c)
                : serverUrl(c) ? <span className="block max-w-72 truncate font-mono text-xs" title={serverUrl(c) ?? undefined}>{serverUrl(c)}</span> : <span className="text-muted-foreground">—</span>,
              formatDate(c.updatedAt),
            ])}
          />
        )}
      </AsyncState>
      {tab === "mcp" ? (
        <Section flush title="Member-added servers" description="Separate from the organization servers above. Servers that members ask to share with everyone are reviewed under MCP approvals.">
          <SettingList>
            <SettingRow
              title="Members can add their own MCP servers"
              description={canWriteMcp ? "When off, members can only use servers the organization provides." : "Changing this needs the “Connectors & MCP: manage” permission."}
            >
              <ManagementSwitch
                checked={policy.data.mcp}
                disabled={!canWriteMcp || actionBusy || policy.loading}
                onCheckedChange={(mcp) =>
                  void updatePersonalPolicy({ ...policy.data, mcp })
                }
                aria-label="Allow personal MCP servers"
              />
            </SettingRow>
          </SettingList>
        </Section>
      ) : (
        <p className="text-xs leading-5 text-muted-foreground">Members can always add personal skills for themselves. An administrator can review a member’s skills from People → Members.</p>
      )}

      {detail ? (
        <DetailDrawer
          title={detail.name}
          subtitle={<code>{detail.capabilityId}</code>}
          badge={<AssignmentPill value={detail.assignment} />}
          onClose={() => setActiveId(null)}
          footer={canWrite ? (
            <Button variant="ghost" disabled={actionBusy} onClick={() => setRemoving(detail)}>
              <Trash2 aria-hidden />
              Remove {noun}
            </Button>
          ) : undefined}
        >
          {!canWrite ? <InlineNotice tone="info">You can view this {noun}. Changing it needs the “{tab === "skill" ? "Skills" : "Connectors & MCP"}: manage” permission.</InlineNotice> : null}
          {actionError ? <InlineNotice tone="danger">{actionError}</InlineNotice> : null}
          {detail.description ? (
            <p className="text-md leading-5 text-muted-foreground">
              {detail.description}
            </p>
          ) : null}
          <label className={fieldLabel}>
            Assignment
            <FormSelect
              ariaLabel="Assignment"
              value={detail.assignment}
              disabled={!canWrite || actionBusy}
              onChange={(v) => { if (v !== detail.assignment) void setAssignmentValue(detail, v); }}
              options={ASSIGNMENT_OPTIONS}
            />
            <small className={help}>{assignmentInfo(detail.assignment).help} Changes save immediately.</small>
          </label>
          {optOutRow(Boolean(detail.allowUserDisable), detail.assignment, !canWrite || actionBusy, (checked) => void setAllowDisable(detail, checked), "Members can turn it off")}
          <DefinitionList
            items={[
              ...(detail.kind === "mcp" && serverUrl(detail) ? [{ term: "Address", detail: <code className="break-all">{serverUrl(detail)}</code> }] : []),
              ...(detail.kind === "skill" ? [{ term: "Package", detail: packageSummary(detail) }] : []),
              {
                term: "Content hash",
                detail: detail.contentHash ? (
                  <span className="inline-flex items-center gap-1">
                    <code title={detail.contentHash}>{detail.contentHash.slice(0, 16)}…</code>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => copyText(detail.contentHash)}
                      aria-label="Copy content hash"
                    >
                      <Copy aria-hidden />
                    </Button>
                  </span>
                ) : (
                  "None recorded"
                ),
              },
              { term: "Updated", detail: formatDateTime(detail.updatedAt) },
            ]}
          />
        </DetailDrawer>
      ) : null}

      <ManagementDialog
        open={Boolean(removing)}
        onOpenChange={(open) => { if (!open && !actionBusy) setRemoving(null); }}
        title={`Remove ${removing?.name ?? ""}?`}
        description={`Members lose this ${removing?.kind === "mcp" ? "MCP server" : "skill"} immediately. To offer it again you will need to add it again.`}
        size="sm"
        footer={<>
          <Button type="button" variant="secondary" disabled={actionBusy} onClick={() => setRemoving(null)}>Cancel</Button>
          <Button type="button" variant="destructive" disabled={actionBusy} onClick={() => void removeCapability(removing)}>{actionBusy ? "Removing…" : "Remove"}</Button>
        </>}
      >
        {actionError ? <InlineNotice tone="danger">{actionError}</InlineNotice> : <p className="text-md leading-5 text-muted-foreground">To stop members using it without deleting it, set its assignment to Blocked instead.</p>}
      </ManagementDialog>

      <ManagementDialog
        open={adding && tab === "skill"}
        onOpenChange={(open) => open ? setAdding(true) : requestCloseSkillDialog()}
        title={review ? "Review skill" : "Add skill"}
        description={review ? "Check what was found in the package, then choose how it is assigned to members." : "Upload a skill package or paste a SKILL.md. Berry checks it before anything is published."}
        size="lg"
        footer={!review ? <>
          <Button type="button" variant="secondary" disabled={skillOperation === "reviewing"} onClick={requestCloseSkillDialog}>Cancel</Button>
          <Button type="submit" form="organization-skill-source-form" disabled={skillOperation !== null}><ShieldCheck aria-hidden />{skillOperation === "uploading" ? "Uploading…" : skillOperation === "reviewing" ? "Checking…" : "Check skill"}</Button>
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
            <SegmentedControl label="Skill source" value={skillSource} onChange={(source) => {
              setSkillSource(source);
              setReview(null);
              setImportError("");
              if (source === "paste") {
                discardSkillArchive();
                setSkillDraft((current) => ({ ...current, fileName: "", packageFiles: [], resourceFiles: [] }));
              }
            }} options={[{ value: "upload", label: "Upload package" }, { value: "paste", label: "Paste SKILL.md" }]} />
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
                  <small>.skill or .zip up to 500 MB · SKILL.md up to 256 KB</small>
                  {skillUploadProgress > 0 && skillUploadProgress < 1 ? <small>Uploading {Math.round(skillUploadProgress * 100)}%</small> : null}
                </span>
              </label>
            ) : (
              <label className={fieldLabel}>
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
            {importError ? <InlineNotice tone="danger">{importError}</InlineNotice> : null}
          </form>
        ) : (
          <div className="grid gap-4">
            <DefinitionList
              items={[
                { term: "Skill", detail: <code>${review.name}</code> },
                { term: "Description", detail: review.description || "—" },
                { term: "Package", detail: review.resources.length ? `${review.resources.length + 1} files` : "SKILL.md only" },
                { term: "Content hash", detail: <code className="break-all">{review.hash}</code> },
              ]}
            />
            {review.warnings.length ? (
              <InlineNotice tone="warning" title={review.warnings.length === 1 ? "1 thing to check before publishing" : `${review.warnings.length} things to check before publishing`}>
                <ul className="grid gap-0.5">
                  {review.warnings.map((warning) => <li key={warning}>{warning}</li>)}
                </ul>
              </InlineNotice>
            ) : (
              <InlineNotice tone="good">The check found nothing to flag.</InlineNotice>
            )}
            <label className={fieldLabel}>
              Assignment
              <FormSelect
                ariaLabel="Assignment"
                value={skillDraft.assignment}
                onChange={(assignment) =>
                  setSkillDraft({
                    ...skillDraft,
                    assignment: assignment as OrgCapabilityAssignment,
                  })
                }
                options={ASSIGNMENT_OPTIONS}
              />
              <small className={help}>{assignmentInfo(skillDraft.assignment).help}</small>
            </label>
            {optOutRow(skillDraft.allowUserDisable, skillDraft.assignment, false, (allowUserDisable) => setSkillDraft({ ...skillDraft, allowUserDisable }), "Members can turn it off")}
            {importError ? <InlineNotice tone="danger">{importError}</InlineNotice> : null}
          </div>
        )}
      </ManagementDialog>
      <ManagementDialog
        open={adding && tab === "mcp"}
        onOpenChange={setAdding}
        title="Add MCP server"
        description="Register a remote HTTPS MCP server and choose how it is assigned to members."
        size="lg"
        footer={<><Button type="button" variant="secondary" onClick={() => setAdding(false)}>Cancel</Button><Button type="submit" form="organization-mcp-form"><Plus aria-hidden />Add MCP server</Button></>}
      >
        <form id="organization-mcp-form" className="grid gap-3 sm:grid-cols-2" onSubmit={saveMcp}>
          <label className={fieldLabel}>Name<Input required autoFocus value={mcpDraft.name} onChange={(event) => setMcpDraft({ ...mcpDraft, name: event.currentTarget.value })} placeholder="Company knowledge" /></label>
          <label className={fieldLabel}>
            Assignment
            <FormSelect ariaLabel="Assignment" value={mcpDraft.assignment} onChange={(assignment) => setMcpDraft({ ...mcpDraft, assignment: assignment as OrgCapabilityAssignment })} options={ASSIGNMENT_OPTIONS} />
            <small className={help}>{assignmentInfo(mcpDraft.assignment).help}</small>
          </label>
          <label className={`${fieldLabel} sm:col-span-2`}>Server URL<Input required type="url" value={mcpDraft.url} onChange={(event) => setMcpDraft({ ...mcpDraft, url: event.currentTarget.value })} placeholder="https://mcp.example.com/mcp" /><small className={help}>Must be HTTPS.</small></label>
          <label className={`${fieldLabel} sm:col-span-2`}>Description<Textarea className="min-h-24 resize-y" value={mcpDraft.description} onChange={(event) => setMcpDraft({ ...mcpDraft, description: event.currentTarget.value })} /></label>
          <div className="sm:col-span-2">
            {optOutRow(mcpDraft.allowUserDisable, mcpDraft.assignment, false, (allowUserDisable) => setMcpDraft({ ...mcpDraft, allowUserDisable }), "Members can turn it off")}
          </div>
        </form>
        {importError ? <div className="mt-3"><InlineNotice tone="danger">{importError}</InlineNotice></div> : null}
      </ManagementDialog>
    </ManagementPage>
  );
}
