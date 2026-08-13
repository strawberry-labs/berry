import * as React from "react";
import { ArchiveRestore, Folder, Trash2 } from "lucide-react";
import { ArchivedChatsSearchSchema, type Task } from "@berry/shared";
import { Button, FormSelect, ManagementPage, SearchInput, StatusPill } from "./management-primitives";
import type { ManagementScreenProps } from "./management-context";

export function ArchivedChatsScreen({ tasks, workspaces, onArchiveTask, onDeleteTask, onRestoreTask }: ManagementScreenProps) {
  const initial = React.useMemo(() => ArchivedChatsSearchSchema.parse(typeof window === "undefined" ? {} : Object.fromEntries(new URLSearchParams(window.location.search))), []);
  const [filters, setFilters] = React.useState(initial);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [error, setError] = React.useState("");
  const [status, setStatus] = React.useState("");
  const [confirmDeleteAll, setConfirmDeleteAll] = React.useState(false);

  const workspaceById = React.useMemo(() => new Map(workspaces.map((workspace) => [workspace.id, workspace])), [workspaces]);
  const matching = React.useMemo(() => tasks.filter((task) => {
    const matchesState = filters.state === "all"
      ? task.archived || Boolean(task.deletedAt)
      : filters.state === "archived"
        ? task.archived && !task.deletedAt
        : Boolean(task.deletedAt);
    const matchesKind = filters.kind === "all" || task.conversationKind === filters.kind;
    const matchesWorkspace = filters.workspace === "all" || task.workspaceId === filters.workspace;
    const matchesQuery = !filters.q || task.title.toLocaleLowerCase().includes(filters.q.toLocaleLowerCase());
    return matchesState && matchesKind && matchesWorkspace && matchesQuery;
  }), [filters, tasks]);

  const groups = React.useMemo(() => {
    const grouped = new Map<string, Task[]>();
    for (const task of matching) grouped.set(task.workspaceId, [...(grouped.get(task.workspaceId) ?? []), task]);
    return [...grouped].map(([workspaceId, items]) => ({
      workspace: workspaceById.get(workspaceId),
      items: items.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    })).sort((left, right) => (left.workspace?.name ?? "").localeCompare(right.workspace?.name ?? ""));
  }, [matching, workspaceById]);

  function update(next: Partial<typeof filters>) {
    const value = ArchivedChatsSearchSchema.parse({ ...filters, ...next });
    setFilters(value);
    const search = new URLSearchParams();
    if (value.q) search.set("q", value.q);
    if (value.kind !== "all") search.set("kind", value.kind);
    if (value.workspace !== "all") search.set("workspace", value.workspace);
    if (value.state !== "archived") search.set("state", value.state);
    window.history.replaceState(null, "", `${window.location.pathname}${search.size ? `?${search}` : ""}`);
  }

  async function mutate(task: Task, action: "unarchive" | "delete" | "restore") {
    setBusyId(task.id);
    setError("");
    try {
      if (action === "unarchive") await onArchiveTask(task, false);
      else if (action === "delete") await onDeleteTask(task);
      else await onRestoreTask(task);
      setStatus(action === "unarchive" ? `Unarchived ${task.title}.` : action === "delete" ? `Moved ${task.title} to recently deleted.` : `Restored ${task.title}.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The task could not be updated.");
    } finally {
      setBusyId(null);
    }
  }

  async function deleteAll() {
    const archived = matching.filter((task) => task.archived && !task.deletedAt);
    setBusyId("all");
    setError("");
    try {
      for (const task of archived) await onDeleteTask(task);
      setStatus(`Moved ${archived.length} archived ${archived.length === 1 ? "task" : "tasks"} to recently deleted.`);
      setConfirmDeleteAll(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The archived tasks could not be deleted.");
    } finally {
      setBusyId(null);
    }
  }

  const archivedCount = matching.filter((task) => task.archived && !task.deletedAt).length;
  return (
    <ManagementPage
      title="Archived tasks"
      description="Search, restore, or remove tasks without adding recovery controls beneath the composer."
      eyebrow="History"
      actions={archivedCount > 0 ? <Button variant="destructive" disabled={busyId !== null} onClick={() => setConfirmDeleteAll(true)}><Trash2 />Delete all</Button> : null}
    >
      <div className="grid gap-2 rounded-xl border border-border bg-card p-3 sm:grid-cols-2 xl:grid-cols-[minmax(220px,1fr)_repeat(3,minmax(140px,auto))]" aria-label="Archived task filters">
        <SearchInput label="Search archived tasks" value={filters.q ?? ""} onChange={(value) => update({ q: value || undefined })} placeholder="Search archived tasks" />
        <label><span className="sr-only">Task type</span><FormSelect value={filters.kind} onChange={(value) => update({ kind: value as typeof filters.kind })} options={[{ value: "all", label: "All tasks" }, { value: "chat", label: "Task" }, { value: "code", label: "Code" }]} /></label>
        <label><span className="sr-only">Project</span><FormSelect value={filters.workspace} onChange={(value) => update({ workspace: value })} options={[{ value: "all", label: "All projects" }, ...workspaces.map((workspace) => ({ value: workspace.id, label: workspace.workspaceKind === "general" ? "Tasks" : workspace.name }))]} /></label>
        <label><span className="sr-only">Archive state</span><FormSelect value={filters.state} onChange={(value) => update({ state: value as typeof filters.state })} options={[{ value: "archived", label: "Archived" }, { value: "deleted", label: "Recently deleted" }, { value: "all", label: "Archived and deleted" }]} /></label>
      </div>

      {confirmDeleteAll ? <div className="flex flex-col gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4 sm:flex-row sm:items-center" role="alertdialog" aria-labelledby="delete-archived-title" aria-describedby="delete-archived-description"><div className="mr-auto"><b className="text-sm text-foreground" id="delete-archived-title">Delete {archivedCount} archived {archivedCount === 1 ? "task" : "tasks"}?</b><p className="mt-1 text-xs text-muted-foreground" id="delete-archived-description">They will move to Recently deleted and can still be restored.</p></div><Button variant="secondary" onClick={() => setConfirmDeleteAll(false)}>Cancel</Button><Button variant="destructive" disabled={busyId !== null} onClick={() => void deleteAll()}><Trash2 />Delete all</Button></div> : null}
      {error ? <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive" role="alert">{error}</p> : null}
      {status ? <p className="rounded-lg border border-[var(--berry-success)]/25 bg-[var(--berry-success)]/5 px-3 py-2 text-xs text-[var(--berry-success)]" role="status">{status}</p> : null}

      {groups.length === 0 ? <div className="flex min-h-44 flex-col items-center justify-center gap-2 rounded-xl border border-border bg-card px-6 py-8 text-center"><ArchiveRestore className="size-5 text-muted-foreground" aria-hidden /><h2 className="text-sm font-medium text-foreground">{filters.state === "deleted" ? "No recently deleted tasks" : "No archived tasks"}</h2><p className="text-xs text-muted-foreground">{filters.q ? "Try a different search or filter." : "Tasks you archive will appear here."}</p></div> : groups.map(({ workspace, items }) => (
        <section className="grid gap-2" key={workspace?.id ?? items[0]?.workspaceId} aria-labelledby={`archive-group-${items[0]?.workspaceId}`}>
          <header className="flex items-center justify-between gap-4 px-1"><h2 className="flex items-center gap-2 text-sm font-medium text-foreground" id={`archive-group-${items[0]?.workspaceId}`}><Folder className="size-4 text-muted-foreground" aria-hidden />{workspace?.workspaceKind === "general" ? "Tasks" : workspace?.name ?? "Unknown project"}</h2><span className="text-xs text-muted-foreground">{items.length} {items.length === 1 ? "task" : "tasks"}</span></header>
          <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
            {items.map((task) => <article className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto]" key={task.id}>
              <div className="grid min-w-0 gap-0.5"><b className="truncate text-sm font-medium text-foreground" title={task.title}>{task.title}</b><time className="text-xs text-muted-foreground" dateTime={task.updatedAt}>{new Date(task.updatedAt).toLocaleString()}</time></div>
              <StatusPill tone={task.deletedAt ? "warning" : "info"}>{task.deletedAt ? "Recently deleted" : task.conversationKind === "code" ? "Code" : "Task"}</StatusPill>
              {!task.deletedAt ? <Button variant="ghost" size="icon" aria-label={`Delete ${task.title}`} disabled={busyId !== null} onClick={() => void mutate(task, "delete")}><Trash2 /></Button> : null}
              <Button variant="secondary" disabled={busyId !== null} onClick={() => void mutate(task, task.deletedAt ? "restore" : "unarchive")}>{task.deletedAt ? "Restore" : "Unarchive"}</Button>
            </article>)}
          </div>
        </section>
      ))}
    </ManagementPage>
  );
}
