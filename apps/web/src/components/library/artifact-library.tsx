import * as React from "react";
import type { BerryApiClient, ProjectOutcome } from "@berry/api-client";
import type { StoredFile, Workspace } from "@berry/shared";
import { AlertCircle, Check, Clock } from "lucide-react";
import { Button } from "@berry/desktop-ui/components/ui/button";
import { CircularActivitySpinner } from "@berry/desktop-ui/components/ui/circular-activity-spinner";
import { Input } from "@berry/desktop-ui/components/ui/input";
import { FileImage, Files, FileText, FolderOpen, RefreshCw, Search, Trash2 } from "@berry/desktop-ui/lib/icons";
import { FileTypeIcon } from "@berry/desktop-ui/lib/file-icons";
import { GeneratedImageLightbox, type GeneratedImageView } from "@berry/desktop-ui/components/generated-image-gallery";
import type { ArtifactLibraryTab } from "@/lib/cloud-shell-state";
import { DocumentPreviewModal } from "./document-preview-modal";
import { fileTypeLabel, formatBytes } from "./file-metadata";

const LIBRARY_PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 220;

export function ArtifactLibrary({ client, tab, onTabChange, workspaces, activeWorkspaceId, onWorkspaceChange }: {
  client: BerryApiClient | null;
  tab: ArtifactLibraryTab;
  onTabChange: (tab: ArtifactLibraryTab) => void;
  workspaces: Workspace[];
  activeWorkspaceId: string;
  onWorkspaceChange: (workspaceId: string) => void;
}) {
  const [items, setItems] = React.useState<StoredFile[]>([]);
  const [selected, setSelected] = React.useState<StoredFile | null>(null);
  const [nextCursor, setNextCursor] = React.useState<string | null>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [state, setState] = React.useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = React.useState("");
  const [searchInput, setSearchInput] = React.useState("");
  const search = useDebouncedValue(searchInput.trim(), SEARCH_DEBOUNCE_MS);
  const requestRef = React.useRef<{ id: number; controller: AbortController } | null>(null);
  const requestIdRef = React.useRef(0);

  const beginRequest = React.useCallback(() => {
    requestRef.current?.controller.abort();
    const request = { id: ++requestIdRef.current, controller: new AbortController() };
    requestRef.current = request;
    return request;
  }, []);

  const isCurrentRequest = React.useCallback((request: { id: number }) => requestRef.current?.id === request.id, []);

  const refresh = React.useCallback(async () => {
    const request = beginRequest();
    if (!client) {
      setItems([]);
      setNextCursor(null);
      setLoadingMore(false);
      setState("ready");
      return;
    }
    setState("loading");
    setError("");
    try {
      const page = await client.listFiles({
        limit: LIBRARY_PAGE_SIZE,
        ...(search ? { search } : {}),
      }, { signal: request.controller.signal });
      if (!isCurrentRequest(request)) return;
      setItems(page.items);
      setNextCursor(page.nextCursor);
      setState("ready");
    } catch (cause) {
      if (request.controller.signal.aborted || !isCurrentRequest(request)) return;
      setError(cause instanceof Error ? cause.message : "Unable to load the library");
      setState("error");
    }
  }, [beginRequest, client, isCurrentRequest, search]);

  React.useEffect(() => {
    void refresh();
    return () => requestRef.current?.controller.abort();
  }, [refresh]);

  const loadMore = React.useCallback(async () => {
    if (!client || !nextCursor || loadingMore) return;
    const request = beginRequest();
    setLoadingMore(true);
    try {
      const page = await client.listFiles({
        cursor: nextCursor,
        limit: LIBRARY_PAGE_SIZE,
        ...(search ? { search } : {}),
      }, { signal: request.controller.signal });
      if (!isCurrentRequest(request)) return;
      setItems((current) => [...current, ...page.items.filter((item) => !current.some((existing) => existing.id === item.id))]);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      if (request.controller.signal.aborted || !isCurrentRequest(request)) return;
      setError(cause instanceof Error ? cause.message : "Unable to load more files");
    } finally {
      if (isCurrentRequest(request)) setLoadingMore(false);
    }
  }, [beginRequest, client, isCurrentRequest, loadingMore, nextCursor, search]);
  const images = items.filter((item) => item.mediaType.startsWith("image/"));
  const documents = items.filter((item) => !item.mediaType.startsWith("image/"));
  const visibleImages = images;
  const visibleDocuments = documents;
  const libraryImageViews = React.useMemo<GeneratedImageView[]>(() => images.map((item) => ({
    id: item.id,
    src: item.previewUrl,
    fileId: item.id,
    title: item.name.replace(/\.[^.]+$/, "") || "Generated image",
    aspectRatio: "1:1",
    mimeType: item.mediaType,
    sizeBytes: item.size,
    transparentBackground: false,
    downloadUrl: item.downloadUrl,
  })), [images]);

  return (
    <section className="berry-library-page" aria-labelledby="berry-library-title">
      <header className="berry-library-header">
        <div>
          <h1 id="berry-library-title">Library</h1>
          <p>Uploads and files saved from Berry sandboxes appear here automatically.</p>
        </div>
        <div className="berry-library-header-actions">
          <Button variant="ghost" size="icon-sm" onClick={() => void refresh()} disabled={state === "loading"} aria-label="Refresh files" title="Refresh files"><RefreshCw /></Button>
          <label className="berry-library-search">
            <Search aria-hidden="true" />
            <Input value={searchInput} onChange={(event) => setSearchInput(event.currentTarget.value)} placeholder="Search files" aria-label="Search files" />
          </label>
        </div>
      </header>

      <ProjectKnowledgePanel
        client={client}
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        onWorkspaceChange={onWorkspaceChange}
        onOpenFile={setSelected}
      />

      <div className="berry-library-tabs" role="tablist" aria-label="Library file type">
        <button type="button" role="tab" aria-selected={tab === "all"} onClick={() => onTabChange("all")}><Files /> All <span>{items.length}</span></button>
        <button type="button" role="tab" aria-selected={tab === "images"} onClick={() => onTabChange("images")}><FileImage /> Images <span>{images.length}</span></button>
        <button type="button" role="tab" aria-selected={tab === "documents"} onClick={() => onTabChange("documents")}><FileText /> Documents <span>{documents.length}</span></button>
      </div>

      {state === "loading" ? (
        <div className="berry-library-status" aria-live="polite" aria-busy="true">
          <CircularActivitySpinner size={28} label="Loading library" />
        </div>
      ) : null}
      {state === "error" ? <LibraryStatus title="The library could not be loaded" detail={error} action={<Button size="sm" onClick={() => void refresh()}>Try again</Button>} /> : null}
      {state === "ready" && items.length === 0 ? <LibraryStatus title={search ? "No matching files" : tab === "all" ? "No files yet" : tab === "images" ? "No images yet" : "No documents yet"} detail={search ? "Try a different file name or clear the search." : "Upload a file in chat or ask Berry to create one. It will show up here."} /> : null}

      {state === "ready" && (tab === "all" || tab === "images") && visibleImages.length > 0 ? (
        <div className="berry-library-image-grid">
          {visibleImages.map((item) => (
            <button type="button" key={item.id} className="berry-library-image-card" onClick={() => setSelected(item)}>
              <div className="berry-library-image-preview"><img src={item.previewUrl} alt={item.name} loading="lazy" /></div>
              <ArtifactMeta item={item} />
            </button>
          ))}
        </div>
      ) : null}

      {state === "ready" && (tab === "all" || tab === "documents") && visibleDocuments.length > 0 ? (
        <div className={`berry-library-document-list${tab === "all" && visibleImages.length > 0 ? " berry-library-all-documents" : ""}`}>
          {visibleDocuments.map((item) => (
            <button type="button" key={item.id} className="berry-library-document-row" onClick={() => setSelected(item)}>
              <span className="berry-library-file-icon"><FileTypeIcon path={item.name} className="size-10" /></span>
              <ArtifactMeta item={item} />
              <span className="berry-library-open">Open</span>
            </button>
          ))}
        </div>
      ) : null}
      {state === "ready" && nextCursor ? <Button className="berry-library-load-more" variant="outline" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? "Loading…" : "Load more files"}</Button> : null}
      {selected?.mediaType.startsWith("image/") ? (
        <GeneratedImageLightbox
          images={libraryImageViews}
          activeId={selected.id}
          onActiveIdChange={(id) => setSelected(id ? images.find((item) => item.id === id) ?? null : null)}
        />
      ) : (
        <DocumentPreviewModal file={selected} onOpenChange={(open) => { if (!open) setSelected(null); }} />
      )}
    </section>
  );
}

