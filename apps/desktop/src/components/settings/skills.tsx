import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FileDown, FolderOpen, Plus, RefreshCw, Search, Trash2, WandSparkles } from "@berry/desktop-ui/lib/icons";
import type { SkillImportPreview, SkillManifest } from "@berry/shared";
import { Badge } from "@berry/desktop-ui/components/ui/badge";
import { Button } from "@berry/desktop-ui/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@berry/desktop-ui/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@berry/desktop-ui/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@berry/desktop-ui/components/ui/empty";
import { Input } from "@berry/desktop-ui/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@berry/desktop-ui/components/ui/input-group";
import { Label } from "@berry/desktop-ui/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@berry/desktop-ui/components/ui/select";
import { Skeleton } from "@berry/desktop-ui/components/ui/skeleton";
import { Switch } from "@berry/desktop-ui/components/ui/switch";
import { Textarea } from "@berry/desktop-ui/components/ui/textarea";
import { host, useWorkbench } from "@/lib/berry";
import { HostRpcError, isTauri, pickSkillFile } from "@/host-client";
import { SettingCard, SettingsPageHeader, SettingsSectionLabel } from "./shared";

const skillsKey = (workspaceId?: string | null) => ["skills", workspaceId ?? "global"] as const;

type StatusFilter = "all" | "enabled" | "disabled";
type SkillReview = { name: string; version: string; pendingHash: string; diff: string };

function skillReviewFromError(error: unknown): SkillReview | null {
  if (!(error instanceof HostRpcError) || error.code !== "skill_update_review_required") return null;
  const details = error.details && typeof error.details === "object" && !Array.isArray(error.details) ? error.details : {};
  return {
    name: typeof details.name === "string" ? details.name : "skill",
    version: typeof details.version === "string" ? details.version : "unknown",
    pendingHash: typeof details.pendingHash === "string" ? details.pendingHash : "",
    diff: typeof details.diff === "string" ? details.diff : "No text diff is available.",
  };
}

