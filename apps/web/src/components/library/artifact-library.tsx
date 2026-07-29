import * as React from "react";
import type { BerryApiClient } from "@berry/api-client";
import type { StoredFile, Workspace } from "@berry/shared";
import { Button } from "@berry/desktop-ui/components/ui/button";
import { CircularActivitySpinner } from "@berry/desktop-ui/components/ui/circular-activity-spinner";
import { Input } from "@berry/desktop-ui/components/ui/input";
import { FileImage, Files, FileText, FolderOpen, RefreshCw, Search } from "@berry/desktop-ui/lib/icons";
import { FileTypeIcon } from "@berry/desktop-ui/lib/file-icons";
import { GeneratedImageLightbox, type GeneratedImageView } from "@berry/desktop-ui/components/generated-image-gallery";
import type { ArtifactLibraryTab } from "@/lib/cloud-shell-state";
import { DocumentPreviewModal } from "./document-preview-modal";
import { fileTypeLabel, formatBytes } from "./file-metadata";

const LIBRARY_PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 220;

export function ArtifactLibrary({ client, tab, onTabChange, workspaces }: {
  client: BerryApiClient | null;
  tab: ArtifactLibraryTab;
  onTabChange: (tab: ArtifactLibraryTab) => void;
  workspaces: Workspace[];
}) {
  const projects = React.useMemo(() => projectFilterWorkspaces(workspaces), [workspaces]);
  const [selectedProjectId, setSelectedProjectId] = React.useState("");
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

  React.useEffect(() => {
    if (selectedProjectId && !projects.some((project) => project.id === selectedProjectId)) setSelectedProjectId("");
  }, [projects, selectedProjectId]);

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
      const page = await client.listFiles({ limit: LIBRARY_PAGE_SIZE, ...(selectedProjectId ? { workspaceId: selectedProjectId } : {}), ...(search ? { search } : {}) }, { signal: request.controller.signal });
      if (!isCurrentRequest(request)) return;
      setItems(page.items);
      setNextCursor(page.nextCursor);
      setState("ready");
    } catch (cause) {
      if (request.controller.signal.aborted || !isCurrentRequest(request)) return;
      setError(cause instanceof Error ? cause.message : "Unable to load the library");
      setState("error");
    }
  }, [beginRequest, client, isCurrentRequest, search, selectedProjectId]);

  React.useEffect(() => {
    void refresh();
    return () => requestRef.current?.controller.abort();
  }, [refresh]);

  const loadMore = React.useCallback(async () => {
    if (!client || !nextCursor || loadingMore) return;
    const request = beginRequest();
    setLoadingMore(true);
    try {
      const page = await client.listFiles({ cursor: nextCursor, limit: LIBRARY_PAGE_SIZE, ...(selectedProjectId ? { workspaceId: selectedProjectId } : {}), ...(search ? { search } : {}) }, { signal: request.controller.signal });
      if (!isCurrentRequest(request)) return;
      setItems((current) => [...current, ...page.items.filter((item) => !current.some((existing) => existing.id === item.id))]);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      if (request.controller.signal.aborted || !isCurrentRequest(request)) return;
      setError(cause instanceof Error ? cause.message : "Unable to load more files");
    } finally {
      if (isCurrentRequest(request)) setLoadingMore(false);
    }
  }, [beginRequest, client, isCurrentRequest, loadingMore, nextCursor, search, selectedProjectId]);
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
          {projects.length > 0 ? (
            <label className="berry-library-project-filter">
              <span className="sr-only">Filter files by project</span>
              <select
                value={selectedProjectId}
                onChange={(event) => {
                  setSelectedProjectId(event.currentTarget.value);
                }}
                aria-label="Filter files by project"
              >
                <option value="">All projects</option>
                {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
            </label>
          ) : null}
          <Button variant="ghost" size="icon-sm" onClick={() => void refresh()} disabled={state === "loading"} aria-label="Refresh files" title="Refresh files"><RefreshCw /></Button>
          <label className="berry-library-search">
            <Search aria-hidden="true" />
            <Input value={searchInput} onChange={(event) => setSearchInput(event.currentTarget.value)} placeholder="Search files" aria-label="Search files" />
          </label>
        </div>
      </header>

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

export function projectFilterWorkspaces(workspaces: readonly Workspace[]): Workspace[] {
  return workspaces.filter((workspace) => workspace.workspaceKind === "project");
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
