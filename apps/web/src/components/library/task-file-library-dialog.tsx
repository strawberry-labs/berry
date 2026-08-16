import * as React from "react";
import type { BerryApiClient } from "@berry/api-client";
import type { StoredFile } from "@berry/shared";
import { Button } from "@berry/desktop-ui/components/ui/button";
import { CircularActivitySpinner } from "@berry/desktop-ui/components/ui/circular-activity-spinner";
import { Checkbox } from "@berry/desktop-ui/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@berry/desktop-ui/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@berry/desktop-ui/components/ui/dropdown-menu";
import { Input } from "@berry/desktop-ui/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@berry/desktop-ui/components/ui/tabs";
import { FileTypeIcon } from "@berry/desktop-ui/lib/file-icons";
import { Download, Ellipsis, Eye, RefreshCw, Search, X } from "lucide-react";
import { DocumentPreviewModal } from "./document-preview-modal";
import { fileTypeLabel, formatBytes } from "./file-metadata";
import { FileThumbnail, isImageFile } from "./file-thumbnail";
import { toast } from "sonner";

type Scope = "task" | "project";

export function TaskFileLibraryDialog({
  open,
  onOpenChange,
  client,
  taskId,
  projectWorkspaceId,
  projectName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  client: BerryApiClient | null;
  taskId: string;
  projectWorkspaceId: string;
  projectName: string;
}) {
  const [scope, setScope] = React.useState<Scope>("task");
  const [items, setItems] = React.useState<StoredFile[]>([]);
  const [selected, setSelected] = React.useState<StoredFile | null>(null);
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(() => new Set());
  const [downloadProgress, setDownloadProgress] = React.useState<{ completed: number; total: number } | null>(null);
  const [query, setQuery] = React.useState("");
  const [state, setState] = React.useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = React.useState("");
  const [nextCursor, setNextCursor] = React.useState<string | null>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [loadMoreError, setLoadMoreError] = React.useState("");
  const downloadAbort = React.useRef<AbortController | null>(null);
  const loadAbort = React.useRef<AbortController | null>(null);

  const refresh = React.useCallback(async () => {
    if (!client || !open) return;
    loadAbort.current?.abort();
    const controller = new AbortController();
    loadAbort.current = controller;
    setState("loading");
    setError("");
    setNextCursor(null);
    setLoadingMore(false);
    setLoadMoreError("");
    try {
      const page = await client.listFiles(
        scope === "task"
          ? { taskId, limit: 100 }
          : { workspaceId: projectWorkspaceId, limit: 100 },
        { signal: controller.signal },
      );
      if (controller.signal.aborted || loadAbort.current !== controller) return;
      setItems(page.items);
      setNextCursor(page.nextCursor);
      setState("ready");
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : "Unable to load files");
      setState("error");
    } finally {
      if (loadAbort.current === controller) loadAbort.current = null;
    }
  }, [client, open, projectWorkspaceId, scope, taskId]);

  const loadMore = React.useCallback(async () => {
    if (!client || !open || !nextCursor || loadingMore) return;
    loadAbort.current?.abort();
    const controller = new AbortController();
    const requestedCursor = nextCursor;
    loadAbort.current = controller;
    setLoadingMore(true);
    setLoadMoreError("");
    try {
      const page = await client.listFiles(
        scope === "task"
          ? { taskId, limit: 100, cursor: requestedCursor }
          : { workspaceId: projectWorkspaceId, limit: 100, cursor: requestedCursor },
        { signal: controller.signal },
      );
      if (controller.signal.aborted || loadAbort.current !== controller) return;
      if (page.nextCursor === requestedCursor) {
        throw new Error("File pagination returned a repeated cursor");
      }
      setItems((current) => mergeItemsById(current, page.items));
      setNextCursor(page.nextCursor);
    } catch (cause) {
      if (controller.signal.aborted) return;
      setLoadMoreError(cause instanceof Error ? cause.message : "Unable to load more files");
    } finally {
      if (loadAbort.current === controller) {
        loadAbort.current = null;
        setLoadingMore(false);
      }
    }
  }, [client, loadingMore, nextCursor, open, projectWorkspaceId, scope, taskId]);

  React.useEffect(() => {
    if (!open) {
      return;
    }
    setScope("task");
    setQuery("");
    setSelectedIds(new Set());
  }, [open, taskId]);
  React.useEffect(() => () => {
    loadAbort.current?.abort();
    downloadAbort.current?.abort();
  }, []);
  React.useEffect(() => { void refresh(); }, [refresh]);

  const visible = React.useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return normalized ? items.filter((file) => `${file.name} ${file.originalName}`.toLowerCase().includes(normalized)) : items;
  }, [items, query]);
  const visibleIds = React.useMemo(() => new Set(visible.map((file) => file.id)), [visible]);
  const selectedVisible = React.useMemo(
    () => visible.filter((file) => selectedIds.has(file.id)),
    [selectedIds, visible],
  );
  const selectedFiles = React.useMemo(
    () => items.filter((file) => selectedIds.has(file.id)),
    [items, selectedIds],
  );
  const allVisibleSelected = visible.length > 0 && selectedVisible.length === visible.length;

  React.useEffect(() => {
    setSelectedIds((current) => new Set([...current].filter((id) => items.some((item) => item.id === id))));
  }, [items]);

  const toggleVisible = React.useCallback((checked: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const id of visibleIds) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, [visibleIds]);

  const downloadFiles = React.useCallback(async () => {
    if (!client || downloadProgress) return;
    const files = selectedFiles.length > 0 ? selectedFiles : visible;
    if (files.length === 0) return;
    const controller = new AbortController();
    downloadAbort.current = controller;
    setDownloadProgress({ completed: 0, total: files.length });
    try {
      const result = await downloadFilesIndividually({
        files,
        signal: controller.signal,
        download: (fileId, signal) => client.downloadFile(fileId, { signal }),
        save: downloadBlob,
        onProgress: (completed) => setDownloadProgress({ completed, total: files.length }),
      });
      if (controller.signal.aborted) return;
      if (result.failed.length === 0) {
        toast.success(`Downloaded ${result.downloaded} file${result.downloaded === 1 ? "" : "s"}`);
      } else {
        toast.error(`Downloaded ${result.downloaded} of ${files.length} files. ${result.failed.length} failed.`);
      }
    } catch (cause) {
      const wasAborted = controller.signal.aborted;
      controller.abort();
      if (!wasAborted)
        toast.error(cause instanceof Error ? cause.message : "Unable to download the files");
    } finally {
      if (downloadAbort.current === controller) {
        downloadAbort.current = null;
        setDownloadProgress(null);
      }
    }
  }, [client, downloadProgress, selectedFiles, visible]);

  const changeOpen = React.useCallback((nextOpen: boolean) => {
    if (!nextOpen) {
      loadAbort.current?.abort();
      downloadAbort.current?.abort();
    }
    onOpenChange(nextOpen);
  }, [onOpenChange]);

  return (
    <>
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent
          showCloseButton={false}
          className="berry-file-library-dialog flex h-[88vh] w-[min(92vw,1040px)] max-w-[min(92vw,1040px)] flex-col gap-0 overflow-hidden rounded-[20px] border-0 bg-[var(--berry-main-bg)] p-0 shadow-2xl"
        >
          <DialogHeader className="shrink-0 gap-4 border-b border-border px-6 py-5 text-left">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <DialogTitle className="text-xl">Files</DialogTitle>
                <DialogDescription className="mt-1 truncate">Browse files from this task or {projectName}.</DialogDescription>
              </div>
              <Button variant="ghost" size="icon-sm" aria-label="Refresh files" disabled={state === "loading" || loadingMore} onClick={() => void refresh()}><RefreshCw /></Button>
              <Button variant="secondary" size="sm" disabled={state !== "ready" || (visible.length === 0 && selectedFiles.length === 0) || Boolean(downloadProgress)} onClick={() => void downloadFiles()}>
                <Download data-icon="inline-start" />
                {downloadProgress
                  ? `Downloading ${Math.min(downloadProgress.completed + 1, downloadProgress.total)} of ${downloadProgress.total}…`
                  : selectedFiles.length > 0
                    ? `Download selected (${selectedFiles.length})`
                    : query.trim()
                      ? `Download matches (${visible.length})`
                      : nextCursor
                        ? `Download loaded (${visible.length})`
                        : "Download all"}
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label="Close files" onClick={() => changeOpen(false)}><X /></Button>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <Tabs value={scope} onValueChange={(value) => setScope(value as Scope)}>
                <TabsList className="berry-file-library-scope-switch h-9 p-0">
                  <TabsTrigger value="task" className="berry-file-library-scope-trigger min-w-24">Task</TabsTrigger>
                  <TabsTrigger value="project" className="berry-file-library-scope-trigger min-w-24">Project</TabsTrigger>
                </TabsList>
              </Tabs>
              <label className="relative block w-full sm:max-w-72">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Search files" className="pl-9" />
              </label>
            </div>
          </DialogHeader>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 sm:px-6">
            {state === "loading" ? <FileLibraryStatus><CircularActivitySpinner size={28} label="Loading files" /></FileLibraryStatus> : null}
            {state === "error" ? <FileLibraryStatus>{error}</FileLibraryStatus> : null}
            {state === "ready" && visible.length === 0 ? (
              <FileLibraryStatus>{query.trim() ? "No matching files loaded." : `No files in this ${scope} yet.`}</FileLibraryStatus>
            ) : null}
            {state === "ready" && visible.length > 0 ? (
              <div className="flex flex-col" role="list">
                <div className="flex min-h-10 items-center gap-3 border-b border-border px-2 text-xs text-muted-foreground">
                  <Checkbox
                    checked={allVisibleSelected ? true : selectedVisible.length > 0 ? "indeterminate" : false}
                    onCheckedChange={(checked) => toggleVisible(checked === true)}
                    aria-label={allVisibleSelected ? "Clear visible file selection" : "Select all visible files"}
                  />
                  <span>{selectedVisible.length > 0 ? `${selectedVisible.length} selected` : `${visible.length} file${visible.length === 1 ? "" : "s"}`}</span>
                </div>
                {visible.map((file) => (
                  <div key={file.id} role="listitem" className="group flex min-w-0 items-center gap-3 rounded-[12px] px-2 py-2 transition-colors hover:bg-accent">
                    <Checkbox
                      checked={selectedIds.has(file.id)}
                      onCheckedChange={(checked) => setSelectedIds((current) => {
                        const next = new Set(current);
                        if (checked === true) next.add(file.id);
                        else next.delete(file.id);
                        return next;
                      })}
                      aria-label={`${selectedIds.has(file.id) ? "Deselect" : "Select"} ${file.name}`}
                    />
                    <button type="button" className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => setSelected(file)}>
                      {isImageFile(file) ? <FileThumbnail name={file.name} previewImageUrl={file.previewUrl} mediaType={file.mediaType} /> : <FileTypeIcon path={file.name} className="size-10" />}
                      <span className="min-w-0 flex-1">
                        <strong className="block truncate text-sm font-medium" title={file.name}>{file.name}</strong>
                        <small className="block truncate text-xs text-muted-foreground">{fileTypeLabel(file)} · {formatBytes(file.size)} · {new Date(file.createdAt).toLocaleString()}</small>
                      </span>
                    </button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`Actions for ${file.name}`}><Ellipsis /></Button></DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setSelected(file)}><Eye /> Preview</DropdownMenuItem>
                        <DropdownMenuItem asChild><a href={file.downloadUrl} download={file.name}><Download /> Download</a></DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                ))}
              </div>
            ) : null}
            {state === "ready" && nextCursor ? (
              <div className="flex flex-col items-center gap-2 border-t border-border px-2 py-4">
                {loadMoreError ? <p className="text-xs text-destructive" role="alert">{loadMoreError}</p> : null}
                <Button variant="outline" size="sm" disabled={loadingMore} onClick={() => void loadMore()}>
                  {loadingMore ? <CircularActivitySpinner size={16} label="Loading more files" /> : null}
                  {loadingMore ? "Loading…" : "Load more files"}
                </Button>
              </div>
            ) : null}
          </div>
          <DocumentPreviewModal file={selected} onOpenChange={(nextOpen) => { if (!nextOpen) setSelected(null); }} />
        </DialogContent>
      </Dialog>
    </>
  );
}