function NewSkillDialog({ workspaceId }: { workspaceId: string | null }) {
  const queryClient = useQueryClient();
  const key = skillsKey(workspaceId);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [version, setVersion] = useState("0.1.0");

  const save = useMutation({
    mutationFn: () =>
      host.call("skill.create", {
        name: name.trim(),
        description: description.trim(),
        version: version.trim() || "0.1.0",
        ...(workspaceId ? { workspaceId, scope: "project" as const } : { scope: "global" as const }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: key });
      toast.success(`Added ${name.trim()}`);
      setOpen(false);
      setName("");
      setDescription("");
      setVersion("0.1.0");
    },
    onError: () => toast.error("Could not save skill"),
  });

  const valid = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name.trim()) && name.trim().length <= 64 && description.trim().length > 0 && description.trim().length <= 1024;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid) save.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus />
          New skill
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>New skill</DialogTitle>
            <DialogDescription>
              Create a managed skill template {workspaceId ? "for the current project" : "for all projects"}. Enabled skills can be referenced in chat with $skill-name.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="skill-name">Name</Label>
            <Input id="skill-name" placeholder="e.g. release-notes" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="skill-description">Description</Label>
            <Textarea
              id="skill-description"
              placeholder="What this skill helps Berry do"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="skill-version">Version</Label>
            <Input
              id="skill-version"
              className="font-mono text-xs"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || save.isPending}>
              {save.isPending ? "Creating..." : "Create skill"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ImportSkillDialog({ workspaceId }: { workspaceId: string | null }) {
  const queryClient = useQueryClient();
  const key = skillsKey(workspaceId);
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState("");
  const [preview, setPreview] = useState<SkillImportPreview | null>(null);
  const [scope, setScope] = useState<"project" | "global">(workspaceId ? "project" : "global");
  const [conflictAction, setConflictAction] = useState<"replace" | "keep" | null>(null);
  const [installed, setInstalled] = useState<SkillManifest | null>(null);

  const inspect = useMutation({
    mutationFn: (selectedPath: string) => host.call("skill.inspect", {
      path: selectedPath,
      ...(workspaceId ? { workspaceId } : {}),
    }),
    onSuccess: (value) => {
      setPreview(value);
      setScope(value.projectAvailable ? "project" : "global");
      setConflictAction(null);
      setInstalled(null);
      setOpen(true);
    },
    onError: (error) => {
      setOpen(true);
      toast.error("Could not inspect skill", { description: error instanceof Error ? error.message : String(error) });
    },
  });

  const selectPackage = async () => {
    if (!isTauri()) {
      setOpen(true);
      return;
    }
    try {
      const selected = await pickSkillFile();
      if (!selected) return;
      setPath(selected);
      inspect.mutate(selected);
    } catch (error) {
      toast.error("Could not open skill picker", { description: error instanceof Error ? error.message : String(error) });
    }
  };

  const importSkill = useMutation({
    mutationFn: () => host.call("skill.import", {
      path: path.trim(),
      ...(workspaceId ? { workspaceId } : {}),
      scope,
      expectedFingerprint: preview!.fingerprint,
      trusted: true,
      enabled: true,
      ...(selectedScopeConflict(preview!, scope) && conflictAction ? { conflictAction } : {}),
    }),
    onSuccess: (skills) => {
      void queryClient.invalidateQueries({ queryKey: key });
      if (conflictAction === "keep") {
        toast.success(`Kept the existing ${preview?.name ?? "skill"}`);
        close();
        return;
      }
      const skill = skills[0] ?? null;
      setInstalled(skill);
      if (skill) toast.success(`${skill.name} installed`);
    },
    onError: (error) => toast.error("Could not install skill", { description: error instanceof Error ? error.message : String(error) }),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!preview && path.trim()) inspect.mutate(path.trim());
    else if (preview && (!selectedScopeConflict(preview, scope) || conflictAction)) importSkill.mutate();
  };

  const close = () => {
    setOpen(false);
    setPath("");
    setPreview(null);
    setConflictAction(null);
    setInstalled(null);
  };
  const conflict = preview ? selectedScopeConflict(preview, scope) : false;

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => void selectPackage()} disabled={inspect.isPending}>
        <FileDown />
        {inspect.isPending ? "Inspecting..." : "Import skill"}
      </Button>
      <Dialog open={open} onOpenChange={(next) => { if (!next) close(); else setOpen(true); }}>
      <DialogContent
        className="sm:max-w-xl"
        onDragOver={(event) => { if (Array.from(event.dataTransfer.types).includes("Files")) event.preventDefault(); }}
        onDrop={(event) => {
          const file = event.dataTransfer.files[0] as (File & { path?: string }) | undefined;
          if (!file?.path || !file.name.toLowerCase().endsWith(".skill")) return;
          event.preventDefault();
          setPath(file.path);
          inspect.mutate(file.path);
        }}
      >
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{installed ? `${installed.name} is ready` : preview ? `Install ${preview.name}` : "Import skill"}</DialogTitle>
            <DialogDescription>
              {installed
                ? `Installed for ${scope === "project" ? "this project" : "all projects"}.`
                : preview
                  ? "Review the package contents and choose where Berry should install it."
                  : "Choose a .skill package. Berry validates it before extracting any files."}
            </DialogDescription>
          </DialogHeader>
          {installed ? (
            <div className="rounded-lg border bg-muted/20 p-4">
              <div className="text-sm font-medium">Installed to</div>
              <div className="mt-1 break-all font-mono text-xs text-muted-foreground">{installed.sourcePath}</div>
            </div>
          ) : preview ? (
            <div className="flex min-w-0 flex-col gap-4">
              <div className="rounded-lg border bg-muted/20 p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="font-medium">{preview.name}</div>
                    <p className="mt-1 text-sm text-muted-foreground">{preview.description}</p>
                  </div>
                  <Badge variant="outline">v{preview.version}</Badge>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs text-muted-foreground">
                  <span>{preview.fileCount} files · {formatFileSize(preview.extractedSize)} extracted</span>
                  <span>{preview.rootLayout === "archive-root" ? "SKILL.md at archive root" : `Folder: ${preview.sourceDirectoryName}`}</span>
                  <span>License: {preview.license ?? "Not declared"}</span>
                  <span>Compatibility: {preview.compatibility ?? "No requirements declared"}</span>
                </div>
                {preview.hasScripts ? (
                  <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-foreground">
                    Contains {preview.scripts.length} executable-script resource{preview.scripts.length === 1 ? "" : "s"}. Importing does not run them; later execution still requires normal tool permission.
                  </div>
                ) : null}
                {preview.resources.length > 0 ? (
                  <details className="mt-3 text-xs">
                    <summary className="cursor-pointer text-muted-foreground">Included resources ({preview.resources.length})</summary>
                    <div className="mt-2 max-h-28 overflow-auto rounded border bg-background p-2 font-mono">
                      {preview.resources.map((resource) => <div key={resource}>{resource}</div>)}
                    </div>
                  </details>
                ) : null}
              </div>

              <div className="flex flex-col gap-2">
                <Label>Install location</Label>
                <button
                  type="button"
                  className={`rounded-lg border p-3 text-left transition-colors ${scope === "project" ? "border-ring bg-accent/50" : "hover:bg-accent/30"}`}
                  onClick={() => { setScope("project"); setConflictAction(null); }}
                  disabled={!preview.projectAvailable}
                >
                  <div className="flex items-center gap-2 text-sm font-medium">Current project <Badge variant="secondary">Recommended</Badge></div>
                  <div className="mt-1 break-all font-mono text-xs text-muted-foreground">
                    {preview.destinations.project ?? "Open a project to use this location."}
                  </div>
                </button>
                <button
                  type="button"
                  className={`rounded-lg border p-3 text-left transition-colors ${scope === "global" ? "border-ring bg-accent/50" : "hover:bg-accent/30"}`}
                  onClick={() => { setScope("global"); setConflictAction(null); }}
                >
                  <div className="text-sm font-medium">Global</div>
                  <div className="mt-1 break-all font-mono text-xs text-muted-foreground">{preview.destinations.global}</div>
                </button>
              </div>

              {conflict ? (
                <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
                  <div className="text-sm font-medium">A {scope} skill with this name already exists.</div>
                  <div className="mt-2 flex gap-2">
                    <Button type="button" size="sm" variant={conflictAction === "replace" ? "secondary" : "outline"} onClick={() => setConflictAction("replace")}>Replace</Button>
                    <Button type="button" size="sm" variant={conflictAction === "keep" ? "secondary" : "outline"} onClick={() => setConflictAction("keep")}>Keep existing</Button>
                  </div>
                </div>
              ) : null}

              {!preview.projectTrusted && scope === "project" ? (
                <p className="text-xs text-muted-foreground">This project is not trusted, so the skill will be installed but kept unavailable to the agent.</p>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <Label htmlFor="skill-import-path">Path</Label>
              {isTauri() ? (
                <Button type="button" variant="outline" onClick={() => void selectPackage()}>Choose .skill file…</Button>
              ) : (
                <Input id="skill-import-path" className="font-mono text-xs" placeholder="/path/to/example.skill" value={path} onChange={(event) => setPath(event.target.value)} />
              )}
            </div>
          )}
          <DialogFooter>
            {installed ? (
              <>
                <Button type="button" variant="outline" onClick={() => void host.call("skill.openFolder", { id: installed.id })}>Open skill</Button>
                <Button type="button" onClick={() => {
                  void navigator.clipboard.writeText(`$${installed.name} `);
                  toast.success(`Copied $${installed.name}`);
                  close();
                }}>Use {`$${installed.name}`}</Button>
              </>
            ) : (
              <>
                <Button type="button" variant="ghost" onClick={close}>Cancel</Button>
                <Button type="submit" disabled={inspect.isPending || importSkill.isPending || (!preview && !path.trim()) || Boolean(preview && conflict && !conflictAction)}>
                  {inspect.isPending ? "Inspecting..." : importSkill.isPending ? "Installing..." : preview ? conflictAction === "keep" ? "Keep existing" : "Install skill" : "Inspect"}
                </Button>
              </>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
      </Dialog>
    </>
  );
}

function selectedScopeConflict(preview: SkillImportPreview, scope: "project" | "global"): boolean {
  return scope === "project" ? preview.conflicts.project : preview.conflicts.global;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function SkillUpdateDialog({ skill, workspaceId }: { skill: SkillManifest; workspaceId: string | null }) {
  const queryClient = useQueryClient();
  const key = skillsKey(workspaceId);
  const [open, setOpen] = useState(false);
  const [review, setReview] = useState<SkillReview | null>(null);
  const update = useMutation({
    mutationFn: (confirmHash?: string) => host.call("skill.import", {
      path: skill.originPath!,
      workspaceId: skill.workspaceId ?? workspaceId ?? undefined,
      scope: skill.scope === "workspace" || skill.scope === "workspace-legacy" ? "project" : "global",
      trusted: skill.trusted,
      enabled: skill.enabled,
      ...(confirmHash ? { confirmHash, expectedFingerprint: confirmHash, conflictAction: "replace" as const } : {}),
    }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: key });
      toast.success(`Updated ${skill.name}`);
      setReview(null);
      setOpen(false);
    },
    onError: (error) => {
      const pending = skillReviewFromError(error);
      if (pending) setReview(pending);
      else toast.error(`Could not update ${skill.name}`);
    },
  });
  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (next) update.mutate(undefined); else setReview(null); }}>
      <DialogTrigger asChild><Button size="sm" variant="outline">Review update</Button></DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Update {skill.name}</DialogTitle>
          <DialogDescription>Review source changes before replacing the managed copy.</DialogDescription>
        </DialogHeader>
        {review ? (
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 font-mono text-xs">{review.diff}</pre>
        ) : (
          <div className="py-6 text-sm text-muted-foreground">Checking source...</div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <Button disabled={!review?.pendingHash || update.isPending} onClick={() => review && update.mutate(review.pendingHash)}>
            {update.isPending ? "Updating..." : `Install v${review?.version ?? skill.version}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SkillRow({ skill, workspaceId }: { skill: SkillManifest; workspaceId: string | null }) {
  const queryClient = useQueryClient();
  const key = skillsKey(workspaceId);
  const overrideWorkspaceId = skill.workspaceId ?? workspaceId;
  const [confirmRemove, setConfirmRemove] = useState(false);
  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      host.call("skill.enable", {
        id: skill.id,
        enabled,
        ...(overrideWorkspaceId ? { workspaceId: overrideWorkspaceId } : {}),
        sourcePath: skill.sourcePath,
        name: skill.name,
        description: skill.description,
        trusted: skill.trusted,
      }),
    onMutate: async (enabled) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<SkillManifest[]>(key);
      queryClient.setQueryData<SkillManifest[]>(key, (current) =>
        (current ?? []).map((item) => (item.id === skill.id ? { ...item, enabled } : item)),
      );
      return { previous };
    },
    onError: (_error, _enabled, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
      toast.error(`Could not update ${skill.name}`);
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: key }),
  });
  const remove = useMutation({
    mutationFn: () => host.call("skill.delete", { id: skill.id }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: key });
      toast.success(`Removed ${skill.name}`);
    },
    onError: () => toast.error(`Could not remove ${skill.name}`),
  });
  const trust = useMutation({
    mutationFn: (trusted: boolean) => host.call("skill.trust", { id: skill.id, trusted }),
    onMutate: async (trusted) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<SkillManifest[]>(key);
      queryClient.setQueryData<SkillManifest[]>(key, (current) =>
        (current ?? []).map((item) => (item.id === skill.id ? { ...item, trusted } : item)),
      );
      return { previous };
    },
    onError: (error, _trusted, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
      toast.error(`Could not change trust for ${skill.name}`, { description: error instanceof Error ? error.message : String(error) });
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: key }),
  });
  const openFolder = useMutation({
    mutationFn: () => host.call("skill.openFolder", { id: skill.id, sourcePath: skill.sourcePath }),
    onError: () => toast.error(`Could not open ${skill.name}`),
  });
  const openFile = useMutation({
    mutationFn: () => host.call("skill.openFile", { id: skill.id, sourcePath: skill.sourcePath }),
    onError: () => toast.error(`Could not open ${skill.name}`),
  });

  return (
    <div className="flex items-center justify-between gap-6 p-4">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{skill.name}</span>
          {skill.diagnostic ? <Badge variant="destructive">Invalid</Badge> : null}
          {skill.shadowedBy ? <Badge variant="outline">Shadowed</Badge> : null}
        </div>
        {skill.description ? (
          <p className="line-clamp-2 text-sm text-muted-foreground">{skill.description}</p>
        ) : null}
        <span className="truncate font-mono text-xs text-muted-foreground">{skill.originPath ?? skill.sourcePath}</span>
        {skill.shadowedBy ? <span className="text-xs text-muted-foreground">Shadowed by {skill.shadowedBy}</span> : null}
        {skill.shadows.length > 0 ? <span className="text-xs text-muted-foreground">Overrides {skill.shadows.length} lower-precedence skill{skill.shadows.length === 1 ? "" : "s"}</span> : null}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <Badge variant="outline">{scopeLabel(skill.scope)}</Badge>
        <Badge variant="outline">v{skill.version}</Badge>
        {skill.updateAvailable ? <Badge variant="secondary">Update available</Badge> : null}
        {skill.id.startsWith("managed:") ? <Badge variant="secondary">Organization managed</Badge> : skill.readOnly ? <Badge variant="secondary">Discovered</Badge> : null}
        <Badge variant={skill.trusted ? "secondary" : "outline"}>{skill.trusted ? "Trusted" : "Untrusted"}</Badge>
        {!skill.readOnly ? (
          <Switch checked={skill.trusted} onCheckedChange={(trusted) => trust.mutate(trusted)} aria-label={`Trust ${skill.name}`} />
        ) : null}
        <Switch
          checked={skill.enabled}
          onCheckedChange={(enabled) => toggle.mutate(enabled)}
          aria-label={`Enable ${skill.name}`}
          disabled={Boolean(skill.readOnly || skill.diagnostic || skill.shadowedBy)}
        />
        {skill.updateAvailable && skill.originPath ? <SkillUpdateDialog skill={skill} workspaceId={workspaceId} /> : null}
        <Button size="icon-sm" variant="ghost" onClick={() => openFile.mutate()} disabled={openFile.isPending} aria-label={`View ${skill.name} SKILL.md`} title="View SKILL.md">
          <WandSparkles />
        </Button>
        <Button size="icon-sm" variant="ghost" onClick={() => openFolder.mutate()} disabled={openFolder.isPending} aria-label={`Open ${skill.name} folder`} title="Open folder">
          <FolderOpen />
        </Button>
        {!skill.readOnly ? (
          <>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => setConfirmRemove(true)}
              disabled={remove.isPending}
              aria-label={`Delete ${skill.name}`}
            >
              <Trash2 />
            </Button>
            <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Remove {skill.name}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This removes only the {scopeLabel(skill.scope).toLowerCase()} installation at {skill.sourcePath}. A shadowed lower-precedence skill may become active.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={() => remove.mutate()}>Remove skill</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        ) : null}
      </div>
    </div>
  );
}

export function SkillsSettings() {
  const queryClient = useQueryClient();
  const { activeWorkspace } = useWorkbench();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const key = skillsKey(activeWorkspace?.id);

  const skills = useQuery({
    queryKey: key,
    queryFn: () => host.call("skill.list", activeWorkspace ? { workspaceId: activeWorkspace.id } : undefined),
  });

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (skills.data ?? []).filter((skill) => {
      if (status === "enabled" && !skill.enabled) return false;
      if (status === "disabled" && skill.enabled) return false;
      if (query.length === 0) return true;
      return (
        skill.name.toLowerCase().includes(query) ||
        skill.description.toLowerCase().includes(query)
      );
    });
  }, [skills.data, search, status]);

  return (
    <div className="flex flex-col gap-6">
      <SettingsPageHeader
        title="Skills"
        description="Manage workspace and personal skills. Enabled skills can be referenced in chat with $skill-name."
        actions={
          <>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Refresh skills"
              onClick={() => void queryClient.invalidateQueries({ queryKey: key })}
            >
              <RefreshCw />
            </Button>
            <ImportSkillDialog workspaceId={activeWorkspace?.id ?? null} />
            <NewSkillDialog workspaceId={activeWorkspace?.id ?? null} />
          </>
        }
      />

      <div className="flex items-center gap-2">
        <InputGroup className="flex-1">
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            placeholder="Search skills..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            aria-label="Search skills"
          />
        </InputGroup>
        <Select value={status} onValueChange={(value) => setStatus(value as StatusFilter)}>
          <SelectTrigger className="w-32" aria-label="Filter by status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="enabled">Enabled</SelectItem>
            <SelectItem value="disabled">Disabled</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {skills.isPending ? (
        <SettingCard>
          {[0, 1, 2].map((index) => (
            <div key={index} className="flex items-center justify-between gap-6 p-4">
              <div className="flex w-full flex-col gap-2">
                <Skeleton className="h-4 w-36" />
                <Skeleton className="h-3 w-2/3" />
              </div>
              <Skeleton className="h-5 w-9 rounded-full" />
            </div>
          ))}
        </SettingCard>
      ) : filtered.length === 0 ? (
        <Empty className="border border-dashed border-border py-10 md:p-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <WandSparkles />
            </EmptyMedia>
            <EmptyTitle className="text-sm">
              {(skills.data ?? []).length === 0 ? "No skills yet" : "No skills match"}
            </EmptyTitle>
            <EmptyDescription>
              {(skills.data ?? []).length === 0
                ? "Add a skill folder to teach Berry a repeatable workflow."
                : "Try a different search or status filter."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex flex-col gap-3">
          <SettingsSectionLabel>
            Workspace and personal skills{" "}
            <span className="font-normal">· {filtered.length} {filtered.length === 1 ? "item" : "items"}</span>
          </SettingsSectionLabel>
          <SettingCard>
            {filtered.map((skill) => (
              <SkillRow key={skill.id} skill={skill} workspaceId={activeWorkspace?.id ?? null} />
            ))}
          </SettingCard>
        </div>
      )}
    </div>
  );
}

function scopeLabel(scope: SkillManifest["scope"]): string {
  switch (scope) {
    case "workspace":
      return "Project";
    case "workspace-legacy":
      return "Project legacy";
    case "user":
      return "Global";
    case "codex":
      return "Codex";
    case "user-legacy":
      return "Legacy";
    case "plugin":
      return "Plugin";
    default:
      return "Registered";
  }
}
