import * as React from "react";
import type { StoredFile } from "@berry/shared";
import { Button } from "@berry/desktop-ui/components/ui/button";
import { CircularActivitySpinner } from "@berry/desktop-ui/components/ui/circular-activity-spinner";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@berry/desktop-ui/components/ui/dialog";
import { FileDown, X } from "@berry/desktop-ui/lib/icons";
import { FileTypeIcon } from "@berry/desktop-ui/lib/file-icons";
import { PhotoProvider, PhotoView } from "react-photo-view";
import "react-photo-view/dist/react-photo-view.css";
import { fileTypeLabel, formatBytes } from "./file-metadata";
import { filePreviewDecision } from "./file-preview-policy";
import { DownloadOnlyPreview, OfficePreviewGate } from "./office-preview-gate";
import { readResponseBytes } from "./preview-stream";
import { assertImagePreviewBounds } from "./image-preview-bounds";

const DocxDocumentViewer = React.lazy(() => import("./docx-document-viewer"));
const PptxDocumentViewer = React.lazy(() => import("./pptx-document-viewer"));
const SpreadsheetDocumentViewer = React.lazy(() => import("./spreadsheet-document-viewer"));
const CodeDocumentViewer = React.lazy(() => import("./code-document-viewer"));

export function DocumentPreviewModal({ file, onOpenChange }: { file: StoredFile | null; onOpenChange: (open: boolean) => void }) {
  const previewDecision = file ? filePreviewDecision(file) : { kind: "unsupported" as const, allowed: false, reason: null, maxSourceBytes: null };
  const previewKind = previewDecision.kind;
  return (
    <Dialog open={Boolean(file)} onOpenChange={onOpenChange}>
      <DialogContent className="berry-document-preview-dialog !z-[60] !h-[85vh] !w-[80vw] !max-w-[80vw] gap-0 overflow-hidden rounded-[18px] border-0 bg-[var(--berry-main-bg)] p-0" showCloseButton={false}>
        {file ? (
          <>
            <DialogHeader className="berry-document-preview-header flex h-16 shrink-0 flex-row items-center gap-3 px-4 text-left">
              <span className="berry-document-preview-icon"><FileTypeIcon path={file.name} className="size-10" /></span>
              <span className="min-w-0 flex-1">
                <DialogTitle className="truncate text-sm font-medium" title={file.name}>{file.name}</DialogTitle>
                <DialogDescription className="truncate text-xs">{fileTypeLabel(file)} · {formatBytes(file.size)}</DialogDescription>
              </span>
              <Button asChild variant="ghost" size="icon" className="berry-document-preview-action" aria-label={`Download ${file.name}`}>
                <a href={file.downloadUrl} download={file.name}><FileDown /></a>
              </Button>
              <DialogClose asChild>
                <Button variant="ghost" size="icon" className="berry-document-preview-action" aria-label="Close preview"><X /></Button>
              </DialogClose>
            </DialogHeader>
            <div className="berry-document-preview-stage min-h-0 flex-1">
              {!previewDecision.allowed ? (
                <DownloadOnlyPreview file={file} reason={previewDecision.reason ?? "This file cannot be previewed safely in the browser."} />
              ) : previewKind === "image" ? (
                <AuthenticatedImagePreview file={file} decision={previewDecision} />
              ) : previewKind === "spreadsheet" ? (
                <React.Suspense fallback={<DocumentPreviewLoading name={file.name} />}>
                  <ViewerErrorBoundary key={file.id} file={file}>
                    <OfficePreviewGate key={file.id} file={file} kind="spreadsheet"><SpreadsheetDocumentViewer file={file} /></OfficePreviewGate>
                  </ViewerErrorBoundary>
                </React.Suspense>
              ) : previewKind === "docx" ? (
                <React.Suspense fallback={<DocumentPreviewLoading name={file.name} />}>
                  <ViewerErrorBoundary key={file.id} file={file}>
                    <OfficePreviewGate key={file.id} file={file} kind="docx"><DocxDocumentViewer file={file} /></OfficePreviewGate>
                  </ViewerErrorBoundary>
                </React.Suspense>
              ) : previewKind === "pptx" ? (
                <React.Suspense fallback={<DocumentPreviewLoading name={file.name} />}>
                  <ViewerErrorBoundary key={file.id} file={file}>
                    <OfficePreviewGate key={file.id} file={file} kind="pptx"><PptxDocumentViewer file={file} /></OfficePreviewGate>
                  </ViewerErrorBoundary>
                </React.Suspense>
              ) : previewKind === "code" ? (
                <React.Suspense fallback={<DocumentPreviewLoading name={file.name} />}>
                  <ViewerErrorBoundary key={file.id} file={file}>
                    <CodeDocumentViewer file={file} />
                  </ViewerErrorBoundary>
                </React.Suspense>
              ) : (
                <DownloadOnlyPreview file={file} reason="This file type is not safe to preview in the browser." />
              )}
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function AuthenticatedImagePreview({ file, decision }: { file: StoredFile; decision: ReturnType<typeof filePreviewDecision> }) {
  const [source, setSource] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      setError("Image preview timed out. Download the file to open it safely.");
      controller.abort();
    }, 15_000);
    let objectUrl: string | null = null;
    setSource(null);
    setError(null);
    void fetch(file.previewUrl, { credentials: "include", signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`File request failed (${response.status})`);
        return readResponseBytes(response, decision.maxSourceBytes ?? 25 * 1024 * 1024);
      })
      .then((bytes) => {
        clearTimeout(timeout);
        if (controller.signal.aborted) return;
        const imageBytes = new Uint8Array(bytes);
        assertImagePreviewBounds(imageBytes, file.mediaType);
        objectUrl = URL.createObjectURL(new Blob([imageBytes], { type: file.mediaType }));
        setSource(objectUrl);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      clearTimeout(timeout);
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [decision.maxSourceBytes, file.id, file.mediaType, file.previewUrl]);

  if (error) return <DownloadOnlyPreview file={file} reason="The image could not be fetched safely. Download the file to open it." />;
  if (!source) return <DocumentPreviewLoading name={file.name} />;
  return (
    <PhotoProvider maskOpacity={0.88}>
      <PhotoView src={source}>
        <button type="button" className="flex h-full w-full cursor-zoom-in items-center justify-center overflow-hidden bg-[var(--berry-main-bg)]" aria-label={`Open full-size preview of ${file.name}`}>
          <img
            src={source}
            alt={file.name}
            className="max-h-full max-w-full object-contain"
            onError={() => {
              setSource(null);
              setError("The image could not be decoded safely. Download the file to open it.");
            }}
          />
        </button>
      </PhotoView>
    </PhotoProvider>
  );
}

class ViewerErrorBoundary extends React.Component<{ file: StoredFile; children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <DownloadOnlyPreview file={this.props.file} reason="The preview failed safely. Download the file to open it." />;
  }
}

function DocumentPreviewLoading({ name }: { name: string }) {
  return <div className="berry-document-preview-loading" role="status" aria-live="polite" aria-busy="true"><CircularActivitySpinner size={28} label={`Opening ${name}`} /></div>;
}
