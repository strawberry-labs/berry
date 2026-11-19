import { toast } from "sonner";
import * as React from "react";
import { Skeleton } from "@berry/desktop-ui/components/ui/skeleton";
import { useRefreshModelCatalog } from "@/lib/model-catalog";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft,
  BookOpen,
  Check,
  ChevronDown,
  Download,
  EllipsisVertical,
  File,
  FileCode2,
  FileImage,
  Folder,
  LoaderCircle,
  MessageCircle,
  Plus,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { BerryApiError, type BerryApiClient } from "@berry/api-client";
import { cn } from "@berry/desktop-ui/lib/utils";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@berry/desktop-ui/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@berry/desktop-ui/components/ui/dropdown-menu";
import type { EffectiveCapability, PersonalSkill } from "@berry/shared";
import { createBrowserSkillExport } from "@/lib/skill-import";
import {
  AsyncState,
  Button,
  CellStack,
  DataTable,
  EmptyPanel,
  InlineNotice,
  ManagementDialog,
  ManagementPage,
  ManagementSwitch,
  Section,
  SegmentedControl,
  StatusPill,
} from "./management-primitives";
import { useResource, type ManagementScreenProps } from "./management-context";

// Loaded on demand so the skills list stays light: the import dialog (and its archive reader)
// only when someone imports a skill, and the Markdown renderer only when a skill is opened.
const SkillImportDialog = React.lazy(() => import("./skill-import-dialog").then((module) => ({ default: module.SkillImportDialog })));
const Markdown = React.lazy(() => import("@berry/desktop-ui/components/berry-markdown").then((module) => ({ default: module.Markdown })));

type SkillCatalogRow = {
  key: string;
  capabilityId: string;
  name: string;
  description: string;
  content: string | null;
  enabled: boolean;
  locked: boolean;
  provenance: "organization" | "personal" | "self-host-bootstrap";
  assignment: EffectiveCapability["assignment"];
  reason: EffectiveCapability["reason"] | "deployment";
  packageFiles: string[];
  packageStorage: "stored" | "managed" | "definition-only";
  packageBytes: number;
  personal?: PersonalSkill;
};

const emptySkillResource = {
  personal: [] as PersonalSkill[],
  effective: [] as EffectiveCapability[],
};
export async function loadPersonalSkillResource(
  client: Pick<BerryApiClient, "listPersonalSkills" | "effectiveCapabilities">,
  tenantId: string,
): Promise<typeof emptySkillResource> {
  const [personal, effective] = await Promise.all([
    client.listPersonalSkills(),
    client.effectiveCapabilities(tenantId).catch((cause) => {
      if (cause instanceof BerryApiError && cause.status === 403) return [];
      throw cause;
    }),
  ]);
  return { personal, effective };
}

export async function loadSkillPackageForDownload(
  client: Pick<BerryApiClient, "personalSkillPackage" | "organizationSkillPackage"> | null,
  tenantId: string,
  skill: Pick<SkillCatalogRow, "capabilityId" | "content" | "personal" | "provenance">,
) {
  if (!skill.content) throw new Error("This skill has no downloadable content");
  if (client && skill.personal) return client.personalSkillPackage(skill.personal.id);
  if (client && skill.provenance === "organization") {
    return client.organizationSkillPackage(tenantId, skill.capabilityId);
  }
  return { content: skill.content, resourceFiles: [] };
}