export function knowledgeStatusView(status: StoredFile["indexStatus"] | ProjectOutcome["status"]): {
  label: string;
  tone: "neutral" | "good" | "warning" | "danger";
} {
  if (status === "indexed") return { label: "Indexed", tone: "good" };
  if (status === "failed") return { label: "Failed", tone: "danger" };
  if (status === "extracting") return { label: "Extracting", tone: "warning" };
  if (status === "chunking") return { label: "Chunking", tone: "warning" };
  if (status === "embedding") return { label: "Embedding", tone: "warning" };
  if (status === "deleted") return { label: "Removed", tone: "neutral" };
  return { label: "Pending", tone: "neutral" };
}

function ProjectKnowledgePanel({
  client,
  workspaces,
  activeWorkspaceId,
  onWorkspaceChange,
  onOpenFile,
}: {
  client: BerryApiClient | null;
  workspaces: Workspace[];
  activeWorkspaceId: string;
  onWorkspaceChange: (workspaceId: string) => void;
  onOpenFile: (file: StoredFile) => void;
}) {
  const projects = workspaces.filter((workspace) => workspace.workspaceKind === "project");
  const workspace = projects.find((candidate) => candidate.id === activeWorkspaceId) ?? projects[0] ?? null;
  const [files, setFiles] = React.useState<StoredFile[]>([]);
  const [outcomes, setOutcomes] = React.useState<ProjectOutcome[]>([]);
  const [state, setState] = React.useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    if (!client || !workspace) {
      setFiles([]);
      setOutcomes([]);
      setState("ready");
      return;
    }
    setState("loading");
    setError("");
    try {
      const [filePage, indexedOutcomes] = await Promise.all([
        client.listProjectFiles(workspace.id, { limit: 100 }),
        client.listProjectOutcomes(workspace.id),
      ]);
      setFiles(filePage.items);
      setOutcomes(indexedOutcomes);
      setState("ready");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load project knowledge");
      setState("error");
    }
  }, [client, workspace]);

  React.useEffect(() => { void refresh(); }, [refresh]);

  const retry = async (file: StoredFile) => {
    if (!client || !workspace || busy) return;
    setBusy(file.id);
    try {
      await client.retryWorkspaceFile(workspace.id, file.id);
      setFiles((current) => current.map((item) => item.id === file.id
        ? { ...item, indexStatus: "pending", indexFailureReason: null }
        : item));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to retry indexing");
    } finally {
      setBusy(null);
    }
  };

  const unlink = async (file: StoredFile) => {
    if (!client || !workspace || busy) return;
    if (!window.confirm(`Remove ${file.name} from ${workspace.name} knowledge? The original file remains in your library.`)) return;
    setBusy(file.id);
    try {
      await client.unlinkWorkspaceFile(workspace.id, file.id);
      setFiles((current) => current.filter((item) => item.id !== file.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to remove this project file");
    } finally {
      setBusy(null);
    }
  };

  if (projects.length === 0) return null;
  return (
    <section className="project-knowledge" aria-labelledby="project-knowledge-title">
      <header className="project-knowledge-head">
        <div>
          <span>Shared context</span>
          <h2 id="project-knowledge-title">Project knowledge</h2>
          <p>Files and completed task outcomes available to every authorized chat in this project.</p>
        </div>
        <div className="project-knowledge-controls">
          <label>
            <span className="sr-only">Project</span>
            <select value={workspace?.id ?? ""} onChange={(event) => onWorkspaceChange(event.currentTarget.value)}>
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </label>
          <Button variant="ghost" size="icon-sm" aria-label="Refresh project knowledge" disabled={state === "loading"} onClick={() => void refresh()}><RefreshCw /></Button>
        </div>
      </header>
      {state === "loading" ? <div className="project-knowledge-state"><CircularActivitySpinner size={20} label="Loading project knowledge" /></div> : null}
      {state === "error" ? <div className="project-knowledge-state" role="alert"><AlertCircle /><span>{error}</span><Button size="sm" variant="outline" onClick={() => void refresh()}>Retry</Button></div> : null}
      {state === "ready" ? (
        <div className="project-knowledge-grid">
          <div className="project-knowledge-column">
            <div className="project-knowledge-subhead"><h3>Files</h3><span>{files.length}</span></div>
            {files.length === 0 ? <p className="project-knowledge-empty">No project-wide files have been linked yet.</p> : (
              <div className="project-knowledge-list">
                {files.map((file) => {
                  const status = knowledgeStatusView(file.indexStatus);
                  return (
                    <article key={file.id} className="project-knowledge-row">
                      <button type="button" className="project-knowledge-file" onClick={() => onOpenFile(file)}>
                        <FileTypeIcon path={file.name} className="size-8" />
                        <span><strong>{file.name}</strong><small>{file.workspaceVisibility === "task_only" ? "Task only" : "Project wide"} · {formatBytes(file.size)}</small></span>
                      </button>
                      <div className="project-knowledge-row-actions">
                        <KnowledgeBadge label={status.label} tone={status.tone} />
                        {file.indexStatus === "failed" ? <Button size="sm" variant="outline" disabled={busy === file.id} onClick={() => void retry(file)}>Retry</Button> : null}
                        <Button size="icon-sm" variant="ghost" aria-label={`Remove ${file.name} from project knowledge`} disabled={busy === file.id} onClick={() => void unlink(file)}><Trash2 /></Button>
                      </div>
                      {file.indexFailureReason ? <p className="project-knowledge-error">{file.indexFailureReason}</p> : null}
                    </article>
                  );
                })}
              </div>
            )}
          </div>
          <div className="project-knowledge-column">
            <div className="project-knowledge-subhead"><h3>Prior task outcomes</h3><span>{outcomes.length}</span></div>
            {outcomes.length === 0 ? <p className="project-knowledge-empty">Completed task outcomes will appear after indexing.</p> : (
              <div className="project-knowledge-list">
                {outcomes.map((outcome) => {
                  const status = knowledgeStatusView(outcome.status);
                  return (
                    <article key={outcome.sourceId} className="project-outcome-row">
                      <a href={`/tasks/${encodeURIComponent(outcome.taskId)}`}><strong>{outcome.title}</strong><small>Updated {new Date(outcome.updatedAt).toLocaleDateString()}</small></a>
                      <KnowledgeBadge label={status.label} tone={status.tone} />
                      {outcome.failureReason ? <p className="project-knowledge-error">{outcome.failureReason}</p> : null}
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function KnowledgeBadge({ label, tone }: ReturnType<typeof knowledgeStatusView>) {
  const Icon = tone === "good" ? Check : tone === "danger" ? AlertCircle : Clock;
  return <span className="project-knowledge-badge" data-tone={tone}><Icon />{label}</span>;
}

function useDebouncedValue(value: string, delayMs: number): string {
  const [debouncedValue, setDebouncedValue] = React.useState(value);
  React.useEffect(() => {
    const timeout = setTimeout(() => setDebouncedValue(value), delayMs);
    return () => clearTimeout(timeout);
  }, [delayMs, value]);
  return debouncedValue;
}

function ArtifactMeta({ item }: { item: StoredFile }) {
  return <span className="berry-library-meta"><strong title={item.name}>{item.name}</strong><small>{fileTypeLabel(item)} · {formatBytes(item.size)} · {new Date(item.createdAt).toLocaleDateString()}</small></span>;
}

function LibraryStatus({ title, detail, action }: { title: string; detail: string; action?: React.ReactNode }) {
  return <div className="berry-library-status"><FolderOpen /><strong>{title}</strong><p>{detail}</p>{action}</div>;
}
