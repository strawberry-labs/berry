import * as React from "react";
import type { StoredFile } from "@berry/shared";
import { Button } from "@berry/desktop-ui/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@berry/desktop-ui/components/ui/dialog";
import { FileDown, FileText, X } from "@berry/desktop-ui/lib/icons";
import { FileTypeIcon } from "@berry/desktop-ui/lib/file-icons";
import { PhotoProvider, PhotoView } from "react-photo-view";
import "react-photo-view/dist/react-photo-view.css";
import { isImageFile } from "./file-thumbnail";
import { fileTypeLabel, formatBytes } from "./file-metadata";

const DocxDocumentViewer = React.lazy(() => import("./docx-document-viewer"));
const PdfDocumentViewer = React.lazy(() => import("./pdf-document-viewer"));
const PptxDocumentViewer = React.lazy(() => import("./pptx-document-viewer"));
const SpreadsheetDocumentViewer = React.lazy(() => import("./spreadsheet-document-viewer"));
const CodeDocumentViewer = React.lazy(() => import("./code-document-viewer"));

export function DocumentPreviewModal({ file, onOpenChange }: { file: StoredFile | null; onOpenChange: (open: boolean) => void }) {
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
              {isImageFile(file) ? (
                <PhotoProvider maskOpacity={0.88}>
                  <PhotoView src={file.previewUrl}>
                    <button type="button" className="flex h-full w-full cursor-zoom-in items-center justify-center overflow-hidden bg-[var(--berry-main-bg)]" aria-label={`Open full-size preview of ${file.name}`}>
                      <img src={file.previewUrl} alt={file.name} className="max-h-full max-w-full object-contain" />
                    </button>
                  </PhotoView>
                </PhotoProvider>
              ) : isPdf(file) ? (
                <React.Suspense fallback={<DocumentPreviewLoading name={file.name} />}>
                  <ViewerErrorBoundary key={file.id} file={file}>
                    <PdfDocumentViewer src={file.previewUrl} name={file.name} />
                  </ViewerErrorBoundary>
                </React.Suspense>
              ) : isSpreadsheet(file) ? (
                <React.Suspense fallback={<DocumentPreviewLoading name={file.name} />}>
                  <ViewerErrorBoundary key={file.id} file={file}>
                    <SpreadsheetDocumentViewer file={file} />
                  </ViewerErrorBoundary>
                </React.Suspense>
              ) : isDocx(file) ? (
                <React.Suspense fallback={<DocumentPreviewLoading name={file.name} />}>
                  <ViewerErrorBoundary key={file.id} file={file}>
                    <DocxDocumentViewer file={file} />
                  </ViewerErrorBoundary>
                </React.Suspense>
              ) : isPptx(file) ? (
                <React.Suspense fallback={<DocumentPreviewLoading name={file.name} />}>
                  <ViewerErrorBoundary key={file.id} file={file}>
                    <PptxDocumentViewer file={file} />
                  </ViewerErrorBoundary>
                </React.Suspense>
              ) : isCodeFile(file) ? (
                <React.Suspense fallback={<DocumentPreviewLoading name={file.name} />}>
                  <ViewerErrorBoundary key={file.id} file={file}>
                    <CodeDocumentViewer file={file} />
                  </ViewerErrorBoundary>
                </React.Suspense>
              ) : (
                <UnsupportedFile file={file} />
              )}
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

class ViewerErrorBoundary extends React.Component<{ file: StoredFile; children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <UnsupportedFile file={this.props.file} />;
  }
}

function DocumentPreviewLoading({ name }: { name: string }) {
  return <div className="berry-document-preview-loading" role="status"><FileText /><strong>Opening {name}</strong><span>Loading the matching document renderer…</span></div>;
}

function isPdf(file: Pick<StoredFile, "name" | "mediaType">): boolean {
  return file.mediaType.toLowerCase().replace(/^\./, "") === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

function isSpreadsheet(file: Pick<StoredFile, "name">): boolean {
  const extension = file.name.split(".").at(-1)?.trim().toLowerCase();
  return Boolean(extension && ["xlsx", "xls", "csv", "tsv"].includes(extension));
}

function isDocx(file: Pick<StoredFile, "name">): boolean {
  return file.name.toLowerCase().endsWith(".docx");
}

function isPptx(file: Pick<StoredFile, "name">): boolean {
  return file.name.toLowerCase().endsWith(".pptx");
}

function isCodeFile(file: Pick<StoredFile, "name" | "mediaType">): boolean {
  if (file.mediaType.startsWith("text/")) return true;
  if (["application/json", "application/ld+json", "application/javascript", "application/sql", "application/xml", "application/x-yaml"].includes(file.mediaType.toLowerCase())) return true;
  return /(?:^|\.)(?:c|cc|cpp|cs|css|cts|cxx|dockerfile|env|go|h|hpp|html|ini|java|js|json|jsonc|jsx|md|mdx|mjs|php|py|pyi|rb|rs|scss|sh|sql|svg|toml|ts|tsx|txt|xml|ya?ml|zsh)$/i.test(file.name);
}

function UnsupportedFile({ file }: { file: StoredFile }) {
  return (
    <div className="berry-document-preview-loading" role="alert">
      <FileText />
      <strong>This file cannot be previewed in the browser</strong>
      <span>Download {file.name} to open it in its native app.</span>
      <Button asChild variant="outline"><a href={file.downloadUrl} download={file.name}><FileDown /> Download file</a></Button>
    </div>
  );
}
