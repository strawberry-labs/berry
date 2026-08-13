import * as React from "react";
import type { Workspace } from "@berry/shared";
import { Button } from "@berry/desktop-ui/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@berry/desktop-ui/components/ui/dialog";
import { Progress } from "@berry/desktop-ui/components/ui/progress";
import { ArrowUp as Upload, Check, FileText } from "@berry/desktop-ui/lib/icons";

interface ProjectUploadItem {
  id: string;
  file: File;
  progress: number;
  state: "uploading" | "complete" | "error";
  error?: string;
}

const PROJECT_UPLOAD_CONCURRENCY = 3;
const PROJECT_UPLOAD_MAX_FILES = 100;

async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      if (item) await run(item);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
}

export function ProjectUploadDialog({ open, workspace, onOpenChange, onUpload }: {
  open: boolean;
  workspace: Workspace;
  onOpenChange: (open: boolean) => void;
  onUpload: (workspace: Workspace, file: File, onProgress: (ratio: number) => void) => Promise<void>;
}) {
  const [items, setItems] = React.useState<ProjectUploadItem[]>([]);
  const [dragActive, setDragActive] = React.useState(false);
  const [selectionError, setSelectionError] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);
  const uploadLockRef = React.useRef(false);
  const uploading = items.some((item) => item.state === "uploading");

  React.useEffect(() => {
    if (open) {
      setItems([]);
      setSelectionError("");
      uploadLockRef.current = false;
    }
  }, [open]);

  const addFiles = React.useCallback((files: FileList | readonly File[] | null) => {
    if (!files?.length || uploadLockRef.current) return;
    const selected = Array.from(files);
    if (items.length + selected.length > PROJECT_UPLOAD_MAX_FILES) {
      setSelectionError(`Choose no more than ${PROJECT_UPLOAD_MAX_FILES} files per upload session.`);
      if (inputRef.current) inputRef.current.value = "";
      return;
    }
    setSelectionError("");
    uploadLockRef.current = true;
    const queued = selected.map((file): ProjectUploadItem => ({
      id: globalThis.crypto.randomUUID(),
      file,
      progress: 0,
      state: "uploading",
    }));
    setItems((current) => [...current, ...queued]);
    void runWithConcurrency(queued, PROJECT_UPLOAD_CONCURRENCY, async (item) => {
      try {
        await onUpload(workspace, item.file, (ratio) => {
          setItems((current) => current.map((candidate) => candidate.id === item.id
            ? { ...candidate, progress: Math.max(0, Math.min(1, ratio)) }
            : candidate));
        });
        setItems((current) => current.map((candidate) => candidate.id === item.id
          ? { ...candidate, progress: 1, state: "complete" }
          : candidate));
      } catch (cause) {
        setItems((current) => current.map((candidate) => candidate.id === item.id
          ? { ...candidate, state: "error", error: cause instanceof Error ? cause.message : "Upload failed" }
          : candidate));
      }
    }).finally(() => {
      uploadLockRef.current = false;
    });
    if (inputRef.current) inputRef.current.value = "";
  }, [items.length, onUpload, workspace]);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!uploading || next) onOpenChange(next); }}>
      <DialogContent className="overflow-hidden p-0 sm:max-w-lg" showCloseButton={!uploading}>
        <DialogHeader className="px-5 pt-5">
          <DialogTitle>Upload to {workspace.name}</DialogTitle>
          <DialogDescription>Files are saved in this project&apos;s Library and are available to every task in the project.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 px-5">
          <input
            ref={inputRef}
            id={`project-upload-${workspace.id}`}
            className="visually-hidden"
            type="file"
            multiple
            disabled={uploading}
            tabIndex={-1}
            onChange={(event) => addFiles(event.currentTarget.files)}
          />
          <label
            htmlFor={`project-upload-${workspace.id}`}
            className="flex min-h-36 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-[var(--berry-border-strong)] bg-[var(--berry-surface-under)] px-5 text-center transition-[background-color,border-color,transform] active:scale-[0.99] data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-60 data-[disabled=true]:active:scale-100"
            data-drag-active={dragActive ? "true" : "false"}
            data-disabled={uploading ? "true" : "false"}
            aria-disabled={uploading}
            onDragEnter={(event) => { event.preventDefault(); if (!uploading) setDragActive(true); }}
            onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = uploading ? "none" : "copy"; }}
            onDragLeave={(event) => { if (event.currentTarget === event.target) setDragActive(false); }}
            onDrop={(event) => {
              event.preventDefault();
              setDragActive(false);
              if (!uploading) addFiles(event.dataTransfer.files);
            }}
          >
            <span className="flex size-10 items-center justify-center rounded-full bg-[var(--berry-control-bg)] text-[var(--berry-text-secondary)] shadow-[var(--berry-ring-subtle)]"><Upload /></span>
            <strong className="text-sm">Drop files here or choose files</strong>
            <span className="text-xs text-[var(--berry-text-tertiary)]">You can upload more than one file at a time.</span>
          </label>

          {selectionError ? <p className="text-xs text-destructive" role="alert">{selectionError}</p> : null}

          {items.length > 0 ? (
            <div className="flex max-h-56 flex-col gap-2 overflow-y-auto pr-1" aria-live="polite">
              {items.map((item) => (
                <div key={item.id} className="flex min-w-0 items-center gap-3 rounded-lg bg-[var(--berry-surface-under)] px-3 py-2 shadow-[var(--berry-ring-subtle)]">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--berry-control-bg)] text-[var(--berry-text-secondary)]">
                    {item.state === "complete" ? <Check /> : <FileText />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <strong className="block truncate text-xs font-medium">{item.file.name}</strong>
                    {item.state === "uploading" ? <Progress className="mt-1.5 h-1" value={item.progress * 100} aria-label={`${item.file.name} upload progress`} /> : null}
                    {item.state === "complete" ? <span className="block text-[11px] text-[var(--berry-text-tertiary)]">Added to Library</span> : null}
                    {item.state === "error" ? <span className="block text-[11px] text-destructive">{item.error}</span> : null}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <DialogFooter className="border-t border-[var(--berry-border)] px-5 py-4">
          <DialogClose asChild><Button variant="outline" disabled={uploading}>{uploading ? "Uploading…" : "Close"}</Button></DialogClose>
          <Button onClick={() => inputRef.current?.click()} disabled={uploading}><Upload />Choose files</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
