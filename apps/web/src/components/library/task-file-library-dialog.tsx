import * as React from "react";
import type { BerryApiClient } from "@berry/api-client";
import type { StoredFile } from "@berry/shared";
import { Button } from "@berry/desktop-ui/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@berry/desktop-ui/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@berry/desktop-ui/components/ui/dropdown-menu";
import { Input } from "@berry/desktop-ui/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@berry/desktop-ui/components/ui/tabs";
import { FileTypeIcon } from "@berry/desktop-ui/lib/file-icons";
import { Download, Ellipsis, Eye, RefreshCw, Search, X } from "lucide-react";
import { FileViewerModal, fileTypeLabel, formatBytes } from "./file-viewer-modal";
import { FileThumbnail, isImageFile } from "./file-thumbnail";

type Scope = "task" | "project";

export function TaskFileLibraryDialog({
  open,
  onOpenChange,
  client,
  taskId,
  projectTaskIds,
  projectName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  client: BerryApiClient | null;
  taskId: string;
  projectTaskIds: string[];
  projectName: string;
}) {
  const [scope, setScope] = React.useState<Scope>("task");
  const [items, setItems] = React.useState<StoredFile[]>([]);
  const [selected, setSelected] = React.useState<StoredFile | null>(null);
  const [query, setQuery] = React.useState("");
  const [state, setState] = React.useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = React.useState("");
  const taskTabRef = React.useRef<HTMLButtonElement>(null);
  const projectTabRef = React.useRef<HTMLButtonElement>(null);
  const pillRef = React.useRef<HTMLSpanElement>(null);
  const tabsPaintedRef = React.useRef(false);

  const refresh = React.useCallback(async () => {
    if (!client || !open) return;
    setState("loading");
    setError("");
    try {
      const loaded: StoredFile[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listFiles(scope === "task" ? { taskId, limit: 100, ...(cursor ? { cursor } : {}) } : { limit: 100, ...(cursor ? { cursor } : {}) });
        loaded.push(...page.items);
        cursor = page.nextCursor ?? undefined;
      } while (cursor && loaded.length < 1_000);
      const projectIds = new Set(projectTaskIds);
      setItems(scope === "task" ? loaded : loaded.filter((file) => file.taskIds.some((id) => projectIds.has(id))));
      setState("ready");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load files");
      setState("error");
    }
  }, [client, open, projectTaskIds, scope, taskId]);

  React.useEffect(() => {
    if (!open) {
      tabsPaintedRef.current = false;
      return;
    }
    setScope("task");
    setQuery("");
  }, [open, taskId]);
  React.useEffect(() => { void refresh(); }, [refresh]);
  React.useLayoutEffect(() => {
    if (!open) return;
    const tab = scope === "task" ? taskTabRef.current : projectTabRef.current;
    const pill = pillRef.current;
    if (!tab || !pill) return;
    const move = (animate: boolean) => {
      const previous = pill.style.transition;
      if (!animate) pill.style.transition = "none";
      pill.style.transform = `translateX(${tab.offsetLeft}px)`;
      pill.style.width = `${tab.offsetWidth}px`;
      if (!animate) {
        void pill.offsetWidth;
        pill.style.transition = previous;
      }
    };
    move(tabsPaintedRef.current);
    tabsPaintedRef.current = true;
    const onResize = () => move(false);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [open, scope]);

  const visible = React.useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return normalized ? items.filter((file) => `${file.name} ${file.originalName}`.toLowerCase().includes(normalized)) : items;
  }, [items, query]);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
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
              <Button variant="ghost" size="icon-sm" aria-label="Refresh files" disabled={state === "loading"} onClick={() => void refresh()}><RefreshCw /></Button>
              <Button variant="ghost" size="icon-sm" aria-label="Close files" onClick={() => onOpenChange(false)}><X /></Button>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <Tabs value={scope} onValueChange={(value) => setScope(value as Scope)}>
                <TabsList className="t-tabs h-9 rounded-full bg-muted p-[3px]">
                  <span ref={pillRef} className="t-tabs-pill" aria-hidden="true" />
                  <TabsTrigger ref={taskTabRef} value="task" className="t-tab min-w-24 rounded-full data-[state=active]:bg-transparent data-[state=active]:shadow-none">Task</TabsTrigger>
                  <TabsTrigger ref={projectTabRef} value="project" className="t-tab min-w-24 rounded-full data-[state=active]:bg-transparent data-[state=active]:shadow-none">Project</TabsTrigger>
                </TabsList>
              </Tabs>
              <label className="relative block w-full sm:max-w-72">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Search files" className="pl-9" />
              </label>
            </div>
          </DialogHeader>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 sm:px-6">
            {state === "loading" ? <FileLibraryStatus>Loading files…</FileLibraryStatus> : null}
            {state === "error" ? <FileLibraryStatus>{error}</FileLibraryStatus> : null}
            {state === "ready" && visible.length === 0 ? <FileLibraryStatus>No files in this {scope} yet.</FileLibraryStatus> : null}
            {state === "ready" && visible.length > 0 ? (
              <div className="flex flex-col" role="list">
                {visible.map((file) => (
                  <div key={file.id} role="listitem" className="group flex min-w-0 items-center gap-3 rounded-[12px] px-2 py-2 transition-colors hover:bg-accent">
                    <button type="button" className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => setSelected(file)}>
                      {isImageFile(file) ? <FileThumbnail name={file.name} previewImageUrl={file.previewUrl} /> : <FileTypeIcon path={file.name} className="size-10" />}
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
          </div>
        </DialogContent>
      </Dialog>
      <FileViewerModal file={selected} onOpenChange={(nextOpen) => { if (!nextOpen) setSelected(null); }} />
    </>
  );
}

function FileLibraryStatus({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-52 items-center justify-center text-sm text-muted-foreground" role="status">{children}</div>;
}
