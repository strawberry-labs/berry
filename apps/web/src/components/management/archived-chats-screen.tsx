import * as React from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ArchiveRestore, Folder, Trash2 } from "lucide-react";
import { ArchivedTasksSearchSchema, type Task, type TaskPage } from "@berry/shared";
import { managementQueryKeys } from "@/lib/management-query-keys";
import { AsyncState, Button, FormSelect, InlineNotice, ManagementDialog, ManagementPage, SearchInput, Section, StatusPill, formatDateTime } from "./management-primitives";
import type { ManagementScreenProps } from "./management-context";
import { FillHeightScroller, InfiniteScrollTrigger } from "../infinite-scroll-trigger";

/** Demo mode pages the local list too, so the archive scrolls the same way it does against the API. */
const LOCAL_PAGE_SIZE = 20;

export function ArchivedTasksScreen({ client, tenantId, userId, supportView, tasks, workspaces, onArchiveTask, onDeleteTask, onRestoreTask }: ManagementScreenProps) {
  const initial = React.useMemo(() => ArchivedTasksSearchSchema.parse(typeof window === "undefined" ? {} : Object.fromEntries(new URLSearchParams(window.location.search))), []);
  const [filters, setFilters] = React.useState(initial);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [error, setError] = React.useState("");
  const [status, setStatus] = React.useState("");
  const [confirmDeleteAll, setConfirmDeleteAll] = React.useState(false);

  const archiveQuery = useInfiniteQuery({
    queryKey: [...managementQueryKeys.archive(filters), tenantId, userId, Boolean(supportView)],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }): Promise<TaskPage> => {
      if (client) {
        return client.listArchivedTasksPage({
          workspaceId: filters.workspace === "all" ? undefined : filters.workspace,
          search: filters.q,
          state: filters.state,
          cursor: pageParam,
          limit: 50,
        }, { signal });
      }
      const local = tasks.filter((task) => {
        const matchesState = filters.state === "all"
          ? task.archived || Boolean(task.deletedAt)
          : filters.state === "archived"
            ? task.archived && !task.deletedAt
            : Boolean(task.deletedAt);
        return matchesState
          && (filters.workspace === "all" || task.workspaceId === filters.workspace)
          && (!filters.q || task.title.toLocaleLowerCase().includes(filters.q.toLocaleLowerCase()));
      }).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      const offset = pageParam ? Number(pageParam) : 0;
      const end = offset + LOCAL_PAGE_SIZE;
      const hasMore = end < local.length;
      return { items: local.slice(offset, end), hasMore, nextCursor: hasMore ? String(end) : null };
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 15_000,
    retry: 2,
  });

  const workspaceById = React.useMemo(() => new Map(workspaces.map((workspace) => [workspace.id, workspace])), [workspaces]);
  const matching = React.useMemo(() => archiveQuery.data?.pages.flatMap((page) => page.items) ?? [], [archiveQuery.data]);

  const groups = React.useMemo(() => {
    const grouped = new Map<string, Task[]>();
    for (const task of matching) grouped.set(task.workspaceId, [...(grouped.get(task.workspaceId) ?? []), task]);
    return [...grouped].map(([workspaceId, items]) => ({
      workspace: workspaceById.get(workspaceId),
      items: items.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    })).sort((left, right) => (left.workspace?.name ?? "").localeCompare(right.workspace?.name ?? ""));
  }, [matching, workspaceById]);

  function update(next: Partial<typeof filters>) {
    const value = ArchivedTasksSearchSchema.parse({ ...filters, ...next });
    setFilters(value);
    const search = new URLSearchParams();
    if (value.q) search.set("q", value.q);
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
      await archiveQuery.refetch();
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
      const result = client
        ? await client.deleteAllArchivedTasks({
            ...(filters.workspace !== "all" ? { workspaceId: filters.workspace } : {}),
            ...(filters.q ? { search: filters.q } : {}),
          })
        : (await Promise.all(archived.map((task) => onDeleteTask(task))), { deletedCount: archived.length });
      await archiveQuery.refetch();
      setStatus(`Moved ${result.deletedCount} archived ${result.deletedCount === 1 ? "task" : "tasks"} to recently deleted.`);
      setConfirmDeleteAll(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The archived tasks could not be deleted.");
    } finally {
      setBusyId(null);
    }
  }

  const archivedCount = matching.filter((task) => task.archived && !task.deletedAt).length;
  const allLoaded = !archiveQuery.hasNextPage;
  const filtered = Boolean(filters.q) || filters.workspace !== "all";
  const showState = filters.state === "all";
  const projectName = (workspace: (typeof workspaces)[number] | undefined) => workspace?.workspaceKind === "general" ? "Tasks" : workspace?.name ?? "Unknown project";
  return (
    <ManagementPage width="narrow"
      title="Archived tasks"
      description="Tasks you archived or deleted. Unarchive or restore one to bring it back to your task list."
      actions={archivedCount > 0 ? <Button variant="secondary" disabled={busyId !== null} onClick={() => { setError(""); setConfirmDeleteAll(true); }}><Trash2 />Delete all archived</Button> : null}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center" aria-label="Archived task filters">
        <SearchInput label="Search archived tasks" value={filters.q ?? ""} onChange={(value) => update({ q: value || undefined })} placeholder="Search by title" />
        <label className="sm:w-48"><span className="sr-only">Project</span><FormSelect value={filters.workspace} onChange={(value) => update({ workspace: value })} options={[{ value: "all", label: "All projects" }, ...workspaces.map((workspace) => ({ value: workspace.id, label: workspace.workspaceKind === "general" ? "Tasks" : workspace.name }))]} /></label>
        <label className="sm:w-48"><span className="sr-only">Archive state</span><FormSelect value={filters.state} onChange={(value) => update({ state: value as typeof filters.state })} options={[{ value: "archived", label: "Archived" }, { value: "deleted", label: "Recently deleted" }, { value: "all", label: "Archived and deleted" }]} /></label>
      </div>

      {error && !confirmDeleteAll ? <InlineNotice tone="danger">{error}</InlineNotice> : null}
      {status ? <InlineNotice tone="good">{status}</InlineNotice> : null}

      <AsyncState loading={archiveQuery.isPending} error={archiveQuery.error instanceof Error ? archiveQuery.error.message : archiveQuery.error ? "Unable to load archived tasks" : null} onRetry={() => void archiveQuery.refetch()} empty={!archiveQuery.isPending && groups.length === 0} emptyTitle={filters.state === "deleted" ? "No recently deleted tasks" : "No archived tasks"} emptyText={filtered ? "Nothing matches this search and project. Try a different filter." : filters.state === "deleted" ? "Tasks you delete stay here for a while so you can restore them." : "Archive a task from its menu to move it out of your task list. It will appear here."}>
        <Section flush>
          <FillHeightScroller>
          <div className="grid divide-y divide-border">
            {groups.map(({ workspace, items }) => (
              <section key={workspace?.id ?? items[0]?.workspaceId} aria-labelledby={`archive-group-${items[0]?.workspaceId}`}>
                <header className="sticky top-0 z-10 flex items-center justify-between gap-4 border-b border-border bg-[var(--berry-surface-under)] px-4 py-1.5">
                  <h2 className="flex min-w-0 items-center gap-2 text-xs font-medium text-muted-foreground" id={`archive-group-${items[0]?.workspaceId}`}><Folder className="size-3.5 shrink-0" aria-hidden /><span className="truncate">{projectName(workspace)}</span></h2>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{items.length} {items.length === 1 ? "task" : "tasks"}</span>
                </header>
                <div className="grid divide-y divide-border">
                  {items.map((task) => <article className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 hover:bg-[var(--berry-hover)]" key={task.id}>
                    <div className="grid min-w-0 flex-1 basis-48 gap-0.5">
                      <b className="truncate text-md font-medium text-foreground" title={task.title}>{task.title}</b>
                      <time className="text-xs text-muted-foreground" dateTime={task.deletedAt ?? task.updatedAt}>{task.deletedAt ? `Deleted ${formatDateTime(task.deletedAt)}` : `Last updated ${formatDateTime(task.updatedAt)}`}</time>
                    </div>
                    {showState ? <StatusPill tone={task.deletedAt ? "warning" : "neutral"}>{task.deletedAt ? "Deleted" : "Archived"}</StatusPill> : null}
                    <div className="flex shrink-0 items-center gap-1">
                      <Button variant="secondary" disabled={busyId !== null} onClick={() => void mutate(task, task.deletedAt ? "restore" : "unarchive")}><ArchiveRestore />{task.deletedAt ? "Restore" : "Unarchive"}</Button>
                      {!task.deletedAt ? <Button variant="ghost" size="icon" aria-label={`Delete ${task.title}`} title="Move to recently deleted" disabled={busyId !== null} onClick={() => void mutate(task, "delete")}><Trash2 /></Button> : null}
                    </div>
                  </article>)}
                </div>
              </section>
            ))}
          </div>
          <InfiniteScrollTrigger
            className="border-t border-border"
            hasMore={Boolean(archiveQuery.hasNextPage)}
            loading={archiveQuery.isFetchingNextPage}
            error={archiveQuery.isFetchNextPageError ? "Older tasks could not be loaded." : null}
            onLoadMore={() => void archiveQuery.fetchNextPage()}
          />
          </FillHeightScroller>
        </Section>
      </AsyncState>

      <ManagementDialog
        open={confirmDeleteAll}
        onOpenChange={(open) => { if (!open && busyId !== "all") setConfirmDeleteAll(false); }}
        title={allLoaded ? `Delete ${archivedCount} archived ${archivedCount === 1 ? "task" : "tasks"}?` : "Delete all archived tasks?"}
        description={`${filtered ? "Every archived task that matches the current search and project" : "Every archived task"} moves to Recently deleted, where you can still restore it.`}
        size="sm"
        footer={<>
          <Button variant="secondary" disabled={busyId === "all"} onClick={() => setConfirmDeleteAll(false)}>Cancel</Button>
          <Button variant="destructive" disabled={busyId !== null} onClick={() => void deleteAll()}><Trash2 />{busyId === "all" ? "Deleting…" : "Delete all"}</Button>
        </>}
      >
        {error ? <InlineNotice tone="danger">{error}</InlineNotice> : <p className="text-md leading-5 text-muted-foreground">{allLoaded ? "Tasks already in Recently deleted are not affected." : "This includes archived tasks that are not loaded on this page yet."}</p>}
      </ManagementDialog>
    </ManagementPage>
  );
}
