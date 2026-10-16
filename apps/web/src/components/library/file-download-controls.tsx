import * as React from "react";
import type { StoredFile } from "@berry/shared";
import { Button } from "@berry/desktop-ui/components/ui/button";
import { Progress } from "@berry/desktop-ui/components/ui/progress";
import { FileDown } from "@berry/desktop-ui/lib/icons";
import { formatBytes } from "./file-metadata";
import { transferDownload, MAX_BUFFERED_DOWNLOAD_BYTES, type DownloadProgress } from "./file-download";

type State = { phase: "idle" | "starting" | "downloading" | "done" | "cancelled" | "error"; progress?: DownloadProgress; message?: string };
type Download = { state: State; busy: boolean; start(): void; cancel(): void };
const DownloadContext = React.createContext<Download | null>(null);

export function FileDownloadProvider({ file, children }: { file: StoredFile; children: React.ReactNode }) {
  const [state, setState] = React.useState<State>({ phase: "idle" });
  const active = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => { active.current?.abort(); active.current = null; }, []);
  const start = async () => {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    const update = (next: State) => { if (active.current === controller) setState(next); };
    update({ phase: "starting" });
    try {
      if (file.size > MAX_BUFFERED_DOWNLOAD_BYTES) {
        const anchor = document.createElement("a");
        anchor.href = file.downloadUrl; anchor.download = file.name;
        document.body.append(anchor); anchor.click(); anchor.remove();
        update({ phase: "done", message: "Download started. Track progress in your browser’s downloads." });
        return;
      }
      const blob = await transferDownload({
        url: file.downloadUrl, size: file.size, signal: controller.signal, resolveStorageUrl: true,
        onProgress: (progress) => update({ phase: "downloading", progress }),
      });
      controller.signal.throwIfAborted();
      if (blob) {
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url; anchor.download = file.name;
        document.body.append(anchor); anchor.click(); anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
      update({ phase: "done", message: "Download ready. Check your browser’s downloads." });
    } catch (error) {
      const cancelled = controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
      update({ phase: cancelled ? "cancelled" : "error", message: cancelled ? "Download cancelled." : error instanceof Error ? error.message : "Download failed. Please retry." });
    } finally { if (active.current === controller) active.current = null; }
  };
  return <DownloadContext.Provider value={{ state, busy: state.phase === "starting" || state.phase === "downloading", start: () => void start(), cancel: () => active.current?.abort() }}>{children}</DownloadContext.Provider>;
}

export function FileDownloadButton({ file, compact = false }: { file: StoredFile; compact?: boolean }) {
  const download = React.useContext(DownloadContext);
  if (!download) return <Button asChild variant="outline"><a href={file.downloadUrl} download={file.name}><FileDown /> Download file</a></Button>;
  return <Button variant={compact ? "ghost" : "outline"} size={compact ? "icon" : "default"} disabled={download.busy} onClick={download.start} aria-label={`Download ${file.name}`}>
    <FileDown />{!compact && (download.busy ? "Downloading…" : download.state.phase === "error" ? "Retry download" : "Download file")}
  </Button>;
}

export function FileDownloadStatus({ file }: { file: StoredFile }) {
  const download = React.useContext(DownloadContext);
  if (!download || download.state.phase === "idle") return null;
  const { state, busy } = download;
  const progress = state.progress;
  const percent = progress?.total ? Math.min(100, Math.floor(progress.received / progress.total * 100)) : null;
  return <div className="shrink-0 border-b border-[var(--berry-border)] px-4 py-3 text-xs text-[var(--berry-text-secondary)]">
    <div className="flex items-center justify-between gap-3">
      <span role={state.phase === "error" ? "alert" : "status"} aria-live="polite">
        {state.phase === "starting" ? "Preparing download…" : state.phase === "downloading" && progress
          ? `${formatBytes(progress.received)}${progress.total ? ` of ${formatBytes(progress.total)} · ${percent}%` : ""} · ${formatBytes(Math.round(progress.bytesPerSecond))}/s`
          : state.message}
      </span>
      {busy && <Button variant="ghost" size="sm" onClick={download.cancel}>Cancel</Button>}
      {state.phase === "error" && <Button variant="ghost" size="sm" onClick={download.start}>Retry</Button>}
    </div>
    {busy && percent !== null && <Progress className="mt-2 h-1 [&_[data-slot=progress-indicator]]:motion-reduce:transition-none" value={percent} aria-label="File download progress" />}
    {state.phase === "error" && <a className="mt-2 inline-block underline" href={file.downloadUrl} download={file.name}>Use browser download</a>}
  </div>;
}