/** Builds the portable .skill package and hands it to the browser as a download. */
async function downloadSkillPackage(client: BerryApiClient | null, tenantId: string, skill: SkillCatalogRow) {
  const skillPackage = await loadSkillPackageForDownload(client, tenantId, skill);
  const exported = await createBrowserSkillExport(skill.name, skillPackage.content, skillPackage.resourceFiles);
  const url = URL.createObjectURL(exported.blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = exported.fileName;
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
}

/** Skill takes the spare width; source and status stay just wide enough for their text. */
const SKILL_COLUMN_WIDTHS = [undefined, 150, 300];

function skillDisplayName(skill: Pick<SkillCatalogRow, "name">): string {
  return skill.name.startsWith("$") ? skill.name : `$${skill.name}`;
}

export function PersonalSkillsScreen({
  client,
  config,
  tenantId,
  supportView,
  permissions,
}: ManagementScreenProps) {
  const navigate = useNavigate();
  // Organization skills can be deleted by people who manage the org's skills.
  const canDeleteOrgSkills = Boolean(client) && !supportView && permissions.includes("skills:write");
  const refreshCatalog = useRefreshModelCatalog();
  const [creating, setCreating] = React.useState(false);
  const [selected, setSelected] = React.useState<SkillCatalogRow | null>(null);
  const [pendingRemove, setPendingRemove] = React.useState<SkillCatalogRow | null>(null);
  const [removing, setRemoving] = React.useState(false);
  const [removeError, setRemoveError] = React.useState("");
  const resource = useResource(
    `personal-skills:${tenantId}`,
    async () =>
      client ? loadPersonalSkillResource(client, tenantId) : emptySkillResource,
    emptySkillResource,
  );
  const rows = React.useMemo(
    () =>
      buildSkillRows(
        resource.data.personal,
        resource.data.effective,
        config.skills,
      ).map((skill) => supportView && !skill.personal ? { ...skill, locked: true } : skill),
    [resource.data, config.skills, supportView],
  );

  async function toggle(skill: SkillCatalogRow, enabled: boolean) {
    if (!client) return;
    if (skill.personal)
      await client.updatePersonalSkill(skill.personal.id, { enabled });
    else
      await client.setCapabilityOverride(
        tenantId,
        "skill",
        skill.capabilityId,
        enabled,
      );
    setSelected((current) =>
      current?.key === skill.key ? { ...current, enabled } : current,
    );
    resource.retry();
    refreshCatalog();
  }

  async function remove(skill: SkillCatalogRow) {
    if (!client) return;
    if (skill.personal) {
      await client.deletePersonalSkill(skill.personal.id);
    } else if (skill.provenance === "organization") {
      // The effective list names the skill; deleting needs the organization's own record.
      const records = await client.listOrganizationCapabilities(tenantId);
      const record = records.find((item) => item.kind === "skill" && (item.capabilityId === skill.capabilityId || item.name.toLowerCase() === skill.name.toLowerCase()));
      if (!record) throw new Error("This skill is no longer in your organization’s catalog.");
      const result = await client.deleteOrganizationCapability(tenantId, record.id);
      if (!result.ok) throw new Error("The skill could not be deleted.");
    } else {
      throw new Error("Skills built into this deployment cannot be deleted here.");
    }
    setSelected(null);
    resource.retry();
    refreshCatalog();
  }

  async function confirmRemove() {
    if (!pendingRemove) return;
    setRemoving(true);
    setRemoveError("");
    try {
      await remove(pendingRemove);
      toast.success(`Deleted ${skillDisplayName(pendingRemove)}`);
      setPendingRemove(null);
    } catch (cause) {
      setRemoveError(cause instanceof Error ? cause.message : "Could not delete this skill");
    } finally {
      setRemoving(false);
    }
  }

  /** Who may delete this skill, and if not, why not. */
  function deleteAccess(skill: SkillCatalogRow): { allowed: boolean; reason?: string } {
    if (!client) return { allowed: false, reason: "Connect to Berry to delete skills" };
    if (skill.personal) return { allowed: true };
    if (skill.provenance === "organization") {
      return canDeleteOrgSkills
        ? { allowed: true }
        : { allowed: false, reason: "Only admins who manage skills can delete organization skills. You can turn it off instead." };
    }
    return { allowed: false, reason: "Built into this deployment, so it cannot be deleted here" };
  }

  function requestRemove(skill: SkillCatalogRow) {
    setRemoveError("");
    setPendingRemove(skill);
  }

  function download(skill: SkillCatalogRow) {
    void downloadSkillPackage(client, tenantId, skill).catch((cause) => toast.error(cause instanceof Error ? cause.message : "Could not download this skill"));
  }

  function tryInChat(skill: SkillCatalogRow) {
    window.localStorage.setItem("berry.web.pendingPrompt", `$${skill.capabilityId} `);
    setSelected(null);
    void navigate({ to: "/" });
  }

  return (
    <ManagementPage
      title="Skills"
      description="Skills are packaged instructions Berry follows for a kind of work. Turn on the ones you want, or import your own."
      actions={
        <Button
          disabled={!client}
          onClick={() => {
            setCreating(true);
          }}
        >
          <Plus />
          Import skill
        </Button>
      }
    >
      {creating ? (
        <React.Suspense fallback={null}>
          <SkillImportDialog client={client} tenantId={tenantId} open={creating} onOpenChange={setCreating} onSuccess={() => { toast.success("Skill imported and enabled"); resource.retry(); refreshCatalog(); }} />
        </React.Suspense>
      ) : null}
      <AsyncState
        loading={resource.loading}
        error={resource.error}
        onRetry={resource.retry}
      >
        {rows.length === 0 ? (
          <EmptyPanel
            icon={Sparkles}
            title="No skills yet"
            description="Your organization has not shared any skills, and you have not imported one. Import a .skill package or a SKILL.md file to add your own."
            action={<Button variant="secondary" disabled={!client} onClick={() => setCreating(true)}><Plus />Import skill</Button>}
          />
        ) : (
        <Section flush>
        <DataTable
          label="Skills"
          columns={["Skill", "Provided by", "Status", ""]}
          flexColumn={0}
          columnWidths={SKILL_COLUMN_WIDTHS}
          onRowSelect={(index) => setSelected(rows[index] ?? null)}
          rowLabel={(index) => `Opened ${rows[index]?.name ?? "skill"}`}
          rows={rows.map((skill) => {
            const controlHint = skillControlHint(skill, Boolean(client));
            const hintId = `skill-control-${skill.key.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
            return [
              <span className="block max-w-[34rem]">
                <CellStack
                  primary={skillDisplayName(skill)}
                  secondary={skill.description}
                />
              </span>,
              skillProviderLabel(skill),
              <span
                className="inline-flex items-center gap-2.5"
                data-sort={skill.enabled ? 0 : 1}
                onClick={(event) => event.stopPropagation()}
              >
                <ManagementSwitch
                  checked={skill.enabled}
                  disabled={!client || skill.locked}
                  onCheckedChange={(enabled) => void toggle(skill, enabled).catch((cause) => toast.error(cause instanceof Error ? cause.message : "Could not update this skill"))}
                  aria-label={`${skill.enabled ? "Disable" : "Enable"} ${skill.name}`}
                  aria-describedby={hintId}
                  title={controlHint}
                />
                <span id={hintId} className="whitespace-nowrap text-xs text-muted-foreground">{controlHint}</span>
              </span>,
              <SkillRowMenu
                skill={skill}
                onOpen={() => setSelected(skill)}
                onTryInChat={() => tryInChat(skill)}
                onDownload={() => download(skill)}
                deleteAccess={deleteAccess(skill)}
                onDelete={() => requestRemove(skill)}
              />,
            ];
          })}
        />
        </Section>
        )}
      </AsyncState>
      {selected ? (
        <SkillDetailsDialog
          key={selected.key}
          skill={selected}
          client={client}
          tenantId={tenantId}
          hasClient={Boolean(client)}
          onClose={() => setSelected(null)}
          onToggle={(enabled) => toggle(selected, enabled)}
          onTryInChat={() => tryInChat(selected)}
          deleteAccess={deleteAccess(selected)}
          onDelete={() => requestRemove(selected)}
          onDownload={() => downloadSkillPackage(client, tenantId, selected)}
        />
      ) : null}
      <ManagementDialog
        open={pendingRemove !== null}
        onOpenChange={(open) => { if (!open && !removing) setPendingRemove(null); }}
        title={`Delete ${pendingRemove ? skillDisplayName(pendingRemove) : "skill"}?`}
        description={pendingRemove?.personal
          ? "The skill and its files are removed from your account. Download it first if you want to keep a copy."
          : "The skill is removed from your organization’s catalog for every member, including anyone it is required for. Download it first if you want to keep a copy."}
        size="sm"
        footer={<>
          <Button variant="secondary" disabled={removing} onClick={() => setPendingRemove(null)}>Cancel</Button>
          <Button variant="destructive" disabled={removing} onClick={() => void confirmRemove()}><Trash2 />{removing ? "Deleting…" : pendingRemove?.personal ? "Delete skill" : "Delete for everyone"}</Button>
        </>}
      >
        {removeError ? <InlineNotice tone="danger">{removeError}</InlineNotice> : <p className="text-md leading-5 text-muted-foreground">Tasks that already ran with this skill are not affected.</p>}
      </ManagementDialog>
    </ManagementPage>
  );
}

function SkillRowMenu({
  skill,
  onOpen,
  onTryInChat,
  onDownload,
  deleteAccess,
  onDelete,
}: {
  skill: SkillCatalogRow;
  onOpen: () => void;
  onTryInChat: () => void;
  onDownload: () => void;
  deleteAccess: { allowed: boolean; reason?: string };
  onDelete: () => void;
}) {
  const name = skillDisplayName(skill);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${name}`} title="Actions">
          <EllipsisVertical aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem onSelect={onOpen}><BookOpen aria-hidden />View instructions</DropdownMenuItem>
        <DropdownMenuItem disabled={!skill.enabled} onSelect={onTryInChat} title={skill.enabled ? undefined : "Turn the skill on to use it in a task"}>
          <MessageCircle aria-hidden />Try in a task
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!skill.content} onSelect={onDownload} title={skill.content ? undefined : "The skill definition is not loaded, so there is nothing to download"}>
          <Download aria-hidden />Download .skill
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <SkillDeleteItem skill={skill} access={deleteAccess} onDelete={onDelete} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Delete is always listed; when it is not allowed, it stays visible with the reason. */
function SkillDeleteItem({ skill, access, onDelete, disabled = false }: { skill: SkillCatalogRow; access: { allowed: boolean; reason?: string }; onDelete: () => void; disabled?: boolean }) {
  const label = skill.personal ? "Delete skill…" : skill.provenance === "organization" ? "Delete from organization…" : "Delete skill";
  return (
    <>
      <DropdownMenuItem variant="destructive" disabled={!access.allowed || disabled} onSelect={onDelete} title={access.reason}>
        <Trash2 aria-hidden />{label}
      </DropdownMenuItem>
      {!access.allowed && access.reason ? <p className="max-w-52 px-2 pb-1.5 pt-0.5 text-xs leading-snug text-muted-foreground">{access.reason}</p> : null}
    </>
  );
}

function skillProviderLabel(skill: Pick<SkillCatalogRow, "provenance">): string {
  return skill.provenance === "organization" ? "Organization" : skill.provenance === "personal" ? "You" : "Built in";
}

/** Why the skill is on or off for this person, in plain words. */
function skillPolicy(skill: Pick<SkillCatalogRow, "assignment" | "provenance" | "locked" | "enabled">): { label: string; tone: "neutral" | "info" | "danger" } {
  if (skill.provenance === "personal") return { label: "Personal", tone: "neutral" };
  if (skill.assignment === "required") return { label: "Required", tone: "info" };
  if (skill.assignment === "blocked") return { label: "Blocked", tone: "danger" };
  if (skill.assignment === "default-on") return { label: "On by default", tone: "neutral" };
  if (skill.assignment === "available") return { label: "Optional", tone: "neutral" };
  return { label: skill.locked ? "Managed" : "Optional", tone: "neutral" };
}

type SkillViewMode = "rendered" | "source";

type SkillTreeEntry = {
  kind: "folder" | "file";
  name: string;
  path: string;
  depth: number;
};

export function skillPackageTreeEntries(paths: readonly string[]): SkillTreeEntry[] {
  type FolderNode = { folders: Map<string, FolderNode>; files: Map<string, string> };
  const root: FolderNode = { folders: new Map(), files: new Map() };
  for (const rawPath of paths) {
    const path = rawPath.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
    if (!path) continue;
    const parts = path.split("/");
    const fileName = parts.pop()!;
    let folder = root;
    for (const part of parts) {
      let child = folder.folders.get(part);
      if (!child) {
        child = { folders: new Map(), files: new Map() };
        folder.folders.set(part, child);
      }
      folder = child;
    }
    folder.files.set(fileName, path);
  }
  const entries: SkillTreeEntry[] = [];
  const visit = (node: FolderNode, parentPath: string, depth: number) => {
    for (const [name, path] of [...node.files].sort(([left], [right]) => {
      if (left === "SKILL.md") return -1;
      if (right === "SKILL.md") return 1;
      return left.localeCompare(right);
    })) entries.push({ kind: "file", name, path, depth });
    for (const [name, child] of [...node.folders].sort(([left], [right]) => left.localeCompare(right))) {
      const path = parentPath ? `${parentPath}/${name}` : name;
      entries.push({ kind: "folder", name, path, depth });
      visit(child, path, depth + 1);
    }
  };
  visit(root, "", 0);
  return entries;
}

export function skillMarkdownBody(content: string): string {
  const normalized = content.replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("---\n")) return normalized;
  const delimiter = normalized.indexOf("\n---\n", 4);
  if (delimiter < 0) return normalized;
  return normalized.slice(delimiter + 5).trimStart();
}

function SkillDetailsDialog({
  skill,
  client,
  tenantId,
  hasClient,
  onClose,
  onToggle,
  onTryInChat,
  deleteAccess,
  onDelete,
  onDownload,
}: {
  skill: SkillCatalogRow;
  client: BerryApiClient | null;
  tenantId: string;
  hasClient: boolean;
  onClose: () => void;
  onToggle: (enabled: boolean) => Promise<void>;
  onTryInChat: () => void;
  deleteAccess: { allowed: boolean; reason?: string };
  onDelete: () => void;
  onDownload: () => Promise<void>;
}) {
  const [view, setView] = React.useState<SkillViewMode>("rendered");
  const [selectedPath, setSelectedPath] = React.useState("SKILL.md");
  const [loadedFiles, setLoadedFiles] = React.useState<Array<{ path: string; contentBase64: string; mode?: number | undefined }>>([]);
  const [packageLoading, setPackageLoading] = React.useState(false);
  const [packageError, setPackageError] = React.useState("");
  const [busy, setBusy] = React.useState<"toggle" | "download" | null>(null);
  const [actionError, setActionError] = React.useState("");
  const policy = skillPolicy(skill);
  const markdown = skill.content ? skillMarkdownBody(skill.content) : "";
  const controlHint = skillControlHint(skill, hasClient);
  const packagePaths = React.useMemo(() => [
    "SKILL.md",
    ...new Set([...skill.packageFiles, ...loadedFiles.map((file) => file.path)].filter((path) => path !== "SKILL.md")),
  ], [loadedFiles, skill.packageFiles]);
  const treeEntries = React.useMemo(() => skillPackageTreeEntries(packagePaths), [packagePaths]);
  const selectedResource = loadedFiles.find((file) => file.path === selectedPath) ?? null;
  const selectedContent = selectedPath === "SKILL.md" ? skill.content : selectedResource ? decodeSkillTextFile(selectedResource) : null;
  const selectedIsMarkdown = /\.md$/i.test(selectedPath) && selectedContent !== null;
  const name = skillDisplayName(skill);
  const packageSize = skill.packageBytes > 0 ? formatBytes(skill.packageBytes) : null;

  React.useEffect(() => {
    setSelectedPath("SKILL.md");
    setLoadedFiles([]);
    setPackageError("");
  }, [skill.key]);

  React.useEffect(() => {
    if (!client || !skill.content || skill.provenance !== "personal" || selectedPath === "SKILL.md" || !isPreviewableSkillFile(selectedPath) || loadedFiles.some((file) => file.path === selectedPath)) return;
    let cancelled = false;
    setPackageLoading(true);
    setPackageError("");
    void loadSkillPackageForDownload(client, tenantId, skill)
      .then((loaded) => {
        if (!cancelled) setLoadedFiles(loaded.resourceFiles);
      })
      .catch((cause) => {
        if (!cancelled) setPackageError(cause instanceof Error ? cause.message : "Could not load package files");
      })
      .finally(() => {
        if (!cancelled) setPackageLoading(false);
      });
    return () => { cancelled = true; };
  }, [client, loadedFiles, selectedPath, skill.content, skill.personal, skill.provenance, tenantId]);

  React.useEffect(() => {
    if (!client || skill.provenance !== "organization" || skill.packageStorage !== "stored" || selectedPath === "SKILL.md" || !isPreviewableSkillFile(selectedPath) || loadedFiles.some((file) => file.path === selectedPath)) return;
    let cancelled = false;
    setPackageLoading(true);
    setPackageError("");
    void client.organizationSkillPackageFile(tenantId, skill.capabilityId, selectedPath)
      .then((file) => {
        if (!cancelled) setLoadedFiles((current) => current.some((candidate) => candidate.path === file.path) ? current : [...current, file]);
      })
      .catch((cause) => {
        if (!cancelled) setPackageError(cause instanceof Error ? cause.message : "Could not load this package file");
      })
      .finally(() => {
        if (!cancelled) setPackageLoading(false);
      });
    return () => { cancelled = true; };
  }, [client, loadedFiles, selectedPath, skill.capabilityId, skill.packageStorage, skill.provenance, tenantId]);

  React.useEffect(() => {
    if (!packagePaths.includes(selectedPath)) setSelectedPath("SKILL.md");
  }, [packagePaths, selectedPath]);

  React.useEffect(() => {
    setView(/\.md$/i.test(selectedPath) ? "rendered" : "source");
  }, [selectedPath]);

  async function changeEnabled(enabled: boolean) {
    setActionError("");
    setBusy("toggle");
    try {
      await onToggle(enabled);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Could not update this skill");
    } finally {
      setBusy(null);
    }
  }

  async function download() {
    if (!skill.content) return;
    setActionError("");
    setBusy("download");
    try {
      await onDownload();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Could not download this skill");
    } finally {
      setBusy(null);
    }
  }

  const details: Array<{ term: string; detail: React.ReactNode }> = [
    { term: "Provided by", detail: skill.provenance === "organization" ? "Your organization" : skill.provenance === "personal" ? "You" : "This deployment" },
    { term: "Policy", detail: <StatusPill tone={policy.tone}>{policy.label}</StatusPill> },
    { term: "Use it", detail: <code className="rounded bg-[var(--berry-selected)] px-1.5 py-0.5 font-mono text-xs text-foreground">{name}</code> },
    { term: "Package", detail: `${packagePaths.length} ${packagePaths.length === 1 ? "file" : "files"}${packageSize ? ` · ${packageSize}` : ""}` },
  ];

  const fileList = (
    <ul className="grid gap-px" aria-label="Files in this skill">
      {treeEntries.map((entry) => entry.kind === "folder" ? (
        <li
          className="flex h-8 items-center gap-2 pe-2 text-xs font-medium text-muted-foreground"
          key={`folder:${entry.path}`}
          style={{ paddingInlineStart: `${10 + entry.depth * 14}px` }}
        >
          <Folder className="size-4 shrink-0" aria-hidden />
          <span className="truncate">{entry.name}</span>
        </li>
      ) : (
        <li key={`file:${entry.path}`}>
          <button
            type="button"
            className={cn(
              "flex h-8 w-full items-center gap-2 rounded-md pe-2 text-start text-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50",
              entry.path === selectedPath ? "bg-[var(--berry-selected)] font-medium text-foreground" : "text-[var(--berry-text-secondary)] hover:bg-[var(--berry-hover)] hover:text-foreground",
            )}
            style={{ paddingInlineStart: `${10 + entry.depth * 14}px` }}
            aria-current={entry.path === selectedPath ? "true" : undefined}
            onClick={() => setSelectedPath(entry.path)}
          >
            <SkillFileIcon path={entry.path} />
            <span className="truncate">{entry.name}</span>
          </button>
        </li>
      ))}
    </ul>
  );

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        showCloseButton={false}
        className="berry-mgmt inset-0 top-0 left-0 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 bg-[var(--berry-main-bg)] p-0 shadow-none sm:max-w-none data-[state=closed]:zoom-out-100 data-[state=open]:zoom-in-100"
      >
        {/* Top bar: way back, the skill, and what you can do with it. */}
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-2 sm:gap-3 sm:px-4">
          <DialogClose asChild>
            <Button variant="ghost" className="shrink-0">
              <ArrowLeft aria-hidden />
              <span className="hidden sm:inline">Skills</span>
            </Button>
          </DialogClose>
          <span className="h-5 w-px shrink-0 bg-border" aria-hidden />
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <DialogTitle className="truncate text-title font-semibold text-foreground">{name}</DialogTitle>
            <span className="hidden shrink-0 sm:inline-flex"><StatusPill tone={policy.tone}>{policy.label}</StatusPill></span>
          </div>
          <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
            <label className="flex items-center gap-2 pe-1 text-xs text-muted-foreground">
              <span className="hidden lg:inline">{controlHint}</span>
              <ManagementSwitch
                checked={skill.enabled}
                disabled={!hasClient || skill.locked || busy !== null}
                onCheckedChange={(enabled) => void changeEnabled(enabled)}
                aria-label={`${skill.enabled ? "Turn off" : "Turn on"} ${name}`}
                title={controlHint}
              />
            </label>
            <Button variant="secondary" disabled={!skill.enabled} onClick={onTryInChat} title={skill.enabled ? `Start a task with ${name}` : "Turn the skill on to use it in a task"}>
              <MessageCircle aria-hidden />
              <span className="hidden sm:inline">Try in a task</span>
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={`More actions for ${name}`}>
                  <EllipsisVertical aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem
                  disabled={!skill.content || busy !== null}
                  title={skill.content ? "Download a portable skill package" : "The skill definition is not loaded, so there is nothing to download"}
                  onSelect={() => void download()}
                >
                  <Download aria-hidden />
                  {busy === "download" ? "Downloading…" : "Download .skill"}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <SkillDeleteItem skill={skill} access={deleteAccess} onDelete={onDelete} disabled={busy !== null} />
              </DropdownMenuContent>
            </DropdownMenu>
            <span className="mx-0.5 hidden h-5 w-px bg-border sm:block" aria-hidden />
            <DialogClose asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Close skill">
                <X aria-hidden />
              </Button>
            </DialogClose>
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          {/* Side panel: what the skill is for, its files, and the facts about it. */}
          <aside className="hidden w-72 shrink-0 flex-col overflow-y-auto overscroll-contain border-e border-border md:flex xl:w-80" aria-label={`About ${name}`}>
            <section className="grid gap-2 border-b border-border px-5 py-5">
              <h3 className="text-xs font-medium text-muted-foreground">About</h3>
              <DialogDescription className="text-md leading-relaxed text-foreground text-pretty">{skill.description}</DialogDescription>
              {skill.personal?.diagnostics.length ? <InlineNotice tone="warning">{skill.personal.diagnostics.join(" ")}</InlineNotice> : null}
            </section>
            <section className="grid gap-2 border-b border-border px-3 py-4">
              <h3 className="flex items-center justify-between px-2 text-xs font-medium text-muted-foreground">
                Files
                {packageLoading ? <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" aria-label="Loading package files" /> : <span className="tabular-nums">{packagePaths.length}</span>}
              </h3>
              {fileList}
            </section>
            <section className="px-5 py-4">
              <h3 className="sr-only">Details</h3>
              <dl className="grid gap-3">
                {details.map((item) => (
                  <div className="grid gap-1" key={item.term}>
                    <dt className="text-xs text-muted-foreground">{item.term}</dt>
                    <dd className="text-md text-foreground">{item.detail}</dd>
                  </div>
                ))}
              </dl>
            </section>
          </aside>

          {/* The selected file. */}
          <main className="flex min-w-0 flex-1 flex-col">
            {/* On narrow screens the side panel folds into this bar. */}
            <div className="border-b border-border px-4 py-3 md:hidden">
              <p className="line-clamp-2 text-md leading-snug text-[var(--berry-text-secondary)]">{skill.description}</p>
            </div>
            <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border px-3 sm:px-5">
              <div className="flex min-w-0 items-center gap-2">
                <div className="md:hidden">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="secondary" className="max-w-[60vw]">
                        <SkillFileIcon path={selectedPath} />
                        <span className="truncate">{selectedPath}</span>
                        <ChevronDown className="size-3.5 shrink-0" aria-hidden />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="max-h-[60vh] w-[min(320px,calc(100vw-2rem))] overflow-y-auto p-1.5">
                      {treeEntries.filter((entry) => entry.kind === "file").map((entry) => (
                        <DropdownMenuItem className="gap-2" key={entry.path} onSelect={() => setSelectedPath(entry.path)}>
                          <SkillFileIcon path={entry.path} />
                          <span className="truncate">{entry.path}</span>
                          {entry.path === selectedPath ? <Check className="ms-auto size-3.5" aria-hidden /> : null}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                <span className="hidden min-w-0 items-center gap-2 text-md font-medium text-foreground md:flex">
                  <SkillFileIcon path={selectedPath} />
                  <span className="truncate">{selectedPath}</span>
                </span>
              </div>
              {selectedIsMarkdown ? (
                <SegmentedControl
                  label="Skill content view"
                  value={view}
                  onChange={setView}
                  options={[{ value: "rendered", label: "Preview" }, { value: "source", label: "Source" }]}
                />
              ) : null}
            </div>
            {actionError ? <div className="px-5 pt-4"><InlineNotice tone="danger">{actionError}</InlineNotice></div> : null}

            <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
              {selectedPath === "SKILL.md" && !skill.content ? (
                <div className="grid min-h-full place-items-center p-8 text-center">
                  <div className="max-w-md">
                    <p className="text-sm font-medium text-foreground">SKILL.md is not available</p>
                    <p className="mt-1 text-xs leading-5 text-[var(--berry-text-secondary)]">
                      Only this skill’s name and description are available offline. Connect to Berry to load its instructions.
                    </p>
                  </div>
                </div>
              ) : selectedContent !== null && view === "rendered" && selectedIsMarkdown ? (
                <React.Suspense fallback={<div className="mx-auto max-w-3xl space-y-3 px-5 py-8 sm:px-10 sm:py-10"><Skeleton className="h-6 w-2/5" /><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-11/12" /><Skeleton className="h-4 w-3/4" /></div>}>
                  <Markdown className="mx-auto max-w-3xl px-5 py-8 text-base leading-7 tracking-normal text-foreground sm:px-10 sm:py-10">
                    {selectedPath === "SKILL.md" ? markdown : selectedContent}
                  </Markdown>
                </React.Suspense>
              ) : selectedContent !== null ? <SkillSource content={selectedContent} /> : (
                <SkillResourceSummary
                  file={selectedResource}
                  managed={skill.packageStorage === "managed"}
                  stored={skill.packageStorage === "stored"}
                  packageError={packageError}
                  path={selectedPath}
                />
              )}
            </div>
          </main>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SkillFileIcon({ path }: { path: string }) {
  if (/\.(png|jpe?g|gif|webp|avif|svg)$/i.test(path)) return <FileImage className="size-4 shrink-0" aria-hidden />;
  if (/\.(md|txt|json|ya?ml|toml|csv|py|js|jsx|ts|tsx|sh|bash|css|html?|xml|sql)$/i.test(path)) return <FileCode2 className="size-4 shrink-0" aria-hidden />;
  return <File className="size-4 shrink-0" aria-hidden />;
}

function SkillResourceSummary({
  file,
  managed,
  stored,
  packageError,
  path,
}: {
  file: { path: string; contentBase64: string; mode?: number | undefined } | null;
  managed: boolean;
  stored: boolean;
  packageError: string;
  path: string;
}) {
  const imageType = skillImageMediaType(path);
  if (file && imageType) {
    return (
      <div className="grid min-h-full place-items-center p-6">
        <img
          alt={path.split("/").at(-1) ?? path}
          className="max-h-[65vh] max-w-full rounded-lg outline outline-1 -outline-offset-1 outline-[var(--berry-image-outline)]"
          src={`data:${imageType};base64,${file.contentBase64}`}
        />
      </div>
    );
  }
  const bytes = file ? base64ByteLength(file.contentBase64) : null;
  return (
    <div className="grid min-h-full place-items-center p-8 text-center">
      <div className="max-w-lg">
        <SkillFileIcon path={path} />
        <p className="mt-3 break-all text-sm font-medium text-[var(--berry-text-primary)]">{path}</p>
        <p className="mt-1 text-xs leading-5 text-[var(--berry-text-secondary)]">
          {managed
            ? `This legacy organization skill lists ${path}, but its package has not been migrated into organization storage yet. An administrator should resync or re-upload the complete .skill archive.`
            : file
              ? `Bundled binary resource${bytes === null ? "" : ` · ${formatBytes(bytes)}`}. Berry stores it with the skill package and stages it beside SKILL.md when the skill activates.`
              : stored && !isPreviewableSkillFile(path)
                ? "Bundled binary resource. Berry stores it with this organization skill and stages it beside SKILL.md when the skill activates."
              : packageError || "This file is listed in the package manifest, but its preview bytes are unavailable."}
        </p>
      </div>
    </div>
  );
}

function decodeSkillTextFile(file: { path: string; contentBase64: string }): string | null {
  if (!/\.(md|txt|json|ya?ml|toml|csv|py|js|jsx|ts|tsx|sh|bash|css|html?|xml|sql)$/i.test(file.path)) return null;
  try {
    const binary = atob(file.contentBase64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function isPreviewableSkillFile(path: string): boolean {
  return /\.(md|txt|json|ya?ml|toml|csv|py|js|jsx|ts|tsx|sh|bash|css|html?|xml|sql|png|jpe?g|gif|webp|avif|svg)$/i.test(path);
}

function skillImageMediaType(path: string): string | null {
  const extension = path.split(".").at(-1)?.toLowerCase();
  return ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", svg: "image/svg+xml" } as Record<string, string>)[extension ?? ""] ?? null;
}

function base64ByteLength(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return value.length * 3 / 4 - padding;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function SkillSource({ content }: { content: string }) {
  return (
    <div className="min-w-max py-4 font-mono text-xs leading-6 text-[var(--berry-text-primary)]">
      {content.replace(/\r\n?/g, "\n").split("\n").map((line, index) => (
        <div className="grid grid-cols-[3.25rem_minmax(0,1fr)] px-4" key={`${index}:${line}`}>
          <span className="select-none pe-4 text-right text-[var(--berry-text-tertiary)]" aria-hidden>{index + 1}</span>
          <code className="whitespace-pre pe-6">{line || " "}</code>
        </div>
      ))}
    </div>
  );
}

function buildSkillRows(
  personal: PersonalSkill[],
  effective: EffectiveCapability[],
  deployed: Array<{
    id: string;
    name: string;
    description: string;
    content?: string | undefined;
    enabled: boolean;
  }>,
): SkillCatalogRow[] {
  const rows = new Map<string, SkillCatalogRow>();
  const deployedByName = new Map(
    deployed.map((item) => [item.name.replace(/^\$/, "").toLowerCase(), item]),
  );
  for (const item of effective.filter(
    (entry) => entry.kind === "skill" && entry.provenance === "organization",
  )) {
    rows.set(item.name.toLowerCase(), {
      key: `organization:${item.capabilityId}`,
      capabilityId: item.capabilityId,
      name: item.name,
      description:
        item.description?.trim()
        || deployedByName.get(item.name.toLowerCase())?.description
        || "Managed by your organization",
      content: item.content ?? null,
      enabled: item.enabled,
      locked: item.locked,
      provenance: "organization",
      assignment: item.assignment,
      reason: item.reason,
      packageFiles: item.packageFiles ?? [],
      packageStorage: item.packageStorage ?? "definition-only",
      packageBytes: item.packageBytes ?? 0,
    });
  }
  for (const item of personal) {
    rows.set(item.name.toLowerCase(), {
      key: `personal:${item.id}`,
      capabilityId: item.id,
      name: item.name,
      description: item.description,
      content: item.content,
      enabled: item.enabled,
      locked: false,
      provenance: "personal",
      assignment: null,
      reason: "personal",
      packageFiles: item.resources,
      packageStorage: item.resources.length > 0 ? "stored" : "definition-only",
      packageBytes: item.packageBytes,
      personal: item,
    });
  }
  for (const item of deployed) {
    const key = item.name.replace(/^\$/, "").toLowerCase();
    if (!isManagedSkillDuplicate(item.name, effective) && !rows.has(key))
      rows.set(key, {
        key: `deployment:${item.id}`,
        capabilityId: item.id,
        name: item.name.replace(/^\$/, ""),
        description: item.description,
        content: item.content ?? null,
        enabled: item.enabled,
        locked: true,
        provenance: "self-host-bootstrap",
        assignment: null,
        reason: "deployment",
        packageFiles: [],
        packageStorage: "definition-only",
        packageBytes: item.content ? new TextEncoder().encode(item.content).byteLength : 0,
      });
  }
  return [...rows.values()].sort(
    (a, b) =>
      a.provenance.localeCompare(b.provenance) || a.name.localeCompare(b.name),
  );
}

export function isManagedSkillDuplicate(
  deployedName: string,
  effective: EffectiveCapability[],
): boolean {
  const key = deployedName.replace(/^\$/, "").toLowerCase();
  return effective.some((item) =>
    item.kind === "skill"
    && item.provenance === "organization"
    && item.capabilityId.replace(/^\$/, "").toLowerCase() === key,
  );
}

export function skillControlHint(
  skill: Pick<SkillCatalogRow, "enabled" | "locked" | "personal">,
  hasClient: boolean,
): string {
  if (!hasClient) return "Connect to Berry to change this setting";
  if (skill.locked)
    return skill.enabled
      ? "Required by your organization"
      : "Disabled by your organization";
  return skill.enabled ? "On" : "Off";
}
