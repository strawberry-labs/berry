import * as React from "react";
import type { BerryApiClient } from "@berry/api-client";
import type { StoredFile } from "@berry/shared";
import { Button } from "@berry/desktop-ui/components/ui/button";
import { FileImage, FileText, FolderOpen, RefreshCw } from "@berry/desktop-ui/lib/icons";
import { FileTypeIcon } from "@berry/desktop-ui/lib/file-icons";
import type { ArtifactLibraryTab } from "@/lib/cloud-shell-state";
import { DocumentPreviewModal } from "./document-preview-modal";
import { fileTypeLabel, formatBytes } from "./file-metadata";

export function ArtifactLibrary({ client, tab, onTabChange }: {
  client: BerryApiClient | null;
  tab: ArtifactLibraryTab;
  onTabChange: (tab: ArtifactLibraryTab) => void;
}) {
  const [items, setItems] = React.useState<StoredFile[]>([]);
  const [selected, setSelected] = React.useState<StoredFile | null>(null);
  const [nextCursor, setNextCursor] = React.useState<string | null>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [state, setState] = React.useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = React.useState("");

  const refresh = React.useCallback(async () => {
    if (!client) {
      setItems([]);
      setState("ready");
      return;
    }
    setState("loading");
    setError("");
    try {
      const page = await client.listFiles({ limit: 100 });
      setItems(page.items);
      setNextCursor(page.nextCursor);
      setState("ready");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load the library");
      setState("error");
    }
  }, [client]);

  React.useEffect(() => { void refresh(); }, [refresh]);
  const loadMore = React.useCallback(async () => {
    if (!client || !nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await client.listFiles({ cursor: nextCursor, limit: 100 });
      setItems((current) => [...current, ...page.items.filter((item) => !current.some((existing) => existing.id === item.id))]);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load more files");
    } finally {
      setLoadingMore(false);
    }
  }, [client, loadingMore, nextCursor]);
  const images = items.filter((item) => item.mediaType.startsWith("image/"));
  const documents = items.filter((item) => !item.mediaType.startsWith("image/"));
  const visible = tab === "images" ? images : documents;

  return (
    <section className="berry-library-page" aria-labelledby="berry-library-title">
      <header className="berry-library-header">
        <div>
          <div className="berry-library-eyebrow"><FolderOpen /> Library</div>
          <h1 id="berry-library-title">Your files, ready to reuse.</h1>
          <p>Uploads and files saved from Berry sandboxes appear here automatically.</p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={state === "loading"}><RefreshCw /> Refresh</Button>
      </header>

      <div className="berry-library-tabs" role="tablist" aria-label="Library file type">
        <button type="button" role="tab" aria-selected={tab === "images"} onClick={() => onTabChange("images")}><FileImage /> Images <span>{images.length}</span></button>
        <button type="button" role="tab" aria-selected={tab === "documents"} onClick={() => onTabChange("documents")}><FileText /> Documents <span>{documents.length}</span></button>
      </div>

      {state === "loading" ? <LibraryStatus title="Loading your library…" detail="Checking durable artifact storage." /> : null}
      {state === "error" ? <LibraryStatus title="The library could not be loaded" detail={error} action={<Button size="sm" onClick={() => void refresh()}>Try again</Button>} /> : null}
      {state === "ready" && visible.length === 0 ? <LibraryStatus title={tab === "images" ? "No images yet" : "No documents yet"} detail="Upload a file in chat or ask Berry to create one. It will show up here." /> : null}

      {state === "ready" && tab === "images" && visible.length > 0 ? (
        <div className="berry-library-image-grid">
          {visible.map((item) => (
            <button type="button" key={item.id} className="berry-library-image-card" onClick={() => setSelected(item)}>
              <div className="berry-library-image-preview"><img src={item.previewUrl} alt="" loading="lazy" /></div>
              <ArtifactMeta item={item} />
            </button>
          ))}
        </div>
      ) : null}

      {state === "ready" && tab === "documents" && visible.length > 0 ? (
        <div className="berry-library-document-list">
          {visible.map((item) => (
            <button type="button" key={item.id} className="berry-library-document-row" onClick={() => setSelected(item)}>
              <span className="berry-library-file-icon"><FileTypeIcon path={item.name} className="size-10" /></span>
              <ArtifactMeta item={item} />
              <span className="berry-library-open">Open</span>
            </button>
          ))}
        </div>
      ) : null}
      {state === "ready" && nextCursor ? <Button className="berry-library-load-more" variant="outline" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? "Loading…" : "Load more files"}</Button> : null}
      <DocumentPreviewModal file={selected} onOpenChange={(open) => { if (!open) setSelected(null); }} />
    </section>
  );
}

function ArtifactMeta({ item }: { item: StoredFile }) {
  return <span className="berry-library-meta"><strong title={item.name}>{item.name}</strong><small>{fileTypeLabel(item)} · {formatBytes(item.size)} · {new Date(item.createdAt).toLocaleDateString()}</small></span>;
}

function LibraryStatus({ title, detail, action }: { title: string; detail: string; action?: React.ReactNode }) {
  return <div className="berry-library-status"><FolderOpen /><strong>{title}</strong><p>{detail}</p>{action}</div>;
}