export function mergeItemsById<T extends { id: string }>(current: readonly T[], incoming: readonly T[]): T[] {
  const seen = new Set(current.map((item) => item.id));
  return [...current, ...incoming.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  })];
}

export function uniqueDownloadName(name: string, usedNames: Set<string>): string {
  const normalizedName = name.replace(/[\\/\0]/g, "-").trim();
  const safeName = !normalizedName || normalizedName === "." || normalizedName === ".." ? "file" : normalizedName;
  const dot = safeName.lastIndexOf(".");
  const stem = dot > 0 ? safeName.slice(0, dot) : safeName;
  const extension = dot > 0 ? safeName.slice(dot) : "";
  let candidate = safeName;
  let copy = 2;
  while (usedNames.has(candidate.toLowerCase())) {
    candidate = `${stem} (${copy})${extension}`;
    copy += 1;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

export async function downloadFilesIndividually(input: {
  files: readonly Pick<StoredFile, "id" | "name">[];
  signal: AbortSignal;
  download(fileId: string, signal: AbortSignal): Promise<Blob>;
  save(blob: Blob, name: string): void;
  onProgress?(completed: number): void;
}): Promise<{ downloaded: number; failed: Array<{ fileId: string; name: string }> }> {
  const usedNames = new Set<string>();
  const failed: Array<{ fileId: string; name: string }> = [];
  let downloaded = 0;
  for (const file of input.files) {
    if (input.signal.aborted) break;
    const name = uniqueDownloadName(file.name, usedNames);
    try {
      const blob = await input.download(file.id, input.signal);
      if (input.signal.aborted) break;
      input.save(blob, name);
      downloaded += 1;
    } catch {
      if (input.signal.aborted) break;
      failed.push({ fileId: file.id, name: file.name });
    }
    input.onProgress?.(downloaded + failed.length);
  }
  return { downloaded, failed };
}

function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function FileLibraryStatus({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-52 items-center justify-center text-sm text-muted-foreground" role="status">{children}</div>;
}
