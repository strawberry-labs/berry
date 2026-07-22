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
      setError(cause instanceof Error ? cause.message : "The conversation could not be updated.");
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
      setStatus(`Moved ${archived.length} archived ${archived.length === 1 ? "chat" : "chats"} to recently deleted.`);
      setConfirmDeleteAll(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The archived conversations could not be deleted.");
    } finally {
      setBusyId(null);
    }
  }

  const archivedCount = matching.filter((task) => task.archived && !task.deletedAt).length;
  return (
    <ManagementPage
      title="Archived chats"
      description="Search, restore, or remove conversations without adding recovery controls beneath the composer."
      eyebrow="Account & data"
      actions={archivedCount > 0 ? <Button variant="destructive" disabled={busyId !== null} onClick={() => setConfirmDeleteAll(true)}><Trash2 />Delete all</Button> : null}
    >
      <div className="mgmt-archive-filters" aria-label="Archived chat filters">
        <SearchInput label="Search archived chats" value={filters.q ?? ""} onChange={(value) => update({ q: value || undefined })} placeholder="Search archived chats" />
        <label><span className="sr-only">Conversation type</span><FormSelect value={filters.kind} onChange={(value) => update({ kind: value as typeof filters.kind })} options={[{ value: "all", label: "All chats" }, { value: "chat", label: "Chat" }, { value: "code", label: "Code" }]} /></label>
        <label><span className="sr-only">Project</span><FormSelect value={filters.workspace} onChange={(value) => update({ workspace: value })} options={[{ value: "all", label: "All projects" }, ...workspaces.map((workspace) => ({ value: workspace.id, label: workspace.workspaceKind === "general" ? "Chats" : workspace.name }))]} /></label>
        <label><span className="sr-only">Archive state</span><FormSelect value={filters.state} onChange={(value) => update({ state: value as typeof filters.state })} options={[{ value: "archived", label: "Archived" }, { value: "deleted", label: "Recently deleted" }, { value: "all", label: "Archived and deleted" }]} /></label>
      </div>

      {confirmDeleteAll ? <div className="mgmt-confirm-panel" role="alertdialog" aria-labelledby="delete-archived-title" aria-describedby="delete-archived-description"><div><b id="delete-archived-title">Delete {archivedCount} archived {archivedCount === 1 ? "chat" : "chats"}?</b><p id="delete-archived-description">They will move to Recently deleted and can still be restored.</p></div><Button variant="secondary" onClick={() => setConfirmDeleteAll(false)}>Cancel</Button><Button variant="destructive" disabled={busyId !== null} onClick={() => void deleteAll()}><Trash2 />Delete all</Button></div> : null}
      {error ? <p className="mgmt-callout" role="alert">{error}</p> : null}
      {status ? <p className="mgmt-success" role="status">{status}</p> : null}

      {groups.length === 0 ? <div className="mgmt-state"><ArchiveRestore aria-hidden /><h2>{filters.state === "deleted" ? "No recently deleted chats" : "No archived chats"}</h2><p>{filters.q ? "Try a different search or filter." : "Conversations you archive will appear here."}</p></div> : groups.map(({ workspace, items }) => (
        <section className="mgmt-archive-group" key={workspace?.id ?? items[0]?.workspaceId} aria-labelledby={`archive-group-${items[0]?.workspaceId}`}>
          <header><h2 id={`archive-group-${items[0]?.workspaceId}`}><Folder aria-hidden />{workspace?.workspaceKind === "general" ? "Chats" : workspace?.name ?? "Unknown project"}</h2><span>{items.length} {items.length === 1 ? "chat" : "chats"}</span></header>
          <div className="mgmt-archive-list">
            {items.map((task) => <article className="mgmt-archive-row" key={task.id}>
              <div className="mgmt-archive-copy"><b title={task.title}>{task.title}</b><time dateTime={task.updatedAt}>{new Date(task.updatedAt).toLocaleString()}</time></div>
              <StatusPill tone={task.deletedAt ? "warning" : "info"}>{task.deletedAt ? "Recently deleted" : task.conversationKind === "code" ? "Code" : "Chat"}</StatusPill>
              {!task.deletedAt ? <Button variant="ghost" size="icon" className="mgmt-archive-delete" aria-label={`Delete ${task.title}`} disabled={busyId !== null} onClick={() => void mutate(task, "delete")}><Trash2 /></Button> : null}
              <Button variant="secondary" disabled={busyId !== null} onClick={() => void mutate(task, task.deletedAt ? "restore" : "unarchive")}>{task.deletedAt ? "Restore" : "Unarchive"}</Button>
            </article>)}
          </div>
        </section>
      ))}
    </ManagementPage>
  );
}
