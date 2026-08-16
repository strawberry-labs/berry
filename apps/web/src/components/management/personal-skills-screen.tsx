import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Code2,
  Download,
  EllipsisVertical,
  Eye,
  File,
  FileCode2,
  FileImage,
  FlaskConical,
  Folder,
  Info,
  LoaderCircle,
  MessageCircle,
  Plus,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { BerryApiError, type BerryApiClient } from "@berry/api-client";
import { Markdown } from "@berry/desktop-ui/components/berry-markdown";
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@berry/desktop-ui/components/ui/tooltip";
import type {
  EffectiveCapability,
  PersonalMcpServer,
  PersonalSkill,
} from "@berry/shared";
import { createBrowserSkillExport, readBrowserSkillImport } from "@/lib/skill-import";
import {
  AsyncState,
  Button,
  DataTable,
  DetailDrawer,
  FormSelect,
  Input,
  ManagementDialog,
  ManagementPage,
  ManagementSwitch,
  SearchInput,
  StatusPill,
  SuccessMessage,
  Textarea,
  Toolbar,
} from "./management-primitives";
import { useResource, type ManagementScreenProps } from "./management-context";

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
const emptyDraft = {
  content: "",
  sourceUrl: "",
  source: "upload" as "text" | "upload" | "git",
  packageFiles: [] as string[],
  resourceFiles: [] as Array<{ path: string; contentBase64: string; mode?: number | undefined }>,
  fileName: "",
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

export function PersonalSkillsScreen({
  client,
  config,
  tenantId,
}: ManagementScreenProps) {
  const navigate = useNavigate();
  const [query, setQuery] = React.useState("");
  const [draft, setDraft] = React.useState(emptyDraft);
  const [creating, setCreating] = React.useState(false);
  const [selected, setSelected] = React.useState<SkillCatalogRow | null>(null);
  const [message, setMessage] = React.useState("");
  const [importError, setImportError] = React.useState("");
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
      ).filter((skill) =>
        `${skill.name} ${skill.description}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      ),
    [resource.data, config.skills, query],
  );

  async function install(event: React.FormEvent) {
    event.preventDefault();
    if (!client) return;
    setImportError("");
    try {
      await client.savePersonalSkill({
        content: draft.content,
        source: draft.source,
        sourceUrl: draft.sourceUrl || null,
        packageFiles: draft.packageFiles,
        resourceFiles: draft.resourceFiles,
        enabled: true,
      });
      setCreating(false);
      setDraft(emptyDraft);
      setMessage("Skill imported and enabled for your account.");
      resource.retry();
    } catch (cause) {
      setImportError(
        cause instanceof Error ? cause.message : "Skill import failed",
      );
    }
  }

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
  }

  async function remove(skill: PersonalSkill) {
    if (!client) return;
    await client.deletePersonalSkill(skill.id);
    setSelected(null);
    resource.retry();
  }

  async function selectFile(file: File | undefined) {
    if (!file) return;
    setImportError("");
    try {
      const imported = await readBrowserSkillImport(file);
      setDraft({
        content: imported.content,
        packageFiles: imported.packageFiles,
        resourceFiles: imported.resourceFiles,
        fileName: imported.fileName,
        source: "upload",
        sourceUrl: "",
      });
    } catch (cause) {
      setImportError(
        cause instanceof Error
          ? cause.message
          : "Could not read this skill package",
      );
    }
  }

  function tryInChat(skill: SkillCatalogRow) {
    window.localStorage.setItem("berry.web.pendingPrompt", `$${skill.capabilityId} `);
    setSelected(null);
    void navigate({ to: "/" });
  }

  return (
    <ManagementPage
      title="Skills"
      description="Import your own skills or use capabilities provided by your organization."
      eyebrow="Tools & connections"
      actions={
        <Button
          disabled={!client}
          onClick={() => {
            setCreating(true);
            setImportError("");
          }}
        >
          <Plus />
          Import skill
        </Button>
      }
    >
      <Toolbar>
        <SearchInput
          label="Search skills"
          value={query}
          onChange={setQuery}
          placeholder="Search skills"
        />
      </Toolbar>
      {message ? <SuccessMessage>{message}</SuccessMessage> : null}
      <ManagementDialog
        open={creating}
        onOpenChange={setCreating}
        title="Import a skill"
        description="Import a skill package, paste SKILL.md, or load a GitHub SKILL.md URL. Valid skills are enabled for your account immediately."
        size="lg"
      >
        <form
          className="grid gap-3 sm:grid-cols-2 [&>label]:grid [&>label]:gap-1.5 [&>label]:text-xs [&>label]:font-medium [&>label]:text-muted-foreground"
          onSubmit={install}
        >
            <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
              Source
              <FormSelect
                value={draft.source}
                onChange={(source) => {
                  setImportError("");
                  setDraft({
                    ...emptyDraft,
                    source: source as typeof draft.source,
                  });
                }}
                options={[
                  { value: "upload", label: "Skill package" },
                  { value: "text", label: "Paste SKILL.md" },
                  { value: "git", label: "GitHub URL" },
                ]}
              />
            </label>
            {draft.source === "upload" ? (
              <label
                className="settings-skill-dropzone"
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  void selectFile(event.dataTransfer.files[0]);
                }}
              >
                <input
                  type="file"
                  accept=".skill,.zip,.md,text/markdown,application/zip"
                  onChange={(event) =>
                    void selectFile(event.currentTarget.files?.[0])
                  }
                />
                <Upload aria-hidden />
                <span>
                  <b>{draft.fileName || "Choose or drop a .skill package"}</b>
                  <small>.skill, .zip, or SKILL.md · up to 5 MB</small>
                </span>
              </label>
            ) : null}
            {draft.source === "text" ? (
              <label className="grid gap-1.5 text-xs font-medium text-muted-foreground sm:col-span-2">
                SKILL.md
                <Textarea
                  className="min-h-32 resize-y"
                  required
                  value={draft.content}
                  onChange={(event) =>
                    setDraft({ ...draft, content: event.currentTarget.value })
                  }
                  placeholder={
                    "---\nname: my-skill\ndescription: What this skill does and when to use it\n---\n\nInstructions…"
                  }
                />
              </label>
            ) : null}
            {draft.source === "git" ? (
              <label className="grid gap-1.5 text-xs font-medium text-muted-foreground sm:col-span-2">
                GitHub SKILL.md URL
                <Input
                  type="url"
                  required
                  value={draft.sourceUrl}
                  onChange={(event) =>
                    setDraft({ ...draft, sourceUrl: event.currentTarget.value })
                  }
                  placeholder="https://github.com/org/repo/blob/main/skill/SKILL.md"
                />
              </label>
            ) : null}
            {importError ? (
              <div
                className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
                role="alert"
              >
                {importError}
              </div>
            ) : null}
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setCreating(false);
                setDraft(emptyDraft);
                setImportError("");
              }}
            >
              <X />
              Cancel
            </Button>
            <Button type="submit">
              <Check />
              Import and enable
            </Button>
          </form>
      </ManagementDialog>
      <AsyncState
        loading={resource.loading}
        error={resource.error}
        onRetry={resource.retry}
        empty={rows.length === 0}
      >
        <DataTable
          label="Skills"
          columns={["Skill", "Provided by", "Policy", "Status"]}
          rows={rows.map((skill) => {
            const controlHint = skillControlHint(skill, Boolean(client));
            const hintId = `skill-control-${skill.key.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
            return [
              <Button
                variant="ghost"
                className="grid h-auto max-w-80 justify-start gap-0.5 p-0 text-left [&_b]:truncate [&_small]:truncate [&_small]:text-xs [&_small]:text-muted-foreground"
                onClick={() => setSelected(skill)}
              >
                <b>
                  {skill.name.startsWith("$") ? skill.name : `$${skill.name}`}
                </b>
                <small>{skill.description}</small>
              </Button>,
              skill.provenance === "organization"
                ? "Organization"
                : skill.provenance === "personal"
                  ? "You"
                  : "Deployment",
              <StatusPill tone={skill.locked ? "neutral" : "info"}>
                {skill.assignment
                  ? skill.assignment.replace("-", " ")
                  : skill.reason}
              </StatusPill>,
              <span className="inline-flex items-center gap-2 [&_small]:max-w-40 [&_small]:text-xs [&_small]:text-[var(--berry-text-secondary)]">
                <ManagementSwitch
                  checked={skill.enabled}
                  disabled={!client || skill.locked}
                  onCheckedChange={(enabled) => void toggle(skill, enabled)}
                  aria-label={`${skill.enabled ? "Disable" : "Enable"} ${skill.name}`}
                  aria-describedby={hintId}
                  title={controlHint}
                />
                <small id={hintId}>{controlHint}</small>
              </span>,
            ];
          })}
        />
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
          onUninstall={selected.personal ? () => remove(selected.personal!) : undefined}
        />
      ) : null}
    </ManagementPage>
  );
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
  onUninstall,
}: {
  skill: SkillCatalogRow;
  client: BerryApiClient | null;
  tenantId: string;
  hasClient: boolean;
  onClose: () => void;
  onToggle: (enabled: boolean) => Promise<void>;
  onTryInChat: () => void;
  onUninstall?: (() => Promise<void>) | undefined;
}) {
  const [view, setView] = React.useState<SkillViewMode>("rendered");
  const [selectedPath, setSelectedPath] = React.useState("SKILL.md");
  const [loadedFiles, setLoadedFiles] = React.useState<Array<{ path: string; contentBase64: string; mode?: number | undefined }>>([]);
  const [packageLoading, setPackageLoading] = React.useState(false);
  const [packageError, setPackageError] = React.useState("");
  const [descriptionExpanded, setDescriptionExpanded] = React.useState(false);
  const [busy, setBusy] = React.useState<"toggle" | "download" | "uninstall" | null>(null);
  const [actionError, setActionError] = React.useState("");
  const provider = skill.provenance === "organization"
    ? "your organization"
    : skill.provenance === "personal"
      ? "you"
      : "this deployment";
  const descriptionCanExpand = skill.description.length > 220;
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

  async function uninstall() {
    if (!onUninstall) return;
    setActionError("");
    setBusy("uninstall");
    try {
      await onUninstall();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Could not uninstall this skill");
      setBusy(null);
    }
  }

  async function download() {
    if (!skill.content) return;
    setActionError("");
    setBusy("download");
    try {
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
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Could not download this skill");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[min(92dvh,920px)] w-[calc(100vw-1rem)] max-w-none flex-col gap-0 overflow-hidden rounded-[18px] border border-[var(--berry-border)] bg-[var(--berry-main-bg)] p-0 shadow-[var(--berry-shadow-floating)] sm:w-[calc(100vw-2rem)] sm:max-w-[min(1440px,calc(100vw-2rem))]"
      >
        <div className="flex h-14 shrink-0 items-center justify-between px-3 sm:px-5">
          <DialogClose asChild>
            <Button variant="ghost" className="h-8 gap-2 px-2 text-sm font-medium">
              <ArrowLeft aria-hidden />
              Skills
            </Button>
          </DialogClose>
          <DialogClose asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Close skill details">
              <X aria-hidden />
            </Button>
          </DialogClose>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 p-4 sm:p-5">
          <div className="grid shrink-0 gap-3">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <DialogTitle className="truncate text-lg leading-6 font-semibold text-[var(--berry-text-primary)]">
                    {skill.name}
                  </DialogTitle>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button variant="ghost" size="icon-xs" aria-label={`About ${skill.name}`}>
                          <Info aria-hidden />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent sideOffset={6}>
                        {skill.assignment ? `${skill.assignment.replace("-", " ")} organization skill` : `${skill.reason.replace("-", " ")} skill`}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
                <p className="mt-0.5 text-xs text-[var(--berry-text-secondary)]">by {provider}</p>
              </div>

              <div className="flex shrink-0 items-center gap-1.5">
                <ManagementSwitch
                  checked={skill.enabled}
                  disabled={!hasClient || skill.locked || busy !== null}
                  onCheckedChange={(enabled) => void changeEnabled(enabled)}
                  aria-label={`${skill.enabled ? "Disable" : "Enable"} ${skill.name}`}
                  title={controlHint}
                />
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label={`More actions for ${skill.name}`}>
                      <EllipsisVertical aria-hidden />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-48 border-[var(--berry-border)] bg-[var(--berry-card-bg)]">
                    <DropdownMenuItem onSelect={onTryInChat}>
                      <MessageCircle aria-hidden />
                      Try in a task
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={!skill.content || busy !== null}
                      title={skill.content ? "Download a portable skill package" : "This deployment has not loaded the skill definition"}
                      onSelect={() => void download()}
                    >
                      <Download aria-hidden />
                      {busy === "download" ? "Downloading…" : "Download .skill"}
                    </DropdownMenuItem>
                    {onUninstall ? (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          disabled={busy !== null}
                          onSelect={() => void uninstall()}
                        >
                          <Trash2 aria-hidden />
                          {busy === "uninstall" ? "Uninstalling…" : "Uninstall"}
                        </DropdownMenuItem>
                      </>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>

            <DialogDescription
              className={`max-w-none text-sm leading-6 text-[var(--berry-text-primary)] ${descriptionExpanded ? "" : "line-clamp-2"}`}
            >
              {skill.description}
            </DialogDescription>
            {descriptionCanExpand ? (
              <Button
                variant="ghost"
                className="h-auto w-fit p-0 text-xs text-[var(--berry-accent)] hover:bg-transparent"
                onClick={() => setDescriptionExpanded((expanded) => !expanded)}
                aria-expanded={descriptionExpanded}
              >
                {descriptionExpanded ? "See less" : "See more"}
              </Button>
            ) : null}
            {actionError ? (
              <p role="alert" className="text-xs text-[var(--berry-danger)]">{actionError}</p>
            ) : null}
          </div>

          <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-[var(--berry-border)] bg-[var(--berry-surface-inset)]" aria-label={`${skill.name} files`}>
            <div className="flex min-h-12 shrink-0 items-center justify-between gap-3 bg-[var(--berry-control-bg)] px-3">
              <div className="flex min-w-0 items-center gap-2">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="secondary" className="h-8 max-w-[min(55vw,420px)] gap-2 px-3 text-sm font-medium">
                      <SkillFileIcon path={selectedPath} />
                      <span className="truncate">{selectedPath}</span>
                      <ChevronDown className="size-3.5 shrink-0" aria-hidden />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="max-h-[min(60vh,520px)] w-[min(380px,calc(100vw-3rem))] overflow-y-auto border-[var(--berry-border)] bg-[var(--berry-card-bg)] p-1.5">
                    {treeEntries.map((entry) => entry.kind === "folder" ? (
                      <div
                        className="flex h-8 items-center gap-2 rounded-md pe-2 text-xs font-medium text-[var(--berry-text-secondary)]"
                        key={`folder:${entry.path}`}
                        style={{ paddingInlineStart: `${8 + entry.depth * 16}px` }}
                      >
                        <Folder className="size-4 shrink-0" aria-hidden />
                        <span className="truncate">{entry.name}</span>
                      </div>
                    ) : (
                      <DropdownMenuItem
                        className="h-8 gap-2 text-xs"
                        key={`file:${entry.path}`}
                        onSelect={() => setSelectedPath(entry.path)}
                        style={{ paddingInlineStart: `${8 + entry.depth * 16}px` }}
                      >
                        <SkillFileIcon path={entry.path} />
                        <span className="truncate">{entry.name}</span>
                        {entry.path === selectedPath ? <Check className="ms-auto size-3.5" aria-hidden /> : null}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
                <span className="whitespace-nowrap text-xs text-[var(--berry-text-tertiary)]">
                  {packagePaths.length} {packagePaths.length === 1 ? "file" : "files"}
                </span>
                {packageLoading ? <LoaderCircle className="size-3.5 animate-spin text-[var(--berry-text-tertiary)] motion-reduce:animate-none" aria-label="Loading package files" /> : null}
              </div>
              {selectedContent !== null ? <div className="flex rounded-lg bg-[var(--berry-control-bg)] p-0.5" role="group" aria-label="Skill content view">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className={view === "rendered" ? "bg-[var(--berry-selected)] text-[var(--berry-text-primary)]" : "text-[var(--berry-text-secondary)]"}
                  onClick={() => setView("rendered")}
                  aria-label="Rendered Markdown"
                  aria-pressed={view === "rendered"}
                  disabled={!selectedIsMarkdown}
                >
                  <Eye aria-hidden />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className={view === "source" ? "bg-[var(--berry-selected)] text-[var(--berry-text-primary)]" : "text-[var(--berry-text-secondary)]"}
                  onClick={() => setView("source")}
                  aria-label="Markdown source"
                  aria-pressed={view === "source"}
                >
                  <Code2 aria-hidden />
                </Button>
              </div> : null}
            </div>

            <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
              {selectedPath === "SKILL.md" && !skill.content ? (
                <div className="grid min-h-full place-items-center p-8 text-center">
                  <div className="max-w-md">
                    <p className="text-sm font-medium text-[var(--berry-text-primary)]">SKILL.md is not available</p>
                    <p className="mt-1 text-xs leading-5 text-[var(--berry-text-secondary)]">
                      This offline deployment entry only publishes skill metadata. Connect to Berry to load the organization definition.
                    </p>
                  </div>
                </div>
              ) : selectedContent !== null && view === "rendered" && selectedIsMarkdown ? (
                <Markdown className="mx-auto max-w-5xl px-5 py-6 text-[14px] leading-7 tracking-normal text-[var(--berry-text-primary)] sm:px-8 sm:py-8">
                  {selectedPath === "SKILL.md" ? markdown : selectedContent}
                </Markdown>
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
          </section>
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
