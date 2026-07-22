import * as React from "react";
import type { StoredFile } from "@berry/shared";
import { Button } from "@berry/desktop-ui/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@berry/desktop-ui/components/ui/dialog";
import { FileDown, FileText, X } from "@berry/desktop-ui/lib/icons";
import { FileTypeIcon } from "@berry/desktop-ui/lib/file-icons";
import { PhotoProvider, PhotoView } from "react-photo-view";
import "react-photo-view/dist/react-photo-view.css";
import { isImageFile } from "./file-thumbnail";

const DocxDocumentViewer = React.lazy(() => import("./docx-document-viewer"));
const PdfDocumentViewer = React.lazy(() => import("./pdf-document-viewer"));
const PptxDocumentViewer = React.lazy(() => import("./pptx-document-viewer"));
const SpreadsheetDocumentViewer = React.lazy(() => import("./spreadsheet-document-viewer"));

const FlyfishViewer = React.lazy(async () => {
  const module = await import("@file-viewer/react-full");
  module.setDefaultFullAssetBaseUrl("/file-viewer/");
  return { default: module.FileViewer };
});

export function FileViewerModal({ file, onOpenChange }: { file: StoredFile | null; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={Boolean(file)} onOpenChange={onOpenChange}>
      <DialogContent className="berry-file-viewer-dialog h-[85vh] w-[80vw] max-w-[80vw] gap-0 overflow-hidden rounded-[18px] border-0 bg-[var(--berry-main-bg)] p-0" showCloseButton={false}>
        {file ? (
          <>
            <DialogHeader className="berry-file-viewer-header flex h-16 shrink-0 flex-row items-center gap-3 px-4 text-left">
              <span className="berry-file-viewer-icon"><FileTypeIcon path={file.name} className="size-10" /></span>
              <span className="min-w-0 flex-1">
                <DialogTitle className="truncate text-sm font-medium" title={file.name}>{file.name}</DialogTitle>
                <DialogDescription className="truncate text-xs">{fileTypeLabel(file)} · {formatBytes(file.size)}</DialogDescription>
              </span>
              <Button asChild variant="ghost" size="icon" className="berry-file-viewer-action" aria-label={`Download ${file.name}`}>
                <a href={file.downloadUrl} download={file.name}><FileDown /></a>
              </Button>
              <DialogClose asChild>
                <Button variant="ghost" size="icon" className="berry-file-viewer-action" aria-label="Close file viewer"><X /></Button>
              </DialogClose>
            </DialogHeader>
            <div className="berry-file-viewer-stage min-h-0 flex-1">
              {isImageFile(file) ? (
                <PhotoProvider maskOpacity={0.88}>
                  <PhotoView src={file.previewUrl}>
                    <button type="button" className="flex h-full w-full cursor-zoom-in items-center justify-center overflow-hidden bg-[var(--berry-main-bg)]" aria-label={`Open full-size preview of ${file.name}`}>
                      <img src={file.previewUrl} alt={file.name} className="max-h-full max-w-full object-contain" />
                    </button>
                  </PhotoView>
                </PhotoProvider>
              ) : isPdf(file) ? (
                <React.Suspense fallback={<FileViewerLoading name={file.name} />}>
                  <ViewerErrorBoundary key={file.id} file={file} fallback={<FlyfishFallback file={file} />}>
                    <PdfDocumentViewer src={file.previewUrl} name={file.name} />
                  </ViewerErrorBoundary>
                </React.Suspense>
              ) : isSpreadsheet(file) ? (
                <React.Suspense fallback={<FileViewerLoading name={file.name} />}>
                  <ViewerErrorBoundary key={file.id} file={file} fallback={<FlyfishFallback file={file} />}>
                    <SpreadsheetDocumentViewer file={file} />
                  </ViewerErrorBoundary>
                </React.Suspense>
              ) : isDocx(file) ? (
                <React.Suspense fallback={<FileViewerLoading name={file.name} />}>
                  <ViewerErrorBoundary key={file.id} file={file} fallback={<FlyfishFallback file={file} />}>
                    <DocxDocumentViewer file={file} />
                  </ViewerErrorBoundary>
                </React.Suspense>
              ) : isPptx(file) ? (
                <React.Suspense fallback={<FileViewerLoading name={file.name} />}>
                  <ViewerErrorBoundary key={file.id} file={file} fallback={<FlyfishFallback file={file} />}>
                    <PptxDocumentViewer file={file} />
                  </ViewerErrorBoundary>
                </React.Suspense>
              ) : (
                <React.Suspense fallback={<FileViewerLoading name={file.name} />}>
                  <ViewerErrorBoundary key={file.id} file={file}>
                    <FlyfishViewer
                      key={`${file.id}:${file.updatedAt}`}
                      className="h-full w-full"
                      url={file.previewUrl}
                      filename={file.name}
                      type={viewerType(file)}
                      size={file.size}
                      options={{
                        theme: "light",
                        styleIsolation: "shadow",
                        toolbar: { theme: false, download: false, position: "top-center" },
                      }}
                    />
                  </ViewerErrorBoundary>
                </React.Suspense>
              )}
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function FlyfishFallback({ file }: { file: StoredFile }) {
  return (
    <React.Suspense fallback={<FileViewerLoading name={file.name} />}>
      <ViewerErrorBoundary key={`fallback:${file.id}`} file={file}>
        <FlyfishViewer
          className="h-full w-full"
          url={file.previewUrl}
          filename={file.name}
          type={viewerType(file)}
          size={file.size}
          options={{ theme: "light", styleIsolation: "shadow", toolbar: { theme: false, download: false, position: "top-center" } }}
        />
      </ViewerErrorBoundary>
    </React.Suspense>
  );
}

class ViewerErrorBoundary extends React.Component<{ file: StoredFile; children: React.ReactNode; fallback?: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    if (this.props.fallback) return this.props.fallback;
    return (
      <div className="berry-file-viewer-loading" role="alert">
        <FileText />
        <strong>This file cannot be previewed in the browser</strong>
        <span>Download {this.props.file.name} to open it in its native app.</span>
        <Button asChild variant="outline"><a href={this.props.file.downloadUrl} download={this.props.file.name}><FileDown /> Download file</a></Button>
      </div>
    );
  }
}

function FileViewerLoading({ name }: { name: string }) {
  return <div className="berry-file-viewer-loading" role="status"><FileText /><strong>Opening {name}</strong><span>Loading the matching document renderer…</span></div>;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function fileTypeLabel(file: Pick<StoredFile, "name" | "mediaType">): string {
  const extension = file.name.split(".").at(-1)?.toUpperCase();
  if (extension && extension.length <= 8) return extension;
  if (file.mediaType.startsWith("image/")) return "Image";
  if (file.mediaType.startsWith("text/")) return "Text";
  return "File";
}

function viewerType(file: Pick<StoredFile, "name" | "mediaType">): string {
  const extension = file.name.split(".").at(-1)?.trim().toLowerCase();
  if (extension && /^[a-z0-9]{1,10}$/.test(extension)) return extension;
  return file.mediaType;
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
