import * as React from "react";
import type { StoredFile } from "@berry/shared";
import { CircularActivitySpinner } from "@berry/desktop-ui/components/ui/circular-activity-spinner";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { filePreviewDecision, PREVIEW_LIMITS } from "./file-preview-policy";
import { readResponseBytes } from "./preview-stream";

// Keep PDF.js on its own worker and never use a browser/plugin iframe. This
// also prevents embedded PDF JavaScript from being evaluated by the viewer.
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const PDF_PREVIEW_TIMEOUT_MS = 30_000;

export default function PdfDocumentViewer({ file }: { file: StoredFile }) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<Error | null>(null);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const controller = new AbortController();
    let disposed = false;
    let timedOut = false;
    let loadingTask: pdfjsLib.PDFDocumentLoadingTask | null = null;
    let documentProxy: pdfjsLib.PDFDocumentProxy | null = null;
    let activeRenderTask: pdfjsLib.RenderTask | null = null;
    const timeout = setTimeout(() => {
      timedOut = true;
      setError(new Error("PDF preview timed out. Download the file to open it safely."));
      controller.abort();
      activeRenderTask?.cancel();
      void destroyPdfResources(loadingTask, documentProxy).catch(() => undefined);
    }, PDF_PREVIEW_TIMEOUT_MS);

    setLoading(true);
    setError(null);
    container.replaceChildren();

    const render = async (): Promise<void> => {
      const decision = filePreviewDecision(file);
      if (!decision.allowed || decision.kind !== "pdf") {
        throw new Error(decision.reason ?? "This PDF cannot be previewed safely.");
      }

      const response = await fetch(file.previewUrl, { credentials: "include", signal: controller.signal });
      if (!response.ok) throw new Error(`File request failed (${response.status})`);
      const buffer = await readResponseBytes(response, decision.maxSourceBytes ?? PREVIEW_LIMITS.pdfBytes);
      if (controller.signal.aborted || disposed) return;

      loadingTask = pdfjsLib.getDocument({
        data: new Uint8Array(buffer),
        isEvalSupported: false,
        enableXfa: false,
        maxImageSize: PREVIEW_LIMITS.maxImagePixels,
      });
      documentProxy = await loadingTask.promise;
      if (documentProxy.numPages > PREVIEW_LIMITS.maxPages) {
        throw new Error(`This PDF has more than ${PREVIEW_LIMITS.maxPages} pages and is download-only for safety.`);
      }

      const pageWidth = Math.max(320, Math.min((container.clientWidth || 1_024) - 48, 1_200));
      for (let pageNumber = 1; pageNumber <= documentProxy.numPages; pageNumber += 1) {
        if (controller.signal.aborted || disposed) return;
        const page = await documentProxy.getPage(pageNumber);
        const baseViewport = page.getViewport({ scale: 1 });
        if (!Number.isFinite(baseViewport.width) || !Number.isFinite(baseViewport.height) || baseViewport.width <= 0 || baseViewport.height <= 0) {
          throw new Error("This PDF contains an invalid page size.");
        }

        const fitScale = pageWidth / baseViewport.width;
        const pixelScale = Math.sqrt(PREVIEW_LIMITS.pdfPagePixels / (baseViewport.width * baseViewport.height));
        const scale = Math.min(fitScale, pixelScale);
        if (!Number.isFinite(scale) || scale <= 0) throw new Error("This PDF page is too large to preview safely.");
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.ceil(viewport.width));
        canvas.height = Math.max(1, Math.ceil(viewport.height));
        canvas.setAttribute("aria-label", `Page ${pageNumber} of ${documentProxy.numPages}`);

        const context = canvas.getContext("2d", { alpha: false });
        if (!context) throw new Error("The browser could not create a PDF preview surface.");
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        activeRenderTask = page.render({ canvas, canvasContext: context, viewport, background: "#ffffff" });
        await activeRenderTask.promise;
        activeRenderTask = null;
        if (controller.signal.aborted || disposed) return;

        const frame = document.createElement("figure");
        frame.className = "berry-pdf-page";
        frame.dataset.pageNumber = String(pageNumber);
        frame.append(canvas);
        const caption = document.createElement("figcaption");
        caption.className = "berry-pdf-page-label";
        caption.textContent = `Page ${pageNumber} of ${documentProxy.numPages}`;
        frame.append(caption);
        container.append(frame);
      }
    };

    void render()
      .then(() => {
        if (!disposed && !controller.signal.aborted) setLoading(false);
      })
      .catch((cause: unknown) => {
        if (!disposed && !controller.signal.aborted && !timedOut) {
          setError(cause instanceof Error ? cause : new Error(String(cause)));
          setLoading(false);
        }
      });

    return () => {
      disposed = true;
      clearTimeout(timeout);
      controller.abort();
      activeRenderTask?.cancel();
      void destroyPdfResources(loadingTask, documentProxy).catch(() => undefined);
      container.replaceChildren();
    };
  }, [file.id, file.previewUrl]);

  if (error) throw error;

  return (
    <div className="berry-pdf-viewer" aria-label={`Preview of ${file.name}`}>
      <div ref={containerRef} className="berry-pdf-canvas" />
      {loading ? <DocumentLoading /> : null}
    </div>
  );
}

async function destroyPdfResources(loadingTask: pdfjsLib.PDFDocumentLoadingTask | null, documentProxy: pdfjsLib.PDFDocumentProxy | null): Promise<void> {
  if (documentProxy) {
    await documentProxy.destroy();
    return;
  }
  await loadingTask?.destroy();
}

function DocumentLoading() {
  return <div className="berry-office-loading" role="status" aria-live="polite" aria-busy="true"><CircularActivitySpinner size={28} className="text-[var(--berry-preview-muted)]" label="Opening PDF…" /></div>;
}
