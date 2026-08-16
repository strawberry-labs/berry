import * as React from "react";
import type { StoredFile } from "@berry/shared";
import { CircularActivitySpinner } from "@berry/desktop-ui/components/ui/circular-activity-spinner";
import { FileDown, FileText } from "@berry/desktop-ui/lib/icons";
import { Button } from "@berry/desktop-ui/components/ui/button";
import { filePreviewDecision, PREVIEW_LIMITS, type FilePreviewKind } from "./file-preview-policy";
import type { OfficePreviewKind, OfficePreviewWorkerRequest, OfficePreviewWorkerResponse } from "./office-preview-types";

const OfficePreviewBytesContext = React.createContext<ArrayBuffer | null>(null);

export function useOfficePreviewBytes(): ArrayBuffer | null {
  return React.useContext(OfficePreviewBytesContext);
}

export function OfficePreviewGate({ file, kind, children }: { file: StoredFile; kind: Extract<FilePreviewKind, "docx" | "pptx" | "spreadsheet">; children: React.ReactNode }) {
  const decision = filePreviewDecision(file);
  const inspectionKey = `${file.id}:${kind}:${file.previewUrl}`;
  const [status, setStatus] = React.useState<"loading" | "ready" | "error">(decision.allowed ? "loading" : "error");
  const [reason, setReason] = React.useState<string | null>(decision.reason);
  const [readyKey, setReadyKey] = React.useState<string | null>(null);
  const [previewBytes, setPreviewBytes] = React.useState<ArrayBuffer | null>(null);

  React.useEffect(() => {
    if (!decision.allowed || !isOfficeKind(kind)) {
      setPreviewBytes(null);
      setReadyKey(null);
      setStatus("error");
      setReason(decision.reason ?? "This file cannot be previewed safely.");
      return;
    }
    // XLS/CSV/TSV are not ZIP containers; their spreadsheet worker applies
    // the source, sheet, row, column, and cell budgets directly.
    if (!requiresArchiveInspection(kind)) {
      setPreviewBytes(null);
      setReadyKey(inspectionKey);
      setStatus("ready");
      setReason(null);
      return;
    }

    let cancelled = false;
    let worker: Worker | null = null;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (nextStatus: "ready" | "error", nextReason: string | null, bytes: ArrayBuffer | null = null) => {
      if (cancelled) return;
      cancelled = true;
      if (timeout) clearTimeout(timeout);
      worker?.terminate();
      worker = null;
      setPreviewBytes(bytes);
      setReadyKey(nextStatus === "ready" ? inspectionKey : null);
      setStatus(nextStatus);
      setReason(nextReason);
    };
    setStatus("loading");
    setReason(null);
    setPreviewBytes(null);
    setReadyKey(null);
    try {
      worker = new Worker(new URL("./office-preview.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<OfficePreviewWorkerResponse>) => {
        if (cancelled) return;
        if (event.data.type === "error") {
          finish("error", event.data.message);
        } else {
          finish("ready", null, event.data.bytes);
        }
      };
      worker.onerror = () => {
        finish("error", "This file could not be inspected safely for browser preview.");
      };
      const request: OfficePreviewWorkerRequest = {
        type: "inspect",
        url: file.previewUrl,
        kind: kind as OfficePreviewKind,
        sourceBytes: file.size,
        maxSourceBytes: decision.maxSourceBytes ?? PREVIEW_LIMITS.officeBytes,
        maxExpandedBytes: kind === "docx" ? PREVIEW_LIMITS.docxExpandedBytes : kind === "spreadsheet" ? PREVIEW_LIMITS.spreadsheetExpandedBytes : PREVIEW_LIMITS.archiveExpandedBytes,
        maxEntryCount: PREVIEW_LIMITS.archiveEntryCount,
        maxEntryBytes: kind === "docx" ? PREVIEW_LIMITS.docxEntryBytes : kind === "spreadsheet" ? PREVIEW_LIMITS.spreadsheetEntryBytes : PREVIEW_LIMITS.archiveEntryBytes,
        maxSlides: PREVIEW_LIMITS.maxSlides,
      maxPages: PREVIEW_LIMITS.maxPages,
      };
      worker.postMessage(request);
      timeout = setTimeout(() => {
        finish("error", "Preview inspection timed out. Download the file to open it safely.");
      }, 15_000);
    } catch {
      finish("error", "This file could not be inspected safely for browser preview.");
    }

    return () => {
      cancelled = true;
      if (timeout) clearTimeout(timeout);
      worker?.terminate();
      worker = null;
    };
  }, [decision.allowed, decision.maxSourceBytes, decision.reason, file.id, file.name, file.previewUrl, file.size, inspectionKey, kind]);

  if (status === "ready" && readyKey === inspectionKey) return <OfficePreviewBytesContext.Provider value={previewBytes}>{children}</OfficePreviewBytesContext.Provider>;
  if (status === "loading") return <div className="berry-document-preview-loading" role="status" aria-live="polite" aria-busy="true"><CircularActivitySpinner size={28} label={`Checking ${file.name}`} /></div>;
  return <DownloadOnlyPreview file={file} reason={reason ?? "This file cannot be previewed safely in the browser."} />;
}

export function DownloadOnlyPreview({ file, reason }: { file: StoredFile; reason: string }) {
  return (
    <div className="berry-document-preview-loading" role="alert">
      <FileText />
      <strong>This file is download-only</strong>
      <span>{reason}</span>
      <Button asChild variant="outline"><a href={file.downloadUrl} download={file.name}><FileDown /> Download file</a></Button>
    </div>
  );
}

function isOfficeKind(kind: FilePreviewKind): kind is OfficePreviewKind {
  return kind === "docx" || kind === "pptx" || kind === "spreadsheet";
}

function requiresArchiveInspection(kind: OfficePreviewKind): boolean {
  if (kind === "docx" || kind === "pptx") return true;
  // The spreadsheet worker owns its ZIP inspection and consumes the bounded
  // workbook window directly; running the archive gate as well would fetch
  // and inflate the same workbook twice.
  return false;
}
